import { Vault } from '../../core/crypto.js';
import { ownerKey } from '../../core/identity.js';
import type { AssistantModule } from '../../core/modules.js';
import { Navigation, type MenuPage, type MenuTarget } from '../../core/navigation.js';
import { escapeCardValue, menuButton } from '../../core/slack.js';
import { withOwner, type Sql } from '../../core/store.js';
import type { ClickupConfig } from './config.js';
import { ClickupAPI } from './api.js';
import type { Connection } from './domain.js';
import { ClickupOAuth } from './oauth.js';
import { registerClickupRoutes } from './routes.js';
import { clickupSchema, ClickupStore } from './store.js';
import { retrieveTasks, taskPage } from './tasks.js';
import { ClickupStatusStore, statusSchema } from './status-store.js';
import { handleStatusMenu } from './status-menu.js';

export function createClickupModule(config: ClickupConfig, sql: Sql, dependencies: { fetcher?: typeof fetch } = {}): AssistantModule {
  const vault = new Vault(Buffer.from(config.ENCRYPTION_KEY, 'base64'));
  const fetcher = dependencies.fetcher ?? fetch;
  const oauth = new ClickupOAuth(config, sql, vault, fetcher);
  const api = (actor: Parameters<ClickupStore['connection']>[0], connection: Connection, store: ClickupStore) => new ClickupAPI(vault.open<{ token: string }>(connection.tokens, `clickup:${ownerKey(actor)}`).token, fetcher, {
    retryAt: () => store.retryAt(actor, connection.id), blockUntil: until => store.blockUntil(actor, connection.id, until),
  });
  const connectionPage = (connection?: Connection): MenuPage => ({
    kind: 'ClickUp', bindButtons: true,
    text: connection ? `Compte connecté : ${escapeCardValue(connection.identity.name)} (${escapeCardValue(connection.identity.email)}). Workspace : Mayasquad.` : 'Connectez votre compte ClickUp pour consulter vos tâches dans Mayasquad.',
    buttons: connection ? [{ label: 'Mes tâches', action: 'tasks', value: 'tasks', style: 'primary' }, { label: 'Choisir les statuts', action: 'statuses', value: 'statuses' }, { label: 'Changer de compte', action: 'connect', value: 'connect' }, { label: 'Déconnecter ClickUp', action: 'disconnect', value: connection.id }]
      : [{ label: 'Connecter ClickUp', action: 'connect', value: 'connect', style: 'primary' }],
  });
  return {
    id: 'clickup', name: 'ClickUp', description: 'Consulter vos tâches assignées dans Mayasquad',
    menuActions: ['connect', 'disconnect', 'confirm', 'cancel', 'tasks', 'page', 'statuses', 'status_save', 'status_cancel', 'status_reset', 'status_add', 'status_remove', 'status_page', 'status_retry'],
    workOperations: [{ key: 'tasks', label: 'Consulter mes tâches ClickUp', commands: ['tasks'], action: 'tasks' }],
    async initialize(database) { for (const statement of (clickupSchema + statusSchema).split(';').filter(part => part.trim())) await database.query(statement); },
    registerRoutes(app) { registerClickupRoutes(app, config.PUBLIC_URL, oauth); },
    async menu(actor, _page, context) { return connectionPage(await new ClickupStore(context.sql).connection(actor)); },
    async cleanup(pool) {
      const owners = await pool.query('SELECT DISTINCT owner FROM clickup_connections UNION SELECT DISTINCT owner FROM clickup_confirmations UNION SELECT DISTINCT owner FROM clickup_scans UNION SELECT DISTINCT owner FROM clickup_oauth_states UNION SELECT DISTINCT owner FROM clickup_limits UNION SELECT DISTINCT owner FROM clickup_status_editors UNION SELECT DISTINCT owner FROM clickup_status_events');
      for (const row of owners.rows) {
        const [team, user] = String(row.owner).split(':');
        const actor = { team: team!, user: user!, channel: '' };
        await withOwner(pool, actor, async client => { await new ClickupStore(client).cleanup(actor); await new ClickupStatusStore(client, config.CLICKUP_WORKSPACE_ID).cleanup(actor); }, 'clickup');
      }
    },
    async handle(actor, payload, eventId, context) {
      if ((await context.sql.query('SELECT event_id FROM core_navigation_deliveries WHERE event_id=$1 AND owner=$2', [eventId, ownerKey(actor)])).rows.length) return;
      const store = new ClickupStore(context.sql), navigation = new Navigation(context.sql, context.messenger);
      const show = (page: MenuPage) => navigation.show(actor, eventId, { ...page, buttons: [...(page.buttons ?? []), menuButton] });
      let command = payload.type === 'text' ? String(payload.text).trim().toLowerCase() : '';
      let value = '';
      let target: MenuTarget | undefined;
      if (payload.type === 'menu_action') {
        const bound = await navigation.boundTarget(actor, payload.value, payload.timestamp);
        if (!bound) return show({ kind: 'ClickUp indisponible', text: 'Ce bouton est indisponible. Envoyez menu pour continuer.' });
        command = String(payload.action); value = bound.value; target = bound.target;
      } else if (payload.type !== 'text' && payload.type !== 'connection') {
        return show({ kind: 'ClickUp indisponible', text: 'Cette demande est indisponible. Envoyez clickup aide.' });
      }
      if (command === 'connect') {
        const link = await new ClickupOAuth(config, context.sql, vault, fetcher).invitation(actor);
        return show({ kind: 'Connexion ClickUp', text: 'Autorisez Mayasquad dans le navigateur, puis confirmez votre identité dans Slack. Ce lien est à usage unique et expire après 10 minutes.', resourceLinks: [{ label: 'Connecter mon compte ClickUp', url: link }] });
      }
      if (payload.type === 'connection') {
        const proposal = await store.confirmation(actor, String(payload.id));
        if (!proposal || proposal.kind !== 'connect') return show({ kind: 'Connexion indisponible', text: 'Cette confirmation est indisponible ou expirée. Envoyez clickup connecter.' });
        const connection = proposal.data as Connection;
        return show({ kind: 'Confirmation ClickUp', bindButtons: true, text: `Confirmez le compte ${escapeCardValue(connection.identity.name)} (${escapeCardValue(connection.identity.email)}) pour Mayasquad. Cette confirmation expire après 24 heures.`, buttons: [{ label: 'Confirmer ce compte', action: 'confirm', value: proposal.id, style: 'primary' }, { label: 'Annuler', action: 'cancel', value: proposal.id }] });
      }
      if (command === 'cancel') {
        await store.cancel(actor, value);
        return show({ kind: 'ClickUp', text: 'La proposition est annulée ou déjà indisponible.' });
      }
      if (command === 'confirm') {
        const proposal = await store.confirmation(actor, value, true);
        if (!proposal) return show({ kind: 'Confirmation indisponible', text: 'Cette confirmation est indisponible, déjà traitée ou expirée.' });
        if (proposal.status === 'applied') {
          const current = await store.connection(actor);
          return show({ kind: 'ClickUp', text: proposal.kind === 'connect'
            ? current?.id === proposal.resultId ? 'Votre compte ClickUp est connecté à Mayasquad. Cette confirmation a déjà été appliquée.' : 'Cette connexion a déjà été confirmée. La connexion actuelle a changé ; aucune modification n’a été répétée.'
            : current ? 'Cette déconnexion a déjà été confirmée. La connexion actuelle a changé ; aucune modification n’a été répétée.' : 'ClickUp est déconnecté. Cette confirmation a déjà été appliquée.' });
        }
        if (proposal.kind === 'disconnect') {
          const changed = await store.disconnect(actor, value);
          return show({ kind: 'ClickUp', text: changed ? 'ClickUp est déconnecté. Les identifiants, tentatives de connexion et résultats enregistrés ont été supprimés. Vous pouvez aussi révoquer l’autorisation dans ClickUp.' : 'Cette confirmation est devenue indisponible après un changement de connexion.' });
        }
        const connection = proposal.data as Connection;
        try {
          const provider = api(actor, connection, store), identity = await provider.identity();
          if (identity.id !== connection.identity.id) throw new Error('Identity changed');
          await provider.workspace(config.CLICKUP_WORKSPACE_ID);
        } catch { return show({ kind: 'Connexion indisponible', text: 'Le compte ou l’accès à Mayasquad ne peut plus être vérifié. Envoyez clickup connecter.' }); }
        try {
          const changed = await store.activate(actor, value);
          return show({ kind: 'ClickUp', text: changed ? 'Votre compte ClickUp est connecté à Mayasquad.' : 'Cette confirmation est devenue indisponible après un changement de connexion.' });
        } catch (error) {
          if ((error as { code?: string }).code !== '23505') throw error;
          return show({ kind: 'Compte indisponible', text: 'Ce compte ClickUp est déjà connecté par un autre utilisateur Slack.' });
        }
      }
      const connection = await store.connection(actor);
      if (command === 'statuses' || command.startsWith('status_')) {
        if (!connection) return show(connectionPage());
        return handleStatusMenu(actor, command, value, eventId, { api: api(actor, connection, store), store: new ClickupStatusStore(context.sql, config.CLICKUP_WORKSPACE_ID), navigation, connectionId: connection.id, subject: connection.identity.id, workspace: config.CLICKUP_WORKSPACE_ID, target });
      }
      if (command === 'tasks' || command === 'page') {
        if (!connection) return show(connectionPage());
        if (command === 'tasks' && value && value !== 'tasks') return show({ kind: 'ClickUp indisponible', text: 'Ce bouton de lancement est indisponible.' });
        const parsed = command === 'page' ? /^([^|]{1,200})\|(\d{1,6})$/.exec(value) : undefined;
        if (command === 'page' && !parsed) return show({ kind: 'Résultats indisponibles', text: 'Ces résultats sont indisponibles. Envoyez clickup tâches.' });
        const sourceId = parsed?.[1] ?? eventId;
        const provider = api(actor, connection, store);
        const scan = command === 'tasks' ? await retrieveTasks(store, provider, actor, connection, config.CLICKUP_WORKSPACE_ID, sourceId, (await new ClickupStatusStore(context.sql, config.CLICKUP_WORKSPACE_ID).preference(actor)).filter) : await store.scan(actor, sourceId);
        if (!scan || scan.connectionId !== connection.id || Date.now() - Date.parse(scan.retrievedAt) >= 86400_000) return show({ kind: 'Résultats indisponibles', text: 'Ces résultats sont expirés ou liés à une ancienne connexion. Envoyez clickup tâches.' });
        return show(await taskPage(provider, scan, connection, config.CLICKUP_WORKSPACE_ID, sourceId, Number(parsed?.[2] ?? 0)));
      }
      if (command === 'disconnect') {
        if (!connection || (value && value !== connection.id)) return show({ kind: 'Connexion indisponible', text: 'Cette connexion est indisponible. Envoyez menu.' });
        const id = await store.propose(actor, eventId, 'disconnect', { id: connection.id }, connection.id);
        return show({ kind: 'Déconnexion ClickUp', bindButtons: true, text: 'Confirmez la suppression des identifiants, tentatives de connexion et résultats enregistrés de votre compte ClickUp.', buttons: [{ label: 'Confirmer la déconnexion', action: 'confirm', value: id, style: 'danger' }, { label: 'Annuler', action: 'cancel', value: id }] });
      }
      const page = connectionPage(connection);
      return show({ ...page, text: `${page.text}\nCommandes : clickup tâches, clickup statuts, clickup connecter, clickup déconnecter, clickup aide. Aucun appel d’IA ni modification de tâche.` });
    },
  };
}
