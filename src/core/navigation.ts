import { ownerKey, uid, type Actor } from './identity.js';
import { SlackDeliveryRejected, type AgentMessage, type Messenger } from './slack.js';
import type { Sql } from './store.js';

export type MenuPage = AgentMessage & { links?: Array<{ label: string; page: string }> };
export type MenuTarget = { id: string; timestamp: string };

/** Only recorded Agent menus can be edited; workflow Cards are never update targets. */
export class Navigation {
  constructor(private sql: Sql, private messenger: Messenger) {}

  async target(actor: Actor, value: unknown, timestamp: unknown): Promise<{ target: MenuTarget; page: string } | undefined> {
    if (typeof value !== 'string' || typeof timestamp !== 'string') return;
    const [id, page, extra] = value.split('|');
    if (!id || !page || extra !== undefined || !/^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)?$/.test(page)) return;
    const record = (await this.sql.query("SELECT id FROM core_navigation_menus WHERE id=$1 AND owner=$2 AND channel=$3 AND timestamp=$4 AND created_at>=now()-interval '30 days'", [id, ownerKey(actor), actor.channel, timestamp])).rows[0];
    return record ? { target: { id, timestamp }, page } : undefined;
  }

  async show(actor: Actor, eventId: string, page: MenuPage, target?: MenuTarget) {
    const id = target?.id ?? uid();
    const { links = [], ...content } = page;
    const message: AgentMessage = { ...content, buttons: [...(content.buttons ?? []),
      ...links.map(link => ({ label: link.label, action: 'core:navigate', value: `${id}|${link.page}` }))] };
    // Record intent before contacting Slack: an uncertain response must not be resent.
    const claimed = await this.sql.query('INSERT INTO core_navigation_deliveries(event_id,owner) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id', [eventId, ownerKey(actor)]);
    if (!claimed.rows.length) return;
    let attempted = false;
    try {
      if (target) {
        if (!this.messenger.update) throw new Error('Message updates unavailable.');
        attempted = true;
        await this.messenger.update(actor, target.timestamp, message);
      } else if (this.messenger.post) {
        await this.sql.query('INSERT INTO core_navigation_menus(id,owner,channel) VALUES($1,$2,$3)', [id, ownerKey(actor), actor.channel]);
        attempted = true;
        const timestamp = await this.messenger.post(actor, message);
        await this.sql.query('UPDATE core_navigation_menus SET timestamp=$2 WHERE id=$1', [id, timestamp]);
      } else {
        // Preserve send-only adapters; production menus use post/update identities.
        attempted = true;
        await this.messenger.send(actor, message);
      }
    } catch (error) {
      if (!attempted || error instanceof SlackDeliveryRejected) {
        await this.sql.query('DELETE FROM core_navigation_deliveries WHERE event_id=$1 AND owner=$2', [eventId, ownerKey(actor)]);
      }
      throw error;
    }
  }
}
