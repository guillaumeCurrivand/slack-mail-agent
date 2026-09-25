import { Budget, BudgetExceeded, budgetReport } from '../../core/budget.js';
import type { Intelligence, Intent } from './ai.js';
import { availableRuleProposal, currentPreview, labelSchema, ownerKey, planMessage, sameLabels, starterRules, uid, validateRule, type Actor, type Connection, type Draft, type Item, type Run, type UserState } from './domain.js';
import type { Mailbox } from './gmail.js';
import { escapeCardValue, SlackDeliveryRejected, type Button, type Messenger } from '../../core/slack.js';
import { prune, Store } from './store.js';

export const SORT_OPERATION = 'sort';
export type Event = { type: 'text'; text: string; resolved?: Intent; activeOperation?: string } | { type: 'action'; action: string; value: string } | { type: 'connection'; connection: Connection };
export type EngineDependencies = {
  store: Store; intelligence: Intelligence; messenger: Messenger; budget: Budget;
  mailbox: (actor: Actor, state: UserState) => Mailbox;
  connectUrl: (actor: Actor) => Promise<string>;
  admitSort?: (actor: Actor, eventId: string) => Promise<string>;
};
const HELP = 'I can sort your latest 100 inbox messages after you approve a preview.\nCommands: mail connect, mail starters, mail rules, mail sort, mail report, mail details <run-id> <page>, mail disconnect.\nStart every request with mail, including natural language: “mail Label emails from alex@example.com as Projects/Alpha.” Rule changes also need approval. Use the buttons on a preview to confirm, cancel, inspect or undo. Shared commands: help, budget.';

