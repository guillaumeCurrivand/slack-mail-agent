import pg from 'pg';
import { createServer } from '../core/server.js';
import { Slack } from '../core/slack.js';
import { coreSchema, JobStore } from '../core/store.js';
import { worker } from '../core/worker.js';
import { readConfig } from './config.js';
import { createModules } from './modules.js';
import { legacyMetadataMigration } from './schema.js';

export async function start() {
  const config = readConfig();
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 15, connectionTimeoutMillis: 2000 });
  try {
    const modules = createModules(config, pool);
    await pool.query(coreSchema + legacyMetadataMigration);
    for (const module of modules.all()) await module.initialize?.(pool);
    const app = createServer(config, new JobStore(pool), modules);
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    const stopWorker = worker(pool, config, modules, new Slack(config.SLACK_BOT_TOKEN));
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); await stopWorker(); await pool.end(); };
    process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
    console.log(`Agent listening on port ${config.PORT}`);
  } catch (error) { await pool.end(); throw error; }
}
