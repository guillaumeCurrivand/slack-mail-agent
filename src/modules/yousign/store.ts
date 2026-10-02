import { ownerKey, uid, type Actor, type IntegrationActor } from '../../core/identity.js';
import { JobStore, type Sql } from '../../core/store.js';
import { transaction, type Database } from '../../core/transactions.js';
import type { EventSummary } from './events.js';

export const yousignSchema = `
CREATE TABLE IF NOT EXISTS yousign_integrations (team text NOT NULL, integration text NOT NULL, PRIMARY KEY(team,integration));
CREATE TABLE IF NOT EXISTS yousign_destinations (
 id uuid PRIMARY KEY, team text NOT NULL, integration text NOT NULL, channel_id text NOT NULL,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS yousign_active_destination ON yousign_destinations(team,integration,channel_id) WHERE active;
CREATE TABLE IF NOT EXISTS yousign_events (
 id uuid PRIMARY KEY, team text NOT NULL, integration text NOT NULL, event_id text NOT NULL, summary jsonb NOT NULL,
 status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(team,integration,event_id)
);
CREATE TABLE IF NOT EXISTS yousign_deliveries (
 id uuid PRIMARY KEY, team text NOT NULL, integration text NOT NULL,
 event uuid NOT NULL REFERENCES yousign_events(id) ON DELETE CASCADE,
 activation uuid NOT NULL REFERENCES yousign_destinations(id), channel_id text NOT NULL,
 status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0, next_at timestamptz NOT NULL DEFAULT now(),
 cause text, message_ts text, finished_at timestamptz, UNIQUE(event,activation)
);
CREATE INDEX IF NOT EXISTS yousign_delivery_due ON yousign_deliveries(team,integration,next_at) WHERE status='queued';
CREATE TABLE IF NOT EXISTS yousign_handled_events (
 team text NOT NULL, integration text NOT NULL, event_id text NOT NULL, owner text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(team,integration,event_id)
);
CREATE TABLE IF NOT EXISTS yousign_confirmations (
 id uuid PRIMARY KEY, team text NOT NULL, integration text NOT NULL, owner text NOT NULL, channel text NOT NULL,
 source_id text NOT NULL, delivery uuid NOT NULL REFERENCES yousign_deliveries(id) ON DELETE CASCADE,
 expected_attempt integer NOT NULL, status text NOT NULL DEFAULT 'pending',
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 UNIQUE(owner,source_id)
);
CREATE TABLE IF NOT EXISTS yousign_alerts (
 id uuid NOT NULL, team text NOT NULL, integration text NOT NULL, channel_id text NOT NULL, active boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0,
 next_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(team,integration,channel_id)
);`;

export type Delivery = { id: string; event: string; activation: string; channel_id: string; status: string; attempts: number; next_at: Date; cause: string | null; summary: EventSummary; created_at: Date; message_ts?: string };
export type Destination = { id: string; channel_id: string };
export type Alert = { id: string; channel_id: string; status: string; attempts: number; next_at: Date };

