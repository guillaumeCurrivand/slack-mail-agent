import { formatDate } from '../../core/presentation.js';
import { stateLabel } from './presentation.js';
import type { Actor } from '../../core/identity.js';
import { Navigation, type MenuPage } from '../../core/navigation.js';
import { escapeCardValue, type AgentMessage } from '../../core/slack.js';
import { recordTitle, type RecordKind } from './domain.js';
import type { DocumentationStore } from './store.js';
import { InventoryPresentation } from './presentation.js';

export const lifecycleHelp = "Consultez documentation archives [page]. Demandez documentation archiver <projet|technologie|composant|hébergeur|hébergement|outil> <identifiant ou nom exact>, ou documentation restaurer <type> <cible>. Les alias de projet sont acceptés ; les hébergements exigent un identifiant. Chaque opération concerne une fiche et exige votre confirmation dans cette conversation privée sous 24 heures. L’archivage conserve les relations, l’identifiant et tout l’historique. Une fiche archivée doit être restaurée explicitement avant modification. La restauration conserve l’expiration de la modification d’origine. Aucune suppression définitive ni restauration de valeurs historiques. Aucune IA.";
export const statusText = (record: { archived: boolean }) => `État : ${record.archived ? "Archivé" : "Actif"}`;
export const referenceLabel = (name: string, record: { archived: boolean }) => `${name}${record.archived ? " [Archivé]" : ''}`;
export const outcomeButtons = (id: string): NonNullable<AgentMessage['buttons']> => [
  { label: "Détails de la fiche", action: 'open_confirmation_record', value: id },
  { label: "Historique", action: 'open_confirmation_history', value: id },
];
export function lifecycleButton(kind: 'project' | RecordKind, record: { id: string; archived: boolean }): NonNullable<MenuPage['buttons']> {
  return [{ label: record.archived ? "Restaurer" : "Archiver", action: record.archived ? 'request_restore' : 'request_archive', value: `${kind}:${record.id}`, bound: true, ...(record.archived ? {} : { style: 'danger' as const }) }];
}

