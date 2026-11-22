import { z } from 'zod';
import { destinationChannelsPage } from '../../core/destination-channels.js';
import type { AssistantModule } from '../../core/modules.js';
import { Navigation } from '../../core/navigation.js';
import type { SlackChannels } from '../../core/slack-channels.js';
import type { Sql } from '../../core/store.js';
import { transaction } from '../../core/transactions.js';

export async function destinations(sql: Sql, team: string) {
  return (await sql.query('SELECT id,channel_id FROM hyperdx_channels WHERE team=$1 ORDER BY channel_id', [team])).rows as { id: string; channel_id: string }[];
}

export function channelMenu(team: string, directory: SlackChannels, guide: string): Pick<AssistantModule, 'menu' | 'menuActions' | 'handle'> {
  const page = (sql: Sql, user: string, n: number, notice = '', standalone = false) =>
    destinationChannelsPage('hyperdx', 'HyperDX', directory, user, () => destinations(sql, team), n, notice, standalone);
  return {
    menuActions: ['channel_add', 'channel_remove', 'channel_page'],
    async menu(actor, section, { sql }) {
      if (actor.team !== team) throw new Error('Unexpected workspace.');
      if (section === 'channels') return page(sql, actor.user, 0);
      return { kind: 'Bilan HyperDX', text: guide, links: [{ label: 'Choisir les canaux', page: 'channels' }] };
    },
    async handle(actor, payload, eventId, { sql, messenger }) {
      if (actor.team !== team) throw new Error('Unexpected workspace.');
      const navigation = new Navigation(sql, messenger);
      if (payload.type === 'text' && payload.text === 'channels')
        return navigation.show(actor, eventId, await page(sql, actor.user, 0, '', true));
      const bound = payload.type === 'menu_action' && await navigation.boundTarget(actor, payload.value, payload.timestamp);
      if (!bound) return messenger.send(actor, { kind: 'Bilan HyperDX', text: guide });
      if (payload.action === 'channel_page' && /^\d{1,6}$/.test(bound.value))
        return navigation.show(actor, eventId, await page(sql, actor.user, Number(bound.value), '', true), bound.target);
      const parts = bound.value.split('|'), channel = parts[0]!, n = parts.at(-1)!;
      const remove = payload.action === 'channel_remove';
      if (!/^[CG][A-Z0-9]+$/.test(channel) || !/^\d{1,6}$/.test(n) ||
        !(remove ? parts.length === 3 && z.uuid().safeParse(parts[1]).success : payload.action === 'channel_add' && parts.length === 2)) return;
      const allowed = (await directory.list(actor.user)).some(row => row.id === channel) && (remove || await directory.canPost(channel));
      if (allowed) await transaction(sql, async client => {
        const handled = await client.query('INSERT INTO hyperdx_actions(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id', [eventId]);
        if (!handled.rows.length) return;
        if (remove) await client.query('DELETE FROM hyperdx_channels WHERE team=$1 AND channel_id=$2 AND id=$3', [team, channel, parts[1]]);
        else await client.query('INSERT INTO hyperdx_channels(team,channel_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [team, channel]);
      });
      return navigation.show(actor, eventId, await page(sql, actor.user, Number(n),
        allowed ? 'Sélection à jour.' : 'Accès au canal indisponible. Vérifiez que le bot en est membre.', true), bound.target);
    },
  };
}
