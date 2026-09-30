import type { Actor } from '../../core/identity.js';
import type { MenuPage } from '../../core/navigation.js';
import { escapeCardValue, type AgentMessage } from '../../core/slack.js';
import { technologyEdit, technologyFields, componentEdit, componentFields, type InventoryRecord, type InventoryValues, type RecordKind } from './domain.js';
import type { DocumentationStore } from './store.js';

const literal = escapeCardValue;
export const catalogHelp = 'Browse documentation technologies [page]; inspect documentation technology <identifier or exact name>; read documentation history technology <identifier or exact name>. Create one Technology with documentation create technology {"name":"React","category":"Frontend","notes":"Example"}. Edit with documentation edit technology <identifier or exact name> {"category":null,"notes":"Replacement"}. Supported Technology fields: name (required, one line, 120 characters), category (120 characters), notes (1,500 characters). Optional values may be null (Unknown) or empty. Creation and editing require your separate confirmation within 24 hours. Selected fields overwrite intervening edits and preserve unrelated fields. No AI or Gmail is used.';
export const componentHelp = 'Browse documentation components <Project identifier, exact name or alias> [page]; inspect documentation component <identifier or exact name>; read documentation history component <identifier or exact name>. Create one Component with documentation create component {"name":"Frontend","projectId":"<Project identifier>","type":"frontend","technologies":["<Technology identifier or exact name>"]}. Supported Component fields: name (required, one line, 120 characters), type (optional, 120 characters), technologies (optional, at most 20 existing Technology identifiers or exact names). Creation requires the stable Project identifier as projectId. The parent cannot be changed. Edit with documentation edit component <identifier or exact name> {"type":"API","technologies":null}. Null clears optional values to Unknown; [] records no Technologies. Ambiguous names require a stable identifier. Missing Technologies require separate confirmed creation; relationship edits never create them. Hosting is a later slice.';
export const inventoryText = (fields: InventoryValues) => Object.entries(fields).map(([key, value]) => `${key}: ${value === null ? 'Unknown' : literal(Array.isArray(value) ? JSON.stringify(value) : value)}`).join('\n');
const title = (kind: RecordKind) => kind === 'technology' ? 'Technology' : 'Component';
const pages = (prefix: string, page: number, count: number) => [
  ...(page > 0 ? [{ label: 'Previous', page: `${prefix}_${page - 1}` }] : []),
  ...(page + 1 < count ? [{ label: 'Next', page: `${prefix}_${page + 1}` }] : []),
];
function editBody(body: string) {
  for (const boundary of [...body.matchAll(/\s+(?=\{)/g)].reverse()) {
    try { return { selector: body.slice(0, boundary.index).trim(), value: JSON.parse(body.slice(boundary.index + boundary[0].length)) }; }
    catch { continue; }
  }
  throw new Error('Expected one target and a JSON object');
}

// Catalog navigation shares the Module's existing private menus and transport
// recovery. Every selector is re-read within the actor's workspace.
export class Catalog {
  constructor(private store: DocumentationStore) {}
  async page(actor: Actor, destination: string): Promise<MenuPage | undefined> {
    if (destination === 'addtechnology') return { kind: 'Add Technology', text: catalogHelp, links: [{ label: 'Back', page: 'technologies_0' }] };
    const addComponent = /^addcomponent_([^_]+)$/.exec(destination);
    if (addComponent) {
      const project = await this.store.project(actor, addComponent[1]!);
      return project ? { kind: 'Add Component', text: `Project: ${literal(project.fields.name)} (${project.id})\nUse documentation create component {"name":"Frontend","projectId":"${project.id}","type":"frontend","technologies":[]}\n${componentHelp}\n${catalogHelp}`, links: [{ label: 'Back', page: `components_${project.id}_0` }] }
        : { kind: 'Project unavailable', text: 'That Project was not found.' };
    }
    const list = /^technologies_(\d{1,6})$/.exec(destination);
    const components = /^(components|techcomponents)_([^_]+)_(\d{1,6})$/.exec(destination);
    const lookup = /^cataloglookup_([^_]+)_(\d{1,6})$/.exec(destination);
    if (list || lookup || components) {
      const saved = lookup ? await this.store.savedLookup(actor, lookup[1]!) : undefined;
      if (lookup && !saved) return { kind: 'Lookup unavailable', text: 'Repeat the exact lookup for fresh choices.' };
      const kind: RecordKind = components || saved?.destination.includes('component') ? 'component' : 'technology';
      const label = title(kind), plural = kind === 'technology' ? 'Technologies' : 'Components';
      const parentId = components?.[1] === 'components' ? components[2]! : null;
      const technologyId = components?.[1] === 'techcomponents' ? components[2]! : null;
      const parent = parentId ? await this.store.project(actor, parentId) : undefined;
      const technology = technologyId ? await this.store.record(actor, 'technology', technologyId) : undefined;
      if ((parentId && !parent) || (technologyId && !technology)) return { kind: 'Relationships unavailable', text: 'That parent or Technology was not found.' };
      const result = await this.store.records(actor, kind, Number(list?.[1] ?? lookup?.[2] ?? components?.[3]), saved?.selector ?? null, parentId, technologyId);
      const lines = await Promise.all(result.records.map(async record => {
        const project = record.kind === 'component' ? await this.store.project(actor, String(record.fields.projectId)) : undefined;
        return `${literal(String(record.fields.name))} — ${record.id}${project ? ` · Project: ${literal(project.fields.name)} (${project.id})` : ''}`;
      }));
      const prefix = saved ? `cataloglookup_${lookup![1]}` : components ? `${components[1]}_${components[2]}` : 'technologies';
      return { kind: saved ? `Choose a ${label}` : plural, text: `${saved ? 'This name is ambiguous. Choose one stable identifier.\n' : ''}${parent ? `Project: ${literal(parent.fields.name)} (${parent.id})\n` : technology ? `Technology: ${literal(String(technology.fields.name))} (${technology.id})\n` : ''}page ${result.page + 1}/${result.pages} · ${result.total} ${plural}\n${lines.join('\n') || `No ${plural} have been saved.`}`,
        links: [...result.records.map(record => ({ label: String(record.fields.name), page: saved?.destination.startsWith('history') ? `history${kind}_${record.id}_0` : `${kind}_${record.id}` })),
          ...pages(prefix, result.page, result.pages), ...(kind === 'technology' ? [{ label: 'Add Technology', page: 'addtechnology' }] : parent ? [{ label: 'Add Component', page: `addcomponent_${parent.id}` }] : []),
          { label: 'Back', page: parent ? `project_${parent.id}` : technology ? `technology_${technology.id}` : 'main' }] };
    }
    const detail = /^(technology|component|edittechnology|editcomponent)_([^_]+)$/.exec(destination);
    const history = /^history(technology|component)_([^_]+)_(\d{1,6})$/.exec(destination);
    if (detail || history) {
      const kind = (history?.[1] ?? detail![1]!.replace(/^edit/, '')) as RecordKind, label = title(kind);
      const id = detail?.[2] ?? history![2]!;
      const record = await this.store.record(actor, kind, id);
      if (!record) return { kind: `${label} unavailable`, text: `That ${label} was not found.`, links: [{ label: 'Back', page: 'main' }] };
      if (detail?.[1]?.startsWith('edit')) return { kind: `Edit ${label}`, text: `${label}: ${literal(String(record.fields.name))} (${id})\nUse documentation edit ${kind} ${id} ${kind === 'technology' ? '{"notes":"Replacement"}' : '{"type":"API","technologies":[]}'}\n${kind === 'technology' ? catalogHelp : componentHelp}`, links: [{ label: `Back to ${label}`, page: `${kind}_${id}` }] };
      if (history) {
        const result = await this.store.recordHistory(actor, kind, id, Number(history[3]));
        return { kind: `${label} history`, text: `${label}: ${literal(String(record.fields.name))} (${id})\nHistory page ${result.page + 1}/${result.pages}\n${result.changes.map(change => `${label} identifier: ${change.record_id}\nActor: ${literal(change.actor)}\nTime: ${new Date(change.changed_at).toISOString()}\nSource: ${literal(change.source)}\n${change.before_values === null ? 'Before: No record' : `Before:\n${inventoryText(change.before_values)}`}\nAfter:\n${inventoryText(change.after_values)}`).join('\n') || 'No changes have been saved.'}`,
          links: [...pages(`history${kind}_${id}`, result.page, result.pages), { label: `Back to ${label}`, page: `${kind}_${id}` }] };
      }
      const technologies = kind === 'component' && Array.isArray(record.fields.technologies)
        ? await Promise.all(record.fields.technologies.map(ref => this.store.record(actor, 'technology', ref))) : [];
      return { kind: label, text: `Identifier: ${id}\n${inventoryText(record.fields)}`, links: [{ label: 'Edit', page: `edit${kind}_${id}` }, { label: 'History', page: `history${kind}_${id}_0` },
        ...(kind === 'technology' ? [{ label: 'Components', page: `techcomponents_${id}_0` }, { label: 'Back to Technologies', page: 'technologies_0' }] : [
          { label: 'Project', page: `project_${record.fields.projectId}` }, ...technologies.filter(ref => !!ref).map(ref => ({ label: String(ref.fields.name), page: `technology_${ref.id}` })),
          { label: 'Back to Components', page: `components_${record.fields.projectId}_0` },
        ])] };
    }
    return undefined;
  }
  async handle(actor: Actor, payload: Record<string, unknown>, eventId: string,
    deliver: (message: AgentMessage) => Promise<void>, show: (destination: string) => Promise<void>): Promise<boolean> {
    const action = /^confirm_(create|edit)_(technology|component)$/.exec(String(payload.action));
    if (payload.type === 'action' && action) {
      const operation = action[1] as 'create' | 'edit', kind = action[2] as RecordKind, label = title(kind);
      const saved = typeof payload.value === 'string' ? await this.store.confirmRecord(actor, payload.value, kind, operation) : undefined;
      if (!saved || saved.record_kind !== kind || saved.operation !== operation) await deliver({ kind: 'Confirmation unavailable', text: 'This confirmation does not belong to this User and DM, or is unavailable.' });
      else if (!saved.applied_at) await deliver({ kind: 'Confirmation expired', text: `Submit a fresh documentation ${operation} ${kind} request.` });
      else await deliver({ kind: saved.outcome === 'missing' || saved.outcome === 'invalid' ? `${label} ${operation} failed` : saved.outcome === 'satisfied' ? 'Edit already satisfied' : `${label} ${operation === 'create' ? 'created' : 'edited'}`,
        text: `Saved outcome for ${label}: ${saved.target_id}\n${saved.outcome === 'missing' || saved.outcome === 'invalid' ? 'The target, fields or references were invalid or unavailable at confirmation. Nothing was changed.' : saved.outcome === 'satisfied' ? 'The selected fields already matched; no change or history entry was added.' : `Approved values saved once:\n${inventoryText(saved.fields)}\nLater edits may have changed current values.`}\nUse documentation ${kind} ${saved.target_id} to inspect current values.` });
      return true;
    }
    if (payload.type !== 'text') return false;
    const text = String(payload.text ?? '').trim();
    const mutation = /^(create|edit) (technology|component)\s+([\s\S]+)$/i.exec(text);
    if (mutation) {
      const operation = mutation[1]!.toLowerCase();
      const kind = mutation[2]!.toLowerCase() as RecordKind, label = title(kind);
      let proposal = await this.store.request(actor, eventId);
      if (!proposal) {
        let fields: InventoryValues, target: InventoryRecord | undefined, selector: string | undefined;
        try {
          if (operation === 'create') fields = (kind === 'technology' ? technologyFields : componentFields).parse(JSON.parse(mutation[3]!));
          else {
            const request = editBody(mutation[3]!); fields = (kind === 'technology' ? technologyEdit : componentEdit).parse(request.value); selector = request.selector;
          }
        } catch { await deliver({ kind: `Invalid ${label}${operation === 'edit' ? ' edit' : ''}`, text: `Choose one record and one valid JSON object of supported fields.\n${kind === 'technology' ? catalogHelp : componentHelp}` }); return true; }
        if (selector !== undefined) {
          const result = await this.store.lookupRecord(actor, kind, selector);
          if (result.total !== 1) {
            await deliver({ kind: result.total ? `Ambiguous ${label} edit` : `${label} not found`, text: result.total ? `Inspect documentation ${kind} <exact name> and repeat with one stable identifier. Nothing was proposed.` : `No ${label} matches that exact identifier or name.` }); return true;
          }
          target = result.records[0]!;
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
        try { proposal = await this.store.proposeRecord(actor, eventId, kind, fields, target); }
        catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('Inventory target or references changed')) throw error;
          await deliver({ kind: 'Relationships unavailable', text: error.message }); return true;
        }
      }
      await deliver({ kind: `${operation === 'create' ? 'Create' : 'Edit'} ${label} confirmation`, text: `${operation === 'create' ? 'Create' : 'Edit'} shared ${label}: ${proposal.target_id}\n${inventoryText(proposal.fields)}\nOnly approved fields change; intervening edits are overwritten and unrelated fields remain. Only you can confirm in this DM. Expires: ${new Date(new Date(proposal.created_at).getTime() + 24 * 3600_000).toISOString()}. Nothing is saved until you confirm.`, buttons: [{ label: operation === 'create' ? 'Confirm creation' : 'Confirm edit', action: `confirm_${operation}_${kind}`, value: proposal.id, style: 'primary' }] });
      return true;
    }
    const list = /^technologies(?:\s+(\d{1,6}))?$/i.exec(text);
    if (list) { await show(`technologies_${list[1] ?? '0'}`); return true; }
    const components = /^components\s+([\s\S]+)$/i.exec(text);
    if (components) {
      let selector = components[1]!.trim(), result = await this.store.lookup(actor, selector), page = '0';
      const paged = /^([\s\S]+)\s+(\d{1,6})$/.exec(selector);
      if (!result.total && paged) { selector = paged[1]!.trim(); page = paged[2]!; result = await this.store.lookup(actor, selector); }
      if (result.total === 1) await show(`components_${result.projects[0]!.id}_${page}`);
      else if (result.total > 1) await show(`lookup_${await this.store.saveLookup(actor, eventId, selector, 'components')}_0`);
      else await deliver({ kind: 'Project not found', text: 'No Project matches that exact identifier, name or alias.' });
      return true;
    }
    const lookup = /^(technology|component|history technology|history component)\s+([\s\S]+)$/i.exec(text);
    if (lookup) {
      const destination = lookup[1]!.toLowerCase().replace(' ', ''), kind = (destination.replace(/^history/, '')) as RecordKind;
      const selector = lookup[2]!.trim(), result = await this.store.lookupRecord(actor, kind, selector);
      if (result.total === 1) await show(`${destination}_${result.records[0]!.id}${destination.startsWith('history') ? '_0' : ''}`);
      else if (result.total > 1) await show(`cataloglookup_${await this.store.saveLookup(actor, eventId, selector, destination)}_0`);
      else await deliver({ kind: `${title(kind)} not found`, text: `No ${title(kind)} matches that exact identifier or name.` });
      return true;
    }
    return false;
  }
}
