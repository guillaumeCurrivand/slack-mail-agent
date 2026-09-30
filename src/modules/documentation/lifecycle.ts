import type { Actor } from '../../core/identity.js';
import { Navigation, type MenuPage } from '../../core/navigation.js';
import { escapeCardValue, type AgentMessage } from '../../core/slack.js';
import { recordTitle, type RecordKind } from './domain.js';
import type { DocumentationStore } from './store.js';

export const lifecycleHelp = 'Browse documentation archived [page] for archived records. Request documentation archive <project|technology|component|host|hosting|tool> <identifier or exact name>, or documentation restore <kind> <identifier or exact name>. Project aliases also work; Hosting entries require identifiers. Each operation affects one record and requires your own saved confirmation in this DM within 24 hours. Archiving retains all relationships and history; restoration keeps the same identifier. Archived targets require restoration before editing. No permanent deletion or earlier-field-value restoration is available. No AI is used.';
export const statusText = (record: { archived: boolean }) => `Status: ${record.archived ? 'Archived' : 'Active'}`;
export const referenceLabel = (name: string, record: { archived: boolean }) => `${name}${record.archived ? ' [Archived]' : ''}`;
export function lifecycleButton(kind: 'project' | RecordKind, record: { id: string; archived: boolean }): NonNullable<MenuPage['buttons']> {
  return [{ label: record.archived ? 'Restore' : 'Archive', action: record.archived ? 'request_restore' : 'request_archive', value: `${kind}:${record.id}`, bound: true, ...(record.archived ? {} : { style: 'danger' as const }) }];
}

export class Lifecycle {
  constructor(private store: DocumentationStore) {}
  async page(actor: Actor, destination: string): Promise<MenuPage | undefined> {
    const match = /^archived_(\d{1,6})$/.exec(destination);
    if (!match) return;
    const result = await this.store.archived(actor, Number(match[1]));
    return { kind: 'Archived inventory', text: `page ${result.page + 1}/${result.pages} · ${result.total} archived records\n${result.records.map(record => `${recordTitle(record.kind)}: ${escapeCardValue(String(record.fields.name ?? record.fields.environment ?? 'Unknown environment'))} [Archived] — ${record.id}`).join('\n') || 'No archived records.'}`,
      links: [...result.records.map(record => ({ label: `${recordTitle(record.kind)}: ${String(record.fields.name ?? record.fields.environment ?? 'Unknown environment')}`, page: `${record.kind}_${record.id}` })),
        ...(result.page > 0 ? [{ label: 'Previous', page: `archived_${result.page - 1}` }] : []),
        ...(result.page + 1 < result.pages ? [{ label: 'Next', page: `archived_${result.page + 1}` }] : []), { label: 'Back', page: 'main' }] };
  }
  async handle(actor: Actor, payload: Record<string, unknown>, eventId: string, navigation: Navigation,
    deliver: (message: AgentMessage) => Promise<void>, show: (destination: string) => Promise<void>): Promise<boolean> {
    const confirm = /^confirm_(archive|restore)_(project|technology|component|host|hosting|tool)$/.exec(String(payload.action));
    if (payload.type === 'action' && confirm) {
      const operation = confirm[1] as 'archive' | 'restore', kind = confirm[2] as 'project' | RecordKind;
      const saved = typeof payload.value === 'string' ? await this.store.confirmLifecycle(actor, payload.value, kind, operation) : undefined;
      if (!saved || saved.record_kind !== kind || saved.operation !== operation) await deliver({ kind: 'Confirmation unavailable', text: 'This confirmation does not belong to this User and DM, or is unavailable.' });
      else if (!saved.applied_at) await deliver({ kind: 'Confirmation expired', text: `Submit a fresh documentation ${operation} ${kind} request.` });
      else await deliver({ kind: saved.outcome === 'missing' ? 'Lifecycle change failed' : saved.outcome === 'satisfied' ? 'Lifecycle already satisfied' : `${recordTitle(kind)} ${operation === 'archive' ? 'archived' : 'restored'}`,
        text: `Saved outcome for ${recordTitle(kind)}: ${saved.target_id}\n${saved.outcome === 'missing' ? 'The target was unavailable. Nothing changed.' : saved.outcome === 'satisfied' ? 'The requested lifecycle state already matched; no change or history entry was added.' : 'The approved lifecycle change was saved once. Later changes may have changed the current state.'}\nUse documentation ${kind === 'hosting' ? 'hosting-entry' : kind} ${saved.target_id} to inspect current state.` });
      return true;
    }
    let request: { operation: 'archive' | 'restore'; kind: 'project' | RecordKind; selector: string } | undefined;
    if (payload.type === 'menu_action' && ['request_archive', 'request_restore'].includes(String(payload.action))) {
      const bound = await navigation.boundTarget(actor, payload.value, payload.timestamp);
      const value = bound && /^(project|technology|component|host|hosting|tool):([^:]+)$/.exec(bound.value);
      if (!value) { await deliver({ kind: 'Menu unavailable', text: 'This private control is unavailable. Open the record again.' }); return true; }
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
        await deliver({ kind: result.total ? 'Ambiguous lifecycle target' : `${recordTitle(request.kind)} not found`, text: 'Inspect the exact record and repeat with one stable identifier. Nothing was proposed.' }); return true;
      }
      const target = 'projects' in result ? result.projects[0]! : result.records[0]!;
      proposal = await this.store.proposeLifecycle(actor, eventId, request.kind, target.id, request.operation);
    }
    const operation = proposal.operation === 'archive' ? 'archive' : 'restore';
    await deliver({ kind: `${operation === 'archive' ? 'Archive' : 'Restore'} ${recordTitle(proposal.record_kind)} confirmation`,
      text: `${operation === 'archive' ? 'Archive' : 'Restore'} shared ${recordTitle(proposal.record_kind)}: ${proposal.target_id}\nRelationships, identifier and complete history are retained. Only this record changes. Only you can confirm in this DM. Expires: ${new Date(new Date(proposal.created_at).getTime() + 24 * 3600_000).toISOString()}. Nothing is saved until you confirm.`,
      buttons: [{ label: `Confirm ${operation}`, action: `confirm_${operation}_${proposal.record_kind}`, value: proposal.id, style: operation === 'archive' ? 'danger' : 'primary' }] });
    return true;
  }
}
