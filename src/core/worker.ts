import type { Pool } from 'pg';
import { dispatchJob, type RuntimeOptions } from './dispatch.js';
import { isIntegration, workOwnerKey, type WorkIdentity } from './identity.js';
import type { ModuleRegistry } from './modules.js';
import { SlackDeliveryRejected, type Messenger } from './slack.js';
import { JobStore, withWorkOwner } from './store.js';

const diagnosticCodes = new Set(['access_denied', 'channel_not_found', 'ekm_access_denied', 'invalid_auth', 'invalid_blocks', 'is_archived', 'missing_scope', 'no_permission', 'not_in_channel', 'rate_limited', 'ratelimited', 'token_expired', 'token_revoked', 'message_not_found', 'cant_update_message', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);

function failureDetails(error: unknown) {
  if (!(error instanceof Error)) return { error_type: 'NonError' };
  const code = 'code' in error ? error.code : undefined;
  // Never log messages, query details, causes, payloads or the raw stack: these can contain credentials.
  const location = error.stack?.split('\n').slice(1).map(line => line.replaceAll('\\', '/').match(/\/(?:src|dist)\/((?:core|app|modules)\/[a-zA-Z0-9_./-]+\.[cm]?[jt]s:\d+:\d+)(?:\)|$)/)?.[1]).find(Boolean);
  return {
    error_type: error instanceof SlackDeliveryRejected ? 'SlackDeliveryRejected' : error instanceof TypeError ? 'TypeError'
      : error instanceof SyntaxError ? 'SyntaxError' : error instanceof RangeError ? 'RangeError' : 'Error',
    error_code: typeof code === 'string' && (diagnosticCodes.has(code) || /^[0-9A-Z]{5}$/.test(code)) ? code : undefined,
    error_location: location,
  };
}

export function worker(pool: Pool, config: RuntimeOptions & { WORKER_CONCURRENCY: number }, modules: ModuleRegistry, messenger: Messenger) {
  const globalStore = new JobStore(pool), enabled = modules.enabledIds();
  let stopping = false;
  const tick = async () => {
    const jobs = await pool.query(`SELECT * FROM (
      SELECT DISTINCT ON (owner,module) id,actor,module,created_at,available_at FROM jobs
      WHERE module=ANY($1::text[]) AND status IN ('queued','running')
        AND (actor->>'kind' IS DISTINCT FROM 'integration' OR available_at<=now())
      ORDER BY owner,module,created_at,id
    ) ready WHERE available_at<=now() ORDER BY created_at,id LIMIT 30`, [enabled]);
    for (const candidate of jobs.rows) {
      if (stopping) return;
      const worked = await withWorkOwner(pool, candidate.actor as WorkIdentity, async client => {
        // Fetch again after the module lock: another worker may have completed the candidate.
        const job = (await client.query("SELECT * FROM jobs WHERE owner=$1 AND module=$2 AND status IN ('queued','running') AND (actor->>'kind' IS DISTINCT FROM 'integration' OR available_at<=now()) ORDER BY created_at,id LIMIT 1", [workOwnerKey(candidate.actor), candidate.module])).rows[0];
        if (!job || new Date(job.available_at).getTime() > Date.now()) return false;
        await client.query("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id=$1", [job.id]);
        try {
          const retryAt = await dispatchJob(client, config, modules, messenger, job);
          if (retryAt) await new JobStore(client).defer(job.id, retryAt);
          else await new JobStore(client).complete(job.id);
        } catch (error) {
          // Usually a DB/Slack delivery failure. AI interpretations and message checkpoints are already durable.
          if (isIntegration(job.actor)) await new JobStore(client).defer(job.id, new Date(Date.now() + 30_000));
          else await new JobStore(client).retryOrFail(job.id);
          console.error(JSON.stringify({ event: 'job_failed', job: job.id, module: job.module, ...failureDetails(error) }));
        }
        return true;
      }, candidate.module);
      if (worked) return;
    }
  };
  const cleanup = async () => {
    await globalStore.cleanup();
    for (const module of modules.all()) {
      try { await module.cleanup?.(pool); }
      catch (error) { console.error(JSON.stringify({ event: 'module_cleanup_failed', module: module.id, ...failureDetails(error) })); }
    }
  };
  const loops = Array.from({ length: config.WORKER_CONCURRENCY }, async () => {
    while (!stopping) {
      try { await tick(); } catch (error) { console.error(JSON.stringify({ event: 'worker_error', ...failureDetails(error) })); }
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 500));
    }
  });
  let housekeepingRun: Promise<void> | undefined;
  const runCleanup = () => {
    if (stopping || housekeepingRun) return;
    housekeepingRun = cleanup().catch(error => console.error(JSON.stringify({ event: 'retention_cleanup_failed', ...failureDetails(error) })))
      .finally(() => { housekeepingRun = undefined; });
  };
  const housekeeping = setInterval(runCleanup, 3600_000);
  runCleanup();
  return async () => { stopping = true; clearInterval(housekeeping); await Promise.all([...loops, housekeepingRun]); };
}
