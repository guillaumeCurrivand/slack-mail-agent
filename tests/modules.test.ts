import { randomBytes, createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readConfig } from '../src/app/config.js';
import { createModules } from '../src/app/modules.js';
import { legacyMetadataMigration, schema } from '../src/app/schema.js';
import { Budget, BudgetExceeded } from '../src/core/budget.js';
import { dispatchJob, type RuntimeOptions } from '../src/core/dispatch.js';
import { ownerKey, uid, type Actor } from '../src/core/identity.js';
import { ModuleRegistry, type AssistantModule, type RoutedJob } from '../src/core/modules.js';
import { createServer } from '../src/core/server.js';
import type { AgentMessage, Messenger } from '../src/core/slack.js';
import { coreSchema, JobStore, type Sql } from '../src/core/store.js';
import { worker } from '../src/core/worker.js';
import type { Pool } from 'pg';
import { emptyState } from '../src/modules/mail/domain.js';
import { Store } from '../src/modules/mail/store.js';

const alice = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
const bob = { ...alice, user: 'UBOB', channel: 'DBOB' };
const env = { PUBLIC_URL: 'https://agent.example.com', DATABASE_URL: 'postgresql://unused', SLACK_TEAM_ID: 'TTEAM', SLACK_BOT_TOKEN: 'token', SLACK_SIGNING_SECRET: 'secret' };
const mailEnv = { ...env, ENCRYPTION_KEY: randomBytes(32).toString('base64'), GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_WORKSPACE_DOMAINS: 'example.com', OPENAI_API_KEY: 'unused' };
const options: RuntimeOptions = { AI_MONTHLY_LIMIT_USD: 10, AI_USER_MONTHLY_LIMIT_USD: 10, AI_ALERT_USD: 8, SLACK_ADMIN_USER_ID: '' };
let db: PGlite, sql: Sql;
beforeAll(async () => { db = new PGlite(); await db.exec(schema); sql = { query: (text, values) => db.query(text, values) }; });
beforeEach(async () => { await db.exec('TRUNCATE users,jobs,oauth_states,ai_calls,ai_months,core_operation_slots CASCADE'); });
afterAll(async () => db.close());

function harness(modules = createModules(readConfig(mailEnv), sql, mailEnv), runtime = options) {
  const messages: Array<AgentMessage & { actor: Actor }> = [];
  const messenger: Messenger = { async send(actor, message) { messages.push({ actor, ...message }); } };
  const run = (route: RoutedJob, actor = alice, id = uid()) => dispatchJob(sql, runtime, modules, messenger, { ...route, actor, id });
  return { modules, messages, run, text: (text: string, actor = alice) => run(modules.text(text), actor) };
}

it('requires a fresh prefix for every request and isolates natural language routing', async () => {
  const seen: unknown[] = [];
  const probe: AssistantModule = { id: 'probe', description: 'Test capability', async handle(actor, payload) { seen.push({ actor, payload }); } };
  const actualMail = createModules(readConfig(mailEnv), sql, mailEnv).all()[0]!;
  const h = harness(new ModuleRegistry([actualMail, probe]));
  await h.text('mail starters');
  await h.text('probe show my requests\nfrom yesterday');
  await h.text('sort');
  await h.text('show me more');
  await h.text('unknown sort');
  expect(seen).toEqual([{ actor: alice, payload: { type: 'text', text: 'show my requests\nfrom yesterday' } }]);
  expect(h.messages.slice(-3).every(m => m.kind === 'Help' && m.text.includes('not sent to a module'))).toBe(true);
  expect((await new Store(sql).load(alice)).drafts).toHaveLength(1);
  expect(h.modules.text('  MAIL   rules  ')).toEqual({ module: 'mail', payload: { type: 'text', text: 'rules' } });
  expect(h.modules.text('mail')).toEqual({ module: 'mail', payload: { type: 'text', text: 'help' } });
});

it('namespaces real mail buttons and retains ownership and duplicate-approval safeguards', async () => {
  const h = harness();
  await h.text('mail starters');
  const button = h.messages.find(m => m.kind === 'Rule proposal')!.buttons![0]!;
  expect(button.action).toBe('mail:approve_draft');
  await h.run(h.modules.action(button.action, button.value), bob);
  expect((await new Store(sql).load(bob)).rules).toEqual([]);
  await h.text('help'); // The intervening conversation cannot change button routing.
  const approval = h.modules.action(button.action, button.value), id = uid();
  await h.run(approval, alice, id);
  await h.run(approval, alice, id);
  await h.run(approval); // A second click with a fresh event ID is also harmless.
  expect((await new Store(sql).load(alice)).rules).toHaveLength(2);
});

