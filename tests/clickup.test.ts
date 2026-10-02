import { createHmac, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createModules } from '../src/app/modules.js';
import { readConfig } from '../src/app/config.js';
import { schema } from '../src/app/schema.js';
import { dispatchJob } from '../src/core/dispatch.js';
import type { AgentMessage } from '../src/core/slack.js';
import { JobStore } from '../src/core/store.js';
import { createServer } from '../src/core/server.js';
import { ModuleRegistry, type RoutedJob } from '../src/core/modules.js';
import { createClickupModule } from '../src/modules/clickup/index.js';
import { Slack, SlackDeliveryRejected } from '../src/core/slack.js';
import type { ClickupDatabase } from '../src/modules/clickup/transactions.js';
import { frenchCommand } from '../src/app/commands.js';

const alice = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
const env = { PUBLIC_URL: 'https://agent.example.com', DATABASE_URL: 'postgresql://unused', SLACK_TEAM_ID: 'TTEAM', SLACK_BOT_TOKEN: 'unused', SLACK_SIGNING_SECRET: 'secret', ENABLED_MODULES: 'clickup', ENCRYPTION_KEY: randomBytes(32).toString('base64'), CLICKUP_CLIENT_ID: 'client', CLICKUP_CLIENT_SECRET: 'secret', CLICKUP_WORKSPACE_ID: '42' };
const runtime = { AI_MONTHLY_LIMIT_USD: 0, AI_USER_MONTHLY_LIMIT_USD: 0, AI_ALERT_USD: 0, SLACK_ADMIN_USER_ID: '' };
let db: PGlite, sql: ClickupDatabase;
beforeAll(async () => { db = new PGlite(); await db.exec(schema); sql = { query: (text, values) => db.query(text, values), transaction: work => db.transaction(tx => work({ query: (text, values) => tx.query(text, values) })) }; });
afterAll(async () => db.close());
beforeEach(async () => {
  await db.exec('TRUNCATE jobs,core_navigation_menus,core_navigation_deliveries,core_operation_slots,ai_calls,ai_months CASCADE');
  for (const { tablename } of (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE tablename LIKE 'clickup_%'")).rows) await db.exec(`TRUNCATE ${tablename} CASCADE`);
});

function harness(fetcher: typeof fetch) {
  const module = createClickupModule({ ...env }, sql, { fetcher });
  const modules = new ModuleRegistry([{ ...module, normalizeText: text => frenchCommand('clickup', text) }]);
  const messages: Array<AgentMessage & { timestamp: string }> = [];
  const messenger = {
    async send(_actor: unknown, message: AgentMessage) { messages.push({ ...message, timestamp: `${messages.length + 1}.000` }); },
    async post(_actor: unknown, message: AgentMessage) { const timestamp = `${messages.length + 1}.000`; messages.push({ ...message, timestamp }); return timestamp; },
    async update(_actor: unknown, timestamp: string, message: AgentMessage) { messages.push({ ...message, timestamp }); },
  };
  const run = (route: RoutedJob, actor = alice, id = `event-${messages.length}`) => dispatchJob(sql, { ...runtime, AI_ALERT_USD: 8 }, modules, messenger, { ...route, actor, id });
  const text = (value: string, actor = alice, id?: string) => run(modules.text(value), actor, id);
  const click = (action: string, message = messages.at(-1)!, actor = alice, id?: string) => {
    const button = message.buttons!.find(button => button.action === `clickup:${action}`)!;
    return run({ ...modules.action(button.action, button.value), payload: { ...modules.action(button.action, button.value).payload, timestamp: message.timestamp } }, actor, id);
  };
  return { module, modules, messages, messenger, run, text, click };
}

async function connect(h: ReturnType<typeof harness>, actor = alice) {
  await h.module.initialize?.(sql);
  const app = createServer(readConfig(env), new JobStore(sql), h.modules);
  await h.text('clickup connect', actor);
  const invitation = h.messages.at(-1)!.resourceLinks![0]!.url;
  const start = await app.inject(new URL(invitation).pathname + new URL(invitation).search);
  const state = new URL(start.headers.location!).searchParams.get('state')!;
  const cookie = String(start.headers['set-cookie']).split(';')[0]!;
  const finish = await app.inject({ url: `/auth/clickup/callback?state=${state}&code=code`, headers: { cookie } });
  expect(finish.statusCode).toBe(200);
  const job = (await sql.query("SELECT * FROM jobs WHERE module='clickup' AND payload->>'type'='connection' ORDER BY created_at DESC")).rows[0];
  await h.run({ module: job.module, payload: job.payload }, job.actor, job.id);
  await app.close();
  return h.messages.at(-1)!;
}

it('routes French assigned-task requests without Gmail or AI and requires a ClickUp connection', async () => {
  const modules = createModules(readConfig(env), sql, env);
  for (const module of modules.all()) await module.initialize?.(sql);
  expect(modules.text('clickup tâches')).toEqual({ module: 'clickup', payload: { type: 'text', text: 'tasks' } });
  const messages: AgentMessage[] = [];
  await dispatchJob(sql, runtime, modules, { async send(_actor, message) { messages.push(message); } }, { ...modules.text('clickup tâches'), actor: alice, id: 'not-connected' });
  expect(messages.at(-1)?.text).toContain('Connectez');
  expect(messages.at(-1)?.buttons?.some(button => button.action === 'clickup:connect')).toBe(true);
});

it('binds OAuth to its browser and requires private confirmation of the authenticated Mayasquad identity', async () => {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'alice-secret' });
    if (String(url).endsWith('/user')) return Response.json({ user: { id: 7, username: 'Alice', email: 'alice@clickup.example' } });
    if (String(url).endsWith('/team')) return Response.json({ teams: [{ id: '42', name: 'Renamed Mayasquad' }, { id: '99', name: 'Other' }] });
    throw new Error(`Unexpected provider call ${url}`);
  }) as typeof fetch;
  const h = harness(fetcher), proposal = await connect(h);
  expect(proposal.text.replaceAll('\\', '')).toContain('alice@clickup.example');
  await h.text('clickup tasks');
  expect(h.messages.at(-1)!.text).toContain('Connectez');
  await h.click('confirm', proposal, { ...alice, user: 'UBOB', channel: 'DBOB' });
  expect(h.messages.at(-1)!.text).toContain('indisponible');
  await h.click('confirm', proposal);
  expect(h.messages.at(-1)!.text).toContain('connecté');
  expect(calls.filter(url => url.endsWith('/oauth/token'))).toHaveLength(1);
});

