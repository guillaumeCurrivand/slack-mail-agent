import type { Actor } from '../../core/identity.js';
import type { MenuPage } from '../../core/navigation.js';
import { escapeCardValue, type AgentMessage } from '../../core/slack.js';
import { recordSchemas, recordTitle, recordName, validSavedFields, parseEditRequest, type InventoryRecord, type InventoryValues, type RecordKind } from './domain.js';
import { lifecycleButton, statusText, referenceLabel, outcomeButtons } from './lifecycle.js';
import type { DocumentationStore } from './store.js';

const literal = escapeCardValue;
export const catalogHelp = 'Browse documentation technologies [page]; inspect documentation technology <identifier or exact name>; read documentation history technology <identifier or exact name>. Create one Technology with documentation create technology {"name":"React","category":"Frontend","notes":"Example"}. Edit with documentation edit technology <identifier or exact name> {"category":null,"notes":"Replacement"}. Supported Technology fields: name (required, one line, 120 characters), category (120 characters), notes (1,500 characters). Optional values may be null (Unknown) or empty. Creation and editing require your separate confirmation within 24 hours. Selected fields overwrite intervening edits and preserve unrelated fields. No AI or Gmail is used.';
export const componentHelp = 'Browse documentation components <Project identifier, exact name or alias> [page]; inspect documentation component <identifier or exact name>; read documentation history component <identifier or exact name>. Create one Component with documentation create component {"name":"Frontend","projectId":"<Project identifier>","type":"frontend","technologies":["<Technology identifier or exact name>"]}. Supported Component fields: name (required, one line, 120 characters), type (optional, 120 characters), technologies (optional, at most 20 existing Technology identifiers or exact names). Creation requires the stable Project identifier as projectId. The parent cannot be changed. Edit with documentation edit component <identifier or exact name> {"type":"API","technologies":null}. Null clears optional values to Unknown; [] records no Technologies. Ambiguous names require a stable identifier. Missing Technologies require separate confirmed creation; relationship edits never create them. Hosting entries are reachable through the Hosting entries control; use documentation hosting <Component identifier> to browse them.';
export const hostHelp = 'Browse documentation hosts [page]; inspect documentation host <identifier or exact name>; read documentation history host <identifier or exact name>. Create with documentation create host {"name":"OVH","role":"Compute","monthlyCost":12.5,"currency":"EUR","notes":"Example"}. Edit with documentation edit host <identifier or exact name> {"role":null,"monthlyCost":null}. Fields: name (required, one line, 120 characters), role (120 characters), monthlyCost (finite number, 0–1 trillion), currency (three-letter code, normalized uppercase), notes (1,500 characters). Known cost requires currency; clearing currency while cost is known is invalid. Unknown cost is not zero. Costs belong only to this shared service. Each save requires your separate confirmation within 24 hours; selected fields overwrite intervening edits and preserve unrelated fields. No AI or infrastructure provider is used.';
export const hostingHelp = 'Browse documentation hosting <Component identifier or exact name> [page]; inspect documentation hosting-entry <identifier>; read documentation history hosting-entry <identifier>. Create with documentation create hosting {"componentId":"<Component identifier>","serviceId":"<Host/service identifier or exact name>","environment":"production","accountReference":"Team account","urls":["https://example.com"],"accessInstructions":"See password manager","notes":"Example"}. Edit with documentation edit hosting <identifier> {"environment":"staging","serviceId":"<existing Host/service>","notes":null}. The Component parent is fixed. Fields: environment (one line, 120 characters), serviceId (required existing Host/service), accountReference/accessInstructions/notes (1,500 characters each), urls (up to 10 HTTP(S) URLs, 400 characters each, without credentials). Creation and selected replacements fit 5,000 JSON characters. Optional fields may be null (Unknown) or empty. Use account references, instructions and password-manager links; never supply passwords or API keys. Missing services need separate confirmed creation; ambiguous names require stable identifiers. Each save affects one entry and requires your confirmation within 24 hours. No AI or infrastructure provider is used.';
export const toolHelp = 'Browse documentation tools [page]; inspect documentation tool <identifier or exact name>; read documentation history tool <identifier or exact name>. Create with documentation create tool {"name":"Slack","category":"Communication","usage":"Company chat","referent":"Team contact","companyWide":true,"projects":["<Project identifier, exact name or alias>"],"notes":"Example"}. Only name is required (one line, 120 characters); category allows 120 characters, usage/referent/notes 1,500 each, projects at most 20 existing Projects. companyWide is true, false or null. Company-wide and Project usage can coexist. Missing fields and null stay Unknown; empty values stay empty. Edit with documentation edit tool <identifier or exact name> {"usage":"Replacement","referent":null}. Creation/selected replacements fit 5,000 JSON characters. Project references resolve unambiguously to stable identifiers; missing Projects require separate confirmed creation. Usage text never creates relationships. Referents are descriptive, confer no edit authority and trigger no notifications. System metadata/history cannot be edited. Every save affects one record, needs your own separate confirmation within 24 hours, overwrites selected fields and preserves unrelated fields. No AI or Gmail is used.';
export const inventoryText = (fields: InventoryValues) => Object.entries(fields).map(([key, value]) => `${key}: ${value === null ? 'Unknown' : literal(Array.isArray(value) ? JSON.stringify(value) : String(value))}`).join('\n');
export const hostingEntryText = (entry: Awaited<ReturnType<DocumentationStore['projectHosting']>>['entries'][number]) =>
  `Component: ${literal(entry.component_name)} (${entry.component_id})${entry.component_archived ? ' [Archived]' : ''}\n${entry.fields ? `Hosting entry: ${entry.hosting_id}${entry.hosting_archived ? ' [Archived]' : ''}\nHost/service: ${literal(entry.service_name ?? 'Unknown')} (${entry.fields.serviceId})${entry.service_archived ? ' [Archived]' : ''}\n${inventoryText(entry.fields)}` : 'Hosting entries: Unknown\nEnvironment: Unknown\nHost/service: Unknown'}`;
