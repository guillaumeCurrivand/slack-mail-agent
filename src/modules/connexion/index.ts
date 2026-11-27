import type { Actor } from '../../core/identity.js';
import type { AssistantModule } from '../../core/modules.js';
import { boundMenuTarget, type MenuPage } from '../../core/navigation.js';
import { SlackDeliveryRejected } from '../../core/slack.js';
import type { Sql } from '../../core/store.js';
import type { createConnexionPanel } from './panel.js';

const description = 'Consulter et gérer vos connexions externes';
const guide = 'Envoyez connexion dans votre DM avec Mayassistant ou choisissez Connexion dans le menu. Le tableau affiche les états enregistrés pour vos comptes et les intégrations d’équipe accessibles. Ouvrir renvoie vers l’écran du module concerné, qui gère l’autorisation, les confirmations et le retrait. Actualiser relit les états enregistrés. Le tableau ne lance ni requête chez les fournisseurs ni appel à l’IA.';

export function createConnexionModule(team: string, modules: () => readonly AssistantModule[], panel?: ReturnType<typeof createConnexionPanel>): AssistantModule {
  async function dashboard(actor: Actor, sql: Sql): Promise<MenuPage> {
    if (actor.team !== team || !/^D[A-Z0-9]+$/.test(actor.channel)) return { kind: 'Connexion', text: 'Ouvrez Connexion en message privé.' };
    const sources = modules().filter(module => module.connections);
    const entries = (await Promise.all(sources.map(async module =>
      (await module.connections!(actor, sql)).map(item => ({ item, destination: `${module.id}:${item.page}` }))
    ))).flat();
    entries.sort((a, b) => a.item.scope.localeCompare(b.item.scope) || a.item.name.localeCompare(b.item.name, 'fr'));
    if (!entries.length) return { kind: 'Connexion', text: 'Aucune connexion disponible. Un administrateur peut activer les modules concernés.' };
    return {
      kind: 'Connexion', text: 'Ouvrez une application pour gérer son accès.',
      buttons: [{ label: 'Actualiser', action: 'core:navigate', value: 'connexion:main', bound: true },
        ...(panel ? [{ label: 'Ouvrir le tableau interactif', action: 'open_panel', value: 'tableau', bound: true }] : [])],
      table: {
        columns: ['Application', 'Accès', 'État enregistré', 'Compte'], literalText: true,
        rows: entries.map(({ item }) => [item.name, item.scope === 'personal' ? 'Personnel' : 'Équipe', item.status, item.account ?? '']),
        rowButtonColumn: 'Actions',
        rowButtons: entries.map(({ destination }) => ({ label: 'Ouvrir', action: 'core:navigate', value: destination, bound: true })),
      },
    };
  }

  return {
    id: 'connexion', name: 'Connexion', aliases: ['connexions'], description,
    help: { text: panel ? `${guide} Pour ouvrir le tableau interactif, envoyez connexion tableau.` : guide },
    menu: (actor, _page, { sql }) => dashboard(actor, sql),
    ...(panel ? { menuActions: ['open_panel'], registerRoutes: panel.registerRoutes, workObject: panel.workObject } : {}),
    async handle(actor, payload, eventId, { sql, messenger }) {
      const openPanel = panel && ((payload.type === 'text' && payload.text === 'tableau') ||
        (payload.type === 'menu_action' && payload.action === 'open_panel' &&
          (await boundMenuTarget(sql, actor, payload.value, payload.timestamp))?.value === 'tableau'));
      if (openPanel) {
        const page = await dashboard(actor, sql);
        if (!page.table) return messenger.send(actor, page);
        try { await panel.launch(actor, eventId, page, messenger); }
        catch (error) {
          if (!(error instanceof SlackDeliveryRejected) || !['invalid_metadata_format', 'invalid_metadata_schema', 'missing_scope'].includes(error.code ?? '')) throw error;
          await messenger.send(actor, { ...page, text: `Slack n’a pas accepté la carte interactive. ${page.text}` });
        }
        return;
      }
      if (payload.type !== 'text') return;
      if (payload.text !== 'menu') return messenger.send(actor, { kind: 'Connexion', text: guide });
      await messenger.send(actor, await dashboard(actor, sql));
    },
  };
}
