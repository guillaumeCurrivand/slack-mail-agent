import type { MenuPage } from './navigation.js';
import type { SlackChannels } from './slack-channels.js';
import { menuButton, type Button } from './slack.js';

export async function destinationChannelsPage(id: string, name: string, directory: SlackChannels, user: string,
  loadDestinations: () => Promise<{ channel_id: string; id: string }[]>, requested = 0, notice = '', standalone = false): Promise<MenuPage> {
  const back = [{ label: `Retour à ${name}`, page: standalone ? `${id}:main` : 'main' }];
  let available;
  try { available = await directory.list(user); }
  catch { return { kind: `Canaux ${name}`, text: 'L’accès aux canaux ne peut pas être vérifié. Aucun canal n’est affiché ni modifié. Réouvrez la liste plus tard.', buttons: [menuButton], links: back }; }
  const selected = new Map((await loadDestinations()).map(row => [row.channel_id, row.id]));
  const pages = Math.max(1, Math.ceil(available.length / 10)), current = Math.min(requested, pages - 1);
  const visible = available.slice(current * 10, (current + 1) * 10);
  const rowButtons: Button[] = visible.map(channel => selected.has(channel.id)
    ? { label: '☑ Retirer', action: 'channel_remove', value: `${channel.id}|${selected.get(channel.id)}|${current}`, style: 'danger' }
    : { label: '☐ Activer', action: 'channel_add', value: `${channel.id}|${current}` });
  const buttons: Button[] = [];
  if (current) buttons.push({ label: 'Précédent', action: 'channel_page', value: String(current - 1) });
  if (current + 1 < pages) buttons.push({ label: 'Suivant', action: 'channel_page', value: String(current + 1) });
  buttons.push(menuButton);
  return { kind: `Canaux ${name}`, bindButtons: true, links: back, buttons,
    ...(visible.length ? { table: { columns: ['Canal', 'Visibilité', 'Notifications'],
      rows: visible.map(channel => [`#${channel.name}`, channel.private ? 'Privé' : 'Public', selected.has(channel.id) ? 'Activées' : 'Désactivées']),
      rowButtons, rowButtonColumn: 'Sélection', rowButtonFallback: `Ouvrez ${id} canaux dans un client Slack récent`,
    } } : {}), text: [notice,
    `Liste partagée : Activer autorise immédiatement les futurs messages ${name} dans ce canal. Retirer annule les messages en attente. Les canaux auxquels vous n’avez pas accès sont masqués.`,
    `Canaux (page ${current + 1}/${pages}) :`,
    !available.length ? 'Aucun canal partagé avec le bot. Invitez-le dans les canaux à sélectionner.' : '',
  ].filter(Boolean).join('\n') };
}