it('accepts only the exact legacy mail button IDs and handles unavailable modules without executing them', async () => {
  const h = harness();
  await h.text('mail starters');
  const draft = (await new Store(sql).load(alice)).drafts[0]!;
  await h.run(h.modules.action('approve_draft', draft.id));
  expect((await new Store(sql).load(alice)).rules).toHaveLength(2);
  expect(h.modules.action('invented_old_action', draft.id).module).toBe('core');
  const disabled = harness(new ModuleRegistry([]));
  await disabled.run(disabled.modules.action('mail:approve_draft', draft.id));
  expect(disabled.messages[0]!.text).toContain('No modules are currently enabled');
  await expect(disabled.run({ module: 'mail', payload: { type: 'text', text: 'starters' } })).rejects.toThrow('not enabled');
  expect((await new Store(sql).load(alice)).drafts).toHaveLength(0);
});

it('starts the core without Gmail, encryption or AI credentials and exposes no mail routes', async () => {
  const config = readConfig({ ...env, ENABLED_MODULES: '' });
  const modules = createModules(config, sql, { ...env, ENABLED_MODULES: '' });
  const app = createServer(config, new JobStore(sql), modules);
  try {
    expect((await app.inject('/health')).statusCode).toBe(200);
    expect((await app.inject('/ready')).statusCode).toBe(200);
    expect((await app.inject('/auth/google?ticket=test')).statusCode).toBe(404);
    expect((await app.inject('/auth/google/callback?code=test&state=test')).statusCode).toBe(404);
    const h = harness(modules);
    await h.text('budget'); await h.text('help'); await h.text('mail sort');
    expect(h.messages[0]!.text).toContain('$0.0000');
    expect(h.messages[1]!.text).toContain('No modules are currently enabled');
  } finally { await app.close(); }
  expect(() => createModules(readConfig(env), sql, env)).toThrow();
  expect(() => createModules(readConfig({ ...env, ENABLED_MODULES: 'missing' }), sql, env)).toThrow('Unknown enabled module');
  expect(() => readConfig({ ...env, ENABLED_MODULES: 'mail,mail' })).toThrow('Duplicate');
});

it('can add a module with private state without creating or using a Gmail connection', async () => {
  await sql.query('CREATE TABLE IF NOT EXISTS probe_state (owner text PRIMARY KEY, value text NOT NULL)');
  const module: AssistantModule = { id: 'probe', description: 'Test capability', async handle(actor, payload, _id, context) {
    await context.sql.query('INSERT INTO probe_state(owner,value) VALUES($1,$2) ON CONFLICT(owner) DO UPDATE SET value=excluded.value', [ownerKey(actor), payload.text]);
    await context.messenger.send(actor, { text: String(payload.text) });
  } };
  const h = harness(new ModuleRegistry([module]));
  await h.text('probe Alice only'); await h.text('probe Bob only', bob);
  expect((await sql.query('SELECT owner,value FROM probe_state ORDER BY owner')).rows).toEqual([
    { owner: ownerKey(alice), value: 'Alice only' }, { owner: ownerKey(bob), value: 'Bob only' },
  ]);
  expect((await sql.query('SELECT * FROM users')).rows).toEqual([]);
  expect(h.messages.map(m => m.actor.channel)).toEqual(['DALICE', 'DBOB']);
});

