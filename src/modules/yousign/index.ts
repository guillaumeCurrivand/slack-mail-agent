import { z } from 'zod';
import type { Actor, IntegrationActor } from '../../core/identity.js';
import type { AssistantModule } from '../../core/modules.js';
import { Navigation, type MenuPage } from '../../core/navigation.js';
import { formatDate } from '../../core/presentation.js';
import { escapeCardValue, menuButton, type Button } from '../../core/slack.js';
import type { Database } from '../../core/transactions.js';
import { YousignChannels } from './channels.js';
import type { YousignConfig } from './config.js';
import { deliverEvent } from './delivery.js';
import { parseEvent, verifyYousign } from './events.js';
import { YousignStore } from './store.js';

const uuid = z.uuid();
const pageNumber = (value: string) => /^\d{1,6}$/.test(value) ? Number(value) : 0;

export function createYousignModule(config: YousignConfig, database: Database, dependencies: { fetcher?: typeof fetch } = {}): AssistantModule {
  const identity: IntegrationActor = { kind: 'integration', team: config.SLACK_TEAM_ID, integration: config.YOUSIGN_SUBSCRIPTION_ID };
  const directory = new YousignChannels(config.SLACK_BOT_TOKEN, dependencies.fetcher);
  const store = (sql: Database = database) => new YousignStore(sql, identity);
  const back = (standalone: boolean) => [{ label: 'Retour à Yousign', page: standalone ? 'yousign:main' : 'main' }];
  const main: MenuPage = { kind: 'Yousign', text: 'Notifications de tous les événements du webhook Yousign de l’entreprise. Les canaux sélectionnés sont partagés entre tous les utilisateurs. Aucun appel d’IA.', links: [{ label: 'Choisir les canaux', page: 'channels_0' }, { label: 'Statut', page: 'status_0' }] };

  async function channelsPage(actor: Actor, sql: Database, requested = 0, notice = '', standalone = false): Promise<MenuPage> {
    let available;
    try { available = await directory.list(actor.user); }
    catch { return { kind: 'Canaux Yousign', text: 'L’accès aux canaux ne peut pas être vérifié. Aucun canal n’est affiché ni modifié. Réouvrez la liste plus tard.', links: back(standalone) }; }
    const selected = new Map((await store(sql).destinations()).map(row => [row.channel_id, row.id]));
    const pages = Math.max(1, Math.ceil(available.length / 10)), current = Math.min(requested, pages - 1);
    const visible = available.slice(current * 10, (current + 1) * 10);
    const buttons: Button[] = visible.map(channel => selected.has(channel.id)
      ? { label: `Retirer #${channel.name.slice(0, 55)}`, action: 'channel_remove', value: `${channel.id}|${selected.get(channel.id)}|${current}`, style: 'danger' }
      : { label: `Activer #${channel.name.slice(0, 55)}`, action: 'channel_add', value: `${channel.id}|${current}` });
    if (current) buttons.push({ label: 'Précédent', action: 'channel_page', value: String(current - 1) });
    if (current + 1 < pages) buttons.push({ label: 'Suivant', action: 'channel_page', value: String(current + 1) });
    return { kind: 'Canaux Yousign', bindButtons: true, links: back(standalone), buttons, text: [notice,
      'Liste partagée : Activer autorise immédiatement les futurs messages Yousign dans ce canal. Retirer annule les messages en attente. Les canaux auxquels vous n’avez pas accès sont masqués.',
      `Canaux (page ${current + 1}/${pages}) :`, ...visible.map(channel => `${selected.has(channel.id) ? '✓' : '○'} ${channel.private ? 'Privé' : 'Public'} #${escapeCardValue(channel.name)}`),
      !available.length ? 'Aucun canal partagé avec le bot. Invitez-le dans les canaux à sélectionner.' : '',
    ].filter(Boolean).join('\n') };
  }

  async function statusPage(actor: Actor, sql: Database, requested = 0, notice = '', standalone = false): Promise<MenuPage> {
    let available;
    try { available = await directory.list(actor.user); }
    catch { return { kind: 'Statut Yousign', text: 'L’accès aux canaux ne peut pas être vérifié. Aucun détail de notification n’est affiché.', links: back(standalone) }; }
    const names = new Map(available.map(channel => [channel.id, channel.name]));
    const rows = await store(sql).history([...names.keys()], requested * 8), visible = rows.slice(0, 8);
    const received = await store(sql).lastReceipt();
    const labels: Record<string, string> = { queued: 'En attente', sending: 'Envoi commencé', sent: 'Envoyée', uncertain: 'Livraison incertaine', failed: 'Échec', cancelled: 'Annulée' };
    const causes: Record<string, string> = { access_unavailable: 'Publication indisponible dans ce canal.', rejected: 'Slack a refusé cet envoi.', invalid_message: 'Slack a refusé cette notification.', interrupted: 'Envoi interrompu ; Slack peut avoir publié le message.', uncertain: 'Slack peut avoir publié le message.' };
    const buttons: Button[] = visible.filter(row => ['uncertain', 'failed'].includes(row.status)).map(row => ({
      label: `${row.status === 'uncertain' ? 'Examiner' : 'Réessayer'} #${names.get(row.channel_id)!.slice(0, 45)}`,
      action: row.status === 'uncertain' ? 'review' : 'retry', value: row.status === 'uncertain' ? row.id : `${row.id}|${row.attempts}` }));
    if (requested) buttons.push({ label: 'Précédent', action: 'status_page', value: String(requested - 1) });
    if (rows.length > 8) buttons.push({ label: 'Suivant', action: 'status_page', value: String(requested + 1) });
    buttons.push({ label: 'Actualiser', action: 'status_page', value: String(requested) });
    return { kind: 'Statut Yousign', bindButtons: true, links: back(standalone), buttons, text: [notice,
      received ? `Dernière réception authentifiée : ${formatDate(received)}` : 'Aucun événement reçu. Vérifiez la destination du webhook existant si nécessaire.',
      'Historique de 30 jours, limité aux canaux accessibles. Les envois connus comme non livrés sont repris automatiquement ; les livraisons incertaines nécessitent un examen. Les alertes opérationnelles sont privées.',
      `Page ${requested + 1}`, ...visible.map(row => [`${labels[row.status] ?? 'Indisponible'} — #${escapeCardValue(names.get(row.channel_id)!)}`, escapeCardValue(row.summary.request ?? row.summary.resource ?? row.summary.name),
        `Événement : ${escapeCardValue(row.summary.name)} — ${formatDate(row.summary.time)}`, `Reçu : ${formatDate(row.created_at)}`, row.cause ? causes[row.cause] : '',
        row.status === 'queued' && row.cause ? `Prochain essai : ${formatDate(row.next_at)}` : ''].filter(Boolean).join('\n')),
      !visible.length ? 'Aucune notification visible. Sans canal sélectionné, les événements sont ignorés.' : '',
    ].filter(Boolean).join('\n\n') };
  }

  return {
    id: 'yousign', name: 'Yousign', description: 'Recevoir les notifications Yousign dans des canaux partagés',
    menuActions: ['channel_add', 'channel_remove', 'channel_page', 'status_page', 'review', 'retry', 'confirm', 'cancel'],
    async initialize(sql) { await store(sql).initialize(); },
    registerRoutes(app) {
      app.post('/webhooks/yousign', async (request, reply) => {
        const raw = typeof request.body === 'string' ? request.body : '';
        if (!verifyYousign(raw, request.headers['x-yousign-signature-256'], config.YOUSIGN_WEBHOOK_SECRET)) return reply.code(401).send();
        let event;
        try { event = parseEvent(raw, config.YOUSIGN_SUBSCRIPTION_ID, config.YOUSIGN_SANDBOX); }
        catch { return reply.code(400).send({ error: 'Événement Yousign invalide.' }); }
        try { await store().accept(event); }
        catch { return reply.code(503).send({ error: 'La réception durable est temporairement indisponible.' }); }
        return { ok: true };
      });
    },
    async cleanup(pool) { await store(pool).cleanup(); },
    async menu(actor, page, context) {
      if (actor.team !== identity.team) throw new Error('Unexpected workspace.');
      if (/^channels_\d{1,6}$/.test(page)) return channelsPage(actor, context.sql, pageNumber(page.slice(9)));
      if (/^status_\d{1,6}$/.test(page)) return statusPage(actor, context.sql, pageNumber(page.slice(7)));
      return main;
    },
    async handleIntegration(actor, payload, _id, context) {
      if (actor.team !== identity.team || actor.integration !== identity.integration || payload.type !== 'event' || !uuid.safeParse(payload.event).success)
        throw new Error('Unexpected integration job.');
      return deliverEvent(store(context.sql), directory, context.messenger, config, String(payload.event));
    },
    async handle(actor, payload, eventId, context) {
      if (actor.team !== identity.team) throw new Error('Unexpected workspace.');
      const saved = store(context.sql), navigation = new Navigation(context.sql, context.messenger);
      const show = (page: MenuPage, target?: Parameters<Navigation['show']>[3]) => navigation.show(actor, eventId, page, target);
      if (payload.type === 'text') {
        const command = String(payload.text ?? '').toLowerCase();
        if (command === 'channels') return show(await channelsPage(actor, context.sql, 0, '', true));
        if (command === 'status') return show(await statusPage(actor, context.sql, 0, '', true));
        return show({ ...main, links: main.links!.map(link => ({ ...link, page: `yousign:${link.page}` })),
          text: `${main.text}\nCommandes : yousign canaux, yousign statut, yousign aide. Les sélections n’affectent pas Slack Unanswered.`, buttons: [menuButton] });
      }
      const bound = payload.type === 'menu_action' ? await navigation.boundTarget(actor, payload.value, payload.timestamp) : undefined;
      if (!bound) return show({ kind: 'Yousign indisponible', text: 'Ce bouton est indisponible. Envoyez menu pour continuer.', buttons: [menuButton] });
      const action = String(payload.action), value = bound.value;
      if (action === 'channel_page') return show(await channelsPage(actor, context.sql, pageNumber(value), '', true), bound.target);
      if (action === 'status_page') return show(await statusPage(actor, context.sql, pageNumber(value), '', true), bound.target);
      if (['channel_add', 'channel_remove'].includes(action)) {
        const parts = value.split('|'), channel = parts[0]!, activation = action === 'channel_remove' ? parts[1] : undefined;
        const page = pageNumber(parts[action === 'channel_remove' ? 2 : 1] ?? '0');
        if (!/^[CG][A-Z0-9]+$/.test(channel) || (activation !== undefined && !uuid.safeParse(activation).success))
          return show(await channelsPage(actor, context.sql, page, 'Ce bouton est invalide.', true), bound.target);
        let access = false;
        try { access = (await directory.list(actor.user)).some(item => item.id === channel); } catch { /* Fail closed. */ }
        if (!access) return show(await channelsPage(actor, context.sql, page, 'L’accès au canal ne peut plus être vérifié. Aucune modification.', true), bound.target);
        const changed = await saved.change(actor, eventId, channel, activation);
        return show(await channelsPage(actor, context.sql, page, changed ? 'Sélection partagée mise à jour.' : 'Aucun changement : action déjà traitée ou sélection périmée.', true), bound.target);
      }
      if (action === 'review' && uuid.safeParse(value).success) {
        const visible = await directory.list(actor.user);
        const target = await saved.delivery(value);
        if (!target || !visible.some(item => item.id === target.channel_id)) return show(await statusPage(actor, context.sql, 0, 'Cette notification est inaccessible.', true), bound.target);
        const id = await saved.propose(actor, eventId, value);
        if (!id) return show(await statusPage(actor, context.sql, 0, 'Cette livraison n’est plus incertaine.', true), bound.target);
        return show({ kind: 'Confirmer une relance Yousign', bindButtons: true, text: `Canal : #${escapeCardValue(visible.find(channel => channel.id === target.channel_id)!.name)}\n${escapeCardValue(target.summary.request ?? target.summary.resource ?? target.summary.name)}\nÉvénement : ${escapeCardValue(target.summary.name)} — ${formatDate(target.summary.time)}\nSlack a peut-être déjà publié cette notification. Vérifiez le canal avant de relancer : une nouvelle publication peut créer un doublon. Cette confirmation expire après 24 heures.`,
          buttons: [{ label: 'Confirmer cette relance', action: 'confirm', value: id, style: 'danger' }, { label: 'Annuler', action: 'cancel', value: id }], links: back(true) });
      }
      if (action === 'retry') {
        const [id, attempt] = value.split('|');
        if (uuid.safeParse(id).success && /^\d{1,9}$/.test(attempt ?? '')) {
          const target = await saved.delivery(id!);
          let visible = false;
          try { visible = !!target && (await directory.list(actor.user)).some(channel => channel.id === target.channel_id); } catch { /* Fail closed. */ }
          const changed = visible && await saved.retryKnown(actor, eventId, id!, Number(attempt));
          return show(await statusPage(actor, context.sql, 0, changed ? 'Nouvel essai enregistré.' : 'Aucun nouvel essai enregistré.', true), bound.target);
        }
      }
      if (['confirm', 'cancel'].includes(action) && uuid.safeParse(value).success) {
        const proposal = await saved.confirmation(actor, value);
        if (!proposal) return show(await statusPage(actor, context.sql, 0, 'Confirmation indisponible ou expirée.', true), bound.target);
        let visible = false;
        try { visible = (await directory.list(actor.user)).some(channel => channel.id === proposal.channel_id); } catch { /* Fail closed. */ }
        if (!visible) return show(await statusPage(actor, context.sql, 0, 'Cette notification est inaccessible.', true), bound.target);
        if (action === 'cancel') await context.sql.query("UPDATE yousign_confirmations SET status='cancelled' WHERE id=$1 AND owner=$2 AND channel=$3 AND status='pending'", [value, `${actor.team}:${actor.user}`, actor.channel]);
        const changed = action === 'confirm' && await saved.confirm(actor, value);
        return show(await statusPage(actor, context.sql, 0, changed ? 'Relance enregistrée.' : 'Aucune nouvelle relance enregistrée.', true), bound.target);
      }
      return show(await statusPage(actor, context.sql, 0, 'Ce bouton est indisponible.', true), bound.target);
    },
  };
}
