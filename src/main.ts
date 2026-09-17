import pg from 'pg';
import { readConfig } from './config.js';
import { Vault } from './crypto.js';
import { GoogleOAuth } from './oauth.js';
import { createServer } from './server.js';
import { schema, Store } from './store.js';
import { worker } from './worker.js';

async function main() {
  const config = readConfig();
  const vault = new Vault(Buffer.from(config.ENCRYPTION_KEY, 'base64'));
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 15, connectionTimeoutMillis: 2000 });
  await pool.query(schema);
  const store = new Store(pool), oauth = new GoogleOAuth(config, store, vault);
  const app = createServer(config, store, oauth);
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  const stopWorker = worker(pool, config, vault);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); await stopWorker(); await pool.end(); };
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  console.log(`Agent listening on port ${config.PORT}`);
}
main().catch(() => { console.error('Startup failed. Check environment configuration, model price card, encryption key and database connectivity.'); process.exitCode = 1; });
