import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Budget, BudgetExceeded, costMicro } from '../src/core/budget.js';
import { OpenAI, type Intelligence } from '../src/modules/mail/ai.js';
import { emptyState, starterRules, uid, type Actor, type Mail, type Rule } from '../src/modules/mail/domain.js';
import { Engine } from '../src/modules/mail/engine.js';
import type { Mailbox, Mutation } from '../src/modules/mail/gmail.js';
import { schema } from '../src/app/schema.js';
import { Store } from '../src/modules/mail/store.js';
import type { Sql } from '../src/core/store.js';
import { escapeCardValue, type AgentMessage, type Messenger } from '../src/core/slack.js';

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
function harness(mailbox = new FakeMailbox(), decision: 'yes' | 'uncertain' = 'yes', extras: { converse?: Intelligence['converse'] } = {}) {
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
  const engine = new Engine({ store, messenger, intelligence, budget, mailbox: () => mailbox, connectUrl: async () => 'https://agent.example.com/auth/google?ticket=test' });
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
    expect(message.kind).toBe("Aide");
    expect(message.text).toMatch(/connect/i);
    expect(message.text).toMatch(/modèles/i);
    expect(message.text).toMatch(/règles/i);
    expect(message.text).toMatch(/trier/i);
    expect(message.text).toMatch(/rapport/i);
    expect(message.text).toMatch(/budget/i);
    expect(message.text).toMatch(/déconnecter/i);
    expect(message.text).toMatch(/approbation/i);
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
      kind: "Connexion",
      text: expect.stringContaining('https://agent.example.com/auth/google?ticket=test'),
    });
  });

  it('sends Confirm mailbox after OAuth with the existing Connect-this-mailbox and Cancel buttons', async () => {
    const h = harness();
    await h.engine.handle(alice, { type: 'connection', connection: { id: 'c1', subject: 'google-alice', email: 'alice@example.com', encryptedTokens: 'sealed' } }, uid());
    const message = h.messages.at(-1)!;
    expect(message.kind).toBe("Confirmer la boîte e-mail");
    expect(message.text).toContain('alice@example.com');
    expect(message.buttons).toEqual([
      { label: "Connecter cette boîte", action: 'approve_draft', value: expect.any(String), style: 'primary' },
      { label: "Annuler", action: 'cancel_draft', value: expect.any(String) },
    ]);
    expect(message.buttons![0]!.value).toBe(message.buttons![1]!.value);
  });

  it('sends disconnect as a Card titled Disconnect Gmail with the existing danger button', async () => {
    await seed();
    const h = harness();
    await h.engine.handle(alice, { type: 'text', text: 'disconnect' }, uid());
    expect(h.messages.at(-1)).toEqual({
      actor: alice,
      kind: "Déconnecter Gmail",
      text: "Déconnecter Gmail et annuler tous les aperçus en attente ? Les règles enregistrées sont conservées. Vous pouvez aussi révoquer l’application depuis votre compte Google.",
      buttons: [{ label: "Déconnecter Gmail", action: 'disconnect', value: 'connection-a', style: 'danger' }],
    });
  });

  it('keeps connected, cancelled, and disconnected acks as unlabeled Replies', async () => {
    const h = harness();
    await h.engine.handle(alice, { type: 'connection', connection: { id: 'c1', subject: 'google-alice', email: 'alice@example.com', encryptedTokens: 'sealed' } }, uid());
    const draftId = (await store.load(alice)).drafts[0]!.id;
    await action(h, 'approve_draft', draftId);
    expect(h.messages.at(-1)).toEqual({
      actor: alice,
      text: "Connexion établie pour alice@example.com. Envoyez courrier modèles pour examiner les premières règles, ou courrier trier si vos règles sont prêtes.",
      buttons: undefined,
    });

    const cancelled = harness();
    await cancelled.engine.handle(alice, { type: 'connection', connection: { id: 'c2', subject: 'google-alice', email: 'alice@example.com', encryptedTokens: 'sealed' } }, uid());
    const cancelId = (await store.load(alice)).drafts[0]!.id;
    await action(cancelled, 'cancel_draft', cancelId);
    expect(cancelled.messages.at(-1)).toEqual({ actor: alice, text: "Proposition annulée.", buttons: undefined });

    await seed();
    const disconnect = harness();
    await disconnect.engine.handle(alice, { type: 'text', text: 'disconnect' }, uid());
    await action(disconnect, 'disconnect', 'connection-a');
    expect(disconnect.messages.at(-1)).toEqual({ actor: alice, text: "Gmail est déconnecté de l’application. Vos règles sont conservées.", buttons: undefined });
  });
});

