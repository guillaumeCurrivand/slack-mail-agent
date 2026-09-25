import { ownerKey, type Actor } from '../../core/identity.js';
import type { Sql } from '../../core/store.js';

export const slackSchema = `CREATE TABLE IF NOT EXISTS slack_selected_channels (
  owner text NOT NULL,
  channel_id text NOT NULL,
  PRIMARY KEY (owner, channel_id)
);`;
export const slackHandledSchema = `CREATE TABLE IF NOT EXISTS slack_handled_events (
  owner text NOT NULL,
  event_id text NOT NULL,
  handled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, event_id)
);`;
export const slackAiSchema = `CREATE TABLE IF NOT EXISTS slack_ai_attempts (
  owner text NOT NULL,
  event_id text NOT NULL,
  batch_index integer NOT NULL,
  input_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('started','complete','budget')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner,event_id,batch_index)
);`;

export class SlackAiAttempts {
  constructor(private sql: Sql) {}
  async start(actor: Actor, eventId: string, batch: number, hash: string) {
    const owner = ownerKey(actor);
    const inserted = await this.sql.query(`INSERT INTO slack_ai_attempts(owner,event_id,batch_index,input_hash,status)
      VALUES($1,$2,$3,$4,'started') ON CONFLICT DO NOTHING RETURNING event_id`, [owner, eventId, batch, hash]);
    const row = (await this.sql.query(`SELECT input_hash,status,result FROM slack_ai_attempts
      WHERE owner=$1 AND event_id=$2 AND batch_index=$3`, [owner, eventId, batch])).rows[0];
    if (!row) throw new Error('Slack AI checkpoint could not be loaded.');
    return { created: inserted.rows.length === 1, hash: String(row.input_hash), status: String(row.status), result: row.result };
  }
  async complete(actor: Actor, eventId: string, batch: number, hash: string, result: unknown) {
    const updated = await this.sql.query(`UPDATE slack_ai_attempts SET status='complete',result=$5
      WHERE owner=$1 AND event_id=$2 AND batch_index=$3 AND input_hash=$4 AND status='started' RETURNING event_id`,
      [ownerKey(actor), eventId, batch, hash, JSON.stringify(result)]);
    if (updated.rows.length !== 1) throw new Error('Slack AI checkpoint could not be completed.');
  }
  async budget(actor: Actor, eventId: string, batch: number, hash: string) {
    await this.sql.query(`UPDATE slack_ai_attempts SET status='budget'
      WHERE owner=$1 AND event_id=$2 AND batch_index=$3 AND input_hash=$4 AND status='started'`,
      [ownerKey(actor), eventId, batch, hash]);
  }
  async cleanup() {
    await this.sql.query(`DELETE FROM slack_ai_attempts AS attempt
      WHERE attempt.created_at<now()-interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id=attempt.event_id AND jobs.status IN ('queued','running'))`);
  }
}

export class SlackChannelSelections {
  constructor(private sql: Sql) {}
  async list(actor: Actor): Promise<string[]> {
    const result = await this.sql.query('SELECT channel_id FROM slack_selected_channels WHERE owner=$1 ORDER BY channel_id', [ownerKey(actor)]);
    return result.rows.map(row => String(row.channel_id));
  }
  async addOnce(actor: Actor, eventId: string, id: string): Promise<boolean> {
    const result = await this.sql.query(`WITH claim AS (
      INSERT INTO slack_handled_events(owner,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id
    ), changed AS (
      INSERT INTO slack_selected_channels(owner,channel_id) SELECT $1,$3 FROM claim ON CONFLICT DO NOTHING RETURNING channel_id
    ) SELECT EXISTS(SELECT 1 FROM claim) AS claimed`, [ownerKey(actor), eventId, id]);
    return result.rows[0]?.claimed === true;
  }
  async removeOnce(actor: Actor, eventId: string, id: string): Promise<boolean> {
    const result = await this.sql.query(`WITH claim AS (
      INSERT INTO slack_handled_events(owner,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id
    ), changed AS (
      DELETE FROM slack_selected_channels WHERE owner=$1 AND channel_id=$3 AND EXISTS(SELECT 1 FROM claim) RETURNING channel_id
    ) SELECT EXISTS(SELECT 1 FROM claim) AS claimed`, [ownerKey(actor), eventId, id]);
    return result.rows[0]?.claimed === true;
  }
  async handled(actor: Actor, eventId: string): Promise<boolean> {
    const result = await this.sql.query('SELECT 1 FROM slack_handled_events WHERE owner=$1 AND event_id=$2', [ownerKey(actor), eventId]);
    return result.rows.length > 0;
  }
  async markHandled(actor: Actor, eventId: string): Promise<void> {
    await this.sql.query('INSERT INTO slack_handled_events(owner,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [ownerKey(actor), eventId]);
  }
  async unmarkHandled(actor: Actor, eventId: string): Promise<void> {
    await this.sql.query('DELETE FROM slack_handled_events WHERE owner=$1 AND event_id=$2', [ownerKey(actor), eventId]);
  }
  async cleanup(): Promise<void> {
    await this.sql.query(`DELETE FROM slack_handled_events AS handled
      WHERE handled.handled_at<now()-interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id=handled.event_id AND jobs.owner=handled.owner
        AND jobs.module='slack' AND jobs.status IN ('queued','running'))`);
  }
}
