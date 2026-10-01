import { formatDate } from '../../core/presentation.js';
import { stateLabel, sourceLabel } from './presentation.js';
import type { Actor } from '../../core/identity.js';
import type { AssistantModule, ModuleContext } from '../../core/modules.js';
import { Navigation, type MenuPage } from '../../core/navigation.js';
import { escapeCardValue, menuButton, SlackDeliveryRejected, type AgentMessage } from '../../core/slack.js';
import type { Sql } from '../../core/store.js';
import { projectEdit, projectFields, parseEditRequest, recordTitle, type ProjectFields, type ProjectEdit, type RecordKind } from './domain.js';
import { documentationSchema, DocumentationStore } from './store.js';
import { documentationImportSchema } from './import.js';
import { Lifecycle, lifecycleHelp, lifecycleButton, statusText, referenceLabel, outcomeButtons } from './lifecycle.js';
import { Catalog, catalogHelp, componentHelp, hostHelp, hostingHelp, toolHelp } from './catalog.js';
import { readDocumentationAIConfig, type QuestionAIConfig } from './ai.js';
import { DocumentationQuestions, questionSchema } from './questions.js';
import { inventoryQueryHelp } from './inventory-query.js';
import { InventoryPresentation, tableSize, valuePages } from './presentation.js';

const literal = (value: string) => escapeCardValue(value);
const questionHelp = "Questions en langage naturel : documentation où Alpha est-il hébergé ? ; documentation quelles technologies utilise ce projet ? ; documentation quels projets utilisent React et OVH sur leurs composants ? ; documentation combien de projets utilisent React ? ; documentation quels outils sont utilisés par toute l’entreprise ? L’interprétation utilise le budget IA partagé ; ouvrir les fiches et parcourir les résultats est gratuit. Le contexte de projet est privé et expire après 30 minutes. Modifications : documentation crée un projet nommé Alpha ; documentation remplace la description de ce projet par Application équipe ; documentation archive l’outil Tracker. Décrivez une seule fiche et des valeurs explicites. Les références doivent correspondre exactement. Rien ne change avant votre confirmation séparée." + "\n" + inventoryQueryHelp;
const help = "Consultez documentation projets [page] (première page : 0), documentation projet <identifiant, nom exact ou alias> et documentation historique [cible]. Créez avec documentation créer projet {\"name\":\"Alpha\",\"aliases\":[\"A\"],\"description\":\"Exemple\",\"repositories\":[\"https://example.com/repo\"],\"documentationLinks\":[\"https://example.com/docs\"],\"notes\":\"Exemple\"}. Seul name est obligatoire ; les champs omis restent inconnus. Noms et alias : une ligne, 120 caractères, jusqu’à 20 alias ; description et notes : 1 500 chacun ; chaque liste de liens : 10 URL HTTP(S) au maximum, 400 caractères chacune, sans identifiants de connexion. Création ou remplacements : 5 000 caractères JSON maximum. Modifiez avec documentation modifier projet <cible> {\"description\":\"Remplacement\",\"notes\":null}. Champs autorisés : name, aliases, description, repositories, documentationLinks, notes. Seuls les champs fournis changent ; null rend un champ facultatif inconnu. Le nom ne peut pas être effacé. Identifiants système, historique et état d’archivage ne sont pas modifiables. Les demandes en langage naturel utilisent le budget IA partagé et la même confirmation. L’import est un outil opérateur hors ligne. Chaque modification exige votre confirmation séparée dans cette conversation privée, sous 24 heures. Seuls les champs choisis sont remplacés, même après des modifications intermédiaires ; les autres champs sont conservés. Aucun appel IA ni Gmail pour les commandes structurées.";
const recordPage = (destination: string, id: string) => `${destination}_${id}${['history', 'components'].includes(destination) ? '_0' : ''}`;
const pageLinks = (prefix: string, page: number, pages: number) => [
  ...(page > 0 ? [{ label: "Précédent", page: `${prefix}_${page - 1}` }] : []),
  ...(page + 1 < pages ? [{ label: "Suivant", page: `${prefix}_${page + 1}` }] : []),
];
function editRequest(text: string): { selector: string; fields: ProjectEdit } {
  const request = parseEditRequest(text.replace(/^edit project\s+/i, ''));
  return { selector: request.selector, fields: projectEdit.parse(request.value) };
}

