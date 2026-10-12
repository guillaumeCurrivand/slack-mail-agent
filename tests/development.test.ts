import { createHmac, randomUUID } from 'node:crypto';
import { digest } from '../src/core/crypto.js';
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
beforeEach(async () => { await db.exec('TRUNCATE jobs,ai_calls,ai_months,core_navigation_menus,core_navigation_deliveries,core_operation_slots CASCADE; DROP TABLE IF EXISTS development_projects,development_threads,development_ticket_state,development_runs,development_effects,development_receipts,development_health,development_confirmations CASCADE'); });
afterAll(async () => { for (const app of apps) await app.close(); await db.close(); });

async function harness(failure?: 'conversations.info' | 'conversations.members' | 'clickup') {
  const sql: Database = { query: (text, values) => db.query(text, values), transaction: work => db.transaction(tx => work({ query: (text, values) => tx.query(text, values) })) };
  const tasks = new Map<string, Ticket>([['abc123', { id: 'abc123', name: 'Réparer le menu', description: 'Le menu ne se ferme pas au clic.', url: 'https://app.clickup.com/t/abc123', status: 'open', comments: [], attachments: [] }]]);
  const comments: string[] = [], statuses: string[] = [], posts: any[] = [];
  let counter = 0, snapshots = 0, rejectStatus = false, rejectPost = false;
  const fetcher = (async (url: URL | string, init?: RequestInit) => {
    const target = new URL(String(url)), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (target.hostname === 'api.clickup.com') {
      if (failure === 'clickup') return Response.json({}, { status: 403 });
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
    if (target.pathname.startsWith('/api/conversations.')) {
      // Match the production rejection: JSON POST arguments were not accepted.
      if (init?.method !== 'GET' || init.body || !target.searchParams.has('channel')) return Response.json({ ok: false, error: 'invalid_arguments' });
      if (target.pathname === `/api/${failure}`) return Response.json({ ok: false, error: 'missing_scope' });
      const channel = target.searchParams.get('channel');
      if (target.pathname.endsWith('/conversations.info')) return Response.json({ ok: true, channel: { id: channel, is_member: channel === 'CPROJECT' } });
      if (target.pathname.endsWith('/conversations.members')) {
        expect(target.searchParams.get('limit')).toBe('200');
        return Response.json(target.searchParams.get('cursor') === 'next+page'
          ? { ok: true, members: ['UALICE'], response_metadata: { next_cursor: '' } }
          : { ok: true, members: ['UBOB'], response_metadata: { next_cursor: 'next+page' } });
      }
    }
    if (target.pathname.endsWith('/chat.postMessage') || target.pathname.endsWith('/chat.update')) {
      const ts = body.ts ?? `1700000000.${String(++counter).padStart(6, '0')}`;
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
  const dm = async (text: string, user = 'UALICE') => { const request = await ingress(text, { channel: 'DALICE', user }); await run(request.id); return posts.at(-1); };
  const click = async (source: any, label: string, actor = alice, timestamp = source.ts) => {
    const controls: any[] = [];
    const walk = (value: any) => { if (!value || typeof value !== 'object') return; if (value.action_id) controls.push(value); for (const child of Object.values(value)) if (typeof child === 'object') walk(child); };
    walk(source.blocks);
    const control = controls.find(button => button.text?.text.replace(/^🧭 /, '') === label);
    expect(control, `Missing ${label}: ${controls.map(button => button.text?.text).join(', ')}`).toBeTruthy();
    const stamp = String(Math.floor(Date.now() / 1000));
    const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: actor.team }, user: { id: actor.user }, channel: { id: actor.channel }, message: { ts: timestamp }, actions: [{ action_id: control.action_id, value: control.value, action_ts: randomUUID() }] }) }).toString();
    const response = await app.inject({ method: 'POST', url: '/slack/actions', payload: raw, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': stamp, 'x-slack-signature': `v0=${createHmac('sha256', 'secret').update(`v0:${stamp}:${raw}`).digest('hex')}` } });
    expect(response.statusCode).toBe(200);
    await run(`action:${digest(raw)}`);
    return posts.at(-1);
  };
  const api = async (route: string, body: unknown, bearer = token) => app.inject({ method: 'POST', url: `/development/worker/${route}`, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` } });
  return { sql, store, tasks, comments, statuses, posts, run, dm, click, ingress, api, module, modules, app,
    poll: () => run('development:poll:TTEAM'), configure: () => dm(`development configure ${JSON.stringify(project)}`),
    snapshotCount: () => snapshots, failStatus: () => { rejectStatus = true; }, failPost: () => { rejectPost = true; } };
}

it('browses projects, configuration, history and run details through signed buttons without starting work', async () => {
  const h = await harness(); await h.configure();
  for (let index = 0; index < 10; index++) await h.store.review(project, { ...h.tasks.get('abc123')!, name: `Ticket ${index}` }, '1700000000.000001', `browse-${index}`);
  const reads = h.snapshotCount();
  const main = await h.dm('menu');
  const module = await h.click(main, 'Développement');
  expect(module.ts).toBe(main.ts);
  const projects = await h.click(module, 'Projets et traitements');
  const detail = await h.click(projects, 'Projet pilote');
  expect(detail.text).toContain('Skill : maintenance');
  expect(JSON.stringify(detail)).toContain('https://app.slack.com/client/TTEAM/CPROJECT');
  const configuration = await h.click(detail, 'Modifier la configuration');
  expect(configuration.text).toContain('development configurer');
  expect(configuration.text).toContain('https://github.com/example/project');
  const history = await h.click(await h.click(configuration, 'Retour au projet'), 'Voir les traitements');
  expect(JSON.stringify(history)).toContain('Ouvrir');
  const next = await h.click(history, 'Suivant');
  expect(next.text).toContain('Page 2');
  const run = await h.click(next, 'Ouvrir');
  expect(run.text).toContain('Traitement : review:browse-');
  expect(JSON.stringify(run)).toContain('https://app.clickup.com/t/abc123');
  await h.click(run, 'Actualiser');
  expect(h.snapshotCount()).toBe(reads);
  expect((await h.sql.query('SELECT count(*)::int AS count FROM development_runs')).rows[0].count).toBe(10);
  expect(h.comments).toEqual([]); expect(h.statuses).toEqual([]);
});

it('confirms pause/resume separately, preserves configuration and cannot replay an old confirmation', async () => {
  const h = await harness(); await h.configure();
  const page = await h.dm('development status pilot');
  const pause = await h.click(page, 'Suspendre le projet');
  expect(pause.ts).not.toBe(page.ts);
  expect((await h.store.project('pilot'))!.enabled).toBe(true);
  const paused = await h.click(pause, 'Confirmer la suspension');
  expect(await h.store.project('pilot')).toEqual({ ...project, enabled: false });
  const pausedPage = await h.click(paused, 'Retour au projet');
  const resume = await h.click(pausedPage, 'Réactiver le projet');
  await h.click(resume, 'Confirmer la réactivation');
  expect(await h.store.project('pilot')).toEqual(project);
  await h.click(pause, 'Confirmer la suspension');
  expect(await h.store.project('pilot')).toEqual(project);
});

it('opens long legacy run identifiers through bounded controls and offers suspended setup templates', async () => {
  const h = await harness(); await h.configure();
  const setup = await h.click(await h.click(await h.dm('menu'), 'Développement'), 'Configurer un projet');
  expect(setup.text).toContain('"enabled":false');
  await h.store.review(project, h.tasks.get('abc123')!, '1700000000.000001', 'long-id');
  await h.sql.query("UPDATE development_runs SET id=$1,state='blocked'", ['r'.repeat(300)]);
  const detail = await h.click(await h.click(await h.dm('development status pilot'), 'Voir les traitements'), 'Ouvrir');
  expect(detail.text).toContain('r'.repeat(300));
  const confirmation = await h.click(detail, 'Relancer…');
  await h.click(confirmation, 'Confirmer la relance');
  expect(await h.store.history('pilot')).toHaveLength(2);
});

it('recovers uncertain confirmation delivery without repeating a saved effect', async () => {
  const h = await harness(); await h.configure();
  const confirmation = await h.click(await h.dm('development status pilot'), 'Suspendre le projet');
  h.failPost();
  await expect(h.click(confirmation, 'Confirmer la suspension')).rejects.toThrow('Uncertain Slack delivery');
  expect((await h.store.project('pilot'))!.enabled).toBe(false);
  const queued = (await h.sql.query("SELECT id FROM jobs WHERE status='queued' AND payload->>'action'='confirm'")).rows[0];
  const delivered = h.posts.length;
  await h.run(queued.id);
  expect(h.posts).toHaveLength(delivered);
  await h.store.save(project, 'later-reactivation');
  const repeated = await h.click(confirmation, 'Confirmer la suspension');
  expect(repeated.text).toContain('déjà été appliquée');
  expect((await h.store.project('pilot'))!.enabled).toBe(true);
});

it('rejects expired menu controls before preparing a confirmation', async () => {
  const h = await harness(); await h.configure();
  const page = await h.dm('development status pilot');
  await h.sql.query("UPDATE core_navigation_menus SET created_at=now()-interval '31 days'");
  await h.click(page, 'Suspendre le projet');
  expect((await h.sql.query('SELECT * FROM development_confirmations')).rows).toHaveLength(0);
  expect((await h.store.project('pilot'))!.enabled).toBe(true);
});

it('rejects another owner, DM, message, expired confirmation and changed project configuration', async () => {
  const h = await harness(); await h.configure();
  const page = await h.dm('development status pilot');
  const proposal = await h.click(page, 'Suspendre le projet');
  for (const actor of [{ ...alice, user: 'UBOB' }, { ...alice, channel: 'DOTHER' }]) await h.click(proposal, 'Confirmer la suspension', actor);
  await h.click(proposal, 'Confirmer la suspension', alice, '1.000001');
  expect((await h.store.project('pilot'))!.enabled).toBe(true);
  await h.store.save({ ...project, skill: 'changed' }, 'changed-config');
  const stale = await h.click(proposal, 'Confirmer la suspension');
  expect(stale.text).toContain('configuration modifiée');
  expect((await h.store.project('pilot'))!.enabled).toBe(true);
  const fresh = await h.click(await h.dm('development status pilot'), 'Suspendre le projet');
  await h.sql.query("UPDATE development_confirmations SET created_at=now()-interval '25 hours'");
  await h.click(fresh, 'Confirmer la suspension');
  expect((await h.store.project('pilot'))!.enabled).toBe(true);
});

it('cancels and confirms a blocked-run retry once while retaining its frozen requirements', async () => {
  const h = await harness(); await h.configure();
  await h.store.review(project, h.tasks.get('abc123')!, '1700000000.000001', 'blocked');
  await h.sql.query("UPDATE development_runs SET state='blocked',result=$1", [JSON.stringify({ outcome: 'blocked', summary: 'Service indisponible.', tests: [] })]);
  const history = await h.click(await h.dm('development status pilot'), 'Voir les traitements');
  const detail = await h.click(history, 'Ouvrir');
  const cancelled = await h.click(detail, 'Relancer…');
  await h.click(cancelled, 'Annuler');
  await h.click(cancelled, 'Confirmer la relance');
  expect(await h.store.history('pilot')).toHaveLength(1);
  const confirmation = await h.click(detail, 'Relancer…');
  h.tasks.get('abc123')!.description = 'Changed current ticket';
  await h.click(confirmation, 'Confirmer la relance');
  await h.click(confirmation, 'Confirmer la relance');
  const rows = await h.store.history('pilot');
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.id.startsWith('retry:')).ticket.description).toBe('Le menu ne se ferme pas au clic.');
  // Even after the new run finishes, the old confirmation cannot authorize more work.
  await h.sql.query("UPDATE development_runs SET state='completed' WHERE id LIKE 'retry:%'");
  await h.click(confirmation, 'Confirmer la relance');
  expect(await h.store.history('pilot')).toHaveLength(2);
});

it('retries an already-pushed reporting failure through a warning and confirmation using the current ticket', async () => {
  const h = await harness(); await h.configure();
  h.tasks.get('abc123')!.status = 'Ready for AI'; await h.poll();
  await h.sql.query("UPDATE development_runs SET state='reporting_error',result=$1", [JSON.stringify({ outcome: 'pushed', summary: 'Poussé.', tests: ['Tests OK'], commit: 'a'.repeat(40), branch: 'maintenance/old' })]);
  const detail = await h.click(await h.click(await h.dm('development status pilot'), 'Voir les traitements'), 'Ouvrir');
  expect(JSON.stringify(detail)).toContain(`/commit/${'a'.repeat(40)}`);
  const proposal = await h.click(detail, 'Relancer…');
  expect(proposal.text).toContain('maintenance/old');
  h.tasks.get('abc123')!.description = 'New explicit requirements';
  await h.click(proposal, 'Confirmer la relance');
  const rows = await h.store.history('pilot');
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.id.startsWith('retry:')).ticket.description).toBe('New explicit requirements');
  expect(rows.find(row => !row.id.startsWith('retry:')).result.commit).toBe('a'.repeat(40));
});

it('rechecks channel access on old controls and refuses retry after suspension', async () => {
  const h = await harness(); await h.configure();
  await h.store.review(project, h.tasks.get('abc123')!, '1700000000.000001', 'access');
  await h.sql.query("UPDATE development_runs SET state='blocked'");
  const detail = await h.click(await h.click(await h.dm('development status pilot'), 'Voir les traitements'), 'Ouvrir');
  const proposal = await h.click(detail, 'Relancer…');
  await h.store.save({ ...project, enabled: false }, 'pause');
  await h.click(proposal, 'Confirmer la relance');
  expect(await h.store.history('pilot')).toHaveLength(1);
  expect(await h.store.retry('review:access:pilot:abc123', 'disabled', 'pilot')).toBe(false);
  await h.store.save({ ...project, channel: 'COTHER' }, 'access-lost');
  const hidden = await h.click(detail, 'Actualiser');
  expect(hidden.text).toContain('inaccessible');
  expect(hidden.text).not.toContain('Le menu ne se ferme');
});

it('configures through signed DM dispatch and restricts configuration/status to channel members', async () => {
  const h = await harness();
  await h.configure(); expect(await h.store.project('pilot')).toEqual(project);
  expect(h.posts.at(-1).text).toContain('Projet Projet pilote enregistré');
  await h.dm('development projects');
  expect(h.posts.at(-1).text).toContain('pilot — Projet pilote');
  await h.dm(`development configure ${JSON.stringify({ ...project, skill: 'other' })}`, 'UOUTSIDER');
  expect((await h.store.project('pilot'))!.skill).toBe('maintenance');
  await h.dm('development projects', 'UOUTSIDER');
  expect(h.posts.at(-1).text).toContain('Aucun projet accessible');
  expect((await h.ingress('https://app.clickup.com/t/abc123', { team: 'TOTHER' })).response.statusCode).toBe(403);
  expect((await h.api('claim', { worker: randomUUID(), projects: ['pilot'] }, 'wrong')).statusCode).toBe(401);
});

it.each(['conversations.info', 'conversations.members', 'clickup'] as const)('reports %s configuration access failures in the DM without saving a project', async failure => {
  const h = await harness(failure);
  await h.configure();
  expect(await h.store.project('pilot')).toBeUndefined();
  expect(h.posts.at(-1).text).toContain('Configuration non enregistrée');
  expect(h.posts.at(-1).text).toContain(failure === 'clickup' ? 'ClickUp' : 'Slack');
  expect(h.posts.at(-1).channel).toBe('DALICE');
  const jobs = (await h.sql.query("SELECT status FROM jobs WHERE module='development' AND actor->>'user'='UALICE'")).rows;
  expect(jobs).toEqual([{ status: 'done' }]);
});

it.each(['<URL>', '<URL|Orientaction frontend>'])('accepts Slack repository link formatting %s through signed DM dispatch', async format => {
  const h = await harness();
  const repository = 'https://gitlab.com/mayasquad/orient-action/orient-action-frontend';
  const configured = { ...project, repository };
  await h.dm(`development configure ${JSON.stringify({ ...configured, repository: format.replace('URL', repository) })}`);
  expect(await h.store.project('pilot')).toEqual(configured);
  expect(h.posts.at(-1).text).toContain('enregistré');
  await h.dm('development projects');
  expect(h.posts.at(-1).text).toContain('pilot — Projet pilote');
});

it.each(['not-a-url', '<https://example.com', 'https://', '<not-a-url|https://gitlab.com/example/project>', '<http://example.com/project>', '<https://user:password@example.com/project>', '<https://example.com/project?token=secret>', '<https://example.com/project#fragment>'])('rejects invalid repository input without throwing or saving: %s', async repository => {
  expect(projectSchema.safeParse({ ...project, repository }).success).toBe(false);
  const h = await harness();
  await h.dm(`development configure ${JSON.stringify({ ...project, repository })}`);
  expect(await h.store.project('pilot')).toBeUndefined();
  expect(h.posts.at(-1).text).toContain('Configuration invalide');
  expect(h.posts.at(-1).text).not.toContain('user:password');
  expect(h.posts.at(-1).text).not.toContain('token=secret');
  expect((await h.sql.query("SELECT status FROM jobs WHERE module='development' AND actor->>'user'='UALICE'")).rows).toEqual([{ status: 'done' }]);
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
  h.tasks.get('abc123')!.status = 'to do';
  await h.poll();
  h.tasks.get('abc123')!.status = 'Ready for AI';
  h.tasks.get('abc123')!.description = 'Comportement revu après le commit.';
  await h.poll();
  expect(await h.store.history('pilot')).toHaveLength(1);
  await h.dm(`development retry ${work.id}`);
  const runs = await h.store.history('pilot');
  expect(runs).toHaveLength(2);
  expect(runs.find(run => run.id !== work.id).ticket.description).toBe('Comportement revu après le commit.');
  expect((await h.store.run(work.id)).state).toBe('reporting_error');
  expect(h.posts.at(-1).text).toContain('branche configurée localement');
  expect(h.posts.at(-1).text).toContain('b'.repeat(40));
  expect(h.posts.some(post => post.text.includes('a déjà été poussé'))).toBe(true);
  await h.poll();
  expect(await h.store.history('pilot')).toHaveLength(2);
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
