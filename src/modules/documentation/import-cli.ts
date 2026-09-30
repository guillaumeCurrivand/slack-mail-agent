import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import type { Sql } from '../../core/store.js';
import { documentationSchema } from './store.js';
import { DocumentationImport, documentationImportSchema, approveReview, reviewSnapshot, type ImportApproval } from './import.js';
import { checkApproval } from './import-review.js';

const usage = `Offline Documentation import (no source URLs are fetched):
  review snapshot.json review.json
  approve snapshot.json review.json approval.json "User approval attribution"
  apply snapshot.json review.json approval.json
  reconcile snapshot.json review.json approval.json
  status
  recover new-directory
Requires SLACK_TEAM_ID and ENABLED_MODULES containing documentation.
Database commands additionally require DATABASE_URL. Review/approve never connect to the database.
Real review/approval/import and production deployment require separate User authorization.`;
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const save = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
export async function runImportCommand(args: string[], env: NodeJS.ProcessEnv, sql?: Sql): Promise<unknown> {
  const [command, snapshotPath, reviewPath, approvalPath, confirmedBy] = args;
  if (!command || command === '--help') return usage;
  const config = { workspace: env.SLACK_TEAM_ID ?? '', enabledModules: (env.ENABLED_MODULES ?? 'mail').split(',').map(value => value.trim()) };
  if (!/^T[A-Z0-9]+$/.test(config.workspace) || !config.enabledModules.includes('documentation')) throw new Error('Configured workspace and enabled Documentation are required');
  const arity = { review: 3, approve: 5, apply: 4, reconcile: 4, status: 1, recover: 2 };
  if (!(command in arity) || args.length !== arity[command as keyof typeof arity]) throw new Error(usage);
  if (command === 'review') {
    const review = reviewSnapshot(await readFile(snapshotPath!, 'utf8'), config);
    await save(reviewPath!, review);
    return { review: resolve(reviewPath!), records: review.records.length, unresolved: review.cells.length, warnings: review.warnings };
  }
  if (command === 'approve') {
    const approval = approveReview(await readFile(snapshotPath!, 'utf8'), await json(reviewPath!), config, confirmedBy!);
    await save(approvalPath!, approval);
    return approval;
  }
  if (!sql) {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for database commands');
    const client = new pg.Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    try { return await runImportCommand(args, env, client); } finally { await client.end(); }
  }
  if (command === 'status' || command === 'recover') {
    const saved = (await sql.query('SELECT * FROM documentation_import_batches WHERE team=$1', [config.workspace])).rows[0];
    if (!saved) throw new Error('No import batch in this workspace');
    const effects = (await sql.query('SELECT record_kind,existing,count(*)::int count FROM documentation_import_effects WHERE team=$1 GROUP BY record_kind,existing ORDER BY record_kind', [config.workspace])).rows;
    if (command === 'recover') {
      const directory = resolve(snapshotPath!);
      await mkdir(directory, { recursive: false, mode: 0o700 });
      await writeFile(join(directory, 'snapshot.json'), saved.snapshot, { flag: 'wx', mode: 0o600 });
      await save(join(directory, 'review.json'), saved.review);
      await save(join(directory, 'approval.json'), { version: 1, workspace: config.workspace, sourceDigest: saved.source_digest,
        reviewDigest: saved.review_digest, batch: saved.batch, confirmedBy: saved.approved_by });
    }
    return { batch: saved.batch, status: saved.status, authoritativeAt: saved.authoritative_at, lastError: saved.last_error, effects, reconciliation: saved.reconciliation };
  }
  const snapshot = await readFile(snapshotPath!, 'utf8'), review = await json(reviewPath!), approval: ImportApproval = await json(approvalPath!);
  // Validate before even running idempotent DDL on an apply attempt.
  checkApproval(snapshot, review, approval, config);
  // These are the same module-owned tables initialized by the application. No
  // shared/Gmail/AI configuration or external provider is constructed here.
  await sql.query(documentationSchema + documentationImportSchema);
  const importer = new DocumentationImport(sql, config);
  return command === 'apply' ? importer.apply(snapshot, review, approval) : importer.reconcile(snapshot, review, approval);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runImportCommand(process.argv.slice(2), process.env).then(result => {
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    if (typeof result === 'object' && result && 'reconciled' in result && !result.reconciled) process.exitCode = 1;
  }).catch(error => { console.error(error instanceof Error ? error.message : 'Import command failed'); process.exitCode = 1; });
}
