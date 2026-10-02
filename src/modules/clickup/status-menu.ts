import { createHash } from 'node:crypto';
import type { Actor } from '../../core/identity.js';
import { Navigation, type MenuPage, type MenuTarget } from '../../core/navigation.js';
import { escapeCardValue, menuButton, type Button } from '../../core/slack.js';
import type { StatusEditor } from './domain.js';
import { ClickupAPI, ClickupError } from './api.js';
import { formatDate, formatNumber } from '../../core/presentation.js';
import { ClickupStatusStore } from './status-store.js';
import { discoverStatuses } from './statuses.js';

const choiceKey = (name: string) => createHash('sha256').update(name).digest('hex');
const editorChoices = (editor: StatusEditor) => {
  const { catalogue, filter } = editor.data;
  return [...catalogue.choices.map(choice => ({ ...choice, available: true })), ...(filter.mode === 'custom' ? filter.names : []).filter(name => !catalogue.choices.some(choice => choice.name === name)).map(name => ({ name, unfinished: false, available: false }))];
};

export function statusPage(editor: StatusEditor, requestedPage = 0, notice = ''): MenuPage {
  const { catalogue, filter } = editor.data;
  const names = filter.mode === 'custom' ? filter.names : catalogue.choices.filter(choice => choice.unfinished).map(choice => choice.name);
  const choices = editorChoices(editor);
  const pages = Math.max(1, Math.ceil(choices.length / 10)), page = Math.min(requestedPage, pages - 1);
  const selected = new Set(names), visible = choices.slice(page * 10, (page + 1) * 10);
  const buttons: Button[] = visible.filter(choice => choice.available || selected.has(choice.name)).map(choice => ({
    label: `${selected.has(choice.name) ? 'Retirer' : 'Ajouter'} ${choice.name.slice(0, 60)}`,
    action: selected.has(choice.name) ? 'status_remove' : 'status_add', value: `${editor.id}|${page}|${choiceKey(choice.name)}`,
  }));
  if (page > 0) buttons.push({ label: 'Précédent', action: 'status_page', value: `${editor.id}|${page - 1}` });
  if (page + 1 < pages) buttons.push({ label: 'Suivant', action: 'status_page', value: `${editor.id}|${page + 1}` });
  if (catalogue.complete) buttons.push({ label: 'Enregistrer', action: 'status_save', value: `${editor.id}|${page}`, style: 'primary' });
  else buttons.push({ label: 'Réessayer', action: 'status_retry', value: `${editor.id}|${page}` });
  buttons.push({ label: 'Réinitialiser le filtre', action: 'status_reset', value: `${editor.id}|${page}` }, { label: 'Annuler', action: 'status_cancel', value: `${editor.id}|${page}` });
  return { kind: 'Statuts ClickUp', bindButtons: true, buttons, text: [
    notice, filter.mode === 'default' ? 'Filtre par défaut : tous les statuts non terminés.' : `Sélection personnelle : ${formatNumber(names.length)} statuts.`,
    'Les modifications prennent effet après Enregistrer. Ce sélecteur expire après 30 minutes.',
    catalogue.complete ? `Statuts disponibles · Page ${formatNumber(page + 1)}/${formatNumber(pages)}.` : 'Liste des statuts incomplète. Enregistrement bloqué ; votre filtre enregistré est conservé.',
    ...visible.map(choice => `${selected.has(choice.name) ? '✓' : '○'} ${escapeCardValue(choice.name)}${catalogue.complete && !catalogue.choices.some(available => available.name === choice.name) ? ' · indisponible' : ''}`),
    'Les noms identiques s’appliquent à toutes les listes de Mayasquad. La découverte des statuts de Personal List est différée.',
  ].filter(Boolean).join('\n') };
}

type StatusMenuContext = { api: ClickupAPI; store: ClickupStatusStore; navigation: Navigation; connectionId: string; subject: string; workspace: string; target?: MenuTarget };

