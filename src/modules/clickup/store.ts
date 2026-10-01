import { ownerKey, uid, type Actor } from '../../core/identity.js';
import type { Sql } from '../../core/store.js';
import type { Confirmation, Connection, Scan } from './domain.js';

export const clickupSchema = `
CREATE TABLE IF NOT EXISTS clickup_authorizations (
 owner text PRIMARY KEY, generation text NOT NULL
);
CREATE TABLE IF NOT EXISTS clickup_connections (
 owner text PRIMARY KEY, team text NOT NULL, subject text NOT NULL, connection_id text NOT NULL,
 identity jsonb NOT NULL, tokens text NOT NULL, UNIQUE(team,subject)
);
CREATE TABLE IF NOT EXISTS clickup_oauth_states (
 hash text PRIMARY KEY, owner text NOT NULL, kind text NOT NULL, encrypted text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE TABLE IF NOT EXISTS clickup_confirmations (
 id text PRIMARY KEY, owner text NOT NULL, channel text NOT NULL, source_id text NOT NULL,
 kind text NOT NULL, data jsonb NOT NULL, expected text, status text NOT NULL DEFAULT 'pending', result_id text,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours', UNIQUE(owner,channel,source_id)
);
CREATE TABLE IF NOT EXISTS clickup_scans (
 id text PRIMARY KEY, owner text NOT NULL, channel text NOT NULL, connection_id text NOT NULL, data jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours'
);
CREATE TABLE IF NOT EXISTS clickup_limits (
 owner text PRIMARY KEY, connection_id text NOT NULL, retry_at timestamptz NOT NULL
);
`;

