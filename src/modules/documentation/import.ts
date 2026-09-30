import type { Sql } from '../../core/store.js';
import { canonical, checkApproval, digest, type ApprovedRecord, type ImportApproval, type ImportConfig } from './import-review.js';
export { reviewSnapshot, approveReview } from './import-review.js';
export type { ImportReview, ImportApproval } from './import-review.js';

export const documentationImportSchema = `
CREATE TABLE IF NOT EXISTS documentation_import_batches (
 team text PRIMARY KEY, batch text NOT NULL, source_digest text NOT NULL, review_digest text NOT NULL,
 snapshot text NOT NULL, review jsonb NOT NULL, approved_by text NOT NULL,
 superseded jsonb NOT NULL DEFAULT '[]'::jsonb,
 status text NOT NULL DEFAULT 'pending', last_error text, reconciliation jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), authoritative_at timestamptz
);
CREATE TABLE IF NOT EXISTS documentation_import_effects (
 team text NOT NULL REFERENCES documentation_import_batches(team), batch text NOT NULL,
 effect_key text NOT NULL, record_id text NOT NULL, record_kind text NOT NULL,
 existing boolean NOT NULL, fields jsonb NOT NULL, history_id text NOT NULL,
 applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(team,effect_key), UNIQUE(team,record_id)
);`;
type Batch = { batch: string; approved_by: string; source_digest: string; status: string; last_error: string | null; authoritative_at: string | Date | null; reconciliation: ImportReport | null };
export type ImportReport = {
  batch: string; status: string; authoritative: boolean; reconciled: boolean; expected: number; applied: number; existing: number;
  initialHistory: number; relationships: number; counts: Record<string, number>; problems: string[];
};
const rank = { project: 0, technology: 1, host: 2, component: 3, hosting: 4, tool: 5 };
const tableFor = (kind: ApprovedRecord['kind']) => kind === 'project' ? 'documentation_projects' : 'documentation_records';
const historyFor = (kind: ApprovedRecord['kind']) => kind === 'project' ? 'documentation_history' : 'documentation_record_history';
const refsFor = (record: ApprovedRecord): { id: string; kind: ApprovedRecord['kind'] }[] => {
  const f = record.fields;
  if (record.kind === 'component') return [{ id: String(f.projectId), kind: 'project' }, ...(Array.isArray(f.technologies) ? f.technologies.map(id => ({ id, kind: 'technology' as const })) : [])];
  if (record.kind === 'hosting') return [{ id: String(f.componentId), kind: 'component' }, { id: String(f.serviceId), kind: 'host' }];
  if (record.kind === 'tool' && Array.isArray(f.projects)) return f.projects.map(id => ({ id, kind: 'project' as const }));
  return [];
};

