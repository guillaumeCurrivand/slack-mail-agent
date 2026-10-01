import { formatDate } from '../../core/presentation.js';
import { stateLabel, sourceLabel } from './presentation.js';
import type { Actor } from '../../core/identity.js';
import type { MenuPage } from '../../core/navigation.js';
import { escapeCardValue, type AgentMessage } from '../../core/slack.js';
import { recordSchemas, recordTitle, recordName, validSavedFields, parseEditRequest, type InventoryRecord, type InventoryValues, type RecordKind } from './domain.js';
import { lifecycleButton, statusText, referenceLabel, outcomeButtons } from './lifecycle.js';
import type { DocumentationStore } from './store.js';
import { InventoryPresentation } from './presentation.js';

const literal = escapeCardValue;
export const catalogHelp = "Consultez documentation technologies [page], documentation technologie <identifiant ou nom exact> et documentation historique technologie <identifiant ou nom exact>. Créez avec documentation créer technologie {\"name\":\"React\",\"category\":\"Interface\",\"notes\":\"Exemple\"}. Modifiez avec documentation modifier technologie <cible> {\"category\":null,\"notes\":\"Remplacement\"}. Champs : name (obligatoire, une ligne, 120 caractères), category (120), notes (1 500). Les champs facultatifs acceptent null (inconnu) ou une valeur vide. Chaque modification exige votre confirmation séparée dans cette conversation privée, sous 24 heures. Seuls les champs choisis sont remplacés, même après des modifications intermédiaires ; les autres champs sont conservés. Aucun appel IA ni Gmail pour les commandes structurées.";
export const componentHelp = "Consultez documentation composants <projet> [page], documentation composant <identifiant ou nom exact> et documentation historique composant <cible>. Créez avec documentation créer composant {\"name\":\"Interface\",\"projectId\":\"<identifiant du projet>\",\"type\":\"interface\",\"technologies\":[\"<technologie existante>\"]}. Champs : name (obligatoire, une ligne, 120 caractères), type (facultatif, 120), technologies (jusqu’à 50 technologies existantes, par identifiant ou nom exact). projectId doit être un identifiant stable de projet ; le parent ne peut pas changer. Modifiez avec documentation modifier composant <cible> {\"type\":\"API\",\"technologies\":null}. null signifie inconnu ; [] signifie aucune technologie. Une référence ambiguë exige un identifiant stable. Créez toute technologie manquante séparément avec confirmation. Les modifications de relations ne créent pas de fiches. Consultez les hébergements avec le bouton Hébergements ou documentation hébergements <composant>. Chaque modification exige votre confirmation séparée dans cette conversation privée, sous 24 heures. Seuls les champs choisis sont remplacés, même après des modifications intermédiaires ; les autres champs sont conservés. Aucun appel IA ni Gmail pour les commandes structurées.";
export const hostHelp = "Consultez documentation hébergeurs [page], documentation hébergeur <cible> et documentation historique hébergeur <cible>. Créez avec documentation créer hébergeur {\"name\":\"OVH\",\"role\":\"Calcul\",\"monthlyCost\":12.5,\"currency\":\"EUR\",\"notes\":\"Exemple\"}. Modifiez avec documentation modifier hébergeur <cible> {\"role\":null,\"monthlyCost\":null}. Champs : name (obligatoire, une ligne, 120 caractères), role (120), monthlyCost (nombre fini de 0 à 1 000 milliards), currency (code de 3 lettres, normalisé en majuscules), notes (1 500). Un coût connu exige une devise ; un coût inconnu ne vaut pas zéro. Le coût appartient au service partagé. Aucune opération auprès d’un fournisseur d’hébergement. Chaque modification exige votre confirmation séparée dans cette conversation privée, sous 24 heures. Seuls les champs choisis sont remplacés, même après des modifications intermédiaires ; les autres champs sont conservés. Aucun appel IA ni Gmail pour les commandes structurées.";
export const hostingHelp = "Consultez documentation hébergements <composant> [page], documentation hébergement <identifiant> et documentation historique hébergement <identifiant>. Créez avec documentation créer hébergement {\"componentId\":\"<identifiant du composant>\",\"serviceId\":\"<hébergeur existant>\",\"environment\":\"production\",\"accountReference\":\"Compte équipe\",\"urls\":[\"https://example.com\"],\"accessInstructions\":\"Voir le gestionnaire de mots de passe\",\"notes\":\"Exemple\"}. Modifiez avec documentation modifier hébergement <identifiant> {\"environment\":\"préproduction\",\"serviceId\":\"<hébergeur existant>\",\"notes\":null}. Le parent componentId est fixe. environment : une ligne, 120 caractères ; serviceId : référence existante requise ; accountReference, accessInstructions et notes : 1 500 caractères chacun ; urls : 10 URL HTTP(S) au maximum, 400 caractères chacune, sans identifiants de connexion. Création et remplacements : 5 000 caractères JSON maximum. Champs facultatifs : null ou valeur vide. Fournissez des références et liens de gestionnaire de mots de passe, jamais des mots de passe ou clés API. Créez tout service manquant séparément avec confirmation ; les références ambiguës exigent un identifiant stable. Chaque modification exige votre confirmation séparée dans cette conversation privée, sous 24 heures. Seuls les champs choisis sont remplacés, même après des modifications intermédiaires ; les autres champs sont conservés. Aucun appel IA ni Gmail pour les commandes structurées.";
export const toolHelp = "Consultez documentation outils [page], documentation outil <cible> et documentation historique outil <cible>. Créez avec documentation créer outil {\"name\":\"Slack\",\"category\":\"Communication\",\"usage\":\"Messagerie équipe\",\"referent\":\"Contact équipe\",\"companyWide\":true,\"projects\":[\"<projet existant>\"],\"notes\":\"Exemple\"}. name est obligatoire : une ligne, 120 caractères ; category : 120 ; usage, referent, notes : 1 500 chacun ; projects : 20 projets existants au maximum, par identifiant, nom exact ou alias. companyWide accepte true, false ou null. Usage pour toute l’entreprise et relations de projets peuvent coexister. Les valeurs omises/null restent inconnues ; les valeurs vides restent vides. Modifiez avec documentation modifier outil <cible> {\"usage\":\"Remplacement\",\"referent\":null}. Création et remplacements : 5 000 caractères JSON maximum. Créez les projets manquants séparément avec confirmation ; le texte d’utilisation ne crée aucune relation. Le référent est descriptif, n’accorde aucun droit et ne reçoit aucune notification. Les métadonnées et l’historique ne sont pas modifiables. Chaque modification exige votre confirmation séparée dans cette conversation privée, sous 24 heures. Seuls les champs choisis sont remplacés, même après des modifications intermédiaires ; les autres champs sont conservés. Aucun appel IA ni Gmail pour les commandes structurées.";
const title = recordTitle;
const helpFor = (kind: RecordKind) => ({ technology: catalogHelp, component: componentHelp, host: hostHelp, hosting: hostingHelp, tool: toolHelp })[kind];
const pluralFor = (kind: RecordKind) => ({ technology: "Technologies", component: "Composants", host: "Hébergeurs/services", hosting: "Hébergements", tool: "Outils" })[kind];
const exampleFor = (kind: RecordKind) => ({ technology: '{"notes":"Replacement"}', component: '{"type":"API","technologies":[]}', host: '{"role":"Compute"}', hosting: '{"environment":"staging","notes":null}', tool: '{"usage":"Replacement","referent":null}' })[kind];
const pages = (prefix: string, page: number, count: number) => [
  ...(page > 0 ? [{ label: "Précédent", page: `${prefix}_${page - 1}` }] : []),
  ...(page + 1 < count ? [{ label: "Suivant", page: `${prefix}_${page + 1}` }] : []),
];
async function pagedLookup<T extends { total: number }>(input: string, lookup: (selector: string) => Promise<T>) {
  let selector = input.trim(), result = await lookup(selector), page = '0';
  // A name ending in digits takes precedence over a trailing page number.
  const paged = /^([\s\S]+)\s+(\d{1,6})$/.exec(selector);
  if (!result.total && paged) { selector = paged[1]!.trim(); page = paged[2]!; result = await lookup(selector); }
  return { selector, result, page };
}
// Catalog navigation shares the Module's existing private menus and transport
// recovery. Every selector is re-read within the actor's workspace.
export class Catalog {
  constructor(private store: DocumentationStore) {}
  private async resolveReferences(actor: Actor, kind: 'project' | 'technology', selectors: string[]): Promise<string[] | AgentMessage> {
    const ids: string[] = [], label = title(kind);
    for (const selector of selectors) {
      const result = kind === 'project' ? await this.store.lookup(actor, selector) : await this.store.lookupRecord(actor, kind, selector);
      if (result.total !== 1) return { kind: result.total ? `Référence ambiguë : ${label}` : `${label} introuvable`,
        text: result.total ? `${label} ${literal(selector)} est ambiguë. Consultez documentation ${kind} ${literal(selector)} et répétez avec un identifiant stable. Rien n’a été proposé.`
          : `${label} ${literal(selector)} est introuvable dans cet espace de travail. Créez cette fiche avec documentation créer ${kind} dans une opération séparée confirmée, puis répétez cette demande. Rien n’a été proposé.` };
      ids.push('projects' in result ? result.projects[0]!.id : result.records[0]!.id);
    }
    return [...new Set(ids)];
  }
  async page(actor: Actor, destination: string): Promise<MenuPage | undefined> {
    const presentation = new InventoryPresentation(this.store, actor);
    if (destination === 'addtechnology') return { kind: "Ajouter une technologie", text: catalogHelp, links: [{ label: "Retour", page: 'technologies_0' }] };
    if (destination === 'addtool') return { kind: "Ajouter un outil", text: toolHelp, links: [{ label: "Retour", page: 'tools_0' }] };
    if (destination === 'addhost') return { kind: "Ajouter un hébergeur/service", text: hostHelp, links: [{ label: "Retour", page: 'hosts_0' }] };
    const addHosting = /^addhosting_([^_]+)$/.exec(destination);
    if (addHosting) {
      const component = await this.store.record(actor, 'component', addHosting[1]!);
      return component ? { kind: "Ajouter un hébergement", text: `Composant : ${literal(recordName(component))} (${component.id})\nUtilisez documentation créer hébergement {\"componentId\":\"${component.id}\",\"serviceId\":\"<hébergeur/service existant>\",\"environment\":\"production\"}\n${hostingHelp}\n${hostHelp}`, links: [{ label: "Retour", page: `hostingentries_${component.id}_0` }] }
        : { kind: "Composant indisponible", text: "Ce composant est introuvable." };
    }
    const addComponent = /^addcomponent_([^_]+)$/.exec(destination);
    if (addComponent) {
      const project = await this.store.project(actor, addComponent[1]!);
      return project ? { kind: "Ajouter un composant", text: `Projet : ${literal(referenceLabel(project.fields.name, project))} (${project.id})\nUtilisez documentation créer composant {\"name\":\"Interface\",\"projectId\":\"${project.id}","type":"frontend","technologies":[]}\n${componentHelp}\n${catalogHelp}`, links: [{ label: "Retour", page: `components_${project.id}_0` }] }
        : { kind: "Projet indisponible", text: "Ce projet est introuvable." };
    }
    const list = /^(technologies|hosts|tools)_(\d{1,6})$/.exec(destination);
    const components = /^(components|techcomponents|hostingentries|hostentries|projecttools)_([^_]+)_(\d{1,6})$/.exec(destination);
    const lookup = /^cataloglookup_([^_]+)_(\d{1,6})$/.exec(destination);
    if (list || lookup || components) {
      const saved = lookup ? await this.store.savedLookup(actor, lookup[1]!) : undefined;
      if (lookup && !saved) return { kind: "Recherche indisponible", text: "Répétez la recherche exacte pour obtenir de nouveaux choix." };
      const kind: RecordKind = saved ? saved.destination.replace(/^history/, '') as RecordKind : list ? (list[1] === 'hosts' ? 'host' : list[1] === 'tools' ? 'tool' : 'technology') : components?.[1] === 'projecttools' ? 'tool' : components?.[1]?.includes('entries') ? 'hosting' : 'component';
      const label = title(kind), plural = pluralFor(kind);
      const parentId = ['components', 'projecttools'].includes(components?.[1] ?? '') ? components![2]! : null;
      const technologyId = components?.[1] === 'techcomponents' ? components[2]! : null;
      const parent = parentId ? await this.store.project(actor, parentId) : undefined;
      const technology = technologyId ? await this.store.record(actor, 'technology', technologyId) : undefined;
      const componentId = components?.[1] === 'hostingentries' ? components[2]! : null;
      const serviceId = components?.[1] === 'hostentries' ? components[2]! : null;
      const component = componentId ? await this.store.record(actor, 'component', componentId) : undefined;
      const service = serviceId ? await this.store.record(actor, 'host', serviceId) : undefined;
      if ((componentId && !component) || (serviceId && !service)) return { kind: "Relations indisponibles", text: "Ce composant ou hébergeur/service est introuvable." };
      if ((parentId && !parent) || (technologyId && !technology)) return { kind: "Relations indisponibles", text: "Ce parent ou cette technologie est introuvable." };
      const result = await this.store.records(actor, kind, Number(list?.[2] ?? lookup?.[2] ?? components?.[3]), saved?.selector ?? null, kind === 'tool' ? null : parentId ?? componentId, kind === 'tool' ? parentId : technologyId ?? serviceId);
      const prefix = saved ? `cataloglookup_${lookup![1]}` : components ? `${components[1]}_${components[2]}` : list![1]!;
      return { kind: saved ? `Choisir une fiche : ${label}` : plural, text: `${saved ? "Ce nom est ambigu. Choisissez une fiche.\n" : ''}${parent ? `Projet : ${literal(referenceLabel(parent.fields.name, parent))}\n` : technology ? `Technologie : ${literal(referenceLabel(String(technology.fields.name), technology))}\n` : ''}page ${result.page + 1}/${result.pages} · ${result.total} ${plural}\n${result.records.length ? '' : `Aucune fiche : ${plural} enregistrée.`}`,
        ...await presentation.list(result.records, result.records.map(record => saved?.destination.startsWith('history') ? `history${kind}_${record.id}_0` : `${kind}_${record.id}`)),
        links: [
          ...pages(prefix, result.page, result.pages), ...(kind === 'technology' ? [{ label: "Ajouter une technologie", page: 'addtechnology' }] : kind === 'tool' ? [{ label: "Ajouter un outil", page: 'addtool' }] : kind === 'host' ? [{ label: "Ajouter un hébergeur/service", page: 'addhost' }] : parent ? [{ label: "Ajouter un composant", page: `addcomponent_${parent.id}` }] : component ? [{ label: "Ajouter un hébergement", page: `addhosting_${component.id}` }] : []),
          { label: "Retour", page: parent ? `project_${parent.id}` : technology ? `technology_${technology.id}` : component ? `component_${component.id}` : service ? `host_${service.id}` : 'main' }] };
    }
    const detail = /^(technology|component|host|hosting|tool|edittechnology|editcomponent|edithost|edithosting|edittool)_([^_]+)$/.exec(destination);
    const history = /^history(technology|component|host|hosting|tool)_([^_]+)_(\d{1,6})$/.exec(destination);
    if (detail || history) {
      const kind = (history?.[1] ?? detail![1]!.replace(/^edit/, '')) as RecordKind, label = title(kind);
      const id = detail?.[2] ?? history![2]!;
      const record = await this.store.record(actor, kind, id);
      if (!record) return { kind: `${label} indisponible`, text: `Cette fiche ${label} est introuvable.`, links: [{ label: "Retour", page: 'main' }] };
      if (detail?.[1]?.startsWith('edit') && record.archived) return { kind: "Restauration nécessaire avant modification", text: `${label}: ${literal(await presentation.name(kind, id))}\nÉtat : archivé\nRestaurez explicitement cette fiche avant de la modifier.`, buttons: lifecycleButton(kind, record), links: [{ label: `Retour à ${label}`, page: `${kind}_${id}` }] };
      if (detail?.[1]?.startsWith('edit')) return { kind: `Modifier ${label}`, text: `${label}: ${literal(recordName(record))} (${id})\nUtilisez documentation modifier ${kind} ${id} ${exampleFor(kind)}\n${helpFor(kind)}`, links: [{ label: `Retour à ${label}`, page: `${kind}_${id}` }] };
      if (history) {
        const result = await this.store.recordHistory(actor, kind, id, Number(history[3]));
        const change = result.changes[0];
        return { kind: `Historique — ${label}`, ...(change ? { table: await presentation.values(change.after_values, change.before_values) } : {}), text: `${label}: ${literal(await presentation.name(kind, id))}\n${statusText(record)}\nHistorique — page ${result.page + 1}/${result.pages}\n${change ? `Auteur : ${literal(change.actor)}\nDate : ${formatDate(change.changed_at)}\nSource : ${literal(sourceLabel(change.source))}\n${change.before_values === null ? "Avant : aucune fiche" : ''}` : "Aucune modification n’a été enregistrée."}`,
          links: [...pages(`history${kind}_${id}`, result.page, result.pages), { label: `Retour à ${label}`, page: `${kind}_${id}` }] };
      }
      const technologies = kind === 'component' && Array.isArray(record.fields.technologies)
        ? await Promise.all(record.fields.technologies.map(ref => this.store.record(actor, 'technology', ref))) : [];
      const service = kind === 'hosting' ? await this.store.record(actor, 'host', String(record.fields.serviceId)) : undefined;
      const projects = kind === 'tool' && Array.isArray(record.fields.projects)
        ? await Promise.all(record.fields.projects.map(ref => this.store.project(actor, ref))) : [];
      const details = await presentation.details(record.fields);
      return { kind: label, ...details, text: `${label}: ${literal(await presentation.name(kind, id))}\n${statusText(record)}\n${details.text}`,
        buttons: lifecycleButton(kind, record),
        links: [...(!record.archived ? [{ label: "Modifier", page: `edit${kind}_${id}` }] : []), { label: "Historique", page: `history${kind}_${id}_0` },
        ...(kind === 'tool' ? [...projects.filter(ref => !!ref).map(ref => ({ label: referenceLabel(ref.fields.name, ref), page: `project_${ref.id}` })), { label: "Retour aux outils", page: 'tools_0' }] : kind === 'host' ? [{ label: "Hébergements", page: `hostentries_${id}_0` }, { label: "Retour aux hébergeurs/services", page: 'hosts_0' }] :
          kind === 'hosting' ? [{ label: "Composant", page: `component_${record.fields.componentId}` }, ...(service ? [{ label: referenceLabel(recordName(service), service), page: `host_${service.id}` }] : []), { label: "Retour aux hébergements", page: `hostingentries_${record.fields.componentId}_0` }] :
          kind === 'technology' ? [{ label: "Composants", page: `techcomponents_${id}_0` }, { label: "Retour aux technologies", page: 'technologies_0' }] : [
          { label: "Hébergements", page: `hostingentries_${id}_0` },
          { label: "Projet", page: `project_${record.fields.projectId}` }, ...technologies.filter(ref => !!ref).map(ref => ({ label: referenceLabel(String(ref.fields.name), ref), page: `technology_${ref.id}` })),
          { label: "Retour aux composants", page: `components_${record.fields.projectId}_0` },
        ])] };
    }
    return undefined;
  }
  async handle(actor: Actor, payload: Record<string, unknown>, eventId: string,
    deliver: (message: AgentMessage) => Promise<void>, show: (destination: string) => Promise<void>, source = 'Slack structured'): Promise<boolean> {
    const presentation = new InventoryPresentation(this.store, actor);
    const action = /^confirm_(create|edit)_(technology|component|host|hosting|tool)$/.exec(String(payload.action));
    if (payload.type === 'action' && action) {
      const operation = action[1] as 'create' | 'edit', kind = action[2] as RecordKind, label = title(kind);
      const saved = typeof payload.value === 'string' ? await this.store.confirmRecord(actor, payload.value, kind, operation) : undefined;
      if (!saved || saved.record_kind !== kind || saved.operation !== operation) await deliver({ kind: "Confirmation indisponible", text: "Cette confirmation est indisponible ou n’appartient pas à cet utilisateur et à cette conversation privée." });
      else if (saved.outcome === 'archived') await deliver({ kind: "Restauration nécessaire avant modification", text: `${label} ${literal(await presentation.name(kind, saved.target_id))} est archivé. Restaurez-le explicitement, puis réessayez cette confirmation dans son délai d’origine de 24 heures.` });
      else if (!saved.applied_at) await deliver({ kind: "Confirmation expirée", text: `Envoyez une nouvelle demande documentation ${stateLabel(operation)} ${kind}.` });
      else await deliver({ kind: saved.outcome === 'missing' || saved.outcome === 'invalid' ? `${label} : échec de l’opération ${stateLabel(operation)}` : saved.outcome === 'satisfied' ? "Modification déjà satisfaite" : `${label} : ${operation === 'create' ? 'création enregistrée' : 'modification enregistrée'}`,
        buttons: outcomeButtons(saved.id),
        table: await presentation.values(saved.fields), text: `${label}: ${literal(await presentation.name(kind, saved.target_id))}\n${saved.outcome === 'missing' || saved.outcome === 'invalid' ? "La cible, les champs ou les références étaient invalides ou indisponibles à la confirmation. Rien n’a été modifié." : saved.outcome === 'satisfied' ? "Les champs sélectionnés correspondaient déjà ; aucune modification ni entrée d’historique n’a été ajoutée." : "Les valeurs approuvées ont été enregistrées une seule fois. Des modifications ultérieures peuvent avoir changé les valeurs actuelles."}\nOuvrez Détails de la fiche pour consulter les valeurs actuelles.` });
      return true;
    }
    if (payload.type !== 'text') return false;
    const text = String(payload.text ?? '').trim();
    const mutation = /^(create|edit) (technology|component|host|hosting|tool)\s+([\s\S]+)$/i.exec(text);
    if (mutation) {
      const operation = mutation[1]!.toLowerCase();
      const kind = mutation[2]!.toLowerCase() as RecordKind, label = title(kind);
      let proposal = await this.store.request(actor, eventId);
      if (!proposal) {
        let fields: InventoryValues, target: InventoryRecord | undefined, selector: string | undefined;
        try {
          if (operation === 'create') fields = recordSchemas[kind].create.parse(JSON.parse(mutation[3]!));
          else {
            const request = parseEditRequest(mutation[3]!); fields = recordSchemas[kind].edit.parse(request.value); selector = request.selector;
          }
        } catch { await deliver({ kind: `Valeur invalide : ${label}${operation === 'edit' ? ' — modification' : ''}`, text: `Choisissez une fiche et un objet JSON valide de champs autorisés.\n${helpFor(kind)}` }); return true; }
        if (selector !== undefined) {
          const result = await this.store.lookupRecord(actor, kind, selector);
          if (result.total !== 1) {
            await deliver({ kind: result.total ? `Référence ambiguë : ${label} — modification` : `${label} introuvable`, text: result.total ? `Consultez documentation ${kind} <nom exact> et répétez avec un identifiant stable. Rien n’a été proposé.` : `Aucune fiche : ${label} ne correspond exactement à cet identifiant ou nom.` }); return true;
          }
          target = result.records[0]!;
          if (target.archived) { await deliver({ kind: "Restauration nécessaire avant modification", text: `Cette fiche ${label} est archivée. Restaurez-la explicitement avant de la modifier.` }); return true; }
        }
        for (const [field, referenceKind] of [['projects', 'project'], ['technologies', 'technology']] as const) {
          if (!Array.isArray(fields[field])) continue;
          const resolved = await this.resolveReferences(actor, referenceKind, fields[field]);
          if (!Array.isArray(resolved)) { await deliver(resolved); return true; }
          fields[field] = resolved;
        }
        if (kind === 'component') {
          if (operation === 'create' && !await this.store.project(actor, String(fields.projectId))) {
            await deliver({ kind: "Projet introuvable", text: "Utilisez l’identifiant d’un projet existant dans cet espace. Créez un projet manquant dans une opération séparée confirmée." }); return true;
          }
        }
        if (kind === 'hosting') {
          if (operation === 'create' && !await this.store.record(actor, 'component', String(fields.componentId))) {
            await deliver({ kind: "Composant introuvable", text: "Utilisez l’identifiant d’un composant existant dans cet espace. Créez un composant manquant dans une opération séparée confirmée." }); return true;
          }
          if (typeof fields.serviceId === 'string') {
            const result = await this.store.lookupRecord(actor, 'host', fields.serviceId);
            if (result.total !== 1) {
              await deliver({ kind: result.total ? "Référence d’hébergeur/service ambiguë" : "Hébergeur/service introuvable", text: result.total ? "Consultez documentation hébergeur <nom exact> et répétez avec un identifiant stable. Rien n’a été proposé." : "Créez l’hébergeur/service manquant avec documentation créer hébergeur dans une opération séparée confirmée, puis répétez cette demande. Rien n’a été proposé." }); return true;
            }
            fields.serviceId = result.records[0]!.id;
          }
        }
        if (kind === 'host' && !recordSchemas.host.create.safeParse({ ...target?.fields, ...fields }).success) {
          await deliver({ kind: "Modification d’hébergeur/service invalide", text: `Un coût mensuel connu nécessite une devise explicite.\n${hostHelp}` }); return true;
        }
        if (!validSavedFields(kind, operation as 'create' | 'edit', fields)) {
          await deliver({ kind: `Valeur invalide : ${label}${operation === 'edit' ? ' — modification' : ''}`, text: `Les champs normalisés et les identifiants résolus dépassent les contraintes autorisées.\n${helpFor(kind)}` }); return true;
        }
        try { proposal = await this.store.proposeRecord(actor, eventId, kind, fields, target, source); }
        catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("La cible ou les références d’inventaire ont changé")) throw error;
          await deliver({ kind: "Relations indisponibles", text: error.message }); return true;
        }
      }
      const preview = await presentation.confirmation(proposal);
      const name = operation === 'create' ? recordName({ fields: proposal.fields } as InventoryRecord) : await presentation.name(kind, proposal.target_id);
      await deliver({ ...preview, kind: `${operation === 'create' ? "Créer" : "Modifier"} ${label} — confirmation`, text: `${operation === 'create' ? "Créer" : "Modifier"} partagé — ${label}: ${literal(name)}\n${preview.text}\nSeuls les champs approuvés changent ; les modifications intermédiaires sont remplacées et les autres champs sont conservés. Vous seul pouvez confirmer dans cette conversation privée. Expiration : ${formatDate(new Date(proposal.created_at).getTime() + 24 * 3600_000)}. Rien n’est enregistré avant votre confirmation.`, buttons: [{ label: operation === 'create' ? "Confirmer la création" : "Confirmer la modification", action: `confirm_${operation}_${kind}`, value: proposal.id, style: 'primary' }, ...(operation === 'edit' || !preview.table ? [{ label: "Examiner les valeurs", action: 'open_confirmation_values', value: proposal.id }] : [])] });
      return true;
    }
    const list = /^(technologies|hosts|tools)(?:\s+(\d{1,6}))?$/i.exec(text);
    if (list) { await show(`${list[1]!.toLowerCase()}_${list[2] ?? '0'}`); return true; }
    const hosting = /^hosting\s+([\s\S]+)$/i.exec(text);
    if (hosting) {
      const { result, page } = await pagedLookup(hosting[1]!, selector => this.store.lookupRecord(actor, 'component', selector));
      if (result.total === 1) await show(`hostingentries_${result.records[0]!.id}_${page}`);
      else if (result.total > 1) await deliver({ kind: "Composant ambigu", text: "Consultez documentation composant <nom exact> et répétez avec un identifiant stable." });
      else await deliver({ kind: "Composant introuvable", text: "Aucun composant ne correspond exactement à cet identifiant ou nom." });
      return true;
    }
    const components = /^components\s+([\s\S]+)$/i.exec(text);
    if (components) {
      const { selector, result, page } = await pagedLookup(components[1]!, selector => this.store.lookup(actor, selector));
      if (result.total === 1) await show(`components_${result.projects[0]!.id}_${page}`);
      else if (result.total > 1) await show(`lookup_${await this.store.saveLookup(actor, eventId, selector, 'components')}_0`);
      else await deliver({ kind: "Projet introuvable", text: "Aucun projet ne correspond exactement à cet identifiant, nom ou alias." });
      return true;
    }
    const lookup = /^(technology|component|host|tool|hosting-entry|history technology|history component|history host|history tool|history hosting-entry)\s+([\s\S]+)$/i.exec(text);
    if (lookup) {
      const destination = lookup[1]!.toLowerCase().replace(' ', '').replace('hosting-entry', 'hosting'), kind = (destination.replace(/^history/, '')) as RecordKind;
      const selector = lookup[2]!.trim(), result = await this.store.lookupRecord(actor, kind, selector);
      if (result.total === 1) await show(`${destination}_${result.records[0]!.id}${destination.startsWith('history') ? '_0' : ''}`);
      else if (result.total > 1) await show(`cataloglookup_${await this.store.saveLookup(actor, eventId, selector, destination)}_0`);
      else await deliver({ kind: `${title(kind)} introuvable`, text: `Aucune fiche : ${title(kind)} ne correspond exactement à cet identifiant ou nom.` });
      return true;
    }
    return false;
  }
}
