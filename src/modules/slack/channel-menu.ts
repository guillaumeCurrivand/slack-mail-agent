import type { Actor } from '../../core/identity.js';
import type { JobPayload, ModuleContext } from '../../core/modules.js';
import { Navigation, type MenuPage } from '../../core/navigation.js';
import { escapeCardValue, escapeSlack, menuButton, type Button } from '../../core/slack.js';
import { SlackChannelDirectory, type Channel } from './channels.js';
import { SlackChannelSelections } from './store.js';

const PAGE_SIZE = 10;
const selectionValue = (id: string, page: number) => `${id}|${page}`;
const parseSelection = (value: unknown) => {
  if (typeof value !== 'string') return;
  const match = /^([CG][A-Z0-9]+)\|(\d{1,6})$/.exec(value);
  return match ? { id: match[1]!, page: Number(match[2]) } : undefined;
};

export function createChannelMenu(directory: SlackChannelDirectory, selections: SlackChannelSelections) {
  async function page(actor: Actor, requestedPage = 0, notice = '', standalone = false): Promise<MenuPage> {
    const links = [{ label: 'Back to Slack Unanswered', page: standalone ? 'slack:main' : 'main' }];
    let available: Channel[] = [];
    let accessUnavailable = false;
    try { available = await directory.listFor(actor.user); }
    catch { accessUnavailable = true; }
    const saved = new Set(await selections.list(actor));
    const availableIds = new Set(available.map(channel => channel.id));
    const unavailable = [...saved].filter(id => !availableIds.has(id)).sort();
    const items = [
      ...available.map(channel => ({ id: channel.id, name: `${channel.private ? 'Private' : 'Public'} #${escapeCardValue(escapeSlack(channel.name))}`, buttonName: `#${channel.name}`, selected: saved.has(channel.id) })),
      ...unavailable.map(id => ({ id, name: `Unavailable selected channel ${id}`, buttonName: id, selected: true })),
    ];
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const current = Math.min(requestedPage, pages - 1);
    const visible = items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
    const text = [
      notice,
      `Selected channels: ${saved.size}. Only you can change your selection.`,
      accessUnavailable ? 'Channel access unavailable right now. Available channels cannot be shown. Saved selections can still be removed.'
        : items.length ? `Channels (page ${current + 1}/${pages}):` : 'No shared public or private channels are available. Invite the bot to a channel to make it eligible.',
      accessUnavailable && items.length ? `Saved selections (page ${current + 1}/${pages}):` : '',
      ...visible.map(item => `${item.selected ? '✓' : '○'} ${item.name}`),
      unavailable.length ? 'Unavailable selected channels remain saved until you remove them. Their content is not shown.' : '',
    ].filter(Boolean).join('\n');
    const buttons: Button[] = visible.map(item => ({
      label: `${item.selected ? 'Remove' : 'Add'} ${item.buttonName.slice(0, 60)}`,
      action: item.selected ? 'channel_remove' : 'channel_select', value: selectionValue(item.id, current),
    }));
    if (current > 0) buttons.push({ label: 'Previous', action: 'channel_page', value: String(current - 1) });
    if (current + 1 < pages) buttons.push({ label: 'Next', action: 'channel_page', value: String(current + 1) });
    return { kind: 'Slack channels', text, buttons, bindButtons: true, links };
  }

  async function handle(actor: Actor, payload: JobPayload, eventId: string, context: ModuleContext) {
    const navigation = new Navigation(context.sql, context.messenger);
    if (payload.type === 'text') return navigation.show(actor, eventId, await page(actor, 0, '', true));
    const bound = await navigation.boundTarget(actor, payload.value, payload.timestamp);
    const action = String(payload.action);
    // Channel Cards posted before DM navigation used unbound values. Their
    // signed clicks still act only on the current User's selections and access.
    const legacy = !bound && (action === 'channel_page' ? /^\d{1,6}$/.test(String(payload.value)) : !!parseSelection(payload.value));
    if (!bound && !legacy) return navigation.show(actor, eventId, { kind: 'Menu unavailable', text: 'This channel list is unavailable. Send slack channels or menu to open a fresh one.', buttons: [menuButton] });
    const value = bound?.value ?? String(payload.value);
    if (action === 'channel_page') {
      const requestedPage = /^\d{1,6}$/.test(value) ? Number(value) : 0;
      return navigation.show(actor, eventId, await page(actor, requestedPage, '', true), bound?.target);
    }
    const selected = parseSelection(value);
    if (!selected) return navigation.show(actor, eventId, await page(actor, 0, 'That channel control is invalid.', true), bound?.target);
    if (await selections.handled(actor, eventId)) return navigation.show(actor, eventId, await page(actor, selected.page, 'This action was already processed.', true), bound?.target);
    const saved = new Set(await selections.list(actor));
    let notice: string;
    if (action === 'channel_remove') {
      if (saved.has(selected.id)) notice = await selections.removeOnce(actor, eventId, selected.id) ? 'Channel removed.' : 'This action was already processed.';
      else { await selections.markHandled(actor, eventId); notice = 'That channel was already removed.'; }
    } else {
      let available: Channel[];
      try { available = await directory.listFor(actor.user); }
      catch {
        await selections.markHandled(actor, eventId);
        return navigation.show(actor, eventId, await page(actor, selected.page, 'Could not verify channel access. No selection was changed.', true), bound?.target);
      }
      if (!available.some(channel => channel.id === selected.id)) notice = 'That channel is no longer available to you and the bot. No selection was changed.';
      else if (saved.has(selected.id)) notice = 'That channel is already selected.';
      else notice = await selections.addOnce(actor, eventId, selected.id) ? 'Channel added.' : 'This action was already processed.';
      if (notice !== 'Channel added.') await selections.markHandled(actor, eventId);
    }
    return navigation.show(actor, eventId, await page(actor, selected.page, notice, true), bound?.target);
  }

  return { page, handle };
}
