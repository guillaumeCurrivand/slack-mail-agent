import { formatDate, retainedTextNotice } from '../../core/presentation.js';
import type { Actor } from '../../core/identity.js';
import type { AssistantModule, JobPayload, ModuleContext } from '../../core/modules.js';
import { boundMenuTarget } from '../../core/navigation.js';
import { escapeCardValue, escapeSlack, menuButton, SlackDeliveryRejected, type Button, type Messenger } from '../../core/slack.js';
import type { Sql } from '../../core/store.js';
import { SlackChannelDirectory } from './channels.js';
import { createChannelMenu } from './channel-menu.js';
import { SlackAI } from './ai.js';
import type { readSlackConfig } from './config.js';
import { SlackHistory } from './history.js';
import { slackAiSchema, slackHandledSchema, slackResultsSchema, slackSchema, SlackAiAttempts, SlackChannelSelections, SlackUnansweredResults } from './store.js';
import { SlackUnansweredSearch, type UnansweredMatch } from './unanswered.js';
import { slackHelp } from './help.js';

const RESULT_PAGE_SIZE = 8;
const parseResultsPage = (value: unknown) => {
  if (typeof value !== 'string') return;
  const match = /^([^|]{1,200})\|(\d{1,6})$/.exec(value);
  return match ? { sourceId: match[1]!, page: Number(match[2]) } : undefined;
};