function task(id: string, overrides: Record<string, unknown> = {}) {
  return { id, name: `Task ${id}`, status: { status: 'In progress', type: 'custom' }, archived: false, assignees: [{ id: 7 }], due_date: null, priority: null, list: { id: '12', name: 'Delivery' }, url: `https://app.clickup.com/t/${id}`, ...overrides };
}
function provider(pages: unknown[][]) {
  const calls: string[] = [];
  const tasks = new Map(pages.flat().map(value => [(value as { id: string }).id, value]));
  const failures = new Map<string, number>();
  let subject = 7, workspace = '42';
  const statuses = [{ status: 'In progress', type: 'custom' }, { status: 'Unused', type: 'open' }, { status: 'Finished', type: 'done' }, { status: 'Closed', type: 'closed' }];
  const locations = new Map<string, unknown>([
    ['/api/v2/team/42/space', { spaces: [{ id: '10', statuses }] }],
    ['/api/v2/space/10/folder', { folders: [{ id: '11' }] }],
    ['/api/v2/space/10/list', { lists: [] }],
    ['/api/v2/folder/11', { id: '11', statuses, folders: [] }],
    ['/api/v2/folder/11/list', { lists: [{ id: '12' }] }],
    ['/api/v2/list/12', { id: '12', statuses }],
    ['/api/v2/team/42/shared', { shared: { tasks: [], lists: [], folders: [] } }],
  ]);
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push(url.pathname + url.search);
    if (url.pathname.endsWith('/oauth/token')) return Response.json({ access_token: 'alice-secret' });
    expect((init?.headers as { Authorization: string }).Authorization).toBe('alice-secret');
    const failure = failures.get(url.pathname + url.search) ?? failures.get(url.pathname);
    if (failure) return new Response('', { status: failure });
    if (url.pathname.endsWith('/user')) return Response.json({ user: { id: subject, username: 'Alice', email: 'alice@example.com' } });
    if (url.pathname.endsWith('/team')) return Response.json({ teams: [{ id: workspace, name: 'Mayasquad' }, { id: '99', name: 'Other' }] });
    if (locations.has(url.pathname + url.search)) return Response.json(locations.get(url.pathname + url.search));
    if (locations.has(url.pathname)) return Response.json(locations.get(url.pathname));
    if (url.pathname === '/api/v2/team/42/task') {
      expect(url.searchParams.get('assignees[]')).toBe(String(subject)); expect(url.searchParams.get('subtasks')).toBe('true');
      return Response.json({ tasks: pages[Number(url.searchParams.get('page'))] ?? [] });
    }
    if (url.pathname.startsWith('/api/v2/task/')) {
      const value = tasks.get(url.pathname.split('/').at(-1)!);
      return value ? Response.json(value) : new Response('', { status: 404 });
    }
    throw new Error(`Unexpected call ${input}`);
  }) as typeof fetch;
  return { fetcher, calls, tasks, failures, locations, replaceTask: (id: string, value: ReturnType<typeof task>) => { tasks.set(id, value); for (const page of pages) { const index = page.findIndex(item => (item as { id: string }).id === id); if (index >= 0) page[index] = value; } }, changeIdentity: (id: number) => { subject = id; }, changeWorkspace: (id: string) => { workspace = id; } };
}
async function connected(p: ReturnType<typeof provider>) {
  const h = harness(p.fetcher), proposal = await connect(h);
  await h.click('confirm', proposal);
  return h;
}

it('opens the private French status picker with unused configured statuses and completed choices', async () => {
  const h = await connected(provider([[task('one')]]));
  await h.text('clickup statuts');
  const picker = h.messages.at(-1)!;
  expect(picker.kind).toBe('Statuts ClickUp');
  expect(picker.text).toContain('Unused');
  expect(picker.text).toContain('Finished');
  expect(picker.text).toContain('Personal List');
  expect(picker.buttons!.map(button => button.label)).toEqual(expect.arrayContaining(['Enregistrer', 'Annuler', 'Réinitialiser le filtre']));
  await h.click('status_save', picker, { ...alice, user: 'UBOB', channel: 'DBOB' });
  expect(h.messages.at(-1)!.text).toContain('indisponible');
});

it('loads a twelve-page catalogue without serializing independent List reads', async () => {
  const p = provider([]), definitions = Array.from({ length: 120 }, (_, index) => ({ status: `Status ${String(index).padStart(3, '0')}`, type: 'custom' }));
  p.locations.set('/api/v2/team/42/space', { spaces: [{ id: '10', statuses: definitions }] });
  p.locations.set('/api/v2/folder/11', { id: '11', statuses: definitions });
  p.locations.set('/api/v2/folder/11/list', { lists: definitions.map((_, index) => ({ id: String(1000 + index) })) });
  for (const [index, status] of definitions.entries()) p.locations.set(`/api/v2/list/${1000 + index}`, { id: String(1000 + index), statuses: [status] });
  let active = 0, peak = 0, reads = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.startsWith('/api/v2/list/')) {
      active++; peak = Math.max(peak, active); reads++;
      try { await new Promise(resolve => setTimeout(resolve, 20)); return await p.fetcher(input, init); }
      finally { active--; }
    }
    return p.fetcher(input, init);
  }) as typeof fetch;
  const h = harness(fetcher), proposal = await connect(h); await h.click('confirm', proposal);
  await h.text('clickup statuts');
  expect(h.messages.at(-1)!.text).toContain('Page 1/12');
  expect(h.messages.at(-1)!.buttons!.some(button => button.label === 'Enregistrer')).toBe(true);
  expect(reads).toBe(120); expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(4);
  const calls = p.calls.length;
  await h.click('status_page'); await chooseStatus(h, 'Status 010', false); await h.click('status_reset');
  expect(h.messages.at(-1)!.text).toContain('Filtre par défaut'); expect(p.calls).toHaveLength(calls);
});

it('lets Retirer change a saved editor draft during a ClickUp cooldown without provider calls', async () => {
  const p = provider([]), h = await connected(p);
  await h.text('clickup statuts'); const picker = h.messages.at(-1)!, calls = p.calls.length;
  await sql.query("INSERT INTO clickup_limits(owner,connection_id,retry_at) SELECT owner,connection_id,now()+interval '2 minutes' FROM clickup_connections");
  await chooseStatus(h, 'Unused', false, picker);
  expect(h.messages.at(-1)!.buttons!.map(button => button.label)).toContain('Ajouter Unused');
  expect(h.messages.at(-1)!.text).toContain('Sélection personnelle');
  expect(p.calls).toHaveLength(calls);
  await h.click('status_save');
  expect(h.messages.at(-1)!.text).toContain('temporairement');
  expect(h.messages.at(-1)!.buttons!.map(button => button.label)).toContain('Ajouter Unused');
  await h.click('status_cancel'); expect(h.messages.at(-1)!.text).toContain('annulée');
});

it('reuses a recent complete catalogue across restart and explicitly refreshes or expires it', async () => {
  const p = provider([]), h = await connected(p);
  await h.text('clickup statuts'); const reads = p.calls.filter(path => !['/api/v2/user', '/api/v2/team', '/api/v2/oauth/token'].includes(path)).length;
  const restarted = harness(p.fetcher);
  await restarted.text('clickup statuts', alice, 'reopen-cached');
  expect(p.calls.filter(path => !['/api/v2/user', '/api/v2/team', '/api/v2/oauth/token'].includes(path))).toHaveLength(reads);
  expect(restarted.messages.at(-1)!.text).toContain('Catalogue vérifié');
  p.locations.set('/api/v2/list/12', { id: '12', statuses: [{ status: 'New name', type: 'custom' }] });
  await restarted.click('status_retry');
  expect(restarted.messages.at(-1)!.text).toContain('New name');
  await sql.query("UPDATE clickup_status_editors SET data=jsonb_set(data,'{catalogue,checkedAt}',to_jsonb((now()-interval '6 minutes')::text))");
  const before = p.calls.length; await restarted.text('clickup statuts', alice, 'reopen-expired');
  expect(p.calls.length - before).toBeGreaterThan(2);
});

