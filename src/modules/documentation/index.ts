import type { Actor } from '../../core/identity.js';
import type { AssistantModule, ModuleContext } from '../../core/modules.js';
import { Navigation, type MenuPage } from '../../core/navigation.js';
import { escapeCardValue, menuButton, SlackDeliveryRejected, type AgentMessage } from '../../core/slack.js';
import type { Sql } from '../../core/store.js';
import { projectFields, type ProjectFields } from './domain.js';
import { documentationSchema, DocumentationStore } from './store.js';

const literal = (value: string) => escapeCardValue(value);
const help = 'Use documentation projects [page] to browse (pages start at 0); documentation project <identifier, exact name or alias> for details; documentation history <identifier, exact name or alias> for history.\nCreate one Project with documentation create project {"name":"Alpha","aliases":["A"],"description":"…","repositories":["https://example.com/repo"],"documentationLinks":["https://example.com/docs"],"notes":"…"}. Only name is required. Other fields remain Unknown when omitted. Names/aliases allow 120 characters, up to 20 aliases; description/notes allow 1,500 characters each; each link list allows 10 HTTP(S) URLs of up to 400 characters without credentials. The complete normalized JSON record allows 5,000 characters. Creation needs your separate confirmation within 24 hours. No AI or Gmail is needed. Editing, other inventory kinds and natural-language interpretation are later slices.';
const fieldsText = (fields: ProjectFields) => Object.entries(fields).map(([key, value]) => `${key}: ${value === null ? 'Unknown' : literal(Array.isArray(value) ? JSON.stringify(value) : value)}`).join('\n');
const resourceLinks = (fields: ProjectFields) => [...(fields.repositories ?? []).map(url => ({ label: `Repository: ${url}`, url })), ...(fields.documentationLinks ?? []).map(url => ({ label: `Documentation: ${url}`, url }))];
const recordPage = (destination: string, id: string) => `${destination}_${id}${destination === 'history' ? '_0' : ''}`;
const pageLinks = (prefix: string, page: number, pages: number) => [
  ...(page > 0 ? [{ label: 'Previous', page: `${prefix}_${page - 1}` }] : []),
  ...(page + 1 < pages ? [{ label: 'Next', page: `${prefix}_${page + 1}` }] : []),
];

