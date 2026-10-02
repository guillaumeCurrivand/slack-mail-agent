import type { Pool, PoolClient } from 'pg';
import type { Sql } from './store.js';

export type Database = Sql & { transaction?<T>(work: (sql: Sql) => Promise<T>): Promise<T> };

/** Use a dedicated pool connection, or the caller's already checked-out connection. */
export async function transaction<T>(database: Database, work: (sql: Sql) => Promise<T>): Promise<T> {
  if (database.transaction) return database.transaction(work);
  const pooled = typeof (database as Pool).connect === 'function' && typeof (database as PoolClient).release !== 'function';
  const client = pooled ? await (database as Pool).connect() : database;
  let releaseError: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { releaseError = new Error('Transaction rollback failed.'); }
    throw error;
  } finally { if (pooled) (client as PoolClient).release(releaseError); }
}
