import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createModules } from '../src/app/modules.js';
import { readConfig } from '../src/app/config.js';
import { schema } from '../src/app/schema.js';
import { createServer } from '../src/core/server.js';
import { dispatchJob } from '../src/core/dispatch.js';
import { JobStore, type Sql } from '../src/core/store.js';
import { Slack } from '../src/core/slack.js';
import { Store } from '../src/modules/mail/store.js';

const alice = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
const bob = { ...alice, user: 'UBOB', channel: 'DBOB' };
const env = { PUBLIC_URL: 'https://agent.example.com', DATABASE_URL: 'postgresql://unused', SLACK_TEAM_ID: alice.team, SLACK_BOT_TOKEN: 'fake', SLACK_SIGNING_SECRET: 'secret', ENABLED_MODULES: 'mail,documentation', ENCRYPTION_KEY: randomBytes(32).toString('base64'), GOOGLE_CLIENT_ID: 'fake', GOOGLE_CLIENT_SECRET: 'fake', GOOGLE_WORKSPACE_DOMAINS: 'example.com', OPENAI_API_KEY: 'unused' };
let db: PGlite, sql: Sql;
beforeAll(async () => { db = new PGlite(); await db.exec(schema); sql = { query: (text, values) => db.query(text, values) }; });
beforeEach(async () => { for (const row of (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows) await db.exec(`TRUNCATE ${row.tablename} CASCADE`); });
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => db.close());