describe('Rules Cards', () => {
  it('lists rules, including an empty list, as a Card titled Your rules', async () => {
    const empty = harness();
    await empty.engine.handle(alice, { type: 'text', text: 'rules' }, uid());
    expect(empty.messages.at(-1)).toMatchObject({
      kind: "Vos règles",
      text: "Vous n’avez aucune règle approuvée. Envoyez courrier modèles ou décrivez votre première règle après le préfixe courrier.",
    });

    await seed();
    const listed = harness();
    await listed.engine.handle(alice, { type: 'text', text: 'rules' }, uid());
    expect(listed.messages.at(-1)!.kind).toBe("Vos règles");
    expect(listed.messages.at(-1)!.text).toContain('Urgent');
    expect(listed.messages.at(-1)!.text).toContain('urgent');
  });

  const proposalRule = {
    name: 'Alpha', kind: 'sender' as const, category: 'project' as const, condition: 'Sender is Alex',
    senders: ['alex@example.com'], labels: ['Projects/Alpha'], action: 'keep' as const, examples: ['Alex matches'],
  };

  it('sends an add or replace Proposal as a Card titled Rule proposal with the existing Approve and Cancel buttons', async () => {
    const h = harness();
    await h.engine.handle(alice, { type: 'text', text: 'label mail from alex as Projects/Alpha', resolved: { intent: 'propose_rule', reply: '', rule: proposalRule, ruleId: null, runId: null, messageId: null, correction: null } }, uid());
    const message = h.messages.at(-1)!;
    expect(message.kind).toBe("Proposition de règle");
    expect(message.text).toContain('Alpha');
    expect(message.text).toMatch(/Aucune règle ne change avant votre approbation/);
    expect(message.buttons).toEqual([
      { label: "Approuver les règles", action: 'approve_draft', value: expect.any(String), style: 'primary' },
      { label: "Annuler", action: 'cancel_draft', value: expect.any(String) },
    ]);
    expect(message.buttons![0]!.value).toBe(message.buttons![1]!.value);

    await seed();
    const replace = harness();
    await replace.engine.handle(alice, { type: 'text', text: 'replace urgent', resolved: { intent: 'propose_rule', reply: '', rule: { ...starterRules()[0]!, name: 'Urgent mail' }, ruleId: 'urgent', runId: null, messageId: null, correction: null } }, uid());
    expect(replace.messages.at(-1)!.kind).toBe("Proposition de règle");
    expect(replace.messages.at(-1)!.text).toMatch(/Remplacer la règle existante/);
    expect(replace.messages.at(-1)!.buttons).toEqual([
      { label: "Approuver les règles", action: 'approve_draft', value: expect.any(String), style: 'primary' },
      { label: "Annuler", action: 'cancel_draft', value: expect.any(String) },
    ]);
  });

  it('sends a delete Proposal as a Card titled Remove rule with the existing Approve and Cancel buttons', async () => {
    await seed();
    const h = harness();
    await h.engine.handle(alice, { type: 'text', text: 'delete urgent', resolved: { intent: 'delete_rule', reply: '', rule: null, ruleId: 'urgent', runId: null, messageId: null, correction: null } }, uid());
    const message = h.messages.at(-1)!;
    expect(message.kind).toBe("Supprimer la règle");
    expect(message.text).toContain('Urgent');
    expect(message.buttons).toEqual([
      { label: "Approuver les règles", action: 'approve_draft', value: expect.any(String), style: 'danger' },
      { label: "Annuler", action: 'cancel_draft', value: expect.any(String) },
    ]);
    expect(message.buttons![0]!.value).toBe(message.buttons![1]!.value);
  });

  it('sends starters as a Rule proposal Card and then an unlabeled mapping follow-up', async () => {
    const h = harness();
    await h.engine.handle(alice, { type: 'text', text: 'starters' }, uid());
    expect(h.messages).toHaveLength(2);
    expect(h.messages[0]).toMatchObject({
      kind: "Proposition de règle",
      text: expect.stringMatching(/Aucune règle ne change avant votre approbation/),
      buttons: [
        { label: "Approuver les règles", action: 'approve_draft', value: expect.any(String), style: 'primary' },
        { label: "Annuler", action: 'cancel_draft', value: expect.any(String) },
      ],
    });
    expect(h.messages[1]).toEqual({
      actor: alice,
      text: "Modèle de projet : lorsque l’expéditeur correspond à une association approuvée, appliquez un libellé de projet et conservez le message dans la boîte de réception. Commencez votre réponse par courrier, puis indiquez le nom du projet et les adresses e-mail des expéditeurs.",
      buttons: undefined,
    });
    expect(h.messages[1]!.kind).toBeUndefined();
  });

  it('escapes interpolated rule name, condition, senders, labels, and examples so markdown stays literal', async () => {
    const state = emptyState();
    state.rules = [{
      id: 'promo', name: '**FREE**', category: 'custom', kind: 'sender',
      condition: 'See [click](http://evil)', senders: ['*alerts*@example.com'],
      labels: ['**Promo**'], action: 'keep', examples: ['[docs](http://evil)'],
    }];
    await store.save(alice, state);

    const listed = harness();
    await listed.engine.handle(alice, { type: 'text', text: 'rules' }, uid());
    const listedText = listed.messages.at(-1)!.text;
    expect(listedText).toContain('\\*\\*FREE\\*\\*');
    expect(listedText).not.toContain('**FREE**');
    expect(listedText).toContain('\\[click\\]\\(http://evil\\)');
    expect(listedText).not.toContain('[click](http://evil)');
    expect(listedText).toContain('\\*alerts\\*@example\\.com');
    expect(listedText).toContain('\\*\\*Promo\\*\\*');
    expect(listedText).not.toContain('**Promo**');

    const proposed = harness();
    await proposed.engine.handle(alice, { type: 'text', text: 'add promo rule', resolved: {
      intent: 'propose_rule', reply: '',
      rule: {
        name: '**FREE**', category: 'custom', kind: 'semantic', condition: 'See [click](http://evil)',
        senders: [], labels: ['**Promo**'], action: 'keep', examples: ['[docs](http://evil)'],
      },
      ruleId: null, runId: null, messageId: null, correction: null,
    } }, uid());
    const proposedText = proposed.messages.at(-1)!.text;
    expect(proposedText).toContain('\\*\\*FREE\\*\\*');
    expect(proposedText).not.toContain('**FREE**');
    expect(proposedText).toContain('\\[click\\]\\(http://evil\\)');
    expect(proposedText).toContain('\\*\\*Promo\\*\\*');
    expect(proposedText).toContain('\\[docs\\]\\(http://evil\\)');
    expect(proposedText).not.toContain('[docs](http://evil)');

    const removed = harness();
    await removed.engine.handle(alice, { type: 'text', text: 'delete promo', resolved: { intent: 'delete_rule', reply: '', rule: null, ruleId: 'promo', runId: null, messageId: null, correction: null } }, uid());
    expect(removed.messages.at(-1)!.text).toContain('\\*\\*FREE\\*\\*');
    expect(removed.messages.at(-1)!.text).not.toContain('**FREE**');
  });

  it('keeps Proposal cancelled and rule-changes-saved acks as unlabeled Replies', async () => {
    const cancelled = harness();
    await cancelled.engine.handle(alice, { type: 'text', text: 'starters' }, uid());
    await action(cancelled, 'cancel_draft', (await store.load(alice)).drafts[0]!.id);
    expect(cancelled.messages.at(-1)).toEqual({ actor: alice, text: "Proposition annulée.", buttons: undefined });

    const saved = harness();
    await saved.engine.handle(alice, { type: 'text', text: 'starters' }, uid());
    await action(saved, 'approve_draft', (await store.load(alice)).drafts[0]!.id);
    expect(saved.messages.at(-1)).toEqual({ actor: alice, text: "Vos changements de règles sont enregistrés. Envoyez courrier trier pour créer un aperçu.", buttons: undefined });
  });
});