export function createSlackModule(token: string, sql: Sql, aiConfig: ReturnType<typeof readSlackConfig>): AssistantModule {
  const directory = new SlackChannelDirectory(token);
  const selections = new SlackChannelSelections(sql);
  const channelMenu = createChannelMenu(directory, selections);
  const aiAttempts = new SlackAiAttempts(sql);
  const savedResults = new SlackUnansweredResults(sql);
  const history = new SlackHistory(token);
  const unanswered = new SlackUnansweredSearch(directory, selections, history);

  async function sendUnansweredPage(actor: Actor, sourceId: string, requestedPage: number, context: ModuleContext) {
    const pages = await savedResults.load(actor, sourceId);
    if (!pages?.length) return context.messenger.send(actor, { text: "Ces résultats sont indisponibles. Relancez slack sans-réponse.", buttons: [menuButton] });
    const page = Math.min(requestedPage, pages.length - 1);
    const saved = pages[page]!;
    if (!Array.isArray(saved.selected) || !Array.isArray(saved.channels)) return context.messenger.send(actor, {
      text: "Ces résultats sont indisponibles. Relancez slack sans-réponse.", buttons: [menuButton],
    });
    try {
      const selected = await selections.list(actor);
      const sameSelection = selected.length === saved.selected.length && selected.every((id, index) => id === saved.selected[index]);
      if (!sameSelection) return context.messenger.send(actor, {
        text: "Un canal de ces résultats n’est plus sélectionné ou accessible. Aucun contenu de message n’a été affiché. Relancez slack sans-réponse pour des résultats actuels.", buttons: [menuButton],
      });
      if (selected.length) {
        const available = new Set((await directory.listFor(actor.user)).map(channel => channel.id));
        const availableSources = selected.filter(id => available.has(id));
        const sameAccess = availableSources.length === saved.channels.length && availableSources.every((id, index) => id === saved.channels[index]);
        if (!sameAccess) return context.messenger.send(actor, {
          text: "Un canal de ces résultats n’est plus sélectionné ou accessible. Aucun contenu de message n’a été affiché. Relancez slack sans-réponse pour des résultats actuels.", buttons: [menuButton],
        });
      }
    } catch {
      return context.messenger.send(actor, { text: "L’accès aux canaux de ces résultats n’a pas pu être vérifié. Relancez slack sans-réponse.", buttons: [menuButton] });
    }
    const buttons: Button[] = [];
    if (page > 0) buttons.push({ label: "Précédent", action: 'unanswered_page', value: `${sourceId}|${page - 1}` });
    if (page + 1 < pages.length) buttons.push({ label: "Suivant", action: 'unanswered_page', value: `${sourceId}|${page + 1}` });
    return context.messenger.send(actor, { kind: "Messages sans réponse", text: `${saved.language === 'fr' ? '' : `${retainedTextNotice}\n\n`}${saved.text}`, buttons: [...buttons, menuButton] });
  }

  async function showUnanswered(actor: Actor, eventId: string, context: ModuleContext, anchor: Date, requestedPage = 0, replayOnly = false) {
    if (await savedResults.load(actor, eventId)) return sendUnansweredPage(actor, eventId, requestedPage, context);
    let results;
    try { results = await unanswered.search(actor, anchor); }
    catch {
      await context.messenger.send(actor, { text: "Impossible de rechercher dans les canaux Slack pour le moment. Réessayez slack sans-réponse.", buttons: [menuButton] });
      return;
    }
    const clear: UnansweredMatch[] = [...results.matches];
    const possible: Array<UnansweredMatch & { reason: string }> = [];
    const assessed = new Set<string>();
    let incomplete: 'budget' | 'provider' | 'config' | 'saved' | undefined;
    if (results.candidates.length) {
      if (!aiConfig.key && !replayOnly) incomplete = 'config';
      else {
        const classification = await new SlackAI(aiConfig.key ?? '', aiConfig.model, context.budget, aiAttempts)
          .classify(actor, eventId, results.names, results.candidates, replayOnly);
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
    const selectedCount = entries.length ? 0 : results.selected.length;
    const availableSources = results.available;
    const pages: Array<{ text: string; channels: string[]; selected: string[]; language: 'fr' }> = [];
    const authors = new Map<string, string>();
    try {
      for (let page = 0; page < pageCount; page++) {
        const visible = entries.slice(page * RESULT_PAGE_SIZE, (page + 1) * RESULT_PAGE_SIZE);
        const lines = [`Messages des 48 heures précédant votre commande (page ${page + 1}/${pageCount}):`];
        if (!entries.length) lines.push("Aucun message confirmé sans réponse dans les canaux sélectionnés.");
        if (!entries.length && !selectedCount) lines.push("Choisissez les sources avec slack canaux.");
        let previousChannel = '';
        let previousGroup = '';
        for (const { channel, message, group, reason } of visible) {
          if (group !== previousGroup) {
            lines.push(group === 'clear' ? "*Messages sans réponse*" : "*Vous concerne peut-être*");
            previousGroup = group; previousChannel = '';
          }
          if (channel.id !== previousChannel) lines.push(`*#${escapeCardValue(escapeSlack(channel.name))}*`);
          previousChannel = channel.id;
          if (!authors.has(message.user)) {
            const names = await history.profile(message.user).catch(() => []);
            authors.set(message.user, escapeCardValue(escapeSlack(names[0] ?? message.user)));
          }
          const time = formatDate(Number(message.ts) * 1000);
          const excerpt = escapeCardValue(escapeSlack(message.text.replace(/\s+/g, ' ').slice(0, 220)));
          const link = await history.permalink(channel.id, message.ts);
          lines.push(`• ${authors.get(message.user)} · ${time}: ${excerpt}${message.text.length > 220 ? '…' : ''} [Ouvrir le message](${link})`);
          if (group === 'possible') lines.push(`  Pourquoi ce message pourrait vous concerner : ${escapeCardValue(escapeSlack(reason))}`);
        }
        if (results.skipped.length) lines.push(`Canaux sélectionnés inaccessibles ignorés : ${results.skipped.join(', ')}. Vos sélections sont conservées.`);
        if (incomplete === 'budget') lines.push("Les messages qui pourraient vous concerner et les demandes de suivi n’ont pas pu être entièrement vérifiés car le budget d’IA partagé est indisponible. Les mentions directes et les correspondances de noms restent affichées.");
        if (incomplete === 'provider') lines.push("L’analyse du contexte et des demandes de suivi n’a pas pu aboutir. Les mentions directes et les correspondances de noms restent affichées.");
        if (incomplete === 'config') lines.push("L’analyse du contexte et des demandes de suivi n’est pas configurée. Les mentions directes et les correspondances de noms restent affichées.");
        if (incomplete === 'saved') lines.push("Les anciens résultats contextuels ne peuvent pas être restaurés sans nouveau traitement d’IA. Les mentions directes et les correspondances de noms restent affichées. Relancez slack sans-réponse pour une nouvelle recherche.");
        pages.push({ text: lines.join('\n'), channels: availableSources, selected: results.selected, language: 'fr' });
      }
    } catch {
      await context.messenger.send(actor, { text: "Impossible de charger les détails des messages Slack pour le moment. Réessayez slack sans-réponse.", buttons: [menuButton] });
      return;
    }
    await savedResults.save(actor, eventId, pages);
    return sendUnansweredPage(actor, eventId, requestedPage, context);
  }

  async function respond(actor: Actor, payload: JobPayload, eventId: string, context: ModuleContext) {
    if (payload.type === 'text') {
      const command = String(payload.text ?? '').trim().toLowerCase();
      if (command === 'unanswered') return showUnanswered(actor, eventId, context, context.requestedAt);
      return context.messenger.send(actor, { text: "Utilisez slack canaux pour choisir les sources, puis slack sans-réponse pour rechercher.", buttons: [menuButton] });
    }
    if (payload.type === 'menu_action' && payload.action === 'find_unanswered') {
      const bound = await boundMenuTarget(context.sql, actor, payload.value, payload.timestamp);
      if (!bound || bound.value !== 'unanswered') return context.messenger.send(actor, { text: "Ce bouton de lancement est indisponible. Envoyez menu pour en ouvrir un nouveau.", buttons: [menuButton] });
      return showUnanswered(actor, eventId, context, context.requestedAt);
    }
    if (payload.type !== 'action') return;
    if (payload.action === 'unanswered_page') {
      const page = parseResultsPage(payload.value);
      if (!page) return context.messenger.send(actor, { text: "Ce bouton de résultats est invalide. Relancez slack sans-réponse.", buttons: [menuButton] });
      if (/^\d{13}$/.test(page.sourceId)) {
        const anchor = Number(page.sourceId);
        const sourceId = await savedResults.legacySource(actor, anchor);
        if (!sourceId) return context.messenger.send(actor, { text: "Ces résultats sont indisponibles. Relancez slack sans-réponse.", buttons: [menuButton] });
        return showUnanswered(actor, sourceId, context, new Date(anchor), page.page, true);
      }
      return sendUnansweredPage(actor, page.sourceId, page.page, context);
    }
    return;
  }

  return {
    id: 'slack', name: "Messages Slack sans réponse", description: "Trouver les messages sans réponse dans les canaux Slack sélectionnés",
    help: slackHelp,
    workOperations: [{ key: 'unanswered', label: "Chercher les messages sans réponse", commands: ['unanswered'], action: 'find_unanswered' }],
    menuActions: ['channel_page', 'channel_select', 'channel_remove', 'find_unanswered'],
    async menu(actor, page) {
      if (page.startsWith('channels_')) return channelMenu.page(actor, /^channels_(\d{1,6})$/.test(page) ? Number(page.slice(9)) : 0);
      return { kind: "Messages Slack sans réponse", text: "Choisissez les canaux pour gérer vos sources ou cherchez les messages sans réponse. Raccourcis : slack canaux, slack sans-réponse. Gmail n’est pas nécessaire.",
        buttons: [{ label: "Chercher les messages sans réponse", action: 'find_unanswered', value: 'unanswered', bound: true, style: 'primary' }], links: [{ label: "Choisir les canaux", page: 'channels_0' }] };
    },
    async initialize(database) { await database.query(slackSchema); await database.query(slackHandledSchema); await database.query(slackAiSchema); await database.query(slackResultsSchema); },
    async cleanup() { await selections.cleanup(); await aiAttempts.cleanup(); await savedResults.cleanup(); },
    async handle(actor, payload, eventId, context) {
      if ((payload.type === 'text' && String(payload.text ?? '').trim().toLowerCase() === 'channels') ||
        (payload.type === 'menu_action' && ['channel_page', 'channel_select', 'channel_remove'].includes(String(payload.action)))) {
        return channelMenu.handle(actor, payload, eventId, context);
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