it('returns a partial catalogue promptly instead of waiting inside a provider rate-limit reset', async () => {
  const p = provider([]), h = await connected(p);
  const limited = harness((async (input: string | URL | Request, init?: RequestInit) => String(input).includes('/list/12')
    ? new Response('', { status: 429, headers: { 'Retry-After': '1' } }) : p.fetcher(input, init)) as typeof fetch);
  const timers = vi.spyOn(globalThis, 'setTimeout');
  try {
    await limited.text('clickup statuts', alice, 'short-cooldown');
    expect(limited.messages.at(-1)!.text).toContain('incomplète');
    expect(timers.mock.calls.filter(([, delay]) => Number(delay) === 1000)).toHaveLength(0);
    await chooseStatus(limited, 'Unused', false);
    expect(limited.messages.at(-1)!.buttons!.map(button => button.label)).toContain('Ajouter Unused');
  } finally { timers.mockRestore(); }
});

it('checkpoints a stalled discovery at its time limit and resumes it with Retry', async () => {
  const p = provider([]), base = await connected(p);
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const stalled = harness((async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('/list/12')) {
      entered();
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    return p.fetcher(input, init);
  }) as typeof fetch);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const loading = stalled.text('clickup statuts', alice, 'stalled-catalogue'); await started;
    await vi.advanceTimersByTimeAsync(8000); await loading;
    const partial = stalled.messages.at(-1)!;
    expect(partial.text).toContain('incomplète'); expect(partial.buttons!.some(button => button.label === 'Enregistrer')).toBe(false);
    vi.useRealTimers();
    await base.click('status_retry', partial, alice, 'resume-stalled');
    expect(base.messages.at(-1)!.buttons!.some(button => button.label === 'Enregistrer')).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('keeps the longest cooldown when concurrent catalogue reads receive different rate-limit resets', async () => {
  const p = provider([]), base = await connected(p);
  p.locations.set('/api/v2/folder/11/list', { lists: [{ id: '12' }, { id: '13' }, { id: '14' }] });
  const longest = Math.ceil(Date.now() / 1000) + 120;
  const limited = harness((async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith('/api/v2/list/')) {
      if (path !== '/api/v2/list/12') await new Promise(resolve => setTimeout(resolve, 10));
      return new Response('', { status: 429, headers: { 'X-RateLimit-Reset': String(path === '/api/v2/list/12' ? longest : longest - 90) } });
    }
    return p.fetcher(input, init);
  }) as typeof fetch);
  await limited.text('clickup statuts', alice, 'concurrent-cooldowns');
  expect(limited.messages.at(-1)!.text).toContain('incomplète');
  const deadline = (await sql.query('SELECT retry_at FROM clickup_limits')).rows[0].retry_at;
  expect(new Date(deadline).getTime()).toBeGreaterThanOrEqual(longest * 1000);
  const before = p.calls.length; await chooseStatus(limited, 'Unused', false);
  expect(p.calls).toHaveLength(before);
  await sql.query("UPDATE clickup_limits SET retry_at=now()-interval '1 second'");
  for (const id of ['13', '14']) p.locations.set(`/api/v2/list/${id}`, { id, statuses: [{ status: `New ${id}`, type: 'custom' }] });
  await base.click('status_retry', limited.messages.at(-1)!, alice, 'cooldowns-ended');
  expect(base.messages.at(-1)!.buttons!.some(button => button.label === 'Enregistrer')).toBe(true);
});

it('does not apply a Save rejected during cooldown when its delivery is retried after later draft edits', async () => {
  const p = provider([]), h = await connected(p);
  await h.text('clickup statuts'); await chooseStatus(h, 'Unused', false); const draft = h.messages.at(-1)!;
  await sql.query("INSERT INTO clickup_limits(owner,connection_id,retry_at) SELECT owner,connection_id,now()+interval '2 minutes' FROM clickup_connections");
  const update = h.messenger.update; h.messenger.update = async () => { throw new SlackDeliveryRejected('rejected'); };
  await expect(h.click('status_save', draft, alice, 'cooldown-save')).rejects.toThrow('rejected');
  h.messenger.update = update; await chooseStatus(h, 'Closed', true, draft);
  await sql.query("UPDATE clickup_limits SET retry_at=now()-interval '1 second'");
  await h.click('status_save', draft, alice, 'cooldown-save');
  await h.text('clickup statuts'); expect(h.messages.at(-1)!.text).toContain('Filtre par défaut');
});

async function chooseStatus(h: ReturnType<typeof harness>, name: string, selected: boolean, message = h.messages.at(-1)!, eventId?: string) {
  const label = `${selected ? 'Ajouter' : 'Retirer'} ${name.slice(0, 60)}`;
  const button = message.buttons!.find(button => button.label === label)!;
  expect(button, label).toBeDefined();
  const route = h.modules.action(button.action, button.value);
  await h.run({ ...route, payload: { ...route.payload, timestamp: message.timestamp } }, alice, eventId);
}

it('saves a personal completed-status filter without changing an earlier task snapshot', async () => {
  const p = provider([[...Array.from({ length: 9 }, (_, index) => task(`active${index}`)), task('done', { status: { status: 'Finished', type: 'done' } }), task('closed', { status: { status: 'Closed', type: 'closed' } })]]), h = await connected(p);
  await h.text('clickup tasks'); const original = h.messages.at(-1)!;
  await h.text('clickup statuts');
  await chooseStatus(h, 'In progress', false);
  await chooseStatus(h, 'Unused', false);
  await chooseStatus(h, 'Finished', true);
  await chooseStatus(h, 'Closed', true);
  await h.click('status_save');
  expect(h.messages.at(-1)!.text).toContain('enregistré');
  await h.click('page', original);
  expect(h.messages.at(-1)!.text).toContain('tous les statuts non terminés');
  expect(h.messages.at(-1)!.table!.rows[0]![0]).toEqual([{ text: 'Task active8', url: 'https://app.clickup.com/t/active8' }]);
  await h.text('clickup tasks');
  expect(h.messages.at(-1)!.table!.rows.map(row => row[0])).toEqual([[{ text: 'Task closed', url: 'https://app.clickup.com/t/closed' }], [{ text: 'Task done', url: 'https://app.clickup.com/t/done' }]]);
  expect(h.messages.at(-1)!.text).toContain('Finished');
  expect(new URL(`https://unused${p.calls.filter(path => path.startsWith('/api/v2/team/42/task')).at(-1)}`).searchParams.get('include_closed')).toBe('true');
  await h.click('tasks', original);
  expect(h.messages.at(-1)!.text).toContain('Finished');
  await h.text('clickup statuses');
  expect(h.messages.at(-1)!.buttons!.map(button => button.label)).toEqual(expect.arrayContaining(['Retirer Finished', 'Retirer Closed', 'Ajouter In progress']));
});

