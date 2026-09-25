import type { Actor } from '../../core/identity.js';
import type { AssistantModule, JobPayload, ModuleContext } from '../../core/modules.js';
import { escapeCardValue, escapeSlack, SlackDeliveryRejected, type Button, type Messenger } from '../../core/slack.js';
import type { Sql } from '../../core/store.js';
import { SlackChannelDirectory, type Channel } from './channels.js';
import { SlackAI } from './ai.js';
import type { readSlackConfig } from './config.js';
import { SlackHistory } from './history.js';
import { slackAiSchema, slackHandledSchema, slackSchema, SlackAiAttempts, SlackChannelSelections } from './store.js';
import { SlackUnansweredSearch, type UnansweredMatch } from './unanswered.js';

const PAGE_SIZE = 10;
const RESULT_PAGE_SIZE = 8;
const selectionValue = (id: string, page: number) => `${id}|${page}`;
const parseSelection = (value: unknown) => {
  if (typeof value !== 'string') return;
  const match = /^([CG][A-Z0-9]+)\|(\d{1,6})$/.exec(value);
  return match ? { id: match[1]!, page: Number(match[2]) } : undefined;
};
const parseResultsPage = (value: unknown) => {
  if (typeof value !== 'string') return;
  const match = /^(\d{13})\|(\d{1,6})$/.exec(value);
  const anchorMs = Number(match?.[1]), page = Number(match?.[2]);
  return Number.isSafeInteger(anchorMs) && anchorMs > 0 && anchorMs <= Date.now() && Number.isSafeInteger(page)
    ? { anchor: new Date(anchorMs), page } : undefined;
};