export class ClickupStore {
  constructor(private sql: Sql) {}
  async connection(actor: Actor): Promise<Connection | undefined> {
    const row = (await this.sql.query('SELECT * FROM clickup_connections WHERE owner=$1', [ownerKey(actor)])).rows[0];
    return row ? { id: row.connection_id, identity: row.identity, tokens: row.tokens } : undefined;
  }
  async putState(hash: string, actor: Actor, kind: string, encrypted: string) {
    await this.sql.query('INSERT INTO clickup_oauth_states(hash,owner,kind,encrypted) VALUES($1,$2,$3,$4)', [hash, ownerKey(actor), kind, encrypted]);
  }
  async generation(actor: Actor): Promise<string> {
    await this.sql.query('INSERT INTO clickup_authorizations(owner,generation) VALUES($1,$2) ON CONFLICT DO NOTHING', [ownerKey(actor), uid()]);
    return (await this.sql.query('SELECT generation FROM clickup_authorizations WHERE owner=$1', [ownerKey(actor)])).rows[0].generation;
  }
  async readState(hash: string, kind: string): Promise<string | undefined> {
    return (await this.sql.query('SELECT encrypted FROM clickup_oauth_states WHERE hash=$1 AND kind=$2 AND expires_at>now()', [hash, kind])).rows[0]?.encrypted;
  }
  async takeState(hash: string, kind: string): Promise<string | undefined> {
    return (await this.sql.query('DELETE FROM clickup_oauth_states WHERE hash=$1 AND kind=$2 AND expires_at>now() RETURNING encrypted', [hash, kind])).rows[0]?.encrypted;
  }
  async propose(actor: Actor, source: string, kind: Confirmation['kind'], data: Confirmation['data'], expected: string | null): Promise<string> {
    const row = (await this.sql.query(`INSERT INTO clickup_confirmations(id,owner,channel,source_id,kind,data,expected) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(owner,channel,source_id) DO UPDATE SET source_id=excluded.source_id RETURNING id`, [uid(), ownerKey(actor), actor.channel, source, kind, JSON.stringify(data), expected])).rows[0];
    return row.id;
  }
  async confirmation(actor: Actor, id: string, includeApplied = false): Promise<Confirmation | undefined> {
    return (await this.sql.query(`SELECT id,kind,data,expected,status,result_id AS "resultId" FROM clickup_confirmations WHERE id=$1 AND owner=$2 AND channel=$3 AND (status='pending' OR ($4 AND status='applied')) AND expires_at>now()`, [id, ownerKey(actor), actor.channel, includeApplied])).rows[0];
  }
  async cancel(actor: Actor, id: string) {
    await this.sql.query("UPDATE clickup_confirmations SET status='cancelled',data='{}' WHERE id=$1 AND owner=$2 AND channel=$3 AND status='pending'", [id, ownerKey(actor), actor.channel]);
  }
  async activate(actor: Actor, id: string): Promise<boolean> {
    const row = (await this.sql.query(`WITH proposal AS (
      SELECT * FROM clickup_confirmations WHERE id=$1 AND owner=$2 AND channel=$3 AND kind='connect' AND status='pending' AND expires_at>now() FOR UPDATE
    ), changed AS (
      INSERT INTO clickup_connections(owner,team,subject,connection_id,identity,tokens)
      SELECT owner,$4,data->'identity'->>'id',data->>'id',data->'identity',data->>'tokens' FROM proposal
      WHERE expected IS NOT DISTINCT FROM (SELECT connection_id FROM clickup_connections WHERE owner=$2)
      ON CONFLICT(owner) DO UPDATE SET subject=excluded.subject,connection_id=excluded.connection_id,identity=excluded.identity,tokens=excluded.tokens
      WHERE clickup_connections.connection_id IS NOT DISTINCT FROM (SELECT expected FROM proposal) RETURNING owner
    ), consumed AS (
      UPDATE clickup_confirmations SET status='applied',result_id=data->>'id',data='{}' FROM changed WHERE id=$1 RETURNING clickup_confirmations.id
    ), removed AS (DELETE FROM clickup_scans WHERE owner=$2 AND EXISTS(SELECT 1 FROM consumed)),
    limits AS (DELETE FROM clickup_limits WHERE owner=$2 AND EXISTS(SELECT 1 FROM consumed)),
    generation AS (UPDATE clickup_authorizations SET generation=$5 WHERE owner=$2 AND EXISTS(SELECT 1 FROM consumed)),
    states AS (DELETE FROM clickup_oauth_states WHERE owner=$2 AND EXISTS(SELECT 1 FROM consumed)),
    pending AS (UPDATE clickup_confirmations SET status='cancelled',data='{}' WHERE owner=$2 AND id<>$1 AND kind='connect' AND status='pending' AND EXISTS(SELECT 1 FROM consumed))
    SELECT id FROM consumed`, [id, ownerKey(actor), actor.channel, actor.team, uid()])).rows[0];
    return !!row;
  }
  async disconnect(actor: Actor, id: string): Promise<boolean> {
    const row = (await this.sql.query(`WITH proposal AS (
      SELECT * FROM clickup_confirmations WHERE id=$1 AND owner=$2 AND channel=$3 AND kind='disconnect' AND status='pending' AND expires_at>now() FOR UPDATE
    ), removed AS (
      DELETE FROM clickup_connections WHERE owner=$2 AND connection_id=(SELECT expected FROM proposal) RETURNING owner
    ), consumed AS (UPDATE clickup_confirmations SET status='applied',result_id=expected,data='{}' WHERE id=$1 AND EXISTS(SELECT 1 FROM removed) RETURNING id),
    scans AS (DELETE FROM clickup_scans WHERE owner=$2 AND EXISTS(SELECT 1 FROM consumed)),
    limits AS (DELETE FROM clickup_limits WHERE owner=$2 AND EXISTS(SELECT 1 FROM consumed)),
    states AS (DELETE FROM clickup_oauth_states WHERE owner=$2 AND EXISTS(SELECT 1 FROM consumed)),
    generation AS (UPDATE clickup_authorizations SET generation=$4 WHERE owner=$2 AND EXISTS(SELECT 1 FROM consumed)),
    pending AS (UPDATE clickup_confirmations SET status='cancelled',data='{}' WHERE owner=$2 AND kind='connect' AND status='pending' AND EXISTS(SELECT 1 FROM consumed))
    SELECT id FROM consumed`, [id, ownerKey(actor), actor.channel, uid()])).rows[0];
    return !!row;
  }
  async scan(actor: Actor, id: string, includeExpired = false): Promise<Scan | undefined> {
    return (await this.sql.query('SELECT data FROM clickup_scans WHERE id=$1 AND owner=$2 AND channel=$3 AND ($4 OR expires_at>now())', [id, ownerKey(actor), actor.channel, includeExpired])).rows[0]?.data;
  }
  async saveScan(actor: Actor, id: string, scan: Scan) {
    await this.sql.query(`INSERT INTO clickup_scans(id,owner,channel,connection_id,data) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE clickup_scans.owner=excluded.owner AND clickup_scans.channel=excluded.channel`, [id, ownerKey(actor), actor.channel, scan.connectionId, JSON.stringify(scan)]);
  }
  async retryAt(actor: Actor, connectionId: string): Promise<number> {
    const row = (await this.sql.query('SELECT retry_at FROM clickup_limits WHERE owner=$1 AND connection_id=$2', [ownerKey(actor), connectionId])).rows[0];
    return row ? new Date(row.retry_at).getTime() : 0;
  }
  async blockUntil(actor: Actor, connectionId: string, until: number) {
    await this.sql.query(`INSERT INTO clickup_limits(owner,connection_id,retry_at)
      SELECT owner,connection_id,$3 FROM clickup_connections WHERE owner=$1 AND connection_id=$2
      ON CONFLICT(owner) DO UPDATE SET connection_id=excluded.connection_id,retry_at=excluded.retry_at`, [ownerKey(actor), connectionId, new Date(until)]);
  }
  async cleanup(actor: Actor) {
    await this.sql.query('DELETE FROM clickup_oauth_states WHERE owner=$1 AND expires_at<now()', [ownerKey(actor)]);
    await this.sql.query("DELETE FROM clickup_confirmations c WHERE owner=$1 AND expires_at<now() AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id IN(c.source_id,'clickup-connection:'||c.id) AND j.status IN ('queued','running'))", [ownerKey(actor)]);
    await this.sql.query("DELETE FROM clickup_scans WHERE owner=$1 AND expires_at<now() AND id NOT IN (SELECT id FROM jobs WHERE status IN ('queued','running'))", [ownerKey(actor)]);
    await this.sql.query('DELETE FROM clickup_limits WHERE owner=$1 AND retry_at<now()', [ownerKey(actor)]);
  }
}
