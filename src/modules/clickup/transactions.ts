import type { Pool } from 'pg';
import { ownerKey, type Actor } from '../../core/identity.js';
import type { Sql } from '../../core/store.js';

/** Transaction adapters allow fake databases to exercise the same transition boundary. */
export type ClickupDatabase = Sql & { transaction?<T>(work: (sql: Sql) => Promise<T>): Promise<T> };

export async function ownedTransition<T>(database: ClickupDatabase, actor: Actor, work: (sql: Sql) => Promise<T>): Promise<T> {
  if (database.transaction) return database.transaction(work);
  const pool = database as Pool;
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${ownerKey(actor)}:clickup`]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { releaseError = new Error('Failed to roll back ClickUp transition'); }
    throw error;
  } finally { client.release(releaseError); }
}