export function createSlackModule(token: string, sql: Sql, aiConfig: ReturnType<typeof readSlackConfig>): AssistantModule {
  const directory = new SlackChannelDirectory(token);
  const selections = new SlackChannelSelections(sql);
  const aiAttempts = new SlackAiAttempts(sql);
  const history = new SlackHistory(token);
  const unanswered = new SlackUnansweredSearch(directory, selections, history);

  async function showUnanswered(actor: Actor, eventId: string, context: ModuleContext, anchor: Date, requestedPage = 0) {
    let results;
    try { results = await unanswered.search(actor, anchor); }
    catch {
      await context.messenger.send(actor, { text: 'Could not search Slack channels right now. Try slack unanswered again.' });
      return;
    }
    const clear: UnansweredMatch[] = [...results.matches];
    const possible: Array<UnansweredMatch & { reason: string }> = [];
    const assessed = new Set<string>();
    let incomplete: 'budget' | 'provider' | 'config' | undefined;
    if (results.candidates.length) {
      if (!aiConfig.key) incomplete = 'config';
      else {
        const classification = await new SlackAI(aiConfig.key, aiConfig.model, context.budget, aiAttempts)
          .classify(actor, eventId, results.names, results.candidates);
        incomplete = classification.incomplete;
        for (const candidate of classification.assessed) assessed.add(`${candidate.channel.id}:${candidate.message.ts}`);
        for (const { candidate, decision, reason } of classification.decisions) {
          if (decision === 'clear') clear.push(candidate);
          else possible.push({ ...candidate, reason });
        }
      }
    }
    // Keep clear direct matches when contextual checking could not assess them.
    for (const candidate of results.candidates) {
      if (candidate.followup && candidate.direct && !assessed.has(`${candidate.channel.id}:${candidate.message.ts}`)) clear.push(candidate);
    }
    const sort = (a: UnansweredMatch, b: UnansweredMatch) => a.channel.name.localeCompare(b.channel.name) || Number(b.message.ts) - Number(a.message.ts);
    clear.sort(sort); possible.sort(sort);
    const entries = [
      ...clear.map(item => ({ ...item, group: 'clear' as const, reason: '' })),
      ...possible.map(item => ({ ...item, group: 'possible' as const })),
    ];
    const pages = Math.max(1, Math.ceil(entries.length / RESULT_PAGE_SIZE));
    const page = Math.min(requestedPage, pages - 1);
    const visible = entries.slice(page * RESULT_PAGE_SIZE, (page + 1) * RESULT_PAGE_SIZE);
    const lines = [`Messages from the 48 hours before your command (page ${page + 1}/${pages}):`];
    if (!entries.length) lines.push('No confirmed unanswered messages found in your selected channels.');
    if (!entries.length && !(await selections.list(actor)).length) lines.push('Choose sources with slack channels.');
    let previousChannel = '';
    let previousGroup = '';
    try {
      for (const { channel, message, group, reason } of visible) {
        if (group !== previousGroup) {
          lines.push(group === 'clear' ? '*Unanswered for you*' : '*Possibly for you*');
          previousGroup = group; previousChannel = '';
        }
        if (channel.id !== previousChannel) lines.push(`*#${escapeCardValue(escapeSlack(channel.name))}*`);
        previousChannel = channel.id;
        const names = await history.profile(message.user).catch(() => []);
        const author = escapeCardValue(escapeSlack(names[0] ?? message.user));
        const time = new Date(Number(message.ts) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
        const excerpt = escapeCardValue(escapeSlack(message.text.replace(/\s+/g, ' ').slice(0, 220)));
        const link = await history.permalink(channel.id, message.ts);
        lines.push(`• ${author} · ${time}: ${excerpt}${message.text.length > 220 ? '…' : ''} [Open message](${link})`);
        if (group === 'possible') lines.push(`  Why it may concern you: ${escapeCardValue(escapeSlack(reason))}`);
      }
    } catch {
      await context.messenger.send(actor, { text: 'Could not load Slack message details right now. Try slack unanswered again.' });
      return;
    }
    if (results.skipped.length) lines.push(`Skipped inaccessible selected channels: ${results.skipped.join(', ')}. Your selections are saved.`);
    if (incomplete === 'budget') lines.push('Possibly for you could not be fully checked because the shared AI allowance is unavailable. Follow-up resolution could not be fully checked either. Direct mention and name matches are still shown.');
    if (incomplete === 'provider') lines.push('Contextual matching and follow-up resolution could not be completed right now. Direct mention and name matches are still shown.');
    if (incomplete === 'config') lines.push('Contextual matching and follow-up resolution are not configured. Direct mention and name matches are still shown.');
    const buttons: Button[] = [];
    const anchorValue = String(anchor.getTime());
    if (page > 0) buttons.push({ label: 'Previous', action: 'unanswered_page', value: `${anchorValue}|${page - 1}` });
    if (page + 1 < pages) buttons.push({ label: 'Next', action: 'unanswered_page', value: `${anchorValue}|${page + 1}` });
    await context.messenger.send(actor, { kind: 'Unanswered for you', text: lines.join('\n'), buttons });
  }

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

  async function respond(actor: Actor, payload: JobPayload, eventId: string, context: ModuleContext) {
    if (payload.type === 'text') {
      const command = String(payload.text ?? '').trim().toLowerCase();
      if (command === 'channels') return showChannels(actor, context);
      if (command === 'unanswered') return showUnanswered(actor, eventId, context, context.requestedAt);
      return context.messenger.send(actor, { text: 'Use slack channels to choose your sources, then slack unanswered to search them.' });
    }
    if (payload.type !== 'action') return;
    if (payload.action === 'unanswered_page') {
      const page = parseResultsPage(payload.value);
      if (!page) return context.messenger.send(actor, { text: 'That results control is invalid. Run slack unanswered again.' });
      return showUnanswered(actor, eventId, context, page.anchor, page.page);
    }
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
    id: 'slack', description: 'Find unanswered messages in selected Slack channels',
    async initialize(database) { await database.query(slackSchema); await database.query(slackHandledSchema); await database.query(slackAiSchema); },
    async cleanup() { await selections.cleanup(); await aiAttempts.cleanup(); },
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
      await respond(actor, payload, eventId, { ...context, messenger });
      if (!responseAttempted) await selections.markHandled(actor, eventId);
    },
  };
}
