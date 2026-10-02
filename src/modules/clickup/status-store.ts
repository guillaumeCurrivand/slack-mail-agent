import { ownerKey, uid, type Actor } from '../../core/identity.js';
import type { Sql } from '../../core/store.js';
import type { StatusCatalogue, StatusEditor, StatusFilter } from './domain.js';

export const statusSchema = `
CREATE TABLE IF NOT EXISTS clickup_status_preferences (
 owner text NOT NULL, workspace text NOT NULL, version text NOT NULL, filter jsonb NOT NULL,
 PRIMARY KEY(owner,workspace)
);
CREATE TABLE IF NOT EXISTS clickup_status_editors (
 id text PRIMARY KEY, owner text NOT NULL, channel text NOT NULL, workspace text NOT NULL,
 source_id text NOT NULL, connection_id text NOT NULL, version text NOT NULL, data jsonb NOT NULL,
 state text NOT NULL DEFAULT 'editing', expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 UNIQUE(owner,channel,source_id)
);
CREATE TABLE IF NOT EXISTS clickup_status_events (
 owner text NOT NULL, event_id text NOT NULL, editor_id text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days', PRIMARY KEY(owner,event_id)
);
`;

export class ClickupStatusStore {
  constructor(private sql: Sql, private workspace: string) {}
  async preference(actor: Actor): Promise<{ version: string; filter: StatusFilter }> {
    await this.sql.query(`INSERT INTO clickup_status_preferences(owner,workspace,version,filter) VALUES($1,$2,$3,'{"mode":"default"}') ON CONFLICT DO NOTHING`, [ownerKey(actor), this.workspace, uid()]);
    return (await this.sql.query('SELECT version,filter FROM clickup_status_preferences WHERE owner=$1 AND workspace=$2', [ownerKey(actor), this.workspace])).rows[0];
  }
  async editor(actor: Actor, reference: string, source = false): Promise<StatusEditor | undefined> {
    return (await this.sql.query(`SELECT id,connection_id AS "connectionId",version,data,state FROM clickup_status_editors WHERE ${source ? 'source_id' : 'id'}=$1 AND owner=$2 AND channel=$3 AND workspace=$4 AND expires_at>now()`, [reference, ownerKey(actor), actor.channel, this.workspace])).rows[0];
  }
  async catalogue(actor: Actor, connectionId: string): Promise<StatusCatalogue | undefined> {
    const row = (await this.sql.query(`SELECT data->'catalogue' AS catalogue FROM clickup_status_editors
      WHERE owner=$1 AND channel=$2 AND workspace=$3 AND connection_id=$4 AND expires_at>now()
      AND data->'catalogue'->>'complete'='true' AND data->'catalogue'->>'checkedAt'>$5
      ORDER BY data->'catalogue'->>'checkedAt' DESC LIMIT 1`,
    [ownerKey(actor), actor.channel, this.workspace, connectionId, new Date(Date.now() - 5 * 60_000).toISOString()])).rows[0];
    return row?.catalogue;
  }
  async open(actor: Actor, eventId: string, connectionId: string, catalogue: StatusCatalogue): Promise<StatusEditor | undefined> {
    const preference = await this.preference(actor);
    const data = { filter: preference.filter, catalogue };
    const row = (await this.sql.query(`INSERT INTO clickup_status_editors(id,owner,channel,workspace,source_id,connection_id,version,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(owner,channel,source_id) DO UPDATE SET source_id=excluded.source_id RETURNING id`, [uid(), ownerKey(actor), actor.channel, this.workspace, eventId, connectionId, preference.version, JSON.stringify(data)])).rows[0];
    return this.editor(actor, row.id);
  }
  async handled(actor: Actor, eventId: string, editorId: string): Promise<boolean> {
    return !!(await this.sql.query('SELECT event_id FROM clickup_status_events WHERE owner=$1 AND event_id=$2 AND editor_id=$3', [ownerKey(actor), eventId, editorId])).rows.length;
  }
  async edit(actor: Actor, editor: StatusEditor, eventId: string, data: StatusEditor['data'], state: 'editing' | 'cancelled' = 'editing'): Promise<void> {
    await this.sql.query(`WITH target AS (
      SELECT id FROM clickup_status_editors WHERE id=$1 AND owner=$2 AND channel=$3 AND workspace=$4 AND connection_id=$5 AND state='editing' AND expires_at>now()
      AND EXISTS(SELECT 1 FROM clickup_connections WHERE owner=$2 AND connection_id=$5) FOR UPDATE
    ), claimed AS (
      INSERT INTO clickup_status_events(owner,event_id,editor_id) SELECT $2,$6,id FROM target ON CONFLICT DO NOTHING RETURNING editor_id
    ) UPDATE clickup_status_editors SET data=$7,state=$8 WHERE id IN(SELECT editor_id FROM claimed)`,
    [editor.id, ownerKey(actor), actor.channel, this.workspace, editor.connectionId, eventId, JSON.stringify(data), state]);
  }
  async save(actor: Actor, editor: StatusEditor, eventId: string): Promise<void> {
    await this.sql.query(`WITH target AS (
      SELECT * FROM clickup_status_editors WHERE id=$1 AND owner=$2 AND channel=$3 AND workspace=$4 AND connection_id=$5 AND state='editing' AND expires_at>now()
      AND EXISTS(SELECT 1 FROM clickup_connections WHERE owner=$2 AND connection_id=$5) FOR UPDATE
    ), claimed AS (
      INSERT INTO clickup_status_events(owner,event_id,editor_id) SELECT $2,$6,id FROM target ON CONFLICT DO NOTHING RETURNING editor_id
    ), changed AS (
      UPDATE clickup_status_preferences SET filter=target.data->'filter',version=$7 FROM target,claimed
      WHERE clickup_status_preferences.owner=$2 AND clickup_status_preferences.workspace=$4 AND clickup_status_preferences.version=target.version AND claimed.editor_id=target.id
      AND target.data->'catalogue'->>'complete'='true'
      AND (target.data->'filter'->>'mode'='default' OR jsonb_array_length(target.data->'filter'->'names')>0) RETURNING clickup_status_preferences.owner
    ) UPDATE clickup_status_editors SET state=CASE WHEN EXISTS(SELECT 1 FROM changed) THEN 'saved' ELSE 'conflict' END WHERE id IN(SELECT editor_id FROM claimed)`,
    [editor.id, ownerKey(actor), actor.channel, this.workspace, editor.connectionId, eventId, uid()]);
  }
  async cleanup(actor: Actor) {
    await this.sql.query(`DELETE FROM clickup_status_editors e WHERE owner=$1 AND expires_at<=now()
      AND NOT EXISTS(SELECT 1 FROM jobs WHERE id=e.source_id AND status IN('queued','running'))
      AND NOT EXISTS(SELECT 1 FROM clickup_status_events a JOIN jobs j ON j.id=a.event_id WHERE a.editor_id=e.id AND j.status IN('queued','running'))`, [ownerKey(actor)]);
    await this.sql.query(`DELETE FROM clickup_status_events WHERE owner=$1 AND expires_at<=now() AND NOT EXISTS(SELECT 1 FROM jobs WHERE id=event_id AND status IN('queued','running'))`, [ownerKey(actor)]);
  }
}