it('leaves disabled jobs untouched, processes other work for that user, and resumes after re-enablement', async () => {
  // Embedded PostgreSQL executes the real queue queries. Only advisory locks are
  // faked here; their concurrency behavior is covered by postgres.test.ts.
  const query = (text: string, values?: any[]) => text.includes('pg_try_advisory_lock')
    ? Promise.resolve({ rows: [{ locked: true }] }) : text.includes('pg_advisory_unlock')
      ? Promise.resolve({ rows: [{}] }) : sql.query(text, values);
  const pool = { query, async connect() { return { query, release() {} }; } } as unknown as Pool;
  const jobs = new JobStore(sql);
  await jobs.enqueue('disabled-mail', alice, { type: 'text', text: 'starters' }, 'mail');
  await sql.query("UPDATE jobs SET status='running',attempts=2 WHERE id='disabled-mail'");
  await jobs.enqueue('available-help', alice, { type: 'text', text: 'help' });
  const runUntilReply = async (modules: ModuleRegistry) => {
    let reply!: () => void;
    const replied = new Promise<void>(resolve => { reply = resolve; });
    const stop = worker(pool, { ...options, WORKER_CONCURRENCY: 1 }, modules, { async send() { reply(); } });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([replied, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Worker did not deliver a reply')), 3000); })]);
    } finally { clearTimeout(timeout); await stop(); }
  };
  await runUntilReply(new ModuleRegistry([]));
  expect((await sql.query("SELECT status,attempts,payload FROM jobs WHERE id='disabled-mail'")).rows[0]).toEqual({ status: 'running', attempts: 2, payload: { type: 'text', text: 'starters' } });
  expect((await sql.query("SELECT status FROM jobs WHERE id='available-help'")).rows[0]!.status).toBe('done');
  expect((await new Store(sql).load(alice)).drafts).toHaveLength(0);
  await runUntilReply(createModules(readConfig(mailEnv), sql, mailEnv));
  expect((await sql.query("SELECT status,attempts,payload FROM jobs WHERE id='disabled-mail'")).rows[0]).toEqual({ status: 'done', attempts: 3, payload: {} });
  expect((await new Store(sql).load(alice)).drafts).toHaveLength(1);
});

it('keeps navigation and the other module responsive during a held mail scan while serializing mail state', async () => {
  const state = emptyState();
  state.connection = { id: 'connected', subject: 'alice', email: 'alice@example.com', encryptedTokens: new (await import('../src/core/crypto.js')).Vault(Buffer.from(mailEnv.ENCRYPTION_KEY, 'base64'))
    .seal({ access_token: 'fake', refresh_token: 'fake', expires_at: Date.now() + 3600_000 }, ownerKey(alice)) };
  state.rules = [{ id: 'sender-rule', name: 'Known sender', kind: 'sender', category: 'other', condition: 'Known sender', senders: ['known@example.com'], labels: [], action: 'keep', examples: ['Known sender'] }];
  await new Store(sql).save(alice, state);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let listCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('messages?labelIds=INBOX')) { listCalls++; entered(); await gate; return Response.json({ messages: [] }); }
    if (String(url).endsWith('/labels')) return Response.json({ labels: [] });
    throw new Error(`Unexpected provider call: ${url}`);
  }));
  const config = readConfig({ ...mailEnv, ENABLED_MODULES: 'mail,slack' });
  const modules = createModules(config, sql, { ...mailEnv, ENABLED_MODULES: 'mail,slack' });
  for (const module of modules.all()) await module.initialize?.({ query: async text => (await db.exec(text)).at(-1)! });
  const jobs = new JobStore(sql);
  await jobs.enqueueOperation('a-sort-held', alice, { type: 'text', text: 'sort' }, 'mail', 'sort', 'Sort inbox');
  await jobs.enqueueOperation('duplicate-held', alice, { type: 'text', text: 'sort' }, 'mail', 'sort', 'Sort inbox');
  await jobs.enqueue('z-mail-conflict', alice, { type: 'text', text: 'report' }, 'mail');
  await jobs.enqueue('navigate', alice, { type: 'text', text: 'menu' });
  await jobs.enqueueOperation('search-other', alice, { type: 'text', text: 'unanswered' }, 'slack', 'unanswered', 'Find unanswered');
  const held = new Set<string>();
  const query = (text: string, values?: any[]) => text.includes('pg_try_advisory_lock')
    ? Promise.resolve({ rows: [{ locked: !held.has(values![0]) && Boolean(held.add(values![0])) }] })
    : text.includes('pg_advisory_unlock') ? Promise.resolve({ rows: [{ unlocked: held.delete(values![0]) }] }) : sql.query(text, values);
  const pool = { query, async connect() { return { query, release() {} }; } } as unknown as Pool;
  const messages: Array<{ kind?: string; text: string }> = [];
  const messenger: Messenger = { async send(_actor, message) { messages.push(message); },
    async post(_actor, message) { messages.push(message); return '1234567890.000001'; },
    async update(_actor, _ts, message) { messages.push(message); } };
  const stop = worker(pool, { ...config, WORKER_CONCURRENCY: 3 }, modules, messenger);
  try {
    await started;
    const deadline = Date.now() + 3000;
    while ((!messages.some(message => message.kind === 'Menu') || !messages.some(message => message.kind === 'Unanswered for you') || !messages.some(message => message.kind === 'Work in progress')) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    expect(messages.some(message => message.kind === 'Menu')).toBe(true);
    expect(messages.some(message => message.kind === 'Unanswered for you')).toBe(true);
    expect(messages.some(message => message.kind === 'Work in progress')).toBe(true);
    expect((await sql.query("SELECT status FROM jobs WHERE id='z-mail-conflict'")).rows[0].status).toBe('queued');
    expect(listCalls).toBe(1);
  } finally { release(); await stop(); vi.unstubAllGlobals(); }
  expect((await new Store(sql).load(alice)).runs.some(run => run.status === 'preview')).toBe(true);
});

