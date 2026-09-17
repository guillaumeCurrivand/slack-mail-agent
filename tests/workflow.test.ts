import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Budget, BudgetExceeded, OpenAI, costMicro, type Intelligence } from '../src/ai.js';
import { emptyState, starterRules, uid, type Actor, type Mail, type Rule } from '../src/domain.js';
import { Engine } from '../src/engine.js';
import type { Mailbox, Mutation } from '../src/gmail.js';
import { schema, Store, type Sql } from '../src/store.js';
import type { Button, Messenger } from '../src/slack.js';

const alice: Actor = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
const bob: Actor = { team: 'TTEAM', user: 'UBOB', channel: 'DBOB' };
let db: PGlite, sql: Sql, store: Store;
beforeAll(async () => { db = new PGlite(); await db.exec(schema); sql = { query: (text, values) => db.query(text, values) }; store = new Store(sql); });
beforeEach(async () => { await db.exec('TRUNCATE users,jobs,oauth_states,ai_calls,ai_months CASCADE'); });
afterAll(async () => db.close());

class FakeMailbox implements Mailbox {
  mails = new Map<string, Mail>(); labelList = [{ id: 'LURGENT', name: 'Urgent' }]; mutations: { id: string; mutation: Mutation }[] = []; failAfterWrite = false;
  constructor() { this.mails.set('m1', { id: 'm1', from: 'alex@example.com', subject: 'Please act today', body: 'Please approve today.', labels: ['INBOX'], historyId: '1' }); }
  async list() { return [...this.mails.keys()]; }
  async read(id: string) { const mail = this.mails.get(id); if (!mail) throw new Error('Not found'); return structuredClone(mail); }
  async snapshot(id: string) { return this.read(id); }
  async labels() { return structuredClone(this.labelList); }
  async ensureLabel(name: string) { let label = this.labelList.find(l => l.name === name); if (!label) { label = { id: `L${this.labelList.length}`, name }; this.labelList.push(label); } return label.id; }
  async mutate(id: string, mutation: Mutation) {
    this.mutations.push({ id, mutation }); const mail = this.mails.get(id)!;
    mail.labels = [...new Set([...mail.labels.filter(l => !mutation.remove?.includes(l)), ...(mutation.add ?? [])])]; mail.historyId = String(Number(mail.historyId) + 1);
    if (this.failAfterWrite) throw new Error('Connection lost after write');
    return this.snapshot(id);
  }
}
function harness(mailbox = new FakeMailbox(), decision: 'yes' | 'uncertain' = 'yes') {
  const messages: { actor: Actor; text: string; buttons?: Button[] }[] = [];
  const messenger: Messenger = { async send(actor, text, buttons) { messages.push({ actor, text, buttons }); } };
  const seen: unknown[] = [];
  const intelligence: Intelligence = {
    async converse(_actor, text, context) { seen.push(context); return { intent: 'reply', reply: `Received ${text}`, rule: null, ruleId: null, runId: null, messageId: null, correction: null }; },
    async classify(_actor, _mail, rules) { return rules.map(r => ({ ruleId: r.id, decision, reason: 'Time-sensitive request' })); },
  };
  const budget = new Budget(sql);
  const engine = new Engine({ store, messenger, intelligence, budget, mailbox: () => mailbox, connectUrl: async () => 'https://agent.example.com/auth/google?ticket=test' });
  return { engine, mailbox, messages, seen };
}
async function seed(rules?: Rule[]) {
  const state = emptyState(); state.connection = { id: 'connection-a', email: 'alice@example.com', subject: 'google-alice', encryptedTokens: 'sealed' };
  state.rules = rules ?? [{ ...starterRules()[0]!, id: 'urgent' }]; await store.save(alice, state);
}
async function scan(h: ReturnType<typeof harness>) { await h.engine.handle(alice, { type: 'text', text: 'sort' }, uid()); return (await store.load(alice)).runs.at(-1)!; }
async function action(h: ReturnType<typeof harness>, action: string, value: string, actor = alice) { await h.engine.handle(actor, { type: 'action', action, value }, uid()); }