export class YousignStore {
  constructor(private database: Database, readonly actor: IntegrationActor) {}
  private get scope() { return [this.actor.team, this.actor.integration]; }
  private async locked<T>(work: (sql: Sql) => Promise<T>) {
    return transaction(this.database, async sql => {
      const guard = await sql.query('SELECT integration FROM yousign_integrations WHERE team=$1 AND integration=$2 FOR UPDATE', this.scope);
      if (!guard.rows.length) throw new Error('Integration is not initialized.');
      return work(sql);
    });
  }
  async initialize() {
    for (const statement of yousignSchema.split(';').filter(part => part.trim())) await this.database.query(statement);
    await this.database.query('INSERT INTO yousign_integrations(team,integration) VALUES($1,$2) ON CONFLICT DO NOTHING', this.scope);
  }
  async destinations(): Promise<Destination[]> {
    return (await this.database.query('SELECT id,channel_id FROM yousign_destinations WHERE team=$1 AND integration=$2 AND active ORDER BY channel_id', this.scope)).rows as Destination[];
  }
  async change(actor: Actor, eventId: string, channel: string, activation?: string) {
    if (actor.team !== this.actor.team) throw new Error('Unexpected workspace.');
    return this.locked(async sql => {
      const handled = await sql.query('INSERT INTO yousign_handled_events(team,integration,event_id,owner) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id', [...this.scope, eventId, ownerKey(actor)]);
      if (!handled.rows.length) return false;
      if (!activation) return !!(await sql.query('INSERT INTO yousign_destinations(id,team,integration,channel_id) VALUES($3,$1,$2,$4) ON CONFLICT DO NOTHING RETURNING id', [...this.scope, uid(), channel])).rows.length;
      else {
        const removed = await sql.query('UPDATE yousign_destinations SET active=false,removed_at=now() WHERE team=$1 AND integration=$2 AND id=$3 AND channel_id=$4 AND active RETURNING id', [...this.scope, activation, channel]);
        if (!removed.rows.length) return false;
        await sql.query("UPDATE yousign_deliveries SET status='cancelled',finished_at=now() WHERE team=$1 AND integration=$2 AND activation=$3 AND status='queued'", [...this.scope, activation]);
        await sql.query("UPDATE yousign_alerts SET active=false,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=now() WHERE team=$1 AND integration=$2 AND channel_id=$3 AND active", [...this.scope, channel]);
      }
      return true;
    });
  }
  async accept(summary: EventSummary) {
    return this.locked(async sql => {
      if ((await sql.query('SELECT id FROM yousign_events WHERE team=$1 AND integration=$2 AND event_id=$3', [...this.scope, summary.id])).rows.length) return;
      const destinations = (await sql.query('SELECT id,channel_id FROM yousign_destinations WHERE team=$1 AND integration=$2 AND active', this.scope)).rows;
      const id = uid();
      await sql.query("INSERT INTO yousign_events(id,team,integration,event_id,summary,status,finished_at) VALUES($3,$1,$2,$4,$5,$6,CASE WHEN $6='skipped' THEN now() ELSE NULL END)", [...this.scope, id, summary.id, JSON.stringify(summary), destinations.length ? 'accepted' : 'skipped']);
      if (destinations.length) await sql.query(`INSERT INTO yousign_deliveries(id,team,integration,event,activation,channel_id)
        SELECT gen_random_uuid(),$1,$2,$3,id,channel_id FROM yousign_destinations WHERE team=$1 AND integration=$2 AND active`, [...this.scope, id]);
      if (destinations.length) await new JobStore(sql).enqueueIntegration(`yousign:event:${id}`, this.actor, { type: 'event', event: id }, 'yousign');
    });
  }
  async deliveries(event: string): Promise<Delivery[]> {
    return (await this.database.query('SELECT d.*,e.summary,e.created_at FROM yousign_deliveries d JOIN yousign_events e ON e.id=d.event WHERE d.team=$1 AND d.integration=$2 AND d.event=$3 ORDER BY d.channel_id', [...this.scope, event])).rows as Delivery[];
  }
  async delivery(id: string): Promise<Delivery | undefined> {
    return (await this.database.query('SELECT d.*,e.summary,e.created_at FROM yousign_deliveries d JOIN yousign_events e ON e.id=d.event WHERE d.team=$1 AND d.integration=$2 AND d.id=$3', [...this.scope, id])).rows[0] as Delivery | undefined;
  }
  async claim(id: string): Promise<Delivery | undefined> {
    return this.locked(async sql => {
      await sql.query("UPDATE yousign_deliveries d SET status='cancelled',finished_at=now() WHERE d.team=$1 AND d.integration=$2 AND d.id=$3 AND d.status='queued' AND NOT EXISTS(SELECT 1 FROM yousign_destinations s WHERE s.id=d.activation AND s.active)", [...this.scope, id]);
      const claimed = await sql.query("UPDATE yousign_deliveries SET status='sending',attempts=attempts+1,cause=NULL WHERE team=$1 AND integration=$2 AND id=$3 AND status='queued' AND next_at<=now() RETURNING *", [...this.scope, id]);
      if (!claimed.rows.length) return;
      const row = claimed.rows[0];
      return { ...row, summary: (await sql.query('SELECT summary FROM yousign_events WHERE team=$1 AND integration=$2 AND id=$3', [...this.scope, row.event])).rows[0].summary } as Delivery;
    });
  }
  async finish(id: string, status: 'sent' | 'uncertain' | 'failed', message?: string, cause?: string) {
    await this.database.query("UPDATE yousign_deliveries SET status=$4,message_ts=$5,cause=$6,finished_at=now() WHERE team=$1 AND integration=$2 AND id=$3 AND status='sending'", [...this.scope, id, status, message ?? null, cause ?? null]);
  }
  async deferDelivery(id: string, until: Date, cause: string) {
    await this.locked(async sql => {
      const active = (await sql.query('SELECT s.active FROM yousign_deliveries d JOIN yousign_destinations s ON s.id=d.activation WHERE d.team=$1 AND d.integration=$2 AND d.id=$3', [...this.scope, id])).rows[0]?.active;
      if (active) await sql.query("UPDATE yousign_deliveries SET status='queued',next_at=$4,cause=$5,finished_at=NULL WHERE team=$1 AND integration=$2 AND id=$3 AND status IN ('queued','sending')", [...this.scope, id, until, cause]);
      else await sql.query("UPDATE yousign_deliveries SET status='cancelled',cause=NULL,finished_at=now() WHERE team=$1 AND integration=$2 AND id=$3 AND status IN ('queued','sending')", [...this.scope, id]);
    });
  }
  async retryKnown(actor: Actor, source: string, id: string, attempt: number) {
    return this.locked(async sql => {
      const handled = await sql.query('INSERT INTO yousign_handled_events(team,integration,event_id,owner) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id', [...this.scope, source, ownerKey(actor)]);
      if (!handled.rows.length) return false;
      const changed = (await sql.query(`UPDATE yousign_deliveries d SET status='queued',next_at=now(),finished_at=NULL
        WHERE d.team=$1 AND d.integration=$2 AND d.id=$3 AND status='failed' AND attempts=$4
        AND EXISTS(SELECT 1 FROM yousign_destinations s WHERE s.id=d.activation AND s.active) RETURNING event`, [...this.scope, id, attempt])).rows[0];
      if (!changed) return false;
      await sql.query('UPDATE yousign_events SET finished_at=NULL WHERE id=$1', [changed.event]);
      await new JobStore(sql).enqueueIntegration(`yousign:retry:${source}`, this.actor, { type: 'event', event: changed.event }, 'yousign');
      return true;
    });
  }
  async recoverSending(event: string) {
    await this.database.query("UPDATE yousign_deliveries SET status='uncertain',cause='interrupted',finished_at=now() WHERE team=$1 AND integration=$2 AND event=$3 AND status='sending'", [...this.scope, event]);
  }
  async problem(channel: string) {
    await this.database.query(`INSERT INTO yousign_alerts(id,team,integration,channel_id) VALUES($3,$1,$2,$4)
      ON CONFLICT(team,integration,channel_id) DO UPDATE SET id=excluded.id,active=true,status='queued',attempts=0,next_at=now(),updated_at=now() WHERE NOT yousign_alerts.active`, [...this.scope, uid(), channel]);
  }
  async alerts(): Promise<Alert[]> {
    return (await this.database.query("SELECT * FROM yousign_alerts WHERE team=$1 AND integration=$2 AND active AND status IN ('queued','sending') ORDER BY next_at", this.scope)).rows as Alert[];
  }
  async claimAlert(id: string) {
    return !!(await this.database.query("UPDATE yousign_alerts SET status='sending',attempts=attempts+1,updated_at=now() WHERE team=$1 AND integration=$2 AND id=$3 AND active AND status='queued' AND next_at<=now() RETURNING id", [...this.scope, id])).rows.length;
  }
  async finishAlert(id: string, status: 'sent' | 'uncertain' | 'queued', until = new Date()) {
    await this.database.query("UPDATE yousign_alerts SET status=$4,next_at=$5,updated_at=now() WHERE team=$1 AND integration=$2 AND id=$3 AND status='sending'", [...this.scope, id, status, until]);
  }
  async settle(event: string) {
    await this.database.query(`UPDATE yousign_alerts a SET active=false,status=CASE WHEN a.status='queued' THEN 'cancelled' ELSE a.status END,updated_at=now()
      WHERE a.team=$1 AND a.integration=$2 AND active AND NOT EXISTS (
        SELECT 1 FROM yousign_deliveries d JOIN yousign_destinations s ON s.id=d.activation AND s.active
        WHERE d.team=$1 AND d.integration=$2 AND d.channel_id=a.channel_id AND d.status IN ('queued','sending','uncertain','failed')
          AND (d.status='sending' OR d.cause IS NOT NULL))`, this.scope);
    await this.database.query("UPDATE yousign_events e SET finished_at=COALESCE(finished_at,now()) WHERE team=$1 AND integration=$2 AND id=$3 AND NOT EXISTS(SELECT 1 FROM yousign_deliveries d WHERE d.event=e.id AND d.status IN ('queued','sending'))", [...this.scope, event]);
  }
  async history(channels: string[], offset: number) {
    return (await this.database.query(`SELECT d.*,e.summary,e.created_at FROM yousign_deliveries d JOIN yousign_events e ON e.id=d.event
      WHERE d.team=$1 AND d.integration=$2 AND d.channel_id=ANY($3::text[]) ORDER BY e.created_at DESC,d.id LIMIT 9 OFFSET $4`, [...this.scope, channels, offset])).rows as Delivery[];
  }
  async lastReceipt(): Promise<Date | undefined> {
    return (await this.database.query('SELECT created_at FROM yousign_events WHERE team=$1 AND integration=$2 ORDER BY created_at DESC LIMIT 1', this.scope)).rows[0]?.created_at;
  }
  async propose(actor: Actor, source: string, delivery: string) {
    return this.locked(async sql => {
      const row = (await sql.query("SELECT attempts FROM yousign_deliveries WHERE team=$1 AND integration=$2 AND id=$3 AND status='uncertain'", [...this.scope, delivery])).rows[0];
      if (!row) return;
      return (await sql.query(`INSERT INTO yousign_confirmations(id,team,integration,owner,channel,source_id,delivery,expected_attempt)
        VALUES($3,$1,$2,$4,$5,$6,$7,$8) ON CONFLICT(owner,source_id) DO UPDATE SET source_id=excluded.source_id RETURNING id`, [...this.scope, uid(), ownerKey(actor), actor.channel, source, delivery, row.attempts])).rows[0].id as string;
    });
  }
  async confirmation(actor: Actor, id: string) {
    return (await this.database.query(`SELECT c.*,d.channel_id FROM yousign_confirmations c JOIN yousign_deliveries d ON d.id=c.delivery
      WHERE c.team=$1 AND c.integration=$2 AND c.id=$3 AND c.owner=$4 AND c.channel=$5 AND c.expires_at>now()`, [...this.scope, id, ownerKey(actor), actor.channel])).rows[0];
  }
  async confirm(actor: Actor, id: string) {
    return this.locked(async sql => {
      const proposal = (await sql.query("SELECT * FROM yousign_confirmations WHERE team=$1 AND integration=$2 AND id=$3 AND owner=$4 AND channel=$5 AND status='pending' AND expires_at>now() FOR UPDATE", [...this.scope, id, ownerKey(actor), actor.channel])).rows[0];
      if (!proposal) return false;
      const changed = (await sql.query(`UPDATE yousign_deliveries d SET status='queued',next_at=now(),finished_at=NULL
        WHERE d.team=$1 AND d.integration=$2 AND d.id=$3 AND d.status='uncertain' AND d.attempts=$4
        AND EXISTS(SELECT 1 FROM yousign_destinations s WHERE s.id=d.activation AND s.active) RETURNING event`, [...this.scope, proposal.delivery, proposal.expected_attempt])).rows[0];
      await sql.query("UPDATE yousign_confirmations SET status=$2 WHERE id=$1", [id, changed ? 'applied' : 'cancelled']);
      if (!changed) return false;
      await sql.query('UPDATE yousign_events SET finished_at=NULL WHERE id=$1', [changed.event]);
      await new JobStore(sql).enqueueIntegration(`yousign:resend:${id}`, this.actor, { type: 'event', event: changed.event }, 'yousign');
      return true;
    });
  }
  async cleanup() {
    await this.locked(async sql => {
      await sql.query(`DELETE FROM yousign_events e WHERE team=$1 AND integration=$2 AND finished_at<now()-interval '30 days'
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.module='yousign' AND j.status IN ('queued','running') AND j.payload->>'event'=e.id::text)
        AND NOT EXISTS(SELECT 1 FROM yousign_deliveries d LEFT JOIN yousign_confirmations c ON c.delivery=d.id
          JOIN jobs j ON j.module='yousign' AND j.status IN ('queued','running') AND j.actor->>'team'=e.team
            AND (split_part(j.payload->>'value','|',2)=d.id::text OR split_part(j.payload->>'value','|',2)=c.id::text)
          WHERE d.event=e.id)`, this.scope);
      await sql.query("DELETE FROM yousign_destinations s WHERE team=$1 AND integration=$2 AND NOT active AND removed_at<now()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM yousign_deliveries d WHERE d.activation=s.id)", this.scope);
      await sql.query("DELETE FROM yousign_handled_events h WHERE team=$1 AND integration=$2 AND created_at<now()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.id=h.event_id AND j.status IN ('queued','running'))", this.scope);
      await sql.query("DELETE FROM yousign_confirmations c WHERE team=$1 AND integration=$2 AND created_at<now()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.module='yousign' AND j.owner=c.owner AND j.status IN ('queued','running'))", this.scope);
      await sql.query(`UPDATE yousign_alerts a SET active=false,updated_at=now() WHERE team=$1 AND integration=$2 AND active
        AND NOT EXISTS(SELECT 1 FROM yousign_deliveries d JOIN yousign_destinations s ON s.id=d.activation AND s.active
          WHERE d.team=$1 AND d.integration=$2 AND d.channel_id=a.channel_id AND d.status IN ('queued','sending','uncertain','failed')
            AND (d.status='sending' OR d.cause IS NOT NULL))`, this.scope);
      await sql.query("DELETE FROM yousign_alerts WHERE team=$1 AND integration=$2 AND NOT active AND updated_at<now()-interval '30 days'", this.scope);
    });
  }
}
