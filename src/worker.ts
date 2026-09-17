import type { Pool } from 'pg';
import { Budget, OpenAI } from './ai.js';
import type { Config } from './config.js';
import { Vault } from './crypto.js';
import { ownerKey, type Actor } from './domain.js';
import { Engine, type Event } from './engine.js';
import { Gmail, type Tokens } from './gmail.js';
import { GoogleOAuth } from './oauth.js';
import { Slack } from './slack.js';
import { prune, Store, withOwner } from './store.js';

export function worker(pool: Pool, config: Config, vault: Vault) {
  const globalStore = new Store(pool), slack = new Slack(config.SLACK_BOT_TOKEN), oauth = new GoogleOAuth(config, globalStore, vault);
  let stopping = false;
  const tick = async () => {
    const jobs = await pool.query("SELECT id,actor FROM jobs WHERE status IN ('queued','running') AND available_at<=now() ORDER BY created_at,id LIMIT 30");
    for (const candidate of jobs.rows) {
      if (stopping) return;
      const worked = await withOwner(pool, candidate.actor as Actor, async (store, client) => {
        // Fetch again after the owner lock: another worker may have completed the candidate.
        const job = (await client.query("SELECT * FROM jobs WHERE owner=$1 AND status IN ('queued','running') AND available_at<=now() ORDER BY created_at,id LIMIT 1", [ownerKey(candidate.actor)])).rows[0];
        if (!job) return false;
        await client.query("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id=$1", [job.id]);
        const budget = new Budget(client, Math.round(config.AI_MONTHLY_LIMIT_USD * 1e6), Math.round(config.AI_USER_MONTHLY_LIMIT_USD * 1e6));
        const engine = new Engine({ store, budget, messenger: slack,
          intelligence: new OpenAI(config.OPENAI_API_KEY, config.OPENAI_MODEL, budget),
          connectUrl: actor => oauth.invitation(actor), alertMicro: Math.round(config.AI_ALERT_USD * 1e6), adminUser: config.SLACK_ADMIN_USER_ID,
          mailbox: (actor, state) => new Gmail(vault.open<Tokens>(state.connection!.encryptedTokens, ownerKey(actor)), config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET,
            async tokens => { state.connection!.encryptedTokens = vault.seal(tokens, ownerKey(actor)); await store.save(actor, state); }),
        });
        try {
          await engine.handle(job.actor as Actor, job.payload as Event, job.id);
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
  const pruneUsers = async () => {
    await globalStore.cleanup();
    const users = await pool.query('SELECT team,slack_user FROM users');
    for (const row of users.rows) {
      const actor = { team: row.team, user: row.slack_user, channel: '' };
      await withOwner(pool, actor, async store => { const state = await store.load(actor); prune(state); await store.save(actor, state); });
    }
  };
  const loops = Array.from({ length: config.WORKER_CONCURRENCY }, async () => {
    while (!stopping) {
      try { await tick(); } catch { console.error(JSON.stringify({ event: 'worker_error' })); }
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 500));
    }
  });
  const housekeeping = setInterval(() => { void pruneUsers().catch(() => console.error(JSON.stringify({ event: 'retention_cleanup_failed' }))); }, 3600_000);
  void pruneUsers().catch(() => {});
  return async () => { stopping = true; clearInterval(housekeeping); await Promise.all(loops); };
}
