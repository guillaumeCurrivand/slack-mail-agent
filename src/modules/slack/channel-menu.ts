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
    const links = [{ label: "Retour aux messages Slack sans réponse", page: standalone ? 'slack:main' : 'main' }];
    let available: Channel[] = [];
    let accessUnavailable = false;
    try { available = await directory.listFor(actor.user); }
    catch { accessUnavailable = true; }
    const saved = new Set(await selections.list(actor));
    const availableIds = new Set(available.map(channel => channel.id));
    const unavailable = [...saved].filter(id => !availableIds.has(id)).sort();
    const items = [
      ...available.map(channel => ({ id: channel.id, name: `${channel.private ? "Privé" : "Public"} #${escapeCardValue(escapeSlack(channel.name))}`, buttonName: `#${channel.name}`, selected: saved.has(channel.id) })),
      ...unavailable.map(id => ({ id, name: `Canal sélectionné indisponible ${id}`, buttonName: id, selected: true })),
    ];
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const current = Math.min(requestedPage, pages - 1);
    const visible = items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
    const text = [
      notice,
      `Canaux sélectionnés : ${saved.size}. Vous seul pouvez modifier votre sélection.`,
      accessUnavailable ? "L’accès aux canaux est momentanément indisponible. Les canaux disponibles ne peuvent pas être affichés. Les sélections enregistrées peuvent toujours être retirées."
        : items.length ? `Canaux (page ${current + 1}/${pages}):` : "Aucun canal public ou privé partagé n’est disponible. Invitez le bot dans un canal pour le rendre accessible.",
      accessUnavailable && items.length ? `Sélections enregistrées (page ${current + 1}/${pages}):` : '',
      ...visible.map(item => `${item.selected ? '✓' : '○'} ${item.name}`),
      unavailable.length ? "Les canaux sélectionnés inaccessibles restent enregistrés jusqu’à leur retrait. Leur contenu n’est pas affiché." : '',
    ].filter(Boolean).join('\n');
    const buttons: Button[] = visible.map(item => ({
      label: `${item.selected ? "Retirer" : "Ajouter"} ${item.buttonName.slice(0, 60)}`,
      action: item.selected ? 'channel_remove' : 'channel_select', value: selectionValue(item.id, current),
    }));
    if (current > 0) buttons.push({ label: "Précédent", action: 'channel_page', value: String(current - 1) });
    if (current + 1 < pages) buttons.push({ label: "Suivant", action: 'channel_page', value: String(current + 1) });
    return { kind: "Canaux Slack", text, buttons, bindButtons: true, links };
  }

  async function handle(actor: Actor, payload: JobPayload, eventId: string, context: ModuleContext) {
    const navigation = new Navigation(context.sql, context.messenger);
    if (payload.type === 'text') return navigation.show(actor, eventId, await page(actor, 0, '', true));
    const bound = await navigation.boundTarget(actor, payload.value, payload.timestamp);
    const action = String(payload.action);
    // Channel Cards posted before DM navigation used unbound values. Their
    // signed clicks still act only on the current User's selections and access.
    const legacy = !bound && (action === 'channel_page' ? /^\d{1,6}$/.test(String(payload.value)) : !!parseSelection(payload.value));
    if (!bound && !legacy) return navigation.show(actor, eventId, { kind: "Menu indisponible", text: "Cette liste de canaux est indisponible. Envoyez slack canaux ou menu pour en ouvrir une nouvelle.", buttons: [menuButton] });
    const value = bound?.value ?? String(payload.value);
    if (action === 'channel_page') {
      const requestedPage = /^\d{1,6}$/.test(value) ? Number(value) : 0;
      return navigation.show(actor, eventId, await page(actor, requestedPage, '', true), bound?.target);
    }
    const selected = parseSelection(value);
    if (!selected) return navigation.show(actor, eventId, await page(actor, 0, "Ce bouton de canal est invalide.", true), bound?.target);
    if (await selections.handled(actor, eventId)) return navigation.show(actor, eventId, await page(actor, selected.page, "Cette action a déjà été traitée.", true), bound?.target);
    const saved = new Set(await selections.list(actor));
    let notice: string;
    if (action === 'channel_remove') {
      if (saved.has(selected.id)) notice = await selections.removeOnce(actor, eventId, selected.id) ? "Canal retiré." : "Cette action a déjà été traitée.";
      else { await selections.markHandled(actor, eventId); notice = "Ce canal avait déjà été retiré."; }
    } else {
      let available: Channel[];
      try { available = await directory.listFor(actor.user); }
      catch {
        await selections.markHandled(actor, eventId);
        return navigation.show(actor, eventId, await page(actor, selected.page, "Impossible de vérifier l’accès au canal. Aucune sélection n’a été modifiée.", true), bound?.target);
      }
      if (!available.some(channel => channel.id === selected.id)) notice = "Ce canal n’est plus accessible à vous et au bot. Aucune sélection n’a été modifiée.";
      else if (saved.has(selected.id)) notice = "Ce canal est déjà sélectionné.";
      else notice = await selections.addOnce(actor, eventId, selected.id) ? "Canal ajouté." : "Cette action a déjà été traitée.";
      if (notice !== "Canal ajouté.") await selections.markHandled(actor, eventId);
    }
    return navigation.show(actor, eventId, await page(actor, selected.page, notice, true), bound?.target);
  }

  return { page, handle };
}
