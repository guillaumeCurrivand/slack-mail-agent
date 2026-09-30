import { ownerKey, uid, type Actor } from '../../core/identity.js';
import type { Sql } from '../../core/store.js';
import type { Project, ProjectFields, ProjectEdit, RecordKind, InventoryRecord, InventoryValues } from './domain.js';
import { validSavedFields } from './domain.js';

export const documentationSchema = `
CREATE TABLE IF NOT EXISTS documentation_confirmations (
 id text PRIMARY KEY, team text NOT NULL, owner text NOT NULL, channel text NOT NULL,
 request_id text NOT NULL, target_id text NOT NULL, fields jsonb NOT NULL,
 created_at timestamptz NOT NULL, applied_at timestamptz,
 UNIQUE(owner,request_id)
);
ALTER TABLE documentation_confirmations ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT 'create';
ALTER TABLE documentation_confirmations ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE documentation_confirmations ADD COLUMN IF NOT EXISTS record_kind text NOT NULL DEFAULT 'project';
CREATE TABLE IF NOT EXISTS documentation_projects (
 team text NOT NULL, id text NOT NULL, fields jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(team,id)
);
CREATE TABLE IF NOT EXISTS documentation_history (
 team text NOT NULL, id text NOT NULL, project_id text NOT NULL,
 actor text NOT NULL, source text NOT NULL, before_values jsonb, after_values jsonb NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(team,id),
 FOREIGN KEY(team,project_id) REFERENCES documentation_projects(team,id)
);
CREATE INDEX IF NOT EXISTS documentation_project_history ON documentation_history(team,project_id,changed_at,id);
CREATE TABLE IF NOT EXISTS documentation_records (
 team text NOT NULL, id text NOT NULL, kind text NOT NULL CHECK(kind IN ('technology','component')),
 fields jsonb NOT NULL, parent_id text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(team,id),
 FOREIGN KEY(team,parent_id) REFERENCES documentation_projects(team,id),
 CHECK((kind='technology' AND parent_id IS NULL) OR (kind='component' AND parent_id IS NOT NULL AND fields->>'projectId'=parent_id))
);
CREATE TABLE IF NOT EXISTS documentation_record_history (
 team text NOT NULL, id text NOT NULL, record_id text NOT NULL, record_kind text NOT NULL,
 actor text NOT NULL, source text NOT NULL, before_values jsonb, after_values jsonb NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(team,id),
 FOREIGN KEY(team,record_id) REFERENCES documentation_records(team,id)
);
ALTER TABLE documentation_records DROP CONSTRAINT IF EXISTS documentation_records_kind_check;
ALTER TABLE documentation_records DROP CONSTRAINT IF EXISTS documentation_records_check;
ALTER TABLE documentation_records ADD COLUMN IF NOT EXISTS component_id text;
ALTER TABLE documentation_records DROP CONSTRAINT IF EXISTS documentation_records_component_id_fkey;
ALTER TABLE documentation_records ADD CONSTRAINT documentation_records_component_id_fkey
 FOREIGN KEY(team,component_id) REFERENCES documentation_records(team,id);
ALTER TABLE documentation_records ADD CONSTRAINT documentation_records_kind_check CHECK(kind IN ('technology','component','host','hosting','tool'));
ALTER TABLE documentation_records ADD CONSTRAINT documentation_records_check CHECK(
 (kind IN ('technology','host','tool') AND parent_id IS NULL AND component_id IS NULL) OR
 (kind='component' AND parent_id IS NOT NULL AND fields->>'projectId'=parent_id AND component_id IS NULL) OR
 (kind='hosting' AND parent_id IS NULL AND component_id IS NOT NULL AND fields->>'componentId'=component_id));
CREATE INDEX IF NOT EXISTS documentation_record_history_lookup ON documentation_record_history(team,record_id,changed_at,id);
CREATE TABLE IF NOT EXISTS documentation_deliveries (
 owner text NOT NULL, event_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,event_id)
);
CREATE TABLE IF NOT EXISTS documentation_lookups (
 id text PRIMARY KEY, team text NOT NULL, owner text NOT NULL, channel text NOT NULL,
 event_id text NOT NULL, selector text NOT NULL, destination text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,event_id)
);`;

