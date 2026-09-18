import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Budget, BudgetExceeded, OpenAI, costMicro, type Intelligence } from '../src/ai.js';
import { emptyState, starterRules, uid, type Actor, type Mail, type Rule } from '../src/domain.js';
import { Engine } from '../src/engine.js';
import type { Mailbox, Mutation } from '../src/gmail.js';
import { schema, Store, type Sql } from '../src/store.js';
import type { AgentMessage, Messenger } from '../src/slack.js';

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
function harness(mailbox = new FakeMailbox(), decision: 'yes' | 'uncertain' = 'yes', extras: { converse?: Intelligence['converse']; alertMicro?: number } = {}) {
  const messages: Array<AgentMessage & { actor: Actor }> = [];
  const messenger: Messenger = { async send(actor, message) { messages.push({ actor, ...message }); } };
  const seen: unknown[] = [];
  const intelligence: Intelligence = {
    async converse(actor, text, context) {
      if (extras.converse) return extras.converse(actor, text, context);
      seen.push(context); return { intent: 'reply', reply: `Received ${text}`, rule: null, ruleId: null, runId: null, messageId: null, correction: null };
    },
    async classify(_actor, _mail, rules) { return rules.map(r => ({ ruleId: r.id, decision, reason: 'Time-sensitive request' })); },
  };
  const budget = new Budget(sql);
  const engine = new Engine({ store, messenger, intelligence, budget, mailbox: () => mailbox, connectUrl: async () => 'https://agent.example.com/auth/google?ticket=test', alertMicro: extras.alertMicro });
  return { engine, mailbox, messages, seen, budget };
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
    expect(requests[0].instructions).toMatch(/standard markdown in reply/i);
    expect(requests[0].instructions).toMatch(/not Slack mrkdwn/i);
    expect(requests[0].instructions).toMatch(/Do not mention people or channels/i);
    expect(requests[0].instructions).toMatch(/do not include links/i);
    expect(requests[0].instructions).toMatch(/never claim actions were executed/i);
    expect(requests[0].instructions).toMatch(/Never layout a Preview, Details, Report/i);
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

describe('Help Card', () => {
  const expectHelpCard = (message: AgentMessage) => {
    expect(message.kind).toBe('Help');
    expect(message.text).toMatch(/connect/i);
    expect(message.text).toMatch(/starters/i);
    expect(message.text).toMatch(/rules/i);
    expect(message.text).toMatch(/sort/i);
    expect(message.text).toMatch(/report/i);
    expect(message.text).toMatch(/budget/i);
    expect(message.text).toMatch(/disconnect/i);
    expect(message.text).toMatch(/approv/i);
  };

  it('sends hi and help as a Card with kind header Help', async () => {
    for (const text of ['hi', 'help']) {
      const h = harness();
      await h.engine.handle(alice, { type: 'text', text }, uid());
      expectHelpCard(h.messages.at(-1)!);
    }
  });

  it('falls back to the Help Card when the model Reply is empty or missing', async () => {
    const empty = harness(undefined, 'yes', { converse: async () => ({ intent: 'reply', reply: '', rule: null, ruleId: null, runId: null, messageId: null, correction: null }) });
    await empty.engine.handle(alice, { type: 'text', text: 'What can you do?' }, uid());
    expectHelpCard(empty.messages.at(-1)!);

    const missing = harness(undefined, 'yes', { converse: async () => ({ intent: 'reply', reply: undefined as unknown as string, rule: null, ruleId: null, runId: null, messageId: null, correction: null }) });
    await missing.engine.handle(alice, { type: 'text', text: 'What can you do?' }, uid());
    expectHelpCard(missing.messages.at(-1)!);
  });
});

describe('Connection Cards', () => {
  it('sends connect as a Card titled Connect with the minted https authorization URL', async () => {
    const h = harness();
    await h.engine.handle(alice, { type: 'text', text: 'connect' }, uid());
    expect(h.messages.at(-1)).toMatchObject({
      kind: 'Connect',
      text: expect.stringContaining('https://agent.example.com/auth/google?ticket=test'),
    });
  });

  it('sends Confirm mailbox after OAuth with the existing Connect-this-mailbox and Cancel buttons', async () => {
    const h = harness();
    await h.engine.handle(alice, { type: 'connection', connection: { id: 'c1', subject: 'google-alice', email: 'alice@example.com', encryptedTokens: 'sealed' } }, uid());
    const message = h.messages.at(-1)!;
    expect(message.kind).toBe('Confirm mailbox');
    expect(message.text).toContain('alice@example.com');
    expect(message.buttons).toEqual([
      { label: 'Connect this mailbox', action: 'approve_draft', value: expect.any(String), style: 'primary' },
      { label: 'Cancel', action: 'cancel_draft', value: expect.any(String) },
    ]);
    expect(message.buttons![0]!.value).toBe(message.buttons![1]!.value);
  });

  it('sends disconnect as a Card titled Disconnect Gmail with the existing danger button', async () => {
    await seed();
    const h = harness();
    await h.engine.handle(alice, { type: 'text', text: 'disconnect' }, uid());
    expect(h.messages.at(-1)).toEqual({
      actor: alice,
      kind: 'Disconnect Gmail',
      text: 'Disconnect Gmail and cancel all pending previews? Saved rules remain. You can also revoke the app from your Google account.',
      buttons: [{ label: 'Disconnect Gmail', action: 'disconnect', value: 'connection-a', style: 'danger' }],
    });
  });

  it('keeps connected, cancelled, and disconnected acks as unlabeled Replies', async () => {
    const h = harness();
    await h.engine.handle(alice, { type: 'connection', connection: { id: 'c1', subject: 'google-alice', email: 'alice@example.com', encryptedTokens: 'sealed' } }, uid());
    const draftId = (await store.load(alice)).drafts[0]!.id;
    await action(h, 'approve_draft', draftId);
    expect(h.messages.at(-1)).toEqual({
      actor: alice,
      text: 'Connected alice@example.com. Send starters to review initial rules, or sort if your rules are ready.',
      buttons: undefined,
    });

    const cancelled = harness();
    await cancelled.engine.handle(alice, { type: 'connection', connection: { id: 'c2', subject: 'google-alice', email: 'alice@example.com', encryptedTokens: 'sealed' } }, uid());
    const cancelId = (await store.load(alice)).drafts[0]!.id;
    await action(cancelled, 'cancel_draft', cancelId);
    expect(cancelled.messages.at(-1)).toEqual({ actor: alice, text: 'Proposal cancelled.', buttons: undefined });

    await seed();
    const disconnect = harness();
    await disconnect.engine.handle(alice, { type: 'text', text: 'disconnect' }, uid());
    await action(disconnect, 'disconnect', 'connection-a');
    expect(disconnect.messages.at(-1)).toEqual({ actor: alice, text: 'Gmail disconnected here. Your saved rules remain.', buttons: undefined });
  });
});

describe('Agent Replies', () => {
  it('posts talk as a Reply with no kind header and stores the model string', async () => {
    const h = harness();
    await h.engine.handle(alice, { type: 'text', text: 'How do I sort?' }, uid());
    expect(h.messages).toEqual([{ actor: alice, text: 'Received How do I sort?', buttons: undefined }]);
    expect((await store.load(alice)).history.map(turn => turn.content)).toEqual(['How do I sort?', 'Received How do I sort?']);
  });
  it('posts unlabeled engine messages as Replies, not Cards', async () => {
    const h = harness();
    await h.engine.handle(alice, { type: 'text', text: 'budget' }, uid());
    expect(h.messages.at(-1)).toMatchObject({ text: expect.stringMatching(/^Team AI usage this UTC calendar month:/) });
    expect(h.messages.at(-1)!.kind).toBeUndefined();

    await seed();
    await h.engine.handle(alice, { type: 'text', text: 'sort' }, uid());
    expect(h.messages.find(m => m.text.startsWith('Checking '))!.kind).toBeUndefined();

    await h.engine.handle(alice, { type: 'text', text: 'starters' }, uid());
    expect(h.messages.at(-1)).toMatchObject({ text: expect.stringContaining('Project template:') });
    expect(h.messages.at(-1)!.kind).toBeUndefined();
    const draftId = (await store.load(alice)).drafts[0]!.id;
    await action(h, 'cancel_draft', draftId);
    expect(h.messages.at(-1)).toEqual({ actor: alice, text: 'Proposal cancelled.', buttons: undefined });

    const run = (await store.load(alice)).runs.at(-1)!;
    await action(h, 'not_a_real_action', run.id);
    expect(h.messages.at(-1)).toEqual({ actor: alice, text: 'Unsupported action.', buttons: undefined });

    await h.engine.handle(alice, { type: 'text', text: 'keep this', resolved: { intent: 'correction', reply: '', rule: null, ruleId: null, runId: run.id, messageId: 'm1', correction: { addLabels: [], removeLabels: [], disposition: 'keep' } } }, uid());
    expect(h.messages.at(-1)).toMatchObject({ text: 'This correction does not change future behavior. Tell me how the rule should change and I will propose it separately for approval.' });
    expect(h.messages.at(-1)!.kind).toBeUndefined();
  });
  it('posts errors and the spend alert as unlabeled Replies', async () => {
    const failing = harness(undefined, 'yes', { converse: async () => { throw new Error('provider exploded'); } });
    await failing.engine.handle(alice, { type: 'text', text: 'What can you do?' }, uid());
    expect(failing.messages.at(-1)).toMatchObject({ text: expect.stringMatching(/^This request could not finish/) });
    expect(failing.messages.at(-1)!.kind).toBeUndefined();

    const h = harness(undefined, 'yes', { alertMicro: 0 });
    await h.budget.reserve(alice, 1);
    await h.engine.handle(alice, { type: 'text', text: 'budget' }, uid());
    expect(h.messages.at(-1)).toMatchObject({ text: expect.stringContaining('The team AI allowance has reached its alert threshold') });
    expect(h.messages.at(-1)!.kind).toBeUndefined();
  });
});