async function harness() {
  const views: any[] = [], messages: any[] = [];
  let rejectOpen = false, rejectUpdate = false;
  const provider = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('https://slack.com/api/views.open');
    views.push(JSON.parse(String(init?.body)).view);
    if (rejectOpen) { rejectOpen = false; throw new Error('Uncertain modal delivery'); }
    return Response.json({ ok: true });
  });
  vi.stubGlobal('fetch', provider);
  const config = readConfig(env), modules = createModules(config, sql, env), jobs = new JobStore(sql);
  for (const module of modules.all()) await module.initialize?.({ query: async text => (await db.exec(text)).at(-1)! });
  const app = createServer(config, jobs, modules);
  const messenger = new Slack('fake', (async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (rejectUpdate && body.ts) { rejectUpdate = false; return Response.json({ ok: false, error: 'ratelimited' }); }
    const ts = body.ts ?? `1700000000.${messages.length + 1}`;
    messages.push({ ...body, ts, method: String(url).split('/').at(-1) });
    return Response.json({ ok: true, ts });
  }) as typeof fetch);
  const signed = async (path: string, payload: unknown) => {
    const json = JSON.stringify(payload), raw = path === '/slack/events' ? json : new URLSearchParams({ payload: json }).toString();
    const stamp = String(Math.floor(Date.now() / 1000));
    return app.inject({ method: 'POST', url: path, payload: raw, headers: { 'content-type': path === '/slack/events' ? 'application/json' : 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': stamp, 'x-slack-signature': `v0=${createHmac('sha256', 'secret').update(`v0:${stamp}:${raw}`).digest('hex')}` } });
  };
  const drain = async () => {
    for (const job of (await sql.query("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,id")).rows) { await dispatchJob(sql, config, modules, messenger, job); await jobs.complete(job.id); }
    return messages.at(-1);
  };
  const dm = async (text: string, actor = alice) => { expect((await signed('/slack/events', { type: 'event_callback', team_id: actor.team, event_id: randomUUID(), event: { type: 'message', channel_type: 'im', channel: actor.channel, user: actor.user, text } })).statusCode).toBe(200); return drain(); };
  const buttons = (message: any) => {
    const found: any[] = [];
    const visit = (object: any) => { if (!object || typeof object !== 'object') return; if (object.type === 'button') found.push(object); Object.values(object).forEach(value => Array.isArray(value) ? value.forEach(visit) : visit(value)); };
    visit(message.blocks); return found;
  };
  const click = async (message: any, label: string, actor = alice) => {
    const control = buttons(message).find(button => button.text.text.replace(/^(?:🧭|\?) /, '') === label);
    expect(control, label).toBeDefined();
    expect((await signed('/slack/actions', { type: 'block_actions', team: { id: actor.team }, user: { id: actor.user }, channel: { id: actor.channel }, message: { ts: message.ts }, trigger_id: 'fake-trigger', actions: [{ action_id: control.action_id, value: control.value, action_ts: randomUUID() }] })).statusCode).toBe(200);
    return drain();
  };
  const submit = (view: any, changes: Record<string, string | string[]> = {}, actor = alice) => {
    const values = Object.fromEntries(view.blocks.filter((block: any) => block.type === 'input').map((block: any) => {
      const field = block.element, supplied = changes[block.block_id];
      const value = field.type === 'multi_external_select' ? { selected_options: supplied === undefined ? field.initial_options ?? [] : (supplied as string[]).map(value => ({ value })) }
        : field.type === 'external_select' ? { selected_option: supplied === undefined ? field.initial_option ?? null : supplied ? { value: supplied } : null }
          : { value: supplied ?? field.initial_value ?? null };
      return [block.block_id, { value }];
    }));
    return signed('/slack/actions', { type: 'view_submission', team: { id: actor.team }, user: { id: actor.user }, view: { callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values } } });
  };
  const seed = async (kind: string, fields: Record<string, unknown>) => {
    const proposal = await dm(`documentation create ${kind} ${JSON.stringify(fields)}`);
    const control = buttons(proposal).find(button => /:confirm_create/.test(button.action_id));
    expect(control).toBeDefined();
    const row = (await sql.query('SELECT target_id FROM documentation_confirmations WHERE id=$1', [control.value])).rows[0];
    await click(proposal, 'Confirmer la création'); return row.target_id as string;
  };
  return { app, views, messages, provider, dm, click, submit, signed, drain, seed, buttons, rejectOpen: () => { rejectOpen = true; }, rejectUpdate: () => { rejectUpdate = true; } };
}

it.each(['project', 'technology', 'host', 'tool', 'component', 'hosting'])('creates %s through a signed guided form and a separate in-place confirmation without AI', async kind => {
  const h = await harness();
  try {
    const project = await h.seed('project', { name: 'Parent' });
    const technology = await h.seed('technology', { name: 'React' });
    const host = await h.seed('host', { name: 'OVH' });
    const component = await h.seed('component', { name: 'API', projectId: project });
    const command = ({ project: 'projects', technology: 'technologies', host: 'hosts', tool: 'tools', component: `components ${project}`, hosting: `hosting ${component}` } as Record<string, string>)[kind];
    const label = ({ project: 'Ajouter un projet', technology: 'Ajouter une technologie', host: 'Ajouter un hébergeur/service', tool: 'Ajouter un outil', component: 'Ajouter un composant', hosting: 'Ajouter un hébergement' } as Record<string, string>)[kind]!;
    const list = await h.dm(`documentation ${command}`);
    const entry = await h.click(list, label), prepared = await h.click(entry, 'Préparer le formulaire');
    await h.click(prepared, 'Remplir le formulaire');
    const view = h.views.at(-1), data: Record<string, string | string[]> = kind === 'hosting' ? { environment: 'staging', serviceId: host } : { name: 'Créé par formulaire' };
    if (kind === 'component') data.technologies = [technology];
    if (kind === 'tool') { data.projects = [project]; data.companyWide = 'true'; }
    if (kind === 'host') { data.monthlyCost = '12,50'; data.currency = 'EUR'; }
    const before = (await sql.query('SELECT count(*)::int AS n FROM documentation_confirmations')).rows[0].n;
    expect((await h.submit(view, data)).json()).toEqual({});
    expect((await h.submit(view, data)).json()).toEqual({});
    expect((await sql.query("SELECT count(*)::int AS n FROM jobs WHERE payload->>'type'='guided_form'")).rows[0].n).toBe(1);
    expect((await sql.query('SELECT count(*)::int AS n FROM documentation_confirmations')).rows[0].n).toBe(before);
    const proposal = await h.drain();
    expect(proposal.ts).toBe(list.ts); expect(proposal.method).toBe('chat.update');
    const control = h.buttons(proposal).find(button => /:confirm_create/.test(button.action_id));
    const saved = (await sql.query('SELECT * FROM documentation_confirmations WHERE id=$1', [control.value])).rows[0];
    expect(saved.applied_at).toBeNull();
    const result = await h.click(proposal, 'Confirmer la création');
    expect(result.ts).toBe(list.ts);
    expect((await sql.query('SELECT applied_at FROM documentation_confirmations WHERE id=$1', [control.value])).rows[0].applied_at).not.toBeNull();
    expect((await sql.query('SELECT count(*)::int AS n FROM ai_calls')).rows[0].n).toBe(0);
    expect(h.provider).toHaveBeenCalledTimes(1);
    const detail = await h.dm(`documentation ${kind === 'hosting' ? 'hosting-entry' : kind} ${saved.target_id}`);
    await h.click(await h.click(await h.click(detail, 'Modifier'), 'Préparer le formulaire'), 'Remplir le formulaire');
    const editView = h.views.at(-1), editedField = kind === 'hosting' ? 'environment' : 'name';
    expect(editView.blocks.find((block: any) => block.block_id === editedField).element.initial_value).toBe(data[editedField]);
    if (['component', 'hosting'].includes(kind)) expect(editView.blocks.some((block: any) => block.block_id === (kind === 'component' ? 'projectId' : 'componentId'))).toBe(false);
    expect((await h.submit(editView, { [editedField]: 'Révisé' })).json()).toEqual({});
    const edit = await h.drain();
    expect(edit.ts).toBe(detail.ts);
    const editControl = h.buttons(edit).find(button => /:confirm_edit/.test(button.action_id));
    expect((await sql.query('SELECT fields FROM documentation_confirmations WHERE id=$1', [editControl.value])).rows[0].fields).toEqual({ [editedField]: 'Révisé' });
    const changed = await h.click(edit, 'Confirmer la modification');
    expect(changed.ts).toBe(detail.ts);
  } finally { await h.app.close(); }
});

it('edits only changed inventory fields, preserves concurrent edits, and rejects foreign choices and owners', async () => {
  const h = await harness();
  try {
    const id = await h.seed('project', { name: 'Alpha', description: 'Avant', notes: 'Initiales' });
    const detail = await h.dm(`documentation project ${id}`);
    const prepared = await h.click(await h.click(detail, 'Modifier'), 'Préparer le formulaire');
    await h.click(prepared, 'Remplir le formulaire');
    const view = h.views.at(-1);
    expect((await h.submit(view, { description: 'Après' }, bob)).json().response_action).toBe('errors');
    expect((await h.submit(view)).json().response_action).toBe('errors');
    await h.click(await h.dm(`documentation edit project ${id} {"notes":"Autre utilisateur"}`, bob), 'Confirmer la modification', bob);
    expect((await h.submit(view, { description: 'Après' })).json()).toEqual({});
    const proposal = await h.drain();
    expect(proposal.ts).toBe(detail.ts);
    const control = h.buttons(proposal).find(button => /:confirm_edit/.test(button.action_id));
    expect((await sql.query('SELECT fields FROM documentation_confirmations WHERE id=$1', [control.value])).rows[0].fields).toEqual({ description: 'Après' });
    await h.click(proposal, 'Confirmer la modification');
    expect((await sql.query('SELECT fields FROM documentation_projects WHERE id=$1', [id])).rows[0].fields).toMatchObject({ description: 'Après', notes: 'Autre utilisateur' });
    const list = await h.dm('documentation tools');
    await h.click(await h.click(await h.click(list, 'Ajouter un outil'), 'Préparer le formulaire'), 'Remplir le formulaire');
    const toolView = h.views.at(-1);
    expect((await h.submit(toolView, { name: 'Tool', projects: [randomUUID()] })).json().errors.projects).toBeTruthy();
    const suggest = (actor = alice) => h.signed('/slack/actions', { type: 'block_suggestion', team: { id: actor.team }, user: { id: actor.user }, block_id: 'projects', action_id: 'value', value: 'Alpha', view: toolView });
    expect((await suggest()).json().options[0].value).toBe(id);
    expect((await suggest(bob)).json().options).toEqual([]);
    await sql.query("UPDATE documentation_guided_forms SET created_at=now()-interval '25 hours' WHERE id=$1", [toolView.private_metadata]);
    expect((await h.submit(toolView, { name: 'Tool' })).json().response_action).toBe('errors');
  } finally { await h.app.close(); }
});

it('creates and edits Mail rules with no paid interpretation, separate approval and in-place replies', async () => {
  const h = await harness();
  try {
    const main = await h.click(await h.dm('menu'), 'Tri des e-mails');
    expect(main.text).toContain('Prochaine étape : connectez Gmail');
    const prepared = await h.click(await h.click(main, 'Gérer les règles'), 'Ajouter une règle');
    await h.click(prepared, 'Règle par expéditeur');
    const view = h.views.at(-1), values = { name: 'Projet Alpha', condition: 'Expéditeur du projet', senders_0: 'alice@example.com', labels: 'Alpha', example0: 'Message du projet : conserver' };
    expect((await h.submit(view, { ...values, senders_0: 'invalid' })).json().response_action).toBe('errors');
    expect((await h.submit(view, values)).json()).toEqual({});
    const proposal = await h.drain(), store = new Store(sql);
    expect(proposal.ts).toBe(main.ts); expect((await store.load(alice)).rules).toHaveLength(0);
    await h.click(proposal, 'Approuver les règles');
    const rule = (await store.load(alice)).rules[0]!;
    expect(rule.name).toBe(values.name);
    const rules = await h.click(await h.click(await h.dm('menu'), 'Tri des e-mails'), 'Gérer les règles');
    await h.click(await h.click(rules, 'Modifier 1'), 'Règle par expéditeur');
    expect((await h.submit(h.views.at(-1), { condition: 'Condition révisée' })).json()).toEqual({});
    const edit = await h.drain();
    expect(edit.ts).toBe(rules.ts);
    await h.click(edit, 'Approuver les règles');
    expect((await store.load(alice)).rules[0]).toMatchObject({ id: rule.id, condition: 'Condition révisée' });
    expect((await sql.query('SELECT count(*)::int AS n FROM ai_calls')).rows[0].n).toBe(0);
  } finally { await h.app.close(); }
});

it('recovers an uncertain form opening on the original card and never submits twice', async () => {
  const h = await harness();
  try {
    const prepared = await h.click(await h.click(await h.click(await h.dm('menu'), 'Tri des e-mails'), 'Gérer les règles'), 'Ajouter une règle');
    h.rejectOpen();
    const notice = await h.click(prepared, 'Règle par expéditeur');
    expect(notice.ts).toBe(prepared.ts); expect(notice.text).toContain('Ouverture non confirmée');
    await h.click(notice, 'Règle par expéditeur');
    const view = h.views.at(-1), data = { name: 'Test', condition: 'Adresse exacte', senders_0: 'a@example.com', example0: 'Conserver' };
    expect((await h.submit(view, data)).json()).toEqual({});
    expect((await h.submit(view, { ...data, name: 'Changed' })).json().response_action).toBe('errors');
    await h.drain();
    expect((await new Store(sql).load(alice)).drafts).toHaveLength(1);
    expect((await new Store(sql).load(alice)).rules).toHaveLength(0);
  } finally { await h.app.close(); }
});

it('offers tailored Mail forms and changes rule type only after a separate approval', async () => {
  const h = await harness();
  try {
    const prepared = await h.click(await h.click(await h.click(await h.dm('menu'), 'Tri des e-mails'), 'Gérer les règles'), 'Ajouter une règle');
    await h.click(prepared, 'Règle par contenu');
    const view = h.views.at(-1);
    expect(view.blocks.some((block: any) => block.block_id?.startsWith('senders_') || block.block_id === 'kind')).toBe(false);
    const data = { name: 'Factures', condition: 'Factures à conserver', example0: 'Facture du fournisseur' };
    expect((await h.submit(view, { ...data, example0: '' })).json().response_action).toBe('errors');
    expect((await h.submit(view, data)).json()).toEqual({});
    const store = new Store(sql), proposal = await h.drain();
    expect((await store.load(alice)).rules).toHaveLength(0);
    await h.click(proposal, 'Approuver les règles');
    const rule = (await store.load(alice)).rules[0]!;
    expect(rule).toMatchObject({ kind: 'semantic', senders: [] });
    const rules = await h.click(await h.click(await h.dm('menu'), 'Tri des e-mails'), 'Gérer les règles');
    const edit = await h.click(rules, 'Modifier 1');
    expect(h.buttons(edit).filter(button => button.action_id.startsWith('mail:form_open')).map(button => button.text.text)).toEqual(['Règle par contenu', 'Règle par expéditeur']);
    await h.click(edit, 'Règle par expéditeur');
    const senderView = h.views.at(-1);
    expect(senderView.blocks.some((block: any) => block.block_id === 'senders_0')).toBe(true);
    expect(senderView.blocks.some((block: any) => block.block_id === 'kind')).toBe(false);
    expect((await h.submit(senderView, {})).json().response_action).toBe('errors');
    expect((await h.submit(senderView, { senders_0: 'billing@example.com' })).json()).toEqual({});
    const change = await h.drain();
    expect((await store.load(alice)).rules[0]).toEqual(rule);
    await h.click(change, 'Approuver les règles');
    expect((await store.load(alice)).rules[0]).toMatchObject({ id: rule.id, kind: 'sender', senders: ['billing@example.com'] });
    const senderRules = await h.click(await h.click(await h.dm('menu'), 'Tri des e-mails'), 'Gérer les règles');
    await h.click(await h.click(senderRules, 'Modifier 1'), 'Règle par contenu');
    expect(h.views.at(-1).blocks.some((block: any) => block.block_id?.startsWith('senders_'))).toBe(false);
    expect((await h.submit(h.views.at(-1), {})).json()).toEqual({});
    await h.click(await h.drain(), 'Approuver les règles');
    expect((await store.load(alice)).rules[0]).toMatchObject({ id: rule.id, kind: 'semantic', senders: [] });
    expect((await sql.query('SELECT count(*)::int AS n FROM ai_calls')).rows[0].n).toBe(0);
    expect(h.provider.mock.calls.every(([url]) => String(url).endsWith('/views.open'))).toBe(true);
  } finally { await h.app.close(); }
});

it('accepts a still-valid Mail form prepared before tailored forms were introduced', async () => {
  const h = await harness();
  try {
    const prepared = await h.click(await h.click(await h.click(await h.dm('menu'), 'Tri des e-mails'), 'Gérer les règles'), 'Ajouter une règle');
    const row = (await sql.query("SELECT id,definition FROM mail_guided_forms WHERE definition->'context'->>'kind'='sender'")).rows[0];
    delete row.definition.context.kind;
    row.definition.fields.push({ key: 'kind', label: 'Comment reconnaître les messages ?', kind: 'choice', required: true,
      choices: [{ label: 'Adresses exactes', value: 'sender' }, { label: 'Analyse du contenu', value: 'semantic' }], initial: 'sender' });
    await sql.query('UPDATE mail_guided_forms SET definition=$2 WHERE id=$1', [row.id, JSON.stringify(row.definition)]);
    await h.click(prepared, 'Règle par expéditeur');
    expect((await h.submit(h.views.at(-1), { name: 'Ancien formulaire', condition: 'Adresse exacte', senders_0: 'a@example.com', example0: 'Conserver' })).json()).toEqual({});
    const proposal = await h.drain(), store = new Store(sql);
    expect((await store.load(alice)).rules).toHaveLength(0);
    await h.click(proposal, 'Approuver les règles');
    expect((await store.load(alice)).rules[0]).toMatchObject({ kind: 'sender', senders: ['a@example.com'] });
  } finally { await h.app.close(); }
});

it('preserves full URL lists and untouched empty values while editing a long inventory record', async () => {
  const h = await harness();
  try {
    const urls = Array.from({ length: 10 }, (_, index) => `https://example.com/${index}/${'x'.repeat(index === 6 ? 10 : 365)}`);
    const id = await h.seed('project', { name: 'Large', description: '', repositories: urls, documentationLinks: [] });
    const detail = await h.dm(`documentation project ${id}`);
    await h.click(await h.click(await h.click(detail, 'Modifier'), 'Préparer le formulaire'), 'Remplir le formulaire');
    const view = h.views.at(-1), fields = view.blocks.filter((block: any) => block.block_id?.startsWith('repositories_'));
    expect(fields.flatMap((block: any) => block.element.initial_value.split('\n'))).toEqual(urls);
    expect(fields.every((block: any) => block.element.initial_value.length <= block.element.max_length)).toBe(true);
    expect((await h.submit(view, { name: 'Renamed' })).json()).toEqual({});
    await h.click(await h.drain(), 'Confirmer la modification');
    expect((await sql.query('SELECT fields FROM documentation_projects WHERE id=$1', [id])).rows[0].fields).toMatchObject({ name: 'Renamed', description: '', repositories: urls, documentationLinks: [] });
  } finally { await h.app.close(); }
});

it('captures form input and its job atomically, then reopens the saved proposal after a rejected reply', async () => {
  const h = await harness();
  try {
    const prepared = await h.click(await h.click(await h.click(await h.dm('menu'), 'Tri des e-mails'), 'Gérer les règles'), 'Ajouter une règle');
    await h.click(prepared, 'Règle par expéditeur');
    const view = h.views.at(-1), data = { name: 'Test', condition: 'Adresse exacte', senders_0: 'a@example.com', example0: 'Conserver' };
    await db.exec("ALTER TABLE jobs ADD CONSTRAINT reject_guided_test CHECK (payload->>'type' IS DISTINCT FROM 'guided_form')");
    try {
      expect((await h.submit(view, data)).statusCode).toBeGreaterThanOrEqual(400);
      expect((await sql.query('SELECT state FROM mail_guided_forms')).rows[0].state).toBe('editing');
    } finally { await db.exec('ALTER TABLE jobs DROP CONSTRAINT reject_guided_test'); }
    expect((await h.submit(view, data)).json()).toEqual({});
    h.rejectUpdate();
    const failed = await h.drain();
    expect(failed.text).toContain('Cette demande n’a pas pu aboutir');
    const pending = await h.click(await h.click(await h.click(failed, 'Menu'), 'Tri des e-mails'), 'Approbations en attente');
    const result = await h.click(pending, 'Ouvrir 1');
    expect(result.ts).toBe(prepared.ts);
    expect(h.buttons(result).some(button => button.text.text === 'Approuver les règles')).toBe(true);
    expect((await new Store(sql).load(alice)).drafts).toHaveLength(1);
    expect(h.messages.filter(message => message.method === 'chat.postMessage')).toHaveLength(1);
  } finally { await h.app.close(); }
});

it('rejects copied form buttons and stale Mail edits without overwriting a newer rule', async () => {
  const h = await harness();
  try {
    const store = new Store(sql), state = await store.load(alice);
    state.rules = [{ id: 'rule', name: 'Original', kind: 'sender', category: 'custom', condition: 'Adresse', senders: ['a@example.com'], labels: [], action: 'keep', examples: ['Conserver'] }];
    await store.save(alice, state);
    const prepared = await h.click(await h.click(await h.click(await h.dm('menu'), 'Tri des e-mails'), 'Gérer les règles'), 'Modifier 1');
    await h.click({ ...prepared, ts: '999.999' }, 'Règle par expéditeur');
    await h.click(prepared, 'Règle par expéditeur', bob);
    expect(h.provider).not.toHaveBeenCalled();
    await h.click(prepared, 'Règle par expéditeur');
    state.rules[0]!.name = 'Newer'; await store.save(alice, state);
    expect((await h.submit(h.views.at(-1), { name: 'Stale' })).json()).toEqual({});
    const rejected = await h.drain();
    expect(rejected.ts).toBe(prepared.ts); expect(rejected.text).toContain('règle modifiée');
    const current = await store.load(alice);
    expect(current.drafts).toHaveLength(0); expect(current.rules[0]!.name).toBe('Newer');
  } finally { await h.app.close(); }
});