export class Engine {
  constructor(private d: EngineDependencies) {}
  private send(actor: Actor, text: string, buttons?: Button[]) { return this.d.messenger.send(actor, { text, buttons }); }
  private sendCard(actor: Actor, kind: string, text: string, buttons?: Button[]) { return this.d.messenger.send(actor, { kind, text, buttons }); }
  private sendHelp(actor: Actor) { return this.sendCard(actor, 'Help', HELP); }
  async handle(actor: Actor, event: Event, eventId: string) {
    const state = await this.d.store.load(actor);
    if (state.handled.includes(eventId)) return;
    if (event.type === 'action' && ['menu_add_rule', 'menu_edit_rule', 'menu_latest_report', 'reopen_draft', 'reopen_preview', 'details', 'report'].includes(event.action)) {
      // Only delivery bookkeeping is persisted for reads; prune a private copy
      // afterward so browsing cannot delete or renew saved domain records.
      state.handled = [...state.handled, eventId].slice(-2000); await this.d.store.save(actor, state);
      prune(state);
      try { await this.action(actor, state, event.action, event.value); }
      catch (error) {
        if (error instanceof SlackDeliveryRejected) {
          const saved = await this.d.store.load(actor);
          saved.handled = saved.handled.filter(id => id !== eventId);
          await this.d.store.save(actor, saved);
        }
        throw error;
      }
      return;
    }
    prune(state);
    try {
      if (event.type === 'connection') {
        const draft: Draft = { id: uid(), created: new Date().toISOString(), kind: 'connection', connection: event.connection };
        state.drafts.push(draft); await this.d.store.save(actor, state);
        await this.sendCard(actor, 'Confirm mailbox', `Confirm that ${event.connection.email} is YOUR Google Workspace mailbox. Connecting replaces any previous connection and invalidates old previews.`, [{ label: 'Connect this mailbox', action: 'approve_draft', value: draft.id, style: 'primary' }, { label: 'Cancel', action: 'cancel_draft', value: draft.id }]);
      } else if (event.type === 'action') await this.action(actor, state, event.action, event.value);
      else await this.text(actor, state, event, eventId);
      state.handled.push(eventId); await this.d.store.save(actor, state);
    } catch (error) {
      // Do not expose provider payloads, tokens, email content, database errors, or raw stack traces.
      console.error('job failed', error instanceof Error ? error.message : 'unknown');
      const message = error instanceof BudgetExceeded ? error.message : 'This request could not finish. No additional changes will be attempted automatically. Use mail report to inspect any completed or uncertain actions, then try again or reconnect if authorization expired.';
      await this.send(actor, message);
      state.handled.push(eventId); await this.d.store.save(actor, state);
    }
  }
  private async text(actor: Actor, state: UserState, event: Extract<Event, { type: 'text' }>, eventId: string) {
    const text = event.text.trim(), command = text.toLowerCase();
    if (command === 'help' || command === 'hi' || command === 'hello') return this.sendHelp(actor);
    if (command === 'disconnect') {
      return this.sendCard(actor, 'Disconnect Gmail', 'Disconnect Gmail and cancel all pending previews? Saved rules remain. You can also revoke the app from your Google account.', [{ label: 'Disconnect Gmail', action: 'disconnect', value: state.connection?.id ?? 'none', style: 'danger' }]);
    }
    if (/^details [\w-]+(?: \d+)?$/.test(command)) {
      const [, id, page] = command.split(' '); return this.details(actor, state, id!, Number(page ?? 0));
    }
    const quick: Record<string, Intent['intent']> = { connect: 'connect', 'connect gmail': 'connect', starters: 'starters', rules: 'rules', sort: 'sort', 'sort my inbox': 'sort', 'sort my mail': 'sort', report: 'report', budget: 'budget' };
    let intent: Intent;
    if (quick[command]) intent = { intent: quick[command]!, reply: '', rule: null, ruleId: null, runId: null, messageId: null, correction: null };
    else if (event.resolved) intent = event.resolved;
    else {
      intent = await this.d.intelligence.converse(actor, text, {
        rules: state.rules, history: state.history.slice(-20), connected: Boolean(state.connection),
        runs: state.runs.slice(-3).map(r => ({ id: r.id, status: r.status, messages: r.items.slice(0, 100).map(i => ({ id: i.id, subject: i.subject.slice(0, 120), plan: i.plan, status: i.status })) })),
      });
      // Persist the interpretation before acting so a worker restart doesn't pay to reinterpret it.
      await this.d.store.sql.query("UPDATE jobs SET payload=jsonb_set(payload,'{resolved}',$2::jsonb) WHERE id=$1 AND owner=$3", [eventId, JSON.stringify(intent), ownerKey(actor)]);
    }
    state.history.push({ role: 'user', content: text.slice(0, 4000), at: new Date().toISOString() });
    switch (intent.intent) {
      case 'connect': return this.sendCard(actor, 'Connect', `Connect your own Google Workspace mailbox using this single-use link (expires in 10 minutes):\n${await this.d.connectUrl(actor)}`);
      case 'starters': {
        await this.propose(actor, state, { kind: 'rules', rules: starterRules() });
        return this.send(actor, 'Project template: when the sender matches an approved mapping, apply Projects/<project name> and keep it in the inbox. Start your reply with mail, then give the project name and sender email addresses to create your mapping.');
      }
      case 'rules': return this.sendCard(actor, 'Your rules', state.rules.length ? state.rules.map(r => `${escapeCardValue(r.name)} [${escapeCardValue(r.id)}]\n${escapeCardValue(r.condition)}\nSenders: ${r.senders.length ? r.senders.map(escapeCardValue).join(', ') : 'semantic matching'}\nLabels: ${r.labels.length ? r.labels.map(escapeCardValue).join(', ') : 'none'}; action: ${r.action}`).join('\n\n') : 'You have no approved rules. Send mail starters or describe your first rule after the mail prefix.');
      case 'budget': return this.send(actor, await budgetReport(this.d.budget));
      case 'sort': {
        const original = event.activeOperation ?? (this.d.admitSort ? await this.d.admitSort(actor, eventId) : eventId);
        if (original !== eventId) return this.sendCard(actor, 'Work in progress', `Your Sort inbox request was already in progress when this message arrived. Existing request: ${original}.`);
        return this.scan(actor, state, eventId);
      }
      case 'report': return this.report(actor, state, intent.runId ?? state.runs.at(-1)?.id);
      case 'propose_rule': {
        if (!intent.rule) return this.send(actor, 'Please start your reply with mail and describe the condition, labels, action and any exceptions.');
        if (intent.ruleId && !state.rules.some(r => r.id === intent.ruleId)) return this.send(actor, 'That rule is not in your saved rules.');
        return this.propose(actor, state, { kind: 'rules', rules: [validateRule(intent.rule)], ...(intent.ruleId ? { replaceId: intent.ruleId } : {}) });
      }
      case 'delete_rule': {
        if (!intent.ruleId || !state.rules.some(r => r.id === intent.ruleId)) return this.send(actor, 'Choose a rule from your rules list.');
        return this.propose(actor, state, { kind: 'delete', ruleId: intent.ruleId });
      }
      case 'correction': return this.correction(actor, state, intent);
      default:
        state.history.push({ role: 'assistant', content: intent.reply, at: new Date().toISOString() });
        return intent.reply ? this.send(actor, intent.reply) : this.sendHelp(actor);
    }
  }
  private async propose(actor: Actor, state: UserState, value: Omit<Draft, 'id' | 'created'>) {
    const draft: Draft = { ...value, id: uid(), created: new Date().toISOString() };
    state.drafts.push(draft); await this.d.store.save(actor, state);
    return this.showDraft(actor, state, draft);
  }
  private showDraft(actor: Actor, state: UserState, draft: Draft) {
    const description = draft.kind === 'delete' ? `Remove rule ${escapeCardValue(state.rules.find(r => r.id === draft.ruleId)?.name ?? '')}?` :
      `${draft.replaceId ? 'Replace existing rule with' : 'Proposed rules'}:\n\n${draft.rules!.map(r => `${escapeCardValue(r.name)}\n${escapeCardValue(r.condition)}\n${r.senders.length ? `Senders: ${r.senders.map(escapeCardValue).join(', ')}\n` : ''}Labels: ${r.labels.length ? r.labels.map(escapeCardValue).join(', ') : 'none'}; action: ${r.action}\nExamples: ${r.examples.map(escapeCardValue).join(' | ')}`).join('\n\n')}`;
    return this.sendCard(actor, draft.kind === 'delete' ? 'Remove rule' : 'Rule proposal', `${description}\n\nNo rule changes until you approve.`, [{ label: 'Approve rule changes', action: 'approve_draft', value: draft.id, style: 'primary' }, { label: 'Cancel', action: 'cancel_draft', value: draft.id }]);
  }
  private async action(actor: Actor, state: UserState, action: string, value: string) {
    if (action === 'menu_add_rule') return this.send(actor, 'Start your reply with mail and describe the condition, labels, action and exceptions. I will propose a rule with examples for your approval.');
    if (action === 'menu_edit_rule') {
      const rule = state.rules.find(rule => rule.id === value);
      return this.send(actor, rule ? `To edit ${escapeCardValue(rule.name)}, reply: mail change rule ${escapeCardValue(rule.id)} followed by your desired condition, labels, action and exceptions. Changes need separate approval.` : 'That rule is no longer available in your account. Open Manage rules again.');
    }
    if (action === 'menu_latest_report') return this.report(actor, state,
      state.runs.findLast(run => run.status === 'done' || run.status === 'undone')?.id);
    if (action === 'menu_starters') return this.propose(actor, state, { kind: 'rules', rules: starterRules() });
    if (action === 'menu_remove_rule') {
      if (!state.rules.some(rule => rule.id === value)) return this.send(actor, 'That rule is no longer available in your account. Open Manage rules again.');
      return this.propose(actor, state, { kind: 'delete', ruleId: value });
    }
    if (action === 'reopen_draft') {
      const draft = state.drafts.find(draft => draft.id === value && availableRuleProposal(state, draft));
      return draft ? this.showDraft(actor, state, draft) : this.send(actor, 'This proposal is unavailable, expired or already handled. Open Pending approvals again.');
    }
    if (action === 'reopen_preview') {
      const run = state.runs.find(run => run.id === value && run.status === 'preview' && currentPreview(state, run));
      return run ? this.preview(actor, run) : this.send(actor, 'This preview is unavailable, expired, or its connection/rules changed. Open Pending approvals or send mail sort for a new preview.');
    }
    if (action === 'approve_draft' || action === 'cancel_draft') {
      const draft = state.drafts.find(d => d.id === value);
      if (!draft) return this.send(actor, 'This proposal is unavailable or already handled.');
      if (action === 'approve_draft' && draft.kind !== 'connection' && !availableRuleProposal(state, draft)) return this.send(actor, 'This proposal is no longer current. Open Manage rules to propose it again.');
      if (action === 'approve_draft') {
        if (draft.kind === 'connection') {
          state.connection = draft.connection; state.runs.forEach(r => { if (r.status === 'preview' || r.status === 'scanning') r.status = 'cancelled'; });
        } else {
          if (draft.kind === 'delete') state.rules = state.rules.filter(r => r.id !== draft.ruleId);
          else {
            const additions = draft.rules!.map(r => ({ ...validateRule(r), id: draft.replaceId ?? uid() }));
            if (draft.replaceId && !state.rules.some(r => r.id === draft.replaceId)) return this.send(actor, 'The original rule no longer exists. Please propose it again.');
            const next = [...state.rules.filter(r => r.id !== draft.replaceId), ...additions];
            if (next.length > 40) return this.send(actor, 'Version one supports up to 40 rules per user. Remove or combine rules first.');
            state.rules = next;
          }
          state.ruleVersion++;
        }
      }
      state.drafts = state.drafts.filter(d => d.id !== value);
      await this.d.store.save(actor, state);
      return this.send(actor, action === 'cancel_draft' ? 'Proposal cancelled.' : draft.kind === 'connection' ? `Connected ${state.connection!.email}. Send mail starters to review initial rules, or mail sort if your rules are ready.` : 'Your rule changes are saved. Send mail sort to create a mailbox preview.');
    }
    if (action === 'disconnect') {
      if (value !== state.connection?.id) return this.send(actor, 'This disconnect request is no longer current.');
      delete state.connection; state.drafts = state.drafts.filter(d => d.kind !== 'connection');
      state.runs.forEach(r => { if (['preview', 'scanning'].includes(r.status)) r.status = 'cancelled'; });
      await this.d.store.save(actor, state); return this.send(actor, 'Gmail disconnected here. Your saved rules remain.');
    }
    const [runId, extra, page] = value.split(':');
    const run = state.runs.find(r => r.id === runId);
    if (!run) return this.send(actor, 'This run is not available in your account.');
    if (action === 'details') return this.details(actor, state, run.id, Number(extra ?? 0));
    if (action === 'report') return this.report(actor, state, run.id);
    if (action === 'cancel_run') {
      if (run.status === 'preview') run.status = 'cancelled';
      await this.d.store.save(actor, state); return this.send(actor, `Run status: ${run.status}.`);
    }
    if (action === 'accept_item' || action === 'skip_item') {
      if (run.status !== 'preview') return this.send(actor, 'This preview can no longer be edited.');
      const item = run.items.find(i => i.id === extra);
      if (item && item.plan.needsDecision) {
        if (action === 'accept_item') item.plan.needsDecision = false;
        else item.status = 'skipped';
        await this.d.store.save(actor, state);
      }
      return this.details(actor, state, run.id, Number(page ?? 0));
    }
    if (action === 'confirm_run') return this.apply(actor, state, run);
    if (action === 'undo_run') return this.undo(actor, state, run);
    return this.send(actor, 'Unsupported action.');
  }
  private connected(actor: Actor, state: UserState): Mailbox {
    if (!state.connection) throw new Error('Connect Gmail first.');
    return this.d.mailbox(actor, state);
  }
  private async scan(actor: Actor, state: UserState, sourceId: string) {
    if (!state.connection) return this.send(actor, 'Connect Gmail first: send mail connect.');
    if (!state.rules.length) return this.send(actor, 'Approve at least one rule first: send mail starters or describe a rule after the mail prefix.');
    const mailbox = this.connected(actor, state);
    let run = state.runs.find(r => r.sourceId === sourceId);
    if (!run) {
      run = { id: uid(), sourceId, created: new Date().toISOString(), ruleVersion: state.ruleVersion, connectionId: state.connection.id, status: 'scanning', items: [], messageIds: await mailbox.list() };
      state.runs.push(run); await this.d.store.save(actor, state);
      await this.send(actor, `Checking ${run.messageIds!.length} inbox messages. I will send a preview before making any changes.`);
    }
    if (run.status !== 'scanning') return this.preview(actor, run);
    for (const id of run.messageIds!) {
      if (run.items.some(i => i.id === id)) continue;
      const mail = await mailbox.read(id);
      let matches;
      try { matches = await this.d.intelligence.classify(actor, mail, state.rules.filter(r => r.kind === 'semantic')); }
      catch (error) { if (error instanceof BudgetExceeded) { run.status = 'cancelled'; await this.d.store.save(actor, state); throw error; } throw error; }
      run.items.push({ id, from: mail.from, subject: mail.subject, before: mail.labels, historyId: mail.historyId, plan: planMessage(mail, state.rules, matches), status: 'pending' });
      await this.d.store.save(actor, state);
    }
    const existing = await mailbox.labels();
    run.newLabels = [...new Set(run.items.flatMap(i => i.plan.labels))].filter(name => !existing.some(l => l.name === name));
    run.status = 'preview'; await this.d.store.save(actor, state);
    return this.preview(actor, run);
  }
  private preview(actor: Actor, run: Run) {
    const actionable = run.items.filter(i => !i.plan.needsDecision && i.status === 'pending');
    const newLabelText = run.newLabels?.length ? run.newLabels.map(escapeCardValue).join(', ') : 'none';
    return this.sendCard(actor, 'Preview', `Run ${escapeCardValue(run.id)}\n\n- ${run.items.length} messages reviewed\n- Labels proposed on ${actionable.filter(i => i.plan.labels.length || i.plan.removeLabels?.length).length}\n- archive ${actionable.filter(i => i.plan.disposition === 'archive').length}\n- TRASH ${actionable.filter(i => i.plan.disposition === 'trash').length}\n- Needs your decision: ${run.items.filter(i => i.plan.needsDecision && i.status === 'pending').length}. These are excluded unless you explicitly include them.\n- New labels: ${newLabelText}\n\nReview message details before confirming. No changes yet.`, [
      { label: 'Review messages', action: 'details', value: `${run.id}:0` },
      { label: 'Confirm proposed changes', action: 'confirm_run', value: run.id, style: 'primary' },
      { label: 'Cancel', action: 'cancel_run', value: run.id },
    ]);
  }
  private details(actor: Actor, state: UserState, id: string, page = 0) {
    const run = state.runs.find(r => r.id === id);
    if (!run) return this.send(actor, 'Run not found in your account.');
    page = Number.isFinite(page) ? Math.max(0, Math.min(Math.floor(page), Math.max(0, Math.ceil(run.items.length / 5) - 1))) : 0;
    const items = run.items.slice(page * 5, page * 5 + 5), buttons: Button[] = [];
    const text = items.map((i, n) => {
      if (run.status === 'preview' && i.plan.needsDecision && i.status === 'pending') buttons.push({ label: `Include proposal ${n + 1}`, action: 'accept_item', value: `${id}:${i.id}:${page}` }, { label: `Leave ${n + 1} unchanged`, action: 'skip_item', value: `${id}:${i.id}:${page}` });
      return `${n + 1}. ${escapeCardValue(i.subject) || '(no subject)'}\nFrom: ${escapeCardValue(i.from)}\nMessage: ${escapeCardValue(i.id)}\n${i.plan.needsDecision ? 'NEEDS YOUR DECISION — ' : ''}${escapeCardValue(i.plan.disposition.toUpperCase())}; add labels: ${i.plan.labels.length ? i.plan.labels.map(escapeCardValue).join(', ') : 'none'}; remove: ${i.plan.removeLabels?.length ? i.plan.removeLabels.map(escapeCardValue).join(', ') : 'none'}\n${i.plan.reasons.map(escapeCardValue).join('\n')}\nStatus: ${escapeCardValue(i.status)}${i.note ? ` — ${escapeCardValue(i.note)}` : ''}`;
    }).join('\n\n');
    if (page > 0) buttons.push({ label: 'Previous', action: 'details', value: `${id}:${page - 1}` });
    if ((page + 1) * 5 < run.items.length) buttons.push({ label: 'Next', action: 'details', value: `${id}:${page + 1}` });
    if (run.status === 'preview') buttons.push({ label: 'Confirm reviewed proposal', action: 'confirm_run', value: id, style: 'primary' });
    return this.sendCard(actor, 'Details', `Run ${escapeCardValue(id)} — page ${page + 1}/${Math.max(1, Math.ceil(run.items.length / 5))}\n\n${text || 'No messages.'}`, buttons);
  }
  private async apply(actor: Actor, state: UserState, run: Run) {
    if (!['preview', 'applying'].includes(run.status)) return this.report(actor, state, run.id);
    if (!currentPreview(state, run)) {
      run.status = 'cancelled'; await this.d.store.save(actor, state);
      return this.send(actor, 'This preview expired or its connection/rules changed. Send mail sort for a new preview.');
    }
    const mailbox = this.connected(actor, state);
    run.status = 'applying'; await this.d.store.save(actor, state);
    for (const item of run.items) {
      if (item.status === 'prepared') { item.status = 'unknown'; item.note = 'Worker stopped during a mutation. Inspect Gmail; this change will not be replayed or automatically undone.'; await this.d.store.save(actor, state); continue; }
      if (item.status !== 'pending') continue;
      if (item.plan.needsDecision) { item.status = 'skipped'; item.note = 'No explicit decision for this uncertain match.'; await this.d.store.save(actor, state); continue; }
      try {
        const labelIds = [];
        for (const label of item.plan.labels) labelIds.push(await mailbox.ensureLabel(label));
        const knownLabels = await mailbox.labels();
        const removeIds = (item.plan.removeLabels ?? []).map(name => knownLabels.find(l => l.name === name)?.id).filter((id): id is string => Boolean(id));
        const current = await mailbox.snapshot(item.id);
        if (!sameLabels(current.labels, item.before) || current.historyId !== item.historyId) { item.status = 'conflict'; item.note = 'Message changed after preview; left unchanged.'; await this.d.store.save(actor, state); continue; }
        const add = [...new Set([...labelIds, ...(item.plan.disposition === 'trash' ? ['TRASH'] : []), ...(run.correction && item.plan.disposition === 'keep' ? ['INBOX'] : [])])].filter(l => !current.labels.includes(l));
        const remove = [...new Set([...removeIds, ...(item.plan.disposition !== 'keep' ? ['INBOX'] : []), ...(run.correction && item.plan.disposition !== 'trash' ? ['TRASH'] : [])])].filter(l => current.labels.includes(l) && !add.includes(l));
        if (!add.length && !remove.length) { item.status = 'skipped'; item.note = 'Already matches the approved plan.'; await this.d.store.save(actor, state); continue; }
        item.add = add; item.remove = remove; item.status = 'prepared'; await this.d.store.save(actor, state);
        const after = await mailbox.mutate(item.id, { kind: 'labels', add, remove });
        item.after = after.labels; item.afterHistory = after.historyId; item.status = 'applied';
      } catch {
        item.note = item.status === 'prepared' ? 'Mutation outcome is uncertain. Inspect Gmail before taking further action.' : 'Message could not be prepared; left unchanged.';
        item.status = item.status === 'prepared' ? 'unknown' : 'conflict';
      }
      await this.d.store.save(actor, state);
    }
    run.status = 'done'; await this.d.store.save(actor, state); return this.report(actor, state, run.id);
  }
  private async undo(actor: Actor, state: UserState, run: Run) {
    if (!['done', 'undoing'].includes(run.status) || run.connectionId !== state.connection?.id) return this.send(actor, 'This run cannot be undone with your current connection.');
    const mailbox = this.connected(actor, state); run.status = 'undoing'; await this.d.store.save(actor, state);
    for (const item of run.items) {
      if (item.status === 'undo_prepared') { item.status = 'unknown'; item.note = 'Worker stopped during undo; inspect Gmail.'; await this.d.store.save(actor, state); continue; }
      if (item.status !== 'applied') continue;
      try {
        const current = await mailbox.snapshot(item.id);
        if (!sameLabels(current.labels, item.after ?? []) || current.historyId !== item.afterHistory) { item.note = 'Undo skipped: message changed since this run.'; await this.d.store.save(actor, state); continue; }
        item.status = 'undo_prepared'; await this.d.store.save(actor, state);
        await mailbox.mutate(item.id, { kind: 'labels', add: item.remove, remove: item.add });
        item.status = 'undone'; item.note = 'Restored only this agent’s recorded label changes.';
      } catch { item.note = 'Undo could not be confirmed; inspect Gmail.'; item.status = 'unknown'; }
      await this.d.store.save(actor, state);
    }
    run.status = 'undone'; await this.d.store.save(actor, state); return this.report(actor, state, run.id);
  }
  private report(actor: Actor, state: UserState, id?: string) {
    const run = state.runs.find(r => r.id === id);
    if (!run) return this.send(actor, 'No retained run is available.');
    const counts = new Map<string, number>(); for (const item of run.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    return this.sendCard(actor, 'Report', `Run ${escapeCardValue(run.id)}: ${escapeCardValue(run.status)}\n${[...counts].map(([s, n]) => `- ${escapeCardValue(s)}: ${n}`).join('\n')}\nUnknown outcomes require inspecting Gmail. Undo skips messages changed since the agent acted.`, [
      { label: 'Details', action: 'details', value: `${run.id}:0` },
      ...(run.status === 'done' ? [{ label: 'Undo this run', action: 'undo_run', value: run.id } as Button] : []),
    ]);
  }
  private async correction(actor: Actor, state: UserState, intent: Intent) {
    const original = state.runs.find(r => r.id === intent.runId), item = original?.items.find(i => i.id === intent.messageId);
    if (!item || !intent.correction || original?.connectionId !== state.connection?.id) return this.send(actor, 'Specify a message ID and run ID from your report, and what should change.');
    const correction = intent.correction;
    const labels = correction.addLabels.map(x => labelSchema.parse(x)), removeLabels = correction.removeLabels.map(x => labelSchema.parse(x));
    const current = await this.connected(actor, state).read(item.id);
    const run: Run = { id: uid(), created: new Date().toISOString(), ruleVersion: state.ruleVersion, connectionId: state.connection!.id, status: 'preview', correction: true,
      items: [{ id: item.id, from: current.from, subject: current.subject, before: current.labels, historyId: current.historyId, status: 'pending', plan: { labels, removeLabels, disposition: correction.disposition, needsDecision: false, reasons: ['One-message correction requested by you. Saved rules are unchanged.'] } }] };
    const existing = await this.connected(actor, state).labels(); run.newLabels = labels.filter(name => !existing.some(l => l.name === name));
    state.runs.push(run); await this.d.store.save(actor, state);
    await this.preview(actor, run);
    return this.send(actor, 'This correction does not change future behavior. Start your reply with mail and describe how the rule should change; I will propose it separately for approval.');
  }
}