// The caller supplies one dedicated SQL connection. Each effect transaction owns
// the workspace batch lock and commits inventory, initial history and checkpoint.
export class DocumentationImport {
  constructor(private sql: Sql, private config: ImportConfig) {}
  private async transaction<T>(work: () => Promise<T>): Promise<T> {
    await this.sql.query('BEGIN');
    try { const result = await work(); await this.sql.query('COMMIT'); return result; }
    catch (error) { await this.sql.query('ROLLBACK'); throw error; }
  }
  private async batch(batch: string, lock = false): Promise<Batch> {
    const saved = (await this.sql.query(`SELECT batch,approved_by,source_digest,status,last_error,authoritative_at,reconciliation FROM documentation_import_batches WHERE team=$1${lock ? ' FOR UPDATE' : ''}`, [this.config.workspace])).rows[0];
    if (!saved || saved.batch !== batch) throw new Error('Workspace already has a different one-time batch; use its exact saved review to recover');
    return saved;
  }
  private async current(record: { id: string; kind: ApprovedRecord['kind'] }, lock = false) {
    return (await this.sql.query(`SELECT fields,archived FROM ${tableFor(record.kind)} WHERE team=$1 AND id=$2${record.kind === 'project' ? '' : ' AND kind=$3'}${lock ? ' FOR SHARE' : ''}`,
      record.kind === 'project' ? [this.config.workspace, record.id] : [this.config.workspace, record.id, record.kind])).rows[0];
  }
  async apply(snapshot: string, review: unknown, approval: ImportApproval): Promise<ImportReport> {
    const checked = checkApproval(snapshot, review, approval, this.config);
    await this.transaction(async () => {
      await this.sql.query(`INSERT INTO documentation_import_batches(team,batch,source_digest,review_digest,snapshot,review,approved_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(team) DO NOTHING`,
      [this.config.workspace, checked.batch, approval.sourceDigest, approval.reviewDigest, snapshot, JSON.stringify(checked.review), approval.confirmedBy]);
      const saved = (await this.sql.query('SELECT * FROM documentation_import_batches WHERE team=$1 FOR UPDATE', [this.config.workspace])).rows[0];
      if (saved.batch !== checked.batch) {
        if (saved.authoritative_at || (await this.sql.query('SELECT 1 FROM documentation_import_effects WHERE team=$1 LIMIT 1', [this.config.workspace])).rows.length) throw new Error('Workspace already has a different one-time batch; use its exact saved review to recover');
        // No effects exist: a freshly approved review can replace a rejected
        // preflight. Keep the prior review/outcome as lifetime provenance.
        await this.sql.query(`UPDATE documentation_import_batches b SET superseded=superseded || jsonb_build_array(to_jsonb(b)-'superseded'),
          batch=$2,source_digest=$3,review_digest=$4,snapshot=$5,review=$6,approved_by=$7,status='pending',last_error=NULL,reconciliation=NULL,created_at=now() WHERE team=$1`,
        [this.config.workspace, checked.batch, approval.sourceDigest, approval.reviewDigest, snapshot, JSON.stringify(checked.review), approval.confirmedBy]);
      } else if (saved.approved_by !== approval.confirmedBy) throw new Error('Approval attribution differs from saved batch');
    });
    const batch = await this.batch(checked.batch);
    if (batch.authoritative_at) return this.reconcile(snapshot, review, approval);
    try {
      for (const record of [...checked.records].sort((a, b) => rank[a.kind] - rank[b.kind] || a.key.localeCompare(b.key))) {
        await this.transaction(async () => {
          await this.batch(checked.batch, true);
          if ((await this.sql.query('SELECT 1 FROM documentation_import_effects WHERE team=$1 AND effect_key=$2', [this.config.workspace, record.key])).rows.length) return;
          await this.sql.query(`UPDATE documentation_import_batches SET status='applying',last_error=NULL WHERE team=$1`, [this.config.workspace]);
          for (const ref of refsFor(record).sort((a, b) => a.id.localeCompare(b.id))) {
            const current = await this.current(ref, true);
            if (!current) throw new Error(`Missing workspace reference ${ref.kind}: ${ref.id}`);
          }
          const current = await this.current(record, true);
          const historyId = digest(`${checked.batch}:${record.key}:initial`);
          if (record.existing) {
            if (!current || current.archived || canonical(current.fields) !== canonical(record.fields)) throw new Error(`Existing record differs from reviewed fields: ${record.key}; no overwrite permitted`);
          } else {
            const collision = (await this.sql.query(`SELECT id FROM ${tableFor(record.kind)} r WHERE team=$1
              ${record.kind === 'project' ? 'AND $3::text IS NULL' : 'AND kind=$3'} AND (id=$2 OR (lower(fields->>'name')=lower($4)
              AND NOT EXISTS(SELECT 1 FROM documentation_import_effects e WHERE e.team=r.team AND e.record_id=r.id AND e.batch=$5)))`,
            record.kind === 'project' ? [this.config.workspace, record.id, null, record.fields.name ?? null, checked.batch]
              : [this.config.workspace, record.id, record.kind, record.fields.name ?? null, checked.batch])).rows;
            if (current || collision.length) throw new Error(`Existing-record collision: ${record.key}; resolve identities in review, never overwrite`);
            if (record.kind === 'project') {
              await this.sql.query('INSERT INTO documentation_projects(team,id,fields) VALUES($1,$2,$3)', [this.config.workspace, record.id, JSON.stringify(record.fields)]);
            } else {
              await this.sql.query('INSERT INTO documentation_records(team,id,kind,fields,parent_id,component_id) VALUES($1,$2,$3,$4,$5,$6)',
                [this.config.workspace, record.id, record.kind, JSON.stringify(record.fields), record.fields.projectId ?? null, record.fields.componentId ?? null]);
            }
            await this.sql.query(`INSERT INTO ${historyFor(record.kind)}(team,id,${record.kind === 'project' ? 'project_id' : 'record_id,record_kind'},actor,source,before_values,after_values)
              VALUES($1,$2,$3,${record.kind === 'project' ? '' : '$7,'}$4,$5,NULL,$6)`,
            record.kind === 'project' ? [this.config.workspace, historyId, record.id, approval.confirmedBy, `Spreadsheet import ${checked.review.source}; batch ${checked.batch}; source ${approval.sourceDigest}; effect ${record.key}`, JSON.stringify(record.fields)]
              : [this.config.workspace, historyId, record.id, approval.confirmedBy, `Spreadsheet import ${checked.review.source}; batch ${checked.batch}; source ${approval.sourceDigest}; effect ${record.key}`, JSON.stringify(record.fields), record.kind]);
          }
          await this.sql.query(`INSERT INTO documentation_import_effects(team,batch,effect_key,record_id,record_kind,existing,fields,history_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [this.config.workspace, checked.batch, record.key, record.id, record.kind, record.existing, JSON.stringify(record.fields), historyId]);
        });
      }
      return await this.reconcile(snapshot, review, approval);
    } catch (error) {
      // A lost COMMIT response is recovered by inspecting durable effects. Never
      // assume the last write failed or rerun completed effects after later edits.
      await this.sql.query(`UPDATE documentation_import_batches SET status='failed',last_error=$2 WHERE team=$1 AND authoritative_at IS NULL`,
        [this.config.workspace, error instanceof Error ? error.message : 'Import failed']);
      return this.report(checked.batch, checked.records, [error instanceof Error ? error.message : 'Import failed']);
    }
  }
  private async report(batchId: string, records: ApprovedRecord[], extraProblems: string[] = []): Promise<ImportReport> {
    const batch = await this.batch(batchId);
    const effects = (await this.sql.query('SELECT * FROM documentation_import_effects WHERE team=$1 AND batch=$2', [this.config.workspace, batchId])).rows;
    const problems = [...extraProblems];
    let initialHistory = 0, relationships = 0;
    const counts: Record<string, number> = { project: 0, technology: 0, host: 0, component: 0, hosting: 0, tool: 0 };
    for (const record of records) {
      const effect = effects.find(effect => effect.effect_key === record.key);
      if (!effect) { problems.push(`Not applied: ${record.key}`); continue; }
      if (effect.record_id !== record.id || effect.record_kind !== record.kind || effect.existing !== record.existing || canonical(effect.fields) !== canonical(record.fields)) problems.push(`Effect mismatch: ${record.key}`);
      const current = await this.current(record);
      if (!current || current.archived || canonical(current.fields) !== canonical(record.fields)) problems.push(`Record/relationships differ: ${record.key}`);
      else {
        counts[record.kind]!++;
        for (const ref of refsFor(record)) {
          if (!await this.current(ref)) problems.push(`Missing relationship: ${record.key} -> ${ref.id}`);
          else relationships++;
        }
      }
      if (!record.existing) {
        const history = (await this.sql.query(`SELECT actor,source,before_values,after_values FROM ${historyFor(record.kind)} WHERE team=$1 AND id=$2 AND ${record.kind === 'project' ? 'project_id' : 'record_id'}=$3`, [this.config.workspace, effect.history_id, record.id])).rows[0];
        if (!history || history.before_values !== null || canonical(history.after_values) !== canonical(record.fields) || history.actor !== batch.approved_by || !history.source.includes(batchId) || !history.source.includes(batch.source_digest)) problems.push(`Initial history mismatch: ${record.key}`);
        else initialHistory++;
      }
    }
    if (effects.length !== records.length) problems.push('Effect count does not match approved mapping');
    return { batch: batchId, status: batch.status, authoritative: !!batch.authoritative_at, reconciled: !problems.length,
      expected: records.length, applied: effects.filter(effect => !effect.existing).length, existing: effects.filter(effect => effect.existing).length,
      initialHistory, relationships, counts, problems };
  }
  async reconcile(snapshot: string, review: unknown, approval: ImportApproval): Promise<ImportReport> {
    const checked = checkApproval(snapshot, review, approval, this.config);
    return this.transaction(async () => {
      const batch = await this.batch(checked.batch, true);
      if (batch.approved_by !== approval.confirmedBy) throw new Error('Approval attribution differs from saved batch');
      // Use a consistent database snapshot: lock approved targets against Slack
      // edits/lifecycle changes until reconciliation and authority commit.
      for (const record of [...checked.records].sort((a, b) => a.id.localeCompare(b.id))) {
        await this.sql.query(`SELECT id FROM ${tableFor(record.kind)} WHERE team=$1 AND id=$2 FOR SHARE`, [this.config.workspace, record.id]);
      }
      const report = await this.report(checked.batch, checked.records);
      report.status = batch.authoritative_at ? 'reconciled' : report.reconciled ? 'reconciled' : 'incomplete';
      report.authoritative ||= report.reconciled;
      await this.sql.query(`UPDATE documentation_import_batches SET status=$2,reconciliation=$3,
        last_error=CASE WHEN $4 THEN NULL ELSE last_error END,
        authoritative_at=CASE WHEN $4 THEN COALESCE(authoritative_at,clock_timestamp()) ELSE authoritative_at END WHERE team=$1`,
        [this.config.workspace, report.status, JSON.stringify(report), report.reconciled]);
      return report;
    });
  }
}