const title = recordTitle;
const lookupCommand = (kind: RecordKind) => kind === 'hosting' ? 'hosting-entry' : kind;
const helpFor = (kind: RecordKind) => ({ technology: catalogHelp, component: componentHelp, host: hostHelp, hosting: hostingHelp, tool: toolHelp })[kind];
const pluralFor = (kind: RecordKind) => ({ technology: 'Technologies', component: 'Components', host: 'Hosts/services', hosting: 'Hosting entries', tool: 'Tools' })[kind];
const exampleFor = (kind: RecordKind) => ({ technology: '{"notes":"Replacement"}', component: '{"type":"API","technologies":[]}', host: '{"role":"Compute"}', hosting: '{"environment":"staging","notes":null}', tool: '{"usage":"Replacement","referent":null}' })[kind];
const pages = (prefix: string, page: number, count: number) => [
  ...(page > 0 ? [{ label: 'Previous', page: `${prefix}_${page - 1}` }] : []),
  ...(page + 1 < count ? [{ label: 'Next', page: `${prefix}_${page + 1}` }] : []),
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
  async page(actor: Actor, destination: string): Promise<MenuPage | undefined> {
    if (destination === 'addtechnology') return { kind: 'Add Technology', text: catalogHelp, links: [{ label: 'Back', page: 'technologies_0' }] };
    if (destination === 'addtool') return { kind: 'Add Tool', text: toolHelp, links: [{ label: 'Back', page: 'tools_0' }] };
    if (destination === 'addhost') return { kind: 'Add Host/service', text: hostHelp, links: [{ label: 'Back', page: 'hosts_0' }] };
    const addHosting = /^addhosting_([^_]+)$/.exec(destination);
    if (addHosting) {
      const component = await this.store.record(actor, 'component', addHosting[1]!);
      return component ? { kind: 'Add Hosting entry', text: `Component: ${literal(recordName(component))} (${component.id})\nUse documentation create hosting {"componentId":"${component.id}","serviceId":"<existing Host/service>","environment":"production"}\n${hostingHelp}\n${hostHelp}`, links: [{ label: 'Back', page: `hostingentries_${component.id}_0` }] }
        : { kind: 'Component unavailable', text: 'That Component was not found.' };
    }
    const addComponent = /^addcomponent_([^_]+)$/.exec(destination);
    if (addComponent) {
      const project = await this.store.project(actor, addComponent[1]!);
      return project ? { kind: 'Add Component', text: `Project: ${literal(referenceLabel(project.fields.name, project))} (${project.id})\nUse documentation create component {"name":"Frontend","projectId":"${project.id}","type":"frontend","technologies":[]}\n${componentHelp}\n${catalogHelp}`, links: [{ label: 'Back', page: `components_${project.id}_0` }] }
        : { kind: 'Project unavailable', text: 'That Project was not found.' };
    }
    const list = /^(technologies|hosts|tools)_(\d{1,6})$/.exec(destination);
    const components = /^(components|techcomponents|hostingentries|hostentries|projecttools)_([^_]+)_(\d{1,6})$/.exec(destination);
    const lookup = /^cataloglookup_([^_]+)_(\d{1,6})$/.exec(destination);
    if (list || lookup || components) {
      const saved = lookup ? await this.store.savedLookup(actor, lookup[1]!) : undefined;
      if (lookup && !saved) return { kind: 'Lookup unavailable', text: 'Repeat the exact lookup for fresh choices.' };
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
      if ((componentId && !component) || (serviceId && !service)) return { kind: 'Relationships unavailable', text: 'That Component or Host/service was not found.' };
      if ((parentId && !parent) || (technologyId && !technology)) return { kind: 'Relationships unavailable', text: 'That parent or Technology was not found.' };
      const result = await this.store.records(actor, kind, Number(list?.[2] ?? lookup?.[2] ?? components?.[3]), saved?.selector ?? null, kind === 'tool' ? null : parentId ?? componentId, kind === 'tool' ? parentId : technologyId ?? serviceId);
      const lines = await Promise.all(result.records.map(async record => {
        const project = record.kind === 'component' ? await this.store.project(actor, String(record.fields.projectId)) : undefined;
        const hostingParent = kind === 'hosting' ? await this.store.record(actor, 'component', String(record.fields.componentId)) : undefined;
        return `${literal(referenceLabel(recordName(record), record))} — ${record.id}${project ? ` · Project: ${literal(referenceLabel(project.fields.name, project))} (${project.id})` : ''}${hostingParent ? ` · Component: ${literal(referenceLabel(recordName(hostingParent), hostingParent))} (${hostingParent.id})` : ''}`;
      }));
      const prefix = saved ? `cataloglookup_${lookup![1]}` : components ? `${components[1]}_${components[2]}` : list![1]!;
      return { kind: saved ? `Choose a ${label}` : plural, text: `${saved ? 'This name is ambiguous. Choose one stable identifier.\n' : ''}${parent ? `Project: ${literal(referenceLabel(parent.fields.name, parent))} (${parent.id})\n` : technology ? `Technology: ${literal(referenceLabel(String(technology.fields.name), technology))} (${technology.id})\n` : ''}page ${result.page + 1}/${result.pages} · ${result.total} ${plural}\n${lines.join('\n') || `No ${plural} have been saved.`}`,
        links: [...result.records.map(record => ({ label: referenceLabel(recordName(record), record), page: saved?.destination.startsWith('history') ? `history${kind}_${record.id}_0` : `${kind}_${record.id}` })),
          ...pages(prefix, result.page, result.pages), ...(kind === 'technology' ? [{ label: 'Add Technology', page: 'addtechnology' }] : kind === 'tool' ? [{ label: 'Add Tool', page: 'addtool' }] : kind === 'host' ? [{ label: 'Add Host/service', page: 'addhost' }] : parent ? [{ label: 'Add Component', page: `addcomponent_${parent.id}` }] : component ? [{ label: 'Add Hosting entry', page: `addhosting_${component.id}` }] : []),
          { label: 'Back', page: parent ? `project_${parent.id}` : technology ? `technology_${technology.id}` : component ? `component_${component.id}` : service ? `host_${service.id}` : 'main' }] };
    }
    const detail = /^(technology|component|host|hosting|tool|edittechnology|editcomponent|edithost|edithosting|edittool)_([^_]+)$/.exec(destination);
    const history = /^history(technology|component|host|hosting|tool)_([^_]+)_(\d{1,6})$/.exec(destination);
    if (detail || history) {
      const kind = (history?.[1] ?? detail![1]!.replace(/^edit/, '')) as RecordKind, label = title(kind);
      const id = detail?.[2] ?? history![2]!;
      const record = await this.store.record(actor, kind, id);
      if (!record) return { kind: `${label} unavailable`, text: `That ${label} was not found.`, links: [{ label: 'Back', page: 'main' }] };
      if (detail?.[1]?.startsWith('edit') && record.archived) return { kind: 'Edit requires restoration', text: `${label}: ${id}\nStatus: Archived\nExplicitly restore this record before editing.`, buttons: lifecycleButton(kind, record), links: [{ label: `Back to ${label}`, page: `${kind}_${id}` }] };
      if (detail?.[1]?.startsWith('edit')) return { kind: `Edit ${label}`, text: `${label}: ${literal(recordName(record))} (${id})\nUse documentation edit ${kind} ${id} ${exampleFor(kind)}\n${helpFor(kind)}`, links: [{ label: `Back to ${label}`, page: `${kind}_${id}` }] };
      if (history) {
        const result = await this.store.recordHistory(actor, kind, id, Number(history[3]));
        return { kind: `${label} history`, text: `${label}: ${literal(recordName(record))} (${id})\n${statusText(record)}\nHistory page ${result.page + 1}/${result.pages}\n${result.changes.map(change => `${label} identifier: ${change.record_id}\nActor: ${literal(change.actor)}\nTime: ${new Date(change.changed_at).toISOString()}\nSource: ${literal(change.source)}\n${change.before_values === null ? 'Before: No record' : `Before:\n${inventoryText(change.before_values)}`}\nAfter:\n${inventoryText(change.after_values)}`).join('\n') || 'No changes have been saved.'}`,
          links: [...pages(`history${kind}_${id}`, result.page, result.pages), { label: `Back to ${label}`, page: `${kind}_${id}` }] };
      }
      const technologies = kind === 'component' && Array.isArray(record.fields.technologies)
        ? await Promise.all(record.fields.technologies.map(ref => this.store.record(actor, 'technology', ref))) : [];
      const service = kind === 'hosting' ? await this.store.record(actor, 'host', String(record.fields.serviceId)) : undefined;
      const parentProject = kind === 'component' ? await this.store.project(actor, String(record.fields.projectId)) : undefined;
      const parentComponent = kind === 'hosting' ? await this.store.record(actor, 'component', String(record.fields.componentId)) : undefined;
      const projects = kind === 'tool' && Array.isArray(record.fields.projects)
        ? await Promise.all(record.fields.projects.map(ref => this.store.project(actor, ref))) : [];
      return { kind: label, text: `Identifier: ${id}\n${statusText(record)}\n${inventoryText(record.fields)}${service ? `\nHost/service: ${literal(recordName(service))} (${service.id})${service.archived ? ' [Archived]' : ''}` : ''}${parentProject ? `\nProject: ${literal(referenceLabel(parentProject.fields.name, parentProject))} (${parentProject.id})` : ''}${parentComponent ? `\nComponent: ${literal(referenceLabel(recordName(parentComponent), parentComponent))} (${parentComponent.id})` : ''}`,
        buttons: lifecycleButton(kind, record),
        resourceLinks: Array.isArray(record.fields.urls) ? record.fields.urls.map(url => ({ label: `Saved URL: ${url}`, url })) : [],
        links: [...(!record.archived ? [{ label: 'Edit', page: `edit${kind}_${id}` }] : []), { label: 'History', page: `history${kind}_${id}_0` },
        ...(kind === 'tool' ? [...projects.filter(ref => !!ref).map(ref => ({ label: referenceLabel(ref.fields.name, ref), page: `project_${ref.id}` })), { label: 'Back to Tools', page: 'tools_0' }] : kind === 'host' ? [{ label: 'Hosting entries', page: `hostentries_${id}_0` }, { label: 'Back to Hosts/services', page: 'hosts_0' }] :
          kind === 'hosting' ? [{ label: 'Component', page: `component_${record.fields.componentId}` }, ...(service ? [{ label: referenceLabel(recordName(service), service), page: `host_${service.id}` }] : []), { label: 'Back to Hosting entries', page: `hostingentries_${record.fields.componentId}_0` }] :
          kind === 'technology' ? [{ label: 'Components', page: `techcomponents_${id}_0` }, { label: 'Back to Technologies', page: 'technologies_0' }] : [
          { label: 'Hosting entries', page: `hostingentries_${id}_0` },
          { label: 'Project', page: `project_${record.fields.projectId}` }, ...technologies.filter(ref => !!ref).map(ref => ({ label: referenceLabel(String(ref.fields.name), ref), page: `technology_${ref.id}` })),
          { label: 'Back to Components', page: `components_${record.fields.projectId}_0` },
        ])] };
    }
    return undefined;
  }
  async handle(actor: Actor, payload: Record<string, unknown>, eventId: string,
    deliver: (message: AgentMessage) => Promise<void>, show: (destination: string) => Promise<void>, source = 'Slack structured'): Promise<boolean> {
    const action = /^confirm_(create|edit)_(technology|component|host|hosting|tool)$/.exec(String(payload.action));
    if (payload.type === 'action' && action) {
      const operation = action[1] as 'create' | 'edit', kind = action[2] as RecordKind, label = title(kind);
      const saved = typeof payload.value === 'string' ? await this.store.confirmRecord(actor, payload.value, kind, operation) : undefined;
      if (!saved || saved.record_kind !== kind || saved.operation !== operation) await deliver({ kind: 'Confirmation unavailable', text: 'This confirmation does not belong to this User and DM, or is unavailable.' });
      else if (saved.outcome === 'archived') await deliver({ kind: 'Edit requires restoration', text: `${label} ${saved.target_id} is archived. Explicitly restore it, then retry this confirmation within its original 24-hour window.` });
      else if (!saved.applied_at) await deliver({ kind: 'Confirmation expired', text: `Submit a fresh documentation ${operation} ${kind} request.` });
      else await deliver({ kind: saved.outcome === 'missing' || saved.outcome === 'invalid' ? `${label} ${operation} failed` : saved.outcome === 'satisfied' ? 'Edit already satisfied' : `${label} ${operation === 'create' ? 'created' : 'edited'}`,
        buttons: outcomeButtons(saved.id),
        text: `Saved outcome for ${label}: ${saved.target_id}\n${saved.outcome === 'missing' || saved.outcome === 'invalid' ? 'The target, fields or references were invalid or unavailable at confirmation. Nothing was changed.' : saved.outcome === 'satisfied' ? 'The selected fields already matched; no change or history entry was added.' : `Approved values saved once:\n${inventoryText(saved.fields)}\nLater edits may have changed current values.`}\nUse documentation ${lookupCommand(kind)} ${saved.target_id} to inspect current values.` });
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
        } catch { await deliver({ kind: `Invalid ${label}${operation === 'edit' ? ' edit' : ''}`, text: `Choose one record and one valid JSON object of supported fields.\n${helpFor(kind)}` }); return true; }
        if (selector !== undefined) {
          const result = await this.store.lookupRecord(actor, kind, selector);
          if (result.total !== 1) {
            await deliver({ kind: result.total ? `Ambiguous ${label} edit` : `${label} not found`, text: result.total ? `Inspect documentation ${kind} <exact name> and repeat with one stable identifier. Nothing was proposed.` : `No ${label} matches that exact identifier or name.` }); return true;
          }
          target = result.records[0]!;
          if (target.archived) { await deliver({ kind: 'Edit requires restoration', text: `This ${label} is archived. Explicitly restore it before editing.` }); return true; }
        }
        if (kind === 'tool' && Array.isArray(fields.projects)) {
          const ids: string[] = [];
          for (const selector of fields.projects) {
            const result = await this.store.lookup(actor, selector);
            if (result.total !== 1) {
              await deliver({ kind: result.total ? 'Ambiguous Project reference' : 'Project not found', text: result.total ? `Project ${literal(selector)} is ambiguous. Inspect documentation project ${literal(selector)} and repeat with a stable identifier. Nothing was proposed.` : `Project ${literal(selector)} was not found in this workspace. Create it with documentation create project in a separate confirmed operation, then repeat this request. Nothing was proposed.` }); return true;
            }
            ids.push(result.projects[0]!.id);
          }
          fields.projects = [...new Set(ids)];
        }
        if (kind === 'component') {
          if (operation === 'create' && !await this.store.project(actor, String(fields.projectId))) {
            await deliver({ kind: 'Project not found', text: 'Use an existing Project identifier from this workspace. Create a missing Project in a separate confirmed operation.' }); return true;
          }
          if (Array.isArray(fields.technologies)) {
            const ids: string[] = [];
            for (const selector of fields.technologies) {
              const result = await this.store.lookupRecord(actor, 'technology', selector);
              if (result.total !== 1) {
                await deliver({ kind: result.total ? 'Ambiguous Technology reference' : 'Technology not found', text: result.total ? `Technology ${literal(selector)} is ambiguous. Inspect documentation technology ${literal(selector)} and repeat with a stable identifier. Nothing was proposed.` : `Technology ${literal(selector)} was not found in this workspace. Create it with documentation create technology in a separate confirmed operation, then repeat this request. Nothing was proposed.` }); return true;
              }
              ids.push(result.records[0]!.id);
            }
            fields.technologies = [...new Set(ids)];
          }
        }
        if (kind === 'hosting') {
          if (operation === 'create' && !await this.store.record(actor, 'component', String(fields.componentId))) {
            await deliver({ kind: 'Component not found', text: 'Use an existing Component identifier from this workspace. Create a missing Component in a separate confirmed operation.' }); return true;
          }
          if (typeof fields.serviceId === 'string') {
            const result = await this.store.lookupRecord(actor, 'host', fields.serviceId);
            if (result.total !== 1) {
              await deliver({ kind: result.total ? 'Ambiguous Host/service reference' : 'Host/service not found', text: result.total ? 'Inspect documentation host <exact name> and repeat with one stable identifier. Nothing was proposed.' : 'Create the missing Host/service with documentation create host in a separate confirmed operation, then repeat this request. Nothing was proposed.' }); return true;
            }
            fields.serviceId = result.records[0]!.id;
          }
        }
        if (kind === 'host' && !recordSchemas.host.create.safeParse({ ...target?.fields, ...fields }).success) {
          await deliver({ kind: 'Invalid Host/service edit', text: `A known monthly cost requires an explicit currency.\n${hostHelp}` }); return true;
        }
        if (!validSavedFields(kind, operation as 'create' | 'edit', fields)) {
          await deliver({ kind: `Invalid ${label}${operation === 'edit' ? ' edit' : ''}`, text: `The normalized fields and resolved identifiers exceed the allowed constraints.\n${helpFor(kind)}` }); return true;
        }
        try { proposal = await this.store.proposeRecord(actor, eventId, kind, fields, target, source); }
        catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('Inventory target or references changed')) throw error;
          await deliver({ kind: 'Relationships unavailable', text: error.message }); return true;
        }
      }
      await deliver({ kind: `${operation === 'create' ? 'Create' : 'Edit'} ${label} confirmation`, text: `${operation === 'create' ? 'Create' : 'Edit'} shared ${label}: ${proposal.target_id}\n${inventoryText(proposal.fields)}\nOnly approved fields change; intervening edits are overwritten and unrelated fields remain. Only you can confirm in this DM. Expires: ${new Date(new Date(proposal.created_at).getTime() + 24 * 3600_000).toISOString()}. Nothing is saved until you confirm.`, buttons: [{ label: operation === 'create' ? 'Confirm creation' : 'Confirm edit', action: `confirm_${operation}_${kind}`, value: proposal.id, style: 'primary' }] });
      return true;
    }
    const list = /^(technologies|hosts|tools)(?:\s+(\d{1,6}))?$/i.exec(text);
    if (list) { await show(`${list[1]!.toLowerCase()}_${list[2] ?? '0'}`); return true; }
    const hosting = /^hosting\s+([\s\S]+)$/i.exec(text);
    if (hosting) {
      const { result, page } = await pagedLookup(hosting[1]!, selector => this.store.lookupRecord(actor, 'component', selector));
      if (result.total === 1) await show(`hostingentries_${result.records[0]!.id}_${page}`);
      else if (result.total > 1) await deliver({ kind: 'Ambiguous Component', text: 'Inspect documentation component <exact name> and repeat with one stable identifier.' });
      else await deliver({ kind: 'Component not found', text: 'No Component matches that exact identifier or name.' });
      return true;
    }
    const components = /^components\s+([\s\S]+)$/i.exec(text);
    if (components) {
      const { selector, result, page } = await pagedLookup(components[1]!, selector => this.store.lookup(actor, selector));
      if (result.total === 1) await show(`components_${result.projects[0]!.id}_${page}`);
      else if (result.total > 1) await show(`lookup_${await this.store.saveLookup(actor, eventId, selector, 'components')}_0`);
      else await deliver({ kind: 'Project not found', text: 'No Project matches that exact identifier, name or alias.' });
      return true;
    }
    const lookup = /^(technology|component|host|tool|hosting-entry|history technology|history component|history host|history tool|history hosting-entry)\s+([\s\S]+)$/i.exec(text);
    if (lookup) {
      const destination = lookup[1]!.toLowerCase().replace(' ', '').replace('hosting-entry', 'hosting'), kind = (destination.replace(/^history/, '')) as RecordKind;
      const selector = lookup[2]!.trim(), result = await this.store.lookupRecord(actor, kind, selector);
      if (result.total === 1) await show(`${destination}_${result.records[0]!.id}${destination.startsWith('history') ? '_0' : ''}`);
      else if (result.total > 1) await show(`cataloglookup_${await this.store.saveLookup(actor, eventId, selector, destination)}_0`);
      else await deliver({ kind: `${title(kind)} not found`, text: `No ${title(kind)} matches that exact identifier or name.` });
      return true;
    }
    return false;
  }
}