it('does not turn a rejected empty save into a later successful save when delivery is retried', async () => {
  const h = await connected(provider([]));
  await h.text('clickup statuses');
  await chooseStatus(h, 'In progress', false); await chooseStatus(h, 'Unused', false);
  const empty = h.messages.at(-1)!, update = h.messenger.update;
  h.messenger.update = async () => { throw new SlackDeliveryRejected('rejected'); };
  await expect(h.click('status_save', empty, alice, 'empty-save')).rejects.toThrow('rejected');
  h.messenger.update = update;
  await chooseStatus(h, 'Finished', true, empty);
  await h.click('status_save', empty, alice, 'empty-save');
  await h.text('clickup statuses');
  expect(h.messages.at(-1)!.text).toContain('Filtre par défaut');
});

it('cancels draft edits and applies a reset only after Enregistrer', async () => {
  const h = await connected(provider([[task('active'), task('unused', { status: { status: 'Unused', type: 'open' } })]]));
  await h.text('clickup statuses'); await chooseStatus(h, 'Unused', false); await h.click('status_save');
  await h.text('clickup statuses'); await chooseStatus(h, 'Closed', true); await h.click('status_cancel');
  await h.text('clickup statuses');
  expect(h.messages.at(-1)!.buttons!.map(button => button.label)).toContain('Ajouter Closed');
  await h.click('status_reset');
  const reset = h.messages.at(-1)!;
  await h.text('clickup tasks'); expect(h.messages.at(-1)!.text).toContain('1 tâches');
  await h.click('status_save', reset);
  await h.text('clickup tasks'); expect(h.messages.at(-1)!.text).toContain('2 tâches');
  expect(h.messages.at(-1)!.text).toContain('tous les statuts non terminés');
});

it('rejects an outdated editor instead of overwriting a newer saved filter', async () => {
  const h = await connected(provider([]));
  await h.text('clickup statuses'); const older = h.messages.at(-1)!;
  await h.text('clickup statuses'); await chooseStatus(h, 'Unused', false); await h.click('status_save');
  await chooseStatus(h, 'Finished', true, older); await h.click('status_save');
  expect(h.messages.at(-1)!.text).toContain('autre sauvegarde');
  await h.text('clickup statuses');
  expect(h.messages.at(-1)!.buttons!.map(button => button.label)).toEqual(expect.arrayContaining(['Retirer In progress', 'Ajouter Unused', 'Ajouter Finished']));
});

it('resumes incomplete status discovery without saving from a partial catalogue', async () => {
  const p = provider([]), h = await connected(p);
  p.failures.set('/api/v2/list/12', 403);
  await h.text('clickup statuses'); const incomplete = h.messages.at(-1)!;
  expect(incomplete.text).toContain('incomplète');
  expect(incomplete.buttons!.some(button => button.label === 'Enregistrer')).toBe(false);
  await chooseStatus(h, 'Closed', true);
  const retry = h.messages.at(-1)!.buttons!.find(button => button.action === 'clickup:status_retry')!;
  const forgedSave = h.modules.action('clickup:status_save', retry.value);
  await h.run({ ...forgedSave, payload: { ...forgedSave.payload, timestamp: incomplete.timestamp } });
  expect(h.messages.at(-1)!.text).toContain('incomplète');
  await h.text('clickup tasks'); expect(h.messages.at(-1)!.text).toContain('tous les statuts non terminés');
  const successfulReads = p.calls.filter(path => path.startsWith('/api/v2/team/42/space')).length;
  p.failures.delete('/api/v2/list/12'); await h.click('status_retry', incomplete);
  expect(h.messages.at(-1)!.buttons!.some(button => button.label === 'Enregistrer')).toBe(true);
  expect(p.calls.filter(path => path.startsWith('/api/v2/team/42/space'))).toHaveLength(successfulReads);
  await h.click('status_save'); await h.text('clickup statuses');
  expect(h.messages.at(-1)!.buttons!.map(button => button.label)).toContain('Retirer Closed');
});

it('does not repeat a saved effect after delivery rejection and a later reset', async () => {
  const h = await connected(provider([]));
  await h.text('clickup statuses'); await chooseStatus(h, 'Closed', true);
  const picker = h.messages.at(-1)!, update = h.messenger.update;
  h.messenger.update = async () => { throw new SlackDeliveryRejected('rejected'); };
  await expect(h.click('status_save', picker, alice, 'saved-retry')).rejects.toThrow('rejected');
  h.messenger.update = update;
  await h.text('clickup statuses'); await h.click('status_reset'); await h.click('status_save');
  await h.click('status_save', picker, alice, 'saved-retry');
  await h.text('clickup statuses'); expect(h.messages.at(-1)!.text).toContain('Filtre par défaut');
});

it('keeps preferences across disconnect, replacement and disabled-module startup while rejecting old editors', async () => {
  const p = provider([]), h = await connected(p);
  await h.text('clickup statuses'); await chooseStatus(h, 'Closed', true); await h.click('status_save');
  await h.text('clickup statuses'); const oldEditor = h.messages.at(-1)!;
  await h.text('clickup disconnect'); await h.click('confirm');
  const off = createModules(readConfig({ ...env, ENABLED_MODULES: '' }), sql, {});
  expect(off.text('clickup statuts').module).toBe('core');
  const proposal = await connect(h); await h.click('confirm', proposal);
  await h.click('status_save', oldEditor); expect(h.messages.at(-1)!.text).toContain('indisponible');
  p.changeIdentity(8); const replacement = await connect(h); await h.click('confirm', replacement);
  await h.text('clickup statuses');
  expect(h.messages.at(-1)!.buttons!.map(button => button.label)).toContain('Retirer Closed');
});

it('retains unavailable names without falling back to unfinished tasks', async () => {
  const p = provider([[task('active'), task('done', { status: { status: 'Finished', type: 'done' } })]]), h = await connected(p);
  await h.text('clickup statuses'); await chooseStatus(h, 'In progress', false); await chooseStatus(h, 'Unused', false); await chooseStatus(h, 'Finished', true); await h.click('status_save');
  for (const [path, value] of p.locations) {
    const container = value as { statuses?: Array<{ status: string; type: string }>; spaces?: Array<{ statuses: Array<{ status: string; type: string }> }> };
    const rename = (statuses: Array<{ status: string; type: string }>) => statuses.map(status => status.status === 'Finished' ? { ...status, status: 'Renamed' } : status);
    if (container.statuses) p.locations.set(path, { ...container, statuses: rename(container.statuses) });
    if (container.spaces) p.locations.set(path, { ...container, spaces: container.spaces.map(space => ({ ...space, statuses: rename(space.statuses) })) });
  }
  p.replaceTask('done', task('done', { status: { status: 'Renamed', type: 'done' } }));
  await h.text('clickup statuses');
  await h.click('status_retry');
  expect(h.messages.at(-1)!.text).toContain('Finished · indisponible');
  expect(h.messages.at(-1)!.buttons!.map(button => button.label)).toContain('Retirer Finished');
  await h.text('clickup tasks');
  expect(h.messages.at(-1)!.text).toContain('Filtre appliqué : Finished');
  expect(h.messages.at(-1)!.text).toContain('0 tâches');
  expect(h.messages.at(-1)!.table).toBeUndefined();
});