export function createDocumentationModule(sql: Sql): AssistantModule {
  const store = new DocumentationStore(sql);
  async function deliver(actor: Actor, eventId: string, message: AgentMessage, context: ModuleContext) {
    if (!await store.claimDelivery(actor, eventId)) return;
    try { await context.messenger.send(actor, { ...message, buttons: [...(message.buttons ?? []), menuButton] }); }
    catch (error) { if (error instanceof SlackDeliveryRejected) await store.releaseDelivery(actor, eventId); throw error; }
  }
  async function page(actor: Actor, destination: string): Promise<MenuPage> {
    if (destination === 'help' || destination === 'add') return { kind: destination === 'add' ? 'Add Project' : 'Documentation help', text: help, links: [{ label: 'Back', page: 'main' }] };
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
      return { kind: 'Project', text: `Identifier: ${project.id}\n${fieldsText(project.fields)}`, resourceLinks: resourceLinks(project.fields), links: [{ label: 'History', page: `history_${project.id}_0` }, { label: 'Back to Projects', page: 'projects_0' }] };
    }
    if (destination.startsWith('history_')) {
      const match = /^history_([^_]+)_(\d{1,6})$/.exec(destination);
      const id = match?.[1] ?? '', project = await store.project(actor, id);
      if (!project) return { kind: 'History unavailable', text: 'That Project was not found.', links: [{ label: 'Projects', page: 'projects_0' }] };
      const { changes, page, pages } = await store.history(actor, id, Number(match?.[2] ?? 0));
      return { kind: 'Project history', text: `Project: ${literal(project.fields.name)} (${id})\nHistory page ${page + 1}/${pages}\n${changes.map(change => `Actor: ${literal(change.actor)}\nTime: ${new Date(change.changed_at).toISOString()}\nSource: ${literal(change.source)}\nBefore: No record\nAfter:\n${fieldsText(change.after_values)}`).join('\n')}`, links: [...pageLinks(`history_${id}`, page, pages), { label: 'Back to Project', page: `project_${id}` }] };
    }
    return { kind: 'Documentation', text: 'Create and browse shared Projects. Every typed request needs the documentation prefix. Browsing and creation use no AI.',
      links: [{ label: 'Projects', page: 'projects_0' }, { label: 'Add Project', page: 'add' }, { label: 'Help', page: 'help' }] };
  }
  return {
    id: 'documentation', name: 'Documentation', description: 'Create and browse shared Projects and their history',
    initialize: async database => { await database.query(documentationSchema); },
    cleanup: async () => { await store.cleanup(); },
    menu: (actor, destination) => page(actor, destination),
    async handle(actor, payload, eventId, context) {
      const navigation = new Navigation(context.sql, context.messenger);
      const show = async (destination: string) => {
        const content = await page(actor, destination);
        await navigation.show(actor, eventId, { ...content, links: [...(content.links ?? []).map(link => ({ ...link, page: `documentation:${link.page}` })), { label: 'Back to menu', page: 'main' }] });
      };
      if (payload.type === 'action' && payload.action === 'confirm_create') {
        const saved = typeof payload.value === 'string' ? await store.confirm(actor, payload.value) : undefined;
        if (!saved) return deliver(actor, eventId, { kind: 'Confirmation unavailable', text: 'This confirmation does not belong to this User and DM, or is unavailable.' }, context);
        if (!saved.applied_at) return deliver(actor, eventId, { kind: 'Confirmation expired', text: 'This confirmation has expired. Submit a fresh documentation create project request.' }, context);
        return deliver(actor, eventId, { kind: 'Project created', text: `Saved Project: ${saved.target_id}\n${fieldsText(saved.fields)}\nUse documentation project ${saved.target_id} to read the record.` }, context);
      }
      if (payload.type !== 'text') return deliver(actor, eventId, { kind: 'Documentation help', text: help }, context);
      const text = String(payload.text ?? '').trim();
      if (/^create project\s/i.test(text)) {
        let fields: ProjectFields;
        try { fields = projectFields.parse(JSON.parse(text.replace(/^create project\s+/i, ''))); }
        catch { return deliver(actor, eventId, { kind: 'Invalid Project', text: `Provide one JSON object using only the fixed Project fields. Name must be nonempty; links must be HTTP(S) URLs without credentials. The complete record must fit within 5,000 JSON characters.\n${help}` }, context); }
        const proposal = await store.propose(actor, eventId, fields);
        return deliver(actor, eventId, { kind: 'Create Project confirmation', text: `Create shared Project: ${proposal.target_id}\n${fieldsText(proposal.fields)}\nOnly you can confirm in this DM. Expires: ${new Date(new Date(proposal.created_at).getTime() + 24 * 3600_000).toISOString()}. Nothing is saved until you confirm.`, buttons: [{ label: 'Confirm creation', action: 'confirm_create', value: proposal.id, style: 'primary' }] }, context);
      }
      const projects = /^projects(?:\s+(\d{1,6}))?$/i.exec(text);
      if (projects) return show(`projects_${projects[1] ?? '0'}`);
      const lookup = /^(project|history)\s+([\s\S]+)$/i.exec(text);
      if (lookup) {
        const destination = lookup[1]!.toLowerCase(), { projects, total } = await store.lookup(actor, lookup[2]!.trim());
        if (total === 1) return show(recordPage(destination, projects[0]!.id));
        if (total > 1) return show(`lookup_${await store.saveLookup(actor, eventId, lookup[2]!.trim(), destination)}_0`);
        return deliver(actor, eventId, { kind: 'Project not found', text: 'No Project matches that exact identifier, name or alias.' }, context);
      }
      return deliver(actor, eventId, { kind: 'Documentation help', text: help }, context);
    },
  };
}