export class Lifecycle {
  constructor(private store: DocumentationStore) {}
  async page(actor: Actor, destination: string): Promise<MenuPage | undefined> {
    const match = /^archived_(\d{1,6})$/.exec(destination);
    if (!match) return;
    const result = await this.store.archived(actor, Number(match[1]));
    const presentation = new InventoryPresentation(this.store, actor);
    return { kind: "Inventaire archivé", text: `page ${result.page + 1}/${result.pages} · ${result.total} fiches archivées\n${result.records.length ? '' : "Aucune fiche archivée."}`,
      ...await presentation.list(result.records.map(record => ({ ...record, archived: true })), undefined, true),
      links: [
        ...(result.page > 0 ? [{ label: "Précédent", page: `archived_${result.page - 1}` }] : []),
        ...(result.page + 1 < result.pages ? [{ label: "Suivant", page: `archived_${result.page + 1}` }] : []), { label: "Retour", page: 'main' }] };
  }
  async handle(actor: Actor, payload: Record<string, unknown>, eventId: string, navigation: Navigation,
    deliver: (message: AgentMessage) => Promise<void>, show: (destination: string) => Promise<void>, source = 'Slack structured'): Promise<boolean> {
    const presentation = new InventoryPresentation(this.store, actor);
    const confirm = /^confirm_(archive|restore)_(project|technology|component|host|hosting|tool)$/.exec(String(payload.action));
    if (payload.type === 'action' && confirm) {
      const operation = confirm[1] as 'archive' | 'restore', kind = confirm[2] as 'project' | RecordKind;
      const saved = typeof payload.value === 'string' ? await this.store.confirmLifecycle(actor, payload.value, kind, operation) : undefined;
      if (!saved || saved.record_kind !== kind || saved.operation !== operation) await deliver({ kind: "Confirmation indisponible", text: "Cette confirmation est indisponible ou n’appartient pas à cet utilisateur et à cette conversation privée." });
      else if (!saved.applied_at) await deliver({ kind: "Confirmation expirée", text: `Envoyez une nouvelle demande documentation ${stateLabel(operation)} ${kind}.` });
      else await deliver({ kind: saved.outcome === 'missing' ? "Changement d’état échoué" : saved.outcome === 'satisfied' ? "État déjà satisfait" : `${recordTitle(kind)} : ${operation === 'archive' ? 'archivage enregistré' : 'restauration enregistrée'}`,
        buttons: outcomeButtons(saved.id),
        text: `${recordTitle(kind)}: ${escapeCardValue(await presentation.name(kind, saved.target_id))}\n${saved.outcome === 'missing' ? "La cible était indisponible. Rien n’a changé." : saved.outcome === 'satisfied' ? "L’état demandé était déjà satisfait ; aucune modification ni entrée d’historique n’a été ajoutée." : "Le changement d’état approuvé a été enregistré une seule fois. Des changements ultérieurs peuvent avoir modifié l’état actuel."}\nOuvrez Détails de la fiche pour consulter l’état actuel.` });
      return true;
    }
    let request: { operation: 'archive' | 'restore'; kind: 'project' | RecordKind; selector: string } | undefined;
    if (payload.type === 'menu_action' && ['request_archive', 'request_restore'].includes(String(payload.action))) {
      const bound = await navigation.boundTarget(actor, payload.value, payload.timestamp);
      const value = bound && /^(project|technology|component|host|hosting|tool):([^:]+)$/.exec(bound.value);
      if (!value) { await deliver({ kind: "Menu indisponible", text: "Ce bouton privé est indisponible. Ouvrez à nouveau la fiche." }); return true; }
      request = { operation: payload.action === 'request_archive' ? 'archive' : 'restore', kind: value[1] as 'project' | RecordKind, selector: value[2]! };
    }
    if (payload.type === 'text') {
      const text = String(payload.text ?? '').trim();
      const archived = /^archived(?:\s+(\d{1,6}))?$/i.exec(text);
      if (archived) { await show(`archived_${archived[1] ?? '0'}`); return true; }
      const match = /^(archive|restore) (project|technology|component|host|hosting|hosting-entry|tool)\s+([\s\S]+)$/i.exec(text);
      if (match) request = { operation: match[1]!.toLowerCase() as 'archive' | 'restore', kind: match[2]!.toLowerCase().replace('hosting-entry', 'hosting') as 'project' | RecordKind, selector: match[3]!.trim() };
    }
    if (!request) return false;
    let proposal = await this.store.request(actor, eventId);
    if (!proposal) {
      const result = request.kind === 'project' ? await this.store.lookup(actor, request.selector) : await this.store.lookupRecord(actor, request.kind, request.selector);
      if (result.total !== 1) {
        await deliver({ kind: result.total ? 'Cible ambiguë' : `${recordTitle(request.kind)} introuvable`, text: "Examinez la fiche exacte et répétez avec un identifiant stable. Rien n’a été proposé." }); return true;
      }
      const target = 'projects' in result ? result.projects[0]! : result.records[0]!;
      proposal = await this.store.proposeLifecycle(actor, eventId, request.kind, target.id, request.operation, source);
    }
    const operation = proposal.operation === 'archive' ? 'archive' : 'restore';
    await deliver({ kind: `${operation === 'archive' ? "Archiver" : "Restaurer"} ${recordTitle(proposal.record_kind)} — confirmation`,
      text: `${operation === 'archive' ? "Archiver" : "Restaurer"} partagé — ${recordTitle(proposal.record_kind)}: ${escapeCardValue(await presentation.name(proposal.record_kind, proposal.target_id))}\nLes relations, l’identifiant et l’historique complet sont conservés. Seule cette fiche change. Vous seul pouvez confirmer dans cette conversation privée. Expiration : ${formatDate(new Date(proposal.created_at).getTime() + 24 * 3600_000)}. Rien n’est enregistré avant votre confirmation.`,
      buttons: [{ label: operation === 'archive' ? 'Confirmer l’archivage' : 'Confirmer la restauration', action: `confirm_${operation}_${proposal.record_kind}`, value: proposal.id, style: operation === 'archive' ? 'danger' : 'primary' }] });
    return true;
  }
}
