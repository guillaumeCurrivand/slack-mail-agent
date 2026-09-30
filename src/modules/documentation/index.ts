import type { Actor } from '../../core/identity.js';
import type { AssistantModule, ModuleContext } from '../../core/modules.js';
import { Navigation, type MenuPage } from '../../core/navigation.js';
import { escapeCardValue, menuButton, SlackDeliveryRejected, type AgentMessage } from '../../core/slack.js';
import type { Sql } from '../../core/store.js';
import { projectEdit, projectFields, type ProjectFields, type ProjectEdit } from './domain.js';
import { documentationSchema, DocumentationStore } from './store.js';
import { Catalog, catalogHelp, componentHelp, inventoryText } from './catalog.js';

const literal = (value: string) => escapeCardValue(value);
const help = 'Use documentation projects [page] to browse (pages start at 0); documentation project <identifier, exact name or alias> for details; documentation history [identifier, exact name or alias] for shared or Project history.\nCreate one Project with documentation create project {"name":"Alpha","aliases":["A"],"description":"…","repositories":["https://example.com/repo"],"documentationLinks":["https://example.com/docs"],"notes":"…"}. Only name is required. Other fields remain Unknown when omitted. Names/aliases allow 120 characters, up to 20 aliases; description/notes allow 1,500 characters each; each link list allows 10 HTTP(S) URLs of up to 400 characters without credentials. A creation record or edit replacement object allows 5,000 JSON characters.\nEdit one Project with documentation edit project <identifier, exact name or alias> {"description":"Replacement","notes":null}. Supported fields: name, aliases, description, repositories, documentationLinks, notes. Only supplied fields change; null clears optional fields to Unknown. Names cannot be cleared. System identifiers, history and lifecycle metadata cannot be edited. Creation and editing need your separate confirmation within 24 hours. Edits overwrite selected fields even after intervening edits; unrelated fields remain. No AI or Gmail is needed. Hosting, Tools, archival, natural language and import are later slices.';
const fieldsText = inventoryText;
const resourceLinks = (fields: ProjectFields) => [...(fields.repositories ?? []).map(url => ({ label: `Repository: ${url}`, url })), ...(fields.documentationLinks ?? []).map(url => ({ label: `Documentation: ${url}`, url }))];
const recordPage = (destination: string, id: string) => `${destination}_${id}${['history', 'components'].includes(destination) ? '_0' : ''}`;
const pageLinks = (prefix: string, page: number, pages: number) => [
  ...(page > 0 ? [{ label: 'Previous', page: `${prefix}_${page - 1}` }] : []),
  ...(page + 1 < pages ? [{ label: 'Next', page: `${prefix}_${page + 1}` }] : []),
];
function editRequest(text: string): { selector: string; fields: ProjectEdit } {
  const body = text.replace(/^edit project\s+/i, '');
  // Names and replacement strings can both contain braces. Find a complete
  // trailing JSON value before validating it, rather than guessing a delimiter.
  for (const boundary of [...body.matchAll(/\s+(?=\{)/g)].reverse()) {
    let value: unknown;
    try { value = JSON.parse(body.slice(boundary.index + boundary[0].length)); }
    catch { continue; }
    return { selector: body.slice(0, boundary.index).trim(), fields: projectEdit.parse(value) };
  }
  throw new Error('Expected one target and a replacement object');
}

export function createDocumentationModule(sql: Sql): AssistantModule {
  const store = new DocumentationStore(sql);
  const catalog = new Catalog(store);
  async function deliver(actor: Actor, eventId: string, message: AgentMessage, context: ModuleContext) {
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
    const chunks = [''];
    for (const line of content.text.split('\n')) {
      const index = chunks.length - 1;
      if (chunks[index]!.length + line.length + 1 > 10_000) chunks.push(line);
      else chunks[index] += `${chunks[index] ? '\n' : ''}${line}`;
    }
    if (chunks.length === 1) return content;
    const index = Math.min(Number(part?.[1] ?? 0), chunks.length - 1);
    return { ...content, text: `Values page ${index + 1}/${chunks.length}\n${chunks[index]}`, links: [
      ...(index > 0 ? [{ label: 'Previous values', page: `content_${index - 1}_${target}` }] : []),
      ...(index + 1 < chunks.length ? [{ label: 'More values', page: `content_${index + 1}_${target}` }] : []),
      ...(content.links ?? []),
    ] };
  }
  async function recordContent(actor: Actor, destination: string): Promise<MenuPage> {
    const catalogPage = await catalog.page(actor, destination);
    if (catalogPage) return catalogPage;
    if (destination === 'help' || destination === 'add') return { kind: destination === 'add' ? 'Add Project' : 'Documentation help', text: `${help}\n${catalogHelp}\n${componentHelp}`, links: [{ label: 'Back', page: 'main' }] };
    const list = /^projects_(\d{1,6})$/.exec(destination), lookup = /^lookup_([^_]+)_(\d{1,6})$/.exec(destination);
    if (list || lookup) {
      const saved = lookup ? await store.savedLookup(actor, lookup[1]!) : undefined;
      if (lookup && !saved) return { kind: 'Lookup unavailable', text: 'Repeat the exact lookup to open a fresh choice.', links: [{ label: 'Projects', page: 'projects_0' }] };
      const { projects, total, page, pages } = await store.projects(actor, Number(list?.[1] ?? lookup?.[2] ?? 0), saved?.selector ?? null);
      const prefix = saved ? `lookup_${lookup![1]}` : 'projects';
      return { kind: saved ? 'Choose a Project' : 'Projects', text: `${saved ? 'This lookup is ambiguous. Choose a Project by its identifier.\n' : ''}page ${page + 1}/${pages} · ${total} Projects\n${projects.length ? projects.map(project => `${literal(project.fields.name)} — ${project.id}`).join('\n') : 'No Projects have been saved.'}`,
        links: [...projects.map(project => ({ label: project.fields.name, page: recordPage(saved?.destination ?? 'project', project.id) })), ...pageLinks(prefix, page, pages), { label: 'Add Project', page: 'add' }, { label: 'Back', page: 'main' }] };
    }
    if (destination.startsWith('project_')) {
      const project = await store.project(actor, destination.slice(8));
      if (!project) return { kind: 'Project unavailable', text: 'That Project was not found.', links: [{ label: 'Projects', page: 'projects_0' }] };
      return { kind: 'Project', text: `Identifier: ${project.id}\n${fieldsText(project.fields)}`, resourceLinks: resourceLinks(project.fields), links: [{ label: 'Edit', page: `edit_${project.id}` }, { label: 'Components', page: `components_${project.id}_0` }, { label: 'History', page: `history_${project.id}_0` }, { label: 'Back to Projects', page: 'projects_0' }] };
    }
    if (destination.startsWith('edit_')) {
      const project = await store.project(actor, destination.slice(5));
      if (!project) return { kind: 'Project unavailable', text: 'That Project was not found.', links: [{ label: 'Projects', page: 'projects_0' }] };
      return { kind: 'Edit Project', text: `Project: ${literal(project.fields.name)} (${project.id})\nUse documentation edit project ${project.id} {"description":"Replacement","notes":null}\n${help}`, links: [{ label: 'Back to Project', page: `project_${project.id}` }] };
    }
    if (destination.startsWith('history_') || destination.startsWith('sharedhistory_')) {
      const shared = /^sharedhistory_(\d{1,6})$/.exec(destination);
      const match = /^history_([^_]+)_(\d{1,6})$/.exec(destination);
      const id = match?.[1] ?? null, project = id ? await store.project(actor, id) : undefined;
      if (!shared && !project) return { kind: 'History unavailable', text: 'That Project was not found.', links: [{ label: 'Projects', page: 'projects_0' }] };
      const { changes, page, pages } = await store.history(actor, id, Number(match?.[2] ?? shared?.[1] ?? 0));
      return { kind: shared ? 'Shared history' : 'Project history', text: `${project ? `Project: ${literal(project.fields.name)} (${id})\n` : ''}History page ${page + 1}/${pages}\n${changes.length ? changes.map(change => `${change.record_kind === 'technology' ? 'Technology' : change.record_kind === 'component' ? 'Component' : 'Project'} identifier: ${change.project_id}\nActor: ${literal(change.actor)}\nTime: ${new Date(change.changed_at).toISOString()}\nSource: ${literal(change.source)}\nChanged fields: ${Object.keys(change.after_values).join(', ')}\n${change.before_values === null ? 'Before: No record' : `Before:\n${fieldsText(change.before_values)}`}\nAfter:\n${fieldsText(change.after_values)}`).join('\n') : 'No changes have been saved.'}`, links: [...pageLinks(shared ? 'sharedhistory' : `history_${id}`, page, pages), ...(shared ? [...changes.map(change => ({ label: 'Record details', page: `${change.record_kind}_${change.project_id}` })), { label: 'Back', page: 'main' }] : [{ label: 'Back to Project', page: `project_${id}` }])] };
    }
    return { kind: 'Documentation', text: 'Create, edit and browse shared Projects, Technologies and Components. Every typed request needs the documentation prefix. Browsing and structured mutations use no AI.',
      links: [{ label: 'Projects', page: 'projects_0' }, { label: 'Add Project', page: 'add' }, { label: 'Technologies', page: 'technologies_0' }, { label: 'History', page: 'sharedhistory_0' }, { label: 'Help', page: 'help' }] };
  }
  return {
    id: 'documentation', name: 'Documentation', description: 'Create, edit and browse shared Projects, Technologies, Components and their history',
    initialize: async database => { await database.query(documentationSchema); },
    cleanup: async () => { await store.cleanup(); },
    menu: (actor, destination) => page(actor, destination),
    async handle(actor, payload, eventId, context) {
      const navigation = new Navigation(context.sql, context.messenger);
      const show = async (destination: string) => {
        const content = await page(actor, destination);
        await navigation.show(actor, eventId, { ...content, links: [...(content.links ?? []).map(link => ({ ...link, page: `documentation:${link.page}` })), { label: 'Back to menu', page: 'main' }] });
      };
      if (await catalog.handle(actor, payload, eventId, message => deliver(actor, eventId, message, context), show)) return;
      if (payload.type === 'action' && ['confirm_create', 'confirm_edit'].includes(String(payload.action))) {
        const operation = payload.action === 'confirm_edit' ? 'edit' : 'create';
        const saved = typeof payload.value === 'string' ? await (operation === 'edit' ? store.confirmEdit(actor, payload.value) : store.confirm(actor, payload.value)) : undefined;
        if (!saved || saved.record_kind !== 'project' || saved.operation !== operation) return deliver(actor, eventId, { kind: 'Confirmation unavailable', text: 'This confirmation does not belong to this User and DM, or is unavailable.' }, context);
        if (!saved.applied_at) return deliver(actor, eventId, { kind: 'Confirmation expired', text: `This confirmation has expired. Submit a fresh documentation ${operation} project request.` }, context);
        if (operation === 'edit') return deliver(actor, eventId, { kind: saved.outcome === 'missing' ? 'Edit failed' : saved.outcome === 'satisfied' ? 'Edit already satisfied' : 'Project edited', text: `Saved outcome for Project: ${saved.target_id}\n${saved.outcome === 'missing' ? 'The target was unavailable at confirmation; no edit was applied.' : `${saved.outcome === 'satisfied' ? 'The selected fields already matched at confirmation; no change or history entry was added.' : 'The approved replacements were saved once. Later edits may have changed the current values.'}\nApproved replacements:\n${fieldsText(saved.fields)}`}\nUse documentation project ${saved.target_id} to read current values.` }, context);
        return deliver(actor, eventId, { kind: 'Project created', text: `Saved Project: ${saved.target_id}\n${fieldsText(saved.fields)}\nUse documentation project ${saved.target_id} to read the record.` }, context);
      }
      if (payload.type !== 'text') return deliver(actor, eventId, { kind: 'Documentation help', text: help }, context);
      const text = String(payload.text ?? '').trim();
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
          proposal = await store.proposeEdit(actor, eventId, projects[0]!, request.fields);
        }
        return deliver(actor, eventId, { kind: 'Edit Project confirmation', text: `Edit shared Project: ${proposal.target_id}\nSelected replacement fields:\n${fieldsText(proposal.fields)}\nOnly these fields will change. Confirmation overwrites them even after another User edits them; unrelated fields remain. Only you can confirm in this DM. Expires: ${new Date(new Date(proposal.created_at).getTime() + 24 * 3600_000).toISOString()}. Nothing is saved until you confirm.`, buttons: [{ label: 'Confirm edit', action: 'confirm_edit', value: proposal.id, style: 'primary' }] }, context);
      }
      if (/^create project\s/i.test(text)) {
        let fields: ProjectFields;
        try { fields = projectFields.parse(JSON.parse(text.replace(/^create project\s+/i, ''))); }
        catch { return deliver(actor, eventId, { kind: 'Invalid Project', text: `Provide one JSON object using only the fixed Project fields. Name must be nonempty; links must be HTTP(S) URLs without credentials. The complete record must fit within 5,000 JSON characters.\n${help}` }, context); }
        const proposal = await store.propose(actor, eventId, fields);
        return deliver(actor, eventId, { kind: 'Create Project confirmation', text: `Create shared Project: ${proposal.target_id}\n${fieldsText(proposal.fields)}\nOnly you can confirm in this DM. Expires: ${new Date(new Date(proposal.created_at).getTime() + 24 * 3600_000).toISOString()}. Nothing is saved until you confirm.`, buttons: [{ label: 'Confirm creation', action: 'confirm_create', value: proposal.id, style: 'primary' }] }, context);
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
      return deliver(actor, eventId, { kind: 'Documentation help', text: `${help}\n${catalogHelp}\n${componentHelp}` }, context);
    },
  };
}