describe('approved mailbox workflow', () => {
  it('isolates contexts and prevents another user from approving a preview', async () => {
    await seed(); const h = harness(); const run = await scan(h);
    expect(h.mailbox.mutations).toHaveLength(0);
    await action(h, 'confirm_run', run.id, bob);
    expect(h.mailbox.mutations).toHaveLength(0);
    expect((await store.load(bob)).runs).toEqual([]);
    await h.engine.handle(bob, { type: 'text', text: 'What are my rules?' }, uid());
    expect(JSON.stringify(h.seen)).not.toContain('google-alice');
    expect(JSON.stringify(h.seen)).not.toContain('urgent');
    await action(h, 'confirm_run', run.id);
    expect(h.mailbox.mutations).toHaveLength(1);
    expect((await h.mailbox.read('m1')).labels).toEqual(['INBOX', 'LURGENT']);
    await action(h, 'confirm_run', run.id);
    expect(h.mailbox.mutations).toHaveLength(1);
  });
  it('requires explicit decisions for uncertain classifications', async () => {
    await seed(); const h = harness(undefined, 'uncertain'); const run = await scan(h);
    await action(h, 'confirm_run', run.id);
    expect(h.mailbox.mutations).toHaveLength(0);
    expect((await store.load(alice)).runs[0]!.items[0]!.status).toBe('skipped');
  });
  it('lets the owner explicitly include an uncertain proposal before confirming', async () => {
    await seed(); const h = harness(undefined, 'uncertain'); const run = await scan(h);
    await action(h, 'accept_item', `${run.id}:m1:0`);
    expect(h.mailbox.mutations).toHaveLength(0);
    await action(h, 'confirm_run', run.id);
    expect(h.mailbox.mutations).toHaveLength(1);
  });
  it('skips messages edited after preview', async () => {
    await seed(); const h = harness(); const run = await scan(h);
    h.mailbox.mails.get('m1')!.labels.push('STARRED'); h.mailbox.mails.get('m1')!.historyId = '2';
    await action(h, 'confirm_run', run.id);
    expect(h.mailbox.mutations).toHaveLength(0);
    expect((await store.load(alice)).runs[0]!.items[0]!.status).toBe('conflict');
  });
  it('invalidates a preview after rule changes', async () => {
    await seed(); const h = harness(); const run = await scan(h); const state = await store.load(alice); state.ruleVersion++; await store.save(alice, state);
    await action(h, 'confirm_run', run.id);
    expect(h.mailbox.mutations).toHaveLength(0);
    expect((await store.load(alice)).runs[0]!.status).toBe('cancelled');
  });
  it('restores only recorded changes on undo', async () => {
    await seed(); const h = harness(); const run = await scan(h);
    await action(h, 'confirm_run', run.id); await action(h, 'undo_run', run.id);
    expect((await h.mailbox.read('m1')).labels).toEqual(['INBOX']);
    expect(h.mailbox.mutations[1]!.mutation.remove).toEqual(['LURGENT']);
    await action(h, 'undo_run', run.id); expect(h.mailbox.mutations).toHaveLength(2);
  });
  it('does not overwrite a later Gmail edit during undo', async () => {
    await seed(); const h = harness(); const run = await scan(h); await action(h, 'confirm_run', run.id);
    h.mailbox.mails.get('m1')!.labels.push('STARRED'); h.mailbox.mails.get('m1')!.historyId = '3';
    await action(h, 'undo_run', run.id);
    expect(h.mailbox.mutations).toHaveLength(1); expect((await h.mailbox.read('m1')).labels).toContain('STARRED');
  });
  it('never replays an ambiguous write after a network failure', async () => {
    await seed(); const h = harness(); const run = await scan(h); h.mailbox.failAfterWrite = true;
    await action(h, 'confirm_run', run.id); await action(h, 'confirm_run', run.id);
    expect(h.mailbox.mutations).toHaveLength(1);
    expect((await store.load(alice)).runs[0]!.items[0]!.status).toBe('unknown');
  });
  it('does not replay a prepared mutation after a worker restart', async () => {
    await seed(); const h = harness(); const run = await scan(h); const state = await store.load(alice);
    state.runs[0]!.status = 'applying'; state.runs[0]!.items[0]!.status = 'prepared'; await store.save(alice, state);
    await action(h, 'confirm_run', run.id);
    expect(h.mailbox.mutations).toHaveLength(0); expect((await store.load(alice)).runs[0]!.items[0]!.status).toBe('unknown');
  });
  it('protects urgent mail from the starter newsletter Trash rule', async () => {
    await seed(starterRules().map(r => ({ ...r, id: r.name }))); const h = harness(); const run = await scan(h); await action(h, 'confirm_run', run.id);
    expect((await h.mailbox.read('m1')).labels).toEqual(['INBOX', 'LURGENT']);
  });
  it('never exposes Gmail credentials to the conversation model', async () => {
    await seed(); const h = harness(); await h.engine.handle(alice, { type: 'text', text: 'Help me organize projects' }, uid());
    expect(JSON.stringify(h.seen)).not.toContain('sealed'); expect(JSON.stringify(h.seen)).not.toContain('google-alice');
  });
  it('persists rule proposals without activating them until their owner approves', async () => {
    const h = harness(); await h.engine.handle(alice, { type: 'text', text: 'starters' }, uid());
    const before = await store.load(alice); expect(before.rules).toHaveLength(0); expect(before.drafts).toHaveLength(1);
    await action(h, 'approve_draft', before.drafts[0]!.id, bob); expect((await store.load(alice)).rules).toHaveLength(0);
    await action(h, 'approve_draft', before.drafts[0]!.id); expect((await store.load(alice)).rules).toHaveLength(2);
  });
});

