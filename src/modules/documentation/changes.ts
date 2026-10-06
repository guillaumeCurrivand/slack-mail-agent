import { formatDate } from '../../core/presentation.js';
import type { Actor } from '../../core/identity.js';
import { escapeCardValue as literal, type AgentMessage } from '../../core/slack.js';
import { projectFields, projectEdit, recordSchemas, recordTitle, validSavedFields, parseEditRequest,
  type Project, type ProjectFields, type ProjectEdit, type InventoryRecord, type InventoryValues, type RecordKind } from './domain.js';
import { helpFor, hostHelp, projectHelp } from './help.js';
import { outcomeButtons } from './lifecycle.js';
import { InventoryPresentation, stateLabel } from './presentation.js';
import type { Confirmation, DocumentationStore } from './store.js';

type Kind = 'project' | RecordKind;
type Operation = 'create' | 'edit';
const unavailable = (): AgentMessage => ({ kind: 'Confirmation indisponible', text: 'Cette confirmation est indisponible ou n’appartient pas à cet utilisateur et à cette conversation privée.' });

/** Owns the create/edit workflow for every inventory kind; delivery remains Module-owned. */
export class InventoryChanges {
  constructor(private store: DocumentationStore) {}

  async handle(actor: Actor, payload: Record<string, unknown>, eventId: string, source = 'Slack structured'): Promise<AgentMessage | undefined> {
    // Project controls predate typed records and must keep their original names.
    const action = /^confirm_(create|edit)(?:_(technology|component|host|hosting|tool))?$/.exec(String(payload.action));
    if (payload.type === 'action' && action) {
      const operation = action[1] as Operation, kind = (action[2] ?? 'project') as Kind;
      const saved = typeof payload.value !== 'string' ? undefined : kind !== 'project'
        ? await this.store.confirmRecord(actor, payload.value, kind, operation)
        : await (operation === 'edit' ? this.store.confirmEdit(actor, payload.value) : this.store.confirm(actor, payload.value));
      if (!saved || saved.record_kind !== kind || saved.operation !== operation) return unavailable();
      return this.outcome(actor, saved, operation);
    }
    if (payload.type !== 'text') return;
    const mutation = /^(create|edit) (project|technology|component|host|hosting|tool)\s+([\s\S]+)$/i.exec(String(payload.text ?? '').trim());
    if (!mutation) return;
    const operation = mutation[1]!.toLowerCase() as Operation, kind = mutation[2]!.toLowerCase() as Kind;
    const saved = await this.store.request(actor, eventId);
    if (saved) return this.preview(actor, saved, operation);
    const proposal = await this.propose(actor, eventId, kind, operation, mutation[3]!, source);
    return 'record_kind' in proposal ? this.preview(actor, proposal, operation) : proposal;
  }

