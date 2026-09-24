import { emptyState, ownerKey, type Actor, type UserState } from './domain.js';
import type { Sql } from '../../core/store.js';

// Keep the original table names and credential contexts for existing installations.
export const mailSchema = `
CREATE TABLE IF NOT EXISTS users (
 owner text PRIMARY KEY, team text NOT NULL, slack_user text NOT NULL,
 google_subject text, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(team,google_subject)
);
CREATE TABLE IF NOT EXISTS oauth_states (
 hash text PRIMARY KEY, kind text NOT NULL, encrypted text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
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
  async putState(hash: string, kind: string, encrypted: string) {
    await this.sql.query('INSERT INTO oauth_states(hash,kind,encrypted) VALUES($1,$2,$3)', [hash, kind, encrypted]);
  }
  async takeState(hash: string, kind: string): Promise<string | undefined> {
    const result = await this.sql.query('DELETE FROM oauth_states WHERE hash=$1 AND kind=$2 AND expires_at>now() RETURNING encrypted', [hash, kind]);
    return result.rows[0]?.encrypted;
  }
  async cleanup() { await this.sql.query('DELETE FROM oauth_states WHERE expires_at<now()'); }
}

export function prune(state: UserState, now = Date.now()) {
  const cutoff = now - 30 * 86400_000;
  state.history = state.history.filter(x => Date.parse(x.at) > cutoff);
  state.runs = state.runs.filter(x => Date.parse(x.created) > cutoff);
  state.drafts = state.drafts.filter(x => Date.parse(x.created) > now - 24 * 3600_000);
  state.handled = state.handled.slice(-2000);
}