it('rejects ambiguous registrations before accepting work', () => {
  const module: AssistantModule = { id: 'probe', description: 'Test', legacyActions: ['old_action'], async handle() {} };
  expect(() => new ModuleRegistry([module, module])).toThrow('duplicate');
  expect(() => new ModuleRegistry([{ ...module, id: 'budget' }])).toThrow('Invalid');
  expect(() => new ModuleRegistry([module, { ...module, id: 'other' }])).toThrow('legacy action');
});

it('durably binds signed text, new actions and old actions to their module', async () => {
  const modules = createModules(readConfig(mailEnv), sql, mailEnv);
  const app = createServer(readConfig(env), new JobStore(sql), modules);
  const post = (url: string, raw: string, contentType: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return app.inject({ method: 'POST', url, payload: raw, headers: { 'content-type': contentType,
      'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${createHmac('sha256', 'secret').update(`v0:${timestamp}:${raw}`).digest('hex')}` } });
  };
  try {
    for (const text of ['mail sort', 'sort', 'budget']) {
      const body = JSON.stringify({ type: 'event_callback', team_id: 'TTEAM', event_id: text,
        event: { type: 'message', channel_type: 'im', user: 'UALICE', channel: 'DALICE', text } });
      expect((await post('/slack/events', body, 'application/json')).statusCode).toBe(200);
      await post('/slack/events', body, 'application/json');
    }
    for (const action of ['mail:confirm_run', 'confirm_run', 'unknown:confirm_run']) {
      const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: 'TTEAM' }, user: { id: 'UALICE' }, channel: { id: 'DALICE' }, actions: [{ action_id: action, value: 'run-id' }] }) }).toString();
      expect((await post('/slack/actions', raw, 'application/x-www-form-urlencoded')).statusCode).toBe(200);
      await post('/slack/actions', raw, 'application/x-www-form-urlencoded');
    }
    const rows = (await sql.query('SELECT module,payload FROM jobs')).rows;
    expect(rows).toHaveLength(6);
    expect(rows.filter(r => r.module === 'mail')).toHaveLength(3);
    expect(rows).toContainEqual({ module: 'core', payload: { type: 'text', text: 'sort' } });
    expect(rows.filter(r => r.payload.action === 'confirm_run').every(r => r.module === 'mail')).toBe(true);
  } finally { await app.close(); }
});

it('enforces shared and per-user budgets across modules and reports module attribution', async () => {
  const mail = new Budget(sql, 10_000_000, 7_000_000, 'mail');
  const probe = new Budget(sql, 10_000_000, 7_000_000, 'probe');
  const call = await mail.reserve(alice, 6_000_000);
  await expect(probe.reserve(alice, 2_000_000)).rejects.toBeInstanceOf(BudgetExceeded);
  await probe.reserve(bob, 4_000_000);
  await expect(mail.reserve(bob, 1)).rejects.toBeInstanceOf(BudgetExceeded);
  await mail.settle(call, 5_000_000);
  expect(await mail.usage()).toEqual({ charged: 5, reserved: 4 });
  expect(await mail.byModule()).toEqual([{ module: 'mail', charged: 5, reserved: 0 }, { module: 'probe', charged: 0, reserved: 4 }]);
  const h = harness(new ModuleRegistry([])); await h.text('budget');
  expect(h.messages[0]!.text).toContain('mail: $5.0000 recorded');
  expect(h.messages[0]!.text).toContain('probe: $0.0000 recorded, $4.0000 reserved');
});

it('attributes actual module calls and sends the shared spending alert once from the core', async () => {
  const module: AssistantModule = { id: 'probe', description: 'Test spending', async handle(actor, _payload, _id, context) { await context.budget.reserve(actor, 1); } };
  const h = harness(new ModuleRegistry([module]), { ...options, AI_ALERT_USD: 0, SLACK_ADMIN_USER_ID: 'UADMIN' });
  await h.text('probe run'); await h.text('probe run');
  expect(h.messages).toHaveLength(1);
  expect(h.messages[0]).toMatchObject({ actor: { user: 'UADMIN', channel: 'UADMIN' }, text: expect.stringContaining('The team AI allowance has reached its alert threshold') });
  expect(h.messages[0]!.kind).toBeUndefined();
  expect((await sql.query('SELECT DISTINCT module FROM ai_calls')).rows).toEqual([{ module: 'probe' }]);
});

