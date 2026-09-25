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
CREATE TABLE IF NOT EXISTS core_operation_slots (
 owner text NOT NULL, module text NOT NULL, operation text NOT NULL, job_id text NOT NULL,
 active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,module,operation)
);
CREATE TABLE IF NOT EXISTS core_navigation_menus (
 id text PRIMARY KEY, owner text NOT NULL, channel text NOT NULL, timestamp text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS core_navigation_deliveries (
 event_id text PRIMARY KEY, owner text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
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
  /** Preserve active work at receipt even when intent is resolved later. */
  async enqueueWithOperationSnapshot(id: string, actor: Actor, payload: Record<string, unknown>, module: string, operation: string) {
    await this.sql.query(`INSERT INTO jobs(id,owner,actor,payload,module)
      SELECT $1,$2,$3,COALESCE((SELECT $4::jsonb || jsonb_build_object('activeOperation',job_id)
        FROM core_operation_slots WHERE owner=$2 AND module=$5 AND operation=$6 AND active),$4::jsonb),$5
      ON CONFLICT DO NOTHING`,
    [id, ownerKey(actor), JSON.stringify(actor), JSON.stringify(payload), module, operation]);
  }
  /** Resolve an intent known only after routing; returns the original active job. */
  async claimOperation(id: string, actor: Actor, module: string, operation: string): Promise<string> {
    const result = await this.sql.query(`INSERT INTO core_operation_slots(owner,module,operation,job_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(owner,module,operation) DO UPDATE SET
        job_id=CASE WHEN core_operation_slots.active THEN core_operation_slots.job_id ELSE excluded.job_id END,
        active=true,updated_at=now() RETURNING job_id`, [ownerKey(actor), module, operation, id]);
    return result.rows[0].job_id;
  }
  /** One statement makes slot admission and both original/duplicate jobs atomic. */
  async enqueueOperation(id: string, actor: Actor, payload: Record<string, unknown>, module: string, operation: string, label = operation) {
    await this.sql.query(`WITH slot AS (
      INSERT INTO core_operation_slots(owner,module,operation,job_id) SELECT $2,$5,$6,$1
      WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE id=$1)
      ON CONFLICT(owner,module,operation) DO UPDATE SET
        job_id=CASE WHEN core_operation_slots.active THEN core_operation_slots.job_id ELSE excluded.job_id END,
        active=true, updated_at=now()
      RETURNING job_id
    )
    INSERT INTO jobs(id,owner,actor,payload,module)
    SELECT $1,$2,$3,CASE WHEN slot.job_id=$1 THEN $4::jsonb
      ELSE jsonb_build_object('type','operation_busy','operation', $7::text,'original',slot.job_id) END,
      CASE WHEN slot.job_id=$1 THEN $5 ELSE 'core' END
    FROM slot ON CONFLICT DO NOTHING`, [id, ownerKey(actor), JSON.stringify(actor), JSON.stringify(payload), module, operation, label]);
  }
  async complete(id: string) {
    await this.sql.query(`WITH finished AS (
      UPDATE jobs SET status='done',finished_at=now(),payload='{}'::jsonb WHERE id=$1 RETURNING id
    ) UPDATE core_operation_slots s SET active=false,updated_at=now()
      FROM finished WHERE s.job_id=finished.id`, [id]);
  }
  async retryOrFail(id: string) {
    await this.sql.query(`WITH updated AS (
      UPDATE jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,
        available_at=now()+interval '30 seconds',finished_at=CASE WHEN attempts>=5 THEN now() ELSE NULL END
      WHERE id=$1 RETURNING id,status
    ) UPDATE core_operation_slots s SET active=false,updated_at=now()
      FROM updated WHERE s.job_id=updated.id AND updated.status='failed'`, [id]);
  }
  async cleanup() {
    await this.sql.query("DELETE FROM jobs WHERE finished_at<now()-interval '30 days'");
    await this.sql.query("DELETE FROM core_navigation_menus WHERE created_at<now()-interval '30 days'");
    await this.sql.query("DELETE FROM core_navigation_deliveries d WHERE created_at<now()-interval '30 days' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id=d.event_id AND j.status IN ('queued','running'))");
    await this.sql.query("DELETE FROM core_operation_slots WHERE NOT active AND updated_at<now()-interval '30 days'");
  }
}

export async function withOwner<T>(pool: Pool, actor: Actor, work: (client: PoolClient) => Promise<T>, scope = ''): Promise<T | undefined> {
  const client = await pool.connect();
  let locked = false;
  const key = scope ? `${ownerKey(actor)}:${scope}` : ownerKey(actor);
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [key])).rows[0].locked;
    if (!locked) return undefined;
    return await work(client);
  } finally {
    let releaseError: Error | undefined;
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); }
      catch { releaseError = new Error('Failed to release owner lock'); }
    }
    // Destroy a connection whose lock state is unknown rather than returning it to the pool.
    client.release(releaseError);
  }
}