export async function handleStatusMenu(actor: Actor, command: string, value: string, eventId: string, context: StatusMenuContext) {
  const show = (page: MenuPage, target = context.target) => context.navigation.show(actor, eventId, { ...page, buttons: [...(page.buttons ?? []), menuButton] }, target);
  const unavailable = () => show({ kind: 'Statuts indisponibles', text: 'Ce sélecteur est indisponible ou expiré. Envoyez clickup statuts pour en ouvrir un nouveau.' });
  try {
    if ((await context.api.identity()).id !== context.subject) throw new Error('Identity changed');
    await context.api.workspace(context.workspace);
  } catch (error) {
    if (error instanceof ClickupError && [401, 403].includes(error.status)) return show({ kind: 'ClickUp indisponible', text: 'Le compte ou l’accès à Mayasquad ne peut pas être vérifié. Reconnectez ClickUp ; votre filtre enregistré est conservé.' });
    return show({ kind: 'Statuts temporairement indisponibles', bindButtons: true,
      text: `ClickUp est temporairement indisponible. Votre filtre et vos modifications sont conservés.${error instanceof ClickupError && error.retryAt > Date.now() ? ` Réessayez après ${formatDate(new Date(error.retryAt).toISOString())}.` : ' Réessayez plus tard.'}`,
      buttons: [{ label: 'Réessayer', action: command === 'statuses' ? 'statuses' : 'status_retry', value: command === 'statuses' ? 'statuses' : value }],
    });
  }
  if (command === 'statuses') {
    let editor = await context.store.editor(actor, eventId, true);
    if (!editor) editor = await context.store.open(actor, eventId, context.connectionId, await discoverStatuses(context.api, context.workspace));
    if (!editor || editor.connectionId !== context.connectionId || editor.state !== 'editing') return unavailable();
    const page = statusPage(editor);
    return context.navigation.show(actor, eventId, { ...page, buttons: [...(page.buttons ?? []), menuButton] });
  }
  const parsed = /^([\w-]{1,128})\|(\d{1,6})(?:\|([a-f0-9]{64}))?$/.exec(value);
  if (!parsed) return unavailable();
  let editor = await context.store.editor(actor, parsed[1]!);
  if (!editor || editor.connectionId !== context.connectionId) return unavailable();
  const page = Number(parsed[2]);
  if (editor.state !== 'editing') {
    return show({ kind: 'Statuts ClickUp', bindButtons: true, text: 'Cette action a déjà été traitée ou ce sélecteur est fermé. Votre filtre actuel est conservé.', buttons: [{ label: 'Choisir les statuts', action: 'statuses', value: 'statuses' }] });
  }
  if (await context.store.handled(actor, eventId, editor.id)) return show(statusPage(editor, page, 'Cette action a déjà été traitée. Aucune modification n’a été répétée.'));
  const data = structuredClone(editor.data);
  let notice = '';
  if (command === 'status_page') return show(statusPage(editor, page));
  if (command === 'status_retry') {
    data.catalogue = await discoverStatuses(context.api, context.workspace, data.catalogue);
    await context.store.edit(actor, editor, eventId, data);
  } else if (command === 'status_cancel') {
    await context.store.edit(actor, editor, eventId, data, 'cancelled');
    return show({ kind: 'Statuts ClickUp', text: 'Modification annulée. Votre filtre enregistré est conservé.' });
  } else if (command === 'status_reset') {
    data.filter = { mode: 'default' };
    await context.store.edit(actor, editor, eventId, data);
  } else if (command === 'status_add' || command === 'status_remove') {
    const choice = editorChoices(editor).find(choice => choiceKey(choice.name) === parsed[3]);
    if (!choice || (command === 'status_add' && !choice.available)) return unavailable();
    const names = new Set(data.filter.mode === 'custom' ? data.filter.names : data.catalogue.choices.filter(choice => choice.unfinished).map(choice => choice.name));
    if (command === 'status_add') names.add(choice.name); else names.delete(choice.name);
    data.filter = { mode: 'custom', names: [...names] };
    await context.store.edit(actor, editor, eventId, data);
  } else if (command === 'status_save') {
    if (!data.catalogue.complete) notice = 'La liste des statuts est incomplète. Réessayez avant d’enregistrer.';
    else if (data.filter.mode === 'custom' && !data.filter.names.length) notice = 'Sélectionnez au moins un statut ou réinitialisez le filtre.';
    else {
      await context.store.save(actor, editor, eventId);
      editor = await context.store.editor(actor, editor.id);
      return show({ kind: 'Statuts ClickUp', bindButtons: true, text: editor?.state === 'saved' ? 'Votre filtre est enregistré. Il s’appliquera à la prochaine commande clickup tâches ou à Actualiser.' : 'Ce sélecteur est périmé après une autre sauvegarde. Votre filtre actuel est conservé ; rouvrez le sélecteur.', buttons: [{ label: 'Choisir les statuts', action: 'statuses', value: 'statuses' }] });
    }
    await context.store.edit(actor, editor, eventId, data);
  } else return unavailable();
  editor = await context.store.editor(actor, editor.id);
  return editor ? show(statusPage(editor, page, notice)) : unavailable();
}