describe('shared AI allowance', () => {
  it('validates a complete conversation response and accounts for its token usage', async () => {
    const budget = new Budget(sql); const requests: any[] = [];
    const answer = { intent: 'reply', reply: 'What project should this sender belong to?', rule: null, ruleId: null, runId: null, messageId: null, correction: null };
    const fakeFetch = (async (_url: any, options: any) => {
      requests.push(JSON.parse(options.body));
      return requests.length === 1 ? Response.json({ input_tokens: 200 }) : Response.json({ status: 'completed', usage: { input_tokens: 200, output_tokens: 30 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] });
    }) as typeof fetch;
    const ai = new OpenAI('fake', 'gpt-4.1-mini-2025-04-14', budget, fakeFetch);
    expect(await ai.converse(alice, 'Help with projects', {})).toEqual(answer);
    expect(requests[1].store).toBe(false);
    expect(requests[1].text.format.strict).toBe(true);
    expect(requests[1].text).toEqual(requests[0].text);
    expect(await budget.usage()).toEqual({ charged: 0.000128, reserved: 0 });
  });
  it('accounts for unsettled reservations across users and settles only once', async () => {
    const budget = new Budget(sql, 10_000_000); const first = await budget.reserve(alice, 9_000_000);
    await expect(budget.reserve(bob, 2_000_000)).rejects.toBeInstanceOf(BudgetExceeded);
    await budget.settle(first, 1_000_000); await budget.settle(first, 1_000_000);
    await budget.reserve(bob, 9_000_000);
    expect(await budget.usage()).toEqual({ charged: 1, reserved: 9 });
  });
  it('does not release a reservation when the provider fails without usage', async () => {
    const budget = new Budget(sql); let calls = 0;
    const fakeFetch = (async () => { calls++; return calls === 1 ? Response.json({ input_tokens: 100 }) : new Response('', { status: 500 }); }) as typeof fetch;
    const ai = new OpenAI('fake', 'gpt-4.1-mini-2025-04-14', budget, fakeFetch);
    await expect(ai.classify(alice, { id: 'x', from: 'a', subject: '', body: 'text', historyId: '1', labels: [] }, [{ ...starterRules()[0]!, id: 'urgent' }])).rejects.toThrow();
    expect((await budget.usage()).reserved).toBe(costMicro(100, 2048) / 1e6); expect(calls).toBe(2);
  });
  it('does not issue a paid generation when remaining allowance is insufficient', async () => {
    const budget = new Budget(sql, 1); let calls = 0;
    const fakeFetch = (async () => { calls++; return Response.json({ input_tokens: 100 }); }) as typeof fetch;
    const ai = new OpenAI('fake', 'gpt-4.1-mini-2025-04-14', budget, fakeFetch);
    await expect(ai.classify(alice, { id: 'x', from: 'a', subject: '', body: 'text', historyId: '1', labels: [] }, [{ ...starterRules()[0]!, id: 'urgent' }])).rejects.toBeInstanceOf(BudgetExceeded);
    expect(calls).toBe(1);
  });
});