it('reports the same shared budget and module attribution through current and legacy mail requests', async () => {
  const mail = new Budget(sql, 10_000_000, 10_000_000, 'mail');
  const call = await mail.reserve(alice, 2_000_000);
  await mail.settle(call, 1_000_000);
  await new Budget(sql, 10_000_000, 10_000_000, 'probe').reserve(bob, 3_000_000);
  const h = harness();
  await h.text('budget');
  await h.text('mail budget');
  await h.run({ module: 'mail', payload: { type: 'text', text: 'budget' } });
  expect(h.messages).toHaveLength(3);
  expect(new Set(h.messages.map(message => message.text)).size).toBe(1);
  expect(h.messages[0]!.text).toContain('mail: $1.0000 recorded, $0.0000 reserved');
  expect(h.messages[0]!.text).toContain('probe: $0.0000 recorded, $3.0000 reserved');
  expect(h.messages.every(message => message.kind === undefined)).toBe(true);
});

it('upgrades old jobs and AI records idempotently without changing mail state or spending', async () => {
  const legacy = new PGlite();
  try {
    await legacy.exec(`
      CREATE TABLE jobs (id text PRIMARY KEY, owner text NOT NULL, actor jsonb NOT NULL, payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
        available_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz);
      CREATE TABLE ai_months (month text PRIMARY KEY, charged_micro bigint NOT NULL DEFAULT 0, reserved_micro bigint NOT NULL DEFAULT 0, alert_sent boolean NOT NULL DEFAULT false);
      CREATE TABLE ai_calls (id text PRIMARY KEY, month text NOT NULL REFERENCES ai_months(month), owner text NOT NULL,
        reserved_micro bigint NOT NULL, charged_micro bigint, status text NOT NULL DEFAULT 'reserved', created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE users (owner text PRIMARY KEY, team text NOT NULL, slack_user text NOT NULL, google_subject text,
        state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(team,google_subject));
    `);
    const oldSql: Sql = { query: (text, values) => legacy.query(text, values) };
    const state = emptyState(); state.connection = { id: 'existing', subject: 'google-alice', email: 'alice@example.com', encryptedTokens: 'unchanged-ciphertext' };
    state.drafts = [{ id: 'old-proposal', created: new Date().toISOString(), kind: 'delete', ruleId: 'rule-1' }];
    await new Store(oldSql).save(alice, state);
    await oldSql.query('INSERT INTO jobs(id,owner,actor,payload) VALUES($1,$2,$3,$4)', ['old-job', ownerKey(alice), JSON.stringify(alice), JSON.stringify({ type: 'action', action: 'cancel_draft', value: 'old-proposal' })]);
    const month = new Date().toISOString().slice(0, 7);
    await oldSql.query('INSERT INTO ai_months(month,charged_micro,reserved_micro) VALUES($1,2000000,3000000)', [month]);
    await oldSql.query("INSERT INTO ai_calls(id,month,owner,reserved_micro,charged_micro,status) VALUES('settled',$1,$2,2000000,2000000,'settled'),('pending',$1,$2,3000000,NULL,'reserved')", [month, ownerKey(alice)]);
    await legacy.exec(coreSchema + legacyMetadataMigration);
    expect(await new Store(oldSql).load(alice)).toEqual(state);
    expect((await oldSql.query('SELECT module FROM jobs')).rows).toEqual([{ module: 'mail' }]);
    expect(await new Budget(oldSql).usage()).toEqual({ charged: 2, reserved: 3 });
    expect(await new Budget(oldSql).byModule()).toEqual([{ module: 'mail', charged: 2, reserved: 3 }]);
    await new JobStore(oldSql).enqueue('new-core', alice, { type: 'text', text: 'help' });
    await legacy.exec(coreSchema + legacyMetadataMigration);
    expect((await oldSql.query("SELECT module FROM jobs WHERE id='new-core'")).rows[0]!.module).toBe('core');
    const modules = createModules(readConfig(mailEnv), oldSql, mailEnv);
    const job = (await oldSql.query("SELECT * FROM jobs WHERE id='old-job'")).rows[0]!;
    await dispatchJob(oldSql, options, modules, { async send() {} }, job as any);
    const after = await new Store(oldSql).load(alice);
    expect(after.drafts).toEqual([]); expect(after.connection).toEqual(state.connection);
    expect(after.handled).toContain('old-job');
  } finally { await legacy.close(); }
});
