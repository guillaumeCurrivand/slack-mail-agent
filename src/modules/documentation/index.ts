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
const questionHelp = `Natural-language reads: documentation where is Alpha hosted?; documentation which technologies does this project use?; documentation which projects use React and Compute across any of their components?; documentation how many projects use React?; documentation which tools are company-wide? Interpretation uses the shared AI budget; opening records and result controls is free. Project context is private and expires after 30 minutes. Natural-language changes: documentation please create a project named Alpha; documentation please set this project description to Team app; documentation please archive the tool Tracker. Describe one record and explicit values; existing references resolve exactly. Interpretation uses the shared budget; nothing changes before your separate confirmation. The offline operator import is delivered in ticket 10.\n${inventoryQueryHelp}`;
const help = 'Use documentation projects [page] to browse (pages start at 0); documentation project <identifier, exact name or alias> for details; documentation history [identifier, exact name or alias] for shared or Project history.\nCreate one Project with documentation create project {"name":"Alpha","aliases":["A"],"description":"…","repositories":["https://example.com/repo"],"documentationLinks":["https://example.com/docs"],"notes":"…"}. Only name is required. Other fields remain Unknown when omitted. Names/aliases allow 120 characters, up to 20 aliases; description/notes allow 1,500 characters each; each link list allows 10 HTTP(S) URLs of up to 400 characters without credentials. A creation record or edit replacement object allows 5,000 JSON characters.\nEdit one Project with documentation edit project <identifier, exact name or alias> {"description":"Replacement","notes":null}. Supported fields: name, aliases, description, repositories, documentationLinks, notes. Only supplied fields change; null clears optional fields to Unknown. Names cannot be cleared. System identifiers, history and lifecycle metadata cannot be edited. Creation and editing need your separate confirmation within 24 hours. Edits overwrite selected fields even after intervening edits; unrelated fields remain. No AI or Gmail is needed. See the Project-question examples below; inventory filters/counts are available below; natural-language changes use the same confirmation path with shared-budget interpretation; the offline operator import is delivered in ticket 10.';
const recordPage = (destination: string, id: string) => `${destination}_${id}${['history', 'components'].includes(destination) ? '_0' : ''}`;
const pageLinks = (prefix: string, page: number, pages: number) => [
  ...(page > 0 ? [{ label: 'Previous', page: `${prefix}_${page - 1}` }] : []),
  ...(page + 1 < pages ? [{ label: 'Next', page: `${prefix}_${page + 1}` }] : []),
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
      message = { ...message, table: undefined, text: `${message.text}\nThe full saved values span several pages. Open Review values to inspect them.`, buttons: [...(message.buttons ?? []), { label: 'Review values', action: 'open_confirmation_values', value: confirmation }] };
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
    return { ...chunks[index]!, text: `Values page ${index + 1}/${chunks.length}\n${chunks[index]!.text}`, links: [
      ...(index > 0 ? [{ label: 'Previous values', page: `content_${index - 1}_${target}` }] : []),
      ...(index + 1 < chunks.length ? [{ label: 'More values', page: `content_${index + 1}_${target}` }] : []),
      ...(content.links ?? []),
    ] };
  }
  async function recordContent(actor: Actor, destination: string): Promise<MenuPage> {
    const presentation = new InventoryPresentation(store, actor);
    const confirmation = /^confirmation_([^_]+)$/.exec(destination);
    if (confirmation) {
      const saved = await store.confirmation(actor, confirmation[1]!);
      const table = saved ? await presentation.values(saved.fields, saved.operation === 'edit' ? saved.before_values : undefined, true) : undefined;
      if (table && saved?.operation === 'edit' && saved.before_values === null) table.rows = table.rows.map(row => [row[0]!, 'Unavailable (original values were not saved)', row[2]!]);
      const targetName = saved?.operation === 'create' ? String(saved.fields.name ?? saved.fields.environment ?? 'Unknown environment') || 'Empty environment' : saved ? await presentation.name(saved.record_kind, saved.target_id) : '';
      return saved ? { kind: `${saved.operation === 'create' ? 'Create' : 'Edit'} confirmation values`, table, text: `${recordTitle(saved.record_kind)}: ${literal(targetName)}\n${saved.operation === 'edit' && saved.before_values === null ? 'Unavailable for this older confirmation; original values were not saved.\n' : ''}These are saved proposal values; current values may differ. Confirm using the original confirmation Card. Expires: ${new Date(new Date(saved.created_at).getTime() + 24 * 3600_000).toISOString()}.` }
        : { kind: 'Confirmation unavailable', text: 'This confirmation does not belong to this User and DM, or is unavailable.' };
    }
    const answer = await questions.page(actor, destination);
    if (answer) return answer;
    const lifecyclePage = await lifecycle.page(actor, destination);
    if (lifecyclePage) return lifecyclePage;
    const catalogPage = await catalog.page(actor, destination);
    if (catalogPage) return catalogPage;
    if (destination === 'help' || destination === 'add') return { kind: destination === 'add' ? 'Add Project' : 'Documentation help', text: `${help}\n${questionHelp}\n${lifecycleHelp}\n${catalogHelp}\n${componentHelp}\n${hostHelp}\n${hostingHelp}\n${toolHelp}`, links: [{ label: 'Back', page: 'main' }] };
    const list = /^projects_(\d{1,6})$/.exec(destination), lookup = /^lookup_([^_]+)_(\d{1,6})$/.exec(destination);
    if (list || lookup) {
      const saved = lookup ? await store.savedLookup(actor, lookup[1]!) : undefined;
      if (lookup && !saved) return { kind: 'Lookup unavailable', text: 'Repeat the exact lookup to open a fresh choice.', links: [{ label: 'Projects', page: 'projects_0' }] };
      const { projects, total, page, pages } = await store.projects(actor, Number(list?.[1] ?? lookup?.[2] ?? 0), saved?.selector ?? null);
      const prefix = saved ? `lookup_${lookup![1]}` : 'projects';
      return { kind: saved ? 'Choose a Project' : 'Projects', text: `${saved ? 'This lookup is ambiguous. Choose a Project.\n' : ''}page ${page + 1}/${pages} · ${total} Projects\n${projects.length ? '' : 'No Projects have been saved.'}`,
        ...await presentation.list(projects.map(project => ({ ...project, kind: 'project' as const })), projects.map(project => recordPage(saved?.destination ?? 'project', project.id))),
        links: [...pageLinks(prefix, page, pages), { label: 'Add Project', page: 'add' }, { label: 'Back', page: 'main' }] };
    }
    const hostingPage = /^projecthosting_([^_]+)_(\d{1,6})$/.exec(destination);
    if (destination.startsWith('project_') || hostingPage) {
      const project = await store.project(actor, hostingPage?.[1] ?? destination.slice(8));
      if (!project) return { kind: 'Project unavailable', text: 'That Project was not found.', links: [{ label: 'Projects', page: 'projects_0' }] };
      await questions.remember(actor, project.id);
      const hosting = hostingPage ? await store.projectHosting(actor, project.id, Number(hostingPage[2])) : undefined;
      const view = hosting
        ? await presentation.list(hosting.entries.filter(entry => entry.fields && entry.hosting_id).map(entry => ({ id: entry.hosting_id!, kind: 'hosting' as const, fields: entry.fields!, archived: !!entry.hosting_archived })))
        : await presentation.details(project.fields);
      const missing = hosting?.entries.filter(entry => !entry.hosting_id) ?? [];
      return { ...view, kind: hosting ? 'Project hosting' : 'Project', text: `Project: ${literal(project.fields.name)}\n${statusText(project)}\n${hosting ? `Hosting page ${hosting.page + 1}/${hosting.pages}\n${!hosting.entries.length ? 'Components: Unknown\nHosting entries: Unknown' : missing.map(entry => `Component: ${literal(entry.component_name)}\nHosting entries: Unknown`).join('\n')}` : ('text' in view ? view.text : '')}`,
        buttons: lifecycleButton('project', project),
        links: [...(hosting ? pageLinks(`projecthosting_${project.id}`, hosting.page, hosting.pages) : [{ label: 'Hosting entries', page: `projecthosting_${project.id}_0` }]),
          ...missing.map(entry => ({ label: `Component: ${entry.component_name}`, page: `component_${entry.component_id}` })),
          ...(!project.archived ? [{ label: 'Edit', page: `edit_${project.id}` }] : []), { label: 'Components', page: `components_${project.id}_0` }, { label: 'Tools', page: `projecttools_${project.id}_0` }, { label: 'History', page: `history_${project.id}_0` }, { label: 'Back to Projects', page: 'projects_0' }] };
    }
    if (destination.startsWith('edit_')) {
      const project = await store.project(actor, destination.slice(5));
      if (!project) return { kind: 'Project unavailable', text: 'That Project was not found.', links: [{ label: 'Projects', page: 'projects_0' }] };
      if (project.archived) return { kind: 'Edit requires restoration', text: `Project: ${literal(project.fields.name)}\nStatus: Archived\nExplicitly restore this Project before editing.`, buttons: lifecycleButton('project', project), links: [{ label: 'Back to Project', page: `project_${project.id}` }] };
      return { kind: 'Edit Project', text: `Project: ${literal(project.fields.name)} (${project.id})\nUse documentation edit project ${project.id} {"description":"Replacement","notes":null}\n${help}`, links: [{ label: 'Back to Project', page: `project_${project.id}` }] };
    }
    if (destination.startsWith('history_') || destination.startsWith('sharedhistory_')) {
      const shared = /^sharedhistory_(\d{1,6})$/.exec(destination);
      const match = /^history_([^_]+)_(\d{1,6})$/.exec(destination);
      const id = match?.[1] ?? null, project = id ? await store.project(actor, id) : undefined;
      if (!shared && !project) return { kind: 'History unavailable', text: 'That Project was not found.', links: [{ label: 'Projects', page: 'projects_0' }] };
      const { changes, page, pages } = await store.history(actor, id, Number(match?.[2] ?? shared?.[1] ?? 0));
      const change = changes[0];
      return { kind: shared ? 'Shared history' : 'Project history', ...(change ? { table: await presentation.values(change.after_values, change.before_values) } : {}), text: `${project ? `Project: ${literal(project.fields.name)}\n${statusText(project)}\n` : ''}History page ${page + 1}/${pages}\n${change ? `${recordTitle(change.record_kind)}: ${literal(await presentation.name(change.record_kind, change.project_id))}\nActor: ${literal(change.actor)}\nTime: ${new Date(change.changed_at).toISOString()}\nSource: ${literal(change.source)}\n${change.before_values === null ? 'Before: No record' : ''}` : 'No changes have been saved.'}`, links: [...pageLinks(shared ? 'sharedhistory' : `history_${id}`, page, pages), ...(shared ? [...changes.map(change => ({ label: 'Record details', page: `${change.record_kind}_${change.project_id}` })), { label: 'Back', page: 'main' }] : [{ label: 'Back to Project', page: `project_${id}` }])] };
    }
    return { kind: 'Documentation', text: 'Create, edit and browse shared Projects, Technologies, Components, Hosts/services, Hosting entries and Tools. Every typed request needs the documentation prefix. Browsing and structured mutations use no AI.',
      links: [{ label: 'Projects', page: 'projects_0' }, { label: 'Add Project', page: 'add' }, { label: 'Technologies', page: 'technologies_0' }, { label: 'Hosts/services', page: 'hosts_0' }, { label: 'Tools', page: 'tools_0' }, { label: 'Archived', page: 'archived_0' }, { label: 'History', page: 'sharedhistory_0' }, { label: 'Help', page: 'help' }] };
  }
  return {
    menuActions: ['request_archive', 'request_restore'],
    id: 'documentation', name: 'Documentation', description: 'Create, edit and browse shared inventory and its history',
    initialize: async database => { await database.query(documentationSchema + questionSchema + documentationImportSchema); },
    cleanup: async () => { await store.cleanup(); await questions.cleanup(); },
    menu: (actor, destination) => page(actor, destination),
    async handle(actor, payload, eventId, context) {
      const presentation = new InventoryPresentation(store, actor);
      const source = await questions.source(actor, eventId);
      const navigation = new Navigation(context.sql, context.messenger);
      const show = async (destination: string) => {
        const content = await page(actor, destination);
        await navigation.show(actor, eventId, { ...content, recordChoices: content.recordChoices?.map(link => ({ ...link, page: `documentation:${link.page}` })), links: [...(content.links ?? []).map(link => ({ ...link, page: `documentation:${link.page}` })), { label: 'Back to menu', page: 'main' }] });
      };
      const interpret = async (text: string) => {
        const result = await questions.ask(actor, text, eventId, context);
        if (typeof result !== 'string' && 'command' in result) return this.handle(actor, { type: 'text', text: result.command }, eventId, context);
        return typeof result === 'string' ? show(result) : deliver(actor, eventId, result, context);
      };
      if (payload.type === 'action' && payload.action === 'open_confirmation_values') {
        const saved = typeof payload.value === 'string' ? await store.confirmation(actor, payload.value) : undefined;
        if (!saved) return deliver(actor, eventId, { kind: 'Confirmation unavailable', text: 'This confirmation does not belong to this User and DM, or is unavailable.' }, context);
        return show(`confirmation_${saved.id}`);
      }
      if (payload.type === 'action' && ['open_confirmation_record', 'open_confirmation_history'].includes(String(payload.action))) {
        const saved = typeof payload.value === 'string' ? await store.confirmation(actor, payload.value) : undefined;
        if (!saved?.applied_at) return deliver(actor, eventId, { kind: 'Result unavailable', text: 'This saved result is private to its User and DM or is unavailable.' }, context);
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
        if (!saved || saved.record_kind !== 'project' || saved.operation !== operation) return deliver(actor, eventId, { kind: 'Confirmation unavailable', text: 'This confirmation does not belong to this User and DM, or is unavailable.' }, context);
        if (saved.outcome === 'archived') return deliver(actor, eventId, { kind: 'Edit requires restoration', text: `Project ${literal(await presentation.name('project', saved.target_id))} is archived. Explicitly restore it, then retry this confirmation within its original 24-hour window.` }, context);
        if (!saved.applied_at) return deliver(actor, eventId, { kind: 'Confirmation expired', text: `This confirmation has expired. Submit a fresh documentation ${operation} project request.` }, context);
        if (operation === 'edit') return deliver(actor, eventId, { kind: saved.outcome === 'missing' ? 'Edit failed' : saved.outcome === 'satisfied' ? 'Edit already satisfied' : 'Project edited', buttons: outcomeButtons(saved.id), table: await presentation.values(saved.fields), text: `Project: ${literal(await presentation.name('project', saved.target_id))}\n${saved.outcome === 'missing' ? 'The target was unavailable at confirmation; no edit was applied.' : saved.outcome === 'satisfied' ? 'The selected fields already matched at confirmation; no change or history entry was added.' : 'The approved replacements were saved once. Later edits may have changed the current values.'}\nOpen Record details to read current values.` }, context);
        return deliver(actor, eventId, { kind: 'Project created', buttons: outcomeButtons(saved.id), table: await presentation.values(saved.fields), text: `Project: ${literal(String(saved.fields.name))}\nOpen Record details to read the record.` }, context);
      }
      if (payload.type !== 'text') return deliver(actor, eventId, { kind: 'Documentation help', text: help }, context);
      const text = String(payload.text ?? '').trim();
      const query = /^(search|count)\s+([\s\S]+)$/i.exec(text);
      if (query) {
        let value: unknown;
        try { value = JSON.parse(query[2]!); }
        catch { return deliver(actor, eventId, { kind: 'Invalid inventory query', text: inventoryQueryHelp }, context); }
        const result = await questions.structured(actor, value, query[1]!.toLowerCase() === 'count' ? 'count' : 'list', eventId);
        return typeof result === 'string' ? show(result) : deliver(actor, eventId, result, context);
      }
      if (/^edit project\s/i.test(text)) {
        const saved = await store.request(actor, eventId);
        let proposal = saved;
        if (!proposal) {
          let request: ReturnType<typeof editRequest>;
          try { request = editRequest(text); }
          catch { return deliver(actor, eventId, { kind: 'Invalid Project edit', text: `Choose one Project and provide one nonempty JSON object of supported fields. Optional values can be null; names must remain valid. Unsupported fields, metadata and multiple records cannot be edited.\n${help}` }, context); }
          const { projects, total } = await store.lookup(actor, request.selector);
          if (total === 0) return deliver(actor, eventId, { kind: 'Project not found', text: 'No Project matches that exact identifier, name or alias.' }, context);
          if (total > 1) return deliver(actor, eventId, { kind: 'Ambiguous Project edit', text: `That exact name or alias matches ${total} Projects. Use documentation project ${literal(request.selector)} to inspect the choices, then repeat the edit with one stable identifier. Nothing has been proposed or saved.` }, context);
          if (projects[0]!.archived) return deliver(actor, eventId, { kind: 'Edit requires restoration', text: 'This Project is archived. Explicitly restore it before editing.' }, context);
          proposal = await store.proposeEdit(actor, eventId, projects[0]!, request.fields, source);
        }
        const preview = await presentation.confirmation(proposal);
        return deliver(actor, eventId, { ...preview, kind: 'Edit Project confirmation', text: `Edit shared Project: ${literal(await presentation.name('project', proposal.target_id))}\n${preview.text}\nOnly these fields will change. Confirmation overwrites them even after another User edits them; unrelated fields remain. Only you can confirm in this DM. Expires: ${new Date(new Date(proposal.created_at).getTime() + 24 * 3600_000).toISOString()}. Nothing is saved until you confirm.`, buttons: [{ label: 'Confirm edit', action: 'confirm_edit', value: proposal.id, style: 'primary' }, { label: 'Review values', action: 'open_confirmation_values', value: proposal.id }] }, context);
      }
      if (/^create project\s/i.test(text)) {
        let fields: ProjectFields;
        try { fields = projectFields.parse(JSON.parse(text.replace(/^create project\s+/i, ''))); }
        catch { return deliver(actor, eventId, { kind: 'Invalid Project', text: `Provide one JSON object using only the fixed Project fields. Name must be nonempty; links must be HTTP(S) URLs without credentials. The complete record must fit within 5,000 JSON characters.\n${help}` }, context); }
        const proposal = await store.propose(actor, eventId, fields, source);
        const preview = await presentation.confirmation(proposal);
        return deliver(actor, eventId, { ...preview, kind: 'Create Project confirmation', text: `Create shared Project: ${literal(String(proposal.fields.name))}\n${preview.text}\nOnly you can confirm in this DM. Expires: ${new Date(new Date(proposal.created_at).getTime() + 24 * 3600_000).toISOString()}. Nothing is saved until you confirm.`, buttons: [{ label: 'Confirm creation', action: 'confirm_create', value: proposal.id, style: 'primary' }, ...(!preview.table ? [{ label: 'Review values', action: 'open_confirmation_values', value: proposal.id }] : [])] }, context);
      }
      const projects = /^projects(?:\s+(\d{1,6}))?$/i.exec(text);
      if (projects) return show(`projects_${projects[1] ?? '0'}`);
      if (/^history$/i.test(text)) return show('sharedhistory_0');
      const lookup = /^(project|history)\s+([\s\S]+)$/i.exec(text);
      if (lookup) {
        const destination = lookup[1]!.toLowerCase(), { projects, total } = await store.lookup(actor, lookup[2]!.trim());
        if (total === 1) return show(recordPage(destination, projects[0]!.id));
        if (total > 1) return show(`lookup_${await store.saveLookup(actor, eventId, lookup[2]!.trim(), destination)}_0`);
        return deliver(actor, eventId, { kind: 'Project not found', text: 'No Project matches that exact identifier, name or alias.' }, context);
      }
      if (text.toLowerCase() !== 'help') {
        return interpret(text);
      }
      return deliver(actor, eventId, { kind: 'Documentation help', text: `${help}\n${questionHelp}\n${lifecycleHelp}\n${catalogHelp}\n${componentHelp}\n${hostHelp}\n${hostingHelp}\n${toolHelp}` }, context);
    },
  };
}
