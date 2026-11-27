import type { Actor } from '../../core/identity.js';
import type { AssistantModule } from '../../core/modules.js';
import type { MenuPage } from '../../core/navigation.js';
import type { Sql } from '../../core/store.js';

const description = 'Consulter et gérer vos connexions externes';
const guide = 'Envoyez connexion dans votre DM avec Mayassistant ou choisissez Connexion dans le menu. Le tableau affiche les états enregistrés pour vos comptes et les intégrations d’équipe accessibles. Ouvrir renvoie vers l’écran du module concerné, qui gère l’autorisation, les confirmations et le retrait. Actualiser relit les états enregistrés. Le tableau ne lance ni requête chez les fournisseurs ni appel à l’IA.';

export function createConnexionModule(team: string, modules: () => readonly AssistantModule[]): AssistantModule {
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
      buttons: [{ label: 'Actualiser', action: 'core:navigate', value: 'connexion:main', bound: true }],
      table: {
        columns: ['Application', 'Accès', 'État enregistré', 'Compte', 'Actions'], literalText: true,
        rows: entries.map(({ item }) => [item.name, item.scope === 'personal' ? 'Personnel' : 'Équipe', item.status, item.account ?? '', '']),
        rowButtonColumn: 'Actions',
        rowButtons: entries.map(({ destination }) => ({ label: 'Ouvrir', action: 'core:navigate', value: destination, bound: true })),
      },
    };
  }

  return {
    id: 'connexion', name: 'Connexion', aliases: ['connexions'], description, help: { text: guide },
    menu: (actor, _page, { sql }) => dashboard(actor, sql),
    async handle(actor, payload, _id, { sql, messenger }) {
      if (payload.type !== 'text') return;
      if (payload.text !== 'menu') return messenger.send(actor, { kind: 'Connexion', text: guide });
      await messenger.send(actor, await dashboard(actor, sql));
    },
  };
}