type Confirmation = { id: string; target_id: string; fields: InventoryValues; record_kind: 'project' | RecordKind; operation: 'create' | 'edit'; outcome: 'applied' | 'satisfied' | 'missing' | 'invalid' | null; created_at: Date | string; applied_at: Date | string | null };
const confirmationColumns = 'id,target_id,fields,record_kind,operation,outcome,created_at,applied_at';
export class DocumentationStore {
  constructor(private sql: Sql) {}
  async propose(actor: Actor, eventId: string, fields: ProjectFields): Promise<Confirmation> {
    const result = await this.sql.query(`INSERT INTO documentation_confirmations(id,team,owner,channel,request_id,target_id,fields,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(owner,request_id) DO UPDATE SET request_id=excluded.request_id
      RETURNING ${confirmationColumns}`, [uid(), actor.team, ownerKey(actor), actor.channel, eventId, uid(), JSON.stringify(fields)]);
    return result.rows[0];
  }
  async proposeEdit(actor: Actor, eventId: string, project: Project, fields: ProjectEdit): Promise<Confirmation> {
    return (await this.sql.query(`INSERT INTO documentation_confirmations(id,team,owner,channel,request_id,target_id,fields,created_at,operation)
      VALUES($1,$2,$3,$4,$5,$6,$7,now(),'edit') ON CONFLICT(owner,request_id) DO UPDATE SET request_id=excluded.request_id
      RETURNING ${confirmationColumns}`, [uid(), actor.team, ownerKey(actor), actor.channel, eventId, project.id, JSON.stringify(fields)])).rows[0];
  }
  async request(actor: Actor, eventId: string): Promise<Confirmation | undefined> {
    return (await this.sql.query(`SELECT ${confirmationColumns} FROM documentation_confirmations
      WHERE team=$1 AND owner=$2 AND channel=$3 AND request_id=$4`, [actor.team, ownerKey(actor), actor.channel, eventId])).rows[0];
  }
  async proposeRecord(actor: Actor, eventId: string, kind: RecordKind, fields: InventoryValues, target?: InventoryRecord): Promise<Confirmation> {
    if (!validSavedFields(kind, target ? 'edit' : 'create', fields)) throw new Error('Invalid inventory fields');
    const result = await this.sql.query(`INSERT INTO documentation_confirmations(id,team,owner,channel,request_id,target_id,fields,created_at,operation,record_kind)
      SELECT $1,$2,$3,$4,$5,$6,$7,now(),$8,$9
      WHERE ($8='create' OR EXISTS(SELECT 1 FROM documentation_records WHERE team=$2 AND id=$6 AND kind=$9))
        AND ($9 IN ('technology','host') OR ($9='tool' AND
          (SELECT count(*) FROM documentation_projects WHERE team=$2
            AND id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF($7::jsonb->'projects','null'::jsonb),'[]'::jsonb))))
          =jsonb_array_length(COALESCE(NULLIF($7::jsonb->'projects','null'::jsonb),'[]'::jsonb)))
          OR ($9='component' AND EXISTS(SELECT 1 FROM documentation_projects WHERE team=$2 AND id=$10)
          AND (SELECT count(*) FROM documentation_records WHERE team=$2 AND kind='technology'
            AND id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF($7::jsonb->'technologies','null'::jsonb),'[]'::jsonb))))
          =jsonb_array_length(COALESCE(NULLIF($7::jsonb->'technologies','null'::jsonb),'[]'::jsonb)))
          OR ($9='hosting' AND EXISTS(SELECT 1 FROM documentation_records WHERE team=$2 AND kind='component' AND id=$11)
            AND EXISTS(SELECT 1 FROM documentation_records WHERE team=$2 AND kind='host' AND id=$12)))
      ON CONFLICT(owner,request_id) DO UPDATE SET request_id=excluded.request_id RETURNING ${confirmationColumns}`,
    [uid(), actor.team, ownerKey(actor), actor.channel, eventId, target?.id ?? uid(), JSON.stringify(fields), target ? 'edit' : 'create', kind, fields.projectId ?? target?.fields.projectId ?? null, fields.componentId ?? target?.fields.componentId ?? null, fields.serviceId ?? target?.fields.serviceId ?? null]);
    if (!result.rows.length) throw new Error('Inventory target or references changed; submit a fresh request');
    return result.rows[0];
  }
  async confirmRecord(actor: Actor, id: string, kind: RecordKind, operation: 'create' | 'edit'): Promise<Confirmation | undefined> {
    const saved = await this.confirmation(actor, id);
    if (!saved || saved.record_kind !== kind || saved.operation !== operation || saved.applied_at) return saved;
    if (!validSavedFields(kind, operation, saved.fields)) {
      await this.sql.query(`UPDATE documentation_confirmations SET outcome='invalid',applied_at=clock_timestamp()
        WHERE id=$1 AND team=$2 AND owner=$3 AND channel=$4 AND record_kind=$5 AND operation=$6 AND applied_at IS NULL
        AND created_at>now()-interval '24 hours' AND created_at<=now()`, [id, actor.team, ownerKey(actor), actor.channel, kind, operation]);
      return this.confirmation(actor, id);
    }
    // Serialize on the saved operation and (for edits) the current shared record.
    // Creation, overwrite history and the terminal effect commit together.
    await this.sql.query(`WITH eligible AS MATERIALIZED (
      SELECT * FROM documentation_confirmations WHERE id=$1 AND team=$2 AND owner=$3 AND channel=$4
        AND record_kind=$6 AND operation=$7 AND applied_at IS NULL
        AND created_at>now()-interval '24 hours' AND created_at<=now() FOR UPDATE
    ), locked AS MATERIALIZED (
      SELECT r.* FROM documentation_records r JOIN eligible c ON r.team=c.team AND r.id=c.target_id AND r.kind=c.record_kind
      WHERE c.operation='edit' FOR UPDATE OF r
    ), changes AS MATERIALIZED (
      SELECT r.team,r.id,
        COALESCE((SELECT jsonb_object_agg(e.key,r.fields->e.key) FROM jsonb_each(c.fields) e WHERE r.fields->e.key IS DISTINCT FROM e.value),'{}'::jsonb) before_values,
        COALESCE((SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(c.fields) e WHERE r.fields->e.key IS DISTINCT FROM e.value),'{}'::jsonb) after_values,
        r.fields || c.fields replacement FROM locked r JOIN eligible c ON r.id=c.target_id
    ), planned AS MATERIALIZED (
      SELECT c.*,CASE WHEN c.operation='create' THEN c.fields ELSE (SELECT replacement FROM changes) END AS replacement FROM eligible c
    ), parents AS MATERIALIZED (
      SELECT p.id FROM documentation_projects p JOIN eligible c ON p.team=c.team
        AND p.id=(SELECT replacement->>'projectId' FROM planned)
      WHERE c.record_kind='component' FOR KEY SHARE OF p
    ), technologies AS MATERIALIZED (
      SELECT r.id FROM documentation_records r JOIN eligible c ON r.team=c.team AND r.kind='technology'
      WHERE r.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF((SELECT replacement->'technologies' FROM planned),'null'::jsonb),'[]'::jsonb)))
      ORDER BY r.id FOR KEY SHARE OF r
    ), hosting_references AS MATERIALIZED (
      SELECT r.id FROM documentation_records r JOIN eligible c ON r.team=c.team
      WHERE c.record_kind='hosting' AND ((r.kind='component' AND r.id=(SELECT replacement->>'componentId' FROM planned))
        OR (r.kind='host' AND r.id=(SELECT replacement->>'serviceId' FROM planned)))
      ORDER BY r.id FOR KEY SHARE OF r
    ), tool_projects AS MATERIALIZED (
      SELECT p.id FROM documentation_projects p JOIN eligible c ON p.team=c.team
      WHERE c.record_kind='tool' AND p.id IN
        (SELECT jsonb_array_elements_text(COALESCE(NULLIF((SELECT replacement->'projects' FROM planned),'null'::jsonb),'[]'::jsonb)))
      ORDER BY p.id FOR KEY SHARE OF p
    ), validated AS MATERIALIZED (
      SELECT c.*, (c.record_kind='technology' OR
        (c.record_kind='tool' AND (SELECT count(*) FROM tool_projects)=
          jsonb_array_length(COALESCE(NULLIF((SELECT replacement->'projects' FROM planned),'null'::jsonb),'[]'::jsonb))) OR
        (c.record_kind='host' AND ((SELECT replacement->'monthlyCost' FROM planned)='null'::jsonb
          OR (SELECT replacement->'currency' FROM planned)<>'null'::jsonb)) OR
        (c.record_kind='hosting' AND (SELECT count(*) FROM hosting_references)=2) OR
        (c.record_kind='component' AND
        (EXISTS(SELECT 1 FROM parents) AND (SELECT count(*) FROM technologies)=
          jsonb_array_length(COALESCE(NULLIF((SELECT replacement->'technologies' FROM planned),'null'::jsonb),'[]'::jsonb))))) AS valid
      FROM eligible c
    ), created AS (
      INSERT INTO documentation_records(team,id,kind,fields,parent_id,component_id)
      SELECT team,target_id,record_kind,fields,fields->>'projectId',fields->>'componentId' FROM validated WHERE operation='create' AND valid RETURNING id
    ), edited AS (
      UPDATE documentation_records r SET fields=d.replacement FROM changes d,validated c
      WHERE r.team=d.team AND r.id=d.id AND d.after_values<>'{}'::jsonb AND c.valid RETURNING r.id
    ), finished AS (
      UPDATE documentation_confirmations c SET applied_at=clock_timestamp(),
        outcome=CASE WHEN c.operation='edit' AND NOT EXISTS(SELECT 1 FROM locked) THEN 'missing'
          WHEN NOT e.valid THEN 'invalid'
          WHEN EXISTS(SELECT 1 FROM created) OR EXISTS(SELECT 1 FROM edited) THEN 'applied' ELSE 'satisfied' END
      FROM validated e WHERE c.id=e.id RETURNING c.*
    ) INSERT INTO documentation_record_history(team,id,record_id,record_kind,actor,source,before_values,after_values,changed_at)
      SELECT c.team,c.id,c.target_id,c.record_kind,$5,
        CASE WHEN c.operation='create' THEN 'Slack structured creation' ELSE 'Slack structured edit' END,
        CASE WHEN c.operation='create' THEN NULL ELSE d.before_values END,
        CASE WHEN c.operation='create' THEN c.fields ELSE d.after_values END,c.applied_at
      FROM finished c LEFT JOIN changes d ON d.team=c.team AND d.id=c.target_id WHERE c.outcome='applied'`,
    [id, actor.team, ownerKey(actor), actor.channel, actor.user, kind, operation]);
    return this.confirmation(actor, id);
  }
  async confirmation(actor: Actor, id: string): Promise<Confirmation | undefined> {
    return (await this.sql.query(`SELECT ${confirmationColumns} FROM documentation_confirmations
      WHERE id=$1 AND team=$2 AND owner=$3 AND channel=$4`, [id, actor.team, ownerKey(actor), actor.channel])).rows[0];
  }
  async confirm(actor: Actor, id: string): Promise<Confirmation | undefined> {
    // One database statement serializes approvals on the saved confirmation row
    // and commits the record, initial history, and effect checkpoint together.
    await this.sql.query(`WITH claimed AS (
      UPDATE documentation_confirmations SET applied_at=now()
      WHERE id=$1 AND team=$2 AND owner=$3 AND channel=$4 AND record_kind='project' AND operation='create' AND applied_at IS NULL
        AND created_at>now()-interval '24 hours' AND created_at<=now()
      RETURNING id,team,target_id,fields,applied_at
    ), created AS (
      INSERT INTO documentation_projects(team,id,fields,created_at)
      SELECT team,target_id,fields,applied_at FROM claimed RETURNING id
    ) INSERT INTO documentation_history(team,id,project_id,actor,source,before_values,after_values,changed_at)
      SELECT team,id,target_id,$5,'Slack structured creation',NULL,fields,applied_at FROM claimed
      WHERE EXISTS(SELECT 1 FROM created)`, [id, actor.team, ownerKey(actor), actor.channel, actor.user]);
    return this.confirmation(actor, id);
  }
  async confirmEdit(actor: Actor, id: string): Promise<Confirmation | undefined> {
    // Lock the confirmation first, then the shared Project. FOR UPDATE reads the
    // current row after waiting for another actor; history uses those locked values.
    // All effects and the terminal checkpoint are in this one atomic statement.
    await this.sql.query(`WITH eligible AS MATERIALIZED (
      SELECT * FROM documentation_confirmations
      WHERE id=$1 AND team=$2 AND owner=$3 AND channel=$4 AND record_kind='project' AND operation='edit' AND applied_at IS NULL
        AND created_at>now()-interval '24 hours' AND created_at<=now() FOR UPDATE
    ), locked AS MATERIALIZED (
      SELECT p.team,p.id,p.fields FROM documentation_projects p JOIN eligible c ON p.team=c.team AND p.id=c.target_id
      FOR UPDATE OF p
    ), changes AS MATERIALIZED (
      SELECT p.team,p.id,
        COALESCE((SELECT jsonb_object_agg(e.key,p.fields->e.key) FROM jsonb_each(c.fields) e
          WHERE p.fields->e.key IS DISTINCT FROM e.value),'{}'::jsonb) AS before_values,
        COALESCE((SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(c.fields) e
          WHERE p.fields->e.key IS DISTINCT FROM e.value),'{}'::jsonb) AS after_values,
        p.fields || c.fields AS replacement
      FROM locked p JOIN eligible c ON c.team=p.team AND c.target_id=p.id
    ), edited AS (
      UPDATE documentation_projects p SET fields=d.replacement FROM changes d
      WHERE p.team=d.team AND p.id=d.id AND d.after_values<>'{}'::jsonb RETURNING p.id
    ), finished AS (
      UPDATE documentation_confirmations c SET applied_at=clock_timestamp(),
        outcome=CASE WHEN NOT EXISTS(SELECT 1 FROM locked) THEN 'missing'
          WHEN EXISTS(SELECT 1 FROM edited) THEN 'applied' ELSE 'satisfied' END
      FROM eligible e WHERE c.id=e.id RETURNING c.id,c.team,c.target_id,c.applied_at,c.outcome
    ) INSERT INTO documentation_history(team,id,project_id,actor,source,before_values,after_values,changed_at)
      SELECT c.team,c.id,c.target_id,$5,'Slack structured edit',d.before_values,d.after_values,c.applied_at
      FROM finished c JOIN changes d ON d.team=c.team AND d.id=c.target_id WHERE c.outcome='applied'`,
    [id, actor.team, ownerKey(actor), actor.channel, actor.user]);
    return this.confirmation(actor, id);
  }
  async projects(actor: Actor, requestedPage = 0, selector: string | null = null): Promise<{ projects: Project[]; total: number; page: number; pages: number }> {
    const filter = `team=$1 AND ($2::text IS NULL OR id=$2 OR lower(fields->>'name')=lower($2)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(NULLIF(fields->'aliases','null'::jsonb),'[]'::jsonb)) alias WHERE lower(alias)=lower($2)))`;
    const total = Number((await this.sql.query(`SELECT count(*) AS total FROM documentation_projects WHERE ${filter}`, [actor.team, selector])).rows[0].total);
    const pages = Math.max(1, Math.ceil(total / 8)), page = Math.min(requestedPage, pages - 1);
    const projects = (await this.sql.query(`SELECT id,fields,created_at FROM documentation_projects
      WHERE ${filter} ORDER BY lower(fields->>'name'),id LIMIT 8 OFFSET $3`, [actor.team, selector, page * 8])).rows;
    return { projects, total, page, pages };
  }
  async project(actor: Actor, id: string): Promise<Project | undefined> {
    return (await this.sql.query('SELECT id,fields,created_at FROM documentation_projects WHERE team=$1 AND id=$2', [actor.team, id])).rows[0];
  }
  async lookup(actor: Actor, query: string) {
    const exactId = await this.project(actor, query);
    return exactId ? { projects: [exactId], total: 1, page: 0, pages: 1 } : this.projects(actor, 0, query);
  }
  async saveLookup(actor: Actor, eventId: string, selector: string, destination: string): Promise<string> {
    const result = await this.sql.query(`INSERT INTO documentation_lookups(id,team,owner,channel,event_id,selector,destination)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner,event_id) DO UPDATE SET event_id=excluded.event_id RETURNING id`,
    [uid(), actor.team, ownerKey(actor), actor.channel, eventId, selector, destination]);
    return result.rows[0].id;
  }
  async records(actor: Actor, kind: RecordKind, requestedPage = 0, selector: string | null = null, parentId: string | null = null, referenceId: string | null = null) {
    const filter = `team=$1 AND kind=$2 AND ($3::text IS NULL OR id=$3 OR lower(fields->>'name')=lower($3))
      AND ($4::text IS NULL OR parent_id=$4 OR component_id=$4) AND ($5::text IS NULL OR fields->'technologies' @> jsonb_build_array($5::text) OR fields->>'serviceId'=$5 OR fields->'projects' @> jsonb_build_array($5::text))`;
    const values = [actor.team, kind, selector, parentId, referenceId];
    const total = Number((await this.sql.query(`SELECT count(*) total FROM documentation_records WHERE ${filter}`, values)).rows[0].total);
    const pages = Math.max(1, Math.ceil(total / 8)), page = Math.min(requestedPage, pages - 1);
    const records: InventoryRecord[] = (await this.sql.query(`SELECT id,kind,fields,created_at FROM documentation_records WHERE ${filter}
      ORDER BY CASE WHEN lower(fields->>'environment')='production' THEN 0 ELSE 1 END,
        lower(COALESCE(fields->>'name',fields->>'environment')),id LIMIT 8 OFFSET $6`, [...values, page * 8])).rows;
    return { records, total, page, pages };
  }
  async record(actor: Actor, kind: RecordKind, id: string): Promise<InventoryRecord | undefined> {
    return (await this.sql.query('SELECT id,kind,fields,created_at FROM documentation_records WHERE team=$1 AND kind=$2 AND id=$3', [actor.team, kind, id])).rows[0];
  }
  async projectHosting(actor: Actor, projectId: string, requestedPage = 0) {
    const from = `FROM documentation_records c LEFT JOIN documentation_records h
      ON h.team=c.team AND h.kind='hosting' AND h.component_id=c.id
      LEFT JOIN documentation_records s ON s.team=h.team AND s.kind='host' AND s.id=h.fields->>'serviceId'
      WHERE c.team=$1 AND c.kind='component' AND c.parent_id=$2`;
    const total = Number((await this.sql.query(`SELECT count(*) total ${from}`, [actor.team, projectId])).rows[0].total);
    const pages = Math.max(1, Math.ceil(total / 8)), page = Math.min(requestedPage, pages - 1);
    const entries: { component_id: string; component_name: string; hosting_id: string | null; fields: InventoryValues | null; service_name: string | null }[] =
      (await this.sql.query(`SELECT c.id component_id,c.fields->>'name' component_name,h.id hosting_id,h.fields,s.fields->>'name' service_name ${from}
        ORDER BY CASE WHEN lower(h.fields->>'environment')='production' THEN 0 ELSE 1 END,
          lower(c.fields->>'name'),c.id,lower(h.fields->>'environment'),h.id LIMIT 8 OFFSET $3`, [actor.team, projectId, page * 8])).rows;
    return { entries, total, page, pages };
  }
  async lookupRecord(actor: Actor, kind: RecordKind, selector: string) {
    const exact = await this.record(actor, kind, selector);
    return exact ? { records: [exact], total: 1, page: 0, pages: 1 } : this.records(actor, kind, 0, selector);
  }
  async recordHistory(actor: Actor, kind: RecordKind, id: string, requestedPage = 0) {
    const total = Number((await this.sql.query('SELECT count(*) total FROM documentation_record_history WHERE team=$1 AND record_kind=$2 AND record_id=$3', [actor.team, kind, id])).rows[0].total);
    const pages = Math.max(1, total), page = Math.min(requestedPage, pages - 1);
    const changes = (await this.sql.query(`SELECT record_id,record_kind,actor,source,before_values,after_values,changed_at FROM documentation_record_history
      WHERE team=$1 AND record_kind=$2 AND record_id=$3 ORDER BY changed_at,id LIMIT 1 OFFSET $4`, [actor.team, kind, id, page])).rows;
    return { changes, total, page, pages };
  }
  async savedLookup(actor: Actor, id: string): Promise<{ selector: string; destination: string } | undefined> {
    return (await this.sql.query(`SELECT selector,destination FROM documentation_lookups
      WHERE id=$1 AND team=$2 AND owner=$3 AND channel=$4 AND created_at>=now()-interval '30 days'`, [id, actor.team, ownerKey(actor), actor.channel])).rows[0];
  }
  async history(actor: Actor, id: string | null, requestedPage = 0) {
    const source = `(SELECT team,id,project_id,'project'::text record_kind,actor,source,before_values,after_values,changed_at FROM documentation_history
      UNION ALL SELECT team,id,record_id,record_kind,actor,source,before_values,after_values,changed_at FROM documentation_record_history) history`;
    const filter = `team=$1 AND ($2::text IS NULL OR (record_kind='project' AND project_id=$2))`;
    const total = Number((await this.sql.query(`SELECT count(*) AS total FROM ${source} WHERE ${filter}`, [actor.team, id])).rows[0].total);
    const pages = Math.max(1, total), page = Math.min(requestedPage, pages - 1);
    const changes = (await this.sql.query(`SELECT project_id,record_kind,actor,source,before_values,after_values,changed_at FROM ${source}
      WHERE ${filter} ORDER BY changed_at,id LIMIT 1 OFFSET $3`, [actor.team, id, page])).rows;
    return { changes, total, page, pages };
  }
  async claimDelivery(actor: Actor, eventId: string) {
    return (await this.sql.query('INSERT INTO documentation_deliveries(owner,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id', [ownerKey(actor), eventId])).rows.length > 0;
  }
  async releaseDelivery(actor: Actor, eventId: string) {
    await this.sql.query('DELETE FROM documentation_deliveries WHERE owner=$1 AND event_id=$2', [ownerKey(actor), eventId]);
  }
  async cleanup() {
    await this.sql.query(`DELETE FROM documentation_deliveries d WHERE created_at<now()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.id=d.event_id AND j.owner=d.owner AND j.module='documentation' AND j.status IN ('queued','running'))`);
    await this.sql.query(`DELETE FROM documentation_confirmations c WHERE created_at<now()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner=c.owner AND j.module='documentation' AND j.status IN ('queued','running'))`);
    await this.sql.query(`DELETE FROM documentation_lookups l WHERE created_at<now()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner=l.owner AND j.module='documentation' AND j.status IN ('queued','running'))`);
  }
}
