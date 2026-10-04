import { createHmac, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { readConfig } from '../src/app/config.js';
import { createModules } from '../src/app/modules.js';
import { dispatchJob } from '../src/core/dispatch.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { createServer } from '../src/core/server.js';
import { Slack } from '../src/core/slack.js';
import { coreSchema, JobStore } from '../src/core/store.js';
import type { Database } from '../src/core/transactions.js';
import { createDevelopmentModule } from '../src/modules/development/index.js';
import { DevelopmentStore } from '../src/modules/development/store.js';
import { projectSchema, type Ticket } from '../src/modules/development/domain.js';

const token = 'synthetic-worker-token-at-least-32-characters';
const env = { PUBLIC_URL: 'https://agent.example.com', DATABASE_URL: 'postgresql://unused', SLACK_TEAM_ID: 'TTEAM', SLACK_BOT_TOKEN: 'bot', SLACK_SIGNING_SECRET: 'secret', ENABLED_MODULES: 'development', DEVELOPMENT_CLICKUP_TOKEN: 'clickup', DEVELOPMENT_WORKER_TOKEN: token };
const config = readConfig(env), alice = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
const project = projectSchema.parse({ id: 'pilot', name: 'Projet pilote', channel: 'CPROJECT', folder: '123', repository: 'https://github.com/example/project', skill: 'maintenance' });
let db: PGlite;
const apps: Array<{ close(): Promise<void> }> = [];
beforeAll(async () => { db = new PGlite(); await db.exec(coreSchema); });
beforeEach(async () => { await db.exec('TRUNCATE jobs,ai_calls,ai_months,core_navigation_menus,core_navigation_deliveries,core_operation_slots CASCADE; DROP TABLE IF EXISTS development_projects,development_threads,development_ticket_state,development_runs,development_effects,development_receipts,development_health CASCADE'); });
afterAll(async () => { for (const app of apps) await app.close(); await db.close(); });

async function harness() {
  const sql: Database = { query: (text, values) => db.query(text, values), transaction: work => db.transaction(tx => work({ query: (text, values) => tx.query(text, values) })) };
  const tasks = new Map<string, Ticket>([['abc123', { id: 'abc123', name: 'Réparer le menu', description: 'Le menu ne se ferme pas au clic.', url: 'https://app.clickup.com/t/abc123', status: 'open', comments: [], attachments: [] }]]);
  const comments: string[] = [], statuses: string[] = [], posts: any[] = [];
  let counter = 0, snapshots = 0, rejectStatus = false, rejectPost = false;
  const fetcher = (async (url: URL | string, init?: RequestInit) => {
    const target = new URL(String(url)), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (target.hostname === 'api.clickup.com') {
      if (target.pathname.endsWith('/folder/123/list')) return Response.json({ lists: [{ id: 'list1' }] });
      if (target.pathname.endsWith('/list/list1/task')) return Response.json({ tasks: [...tasks.values()].map(task => ({ id: task.id, status: { status: task.status } })), last_page: true });
      const match = /\/task\/([^/]+)(\/comment)?$/.exec(target.pathname);
      if (!match || !tasks.has(match[1]!)) return Response.json({}, { status: 404 });
      const task = tasks.get(match[1]!)!;
      if (match[2] && init?.method === 'POST') { comments.push(body.comment_text); task.comments.push(body.comment_text); return Response.json({ id: randomUUID() }); }
      if (match[2]) return Response.json({ comments: task.comments.map((text, index) => ({ id: String(index), date: index, comment_text: text })) });
      if (init?.method === 'PUT') {
        statuses.push(body.status); task.status = body.status;
        if (rejectStatus) { rejectStatus = false; throw new Error('Network lost after provider applied status'); }
        return Response.json({ id: task.id });
      }
      snapshots++;
      return Response.json({ id: task.id, name: task.name, description: task.description, status: { status: task.status }, list: { id: 'list1' } });
    }
    if (target.pathname.endsWith('/conversations.info')) return Response.json({ ok: true, channel: { id: body.channel, is_member: body.channel === 'CPROJECT' } });
    if (target.pathname.endsWith('/conversations.members')) return Response.json({ ok: true, members: ['UALICE', 'UBOB'] });
    if (target.pathname.endsWith('/chat.postMessage') || target.pathname.endsWith('/chat.update')) {
      const ts = `1700000000.${String(++counter).padStart(6, '0')}`;
      posts.push({ ...body, ts });
      if (rejectPost) { rejectPost = false; throw new Error('Uncertain Slack delivery'); }
      return Response.json({ ok: true, ts });
    }
    throw new Error(`Unexpected provider ${target.pathname}`);
  }) as typeof fetch;
  const module = createDevelopmentModule({ ...config, ...env }, sql, { fetcher });
  await module.initialize!(sql);
  const modules = new ModuleRegistry([module]), app = createServer(config, new JobStore(sql), modules); apps.push(app);
  const messenger = new Slack('bot', fetcher), store = new DevelopmentStore(sql, 'TTEAM');
  const run = async (id: string) => {
    const row = (await sql.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
    const until = await dispatchJob(sql, config, modules, messenger, row);
    if (until) await new JobStore(sql).defer(id, until); else await new JobStore(sql).complete(id);
  };
  const ingress = async (text: string, options: { user?: string; channel?: string; thread?: string; id?: string; team?: string } = {}) => {
    const id = options.id ?? randomUUID(), stamp = String(Math.floor(Date.now() / 1000));
    const raw = JSON.stringify({ type: 'event_callback', team_id: options.team ?? 'TTEAM', event_id: id,
      event: { type: 'message', channel_type: options.channel?.startsWith('D') ? 'im' : 'channel', channel: options.channel ?? 'CPROJECT', user: options.user ?? 'UALICE', ts: options.thread ? '1700000000.000002' : '1700000000.000001', ...(options.thread ? { thread_ts: options.thread } : {}), text } });
    const response = await app.inject({ method: 'POST', url: '/slack/events', payload: raw, headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': stamp, 'x-slack-signature': `v0=${createHmac('sha256', 'secret').update(`v0:${stamp}:${raw}`).digest('hex')}` } });
    return { id: options.channel?.startsWith('D') ? `slack:${id}` : `development:slack:${id}`, response };
  };
  const dm = async (text: string, user = 'UALICE') => { const request = await ingress(text, { channel: 'DALICE', user }); await run(request.id); };
  const api = async (route: string, body: unknown, bearer = token) => app.inject({ method: 'POST', url: `/development/worker/${route}`, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` } });
  return { sql, store, tasks, comments, statuses, posts, run, dm, ingress, api, module, modules, app,
    poll: () => run('development:poll:TTEAM'), configure: () => dm(`development configure ${JSON.stringify(project)}`),
    snapshotCount: () => snapshots, failStatus: () => { rejectStatus = true; }, failPost: () => { rejectPost = true; } };
}

it('configures through signed DM dispatch and restricts configuration/status to channel members', async () => {
  const h = await harness();
  await h.configure(); expect(await h.store.project('pilot')).toEqual(project);
  await h.dm(`development configure ${JSON.stringify({ ...project, skill: 'other' })}`, 'UOUTSIDER');
  expect((await h.store.project('pilot'))!.skill).toBe('maintenance');
  await h.dm('development projects', 'UOUTSIDER');
  expect(h.posts.at(-1).text).toContain('Aucun projet accessible');
  expect((await h.ingress('https://app.clickup.com/t/abc123', { team: 'TOTHER' })).response.statusCode).toBe(403);
  expect((await h.api('claim', { worker: randomUUID(), projects: ['pilot'] }, 'wrong')).statusCode).toBe(401);
});

it('queues one review for duplicate signed channel deliveries and preserves Slack clarifications before authorization', async () => {
  const h = await harness(); await h.configure();
  const request = await h.ingress('<https://app.clickup.com/t/abc123|ticket>', { id: 'same' });
  await h.ingress('<https://app.clickup.com/t/abc123|ticket>', { id: 'same' });
  const reply = await h.ingress('Au clic sur le fond du menu.', { thread: '1700000000.000001', user: 'UBOB' });
  await h.run(request.id); expect((await h.store.history('pilot'))).toHaveLength(1);
  await h.run(reply.id);
  expect(h.comments).toHaveLength(1); expect(h.comments[0]).toContain('Au clic sur le fond');
  expect(await h.store.history('pilot')).toHaveLength(2);
  const unauthorized = await h.ingress('secret', { thread: '1700000000.000001', user: 'UOUTSIDER' });
  await h.run(unauthorized.id); expect(h.comments).toHaveLength(1);
  const unrelated = await h.ingress('https://app.clickup.com/t/abc123', { channel: 'COTHER' });
  expect((await h.sql.query('SELECT * FROM jobs WHERE id=$1', [unrelated.id])).rows).toHaveLength(0);
});

it('polls Ready for AI directly, freezes requirements, serializes work and admits at most two attempts', async () => {
  const h = await harness(); await h.configure(); h.tasks.get('abc123')!.status = 'Ready for AI';
  await h.poll(); const initialReads = h.snapshotCount();
  h.tasks.get('abc123')!.description = 'Changed after authorization'; await h.poll();
  expect(h.snapshotCount()).toBe(initialReads);
  const worker = randomUUID(), other = randomUUID();
  const work = (await h.api('claim', { worker, projects: ['pilot'] })).json().work;
  expect(work.ticket.description).toBe('Le menu ne se ferme pas au clic.');
  expect((await h.api('claim', { worker: other, projects: ['pilot'] })).json().work).toBeNull();
  expect((await h.api('claim', { worker, projects: ['pilot'] })).json().work.id).toBe(work.id);
  expect((await h.api('attempt', { id: work.id, lease: work.lease, expected: 0 })).json().attempt).toBe(1);
  expect((await h.api('attempt', { id: work.id, lease: work.lease, expected: 0 })).statusCode).toBe(409);
  expect((await h.api('attempt', { id: work.id, lease: work.lease, expected: 1 })).json().attempt).toBe(2);
  expect((await h.api('attempt', { id: work.id, lease: work.lease, expected: 1 })).statusCode).toBe(409);
  const result = { outcome: 'pushed', branch: 'maintenance/ai', summary: 'Menu corrigé.', tests: ['Tests réussis'], commit: 'a'.repeat(40) };
  expect((await h.api('result', { id: work.id, lease: work.lease, result })).statusCode).toBe(200);
  expect((await h.api('result', { id: work.id, lease: work.lease, result })).statusCode).toBe(200);
  await h.run(`development:finish:${work.id}`);
  expect(h.statuses).toEqual(['to build']); expect(h.comments).toHaveLength(1);
  expect(h.posts.at(-1).text).toContain('Commit poussé sur maintenance/ai');
  expect(h.comments[0]).toContain('Commit poussé sur maintenance/ai');
  await h.poll(); expect(await h.store.history('pilot')).toHaveLength(1);
  h.tasks.get('abc123')!.status = 'Ready for AI'; await h.poll();
  expect(await h.store.history('pilot')).toHaveLength(2);
});

it('does not retry uncertain external status changes or accidentally restart coding', async () => {
  const h = await harness(); await h.configure(); h.tasks.get('abc123')!.status = 'Ready for AI'; await h.poll();
  const work = (await h.api('claim', { worker: randomUUID(), projects: ['pilot'] })).json().work;
  await h.api('attempt', { id: work.id, lease: work.lease, expected: 0 });
  await h.api('result', { id: work.id, lease: work.lease, result: { outcome: 'pushed', summary: 'Corrigé.', tests: ['Tests réussis'], commit: 'b'.repeat(40) } });
  h.failStatus(); await h.run(`development:finish:${work.id}`);
  expect((await h.store.run(work.id)).state).toBe('reporting_error');
  expect(h.statuses).toEqual(['to build']);
  await h.dm(`development retry ${work.id}`);
  expect(await h.store.history('pilot')).toHaveLength(1);
  expect(h.posts.some(post => post.text.includes('a déjà été poussé'))).toBe(true);
});

it('reports blockers in the original thread, leaves ClickUp status unchanged, and allows explicit retry', async () => {
  const h = await harness(); await h.configure();
  const request = await h.ingress('https://app.clickup.com/t/abc123'); await h.run(request.id);
  const work = (await h.api('claim', { worker: randomUUID(), projects: ['pilot'] })).json().work;
  await h.api('attempt', { id: work.id, lease: work.lease, expected: 0 });
  await h.api('result', { id: work.id, lease: work.lease, result: { outcome: 'needs_information', summary: 'Sur quel navigateur ?', tests: [] } });
  await h.run(`development:finish:${work.id}`);
  expect(h.statuses).toEqual([]); expect(h.posts.at(-1).thread_ts).toBe('1700000000.000001');
  await h.dm(`development retry ${work.id}`); expect(await h.store.history('pilot')).toHaveLength(2);
});

it('constructs development only when enabled and leaves all other modules independent', async () => {
  const h = await harness();
  expect(createModules(config, h.sql, env).enabledIds()).toContain('development');
  expect(() => createModules(config, h.sql, { ...env, DEVELOPMENT_WORKER_TOKEN: '' })).toThrow();
  const disabled = readConfig({ ...env, ENABLED_MODULES: '' });
  expect(createModules(disabled, h.sql, { ...env, DEVELOPMENT_WORKER_TOKEN: '' }).enabledIds()).toEqual(['core']);
  expect(h.modules.text('fix this')).toEqual({ module: 'core', payload: { type: 'text', text: 'fix this' } });
  expect((await h.api('result', { id: 'absent', lease: randomUUID(), result: { outcome: 'pushed', summary: 'Fake', tests: [] } })).statusCode).toBe(409);
});
