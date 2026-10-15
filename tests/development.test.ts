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
const config = readConfig(env), alice = { team: 'TTEAM', user: 'UALICE', channel: 'CPROJECT' };
const project = projectSchema.parse({ id: 'pilot', name: 'Projet pilote', channel: 'CPROJECT', folder: '123', repository: 'https://github.com/example/project', skill: 'maintenance' });
let db: PGlite;
const apps: Array<{ close(): Promise<void> }> = [];
beforeAll(async () => { db = new PGlite(); await db.exec(coreSchema); });
beforeEach(async () => { await db.exec('TRUNCATE jobs,ai_calls,ai_months,core_navigation_menus,core_navigation_deliveries,core_operation_slots CASCADE; DROP TABLE IF EXISTS development_projects,development_threads,development_ticket_state,development_runs,development_effects,development_receipts,development_health,development_confirmations,development_configuration_forms,development_ticket_routes,development_route_proposals,development_route_runs CASCADE'); });
afterAll(async () => { for (const app of apps) await app.close(); await db.close(); });

async function harness(failure?: 'conversations.info' | 'conversations.members' | 'clickup') {
  const sql: Database = { query: (text, values) => db.query(text, values), transaction: work => db.transaction(tx => work({ query: (text, values) => tx.query(text, values) })) };
  const tasks = new Map<string, Ticket>([['abc123', { id: 'abc123', name: 'Réparer le menu', description: 'Le menu ne se ferme pas au clic.', url: 'https://app.clickup.com/t/abc123', status: 'open', comments: [], attachments: [] }]]);
  const comments: string[] = [], statuses: string[] = [], posts: any[] = [], views: any[] = [];
  let counter = 0, snapshots = 0, rejectStatus = false, rejectPost = false;
  let rejectView = false, accessFailure = failure;
  const requests: string[] = [];
  const folders = [{ id: '123', name: 'Maintenance', archived: false }, { id: '456', name: 'Autre dossier', archived: false }];
  const accessibleChannels = new Set(['CPROJECT']);
  const taskLists = new Map<string, string>();
  const unavailableFolders = new Set<string>();
  const fetcher = (async (url: URL | string, init?: RequestInit) => {
    const target = new URL(String(url)), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push(target.pathname);
    if (target.pathname === '/api/views.open') {
      views.push(body.view);
      if (rejectView) { rejectView = false; throw new Error('Lost modal response'); }
      return Response.json({ ok: true, view: { id: `V${views.length}` } });
    }
    if (target.hostname === 'api.clickup.com') {
      if (accessFailure === 'clickup') return Response.json({}, { status: 403 });
      if (target.pathname.endsWith('/team')) return Response.json({ teams: [{ id: '1', name: 'Maya' }] });
      if (target.pathname.endsWith('/team/1/space')) return Response.json({ spaces: [{ id: '2', name: 'Projets' }] });
      if (target.pathname.endsWith('/space/2/folder')) return Response.json({ folders });
      if ([...unavailableFolders].some(id => target.pathname.endsWith(`/folder/${id}/list`))) return Response.json({}, { status: 403 });
      if (target.pathname.endsWith('/folder/123/list')) return Response.json({ lists: [{ id: 'list1' }] });
      if (target.pathname.endsWith('/folder/456/list')) return Response.json({ lists: [{ id: 'list2' }] });
      if (/\/list\/list[12]\/task$/.test(target.pathname)) return Response.json({ tasks: [...tasks.values()].filter(task => target.pathname.endsWith(`/list/${taskLists.get(task.id) ?? 'list1'}/task`)).map(task => ({ id: task.id, status: { status: task.status } })), last_page: true });
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
      return Response.json({ id: task.id, name: task.name, description: task.description, status: { status: task.status }, list: { id: taskLists.get(task.id) ?? 'list1' } });
    }
    if (target.pathname.startsWith('/api/conversations.')) {
      // Match the production rejection: JSON POST arguments were not accepted.
      if (init?.method !== 'GET' || init.body || !target.searchParams.has('channel')) return Response.json({ ok: false, error: 'invalid_arguments' });
      if (target.pathname === `/api/${accessFailure}`) return Response.json({ ok: false, error: 'missing_scope' });
      const channel = target.searchParams.get('channel');
      if (target.pathname.endsWith('/conversations.info')) return Response.json({ ok: true, channel: { id: channel, is_member: accessibleChannels.has(channel!) } });
      if (target.pathname.endsWith('/conversations.members')) {
        expect(target.searchParams.get('limit')).toBe('200');
        return Response.json(target.searchParams.get('cursor') === 'next+page'
          ? { ok: true, members: ['UALICE'], response_metadata: { next_cursor: '' } }
          : { ok: true, members: ['UBOB'], response_metadata: { next_cursor: 'next+page' } });
      }
    }
    if (target.pathname.endsWith('/chat.postMessage') || target.pathname.endsWith('/chat.update')) {
      const ts = body.ts ?? `1700000000.${String(++counter).padStart(6, '0')}`;
      const previous = posts.find(p => p.ts === ts && p.channel === body.channel);
      posts.push({ ...body, ts, ...(previous?.thread_ts && !body.thread_ts ? { thread_ts: previous.thread_ts } : {}) });
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
    return { id: options.channel?.startsWith('D') || /^development(?:\s|$)/.test(text) ? `slack:${id}` : `development:slack:${id}`, response };
  };
  const command = async (text: string, user = 'UALICE') => { const request = await ingress(text === 'menu' ? 'development menu' : text, { channel: 'CPROJECT', user }); await run(request.id); return posts.at(-1); };
  const dm = async (text: string, user = 'UALICE') => { const request = await ingress(text, { channel: 'DPRIVATE', user }); await run(request.id); return posts.at(-1); };
  const click = async (source: any, label: string, actor = alice, timestamp = source.ts, clickId = randomUUID(), expectedStatus = 200) => {
    const controls: any[] = [];
    const walk = (value: any) => { if (!value || typeof value !== 'object') return; if (value.action_id) controls.push(value); for (const child of Object.values(value)) if (typeof child === 'object') walk(child); };
    walk(source.blocks);
    const control = controls.find(button => button.text?.text.replace(/^🧭 /, '') === label);
    expect(control, `Missing ${label}: ${controls.map(button => button.text?.text).join(', ')}`).toBeTruthy();
    const stamp = String(Math.floor(Date.now() / 1000));
    const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: actor.team }, user: { id: actor.user }, channel: { id: actor.channel }, message: { ts: timestamp, ...(source.thread_ts ? { thread_ts: source.thread_ts } : {}) }, trigger_id: 'synthetic-trigger', actions: [{ action_id: control.action_id, value: control.value, action_ts: clickId }] }) }).toString();
    const response = await app.inject({ method: 'POST', url: '/slack/actions', payload: raw, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': stamp, 'x-slack-signature': `v0=${createHmac('sha256', 'secret').update(`v0:${stamp}:${raw}`).digest('hex')}` } });
    expect(response.statusCode).toBe(expectedStatus);
    if ((await sql.query('SELECT id FROM jobs WHERE id=$1', [`action:${digest(raw)}`])).rows.length) await run(`action:${digest(raw)}`);
    return posts.at(-1);
  };
  const submit = async (view: any, values: Record<string, unknown>, actor = alice, signed = true) => {
    const state = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value: key === 'channel' ? { type: 'conversations_select', selected_conversation: value } : key === 'folder' ? { type: 'multi_external_select', selected_options: (Array.isArray(value) ? value : value ? [value] : []).map(value => ({ value })) } : key === 'enabled' ? { type: 'checkboxes', selected_options: value ? [{ value: 'enabled' }] : [] } : { type: 'plain_text_input', value } }]));
    const stamp = String(Math.floor(Date.now() / 1000));
    const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'view_submission', team: { id: actor.team }, user: { id: actor.user }, view: { id: 'V1', callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values: state } } }) }).toString();
    return app.inject({ method: 'POST', url: '/slack/actions', payload: raw, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': stamp, 'x-slack-signature': signed ? `v0=${createHmac('sha256', 'secret').update(`v0:${stamp}:${raw}`).digest('hex')}` : 'invalid' } });
  };
  const suggest = async (view: any, value = '', actor = alice, overrides: Record<string, unknown> = {}, signed = true) => {
    const stamp = String(Math.floor(Date.now() / 1000));
    const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_suggestion', team: { id: actor.team }, user: { id: actor.user }, view, block_id: 'folder', action_id: 'value', value, ...overrides }) }).toString();
    return app.inject({ method: 'POST', url: '/slack/actions', payload: raw, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': stamp, 'x-slack-signature': signed ? `v0=${createHmac('sha256', 'secret').update(`v0:${stamp}:${raw}`).digest('hex')}` : 'invalid' } });
  };
  const api = async (route: string, body: unknown, bearer = token) => app.inject({ method: 'POST', url: `/development/worker/${route}`, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` } });
  return { sql, store, tasks, comments, statuses, posts, views, requests, submit, suggest, folders, run, command, dm, click, ingress, api, module, modules, app, accessibleChannels, taskLists, unavailableFolders,
    poll: () => run('development:poll:TTEAM'), configure: () => command(`development configure ${JSON.stringify(project)}`),
    snapshotCount: () => snapshots, failStatus: () => { rejectStatus = true; }, failPost: () => { rejectPost = true; }, failView: () => { rejectView = true; }, accessFailure: (value: typeof failure) => { accessFailure = value; } };
}

async function newForm(h: Awaited<ReturnType<typeof harness>>) {
  const prepared = await h.click(await h.command('menu'), 'Configurer un projet');
  await h.click(prepared, 'Remplir le formulaire');
  return { prepared, view: h.views.at(-1) };
}

async function sharedProjects(h: Awaited<ReturnType<typeof harness>>) {
  await h.configure();
  await h.store.save({ ...project, id: 'backend', name: 'Backend', repository: 'https://github.com/example/backend' }, 'backend');
}
async function chooseRepositories(h: Awaited<ReturnType<typeof harness>>, names = ['Projet pilote', 'Backend']) {
  const menu = await h.command('menu');
  const list = await h.click(menu, 'Tickets et dépôts');
  const detail = await h.click(list, 'À affecter');
  let picker = await h.click(detail, 'Choisir les dépôts');
  for (const name of names) picker = await h.click(picker, `Ajouter ${name}`);
  return h.click(picker, 'Vérifier les dépôts');
}
async function finishRepository(h: Awaited<ReturnType<typeof harness>>, projectId: string, outcome = 'pushed') {
  const work = (await h.api('claim', { worker: randomUUID(), projects: [projectId] })).json().work;
  expect(work).toBeTruthy();
  await h.api('attempt', { id: work.id, lease: work.lease, expected: 0 });
  expect((await h.api('result', { id: work.id, lease: work.lease, result: { outcome, summary: `${projectId} terminé`, tests: ['Checks passed'], ...(outcome === 'pushed' ? { commit: (projectId === 'backend' ? 'b' : 'a').repeat(40) } : {}) } })).statusCode).toBe(200);
  await h.run(`development:finish:${work.id}`);
  return work;
}

const backendRepository = 'https://github.com/example/backend';
const groupedProject = () => projectSchema.parse({ ...project, folders: ['123', '456'], repositories: [project.repository, backendRepository] });

async function assignment(h: Awaited<ReturnType<typeof harness>>, actor = alice) {
  const menu = actor.channel.startsWith('D') ? await h.dm('development menu') : await h.command('menu');
  return h.click(await h.click(menu, 'Tickets et dépôts', actor), 'Affecté — gérer', actor);
}

it('changes repository selection with confirmation, preserves retained analyses and cancels removed queued work', async () => {
  const h = await harness(); await sharedProjects(h);
  const request = await h.ingress('https://app.clickup.com/t/abc123'); await h.run(request.id);
  await h.click(await chooseRepositories(h, ['Projet pilote']), 'Confirmer les dépôts');
  const original = (await h.store.history('pilot'))[0];
  const page = await assignment(h);
  const ticketRuns = await h.click(page, 'Traitements du ticket');
  expect(ticketRuns.ts).toBe(page.ts);
  const treatment = await h.click(ticketRuns, 'En attente du worker');
  expect(treatment.ts).toBe(page.ts);
  expect(JSON.stringify(treatment.blocks)).toContain('Annuler ce traitement');
  const ticket = await h.click(await h.click(treatment, 'Traitements du ticket'), 'Retour au ticket');
  expect(ticket.ts).toBe(page.ts);
  expect(ticket.text).toContain('Dépôts confirmés');
  expect(await h.store.history('pilot')).toHaveLength(1);
  let picker = await h.click(page, 'Modifier les dépôts');
  picker = await h.click(picker, 'Ajouter Backend');
  const confirmation = await h.click(picker, 'Vérifier les dépôts');
  expect(await h.store.history('backend')).toHaveLength(0);
  await h.click(confirmation, 'Confirmer les dépôts');
  expect(await h.store.history('pilot')).toHaveLength(1);
  expect((await h.store.history('pilot'))[0].id).toBe(original.id);
  expect(await h.store.history('backend')).toHaveLength(1);
  picker = await h.click(await assignment(h), 'Modifier les dépôts');
  picker = await h.click(picker, 'Retirer Projet pilote');
  const removal = await h.click(picker, 'Vérifier les dépôts');
  await h.click(removal, 'Confirmer les dépôts');
  await h.click(removal, 'Confirmer les dépôts');
  expect((await h.store.run(original.id))!.state).toBe('cancelled');
  expect(await h.store.history('backend')).toHaveLength(1);
  expect((await h.api('claim', { worker: randomUUID(), projects: ['pilot'] })).json().work).toBeNull();
  expect(await h.store.retry(original.id, 'removed-retry', 'pilot')).toBe(false);
  const removed = await h.click(await h.click(await h.command('development status pilot'), 'Voir les traitements'), 'Annulé');
  expect(JSON.stringify(removed.blocks)).not.toContain('propose_retry');
  expect((await h.click(removed, 'Dépôts du ticket')).text).toContain('Dépôts confirmés');
  expect(h.statuses).toEqual([]);
});

it('rejects stale repository changes and claims that start before selection confirmation', async () => {
  const h = await harness(); await sharedProjects(h);
  const request = await h.ingress('https://app.clickup.com/t/abc123'); await h.run(request.id);
  await h.click(await chooseRepositories(h, ['Projet pilote']), 'Confirmer les dépôts');
  const page = await assignment(h);
  let first = await h.click(page, 'Modifier les dépôts');
  first = await h.click(first, 'Ajouter Backend');
  const stale = await h.click(first, 'Vérifier les dépôts');
  let second = await h.click(page, 'Modifier les dépôts');
  second = await h.click(second, 'Ajouter Backend');
  await h.click(await h.click(second, 'Vérifier les dépôts'), 'Confirmer les dépôts');
  expect((await h.click(stale, 'Confirmer les dépôts')).text).toContain('a changé');
  let picker = await h.click(await assignment(h), 'Modifier les dépôts');
  picker = await h.click(picker, 'Retirer Projet pilote');
  const confirmation = await h.click(picker, 'Vérifier les dépôts');
  const work = (await h.api('claim', { worker: randomUUID(), projects: ['pilot'] })).json().work;
  expect(work).toBeTruthy();
  expect((await h.click(confirmation, 'Confirmer les dépôts')).text).toContain('a démarré');
  expect((await h.store.run(work.id))!.state).toBe('running');
  expect((await h.sql.query('SELECT jsonb_array_length(selected) AS count FROM development_ticket_routes')).rows[0].count).toBe(2);
});

it('treats unchanged repository confirmation as a no-op and supports editing privately', async () => {
  const h = await harness(), actor = { ...alice, channel: 'DPRIVATE' }; await sharedProjects(h);
  const request = await h.ingress('https://app.clickup.com/t/abc123'); await h.run(request.id);
  await h.click(await chooseRepositories(h), 'Confirmer les dépôts');
  const picker = await h.click(await assignment(h, actor), 'Modifier les dépôts', actor);
  const confirmation = await h.click(picker, 'Vérifier les dépôts', actor);
  expect((await h.click(confirmation, 'Confirmer les dépôts', actor)).text).toContain('inchangés');
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(2);
});

it('cancels only a queued correction, preserves its batch and permits an explicit frozen retry', async () => {
  const h = await harness(); await sharedProjects(h); h.tasks.get('abc123')!.status = 'Ready for AI';
  await h.poll(); await h.click(await chooseRepositories(h), 'Confirmer les dépôts'); await h.poll();
  const detail = await h.click(await h.click(await h.command('development status pilot'), 'Voir les traitements'), 'En attente du worker');
  const proposal = await h.click(detail, 'Annuler ce traitement…');
  expect((await h.store.history('pilot'))[0].state).toBe('queued');
  await h.click(proposal, 'Confirmer l’annulation du traitement', { ...alice, user: 'UBOB' });
  expect((await h.store.history('pilot'))[0].state).toBe('queued');
  await h.click(proposal, 'Confirmer l’annulation du traitement');
  await h.click(proposal, 'Confirmer l’annulation du traitement');
  await h.poll();
  expect((await h.store.history('pilot')).map(r => r.state)).toEqual(['cancelled']);
  await finishRepository(h, 'backend');
  expect(h.statuses).toEqual([]);
  const cancelled = await h.click(await h.click(await h.command('development status pilot'), 'Voir les traitements'), 'Annulé');
  const retry = await h.click(cancelled, 'Relancer…');
  h.tasks.get('abc123')!.description = 'Changed after cancellation';
  await h.click(retry, 'Confirmer la relance');
  await h.click(proposal, 'Confirmer l’annulation du traitement');
  const work = await finishRepository(h, 'pilot');
  expect(work.ticket.description).toBe('Le menu ne se ferme pas au clic.');
  expect(h.statuses).toEqual(['to build']);
});

it('refuses cancellation after a worker claim and allows cancelling queued work in a suspended project from a DM', async () => {
  const h = await harness(), actor = { ...alice, channel: 'DPRIVATE' }; await h.configure();
  const request = await h.ingress('https://app.clickup.com/t/abc123'); await h.run(request.id);
  const detail = await h.click(await h.click(await h.dm('development status pilot'), 'Voir les traitements', actor), 'En attente du worker', actor);
  const proposal = await h.click(detail, 'Annuler ce traitement…', actor);
  const work = (await h.api('claim', { worker: randomUUID(), projects: ['pilot'] })).json().work;
  expect((await h.click(proposal, 'Confirmer l’annulation du traitement', actor)).text).toContain('indisponible');
  expect((await h.store.run(work.id))!.state).toBe('running');
  await h.store.review(project, h.tasks.get('abc123')!, '1700000000.000001', 'second');
  await h.store.save({ ...project, enabled: false }, 'pause');
  const queued = await h.click(await h.click(await h.dm('development status pilot'), 'Voir les traitements', actor), 'En attente du worker', actor);
  await h.click(await h.click(queued, 'Annuler ce traitement…', actor), 'Confirmer l’annulation du traitement', actor);
  expect((await h.store.history('pilot')).map(r => r.state).sort()).toEqual(['cancelled', 'running']);
  expect(h.posts.at(-1).channel).toBe('DPRIVATE');
});

it('changes repositories within one grouped project after all queued corrections are cancelled', async () => {
  const h = await harness(); await h.store.save(groupedProject(), 'grouped');
  h.tasks.get('abc123')!.status = 'Ready for AI'; await h.poll();
  await h.click(await chooseRepositories(h, ['1. project — Projet pilote', '2. backend — Projet pilote']), 'Confirmer les dépôts');
  await h.poll();
  const names = (await h.sql.query('SELECT * FROM development_runs')).rows;
  expect(names).toHaveLength(2);
  expect(JSON.stringify(await assignment(h))).not.toContain('Modifier les dépôts');
  for (let index = 0; index < 2; index++) {
    const detail = await h.click(await h.click(await h.command('development status pilot'), 'Voir les traitements'), 'En attente du worker');
    await h.click(await h.click(detail, 'Annuler ce traitement…'), 'Confirmer l’annulation du traitement');
  }
  await h.poll();
  expect((await h.sql.query("SELECT * FROM development_runs WHERE state='queued'")).rows).toHaveLength(0);
  let picker = await h.click(await assignment(h), 'Modifier les dépôts');
  picker = await h.click(picker, 'Retirer 1. project — Projet pilote');
  await h.click(await h.click(picker, 'Vérifier les dépôts'), 'Confirmer les dépôts');
  await h.poll(); await h.poll();
  const queued = (await h.sql.query("SELECT * FROM development_runs WHERE state='queued'")).rows;
  expect(queued).toHaveLength(1);
  expect(queued[0].config.repository).toBe(backendRepository);
  expect(names.every(run => run.ticket.description === queued[0].ticket.description)).toBe(true);
});

it('rejects expired and cross-user repository edits and preserves the current selection', async () => {
  const h = await harness(); await sharedProjects(h);
  const request = await h.ingress('https://app.clickup.com/t/abc123'); await h.run(request.id);
  await h.click(await chooseRepositories(h), 'Confirmer les dépôts');
  let picker = await h.click(await assignment(h), 'Modifier les dépôts');
  picker = await h.click(picker, 'Retirer Backend');
  const confirmation = await h.click(picker, 'Vérifier les dépôts');
  await h.click(confirmation, 'Confirmer les dépôts', { ...alice, user: 'UBOB' });
  await h.sql.query("UPDATE development_route_proposals SET created_at=now()-interval '25 hours'");
  await h.click(confirmation, 'Confirmer les dépôts');
  expect((await h.sql.query('SELECT jsonb_array_length(selected) AS count FROM development_ticket_routes')).rows[0].count).toBe(2);
  expect((await h.sql.query("SELECT * FROM development_runs WHERE state='cancelled'")).rows).toHaveLength(0);
});

it('saves and edits one project with multiple named folders and repositories through signed Slack forms', async () => {
  const h = await harness(); const { view } = await newForm(h);
  const values = { ...project, id: 'EOA-maintenance-backend', folder: ['123', '456'], repository: `${project.repository}\n${backendRepository}` };
  expect((await h.submit(view, values)).json()).toEqual({});
  await h.run(`development:configuration:${view.private_metadata}`);
  expect(h.posts.at(-1).text).toContain('Autre dossier (456)');
  expect(h.posts.at(-1).text).toContain(backendRepository);
  expect(await h.store.projects()).toEqual([]);
  const saved = await h.click(h.posts.at(-1), 'Enregistrer la configuration');
  const [group] = await h.store.projects();
  expect(group).toEqual({ ...groupedProject(), id: 'eoa-maintenance-backend' });
  const detail = await h.click(saved, 'Ouvrir le projet');
  expect(detail.text).toContain('123, 456');
  await h.click(await h.click(detail, 'Modifier la configuration'), 'Remplir le formulaire');
  const edited = h.views.at(-1);
  expect(edited.blocks.find((b: any) => b.block_id === 'folder').element.initial_options.map((o: any) => o.value)).toEqual(['456', '123']);
  expect(edited.blocks.find((b: any) => b.block_id === 'repository').element.initial_value).toBe(values.repository);
  const another = await newForm(h);
  expect((await h.submit(another.view, values)).json().errors.id).toBeTruthy();
});

it('rejects duplicate, invalid and unoffered collection entries and rechecks every folder before saving', async () => {
  const h = await harness(); const { view } = await newForm(h);
  for (const repository of [`${project.repository}\n${project.repository}.git`, `${project.repository}\nnot-a-url`, `${project.repository}\nhttps://user:password@example.com/repo`]) {
    expect((await h.submit(view, { ...project, repository })).json().errors.repository).toBeTruthy();
  }
  for (const folder of [['123', '123'], ['123', '999']]) expect((await h.submit(view, { ...project, folder })).json().errors.folder).toBeTruthy();
  await h.submit(view, { ...project, folder: ['123', '456'] });
  await h.run(`development:configuration:${view.private_metadata}`);
  const confirm = h.posts.at(-1); h.unavailableFolders.add('456');
  await h.click(confirm, 'Enregistrer la configuration');
  expect(h.posts.at(-1).text).toContain('inaccessible');
  expect(await h.store.projects()).toEqual([]);
});

it.each(['123', '456'])('routes a ticket in folder %s to both repositories of one project and completes only after both pushes', async folder => {
  const h = await harness(); await h.command(`development configure ${JSON.stringify(groupedProject())}`);
  if (folder === '456') h.taskLists.set('abc123', 'list2');
  h.tasks.get('abc123')!.status = 'Ready for AI';
  const request = await h.ingress('https://app.clickup.com/t/abc123'); await h.run(request.id);
  await h.poll();
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(0);
  const confirmation = await chooseRepositories(h, ['1. project — Projet pilote', '2. backend — Projet pilote']);
  await h.click(confirmation, 'Confirmer les dépôts'); await h.click(confirmation, 'Confirmer les dépôts');
  await h.poll(); await h.poll();
  const runs = (await h.sql.query('SELECT * FROM development_runs')).rows;
  expect(runs).toHaveLength(2);
  expect(runs.every(r => r.project === 'pilot' && r.config.folder === folder)).toBe(true);
  expect(runs[0]!.ticket).toEqual(runs[1]!.ticket);
  expect((await h.api('claim', { worker: randomUUID(), projects: ['pilot'] })).json().work).toBeNull();
  for (const repository of [project.repository, backendRepository]) {
    const work = (await h.api('claim', { worker: randomUUID(), projects: ['pilot'], targets: [{ id: 'pilot', repository, skill: 'maintenance' }] })).json().work;
    expect(work.project.repository).toBe(repository);
    await h.api('attempt', { id: work.id, lease: work.lease, expected: 0 });
    expect((await h.api('result', { id: work.id, lease: work.lease, result: { outcome: 'pushed', summary: 'Terminé', tests: ['Build passed'], commit: 'a'.repeat(40) } })).statusCode).toBe(200);
    await h.run(`development:finish:${work.id}`);
    expect(h.statuses).toHaveLength(repository === project.repository ? 0 : 1);
  }
  expect(h.statuses).toEqual(['to build']);
  expect(h.posts.filter(p => p.text.includes('Commit poussé')).every(p => p.channel === 'CPROJECT')).toBe(true);
  expect(await h.store.projects()).toHaveLength(1);
});

it('discovers unlinked Ready tickets in every folder and allows selecting only one repository', async () => {
  const h = await harness(); await h.store.save(groupedProject(), 'group');
  h.taskLists.set('abc123', 'list2'); h.tasks.get('abc123')!.status = 'Ready for AI';
  await h.poll();
  await h.click(await chooseRepositories(h, ['2. backend — Projet pilote']), 'Confirmer les dépôts');
  await h.poll();
  expect((await h.sql.query('SELECT config FROM development_runs')).rows.map(r => r.config.repository)).toEqual([backendRepository]);
  expect((await h.api('claim', { worker: randomUUID(), projects: ['pilot'], targets: [{ id: 'pilot', repository: project.repository, skill: 'maintenance' }] })).json().work).toBeNull();
  const target = { id: 'pilot', repository: backendRepository, skill: 'maintenance' };
  const worker = randomUUID();
  const first = (await h.api('claim', { worker, projects: ['pilot'], targets: [target] })).json().work;
  expect(first.project.repository).toBe(backendRepository);
  expect((await h.api('claim', { worker, projects: ['pilot'], targets: [target] })).json().work).toEqual(first);
});

it('holds queued grouped destinations removed from configuration without redirecting them', async () => {
  const h = await harness(); await h.store.save(groupedProject(), 'group');
  const request = await h.ingress('https://app.clickup.com/t/abc123'); await h.run(request.id);
  await h.click(await chooseRepositories(h, ['2. backend — Projet pilote']), 'Confirmer les dépôts');
  await h.store.save(project, 'remove-backend');
  expect((await h.api('claim', { worker: randomUUID(), projects: ['pilot'], targets: [{ id: 'pilot', repository: backendRepository, skill: 'maintenance' }] })).json().work).toBeNull();
  expect((await h.sql.query('SELECT state FROM development_runs')).rows[0]!.state).toBe('queued');
});

it('retains a folder failure in project health when another configured folder succeeds', async () => {
  const h = await harness(); await h.store.save(groupedProject(), 'group'); h.unavailableFolders.add('123');
  await h.poll();
  expect((await h.sql.query('SELECT issue FROM development_health')).rows[0]!.issue).toContain('indisponible');
  h.unavailableFolders.clear(); await h.poll();
  expect((await h.sql.query('SELECT issue FROM development_health')).rows[0]!.issue).toBeNull();
});

it('distinguishes three repositories with identical names even when Slack truncates long labels', async () => {
  const h = await harness(), name = 'Long project '.repeat(7);
  const repositories = ['one', 'two', 'three'].map(org => `https://github.com/${org}/api`);
  await h.command(`development configure ${JSON.stringify({ ...project, name, repositories })}`);
  const request = await h.ingress('https://app.clickup.com/t/abc123'); await h.run(request.id);
  const detail = await h.click(h.posts.at(-1), 'Choisir les dépôts');
  let picker = await h.click(detail, 'Choisir les dépôts');
  for (const index of [1, 3]) picker = await h.click(picker, `Ajouter ${index}. api — ${name}`.slice(0, 75));
  const confirm = await h.click(picker, 'Vérifier les dépôts');
  await h.click(confirm, 'Confirmer les dépôts');
  expect((await h.sql.query('SELECT config FROM development_runs ORDER BY config->>\'repository\'')).rows.map(r => r.config.repository)).toEqual([repositories[0], repositories[2]].sort());
});

it('retries only a blocked repository while its sibling is queued in the same project', async () => {
  const h = await harness(); await h.store.save(groupedProject(), 'group');
  h.tasks.get('abc123')!.status = 'Ready for AI'; await h.poll();
  await h.click(await chooseRepositories(h, ['1. project — Projet pilote', '2. backend — Projet pilote']), 'Confirmer les dépôts');
  await h.poll();
  const targets = [{ id: 'pilot', repository: backendRepository, skill: 'maintenance' }];
  const work = (await h.api('claim', { worker: randomUUID(), projects: ['pilot'], targets })).json().work;
  await h.api('attempt', { id: work.id, lease: work.lease, expected: 0 });
  await h.api('result', { id: work.id, lease: work.lease, result: { outcome: 'blocked', summary: 'Build failed', tests: [] } });
  await h.run(`development:finish:${work.id}`);
  await h.command(`development retry ${work.id}`);
  const runs = (await h.sql.query("SELECT * FROM development_runs WHERE state='queued'")).rows;
  expect(runs).toHaveLength(2);
  expect(runs.map(r => r.config.repository).sort()).toEqual([project.repository, backendRepository].sort());
  const retried = (await h.api('claim', { worker: randomUUID(), projects: ['pilot'], targets })).json().work;
  expect(retried.id).not.toBe(work.id); expect(retried.ticket).toEqual(work.ticket);
  expect((await h.sql.query('SELECT run FROM development_route_runs WHERE run=$1', [retried.id])).rows).toHaveLength(1);
});

it.each(['pause', 'remove-folder'])('holds grouped queued runs after %s', async change => {
  const h = await harness(); await h.store.save(groupedProject(), 'group');
  h.taskLists.set('abc123', 'list2'); h.tasks.get('abc123')!.status = 'Ready for AI'; await h.poll();
  await h.click(await chooseRepositories(h, ['2. backend — Projet pilote']), 'Confirmer les dépôts'); await h.poll();
  if (change === 'pause') {
    const detail = await h.command('development status pilot');
    await h.click(await h.click(detail, 'Suspendre le projet'), 'Confirmer la suspension');
  } else await h.store.save({ ...groupedProject(), folders: ['123'] }, 'removed');
  expect((await h.api('claim', { worker: randomUUID(), projects: ['pilot'], targets: [{ id: 'pilot', repository: backendRepository, skill: 'maintenance' }] })).json().work).toBeNull();
});

it('returns to the Development channel menu on the clicked message without replacing another screen', async () => {
  const h = await harness();
  const first = await h.command('development menu');
  const second = await h.command('development menu');
  const list = await h.click(first, 'Projets et traitements');
  expect(list.ts).toBe(first.ts);
  const home = await h.click(list, 'Retour au menu');
  expect(home.ts).toBe(first.ts);
  expect(home.thread_ts).toBe(first.thread_ts);
  expect(home.text).toContain('Suivez vos projets');
  expect(new Set(h.posts.map(post => post.ts))).toEqual(new Set([first.ts, second.ts]));
  // Another member may open personal controls, but cannot overwrite this screen.
  const personal = await h.click(home, 'Retour au menu', { ...alice, user: 'UBOB' });
  expect(personal.ts).not.toBe(first.ts);
  expect(personal.ts).not.toBe(second.ts);
});

it('creates a project through channel controls and returns modal validation to the initiating thread', async () => {
  const h = await harness();
  const request = await h.ingress('development menu', { thread: '1700000000.123456' });
  await h.run(request.id);
  const prepared = await h.click(h.posts.at(-1), 'Configurer un projet');
  await h.click(prepared, 'Remplir le formulaire');
  const view = h.views.at(-1);
  expect((await h.submit(view, { ...project, channel: 'COTHER' })).statusCode).toBe(200);
  await h.run(`development:configuration:${view.private_metadata}`);
  expect(await h.store.project('pilot')).toBeUndefined();
  expect(h.posts.at(-1).ts).toBe(prepared.ts);
  await h.click(h.posts.at(-1), 'Enregistrer la configuration');
  expect(h.posts.at(-1).ts).toBe(prepared.ts);
  expect(await h.store.project('pilot')).toEqual(project);
  expect(h.posts.every(post => post.channel === 'CPROJECT' && post.thread_ts === '1700000000.123456')).toBe(true);
  expect(JSON.stringify(h.posts)).not.toContain('core:navigate');
});

it('lets another channel member open their own ticket picker but only its owner confirm both repositories', async () => {
  const h = await harness(); await sharedProjects(h);
  const request = await h.ingress('https://app.clickup.com/t/abc123'); await h.run(request.id);
  const bob = { ...alice, user: 'UBOB' };
  const detail = await h.click(h.posts.at(-1), 'Choisir les dépôts', bob);
  let picker = await h.click(detail, 'Choisir les dépôts', bob);
  for (const name of ['Projet pilote', 'Backend']) picker = await h.click(picker, `Ajouter ${name}`, bob);
  const confirm = await h.click(picker, 'Vérifier les dépôts', bob);
  await h.click(confirm, 'Confirmer les dépôts');
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(0);
  await h.click(confirm, 'Confirmer les dépôts', bob);
  expect((await h.sql.query('SELECT project FROM development_runs ORDER BY project')).rows.map(row => row.project)).toEqual(['backend', 'pilot']);
  expect(h.posts.every(post => post.channel === 'CPROJECT' && post.thread_ts === '1700000000.000001')).toBe(true);
});

it('creates a project from the private main menu with Slack and ClickUp selectors and a private confirmation', async () => {
  const h = await harness(), actor = { ...alice, channel: 'DPRIVATE' };
  const main = await h.click(await h.dm('menu'), 'Développement', actor);
  const prepared = await h.click(main, 'Configurer un projet', actor);
  await h.click(prepared, 'Remplir le formulaire', actor);
  const view = h.views.at(-1);
  expect(view.blocks.find((block: any) => block.block_id === 'channel').element.type).toBe('conversations_select');
  expect((await h.suggest(view, 'Maintenance', actor)).json().options[0].value).toBe('123');
  expect((await h.submit(view, project, actor)).statusCode).toBe(200);
  await h.run(`development:configuration:${view.private_metadata}`);
  const confirm = h.posts.at(-1);
  expect(await h.store.project('pilot')).toBeUndefined();
  await h.click(confirm, 'Enregistrer la configuration', { ...actor, user: 'UBOB' });
  await h.click(confirm, 'Enregistrer la configuration', alice);
  expect(await h.store.project('pilot')).toBeUndefined();
  const saved = await h.click(confirm, 'Enregistrer la configuration', actor);
  expect(await h.store.project('pilot')).toEqual(project);
  const detail = await h.click(saved, 'Ouvrir le projet', actor);
  expect(detail.text).toContain('Identifiant : pilot');
  expect(saved.channel).toBe('DPRIVATE');
  expect(h.posts.filter(post => post.channel === 'CPROJECT').every(post => !post.text.includes(project.repository))).toBe(true);
  expect(h.posts.filter(post => post.channel === 'DPRIVATE').every(post => !post.thread_ts)).toBe(true);
});

it('lists accessible projects across channels privately while hiding projects from non-members', async () => {
  const h = await harness(); await h.configure(); h.accessibleChannels.add('GOTHER');
  await h.store.save({ ...project, id: 'other', name: 'Other project', channel: 'GOTHER' }, 'other');
  const list = await h.dm('development projects');
  expect(list.text).toContain('Projet pilote'); expect(list.text).toContain('Other project');
  expect((await h.dm('development status pilot')).text).toContain(project.skill);
  expect((await h.dm('development projects', 'UOUTSIDER')).text).toContain('Aucun projet accessible');
  expect((await h.dm('development status pilot', 'UOUTSIDER')).text).not.toContain(project.repository);
  await h.dm(`development configure ${JSON.stringify({ ...project, name: 'Forbidden' })}`, 'UOUTSIDER');
  expect(await h.store.project('pilot')).toEqual(project);
  expect((await h.dm('development help')).text).toContain('maintenance');
});

it('validates the selected channel for private forms and rechecks access before saving', async () => {
  const h = await harness(), actor = { ...alice, channel: 'DPRIVATE' };
  const prepared = await h.click(await h.dm('development menu'), 'Configurer un projet', actor);
  await h.click(prepared, 'Remplir le formulaire', actor); const view = h.views.at(-1);
  expect((await h.submit(view, { ...project, channel: 'DOTHER' }, actor)).json().errors.channel).toBeTruthy();
  await h.submit(view, { ...project, channel: 'COTHER' }, actor);
  await h.run(`development:configuration:${view.private_metadata}`);
  expect(h.posts.at(-1).text).toContain('Vérifiez les accès Slack');
  expect(await h.store.project('pilot')).toBeUndefined();
  const corrected = await h.click(h.posts.at(-1), 'Corriger le formulaire', actor);
  await h.click(corrected, 'Remplir le formulaire', actor); const next = h.views.at(-1);
  await h.submit(next, project, actor); await h.run(`development:configuration:${next.private_metadata}`);
  const confirm = h.posts.at(-1); h.accessibleChannels.delete('CPROJECT');
  await h.click(confirm, 'Enregistrer la configuration', actor);
  expect(await h.store.project('pilot')).toBeUndefined();
  expect(h.posts.every(post => post.channel === 'DPRIVATE')).toBe(true);
});

it('edits project settings and confirms pause and retry privately without moving channel results into DMs', async () => {
  const h = await harness(), actor = { ...alice, channel: 'DPRIVATE' }; await h.configure();
  const prepared = await h.click(await h.dm('development status pilot'), 'Modifier la configuration', actor);
  await h.click(prepared, 'Remplir le formulaire', actor); const view = h.views.at(-1);
  expect(view.blocks.find((block: any) => block.block_id === 'channel').element.initial_conversation).toBe('CPROJECT');
  await h.submit(view, { ...project, name: 'Updated' }, actor); await h.run(`development:configuration:${view.private_metadata}`);
  await h.click(h.posts.at(-1), 'Enregistrer la configuration', actor);
  expect((await h.store.project('pilot'))!.name).toBe('Updated');
  await h.store.review((await h.store.project('pilot'))!, h.tasks.get('abc123')!, '1700000000.123456', 'dm-retry');
  await h.sql.query("UPDATE development_runs SET state='blocked'");
  const detail = await h.click(await h.click(await h.dm('development status pilot'), 'Voir les traitements', actor), 'Bloqué', actor);
  const retry = await h.click(detail, 'Relancer…', actor);
  await h.click(retry, 'Confirmer la relance', actor);
  expect(await h.store.history('pilot')).toHaveLength(2);
  const work = (await h.api('claim', { worker: randomUUID(), projects: ['pilot'] })).json().work;
  await h.api('result', { id: work.id, lease: work.lease, result: { outcome: 'actionable', summary: 'Prêt.', tests: [] } });
  await h.run(`development:finish:${work.id}`);
  expect(h.posts.at(-1).channel).toBe('CPROJECT');
  expect(h.posts.at(-1).thread_ts).toBe('1700000000.123456');
  const pause = await h.click(await h.dm('development status pilot'), 'Suspendre le projet', actor);
  await h.click(pause, 'Confirmer la suspension', actor);
  expect((await h.store.project('pilot'))!.enabled).toBe(false);
});

it('requires access to both old and new channels when changing a project destination privately', async () => {
  const h = await harness(), actor = { ...alice, channel: 'DPRIVATE' }; await h.configure();
  h.accessibleChannels.add('GOTHER');
  const prepared = await h.click(await h.dm('development status pilot'), 'Modifier la configuration', actor);
  await h.click(prepared, 'Remplir le formulaire', actor); const view = h.views.at(-1);
  await h.submit(view, { ...project, channel: 'GOTHER' }, actor);
  await h.run(`development:configuration:${view.private_metadata}`); const confirm = h.posts.at(-1);
  h.accessibleChannels.delete('CPROJECT');
  await h.click(confirm, 'Enregistrer la configuration', actor);
  expect((await h.store.project('pilot'))!.channel).toBe('CPROJECT');
  h.accessibleChannels.add('CPROJECT');
  await h.click(confirm, 'Enregistrer la configuration', actor);
  expect((await h.store.project('pilot'))!.channel).toBe('GOTHER');
  expect(h.posts.at(-1).channel).toBe('DPRIVATE');
  expect((await h.command('development status pilot')).text).not.toContain(project.repository);
});

it('selects both repositories privately and keeps their runs attached to the shared channel ticket', async () => {
  const h = await harness(), actor = { ...alice, channel: 'DPRIVATE' }; await sharedProjects(h);
  const request = await h.ingress('https://app.clickup.com/t/abc123'); await h.run(request.id);
  const list = await h.click(await h.dm('development menu'), 'Tickets et dépôts', actor);
  let picker = await h.click(await h.click(list, 'À affecter', actor), 'Choisir les dépôts', actor);
  for (const name of ['Projet pilote', 'Backend']) picker = await h.click(picker, `Ajouter ${name}`, actor);
  const confirm = await h.click(picker, 'Vérifier les dépôts', actor);
  await h.click(confirm, 'Confirmer les dépôts', alice);
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(0);
  await h.click(confirm, 'Confirmer les dépôts', actor);
  const runs = (await h.sql.query('SELECT * FROM development_runs')).rows;
  expect(runs).toHaveLength(2);
  expect(runs.every(run => run.config.channel === 'CPROJECT' && run.thread === '1700000000.000001')).toBe(true);
  expect(h.posts.at(-1).channel).toBe('DPRIVATE');
});

it('confines project screens to their channel even when the user belongs to both channels', async () => {
  const h = await harness(); await h.configure(); h.accessibleChannels.add('GOTHER');
  await h.store.save({ ...project, id: 'other', name: 'Other secret', channel: 'GOTHER' }, 'other');
  expect((await h.command('development projects')).text).not.toContain('Other secret');
  expect((await h.command('development status other')).text).not.toContain('Other secret');
  const request = await h.ingress('development projects', { channel: 'GOTHER' }); await h.run(request.id);
  expect(h.posts.at(-1).text).toContain('Other secret');
  expect(h.posts.at(-1).text).not.toContain('Projet pilote');
  h.accessibleChannels.delete('GOTHER');
  const count = h.posts.length;
  await h.click(h.posts.at(-1), 'Other secret', { ...alice, channel: 'GOTHER' });
  expect(h.posts).toHaveLength(count);
});

it('rejects private module and core controls at signed channel ingress and keeps help paging scoped', async () => {
  const h = await harness();
  for (const action of ['core:navigate', 'core:controls', 'mail:approve']) {
    const source = { ts: '1700000000.123456', blocks: [{ action_id: action, value: 'main', text: { text: 'Forbidden' } }] };
    await h.click(source, 'Forbidden', alice, source.ts, randomUUID(), 403);
  }
  expect((await h.sql.query('SELECT * FROM jobs WHERE id LIKE \'action:%\'')).rows).toHaveLength(0);
  const help = await h.command('development help');
  expect(JSON.stringify(help)).toContain('development:controls');
  const next = await h.click(help, 'Suivant');
  expect(next.ts).toBe(help.ts);
  expect(next.thread_ts).toBe(help.thread_ts);
  expect(JSON.stringify(next)).not.toContain('core:');
});

it('keeps the same channel, list and folder and routes a ticket to both repositories only after confirmation', async () => {
  const h = await harness(); await sharedProjects(h);
  const request = await h.ingress('https://app.clickup.com/t/abc123'); await h.run(request.id);
  expect(h.posts.at(-1).text).toContain('Tickets et dépôts');
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(0);
  const confirmation = await chooseRepositories(h);
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(0);
  await h.click(confirmation, 'Confirmer les dépôts');
  await h.click(confirmation, 'Confirmer les dépôts');
  const runs = (await h.sql.query('SELECT * FROM development_runs ORDER BY project')).rows;
  expect(runs.map(r => r.project)).toEqual(['backend', 'pilot']);
  expect(runs.every(r => r.kind === 'review' && r.config.folder === '123' && r.config.channel === 'CPROJECT' && r.thread === '1700000000.000001')).toBe(true);
  expect(h.comments).toEqual([]); expect(h.statuses).toEqual([]);
  expect(h.posts.some(p => p.text.includes('ne peut pas être analysé'))).toBe(false);
  const reply = await h.ingress('Précision commune.', { thread: '1700000000.000001' }); await h.run(reply.id);
  expect(h.comments).toHaveLength(1);
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(4);
});

it('holds Ready for AI without a choice and changes the shared status only after both pushes', async () => {
  const h = await harness(); await sharedProjects(h); h.tasks.get('abc123')!.status = 'Ready for AI';
  await h.poll(); await h.poll();
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(0);
  expect(h.posts.filter(p => p.text.includes('Choisissez les dépôts concernés'))).toHaveLength(1);
  const confirmation = await chooseRepositories(h); await h.click(confirmation, 'Confirmer les dépôts');
  await h.poll(); await h.poll();
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(2);
  h.tasks.get('abc123')!.description = 'Changed after authorization';
  const front = await finishRepository(h, 'pilot');
  expect(front.ticket.description).toBe('Le menu ne se ferme pas au clic.');
  expect(h.statuses).toEqual([]);
  expect(h.posts.at(-1).text).toContain('En attente des autres dépôts');
  await finishRepository(h, 'backend');
  expect(h.statuses).toEqual(['to build']);
  expect(h.comments).toHaveLength(2);
  await h.poll();
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(2);
});

it('can select only one repository without dispatching to its sibling', async () => {
  const h = await harness(); await sharedProjects(h); h.tasks.get('abc123')!.status = 'Ready for AI';
  await h.poll(); await h.click(await chooseRepositories(h, ['Backend']), 'Confirmer les dépôts'); await h.poll();
  expect(await h.store.history('pilot')).toHaveLength(0);
  await finishRepository(h, 'backend');
  expect(h.statuses).toEqual(['to build']);
});

it('keeps to build pending after one blocked repository and retries only that repository', async () => {
  const h = await harness(); await sharedProjects(h); h.tasks.get('abc123')!.status = 'Ready for AI';
  await h.poll(); await h.click(await chooseRepositories(h), 'Confirmer les dépôts'); await h.poll();
  await finishRepository(h, 'pilot'); const failed = await finishRepository(h, 'backend', 'blocked');
  await h.poll(); expect(h.statuses).toEqual([]);
  const retry = await h.click(await h.click(await h.command('development status backend'), 'Voir les traitements'), 'Bloqué');
  await h.click(await h.click(retry, 'Relancer…'), 'Confirmer la relance');
  await finishRepository(h, 'backend');
  expect(h.statuses).toEqual(['to build']);
  expect(await h.store.history('pilot')).toHaveLength(1);
  expect(await h.store.history('backend')).toHaveLength(2);
  await h.command(`development retry ${failed.id}`);
  expect(await h.store.history('backend')).toHaveLength(2);
});

it('binds routing choices to the owner, channel and message and rejects changed project snapshots', async () => {
  const h = await harness(); await sharedProjects(h); h.tasks.get('abc123')!.status = 'Ready for AI';
  await h.poll(); const confirmation = await chooseRepositories(h);
  for (const actor of [{ ...alice, user: 'UBOB' }, { ...alice, channel: 'DOTHER' }]) await h.click(confirmation, 'Confirmer les dépôts', actor);
  await h.click(confirmation, 'Confirmer les dépôts', alice, '9.000001');
  expect((await h.sql.query('SELECT selected FROM development_ticket_routes')).rows[0].selected).toBeNull();
  await h.store.save({ ...project, skill: 'changed' }, 'change-destination');
  await h.click(confirmation, 'Confirmer les dépôts'); await h.poll();
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(0);
});

it('does not reinterpret a disabled sibling as permission to use the remaining repository', async () => {
  const h = await harness(); await sharedProjects(h);
  await h.store.save({ ...(await h.store.project('backend'))!, enabled: false }, 'pause-backend');
  h.tasks.get('abc123')!.status = 'Ready for AI'; await h.poll();
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(0);
  expect(h.posts.at(-1).text).toContain('Choisissez les dépôts');
});

it('holds historical unassigned queued work when a folder becomes shared', async () => {
  const h = await harness(); await h.configure(); h.tasks.get('abc123')!.status = 'Ready for AI'; await h.poll();
  await h.store.save({ ...project, id: 'backend', name: 'Backend', repository: 'https://github.com/example/backend' }, 'backend');
  expect((await h.api('claim', { worker: randomUUID(), projects: ['pilot', 'backend'] })).json().work).toBeNull();
  await h.poll(); await h.click(await chooseRepositories(h), 'Confirmer les dépôts');
  expect(h.posts.at(-1).text).toContain('traitements antérieurs');
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(1);
});

it('cancels and expires routing proposals and lets only the first confirmed choice win', async () => {
  const h = await harness(); await sharedProjects(h); h.tasks.get('abc123')!.status = 'Ready for AI'; await h.poll();
  const cancelled = await chooseRepositories(h); await h.click(cancelled, 'Annuler'); await h.click(cancelled, 'Confirmer les dépôts');
  expect((await h.sql.query('SELECT selected FROM development_ticket_routes')).rows[0].selected).toBeNull();
  const expired = await chooseRepositories(h); await h.sql.query("UPDATE development_route_proposals SET created_at=now()-interval '25 hours'");
  await h.click(expired, 'Confirmer les dépôts');
  expect((await h.sql.query('SELECT selected FROM development_ticket_routes')).rows[0].selected).toBeNull();
  const first = await chooseRepositories(h, ['Backend']), second = await chooseRepositories(h, ['Projet pilote']);
  await h.click(first, 'Confirmer les dépôts'); await h.click(second, 'Confirmer les dépôts'); await h.poll();
  expect(await h.store.history('pilot')).toHaveLength(0); expect(await h.store.history('backend')).toHaveLength(1);
});

it('rechecks provider access and holds an entire new correction if a selected project changes or pauses', async () => {
  const h = await harness(); await sharedProjects(h); h.tasks.get('abc123')!.status = 'Ready for AI'; await h.poll();
  const choice = await chooseRepositories(h);
  h.accessFailure('clickup'); await h.click(choice, 'Confirmer les dépôts');
  expect((await h.sql.query('SELECT selected FROM development_ticket_routes')).rows[0].selected).toBeNull();
  h.accessFailure(undefined); await h.click(choice, 'Confirmer les dépôts');
  const backend = (await h.store.project('backend'))!;
  await h.store.save({ ...backend, enabled: false }, 'pause'); await h.poll();
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(0);
  await h.store.save({ ...backend, repository: 'https://github.com/example/replaced' }, 'change'); await h.poll();
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(0);
  await h.store.save(backend, 'restore'); await h.poll();
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(2);
});

it('retains both results and does not repeat an uncertain shared status write', async () => {
  const h = await harness(); await sharedProjects(h); h.tasks.get('abc123')!.status = 'Ready for AI'; await h.poll();
  await h.click(await chooseRepositories(h), 'Confirmer les dépôts'); await h.poll();
  await finishRepository(h, 'pilot'); h.failStatus(); const backend = await finishRepository(h, 'backend');
  expect((await h.store.run(backend.id))!.state).toBe('reporting_error');
  expect(h.statuses).toEqual(['to build']);
  await h.poll(); h.tasks.get('abc123')!.status = 'Ready for AI'; await h.poll();
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(2);
  expect(h.statuses).toEqual(['to build']);
});

it('continues discovering other shared tickets after an uncertain routing notice', async () => {
  const h = await harness(); await sharedProjects(h); h.tasks.get('abc123')!.status = 'Ready for AI';
  h.tasks.set('def456', { ...h.tasks.get('abc123')!, id: 'def456', name: 'Second ticket' });
  h.failPost(); await h.poll(); await h.poll();
  expect((await h.sql.query('SELECT * FROM development_ticket_routes')).rows).toHaveLength(2);
  expect(h.posts.filter(p => p.text.includes('Choisissez les dépôts concernés'))).toHaveLength(2);
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(0);
});

it('does not post a false mismatch for another folder using the same Slack channel', async () => {
  const h = await harness(); await h.configure();
  await h.store.save({ ...project, id: 'unrelated', folder: '456', repository: 'https://github.com/example/unrelated' }, 'unrelated');
  const before = h.posts.length;
  const request = await h.ingress('https://app.clickup.com/t/abc123'); await h.run(request.id);
  expect(await h.store.history('pilot')).toHaveLength(1);
  expect(await h.store.history('unrelated')).toHaveLength(0);
  expect(h.posts).toHaveLength(before);
});

it('creates a project entirely through the signed form, validates asynchronously, and confirms once', async () => {
  const h = await harness();
  const { view, prepared } = await newForm(h);
  expect(view.blocks.find((block: any) => block.block_id === 'channel').text.text).toContain('CPROJECT');
  expect(view.blocks.find((block: any) => block.block_id === 'channel').element).toBeUndefined();
  expect(view.blocks.find((block: any) => block.block_id === 'enabled').element.initial_options).toBeUndefined();
  const before = h.requests.length;
  expect((await h.submit(view, { ...project, enabled: false })).json()).toEqual({});
  expect(h.requests).toHaveLength(before);
  expect(await h.store.project('pilot')).toBeUndefined();
  await h.run(`development:configuration:${view.private_metadata}`);
  const confirmation = h.posts.at(-1);
  expect(confirmation.text).toContain('Maya / Projets / Maintenance (123)');
  expect(confirmation.ts).toBe(prepared.ts);
  expect(await h.store.project('pilot')).toBeUndefined();
  await h.click(confirmation, 'Enregistrer la configuration');
  expect(await h.store.project('pilot')).toEqual({ ...project, enabled: false });
  expect((await h.submit(view, { ...project, enabled: false })).json()).toEqual({});
  await h.store.save({ ...project, name: 'Changed later' }, 'later');
  await h.click(confirmation, 'Enregistrer la configuration');
  expect((await h.store.project('pilot'))!.name).toBe('Changed later');
  expect((await h.sql.query('SELECT * FROM development_runs')).rows).toHaveLength(0);
  expect(h.comments).toEqual([]); expect(h.statuses).toEqual([]);
  await h.click(prepared, 'Remplir le formulaire');
  expect(h.views).toHaveLength(1);
});

it('prefills editing, keeps the project identifier, and saves all fields without a command', async () => {
  const h = await harness(); await h.configure();
  const prepared = await h.click(await h.command('development status pilot'), 'Modifier la configuration');
  const before = h.requests.length;
  await h.click(prepared, 'Remplir le formulaire');
  expect(h.requests.slice(before)).toEqual(['/api/views.open']);
  const view = h.views.at(-1);
  expect(view.blocks.some((block: any) => block.block_id === 'id')).toBe(false);
  expect(view.blocks.find((block: any) => block.block_id === 'name').element.initial_value).toBe(project.name);
  expect(view.blocks.find((block: any) => block.block_id === 'repository').element.initial_value).toBe(project.repository);
  expect(view.blocks.find((block: any) => block.block_id === 'enabled').element.initial_options).toHaveLength(1);
  const edited = { ...project, name: 'Renamed', repository: 'https://gitlab.com/example/other', skill: 'maintenance-v2', enabled: false };
  expect((await h.submit(view, { ...edited, id: 'cannot-rename' })).json()).toEqual({});
  await h.run(`development:configuration:${view.private_metadata}`);
  await h.click(h.posts.at(-1), 'Enregistrer la configuration');
  expect(await h.store.project('pilot')).toEqual(edited);
  expect(await h.store.project('cannot-rename')).toBeUndefined();
});

it('searches named ClickUp folders beyond the first 100 from an owner-bound prepared snapshot', async () => {
  const h = await harness();
  h.folders.push(...Array.from({ length: 110 }, (_, index) => ({ id: String(1000 + index), name: `Dossier ${index}`, archived: false })));
  h.folders.push({ id: '9876', name: 'Réparations', archived: false }, { id: '9877', name: 'Archivé', archived: true });
  const { view } = await newForm(h);
  const input = view.blocks.find((block: any) => block.block_id === 'folder');
  expect(input.element.type).toBe('multi_external_select');
  const before = h.requests.length;
  expect((await h.suggest(view)).json().options).toHaveLength(100);
  const result = (await h.suggest(view, 'maya reparations')).json().options;
  expect(result).toEqual([{ text: { type: 'plain_text', text: 'Réparations · 9876' }, value: '9876', description: { type: 'plain_text', text: 'Maya / Projets' } }]);
  expect((await h.suggest(view, '1109')).json().options[0].value).toBe('1109');
  expect((await h.suggest(view, 'archivé')).json().options).toEqual([]);
  expect((await h.suggest(view, 'missing')).json().options).toEqual([]);
  expect(h.requests).toHaveLength(before); // Suggestions never call Slack or ClickUp.
  expect((await h.sql.query("SELECT * FROM jobs WHERE payload->>'type'='configuration_validate'")).rows).toHaveLength(0);
});

it('rejects unsigned, cross-user, cross-workspace, wrong-field, disabled and expired folder suggestions', async () => {
  const h = await harness(); const { view } = await newForm(h);
  expect((await h.suggest(view, '', alice, {}, false)).statusCode).toBe(401);
  expect((await h.suggest(view, '', { ...alice, team: 'TOTHER' })).statusCode).toBe(403);
  expect((await h.suggest(view, '', { ...alice, user: 'UBOB' })).json().options).toEqual([]);
  expect((await h.suggest(view, '', alice, { block_id: 'repository' })).json().options).toEqual([]);
  expect((await h.suggest(view, '', alice, { action_id: 'wrong' })).json().options).toEqual([]);
  expect((await h.suggest({ ...view, callback_id: 'disabled:configuration' })).statusCode).toBe(403);
  expect((await h.suggest(view, '', alice, { value: {} })).statusCode).toBe(400);
  await h.sql.query("UPDATE development_configuration_forms SET created_at=now()-interval '25 hours'");
  expect((await h.suggest(view)).json().options).toEqual([]);
});

it('prefills the selected folder and refuses a forged or missing selection before enqueueing validation', async () => {
  const h = await harness(); await h.configure();
  const prepared = await h.click(await h.command('development status pilot'), 'Modifier la configuration');
  await h.click(prepared, 'Remplir le formulaire'); const view = h.views.at(-1);
  expect(view.blocks.find((block: any) => block.block_id === 'folder').element.initial_options[0].value).toBe('123');
  for (const folder of ['99999', null]) expect((await h.submit(view, { ...project, folder })).json().errors.folder).toBeTruthy();
  expect((await h.sql.query("SELECT * FROM jobs WHERE payload->>'type'='configuration_validate'")).rows).toHaveLength(0);
  await h.submit(view, { ...project, folder: '456' });
  await h.run(`development:configuration:${view.private_metadata}`);
  expect(h.posts.at(-1).text).toContain('Autre dossier (456)');
  expect((await h.suggest(view)).json().options).toEqual([]);
  await h.click(h.posts.at(-1), 'Enregistrer la configuration');
  expect((await h.store.project('pilot'))!.folder).toBe('456');
});

it('offers refresh when folder discovery is empty or fails and preserves the project', async () => {
  const h = await harness(); await h.configure(); h.folders.length = 0;
  const prepared = await h.click(await h.command('development status pilot'), 'Modifier la configuration');
  expect(prepared.text).toContain('Aucun dossier');
  expect(h.views).toHaveLength(0);
  h.accessFailure('clickup');
  const failed = await h.click(prepared, 'Actualiser les dossiers');
  expect(failed.text).toContain('chargés complètement');
  expect(await h.store.project('pilot')).toEqual(project);
  h.accessFailure(undefined); h.folders.push({ id: '456', name: 'Nouveau dossier', archived: false });
  const ready = await h.click(failed, 'Actualiser les dossiers');
  await h.click(ready, 'Remplir le formulaire'); const view = h.views.at(-1);
  expect(view.blocks.find((block: any) => block.block_id === 'folder').element.initial_options).toBeUndefined();
  expect(JSON.stringify(view)).toContain('ne figurent plus');
  expect((await h.suggest(view)).json().options[0].value).toBe('456');
});

it('refreshes folder choices in a fresh draft and invalidates the old form', async () => {
  const h = await harness(); const { view, prepared } = await newForm(h);
  h.folders[0]!.name = 'Nom actualisé';
  expect((await h.suggest(view, 'actualisé')).json().options).toEqual([]);
  const refreshed = await h.click(prepared, 'Actualiser les dossiers');
  await h.click(refreshed, 'Remplir le formulaire');
  expect((await h.suggest(h.views.at(-1), 'actualisé')).json().options[0].value).toBe('123');
  expect((await h.suggest(view)).json().options).toEqual([]);
  expect((await h.submit(view, project)).json().response_action).toBe('errors');
});

it('shows per-field validation errors and rejects an existing identifier without enqueueing work', async () => {
  const h = await harness();
  const { view } = await newForm(h);
  const invalid = (await h.submit(view, { ...project, id: 'Bad ID', folder: 'abc', repository: 'https://user:secret@example.com/repo' })).json();
  expect(invalid.response_action).toBe('errors');
  expect(Object.keys(invalid.errors).sort()).toEqual(['folder', 'id', 'repository']);
  expect(JSON.stringify(invalid)).not.toContain('secret');
  expect((await h.sql.query("SELECT * FROM jobs WHERE payload->>'type'='configuration_validate'")).rows).toHaveLength(0);
  await h.configure();
  expect((await h.submit(view, project)).json().errors.id).toContain('existe déjà');
});

it('binds opening and submission to the owner, channel, message, signature, workspace and expiry', async () => {
  const h = await harness();
  const { view, prepared } = await newForm(h);
  for (const actor of [{ ...alice, user: 'UBOB' }, { ...alice, channel: 'DOTHER' }]) await h.click(prepared, 'Remplir le formulaire', actor);
  await h.click(prepared, 'Remplir le formulaire', alice, '9.000001');
  expect(h.views).toHaveLength(1);
  expect((await h.submit(view, project, { ...alice, user: 'UBOB' })).json().response_action).toBe('errors');
  expect((await h.submit(view, project, alice, false)).statusCode).toBe(401);
  expect((await h.submit(view, project, { ...alice, team: 'TOTHER' })).statusCode).toBe(403);
  expect((await h.submit({ ...view, callback_id: 'missing:configuration' }, project)).statusCode).toBe(403);
  await h.sql.query("UPDATE development_configuration_forms SET created_at=now()-interval '25 hours'");
  expect((await h.submit(view, project)).json().response_action).toBe('errors');
  expect(await h.store.project('pilot')).toBeUndefined();
});

it.each(['conversations.members', 'clickup'] as const)('retains submitted values after %s access failure and permits correction in a fresh form', async failure => {
  const h = await harness();
  const { view } = await newForm(h);
  await h.submit(view, project);
  h.accessFailure(failure);
  if (failure === 'conversations.members') {
    await expect(h.run(`development:configuration:${view.private_metadata}`)).rejects.toThrow('Accès Slack indisponible');
    expect(await h.store.project('pilot')).toBeUndefined();
    h.accessFailure(undefined);
  }
  await h.run(`development:configuration:${view.private_metadata}`);
  const error = h.posts.at(-1);
  expect(error.text).toContain(failure === 'clickup' ? 'Aucune configuration enregistrée' : 'Vérifiez la configuration');
  expect(await h.store.project('pilot')).toBeUndefined();
  h.accessFailure(undefined);
  const corrected = await h.click(error, 'Corriger le formulaire');
  await h.click(corrected, 'Remplir le formulaire');
  const next = h.views.at(-1);
  expect(next.private_metadata).not.toBe(view.private_metadata);
  expect(next.blocks.find((block: any) => block.block_id === 'name').element.initial_value).toBe(project.name);
  expect((await h.submit(view, project)).json().response_action).toBe('errors');
  await h.submit(next, project);
  await h.run(`development:configuration:${next.private_metadata}`);
  await h.click(h.posts.at(-1), 'Enregistrer la configuration');
  expect(await h.store.project('pilot')).toEqual(project);
});

it('does not save cancelled forms or overwrite concurrent project changes', async () => {
  const h = await harness();
  const { view, prepared } = await newForm(h);
  await h.click(prepared, 'Annuler');
  expect((await h.submit(view, project)).json().response_action).toBe('errors');
  await h.configure();
  const edit = await h.click(await h.command('development status pilot'), 'Modifier la configuration');
  await h.click(edit, 'Remplir le formulaire');
  const editing = h.views.at(-1);
  await h.submit(editing, { ...project, name: 'My edit' });
  await h.run(`development:configuration:${editing.private_metadata}`);
  const confirm = h.posts.at(-1);
  await h.store.save({ ...project, name: 'Other user edit' }, 'other-edit');
  await h.click(confirm, 'Enregistrer la configuration');
  expect(h.posts.at(-1).text).toContain('modifié');
  expect((await h.store.project('pilot'))!.name).toBe('Other user edit');
});

it('keeps a form configuration in its originating channel despite submitted channel values', async () => {
  const h = await harness();
  const { view } = await newForm(h);
  await h.submit(view, { ...project, channel: 'COTHER' });
  await h.run(`development:configuration:${view.private_metadata}`);
  expect(h.posts.at(-1).text).toContain('Canal : CPROJECT');
  await h.click(h.posts.at(-1), 'Enregistrer la configuration');
  expect(await h.store.project('pilot')).toEqual(project);
});

it('rechecks access at confirmation and preserves a committed save after uncertain delivery', async () => {
  const h = await harness();
  const { view } = await newForm(h);
  await h.submit(view, project);
  await h.run(`development:configuration:${view.private_metadata}`);
  const confirm = h.posts.at(-1);
  h.accessFailure('conversations.members');
  await expect(h.click(confirm, 'Enregistrer la configuration')).rejects.toThrow('Accès Slack indisponible');
  expect(await h.store.project('pilot')).toBeUndefined();
  h.accessFailure(undefined);
  h.failPost();
  await expect(h.click(confirm, 'Enregistrer la configuration')).rejects.toThrow('Uncertain Slack delivery');
  expect(await h.store.project('pilot')).toEqual(project);
  await h.store.save({ ...project, name: 'Later edit' }, 'later-edit');
  await h.click(confirm, 'Enregistrer la configuration');
  expect((await h.store.project('pilot'))!.name).toBe('Later edit');
});

it('does not replay an uncertain modal open and allows a fresh click without provider reads', async () => {
  const h = await harness();
  const prepared = await h.click(await h.command('menu'), 'Configurer un projet');
  const requestsBeforeOpening = h.requests.length;
  const id = randomUUID();
  h.failView();
  await h.click(prepared, 'Remplir le formulaire', alice, prepared.ts, id);
  await h.click(prepared, 'Remplir le formulaire', alice, prepared.ts, id);
  expect(h.views).toHaveLength(1);
  expect(h.requests.slice(requestsBeforeOpening).filter(request => request.startsWith('/api/conversations.') || request.startsWith('/api/v2'))).toEqual([]);
  const notice = (await h.sql.query("SELECT id FROM jobs WHERE payload->>'type'='configuration_notice'")).rows[0]!;
  await h.run(notice.id);
  expect(h.posts.at(-1).ts).toBe(prepared.ts);
  const requestsBeforeRetry = h.requests.length;
  await h.click(h.posts.at(-1), 'Remplir le formulaire');
  expect(h.views).toHaveLength(2);
  expect(h.views[0].external_id).not.toBe(h.views[1].external_id);
  expect(h.requests.slice(requestsBeforeRetry).filter(request => request.startsWith('/api/conversations.') || request.startsWith('/api/v2'))).toEqual([]);
});

it('browses projects, configuration, history and run details through signed buttons without starting work', async () => {
  const h = await harness(); await h.configure();
  for (let index = 0; index < 10; index++) await h.store.review(project, { ...h.tasks.get('abc123')!, name: `Ticket ${index}` }, '1700000000.000001', `browse-${index}`);
  const reads = h.snapshotCount();
  const main = await h.command('menu');
  const module = main;
  expect(module.ts).toBe(main.ts);
  const projects = await h.click(module, 'Projets et traitements');
  const detail = await h.click(projects, 'Projet pilote');
  expect(detail.text).toContain('Skill : maintenance');
  expect(JSON.stringify(detail)).toContain('https://app.slack.com/client/TTEAM/CPROJECT');
  const configuration = await h.click(detail, 'Modifier la configuration');
  expect(configuration.text).toContain('formulaire');
  const history = await h.click(detail, 'Voir les traitements');
  expect(JSON.stringify(history)).toContain('Ouvrir');
  const next = await h.click(history, 'Suivant');
  expect(next.text).toContain('Page 2');
  const run = await h.click(next, 'En attente du worker');
  expect(run.text).toContain('Traitement : review:browse-');
  expect(JSON.stringify(run)).toContain('https://app.clickup.com/t/abc123');
  await h.click(run, 'Actualiser');
  expect(h.snapshotCount()).toBe(reads);
  expect((await h.sql.query('SELECT count(*)::int AS count FROM development_runs')).rows[0].count).toBe(10);
  expect(h.comments).toEqual([]); expect(h.statuses).toEqual([]);
});

it('confirms pause/resume separately, preserves configuration and cannot replay an old confirmation', async () => {
  const h = await harness(); await h.configure();
  const page = await h.command('development status pilot');
  const pause = await h.click(page, 'Suspendre le projet');
  expect(pause.ts).toBe(page.ts);
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

it('opens long legacy run identifiers through bounded controls and offers interactive setup', async () => {
  const h = await harness(); await h.configure();
  const setup = await h.click(await h.command('menu'), 'Configurer un projet');
  expect(setup.text).toContain('formulaire');
  await h.store.review(project, h.tasks.get('abc123')!, '1700000000.000001', 'long-id');
  await h.sql.query("UPDATE development_runs SET id=$1,state='blocked'", ['r'.repeat(300)]);
  const detail = await h.click(await h.click(await h.command('development status pilot'), 'Voir les traitements'), 'Bloqué');
  expect(detail.text).toContain('r'.repeat(300));
  const confirmation = await h.click(detail, 'Relancer…');
  await h.click(confirmation, 'Confirmer la relance');
  expect(await h.store.history('pilot')).toHaveLength(2);
});

it('recovers uncertain confirmation delivery without repeating a saved effect', async () => {
  const h = await harness(); await h.configure();
  const confirmation = await h.click(await h.command('development status pilot'), 'Suspendre le projet');
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
  const page = await h.command('development status pilot');
  await h.sql.query("UPDATE core_navigation_menus SET created_at=now()-interval '31 days'");
  await h.click(page, 'Suspendre le projet');
  expect((await h.sql.query('SELECT * FROM development_confirmations')).rows).toHaveLength(0);
  expect((await h.store.project('pilot'))!.enabled).toBe(true);
});

it('rejects another owner, channel, message, expired confirmation and changed project configuration', async () => {
  const h = await harness(); await h.configure();
  const page = await h.command('development status pilot');
  const proposal = await h.click(page, 'Suspendre le projet');
  for (const actor of [{ ...alice, user: 'UBOB' }, { ...alice, channel: 'DOTHER' }]) await h.click(proposal, 'Confirmer la suspension', actor);
  await h.click(proposal, 'Confirmer la suspension', alice, '1.000001');
  expect((await h.store.project('pilot'))!.enabled).toBe(true);
  await h.store.save({ ...project, skill: 'changed' }, 'changed-config');
  const stale = await h.click(proposal, 'Confirmer la suspension');
  expect(stale.text).toContain('configuration modifiée');
  expect((await h.store.project('pilot'))!.enabled).toBe(true);
  const fresh = await h.click(await h.command('development status pilot'), 'Suspendre le projet');
  await h.sql.query("UPDATE development_confirmations SET created_at=now()-interval '25 hours'");
  await h.click(fresh, 'Confirmer la suspension');
  expect((await h.store.project('pilot'))!.enabled).toBe(true);
});

it('cancels and confirms a blocked-run retry once while retaining its frozen requirements', async () => {
  const h = await harness(); await h.configure();
  await h.store.review(project, h.tasks.get('abc123')!, '1700000000.000001', 'blocked');
  await h.sql.query("UPDATE development_runs SET state='blocked',result=$1", [JSON.stringify({ outcome: 'blocked', summary: 'Service indisponible.', tests: [] })]);
  const history = await h.click(await h.command('development status pilot'), 'Voir les traitements');
  const detail = await h.click(history, 'Bloqué');
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
  const detail = await h.click(await h.click(await h.command('development status pilot'), 'Voir les traitements'), 'Publication à vérifier');
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
  const detail = await h.click(await h.click(await h.command('development status pilot'), 'Voir les traitements'), 'Bloqué');
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

it('configures through signed channel dispatch and restricts configuration/status to channel members', async () => {
  const h = await harness();
  await h.configure(); expect(await h.store.project('pilot')).toEqual(project);
  expect(h.posts.at(-1).text).toContain('Projet Projet pilote enregistré');
  await h.command('development projects');
  expect(h.posts.at(-1).text).toContain('pilot — Projet pilote');
  const postCount = h.posts.length;
  await h.command(`development configure ${JSON.stringify({ ...project, skill: 'other' })}`, 'UOUTSIDER');
  expect((await h.store.project('pilot'))!.skill).toBe('maintenance');
  await h.command('development projects', 'UOUTSIDER');
  expect(h.posts).toHaveLength(postCount);
  expect((await h.ingress('https://app.clickup.com/t/abc123', { team: 'TOTHER' })).response.statusCode).toBe(403);
  expect((await h.api('claim', { worker: randomUUID(), projects: ['pilot'] }, 'wrong')).statusCode).toBe(401);
});

it.each(['conversations.info', 'conversations.members', 'clickup'] as const)('fails closed on %s configuration access failures without saving a project', async failure => {
  const h = await harness(failure);
  if (failure === 'clickup') await h.configure();
  else await expect(h.configure()).rejects.toThrow('Accès Slack indisponible');
  expect(await h.store.project('pilot')).toBeUndefined();
  if (failure === 'clickup') {
    expect(h.posts.at(-1).text).toContain('Configuration non enregistrée');
    expect(h.posts.at(-1).text).toContain('ClickUp');
    expect(h.posts.at(-1).channel).toBe('CPROJECT');
  } else expect(h.posts).toHaveLength(0);
  const jobs = (await h.sql.query("SELECT status FROM jobs WHERE module='development' AND actor->>'user'='UALICE'")).rows;
  expect(jobs).toEqual([{ status: failure === 'clickup' ? 'done' : 'queued' }]);
});

it.each(['<URL>', '<URL|Orientaction frontend>'])('accepts Slack repository link formatting %s through signed channel dispatch', async format => {
  const h = await harness();
  const repository = 'https://gitlab.com/mayasquad/orient-action/orient-action-frontend';
  const configured = { ...project, repository };
  await h.command(`development configure ${JSON.stringify({ ...configured, repository: format.replace('URL', repository) })}`);
  expect(await h.store.project('pilot')).toEqual(configured);
  expect(h.posts.at(-1).text).toContain('enregistré');
  await h.command('development projects');
  expect(h.posts.at(-1).text).toContain('pilot — Projet pilote');
});

it.each(['not-a-url', '<https://example.com', 'https://', '<not-a-url|https://gitlab.com/example/project>', '<http://example.com/project>', '<https://user:password@example.com/project>', '<https://example.com/project?token=secret>', '<https://example.com/project#fragment>'])('rejects invalid repository input without throwing or saving: %s', async repository => {
  expect(projectSchema.safeParse({ ...project, repository }).success).toBe(false);
  const h = await harness();
  await h.command(`development configure ${JSON.stringify({ ...project, repository })}`);
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
  await h.command(`development retry ${work.id}`);
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
  await h.command(`development retry ${work.id}`); expect(await h.store.history('pilot')).toHaveLength(2);
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
