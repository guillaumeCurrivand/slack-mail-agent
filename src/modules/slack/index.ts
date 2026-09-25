import type { Actor } from '../../core/identity.js';
import type { AssistantModule, JobPayload, ModuleContext } from '../../core/modules.js';
import { Navigation, boundMenuTarget, type MenuPage } from '../../core/navigation.js';
import { escapeCardValue, escapeSlack, menuButton, SlackDeliveryRejected, type Button, type Messenger } from '../../core/slack.js';
import type { Sql } from '../../core/store.js';
import { SlackChannelDirectory, type Channel } from './channels.js';
import { SlackAI } from './ai.js';
import type { readSlackConfig } from './config.js';
import { SlackHistory } from './history.js';
import { slackAiSchema, slackHandledSchema, slackResultsSchema, slackSchema, SlackAiAttempts, SlackChannelSelections, SlackUnansweredResults } from './store.js';
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
  const match = /^([^|]{1,200})\|(\d{1,6})$/.exec(value);
  return match ? { sourceId: match[1]!, page: Number(match[2]) } : undefined;
};

export function createSlackModule(token: string, sql: Sql, aiConfig: ReturnType<typeof readSlackConfig>): AssistantModule {
  const directory = new SlackChannelDirectory(token);
  const selections = new SlackChannelSelections(sql);
  const aiAttempts = new SlackAiAttempts(sql);
  const savedResults = new SlackUnansweredResults(sql);
  const history = new SlackHistory(token);
  const unanswered = new SlackUnansweredSearch(directory, selections, history);

  async function sendUnansweredPage(actor: Actor, sourceId: string, requestedPage: number, context: ModuleContext) {
    const pages = await savedResults.load(actor, sourceId);
    if (!pages?.length) return context.messenger.send(actor, { text: 'These results are unavailable. Run slack unanswered again.', buttons: [menuButton] });
    const page = Math.min(requestedPage, pages.length - 1);
    const saved = pages[page]!;
    if (saved.channels.length) {
      try {
        const available = new Set((await directory.listFor(actor.user)).map(channel => channel.id));
        const selected = new Set(await selections.list(actor));
        if (saved.channels.some(id => !available.has(id) || !selected.has(id))) return context.messenger.send(actor, {
          text: 'A channel in these results is no longer selected or accessible. No message content was shown. Run slack unanswered again for current results.', buttons: [menuButton],
        });
      } catch {
        return context.messenger.send(actor, { text: 'Could not verify channel access for these results. Run slack unanswered again.', buttons: [menuButton] });
      }
    }
    const buttons: Button[] = [];
    if (page > 0) buttons.push({ label: 'Previous', action: 'unanswered_page', value: `${sourceId}|${page - 1}` });
    if (page + 1 < pages.length) buttons.push({ label: 'Next', action: 'unanswered_page', value: `${sourceId}|${page + 1}` });
    return context.messenger.send(actor, { kind: 'Unanswered for you', text: saved.text, buttons: [...buttons, menuButton] });
  }

  async function showUnanswered(actor: Actor, eventId: string, context: ModuleContext, anchor: Date) {
    if (await savedResults.load(actor, eventId)) return sendUnansweredPage(actor, eventId, 0, context);
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
    const pageCount = Math.max(1, Math.ceil(entries.length / RESULT_PAGE_SIZE));
    const selectedCount = entries.length ? 0 : (await selections.list(actor)).length;
    const pages: Array<{ text: string; channels: string[] }> = [];
    const authors = new Map<string, string>();
    try {
      for (let page = 0; page < pageCount; page++) {
        const visible = entries.slice(page * RESULT_PAGE_SIZE, (page + 1) * RESULT_PAGE_SIZE);
        const lines = [`Messages from the 48 hours before your command (page ${page + 1}/${pageCount}):`];
        if (!entries.length) lines.push('No confirmed unanswered messages found in your selected channels.');
        if (!entries.length && !selectedCount) lines.push('Choose sources with slack channels.');
        let previousChannel = '';
        let previousGroup = '';
        for (const { channel, message, group, reason } of visible) {
          if (group !== previousGroup) {
            lines.push(group === 'clear' ? '*Unanswered for you*' : '*Possibly for you*');
            previousGroup = group; previousChannel = '';
          }
          if (channel.id !== previousChannel) lines.push(`*#${escapeCardValue(escapeSlack(channel.name))}*`);
          previousChannel = channel.id;
          if (!authors.has(message.user)) {
            const names = await history.profile(message.user).catch(() => []);
            authors.set(message.user, escapeCardValue(escapeSlack(names[0] ?? message.user)));
          }
          const time = new Date(Number(message.ts) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
          const excerpt = escapeCardValue(escapeSlack(message.text.replace(/\s+/g, ' ').slice(0, 220)));
          const link = await history.permalink(channel.id, message.ts);
          lines.push(`• ${authors.get(message.user)} · ${time}: ${excerpt}${message.text.length > 220 ? '…' : ''} [Open message](${link})`);
          if (group === 'possible') lines.push(`  Why it may concern you: ${escapeCardValue(escapeSlack(reason))}`);
        }
        if (results.skipped.length) lines.push(`Skipped inaccessible selected channels: ${results.skipped.join(', ')}. Your selections are saved.`);
        if (incomplete === 'budget') lines.push('Possibly for you could not be fully checked because the shared AI allowance is unavailable. Follow-up resolution could not be fully checked either. Direct mention and name matches are still shown.');
        if (incomplete === 'provider') lines.push('Contextual matching and follow-up resolution could not be completed right now. Direct mention and name matches are still shown.');
        if (incomplete === 'config') lines.push('Contextual matching and follow-up resolution are not configured. Direct mention and name matches are still shown.');
        pages.push({ text: lines.join('\n'), channels: [...new Set(visible.map(item => item.channel.id))] });
      }
    } catch {
      await context.messenger.send(actor, { text: 'Could not load Slack message details right now. Try slack unanswered again.' });
      return;
    }
    await savedResults.save(actor, eventId, pages);
    return sendUnansweredPage(actor, eventId, 0, context);
  }

  async function channelPage(actor: Actor, requestedPage = 0, notice = '', standalone = false): Promise<MenuPage> {
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
    const page = Math.min(requestedPage, pages - 1);
    const visible = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const text = [
      notice,
      `Selected channels: ${saved.size}. Only you can change your selection.`,
      accessUnavailable ? 'Channel access unavailable right now. Available channels cannot be shown. Saved selections can still be removed.'
        : items.length ? `Channels (page ${page + 1}/${pages}):` : 'No shared public or private channels are available. Invite the bot to a channel to make it eligible.',
      accessUnavailable && items.length ? `Saved selections (page ${page + 1}/${pages}):` : '',
      ...visible.map(item => `${item.selected ? '✓' : '○'} ${item.name}`),
      unavailable.length ? 'Unavailable selected channels remain saved until you remove them. Their content is not shown.' : '',
    ].filter(Boolean).join('\n');
    const buttons: Button[] = visible.map(item => ({
      label: `${item.selected ? 'Remove' : 'Add'} ${item.buttonName.slice(0, 60)}`,
      action: item.selected ? 'channel_remove' : 'channel_select', value: selectionValue(item.id, page),
    }));
    if (page > 0) buttons.push({ label: 'Previous', action: 'channel_page', value: String(page - 1) });
    if (page + 1 < pages) buttons.push({ label: 'Next', action: 'channel_page', value: String(page + 1) });
    return { kind: 'Slack channels', text, buttons, bindButtons: true, links };
  }

  async function handleChannels(actor: Actor, payload: JobPayload, eventId: string, context: ModuleContext) {
    const navigation = new Navigation(context.sql, context.messenger);
    if (payload.type === 'text') return navigation.show(actor, eventId, await channelPage(actor, 0, '', true));
    const bound = await navigation.boundTarget(actor, payload.value, payload.timestamp);
    if (!bound) return navigation.show(actor, eventId, { kind: 'Menu unavailable', text: 'This channel list is unavailable. Send slack channels or menu to open a fresh one.' });
    const action = String(payload.action);
    if (action === 'channel_page') {
      const page = /^\d{1,6}$/.test(bound.value) ? Number(bound.value) : 0;
      return navigation.show(actor, eventId, await channelPage(actor, page, '', true), bound.target);
    }
    const selected = parseSelection(bound.value);
    if (!selected) return navigation.show(actor, eventId, await channelPage(actor, 0, 'That channel control is invalid.', true), bound.target);
    if (await selections.handled(actor, eventId)) return navigation.show(actor, eventId, await channelPage(actor, selected.page, 'This action was already processed.', true), bound.target);
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
        return navigation.show(actor, eventId, await channelPage(actor, selected.page, 'Could not verify channel access. No selection was changed.', true), bound.target);
      }
      if (!available.some(channel => channel.id === selected.id)) notice = 'That channel is no longer available to you and the bot. No selection was changed.';
      else if (saved.has(selected.id)) notice = 'That channel is already selected.';
      else notice = await selections.addOnce(actor, eventId, selected.id) ? 'Channel added.' : 'This action was already processed.';
      if (notice !== 'Channel added.') await selections.markHandled(actor, eventId);
    }
    return navigation.show(actor, eventId, await channelPage(actor, selected.page, notice, true), bound.target);
  }

  async function respond(actor: Actor, payload: JobPayload, eventId: string, context: ModuleContext) {
    if (payload.type === 'text') {
      const command = String(payload.text ?? '').trim().toLowerCase();
      if (command === 'unanswered') return showUnanswered(actor, eventId, context, context.requestedAt);
      return context.messenger.send(actor, { text: 'Use slack channels to choose your sources, then slack unanswered to search them.' });
    }
    if (payload.type === 'menu_action' && payload.action === 'find_unanswered') {
      const bound = await boundMenuTarget(context.sql, actor, payload.value, payload.timestamp);
      if (!bound || bound.value !== 'unanswered') return context.messenger.send(actor, { text: 'This work control is unavailable. Send menu to open a fresh one.', buttons: [menuButton] });
      return showUnanswered(actor, eventId, context, context.requestedAt);
    }
    if (payload.type !== 'action') return;
    if (payload.action === 'unanswered_page') {
      const page = parseResultsPage(payload.value);
      if (!page) return context.messenger.send(actor, { text: 'That results control is invalid. Run slack unanswered again.' });
      return sendUnansweredPage(actor, page.sourceId, page.page, context);
    }
    return;
  }

  return {
    id: 'slack', name: 'Slack Unanswered', description: 'Find unanswered messages in selected Slack channels',
    workOperations: [{ key: 'unanswered', label: 'Find unanswered', commands: ['unanswered'], action: 'find_unanswered' }],
    menuActions: ['channel_page', 'channel_select', 'channel_remove', 'find_unanswered'],
    async menu(actor, page) {
      if (page.startsWith('channels_')) return channelPage(actor, /^channels_(\d{1,6})$/.test(page) ? Number(page.slice(9)) : 0);
      return { kind: 'Slack Unanswered', text: 'Choose channels to manage your sources, or find unanswered messages. Shortcuts: slack channels, slack unanswered. Gmail is not required.',
        buttons: [{ label: 'Find unanswered', action: 'find_unanswered', value: 'unanswered', bound: true }], links: [{ label: 'Choose channels', page: 'channels_0' }] };
    },
    async initialize(database) { await database.query(slackSchema); await database.query(slackHandledSchema); await database.query(slackAiSchema); await database.query(slackResultsSchema); },
    async cleanup() { await selections.cleanup(); await aiAttempts.cleanup(); await savedResults.cleanup(); },
    async handle(actor, payload, eventId, context) {
      if ((payload.type === 'text' && String(payload.text ?? '').trim().toLowerCase() === 'channels') ||
        (payload.type === 'menu_action' && ['channel_page', 'channel_select', 'channel_remove'].includes(String(payload.action)))) {
        return handleChannels(actor, payload, eventId, context);
      }
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