it('discovers archived, nested, folderless and shared-only definitions with one choice per name', async () => {
  const p = provider([]);
  const definitions = (name: string) => [{ status: 'In progress', type: 'custom' }, { status: name, type: 'open' }];
  p.locations.set('/api/v2/team/42/space?archived=true', { spaces: [{ id: '30', statuses: definitions('Archived') }] });
  p.locations.set('/api/v2/space/30/folder', { folders: [] }); p.locations.set('/api/v2/space/30/list', { lists: [] });
  p.locations.set('/api/v2/space/10/folder', { folders: [{ id: '11', statuses: [] }, { id: '22', parent_folder: '11' }] });
  p.locations.set('/api/v2/folder/11', { id: '11', statuses: definitions('Inherited'), folders: [{ id: '22' }] });
  p.locations.set('/api/v2/folder/22', { id: '22', statuses: definitions('Nested'), folders: [] });
  p.locations.set('/api/v2/folder/22/list', { lists: [] });
  p.locations.set('/api/v2/space/10/list', { lists: [{ id: '31' }] });
  p.locations.set('/api/v2/list/31', { id: '31', statuses: definitions('Folderless') });
  p.locations.set('/api/v2/team/42/shared', { shared: { folders: [], lists: [{ id: '32' }], tasks: [{ id: 'shared-task' }] } });
  p.locations.set('/api/v2/list/32', { id: '32', statuses: definitions('Shared list') });
  p.tasks.set('shared-task', task('shared-task', { list: { id: '33', name: 'Shared home' } }));
  p.locations.set('/api/v2/list/33', { id: '33', statuses: definitions('Shared task home') });
  const h = await connected(p); await h.text('clickup statuses');
  const picker = h.messages.at(-1)!;
  for (const name of ['Archived', 'Inherited', 'Nested', 'Folderless', 'Shared list', 'Shared task home']) expect(picker.text).toContain(name);
  expect(picker.buttons!.filter(button => button.label === 'Retirer In progress')).toHaveLength(1);
  expect(picker.buttons!.some(button => button.label === 'Enregistrer')).toBe(true);
});

it('keeps more than 100 status choices reachable and preserves a saved filter after uncertain delivery', async () => {
  const p = provider([]), statuses = Array.from({ length: 150 }, (_, index) => ({ status: `Status ${String(index).padStart(3, '0')} ${'long name '.repeat(10)}`, type: 'custom' }));
  p.locations.set('/api/v2/team/42/space', { spaces: [{ id: '10', statuses }] });
  p.locations.set('/api/v2/folder/11', { id: '11', statuses }); p.locations.set('/api/v2/list/12', { id: '12', statuses });
  const h = await connected(p); await h.text('clickup statuses');
  for (let page = 1; page < 15; page++) {
    const message = h.messages.at(-1)!, next = message.buttons!.find(button => button.label === 'Suivant')!;
    const route = h.modules.action(next.action, next.value);
    await h.run({ ...route, payload: { ...route.payload, timestamp: message.timestamp } });
  }
  expect(h.messages.at(-1)!.text).toContain('Status 149');
  expect(h.messages.at(-1)!.text).toContain('Page 15/15');
  await chooseStatus(h, statuses[149]!.status, false);
  const picker = h.messages.at(-1)!, update = h.messenger.update;
  h.messenger.update = async () => { throw new Error('uncertain'); };
  await expect(h.click('status_save', picker, alice, 'uncertain-filter-save')).rejects.toThrow('uncertain');
  h.messenger.update = update;
  await h.click('status_save', picker, alice, 'uncertain-filter-save');
  await h.text('clickup statuses');
  expect(h.messages.at(-1)!.text).toContain('149 statuts');
  p.failures.set('/api/v2/team/42/task', 400);
  await h.text('clickup tasks');
  expect(h.messages.at(-1)!.text.length).toBeLessThan(6000);
  expect(h.messages.at(-1)!.text).toContain('149 statuts');
  expect(h.messages.at(-1)!.text).toContain('sélection complète');
  expect(h.messages.at(-1)!.text).toContain('n’a pas pu être terminée');
});

it('keeps an editor recoverable during a catalogue rate-limit cooldown without asking to reconnect', async () => {
  const p = provider([]), base = await connected(p);
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => String(url).includes('/list/12')
    ? new Response('', { status: 429, headers: { 'X-RateLimit-Reset': String(Math.ceil(Date.now() / 1000) + 120) } }) : p.fetcher(url, init)) as typeof fetch;
  const h = harness(fetcher); await h.text('clickup statuses', alice, 'limited-catalogue'); const incomplete = h.messages.at(-1)!;
  await h.click('status_retry', incomplete, alice, 'limited-catalogue-retry');
  expect(h.messages.at(-1)!.text).toContain('temporairement');
  expect(h.messages.at(-1)!.text).not.toContain('Reconnectez');
  expect(h.messages.at(-1)!.buttons!.some(button => button.label === 'Réessayer')).toBe(true);
  // Simulate the provider's cooldown ending, then reconstruct the process.
  await sql.query('UPDATE clickup_limits SET retry_at=now()-interval \'1 second\'');
  await base.click('status_retry', incomplete, alice, 'catalogue-recovered');
  expect(base.messages.at(-1)!.buttons!.some(button => button.label === 'Enregistrer')).toBe(true);
});

it('keeps each User’s saved filter independent and rejects another DM or message and expired editors', async () => {
  const p = provider([]), h = await connected(p), bob = { ...alice, user: 'UBOB', channel: 'DBOB' };
  await h.text('clickup statuts'); await chooseStatus(h, 'Closed', true); await h.click('status_save');
  p.changeIdentity(8); const proposal = await connect(h, bob); await h.click('confirm', proposal, bob);
  await h.text('clickup statuses', bob); expect(h.messages.at(-1)!.text).toContain('Filtre par défaut');
  await h.click('status_save', h.messages.at(-1)!, bob);
  p.changeIdentity(7); await h.text('clickup statuses'); const picker = h.messages.at(-1)!;
  expect(picker.buttons!.map(button => button.label)).toContain('Retirer Closed');
  await h.click('status_reset', picker, { ...alice, channel: 'DOTHER' }); expect(h.messages.at(-1)!.text).toContain('indisponible');
  await h.click('status_reset', { ...picker, timestamp: '999.000' }); expect(h.messages.at(-1)!.text).toContain('indisponible');
  await sql.query("UPDATE clickup_status_editors SET expires_at=now()-interval '1 second'");
  await h.click('status_reset', picker); expect(h.messages.at(-1)!.text).toContain('expiré');
  await h.text('clickup statuses'); expect(h.messages.at(-1)!.buttons!.map(button => button.label)).toContain('Retirer Closed');
});