export function createDocumentationModule(sql: Sql, aiConfig: QuestionAIConfig = readDocumentationAIConfig({})): AssistantModule {
  const store = new DocumentationStore(sql);
  const catalog = new Catalog(store);
  const lifecycle = new Lifecycle(store);
  const questions = new DocumentationQuestions(sql, aiConfig);
  async function deliver(actor: Actor, eventId: string, message: AgentMessage, context: ModuleContext) {
    if (message.table && tableSize(message.table) > 8500) {
      const confirmation = message.buttons?.find(button => button.action === 'open_confirmation_record' || button.action.startsWith('confirm_'))?.value;
      if (!confirmation) throw new Error('Large inventory values require a saved review destination.');
      message = { ...message, table: undefined, text: `${message.text}\nLes valeurs enregistrées occupent plusieurs pages. Ouvrez Examiner les valeurs pour les consulter.`, buttons: [...(message.buttons ?? []), { label: "Examiner les valeurs", action: 'open_confirmation_values', value: confirmation }] };
    }
    if (!await store.claimDelivery(actor, eventId)) return;
    try { await context.messenger.send(actor, { ...message, buttons: [...(message.buttons ?? []), menuButton] }); }
    catch (error) { if (error instanceof SlackDeliveryRejected) await store.releaseDelivery(actor, eventId); throw error; }
  }
  async function page(actor: Actor, destination: string): Promise<MenuPage> {
    const part = /^content_(\d{1,6})_(.+)$/.exec(destination);
    const target = part?.[2] ?? destination;
    const content = await recordContent(actor, target);
    // Independent edits can grow a Project beyond creation's single-Card limit.
    // Split only between lines so escaping and exact field values remain intact.
    const chunks = valuePages(content);
    if (chunks.length === 1) return content;
    const index = Math.min(Number(part?.[1] ?? 0), chunks.length - 1);
    return { ...chunks[index]!, text: `Valeurs — page ${index + 1}/${chunks.length}\n${chunks[index]!.text}`, links: [
      ...(index > 0 ? [{ label: "Valeurs précédentes", page: `content_${index - 1}_${target}` }] : []),
      ...(index + 1 < chunks.length ? [{ label: "Valeurs suivantes", page: `content_${index + 1}_${target}` }] : []),
      ...(content.links ?? []),
    ] };
  }
  async function recordContent(actor: Actor, destination: string): Promise<MenuPage> {
    const presentation = new InventoryPresentation(store, actor);
    const confirmation = /^confirmation_([^_]+)$/.exec(destination);
    if (confirmation) {
      const saved = await store.confirmation(actor, confirmation[1]!);
      const table = saved ? await presentation.values(saved.fields, saved.operation === 'edit' ? saved.before_values : undefined, true) : undefined;
      if (table && saved?.operation === 'edit' && saved.before_values === null) table.rows = table.rows.map(row => [row[0]!, "Indisponible (valeurs d’origine non enregistrées)", row[2]!]);
      const targetName = saved?.operation === 'create' ? String(saved.fields.name ?? saved.fields.environment ?? "Environnement inconnu") || "Environnement vide" : saved ? await presentation.name(saved.record_kind, saved.target_id) : '';
      return saved ? { kind: `${saved.operation === 'create' ? "Créer" : "Modifier"} — valeurs de la confirmation`, table, text: `${recordTitle(saved.record_kind)}: ${literal(targetName)}\n${saved.operation === 'edit' && saved.before_values === null ? "Indisponible pour cette ancienne confirmation ; les valeurs d’origine n’ont pas été enregistrées.\n" : ''}Ces valeurs proviennent de la proposition enregistrée ; les valeurs actuelles peuvent différer. Confirmez depuis la confirmation d’origine. Expiration : ${formatDate(new Date(saved.created_at).getTime() + 24 * 3600_000)}.` }
        : { kind: "Confirmation indisponible", text: "Cette confirmation est indisponible ou n’appartient pas à cet utilisateur et à cette conversation privée." };
    }
    const answer = await questions.page(actor, destination);
    if (answer) return answer;
    const lifecyclePage = await lifecycle.page(actor, destination);
    if (lifecyclePage) return lifecyclePage;
    const catalogPage = await catalog.page(actor, destination);
    if (catalogPage) return catalogPage;
    if (destination === 'help' || destination === 'add') return { kind: destination === 'add' ? "Ajouter un projet" : "Aide de Documentation", text: `${help}\n${questionHelp}\n${lifecycleHelp}\n${catalogHelp}\n${componentHelp}\n${hostHelp}\n${hostingHelp}\n${toolHelp}`, links: [{ label: "Retour", page: 'main' }] };
    const list = /^projects_(\d{1,6})$/.exec(destination), lookup = /^lookup_([^_]+)_(\d{1,6})$/.exec(destination);
    if (list || lookup) {
      const saved = lookup ? await store.savedLookup(actor, lookup[1]!) : undefined;
      if (lookup && !saved) return { kind: "Recherche indisponible", text: "Répétez la recherche exacte pour obtenir un nouveau choix.", links: [{ label: "Projets", page: 'projects_0' }] };
      const { projects, total, page, pages } = await store.projects(actor, Number(list?.[1] ?? lookup?.[2] ?? 0), saved?.selector ?? null);
      const prefix = saved ? `lookup_${lookup![1]}` : 'projects';
      return { kind: saved ? "Choisir un projet" : "Projets", text: `${saved ? "Cette recherche est ambiguë. Choisissez un projet.\n" : ''}page ${page + 1}/${pages} · ${total} projets\n${projects.length ? '' : "Aucun projet n’a été enregistré."}`,
        ...await presentation.list(projects.map(project => ({ ...project, kind: 'project' as const })), projects.map(project => recordPage(saved?.destination ?? 'project', project.id))),
        links: [...pageLinks(prefix, page, pages), { label: "Ajouter un projet", page: 'add' }, { label: "Retour", page: 'main' }] };
    }
    const hostingPage = /^projecthosting_([^_]+)_(\d{1,6})$/.exec(destination);
    if (destination.startsWith('project_') || hostingPage) {
      const project = await store.project(actor, hostingPage?.[1] ?? destination.slice(8));
      if (!project) return { kind: "Projet indisponible", text: "Ce projet est introuvable.", links: [{ label: "Projets", page: 'projects_0' }] };
      await questions.remember(actor, project.id);
      const hosting = hostingPage ? await store.projectHosting(actor, project.id, Number(hostingPage[2])) : undefined;
      const view = hosting
        ? await presentation.list(hosting.entries.filter(entry => entry.fields && entry.hosting_id).map(entry => ({ id: entry.hosting_id!, kind: 'hosting' as const, fields: entry.fields!, archived: !!entry.hosting_archived })))
        : await presentation.details(project.fields);
      const missing = hosting?.entries.filter(entry => !entry.hosting_id) ?? [];
      return { ...view, kind: hosting ? "Hébergements du projet" : "Projet", text: `Projet : ${literal(project.fields.name)}\n${statusText(project)}\n${hosting ? `Hébergements — page ${hosting.page + 1}/${hosting.pages}\n${!hosting.entries.length ? "Composants : inconnus\nHébergements : inconnus" : missing.map(entry => `Composant : ${literal(entry.component_name)}\nHébergements : inconnus`).join('\n')}` : ('text' in view ? view.text : '')}`,
        buttons: lifecycleButton('project', project),
        links: [...(hosting ? pageLinks(`projecthosting_${project.id}`, hosting.page, hosting.pages) : [{ label: "Hébergements", page: `projecthosting_${project.id}_0` }]),
          ...missing.map(entry => ({ label: `Composant : ${entry.component_name}`, page: `component_${entry.component_id}` })),
          ...(!project.archived ? [{ label: "Modifier", page: `edit_${project.id}` }] : []), { label: "Composants", page: `components_${project.id}_0` }, { label: "Outils", page: `projecttools_${project.id}_0` }, { label: "Historique", page: `history_${project.id}_0` }, { label: "Retour aux projets", page: 'projects_0' }] };
    }
    if (destination.startsWith('edit_')) {
      const project = await store.project(actor, destination.slice(5));
      if (!project) return { kind: "Projet indisponible", text: "Ce projet est introuvable.", links: [{ label: "Projets", page: 'projects_0' }] };
      if (project.archived) return { kind: "Restauration nécessaire avant modification", text: `Projet : ${literal(project.fields.name)}\nÉtat : archivé\nRestaurez explicitement ce projet avant de le modifier.`, buttons: lifecycleButton('project', project), links: [{ label: "Retour au projet", page: `project_${project.id}` }] };
      return { kind: "Modifier le projet", text: `Projet : ${literal(project.fields.name)} (${project.id})\nUtilisez documentation modifier projet ${project.id} {\"description\":\"Remplacement\",\"notes\":null}\n${help}`, links: [{ label: "Retour au projet", page: `project_${project.id}` }] };
    }
    if (destination.startsWith('history_') || destination.startsWith('sharedhistory_')) {
      const shared = /^sharedhistory_(\d{1,6})$/.exec(destination);
      const match = /^history_([^_]+)_(\d{1,6})$/.exec(destination);
      const id = match?.[1] ?? null, project = id ? await store.project(actor, id) : undefined;
      if (!shared && !project) return { kind: "Historique indisponible", text: "Ce projet est introuvable.", links: [{ label: "Projets", page: 'projects_0' }] };
      const { changes, page, pages } = await store.history(actor, id, Number(match?.[2] ?? shared?.[1] ?? 0));
      const change = changes[0];
      return { kind: shared ? "Historique partagé" : "Historique du projet", ...(change ? { table: await presentation.values(change.after_values, change.before_values) } : {}), text: `${project ? `Projet : ${literal(project.fields.name)}\n${statusText(project)}\n` : ''}Historique — page ${page + 1}/${pages}\n${change ? `${recordTitle(change.record_kind)}: ${literal(await presentation.name(change.record_kind, change.project_id))}\nAuteur : ${literal(change.actor)}\nDate : ${formatDate(change.changed_at)}\nSource : ${literal(sourceLabel(change.source))}\n${change.before_values === null ? "Avant : aucune fiche" : ''}` : "Aucune modification n’a été enregistrée."}`, links: [...pageLinks(shared ? 'sharedhistory' : `history_${id}`, page, pages), ...(shared ? [...changes.map(change => ({ label: "Détails de la fiche", page: `${change.record_kind}_${change.project_id}` })), { label: "Retour", page: 'main' }] : [{ label: "Retour au projet", page: `project_${id}` }])] };
    }
    return { kind: 'Documentation', text: "Créez, modifiez et consultez les projets, technologies, composants, hébergeurs/services, hébergements et outils partagés. Commencez chaque demande par documentation. La consultation et les modifications structurées n’utilisent pas d’IA.",
      links: [{ label: "Projets", page: 'projects_0' }, { label: "Ajouter un projet", page: 'add' }, { label: "Technologies", page: 'technologies_0' }, { label: "Hébergeurs/services", page: 'hosts_0' }, { label: "Outils", page: 'tools_0' }, { label: "Archivé", page: 'archived_0' }, { label: "Historique", page: 'sharedhistory_0' }, { label: "Aide", page: 'help' }] };
  }
  return {
    menuActions: ['request_archive', 'request_restore'],
    id: 'documentation', name: 'Documentation', description: "Créer, modifier et consulter l’inventaire partagé et son historique",
    initialize: async database => { await database.query(documentationSchema + questionSchema + documentationImportSchema); },
    cleanup: async () => { await store.cleanup(); await questions.cleanup(); },
    menu: (actor, destination) => page(actor, destination),
    async handle(actor, payload, eventId, context) {
      const presentation = new InventoryPresentation(store, actor);
      const source = await questions.source(actor, eventId);
      const navigation = new Navigation(context.sql, context.messenger);
      const show = async (destination: string) => {
        const content = await page(actor, destination);
        await navigation.show(actor, eventId, { ...content, recordChoices: content.recordChoices?.map(link => ({ ...link, page: `documentation:${link.page}` })), links: [...(content.links ?? []).map(link => ({ ...link, page: `documentation:${link.page}` })), { label: "Retour au menu", page: 'main' }] });
      };
      const interpret = async (text: string) => {
        const result = await questions.ask(actor, text, eventId, context);
        if (typeof result !== 'string' && 'command' in result) return this.handle(actor, { type: 'text', text: result.command }, eventId, context);
        return typeof result === 'string' ? show(result) : deliver(actor, eventId, result, context);
      };
      if (payload.type === 'action' && payload.action === 'open_confirmation_values') {
        const saved = typeof payload.value === 'string' ? await store.confirmation(actor, payload.value) : undefined;
        if (!saved) return deliver(actor, eventId, { kind: "Confirmation indisponible", text: "Cette confirmation est indisponible ou n’appartient pas à cet utilisateur et à cette conversation privée." }, context);
        return show(`confirmation_${saved.id}`);
      }
      if (payload.type === 'action' && ['open_confirmation_record', 'open_confirmation_history'].includes(String(payload.action))) {
        const saved = typeof payload.value === 'string' ? await store.confirmation(actor, payload.value) : undefined;
        if (!saved?.applied_at) return deliver(actor, eventId, { kind: "Résultat indisponible", text: "Ce résultat enregistré est privé à son utilisateur et à sa conversation, ou indisponible." }, context);
        const history = payload.action === 'open_confirmation_history';
        return show(history ? `${saved.record_kind === 'project' ? 'history' : `history${saved.record_kind}`}_${saved.target_id}_0` : `${saved.record_kind}_${saved.target_id}`);
      }
      if (payload.type === 'action' && payload.action === 'choose_question_project') {
        const result = await questions.choose(actor, payload);
        return typeof result === 'string' ? show(result) : deliver(actor, eventId, result, context);
      }
      const lifecycleText = payload.type === 'text' ? /^(archive|restore) (project|technology|component|host|hosting|hosting-entry|tool)\s+([\s\S]+)$/i.exec(String(payload.text)) : null;
      let conversationalLifecycle = false;
      if (lifecycleText && /^(?:this project|it)$|^(?:named|called)\s+/i.test(lifecycleText[3]!.trim())) {
        const kind = lifecycleText[2]!.toLowerCase().replace('hosting-entry', 'hosting') as 'project' | RecordKind;
        const exact = kind === 'project' ? await store.lookup(actor, lifecycleText[3]!.trim()) : await store.lookupRecord(actor, kind, lifecycleText[3]!.trim());
        conversationalLifecycle = exact.total === 0;
      }
      if (payload.type === 'text' && ((/^(create|edit) (project|technology|component|host|hosting|tool)\s/i.test(String(payload.text)) && !/[{[]/.test(String(payload.text)))
        || conversationalLifecycle)) {
        return interpret(String(payload.text));
      }
      if (await lifecycle.handle(actor, payload, eventId, navigation, message => deliver(actor, eventId, message, context), show, source)) return;
      if (await catalog.handle(actor, payload, eventId, message => deliver(actor, eventId, message, context), show, source)) return;
      if (payload.type === 'action' && ['confirm_create', 'confirm_edit'].includes(String(payload.action))) {
        const operation = payload.action === 'confirm_edit' ? 'edit' : 'create';
        const saved = typeof payload.value === 'string' ? await (operation === 'edit' ? store.confirmEdit(actor, payload.value) : store.confirm(actor, payload.value)) : undefined;
        if (!saved || saved.record_kind !== 'project' || saved.operation !== operation) return deliver(actor, eventId, { kind: "Confirmation indisponible", text: "Cette confirmation est indisponible ou n’appartient pas à cet utilisateur et à cette conversation privée." }, context);
        if (saved.outcome === 'archived') return deliver(actor, eventId, { kind: "Restauration nécessaire avant modification", text: `Projet ${literal(await presentation.name('project', saved.target_id))} est archivé. Restaurez-le explicitement, puis réessayez cette confirmation dans son délai d’origine de 24 heures.` }, context);
        if (!saved.applied_at) return deliver(actor, eventId, { kind: "Confirmation expirée", text: `Cette confirmation a expiré. Envoyez une nouvelle demande documentation ${stateLabel(operation)} pour le projet.` }, context);
        if (operation === 'edit') return deliver(actor, eventId, { kind: saved.outcome === 'missing' ? "Modification échouée" : saved.outcome === 'satisfied' ? "Modification déjà satisfaite" : "Projet modifié", buttons: outcomeButtons(saved.id), table: await presentation.values(saved.fields), text: `Projet : ${literal(await presentation.name('project', saved.target_id))}\n${saved.outcome === 'missing' ? "La cible était indisponible à la confirmation ; aucune modification n’a été appliquée." : saved.outcome === 'satisfied' ? "Les champs sélectionnés correspondaient déjà à la confirmation ; aucune modification ni entrée d’historique n’a été ajoutée." : "Les remplacements approuvés ont été enregistrés une seule fois. Des modifications ultérieures peuvent avoir changé les valeurs actuelles."}\nOuvrez Détails de la fiche pour consulter les valeurs actuelles.` }, context);
        return deliver(actor, eventId, { kind: "Projet créé", buttons: outcomeButtons(saved.id), table: await presentation.values(saved.fields), text: `Projet : ${literal(String(saved.fields.name))}\nOuvrez Détails de la fiche pour consulter la fiche.` }, context);
      }
      if (payload.type !== 'text') return deliver(actor, eventId, { kind: "Aide de Documentation", text: help }, context);
      const text = String(payload.text ?? '').trim();
      const query = /^(search|count)\s+([\s\S]+)$/i.exec(text);
      if (query) {
        let value: unknown;
        try { value = JSON.parse(query[2]!); }
        catch { return deliver(actor, eventId, { kind: "Requête d’inventaire invalide", text: inventoryQueryHelp }, context); }
        const result = await questions.structured(actor, value, query[1]!.toLowerCase() === 'count' ? 'count' : 'list', eventId);
        return typeof result === 'string' ? show(result) : deliver(actor, eventId, result, context);
      }
      if (/^edit project\s/i.test(text)) {
        const saved = await store.request(actor, eventId);
        let proposal = saved;
        if (!proposal) {
          let request: ReturnType<typeof editRequest>;
          try { request = editRequest(text); }
          catch { return deliver(actor, eventId, { kind: "Modification de projet invalide", text: `Choisissez un projet et fournissez un objet JSON non vide de champs autorisés. Les valeurs facultatives peuvent être null ; les noms doivent rester valides. Les champs non autorisés, métadonnées et opérations sur plusieurs fiches sont refusés.\n${help}` }, context); }
          const { projects, total } = await store.lookup(actor, request.selector);
          if (total === 0) return deliver(actor, eventId, { kind: "Projet introuvable", text: "Aucun projet ne correspond exactement à cet identifiant, nom ou alias." }, context);
          if (total > 1) return deliver(actor, eventId, { kind: "Modification de projet ambiguë", text: `Ce nom ou alias exact correspond à ${total} projets. Utilisez documentation projet ${literal(request.selector)} pour examiner les choix, puis répétez la modification avec un identifiant stable. Rien n’a été proposé ni enregistré.` }, context);
          if (projects[0]!.archived) return deliver(actor, eventId, { kind: "Restauration nécessaire avant modification", text: "Ce projet est archivé. Restaurez-le explicitement avant de le modifier." }, context);
          proposal = await store.proposeEdit(actor, eventId, projects[0]!, request.fields, source);
        }
        const preview = await presentation.confirmation(proposal);
        return deliver(actor, eventId, { ...preview, kind: "Confirmation de modification du projet", text: `Modifier le projet partagé : ${literal(await presentation.name('project', proposal.target_id))}\n${preview.text}\nSeuls ces champs changeront. La confirmation les remplace même après la modification d’un autre utilisateur ; les autres champs sont conservés. Vous seul pouvez confirmer dans cette conversation privée. Expiration : ${formatDate(new Date(proposal.created_at).getTime() + 24 * 3600_000)}. Rien n’est enregistré avant votre confirmation.`, buttons: [{ label: "Confirmer la modification", action: 'confirm_edit', value: proposal.id, style: 'primary' }, { label: "Examiner les valeurs", action: 'open_confirmation_values', value: proposal.id }] }, context);
      }
      if (/^create project\s/i.test(text)) {
        let fields: ProjectFields;
        try { fields = projectFields.parse(JSON.parse(text.replace(/^create project\s+/i, ''))); }
        catch { return deliver(actor, eventId, { kind: "Projet invalide", text: `Fournissez un objet JSON contenant uniquement les champs du projet autorisés. Le nom doit être non vide ; les liens doivent être des URL HTTP(S) sans identifiants de connexion. La fiche complète doit tenir dans 5 000 caractères JSON.\n${help}` }, context); }
        const proposal = await store.propose(actor, eventId, fields, source);
        const preview = await presentation.confirmation(proposal);
        return deliver(actor, eventId, { ...preview, kind: "Confirmation de création du projet", text: `Créer le projet partagé : ${literal(String(proposal.fields.name))}\n${preview.text}\nVous seul pouvez confirmer dans cette conversation privée. Expiration : ${formatDate(new Date(proposal.created_at).getTime() + 24 * 3600_000)}. Rien n’est enregistré avant votre confirmation.`, buttons: [{ label: "Confirmer la création", action: 'confirm_create', value: proposal.id, style: 'primary' }, ...(!preview.table ? [{ label: "Examiner les valeurs", action: 'open_confirmation_values', value: proposal.id }] : [])] }, context);
      }
      const projects = /^projects(?:\s+(\d{1,6}))?$/i.exec(text);
      if (projects) return show(`projects_${projects[1] ?? '0'}`);
      if (/^history$/i.test(text)) return show('sharedhistory_0');
      const lookup = /^(project|history)\s+([\s\S]+)$/i.exec(text);
      if (lookup) {
        const destination = lookup[1]!.toLowerCase(), { projects, total } = await store.lookup(actor, lookup[2]!.trim());
        if (total === 1) return show(recordPage(destination, projects[0]!.id));
        if (total > 1) return show(`lookup_${await store.saveLookup(actor, eventId, lookup[2]!.trim(), destination)}_0`);
        return deliver(actor, eventId, { kind: "Projet introuvable", text: "Aucun projet ne correspond exactement à cet identifiant, nom ou alias." }, context);
      }
      if (text.toLowerCase() !== 'help') {
        return interpret(text);
      }
      return deliver(actor, eventId, { kind: "Aide de Documentation", text: `${help}\n${questionHelp}\n${lifecycleHelp}\n${catalogHelp}\n${componentHelp}\n${hostHelp}\n${hostingHelp}\n${toolHelp}` }, context);
    },
  };
}
