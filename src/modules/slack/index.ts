import type { Actor } from '../../core/identity.js';
import type { AssistantModule, JobPayload, ModuleContext } from '../../core/modules.js';
import { escapeCardValue, escapeSlack, SlackDeliveryRejected, type Button, type Messenger } from '../../core/slack.js';
import type { Sql } from '../../core/store.js';
import { SlackChannelDirectory, type Channel } from './channels.js';
import { slackHandledSchema, slackSchema, SlackChannelSelections } from './store.js';

const PAGE_SIZE = 10;
const selectionValue = (id: string, page: number) => `${id}|${page}`;
const parseSelection = (value: unknown) => {
  if (typeof value !== 'string') return;
  const match = /^([CG][A-Z0-9]+)\|(\d{1,6})$/.exec(value);
  return match ? { id: match[1]!, page: Number(match[2]) } : undefined;
};

export function createSlackModule(token: string, sql: Sql): AssistantModule {
  const directory = new SlackChannelDirectory(token);
  const selections = new SlackChannelSelections(sql);

  async function showChannels(actor: Actor, context: ModuleContext, requestedPage = 0, notice = '') {
    let available: Channel[];
    try { available = await directory.listFor(actor.user); }
    catch {
      await context.messenger.send(actor, { text: `${notice ? `${notice}\n` : ''}Could not list Slack channels right now. Try slack channels again.` });
      return;
    }
    const saved = new Set(await selections.list(actor));
    const availableIds = new Set(available.map(channel => channel.id));
    const unavailable = [...saved].filter(id => !availableIds.has(id)).sort();
    const items = [
      ...available.map(channel => ({ id: channel.id, name: `${channel.private ? 'Private' : 'Public'} #${escapeCardValue(escapeSlack(channel.name))}`, buttonName: `#${channel.name}`, selected: saved.has(channel.id) })),
      ...unavailable.map(id => ({ id, name: `Unavailable selected channel ${id}`, buttonName: id, selected: true })),
    ];
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const page = Math.min(requestedPage, pages - 1);
    const visible = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const text = [
      notice,
      `Selected channels: ${saved.size}. Only you can change your selection.`,
      items.length ? `Available channels (page ${page + 1}/${pages}):` : 'No shared public or private channels are available. Invite the bot to a channel to make it eligible.',
      ...visible.map(item => `${item.selected ? '✓' : '○'} ${item.name}`),
      unavailable.length ? 'Unavailable selections remain saved until you remove them.' : '',
    ].filter(Boolean).join('\n');
    const buttons: Button[] = visible.map(item => ({
      label: `${item.selected ? 'Remove' : 'Select'} ${item.buttonName.slice(0, 60)}`,
      action: item.selected ? 'channel_remove' : 'channel_select', value: selectionValue(item.id, page),
    }));
    if (page > 0) buttons.push({ label: 'Previous', action: 'channel_page', value: String(page - 1) });
    if (page + 1 < pages) buttons.push({ label: 'Next', action: 'channel_page', value: String(page + 1) });
    await context.messenger.send(actor, { kind: 'Slack channels', text, buttons });
  }

  async function respond(actor: Actor, payload: JobPayload, context: ModuleContext) {
    if (payload.type === 'text') {
      const command = String(payload.text ?? '').trim().toLowerCase();
      if (command === 'channels') return showChannels(actor, context);
      return context.messenger.send(actor, { text: command === 'unanswered'
        ? 'slack unanswered is not available yet. Use slack channels to choose your sources.'
        : 'Use slack channels to choose your sources. slack unanswered is not available yet.' });
    }
    if (payload.type !== 'action') return;
    if (payload.action === 'channel_page') {
      const value = String(payload.value ?? '');
      return showChannels(actor, context, /^\d{1,6}$/.test(value) ? Number(value) : 0);
    }
    if (payload.action !== 'channel_select' && payload.action !== 'channel_remove') return;
    const selected = parseSelection(payload.value);
    if (!selected) return showChannels(actor, context, 0, 'That channel control is invalid.');
    if (payload.action === 'channel_remove') {
      await selections.remove(actor, selected.id);
      return showChannels(actor, context, selected.page, 'Channel removed.');
    }
    let available: Channel[];
    try { available = await directory.listFor(actor.user); }
    catch { return context.messenger.send(actor, { text: 'Could not verify channel access right now. No selection was changed.' }); }
    if (!available.some(channel => channel.id === selected.id)) return showChannels(actor, context, selected.page, 'That channel is no longer available to you and the bot.');
    await selections.add(actor, selected.id);
    return showChannels(actor, context, selected.page, 'Channel selected.');
  }

  return {
    id: 'slack', description: 'Choose Slack channels for unanswered messages',
    async initialize(database) { await database.query(slackSchema); await database.query(slackHandledSchema); },
    async cleanup() { await selections.cleanup(); },
    async handle(actor, payload, eventId, context) {
      if (await selections.handled(actor, eventId)) return;
      let responseAttempted = false;
      const messenger: Messenger = { send: async (recipient, message) => {
        // Slack delivery can succeed before a worker observes an error. Once a
        // response is attempted, a retry must not send that card again.
        await selections.markHandled(actor, eventId);
        responseAttempted = true;
        try { await context.messenger.send(recipient, message); }
        catch (error) {
          // An explicit Slack rejection means no card was posted, so retry it.
          if (error instanceof SlackDeliveryRejected) await selections.unmarkHandled(actor, eventId);
          throw error;
        }
      } };
      await respond(actor, payload, { ...context, messenger });
      if (!responseAttempted) await selections.markHandled(actor, eventId);
    },
  };
}