it('blocks an unresolved shared task’s home List and hides a cached catalogue after workspace revocation', async () => {
  const p = provider([]), h = await connected(p);
  p.locations.set('/api/v2/team/42/shared', { shared: { folders: [], lists: [], tasks: [{ id: 'shared' }] } });
  p.tasks.set('shared', task('shared', { list: { id: '33', name: 'Private home' } }));
  p.locations.set('/api/v2/list/33', { id: '33', statuses: [] });
  await h.text('clickup statuts'); const picker = h.messages.at(-1)!;
  expect(picker.text).toContain('incomplète'); expect(picker.buttons!.some(button => button.label === 'Enregistrer')).toBe(false);
  p.failures.set('/api/v2/team', 403);
  await h.click('status_retry', picker);
  expect(h.messages.at(-1)!.text).toContain('Reconnectez'); expect(h.messages.at(-1)!.text).not.toContain('Unused');
  p.failures.clear(); p.locations.set('/api/v2/list/33', { id: '33', statuses: [{ status: 'Shared unused', type: 'custom' }] });
  await h.click('status_retry', picker);
  expect(h.messages.at(-1)!.text).toContain('Shared unused'); expect(h.messages.at(-1)!.buttons!.some(button => button.label === 'Enregistrer')).toBe(true);
});

