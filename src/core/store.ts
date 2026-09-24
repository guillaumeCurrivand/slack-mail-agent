import type { Pool, PoolClient } from 'pg';
import { ownerKey, type Actor } from './identity.js';

export interface Sql { query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount?: number | null }> }
export const coreSchema = `
CREATE TABLE IF NOT EXISTS jobs (
 id text PRIMARY KEY, owner text NOT NULL, actor jsonb NOT NULL, payload jsonb NOT NULL, module text NOT NULL DEFAULT 'core',
 status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), available_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(available_at,created_at) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS ai_months (
 month text PRIMARY KEY, charged_micro bigint NOT NULL DEFAULT 0, reserved_micro bigint NOT NULL DEFAULT 0,
 alert_sent boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS ai_calls (
 id text PRIMARY KEY, month text NOT NULL REFERENCES ai_months(month), owner text NOT NULL,
 reserved_micro bigint NOT NULL, charged_micro bigint, status text NOT NULL DEFAULT 'reserved', module text NOT NULL DEFAULT 'core',
 created_at timestamptz NOT NULL DEFAULT now()
);
`;

export class JobStore {
  constructor(readonly sql: Sql) {}
  async enqueue(id: string, actor: Actor, payload: Record<string, unknown>, module = 'core') {
    await this.sql.query('INSERT INTO jobs(id,owner,actor,payload,module) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [id, ownerKey(actor), JSON.stringify(actor), JSON.stringify(payload), module]);
  }
  async cleanup() { await this.sql.query("DELETE FROM jobs WHERE finished_at<now()-interval '30 days'"); }
}

export async function withOwner<T>(pool: Pool, actor: Actor, work: (client: PoolClient) => Promise<T>): Promise<T | undefined> {
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [ownerKey(actor)])).rows[0].locked;
    if (!locked) return undefined;
    return await work(client);
  } finally {
    let releaseError: Error | undefined;
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [ownerKey(actor)]); }
      catch { releaseError = new Error('Failed to release owner lock'); }
    }
    // Destroy a connection whose lock state is unknown rather than returning it to the pool.
    client.release(releaseError);
  }
}
