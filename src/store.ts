import type { Pool, PoolClient } from 'pg';
import { emptyState, ownerKey, type Actor, type UserState } from './domain.js';

export interface Sql { query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount?: number | null }> }
export const schema = `
CREATE TABLE IF NOT EXISTS users (
 owner text PRIMARY KEY, team text NOT NULL, slack_user text NOT NULL,
 google_subject text, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(team,google_subject)
);
CREATE TABLE IF NOT EXISTS jobs (
 id text PRIMARY KEY, owner text NOT NULL, actor jsonb NOT NULL, payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), available_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(available_at,created_at) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS oauth_states (
 hash text PRIMARY KEY, kind text NOT NULL, encrypted text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE TABLE IF NOT EXISTS ai_months (
 month text PRIMARY KEY, charged_micro bigint NOT NULL DEFAULT 0, reserved_micro bigint NOT NULL DEFAULT 0,
 alert_sent boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS ai_calls (
 id text PRIMARY KEY, month text NOT NULL REFERENCES ai_months(month), owner text NOT NULL,
 reserved_micro bigint NOT NULL, charged_micro bigint, status text NOT NULL DEFAULT 'reserved',
 created_at timestamptz NOT NULL DEFAULT now()
);
`;

export class Store {
  constructor(readonly sql: Sql) {}
  async load(actor: Actor): Promise<UserState> {
    const result = await this.sql.query('SELECT state FROM users WHERE owner=$1', [ownerKey(actor)]);
    return result.rows[0]?.state ?? emptyState();
  }
  async save(actor: Actor, state: UserState) {
    await this.sql.query(`INSERT INTO users(owner,team,slack_user,google_subject,state) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(owner) DO UPDATE SET google_subject=excluded.google_subject,state=excluded.state,updated_at=now()`,
    [ownerKey(actor), actor.team, actor.user, state.connection?.subject ?? null, JSON.stringify(state)]);
  }
  async enqueue(id: string, actor: Actor, payload: unknown) {
    await this.sql.query('INSERT INTO jobs(id,owner,actor,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, ownerKey(actor), JSON.stringify(actor), JSON.stringify(payload)]);
  }
  async putState(hash: string, kind: string, encrypted: string) {
    await this.sql.query('INSERT INTO oauth_states(hash,kind,encrypted) VALUES($1,$2,$3)', [hash, kind, encrypted]);
  }
  async takeState(hash: string, kind: string): Promise<string | undefined> {
    const result = await this.sql.query('DELETE FROM oauth_states WHERE hash=$1 AND kind=$2 AND expires_at>now() RETURNING encrypted', [hash, kind]);
    return result.rows[0]?.encrypted;
  }
  async cleanup() {
    await this.sql.query('DELETE FROM oauth_states WHERE expires_at<now()');
    await this.sql.query("DELETE FROM jobs WHERE finished_at<now()-interval '30 days'");
    // Active user state is pruned under its owner lock by pruneUsers, not by a racing SQL update.
  }
}

export function prune(state: UserState, now = Date.now()) {
  const cutoff = now - 30 * 86400_000;
  state.history = state.history.filter(x => Date.parse(x.at) > cutoff);
  state.runs = state.runs.filter(x => Date.parse(x.created) > cutoff);
  state.drafts = state.drafts.filter(x => Date.parse(x.created) > now - 24 * 3600_000);
  state.handled = state.handled.slice(-2000);
}

export async function withOwner<T>(pool: Pool, actor: Actor, work: (store: Store, client: PoolClient) => Promise<T>): Promise<T | undefined> {
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [ownerKey(actor)])).rows[0].locked;
    if (!locked) return undefined;
    return await work(new Store(client), client);
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