  private async propose(actor: Actor, eventId: string, kind: Kind, operation: Operation, body: string, source: string): Promise<Confirmation | AgentMessage> {
    const label = recordTitle(kind);
    let fields: InventoryValues, selector: string | undefined, target: Project | InventoryRecord | undefined;
    try {
      const schema = kind === 'project' ? { create: projectFields, edit: projectEdit } : recordSchemas[kind];
      if (operation === 'create') fields = schema.create.parse(JSON.parse(body));
      else {
        const request = parseEditRequest(body);
        fields = schema.edit.parse(request.value); selector = request.selector;
      }
    } catch {
      if (kind === 'project') return operation === 'edit'
        ? { kind: 'Modification de projet invalide', text: `Choisissez un projet et fournissez un objet JSON non vide de champs autorisés. Les valeurs facultatives peuvent être null ; les noms doivent rester valides. Les champs non autorisés, métadonnées et opérations sur plusieurs fiches sont refusés.\n${projectHelp}` }
        : { kind: 'Projet invalide', text: `Fournissez un objet JSON contenant uniquement les champs du projet autorisés. Le nom doit être non vide ; les liens doivent être des URL HTTP(S) sans identifiants de connexion. La fiche complète doit tenir dans 5 000 caractères JSON.\n${projectHelp}` };
      return { kind: `Valeur invalide : ${label}${operation === 'edit' ? ' — modification' : ''}`, text: `Choisissez une fiche et un objet JSON valide de champs autorisés.\n${helpFor(kind)}` };
    }
    if (selector !== undefined) {
      const result = kind === 'project' ? await this.store.lookup(actor, selector) : await this.store.lookupRecord(actor, kind, selector);
      if (result.total !== 1) {
        if (kind === 'project') return result.total === 0
          ? { kind: 'Projet introuvable', text: 'Aucun projet ne correspond exactement à cet identifiant, nom ou alias.' }
          : { kind: 'Modification de projet ambiguë', text: `Ce nom ou alias exact correspond à ${result.total} projets. Utilisez documentation projet ${literal(selector)} pour examiner les choix, puis répétez la modification avec un identifiant stable. Rien n’a été proposé ni enregistré.` };
        return { kind: result.total ? `Référence ambiguë : ${label} — modification` : `${label} introuvable`, text: result.total ? `Consultez documentation ${kind} <nom exact> et répétez avec un identifiant stable. Rien n’a été proposé.` : `Aucune fiche : ${label} ne correspond exactement à cet identifiant ou nom.` };
      }
      target = 'projects' in result ? result.projects[0]! : result.records[0]!;
      if (target.archived) return { kind: 'Restauration nécessaire avant modification', text: kind === 'project' ? 'Ce projet est archivé. Restaurez-le explicitement avant de le modifier.' : `Cette fiche ${label} est archivée. Restaurez-la explicitement avant de la modifier.` };
    }
    if (kind === 'project') {
      // These values were validated by the Project schemas above. Keep its separate tables/history.
      return operation === 'create' ? this.store.propose(actor, eventId, fields as ProjectFields, source)
        : this.store.proposeEdit(actor, eventId, target as Project, fields as ProjectEdit, source);
    }
    const invalid = await this.resolveFields(actor, kind, operation, fields, target);
    if (invalid) return invalid;
    try { return await this.store.proposeRecord(actor, eventId, kind, fields, target as InventoryRecord | undefined, source); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('La cible ou les références d’inventaire ont changé')) throw error;
      return { kind: 'Relations indisponibles', text: error.message };
    }
  }

  private async resolveFields(actor: Actor, kind: RecordKind, operation: Operation, fields: InventoryValues, target?: Project | InventoryRecord): Promise<AgentMessage | undefined> {
    for (const [field, referenceKind] of [['projects', 'project'], ['technologies', 'technology']] as const) {
      if (!Array.isArray(fields[field])) continue;
      const resolved = await this.resolveReferences(actor, referenceKind, fields[field]);
      if (!Array.isArray(resolved)) return resolved;
      fields[field] = resolved;
    }
    if (kind === 'component' && operation === 'create' && !await this.store.project(actor, String(fields.projectId)))
      return { kind: 'Projet introuvable', text: 'Utilisez l’identifiant d’un projet existant dans cet espace. Créez un projet manquant dans une opération séparée confirmée.' };
    if (kind === 'hosting') {
      if (operation === 'create' && !await this.store.record(actor, 'component', String(fields.componentId)))
        return { kind: 'Composant introuvable', text: 'Utilisez l’identifiant d’un composant existant dans cet espace. Créez un composant manquant dans une opération séparée confirmée.' };
      if (typeof fields.serviceId === 'string') {
        const result = await this.store.lookupRecord(actor, 'host', fields.serviceId);
        if (result.total !== 1) return { kind: result.total ? 'Référence d’hébergeur/service ambiguë' : 'Hébergeur/service introuvable', text: result.total ? 'Consultez documentation hébergeur <nom exact> et répétez avec un identifiant stable. Rien n’a été proposé.' : 'Créez l’hébergeur/service manquant avec documentation créer hébergeur dans une opération séparée confirmée, puis répétez cette demande. Rien n’a été proposé.' };
        fields.serviceId = result.records[0]!.id;
      }
    }
    if (kind === 'host' && !recordSchemas.host.create.safeParse({ ...target?.fields, ...fields }).success)
      return { kind: 'Modification d’hébergeur/service invalide', text: `Un coût mensuel connu nécessite une devise explicite.\n${hostHelp}` };
    if (!validSavedFields(kind, operation, fields)) return { kind: `Valeur invalide : ${recordTitle(kind)}${operation === 'edit' ? ' — modification' : ''}`, text: `Les champs normalisés et les identifiants résolus dépassent les contraintes autorisées.\n${helpFor(kind)}` };
  }

  private async resolveReferences(actor: Actor, kind: 'project' | 'technology', selectors: string[]): Promise<string[] | AgentMessage> {
    const ids: string[] = [], label = recordTitle(kind);
    for (const selector of selectors) {
      const result = kind === 'project' ? await this.store.lookup(actor, selector) : await this.store.lookupRecord(actor, kind, selector);
      if (result.total !== 1) return { kind: result.total ? `Référence ambiguë : ${label}` : `${label} introuvable`,
        text: result.total ? `${label} ${literal(selector)} est ambiguë. Consultez documentation ${kind} ${literal(selector)} et répétez avec un identifiant stable. Rien n’a été proposé.`
          : `${label} ${literal(selector)} est introuvable dans cet espace de travail. Créez cette fiche avec documentation créer ${kind} dans une opération séparée confirmée, puis répétez cette demande. Rien n’a été proposé.` };
      ids.push('projects' in result ? result.projects[0]!.id : result.records[0]!.id);
    }
    return [...new Set(ids)];
  }

  private async preview(actor: Actor, proposal: Confirmation, operation: Operation): Promise<AgentMessage> {
    const kind = proposal.record_kind, label = recordTitle(kind), presentation = new InventoryPresentation(this.store, actor);
    const preview = await presentation.confirmation(proposal);
    const name = operation === 'edit' ? await presentation.name(kind, proposal.target_id)
      : String(proposal.fields.name ?? (proposal.fields.environment === '' ? 'Environnement vide' : proposal.fields.environment) ?? 'Environnement inconnu');
    const title = kind === 'project' ? `Confirmation de ${operation === 'create' ? 'création' : 'modification'} du projet` : `${operation === 'create' ? 'Créer' : 'Modifier'} ${label} — confirmation`;
    const heading = kind === 'project' ? `${operation === 'create' ? 'Créer' : 'Modifier'} le projet partagé : ${literal(name)}` : `${operation === 'create' ? 'Créer' : 'Modifier'} partagé — ${label}: ${literal(name)}`;
    const overwrite = kind !== 'project' ? 'Seuls les champs approuvés changent ; les modifications intermédiaires sont remplacées et les autres champs sont conservés. '
      : operation === 'edit' ? 'Seuls ces champs changeront. La confirmation les remplace même après la modification d’un autre utilisateur ; les autres champs sont conservés. ' : '';
    return { ...preview, kind: title, text: `${heading}\n${preview.text}\n${overwrite}Vous seul pouvez confirmer dans cette conversation privée. Expiration : ${formatDate(new Date(proposal.created_at).getTime() + 24 * 3600_000)}. Rien n’est enregistré avant votre confirmation.`,
      buttons: [{ label: operation === 'create' ? 'Confirmer la création' : 'Confirmer la modification', action: `confirm_${operation}${kind === 'project' ? '' : `_${kind}`}`, value: proposal.id, style: 'primary' },
        ...(operation === 'edit' || !preview.table ? [{ label: 'Examiner les valeurs', action: 'open_confirmation_values', value: proposal.id }] : [])] };
  }

  private async outcome(actor: Actor, saved: Confirmation, operation: Operation): Promise<AgentMessage> {
    const kind = saved.record_kind, label = recordTitle(kind), presentation = new InventoryPresentation(this.store, actor);
    if (saved.outcome === 'archived') return { kind: 'Restauration nécessaire avant modification', text: `${label} ${literal(await presentation.name(kind, saved.target_id))} est archivé. Restaurez-le explicitement, puis réessayez cette confirmation dans son délai d’origine de 24 heures.` };
    if (!saved.applied_at) return { kind: 'Confirmation expirée', text: kind === 'project' ? `Cette confirmation a expiré. Envoyez une nouvelle demande documentation ${stateLabel(operation)} pour le projet.` : `Envoyez une nouvelle demande documentation ${stateLabel(operation)} ${kind}.` };
    const values = { buttons: outcomeButtons(saved.id), table: await presentation.values(saved.fields) };
    if (kind === 'project' && operation === 'create') return { ...values, kind: 'Projet créé', text: `Projet : ${literal(String(saved.fields.name))}\nOuvrez Détails de la fiche pour consulter la fiche.` };
    if (kind === 'project') return { ...values, kind: saved.outcome === 'missing' ? 'Modification échouée' : saved.outcome === 'satisfied' ? 'Modification déjà satisfaite' : 'Projet modifié', text: `Projet : ${literal(await presentation.name(kind, saved.target_id))}\n${saved.outcome === 'missing' ? 'La cible était indisponible à la confirmation ; aucune modification n’a été appliquée.' : saved.outcome === 'satisfied' ? 'Les champs sélectionnés correspondaient déjà à la confirmation ; aucune modification ni entrée d’historique n’a été ajoutée.' : 'Les remplacements approuvés ont été enregistrés une seule fois. Des modifications ultérieures peuvent avoir changé les valeurs actuelles.'}\nOuvrez Détails de la fiche pour consulter les valeurs actuelles.` };
    return { ...values, kind: saved.outcome === 'missing' || saved.outcome === 'invalid' ? `${label} : échec de l’opération ${stateLabel(operation)}` : saved.outcome === 'satisfied' ? 'Modification déjà satisfaite' : `${label} : ${operation === 'create' ? 'création enregistrée' : 'modification enregistrée'}`,
      text: `${label}: ${literal(await presentation.name(kind, saved.target_id))}\n${saved.outcome === 'missing' || saved.outcome === 'invalid' ? 'La cible, les champs ou les références étaient invalides ou indisponibles à la confirmation. Rien n’a été modifié.' : saved.outcome === 'satisfied' ? 'Les champs sélectionnés correspondaient déjà ; aucune modification ni entrée d’historique n’a été ajoutée.' : 'Les valeurs approuvées ont été enregistrées une seule fois. Des modifications ultérieures peuvent avoir changé les valeurs actuelles.'}\nOuvrez Détails de la fiche pour consulter les valeurs actuelles.` };
  }
}
