import { createHash } from 'node:crypto';
import type { Actor } from '../../core/identity.js';
import { Navigation, type MenuPage, type MenuTarget } from '../../core/navigation.js';
import { menuButton, type Button } from '../../core/slack.js';
import type { StatusEditor } from './domain.js';
import { ClickupAPI, ClickupError } from './api.js';
import { formatDate, formatNumber } from '../../core/presentation.js';
import { ClickupStatusStore } from './status-store.js';
import { discoverStatuses } from './statuses.js';
import { filterNames, filterSummary, matchesStatus } from './status-filter.js';

const choiceKey = (name: string) => createHash('sha256').update(name).digest('hex');
const editorChoices = (editor: StatusEditor) => {
  const { catalogue, filter } = editor.data;
  return [...catalogue.choices.map(choice => ({ ...choice, available: true })), ...filterNames(filter).filter(name => !catalogue.choices.some(choice => choice.name === name)).map(name => ({ name, unfinished: false, available: false }))];
};

export function statusPage(editor: StatusEditor, requestedPage = 0, notice = ''): MenuPage {
  const { catalogue, filter } = editor.data;
  const choices = editorChoices(editor);
  const names = choices.filter(choice => matchesStatus(filter, choice.name, choice.unfinished)).map(choice => choice.name);
  const pages = Math.max(1, Math.ceil(choices.length / 10)), page = Math.min(requestedPage, pages - 1);
  const selected = new Set(names), visible = choices.slice(page * 10, (page + 1) * 10);
  const rowButtons = visible.map(choice => choice.available || selected.has(choice.name) ? {
    label: selected.has(choice.name) ? '☑ Retirer' : '☐ Ajouter',
    action: selected.has(choice.name) ? 'status_remove' : 'status_add', value: `${editor.id}|${page}|${choiceKey(choice.name)}`,
  } : null);
  const buttons: Button[] = [];
  if (page > 0) buttons.push({ label: 'Précédent', action: 'status_page', value: `${editor.id}|${page - 1}` });
  if (page + 1 < pages) buttons.push({ label: 'Suivant', action: 'status_page', value: `${editor.id}|${page + 1}` });
  if (!catalogue.complete) buttons.push({ label: 'Réessayer', action: 'status_retry', value: `${editor.id}|${page}` });
  if (catalogue.complete) buttons.push({ label: 'Actualiser les statuts', action: 'status_retry', value: `${editor.id}|${page}` });
  buttons.push({ label: 'Réinitialiser le filtre', action: 'status_reset', value: `${editor.id}|${page}` }, { label: 'Fermer', action: 'status_cancel', value: `${editor.id}|${page}` });
  return { kind: 'Statuts ClickUp', bindButtons: true, buttons,
    ...(visible.length ? { table: { columns: ['Statut', 'Inclus', 'Disponibilité'],
      rows: visible.map(choice => [choice.name, selected.has(choice.name) ? 'Oui' : 'Non', choice.available ? 'Disponible' : catalogue.complete ? 'Indisponible' : 'Non vérifié']),
      rowButtons, rowButtonColumn: 'Sélection', rowButtonFallback: 'Ouvrez clickup statuts dans un client Slack récent',
    } } : {}), text: [
    notice, filter.mode === 'default' ? `Filtre par défaut : ${filterSummary(filter)}.` : `Sélection personnelle : ${formatNumber(names.length)} statuts.`,
    '☑ Retirer exclut un statut ; ☐ Ajouter l’inclut. Chaque modification est enregistrée automatiquement. Ce sélecteur expire après 30 minutes.',
    catalogue.complete ? `Statuts disponibles · Page ${formatNumber(page + 1)}/${formatNumber(pages)}.` : `Liste des statuts incomplète · Page ${formatNumber(page + 1)}/${formatNumber(pages)}. Les modifications sont enregistrées ; Réessayer poursuit la découverte.`,
    catalogue.checkedAt ? `Catalogue vérifié : ${formatDate(catalogue.checkedAt)}. Réutilisé pendant 5 minutes ; Actualiser les statuts relance la découverte.` : '',
    !visible.length ? 'Aucun statut découvert pour le moment.' : '',
    'Les noms identiques s’appliquent à toutes les listes de Mayasquad. La découverte des statuts de Personal List est différée.',
  ].filter(Boolean).join('\n') };
}

type StatusMenuContext = { api: ClickupAPI; store: ClickupStatusStore; navigation: Navigation; connectionId: string; subject: string; workspace: string; target?: MenuTarget };