describe('Run Cards', () => {
  it('sends Preview as a Card titled Preview with counts as a list and the existing Review, Confirm, and Cancel buttons', async () => {
    await seed();
    const h = harness();
    const run = await scan(h);
    const message = h.messages.at(-1)!;
    expect(message.kind).toBe("Aperçu");
    expect(message.text).toContain(escapeCardValue(run.id));
    expect(message.text).toMatch(/^- /m);
    expect(message.text).toMatch(/1 messages examinés/);
    expect(message.text).toMatch(/Libellés proposés sur 1/);
    expect(message.text).toMatch(/archive 0/);
    expect(message.text).toMatch(/Corbeille : 0/);
    expect(message.text).toMatch(/Votre décision est nécessaire : 0/);
    expect(message.text).toMatch(/exclus sauf inclusion explicite de votre part/);
    expect(message.text).toMatch(/Nouveaux libellés : aucun/);
    expect(message.text).toMatch(/Aucune modification n’a encore été effectuée/);
    expect(message.buttons).toEqual([
      { label: "Examiner les messages", action: 'details', value: `${run.id}:0` },
      { label: "Confirmer les modifications", action: 'confirm_run', value: run.id, style: 'primary' },
      { label: "Annuler", action: 'cancel_run', value: run.id },
    ]);
  });

  it('keeps scanning unlabeled and follows it with the Preview Card', async () => {
    await seed();
    const h = harness();
    await h.engine.handle(alice, { type: 'text', text: 'sort' }, uid());
    expect(h.messages[0]).toMatchObject({ text: expect.stringMatching(/^Examen de 1 messages de la boîte de réception/) });
    expect(h.messages[0]!.kind).toBeUndefined();
    expect(h.messages[1]!.kind).toBe("Aperçu");
  });

  it('sends Details as a Card titled Details with at most five numbered items and the existing include, skip, prev, next, and confirm buttons', async () => {
    await seed();
    const mailbox = new FakeMailbox();
    for (let n = 2; n <= 6; n++) mailbox.mails.set(`m${n}`, { id: `m${n}`, from: 'alex@example.com', subject: `Mail ${n}`, body: 'Please act today.', labels: ['INBOX'], historyId: '1' });
    const h = harness(mailbox, 'uncertain');
    const run = await scan(h);
    await action(h, 'details', `${run.id}:0`);
    const first = h.messages.at(-1)!;
    expect(first.kind).toBe("Détails");
    expect(first.text).toMatch(/^1\. /m);
    expect(first.text).toMatch(/^5\. /m);
    expect(first.text).not.toMatch(/^6\. /m);
    expect(first.buttons).toEqual([
      { label: 'Inclure la proposition 1', action: 'accept_item', value: `${run.id}:m1:0` },
      { label: 'Laisser 1 sans modification', action: 'skip_item', value: `${run.id}:m1:0` },
      { label: 'Inclure la proposition 2', action: 'accept_item', value: `${run.id}:m2:0` },
      { label: 'Laisser 2 sans modification', action: 'skip_item', value: `${run.id}:m2:0` },
      { label: 'Inclure la proposition 3', action: 'accept_item', value: `${run.id}:m3:0` },
      { label: 'Laisser 3 sans modification', action: 'skip_item', value: `${run.id}:m3:0` },
      { label: 'Inclure la proposition 4', action: 'accept_item', value: `${run.id}:m4:0` },
      { label: 'Laisser 4 sans modification', action: 'skip_item', value: `${run.id}:m4:0` },
      { label: 'Inclure la proposition 5', action: 'accept_item', value: `${run.id}:m5:0` },
      { label: 'Laisser 5 sans modification', action: 'skip_item', value: `${run.id}:m5:0` },
      { label: "Suivant", action: 'details', value: `${run.id}:1` },
      { label: "Confirmer la proposition examinée", action: 'confirm_run', value: run.id, style: 'primary' },
    ]);

    await action(h, 'details', `${run.id}:1`);
    const second = h.messages.at(-1)!;
    expect(second.kind).toBe("Détails");
    expect(second.text).toMatch(/^1\. /m);
    expect(second.text).not.toMatch(/^2\. /m);
    expect(second.buttons).toEqual([
      { label: 'Inclure la proposition 1', action: 'accept_item', value: `${run.id}:m6:1` },
      { label: 'Laisser 1 sans modification', action: 'skip_item', value: `${run.id}:m6:1` },
      { label: "Précédent", action: 'details', value: `${run.id}:0` },
      { label: "Confirmer la proposition examinée", action: 'confirm_run', value: run.id, style: 'primary' },
    ]);
  });

  it('puts run id and page number in the Details body, not the kind header', async () => {
    await seed();
    const h = harness();
    const run = await scan(h);
    await action(h, 'details', `${run.id}:0`);
    const message = h.messages.at(-1)!;
    expect(message.kind).toBe("Détails");
    expect(message.text).toContain(escapeCardValue(run.id));
    expect(message.text).toMatch(/page 1\/1/i);
    expect(message.text).toContain("De :");
    expect(message.text).toContain('Please act today');
    expect(message.text).toContain('alex@example\\.com');
    expect(message.text).toContain('m1');
  });

  it('sends Report as a Card titled Report with status counts and the existing Details and Undo buttons when those actions are valid', async () => {
    await seed();
    const h = harness();
    const run = await scan(h);
    await h.engine.handle(alice, { type: 'text', text: 'report' }, uid());
    const previewReport = h.messages.at(-1)!;
    expect(previewReport.kind).toBe("Rapport");
    expect(previewReport.text).toContain(escapeCardValue(run.id));
    expect(previewReport.text).toContain('aperçu');
    expect(previewReport.text).toMatch(/^- /m);
    expect(previewReport.text).toMatch(/en attente: 1/);
    expect(previewReport.buttons).toEqual([
      { label: "Détails", action: 'details', value: `${run.id}:0` },
    ]);

    await action(h, 'confirm_run', run.id);
    const done = h.messages.at(-1)!;
    expect(done.kind).toBe("Rapport");
    expect(done.text).toContain('terminé');
    expect(done.text).toMatch(/appliqué: 1/);
    expect(done.text).toMatch(/Les résultats incertains nécessitent une vérification dans Gmail/);
    expect(done.text).toMatch(/L’annulation ignore les messages modifiés depuis l’intervention de l’assistant/);
    expect(done.buttons).toEqual([
      { label: "Détails", action: 'details', value: `${run.id}:0` },
      { label: "Annuler ce traitement", action: 'undo_run', value: run.id },
    ]);

    await action(h, 'undo_run', run.id);
    const undone = h.messages.at(-1)!;
    expect(undone.kind).toBe("Rapport");
    expect(undone.text).toContain('annulé');
    expect(undone.buttons).toEqual([
      { label: "Détails", action: 'details', value: `${run.id}:0` },
    ]);
  });

  it('sends a correction as a Preview Card, then an unlabeled does-not-change-future-behavior line', async () => {
    await seed();
    const h = harness();
    const run = await scan(h);
    const before = h.messages.length;
    await h.engine.handle(alice, { type: 'text', text: 'keep this', resolved: { intent: 'correction', reply: '', rule: null, ruleId: null, runId: run.id, messageId: 'm1', correction: { addLabels: [], removeLabels: [], disposition: 'keep' } } }, uid());
    const sent = h.messages.slice(before);
    expect(sent[0]!.kind).toBe("Aperçu");
    expect(sent[1]).toEqual({
      actor: alice,
      text: "Cette correction ne change pas le comportement futur. Commencez votre réponse par courrier et décrivez le changement souhaité de la règle ; je le proposerai séparément pour approbation.",
      buttons: undefined,
    });
    expect(sent[1]!.kind).toBeUndefined();
  });

  it('escapes email subject, from, and id so markdown stays literal', async () => {
    const mailbox = new FakeMailbox();
    mailbox.mails.clear();
    mailbox.mails.set('**id**', {
      id: '**id**', from: '[click](http://evil)', subject: '**FREE**',
      body: 'Please act today.', labels: ['INBOX'], historyId: '1',
    });
    const state = emptyState();
    state.connection = { id: 'connection-a', email: 'alice@example.com', subject: 'google-alice', encryptedTokens: 'sealed' };
    state.rules = [{ ...starterRules()[0]!, id: 'urgent', labels: ['**Promo**'] }];
    await store.save(alice, state);

    const h = harness(mailbox);
    const run = await scan(h);
    const preview = h.messages.find(m => m.kind === "Aperçu")!.text;
    expect(preview).toContain('\\*\\*Promo\\*\\*');
    expect(preview).not.toContain('**Promo**');

    await action(h, 'details', `${run.id}:0`);
    const details = h.messages.at(-1)!.text;
    expect(details).toMatch(/^1\. /m);
    expect(details).toContain('\\*\\*FREE\\*\\*');
    expect(details).not.toContain('**FREE**');
    expect(details).toContain("De : \\[click\\]\\(http://evil\\)");
    expect(details).not.toContain('[click](http://evil)');
    expect(details).toContain('\\*\\*id\\*\\*');
    expect(details).not.toContain('**id**');
    expect(details).toContain('\\*\\*Promo\\*\\*');
    expect(details).toMatch(/^De :/m);
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
    expect(h.messages.at(-1)).toMatchObject({ text: expect.stringMatching(/^Utilisation de l’IA de l’équipe pour ce mois civil UTC :/) });
    expect(h.messages.at(-1)!.kind).toBeUndefined();

    await seed();
    await h.engine.handle(alice, { type: 'text', text: 'sort' }, uid());
    expect(h.messages.find(m => m.text.startsWith("Examen de "))!.kind).toBeUndefined();

    await h.engine.handle(alice, { type: 'text', text: 'starters' }, uid());
    expect(h.messages.at(-1)).toMatchObject({ text: expect.stringContaining("Modèle de projet :") });
    expect(h.messages.at(-1)!.kind).toBeUndefined();
    const draftId = (await store.load(alice)).drafts[0]!.id;
    await action(h, 'cancel_draft', draftId);
    expect(h.messages.at(-1)).toEqual({ actor: alice, text: "Proposition annulée.", buttons: undefined });

    const run = (await store.load(alice)).runs.at(-1)!;
    await action(h, 'not_a_real_action', run.id);
    expect(h.messages.at(-1)).toEqual({ actor: alice, text: "Action non prise en charge.", buttons: undefined });

    await h.engine.handle(alice, { type: 'text', text: 'keep this', resolved: { intent: 'correction', reply: '', rule: null, ruleId: null, runId: run.id, messageId: 'm1', correction: { addLabels: [], removeLabels: [], disposition: 'keep' } } }, uid());
    expect(h.messages.at(-1)).toMatchObject({ text: "Cette correction ne change pas le comportement futur. Commencez votre réponse par courrier et décrivez le changement souhaité de la règle ; je le proposerai séparément pour approbation." });
    expect(h.messages.at(-1)!.kind).toBeUndefined();
  });
  it('posts errors as unlabeled Replies', async () => {
    const failing = harness(undefined, 'yes', { converse: async () => { throw new Error('provider exploded'); } });
    await failing.engine.handle(alice, { type: 'text', text: 'What can you do?' }, uid());
    expect(failing.messages.at(-1)).toMatchObject({ text: expect.stringMatching(/^Cette demande n’a pas pu aboutir/) });
    expect(failing.messages.at(-1)!.kind).toBeUndefined();

  });
});