it('routes signed French status commands and editor controls through Slack ingress and dispatch', async () => {
  const h = await connected(provider([])), app = createServer(readConfig(env), new JobStore(sql), h.modules);
  const signed = (raw: string) => { const timestamp = String(Math.floor(Date.now() / 1000)); return { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${createHmac('sha256', 'secret').update(`v0:${timestamp}:${raw}`).digest('hex')}` }; };
  try {
    const raw = JSON.stringify({ type: 'event_callback', team_id: alice.team, event_id: 'status-command', event: { type: 'message', channel_type: 'im', user: alice.user, channel: alice.channel, text: 'clickup statuts' } });
    expect((await app.inject({ method: 'POST', url: '/slack/events', payload: raw, headers: { ...signed(raw), 'content-type': 'application/json' } })).statusCode).toBe(200);
    const job = (await sql.query("SELECT * FROM jobs WHERE id='slack:status-command'")).rows[0];
    expect(job.module).toBe('clickup'); expect(job.payload.text).toBe('statuses');
    await h.run(job, job.actor, job.id); const picker = h.messages.at(-1)!;
    const add = picker.buttons!.find(button => button.label === 'Ajouter Closed')!;
    const action = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: alice.team }, user: { id: alice.user }, channel: { id: alice.channel }, message: { ts: picker.timestamp }, actions: [{ action_id: add.action, value: add.value }] }) }).toString();
    expect((await app.inject({ method: 'POST', url: '/slack/actions', payload: action, headers: { ...signed(action), 'content-type': 'application/x-www-form-urlencoded' } })).statusCode).toBe(200);
    const click = (await sql.query("SELECT * FROM jobs WHERE id LIKE 'action:%'")).rows[0];
    expect(click.payload.action).toBe('status_add');
    await h.run(click, click.actor, click.id); expect(h.messages.at(-1)!.buttons!.map(button => button.label)).toContain('Retirer Closed');
    await h.click('status_save'); await h.text('clickup statuses');
    expect(h.messages.at(-1)!.buttons!.map(button => button.label)).toContain('Retirer Closed');
  } finally { await app.close(); }
});

it('fetches all raw pages and lists direct assignments in a linked eight-row table, excluding only completed/individual archives', async () => {
  const p = provider([
    [task('done', { status: { status: 'Finished', type: 'done' } }), task('closed', { status: { status: 'Complete', type: 'closed' } }), task('archived', { archived: true }), task('other', { assignees: [{ id: 8 }] })],
    [task('old', { due_date: String(Date.UTC(2020, 0, 1)) }), task('subtask', { parent: 'someone-elses-task', assignees: [{ id: 7 }, { id: 8 }] }), task('active-in-archived-folder', { folder: { archived: true } }), ...Array.from({ length: 7 }, (_, i) => task(`item${i}`))],
  ]);
  const h = await connected(p);
  await h.text('clickup tasks');
  const first = h.messages.at(-1)!;
  expect(first.table!.columns).toEqual(['Tâche', 'Statut', 'Échéance', 'Priorité', 'Workspace', 'Liste']);
  expect(first.table!.rows).toHaveLength(8);
  expect(first.table!.rows[0]![0]).toEqual([{ text: 'Task old', url: 'https://app.clickup.com/t/old' }]);
  expect(first.text).toContain('10 tâches');
  expect(p.calls.filter(url => url.startsWith('/api/v2/team/42/task')).map(url => new URL(`https://unused${url}`).searchParams.get('page'))).toEqual(['0', '1', '2']);
  await h.click('page', first);
  expect(h.messages.at(-1)!.table!.rows).toHaveLength(2);
  expect(p.calls.some(url => url.includes('/team/99/task'))).toBe(false);
});

it('hides cached task text when task access, workspace access or authenticated identity is lost', async () => {
  const p = provider([Array.from({ length: 10 }, (_, i) => task(`a${i}`, { name: `Secret ${i}` }))]), h = await connected(p);
  await h.text('clickup tasks'); const first = h.messages.at(-1)!;
  p.failures.set('/api/v2/task/a8', 403);
  await h.click('page', first);
  expect(JSON.stringify(h.messages.at(-1)!.table)).not.toContain('Secret 8');
  expect(h.messages.at(-1)!.text).toContain('masquées');
  p.changeWorkspace('999');
  await h.click('page', first);
  expect(h.messages.at(-1)!.table).toBeUndefined();
  expect(h.messages.at(-1)!.text).toContain('Aucun contenu');
  p.changeWorkspace('42'); p.changeIdentity(8);
  await h.click('page', first);
  expect(h.messages.at(-1)!.table).toBeUndefined();
});

it('shows partial coverage when provider pages fail and detects repeated pagination without truncating silently', async () => {
  const p = provider([[task('one')], [task('two')]]), h = await connected(p);
  p.failures.set('/api/v2/team/42/task?assignees%5B%5D=7&subtasks=true&include_closed=false&page=1&order_by=id', 400);
  await h.text('clickup tasks');
  expect(h.messages.at(-1)!.text).toContain('Résultats incomplets : 1 tâches récupérées');
  expect(h.messages.at(-1)!.buttons!.some(button => button.label === 'Réessayer')).toBe(true);
  p.failures.clear();
  p.tasks.set('two', task('two'));
  const looping = provider([[task('one')], [task('one')]]), h2 = harness(looping.fetcher);
  // A new harness shares the persisted active connection and module tables.
  await h2.text('clickup tasks', alice, 'looping-request');
  expect(h2.messages.at(-1)!.text).toContain('pagination ClickUp n’a pas progressé');
});

it('disconnects only after confirmation, invalidates results and cannot replay against a later connection', async () => {
  const p = provider([[task('one')]]), h = await connected(p);
  await h.text('clickup tasks'); const result = h.messages.at(-1)!;
  await h.text('clickup disconnect'); const disconnect = h.messages.at(-1)!;
  await h.text('clickup tasks'); expect(h.messages.at(-1)!.table).toBeDefined();
  await h.click('confirm', disconnect);
  expect(h.messages.at(-1)!.text).toContain('déconnecté');
  await h.click('tasks', result);
  expect(h.messages.at(-1)!.text).toContain('Connectez');
  const proposal = await connect(h); await h.click('confirm', proposal);
  await h.click('confirm', disconnect);
  await h.text('clickup tasks'); expect(h.messages.at(-1)!.table).toBeDefined();
});

it('rejects another Slack user sharing the same ClickUp account and preserves the first connection', async () => {
  const p = provider([]), h = await connected(p), bob = { ...alice, user: 'UBOB', channel: 'DBOB' };
  const app = createServer(readConfig(env), new JobStore(sql), h.modules);
  await h.text('clickup connect', bob);
  const url = new URL(h.messages.at(-1)!.resourceLinks![0]!.url), start = await app.inject(url.pathname + url.search);
  await app.inject({ url: `/auth/clickup/callback?state=${new URL(start.headers.location!).searchParams.get('state')}&code=code`, headers: { cookie: String(start.headers['set-cookie']).split(';')[0]! } });
  const job = (await sql.query("SELECT * FROM jobs WHERE owner='TTEAM:UBOB' AND module='clickup'")).rows[0];
  await h.run({ module: job.module, payload: job.payload }, bob, job.id);
  await h.click('confirm', h.messages.at(-1)!, bob);
  expect(h.messages.at(-1)!.text).toContain('déjà connecté');
  await h.text('clickup tasks', bob); expect(h.messages.at(-1)!.text).toContain('Connectez');
  await h.text('clickup tasks'); expect(h.messages.at(-1)!.text).toContain('0 tâches');
  await app.close();
});

it('rejects a wrong browser, replayed and expired OAuth links and unauthorized Mayasquad access', async () => {
  const p = provider([]), h = harness(p.fetcher); await h.module.initialize?.(sql);
  const app = createServer(readConfig(env), new JobStore(sql), h.modules);
  await h.text('clickup connect');
  const url = new URL(h.messages.at(-1)!.resourceLinks![0]!.url), start = await app.inject(url.pathname + url.search);
  expect(start.headers['set-cookie']).toContain('HttpOnly'); expect(start.headers['set-cookie']).toContain('Secure');
  expect((await app.inject(url.pathname + url.search)).statusCode).toBe(400);
  const callback = `/auth/clickup/callback?state=${new URL(start.headers.location!).searchParams.get('state')}&code=code`;
  expect((await app.inject({ url: callback, headers: { cookie: 'clickup_oauth=wrong' } })).statusCode).toBe(400);
  expect(p.calls.filter(url => url.includes('oauth/token'))).toHaveLength(0);
  expect((await app.inject({ url: callback, headers: { cookie: String(start.headers['set-cookie']).split(';')[0]! } })).statusCode).toBe(400);
  await h.text('clickup connect');
  const expired = new URL(h.messages.at(-1)!.resourceLinks![0]!.url);
  await sql.query("UPDATE clickup_oauth_states SET expires_at=now()-interval '1 second'");
  expect((await app.inject(expired.pathname + expired.search)).statusCode).toBe(400);
  p.changeWorkspace('999');
  await expect(connect(h)).rejects.toThrow();
  await app.close();
});

it('never renews expired results or connection confirmations and rejects wrong-DM/message controls', async () => {
  const p = provider([Array.from({ length: 10 }, (_, i) => task(`a${i}`))]), h = await connected(p);
  await h.text('clickup tasks'); const result = h.messages.at(-1)!;
  await h.click('tasks', result, { ...alice, channel: 'DOTHER' }); expect(h.messages.at(-1)!.text).toContain('indisponible');
  await h.click('tasks', { ...result, timestamp: '999.000' }); expect(h.messages.at(-1)!.text).toContain('indisponible');
  await sql.query("UPDATE clickup_scans SET expires_at=now()-interval '1 second'");
  await h.click('page', result);
  expect(h.messages.at(-1)!.text).toContain('expirés');
  const proposal = await connect(h);
  await sql.query("UPDATE clickup_confirmations SET expires_at=now()-interval '1 second' WHERE status='pending'");
  await h.click('confirm', proposal); expect(h.messages.at(-1)!.text).toContain('expirée');
});

it('admits signed French commands and Refresh into one operation slot and hides a disabled module', async () => {
  const p = provider([]), h = await connected(p), app = createServer(readConfig(env), new JobStore(sql), h.modules);
  await h.text('clickup tasks'); const result = h.messages.at(-1)!;
  const signed = (raw: string) => { const timestamp = String(Math.floor(Date.now() / 1000)); return { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${createHmac('sha256', 'secret').update(`v0:${timestamp}:${raw}`).digest('hex')}` }; };
  const raw = JSON.stringify({ type: 'event_callback', team_id: alice.team, event_id: 'first', event: { type: 'message', channel_type: 'im', user: alice.user, channel: alice.channel, text: 'clickup tâches' } });
  expect((await app.inject({ method: 'POST', url: '/slack/events', payload: raw, headers: { ...signed(raw), 'content-type': 'application/json' } })).statusCode).toBe(200);
  const raw2 = raw.replace('first', 'second');
  await app.inject({ method: 'POST', url: '/slack/events', payload: raw2, headers: { ...signed(raw2), 'content-type': 'application/json' } });
  const jobs = (await sql.query("SELECT * FROM jobs WHERE id IN('slack:first','slack:second') ORDER BY id")).rows;
  expect(jobs[0].module).toBe('clickup'); expect(jobs[1].payload.original).toBe('slack:first'); expect(jobs[1].module).toBe('core');
  const refresh = result.buttons!.find(button => button.action === 'clickup:tasks')!;
  const action = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: alice.team }, user: { id: alice.user }, channel: { id: alice.channel }, message: { ts: result.timestamp }, actions: [{ action_id: refresh.action, value: refresh.value }] }) }).toString();
  expect((await app.inject({ method: 'POST', url: '/slack/actions', payload: action, headers: { ...signed(action), 'content-type': 'application/x-www-form-urlencoded' } })).statusCode).toBe(200);
  const duplicate = (await sql.query("SELECT payload FROM jobs WHERE id LIKE 'action:%'")).rows[0];
  expect(duplicate.payload.original).toBe('slack:first');
  const disabled = createModules(readConfig({ ...env, ENABLED_MODULES: '' }), sql, {});
  expect(disabled.text('clickup tasks').module).toBe('core');
  const off = createServer(readConfig(env), new JobStore(sql), disabled);
  expect((await off.inject('/auth/clickup')).statusCode).toBe(404);
  await app.close(); await off.close();
});

it('renders the result as a native Slack table with literal values and ClickUp links', async () => {
  const p = provider([[task('one', { name: '<@UOTHER> **literal**' })]]), h = await connected(p);
  await h.text('clickup tasks'); const result = h.messages.at(-1)!;
  const sent: any[] = [];
  const slack = new Slack('fake', (async (_input, init) => { sent.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }) as typeof fetch);
  await slack.send(alice, result);
  const table = sent[0].blocks.find((block: any) => block.type === 'table');
  expect(table.rows.length).toBe(2);
  expect(JSON.stringify(table)).toContain('https://app.clickup.com/t/one');
});

it('recovers a confirmed connection after definite delivery rejection without repeating its effect', async () => {
  const p = provider([]), h = harness(p.fetcher), proposal = await connect(h);
  const post = h.messenger.post;
  h.messenger.post = async () => { throw new SlackDeliveryRejected('rejected'); };
  await expect(h.click('confirm', proposal, alice, 'approve-retry')).rejects.toThrow('rejected');
  h.messenger.post = post;
  await h.click('confirm', proposal, alice, 'approve-retry');
  expect(h.messages.at(-1)!.text).toContain('connecté');
  await h.text('clickup tasks'); expect(h.messages.at(-1)!.text).toContain('0 tâches');
});

it('reuses saved scan pages after a restart or delivery rejection and does not repeat uncertain delivery', async () => {
  const p = provider([[task('one')]]), h = await connected(p);
  const post = h.messenger.post;
  h.messenger.post = async () => { throw new SlackDeliveryRejected('rejected'); };
  await expect(h.text('clickup tasks', alice, 'scan-retry')).rejects.toThrow('rejected');
  const pageCalls = p.calls.filter(url => url.startsWith('/api/v2/team/42/task')).length;
  const restarted = harness(p.fetcher);
  await restarted.text('clickup tasks', alice, 'scan-retry');
  expect(p.calls.filter(url => url.startsWith('/api/v2/team/42/task'))).toHaveLength(pageCalls);
  expect(restarted.messages.at(-1)!.text).toContain('1 tâches');
  h.messenger.post = async () => { throw new Error('uncertain timeout'); };
  await expect(h.text('clickup tasks', alice, 'scan-uncertain')).rejects.toThrow('uncertain');
  h.messenger.post = post;
  const count = h.messages.length;
  await h.text('clickup tasks', alice, 'scan-uncertain');
  expect(h.messages).toHaveLength(count);
});

it('respects a future rate-limit reset across fresh requests and process reconstruction', async () => {
  const p = provider([]), h = await connected(p);
  let rejectedCalls = 0;
  const limitedFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/team/42/task')) { rejectedCalls++; return new Response('', { status: 429, headers: { 'X-RateLimit-Reset': String(Math.ceil(Date.now() / 1000) + 120) } }); }
    return p.fetcher(url, init);
  }) as typeof fetch;
  const limited = harness(limitedFetch);
  await limited.text('clickup tasks', alice, 'limited-first');
  expect(limited.messages.at(-1)!.text).toContain('incomplets');
  const restarted = harness(limitedFetch);
  await restarted.text('clickup tasks', alice, 'limited-second');
  expect(rejectedCalls).toBe(1);
});

it('retries temporary provider errors and resolves missing own-archive metadata without inspecting ancestors', async () => {
  const missingArchive = task('one'); delete (missingArchive as { archived?: boolean }).archived;
  const p = provider([[missingArchive]]); p.tasks.set('one', task('one', { folder: { archived: true } }));
  let attempts = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/team/42/task') && ++attempts <= 2) return new Response('', { status: 503 });
    return p.fetcher(url, init);
  }) as typeof fetch;
  const h = harness(fetcher), proposal = await connect(h); await h.click('confirm', proposal);
  await h.text('clickup tasks');
  expect(h.messages.at(-1)!.text).toContain('1 tâches');
  expect(h.messages.at(-1)!.table).toBeDefined();
  expect(attempts).toBe(4); // Two failed attempts, successful page zero and terminal empty page.
  expect(p.calls.some(url => url.includes('/folder/'))).toBe(false);
});

it('preserves pending replacement until approval and invalidates old results only when the new account is activated', async () => {
  const p = provider([Array.from({ length: 10 }, (_, i) => task(`a${i}`))]), h = await connected(p);
  await h.text('clickup tasks'); const result = h.messages.at(-1)!;
  p.changeIdentity(8); const replacement = await connect(h); p.changeIdentity(7);
  await h.click('page', result); expect(h.messages.at(-1)!.table).toBeDefined();
  p.changeIdentity(8); await h.click('confirm', replacement);
  expect(h.messages.at(-1)!.text).toContain('connecté');
  await h.click('page', result); expect(h.messages.at(-1)!.text).toContain('ancienne connexion');
  expect(h.messages.at(-1)!.table).toBeUndefined();
});

it.each(['replacement', 'initial'])('cancels a %s callback waiting on the provider across a confirmed disconnect', async kind => {
  const p = provider([]), h = kind === 'replacement' ? await connected(p) : harness(p.fetcher);
  await h.module.initialize?.(sql);
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), paused = new Promise<void>(resolve => { resume = resolve; });
  const slow = harness((async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/oauth/token')) { entered(); await paused; }
    return p.fetcher(url, init);
  }) as typeof fetch);
  const app = createServer(readConfig(env), new JobStore(sql), slow.modules);
  await slow.text('clickup connect', alice, 'slow-invitation');
  const invitation = new URL(slow.messages.at(-1)!.resourceLinks![0]!.url), start = await app.inject(invitation.pathname + invitation.search);
  const callback = app.inject({ url: `/auth/clickup/callback?state=${new URL(start.headers.location!).searchParams.get('state')}&code=code`, headers: { cookie: String(start.headers['set-cookie']).split(';')[0]! } });
  const callbackResult = Promise.resolve(callback); await started;
  if (kind === 'initial') { const proposal = await connect(h); await h.click('confirm', proposal); }
  await h.text('clickup disconnect', alice, 'disconnect-during-callback'); await h.click('confirm', h.messages.at(-1)!);
  resume(); expect((await callbackResult).statusCode).toBe(400);
  await h.text('clickup tasks'); expect(h.messages.at(-1)!.text).toContain('Connectez');
  // Persistent credential cleanup is the externally observable security requirement at this DB boundary.
  expect((await sql.query("SELECT id FROM clickup_confirmations WHERE status='pending' AND data ? 'tokens'")).rows).toEqual([]);
  await app.close();
});

it('does not retain a pending credential when queuing its confirmation fails, and a fresh authorization recovers', async () => {
  const p = provider([]), h = harness(p.fetcher); await h.module.initialize?.(sql);
  await sql.query("ALTER TABLE jobs ADD CONSTRAINT fail_clickup_enqueue CHECK(module <> 'clickup')");
  try {
    await expect(connect(h)).rejects.toThrow();
    expect((await sql.query("SELECT id FROM clickup_confirmations WHERE status='pending'")).rows).toEqual([]);
  } finally { await sql.query('ALTER TABLE jobs DROP CONSTRAINT fail_clickup_enqueue'); }
  const proposal = await connect(h); await h.click('confirm', proposal);
  expect(h.messages.at(-1)!.text).toContain('connecté');
});
