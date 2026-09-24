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

export class SlackChannelSelections {
  constructor(private sql: Sql) {}
  async list(actor: Actor): Promise<string[]> {
    const result = await this.sql.query('SELECT channel_id FROM slack_selected_channels WHERE owner=$1 ORDER BY channel_id', [ownerKey(actor)]);
    return result.rows.map(row => String(row.channel_id));
  }
  async add(actor: Actor, id: string): Promise<void> {
    await this.sql.query('INSERT INTO slack_selected_channels(owner,channel_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [ownerKey(actor), id]);
  }
  async remove(actor: Actor, id: string): Promise<void> {
    await this.sql.query('DELETE FROM slack_selected_channels WHERE owner=$1 AND channel_id=$2', [ownerKey(actor), id]);
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
    await this.sql.query("DELETE FROM slack_handled_events WHERE handled_at<now()-interval '30 days'");
  }
}
