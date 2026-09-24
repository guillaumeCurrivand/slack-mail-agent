import type { Pool } from 'pg';
import { dispatchJob, type RuntimeOptions } from './dispatch.js';
import { ownerKey, type Actor } from './identity.js';
import type { ModuleRegistry } from './modules.js';
import type { Messenger } from './slack.js';
import { JobStore, withOwner } from './store.js';

export function worker(pool: Pool, config: RuntimeOptions & { WORKER_CONCURRENCY: number }, modules: ModuleRegistry, messenger: Messenger) {
  const globalStore = new JobStore(pool), enabled = modules.enabledIds();
  let stopping = false;
  const tick = async () => {
    const jobs = await pool.query("SELECT id,actor FROM jobs WHERE module=ANY($1::text[]) AND status IN ('queued','running') AND available_at<=now() ORDER BY created_at,id LIMIT 30", [enabled]);
    for (const candidate of jobs.rows) {
      if (stopping) return;
      const worked = await withOwner(pool, candidate.actor as Actor, async client => {
        // Fetch again after the owner lock: another worker may have completed the candidate.
        const job = (await client.query("SELECT * FROM jobs WHERE owner=$1 AND module=ANY($2::text[]) AND status IN ('queued','running') AND available_at<=now() ORDER BY created_at,id LIMIT 1", [ownerKey(candidate.actor), enabled])).rows[0];
        if (!job) return false;
        await client.query("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id=$1", [job.id]);
        try {
          await dispatchJob(client, config, modules, messenger, job);
          await client.query("UPDATE jobs SET status='done',finished_at=now(),payload='{}'::jsonb WHERE id=$1", [job.id]);
        } catch {
          // Usually a DB/Slack delivery failure. AI interpretations and message checkpoints are already durable.
          await client.query("UPDATE jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,available_at=now()+interval '30 seconds',finished_at=CASE WHEN attempts>=5 THEN now() ELSE NULL END WHERE id=$1", [job.id]);
          console.error(JSON.stringify({ event: 'job_failed', job: job.id }));
        }
        return true;
      });
      if (worked) return;
    }
  };
  const cleanup = async () => {
    await globalStore.cleanup();
    for (const module of modules.all()) {
      try { await module.cleanup?.(pool); }
      catch { console.error(JSON.stringify({ event: 'module_cleanup_failed', module: module.id })); }
    }
  };
  const loops = Array.from({ length: config.WORKER_CONCURRENCY }, async () => {
    while (!stopping) {
      try { await tick(); } catch { console.error(JSON.stringify({ event: 'worker_error' })); }
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 500));
    }
  });
  let housekeepingRun: Promise<void> | undefined;
  const runCleanup = () => {
    if (stopping || housekeepingRun) return;
    housekeepingRun = cleanup().catch(() => console.error(JSON.stringify({ event: 'retention_cleanup_failed' })))
      .finally(() => { housekeepingRun = undefined; });
  };
  const housekeeping = setInterval(runCleanup, 3600_000);
  runCleanup();
  return async () => { stopping = true; clearInterval(housekeeping); await Promise.all([...loops, housekeepingRun]); };
}