export async function handleStatusMenu(actor: Actor, command: string, value: string, eventId: string, context: StatusMenuContext) {
  const show = (page: MenuPage, target = context.target) => context.navigation.show(actor, eventId, { ...page, buttons: [...(page.buttons ?? []), menuButton] }, target);
  const unavailable = () => show({ kind: 'Statuts indisponibles', text: 'Ce sélecteur est indisponible ou expiré. Envoyez clickup statuts pour en ouvrir un nouveau.' });
  const parsed = /^([\w-]{1,128})\|(\d{1,6})(?:\|([a-f0-9]{64}))?$/.exec(value);
  let editor = command === 'statuses' ? await context.store.editor(actor, eventId, true) : parsed ? await context.store.editor(actor, parsed[1]!) : undefined;
  if ((command !== 'statuses' && !editor) || (editor && editor.connectionId !== context.connectionId)) return unavailable();
  const page = Number(parsed?.[2] ?? 0);
  if (editor && editor.state !== 'editing') return show({ kind: 'Statuts ClickUp', bindButtons: true, text: 'Cette action a déjà été traitée ou ce sélecteur est fermé. Votre filtre actuel est conservé.', buttons: [{ label: 'Choisir les statuts', action: 'statuses', value: 'statuses' }] });
  // Local changes need only ownership/connection checks, including during cooldowns.
  if (['statuses', 'status_save', 'status_retry'].includes(command)) {
    try {
      const options = { waitForRateLimit: false, signal: AbortSignal.timeout(5000) };
      if ((await context.api.identity(options)).id !== context.subject) throw new ClickupError(403);
      await context.api.workspace(context.workspace, options);
    } catch (error) {
      // A rejected Save must not become a successful effect on a later delivery retry.
      if (editor && command === 'status_save') await context.store.edit(actor, editor, eventId, editor.data);
      if (error instanceof ClickupError && [401, 403].includes(error.status)) return show({ kind: 'ClickUp indisponible', text: 'Le compte ou l’accès à Mayasquad ne peut pas être vérifié. Reconnectez ClickUp ; votre filtre enregistré est conservé.' });
      const text = `ClickUp est temporairement indisponible. Votre filtre et vos modifications sont conservés.${error instanceof ClickupError && error.retryAt > Date.now() ? ` Réessayez après ${formatDate(new Date(error.retryAt).toISOString())}.` : ' Réessayez plus tard.'}`;
      if (editor) return show(statusPage(editor, page, text));
      return show({ kind: 'Statuts temporairement indisponibles', bindButtons: true, text, buttons: [{ label: 'Réessayer', action: 'statuses', value: 'statuses' }] });
    }
  }
  if (command === 'statuses') {
    if (!editor) editor = await context.store.open(actor, eventId, context.connectionId, await context.store.catalogue(actor, context.connectionId) ?? await discoverStatuses(context.api, context.workspace));
    if (!editor || editor.connectionId !== context.connectionId || editor.state !== 'editing') return unavailable();
    const page = statusPage(editor);
    return context.navigation.show(actor, eventId, { ...page, buttons: [...(page.buttons ?? []), menuButton] });
  }
  if (!editor || !parsed) return unavailable();
  if (await context.store.handled(actor, eventId, editor.id)) return show(statusPage(editor, page, 'Cette action a déjà été traitée. Aucune modification n’a été répétée.'));
  if (command === 'status_reset' || command === 'status_add' || command === 'status_remove') {
    const choice = command === 'status_reset' ? undefined : editorChoices(editor).find(choice => choiceKey(choice.name) === parsed[3]);
    if (command !== 'status_reset' && !choice) return unavailable();
    const result = await context.store.change(actor, editor.id, context.connectionId, eventId, command === 'status_reset'
      ? { type: 'reset' } : { type: command === 'status_add' ? 'add' : 'remove', name: choice!.name });
    if (result.outcome === 'unavailable') return unavailable();
    if (result.outcome === 'conflict') return show({ kind: 'Statuts ClickUp', bindButtons: true, text: 'Ce sélecteur est périmé après une autre sauvegarde. Votre filtre actuel est conservé ; rouvrez le sélecteur.', buttons: [{ label: 'Choisir les statuts', action: 'statuses', value: 'statuses' }] });
    return show(statusPage(result.editor, page, result.outcome === 'duplicate'
      ? 'Cette action a déjà été traitée. Aucune modification n’a été répétée.'
      : result.outcome === 'last_choice' ? 'Gardez au moins un statut sélectionné ou réinitialisez le filtre. Ce retrait n’a pas été enregistré.'
        : command === 'status_reset' ? 'Filtre par défaut enregistré.' : 'Modification enregistrée. Elle s’appliquera à la prochaine commande clickup tâches ou à Actualiser.'));
  }
  const data = structuredClone(editor.data);
  let notice = '';
  if (command === 'status_page') return show(statusPage(editor, page));
  if (command === 'status_retry') {
    data.catalogue = await discoverStatuses(context.api, context.workspace, data.catalogue.complete ? undefined : data.catalogue);
    await context.store.edit(actor, editor, eventId, data);
  } else if (command === 'status_cancel') {
    await context.store.edit(actor, editor, eventId, data, 'cancelled');
    return show({ kind: 'Statuts ClickUp', text: 'Sélecteur fermé. Vos modifications enregistrées sont conservées.' });
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
  if (editor?.state === 'conflict') return show({ kind: 'Statuts ClickUp', bindButtons: true, text: 'Ce sélecteur est périmé après une autre sauvegarde. Votre filtre actuel est conservé ; rouvrez le sélecteur.', buttons: [{ label: 'Choisir les statuts', action: 'statuses', value: 'statuses' }] });
  return editor ? show(statusPage(editor, page, notice)) : unavailable();
}
