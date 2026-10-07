import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readConfig } from '../src/app/config.js';
import { createModules } from '../src/app/modules.js';
import { schema } from '../src/app/schema.js';
import { dispatchJob } from '../src/core/dispatch.js';
import { createServer } from '../src/core/server.js';
import { ModuleRegistry, type AssistantModule } from '../src/core/modules.js';
import { Slack } from '../src/core/slack.js';
import { Navigation } from '../src/core/navigation.js';
import { Vault } from '../src/core/crypto.js';
import { JobStore, type Sql } from '../src/core/store.js';
import { Store } from '../src/modules/mail/store.js';
import { starterRules, type Run } from '../src/modules/mail/domain.js';

const alice = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
const bob = { ...alice, user: 'UBOB', channel: 'DBOB' };
const env = { PUBLIC_URL: 'https://agent.example.com', DATABASE_URL: 'postgresql://unused', SLACK_TEAM_ID: 'TTEAM', SLACK_BOT_TOKEN: 'token', SLACK_SIGNING_SECRET: 'secret', ENABLED_MODULES: 'slack' };
const mailEnv = { ...env, ENABLED_MODULES: 'mail,slack', ENCRYPTION_KEY: randomBytes(32).toString('base64'), GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_WORKSPACE_DOMAINS: 'example.com', OPENAI_API_KEY: 'unused' };
let db: PGlite, sql: Sql;
beforeAll(async () => { db = new PGlite(); await db.exec(schema); sql = { query: (text, values) => db.query(text, values) }; });
beforeEach(async () => {
  await db.exec('TRUNCATE users,jobs,oauth_states,ai_calls,ai_months,core_navigation_menus,core_navigation_deliveries,core_operation_slots CASCADE; DROP TABLE IF EXISTS slack_selected_channels,slack_handled_events,slack_ai_attempts,slack_unanswered_results');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external provider call'); }));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => db.close());

type Posted = { method: string; body: any; ts: string };
function blocks(message: Posted) { return message.body.blocks.flatMap((block: any) => block.type === 'container' ? [block, ...block.child_blocks] : [block]); }
function buttons(message: Posted) { return blocks(message).filter((block: any) => block.type === 'actions').flatMap((block: any) => block.elements); }
function title(message: Posted) { return message.body.blocks[0]?.title?.text; }
function richParts(message: Posted) { return blocks(message).filter((block: any) => block.type === 'rich_text').flatMap((block: any) => block.elements.flatMap((section: any) => section.elements)); }
function renderedText(message: Posted) { return richParts(message).map((part: any) => part.text ?? '').join(''); }
function findButton(message: Posted, label: string) { return buttons(message).find((item: any) => item.text.text.replace(/^🧭 /, '') === label); }
function button(message: Posted, label: string) { const found = findButton(message, label); expect(found, `${label}; available: ${buttons(message).map((item: any) => item.text.text).join(', ')}`).toBeTruthy(); return found; }
async function harness(overrides: NodeJS.ProcessEnv = env, additionalModules: AssistantModule[] = []) {
  const config = readConfig(overrides), modules = new ModuleRegistry([...createModules(config, sql, overrides).all(), ...additionalModules]);
  for (const module of modules.all()) await module.initialize?.({ query: async (text, values) => values ? db.query(text, values) : (await db.exec(text)).at(-1)! });
  const app = createServer(config, new JobStore(sql), modules);
  const messages: Posted[] = [];
  const selectedControls = new WeakMap<Posted, Map<string, any>>();
  let failure: 'reject' | 'uncertain' | undefined;
  const slack = new Slack('token', (async (url, options) => {
    const method = String(url).split('/').at(-1)!;
    expect(['chat.postMessage', 'chat.update']).toContain(method);
    const outcome = failure; failure = undefined;
    if (outcome === 'reject') return Response.json({ ok: false, error: 'ratelimited' });
    const body = JSON.parse(String(options?.body)), ts = body.ts ?? `${Date.now()}.${messages.length + 1}`;
    messages.push({ method, body, ts });
    if (outcome === 'uncertain') throw new Error('Connection lost after delivery');
    return Response.json({ ok: true, channel: body.channel, ts });
  }) as typeof fetch);
  const post = (path: string, raw: string, type: string, signature = true) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return app.inject({ method: 'POST', url: path, payload: raw, headers: { 'content-type': type, 'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature ? `v0=${createHmac('sha256', 'secret').update(`v0:${timestamp}:${raw}`).digest('hex')}` : 'bad' } });
  };
  const drain = async () => {
    const jobs = (await sql.query("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,id")).rows;
    for (const job of jobs) { await dispatchJob(sql, config, modules, slack, job); await new JobStore(sql).complete(job.id); }
    return messages.at(-1)!;
  };
  const dm = async (text: string, actor = alice) => {
    expect((await post('/slack/events', JSON.stringify({ type: 'event_callback', team_id: actor.team, event_id: randomUUID(), event: { type: 'message', channel_type: 'im', user: actor.user, channel: actor.channel, text } }), 'application/json')).statusCode).toBe(200);
    return drain();
  };
  const submit = async (source: Posted, selected: any, actor: typeof alice, ts: string, clickId: string) => {
    const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: actor.team }, user: { id: actor.user }, channel: { id: actor.channel }, message: { ts }, actions: [{ action_id: selected.action_id, value: selected.value, action_ts: clickId }] }) }).toString();
    expect((await post('/slack/actions', raw, 'application/x-www-form-urlencoded')).statusCode).toBe(200);
    return drain();
  };
  const seek = async (source: Posted, label: string, actor = alice) => {
    let current = source;
    for (let step = 0; step < 40 && !findButton(current, label) && findButton(current, 'Actions ▶'); step++) {
      current = await submit(current, button(current, 'Actions ▶'), actor, current.ts, randomUUID());
    }
    for (let step = 0; step < 40 && !findButton(current, label) && findButton(current, '◀ Actions'); step++) {
      current = await submit(current, button(current, '◀ Actions'), actor, current.ts, randomUUID());
    }
    button(current, label);
    return current;
  };
  const click = async (source: Posted, label: string, actor = alice, ts = source.ts, clickId = randomUUID()) => {
    let selected = selectedControls.get(source)?.get(label);
    if (!selected) {
      const current = await seek(source, label, actor);
      selected = button(current, label);
      const cached = selectedControls.get(source) ?? new Map<string, any>();
      cached.set(label, selected);
      selectedControls.set(source, cached);
    }
    return submit(source, selected, actor, ts, clickId);
  };
  return { dm, click, seek, messages, post, drain, get: (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} }), failNext: (outcome: 'reject' | 'uncertain') => { failure = outcome; }, close: () => app.close() };
}

it('discovers enabled modules and shared commands in a private main menu without Gmail or AI', async () => {
  const h = await harness();
  try {
    for (const command of ['menu', 'hello', 'hi', 'bonjour', 'salut']) {
      const menu = await h.dm(command);
      expect(menu.body.channel).toBe('DALICE');
      expect(menu.body.blocks[0].width).toBe('full');
      expect(buttons(menu).map((item: any) => item.text.text)).toEqual(["Messages Slack sans réponse", 'Budget', "Aide"]);
      expect(buttons(menu).every((item: any) => item.style === undefined)).toBe(true);
      expect(blocks(menu).filter((block: any) => block.type === 'actions')).toHaveLength(1);
      expect(new Set(buttons(menu).map((item: any) => item.action_id)).size).toBe(3);
    }
    const guidance = await h.dm('sort');
    expect(guidance.body.text).toContain("préfixe");
    button(guidance, 'Menu');
  } finally { await h.close(); }
});

it('opens complete built-in help through signed DM dispatch without connections, provider work or domain changes', async () => {
  const allEnv = { ...mailEnv, ENABLED_MODULES: 'mail,slack,documentation,clickup,yousign,development',
    CLICKUP_CLIENT_ID: 'client', CLICKUP_CLIENT_SECRET: 'secret', CLICKUP_WORKSPACE_ID: '123',
    YOUSIGN_WEBHOOK_SECRET: 'fake-webhook-secret', YOUSIGN_SUBSCRIPTION_ID: 'subscription', SLACK_ADMIN_USER_ID: 'UADMIN',
    DEVELOPMENT_CLICKUP_TOKEN: 'fake', DEVELOPMENT_WORKER_TOKEN: 'fake-worker-token'.repeat(3),
  };
  const h = await harness(allEnv);
  try {
    // Startup schedules Development polling; this test exercises only User help jobs.
    await sql.query('DELETE FROM jobs');
    const guide = await h.dm('aide');
    expect(title(guide)).toBe('Aide — guide de l’assistant');
    expect(guide.body.text).toContain('plafond mensuel');
    expect(guide.body.text).toContain('préfixe');
    expect(title(await h.dm('help'))).toBe(title(guide));
    const capabilities = [
      ['courrier', 'Tri des e-mails', '100 derniers messages', 'Annuler ce traitement'],
      ['slack', 'Messages Slack sans réponse', '48 heures', 'Vous concerne peut-être'],
      ['documentation', 'Documentation', 'six types de fiches', 'documentation compter'],
      ['clickup', 'ClickUp', 'directement assignées', 'clickup statuts'],
      ['yousign', 'Yousign', 'destinations sont partagées', 'Confirmer cette relance'],
      ['development', 'Développement', 'Ready for AI', 'development relancer'],
    ];
    for (const [prefix, name, capability, other] of capabilities) {
      const clicked = await h.click(guide, `Aide : ${name}`);
      expect(clicked.method).toBe('chat.update');
      expect(clicked.ts).toBe(guide.ts);
      expect(renderedText(clicked)).toContain(capability);
      expect(renderedText(clicked)).toContain(other);
      for (const text of [prefix!, `${prefix} aide`, `${prefix} help`]) {
        const direct = await h.dm(text);
        expect(renderedText(direct)).toBe(renderedText(clicked));
      }
      const menu = await h.click(clicked, 'Ouvrir le module');
      const help = await h.click(menu, name === 'Documentation' ? 'Aide' : 'Aide du module');
      expect(renderedText(help)).toBe(renderedText(clicked));
    }
    const documentation = await h.dm('documentation aide');
    const fields = await h.click(documentation, 'Hébergements : commandes et champs');
    expect(fields.ts).toBe(documentation.ts);
    expect(fields.body.text).toContain('serviceId');
    expect(fields.body.text).toContain('confirmation séparée');
    const back = await h.click(fields, 'Retour à l’aide du module');
    const query = await h.click(back, 'Rechercher et compter');
    expect(query.body.text).toContain('same-component');
    expect(query.body.text).toContain('documentation compter');
    expect((await h.click(query, 'Retour à l’aide')).body.text).toContain('Commandes communes');
    expect((await h.dm('mail aide')).body.text).toBe((await h.dm('courrier aide')).body.text);
    expect((await sql.query('SELECT * FROM users')).rows).toHaveLength(0);
    expect((await sql.query('SELECT * FROM ai_calls')).rows).toHaveLength(0);
    expect((await sql.query('SELECT * FROM core_operation_slots')).rows).toHaveLength(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it('keeps long static help and topics private and pages them without invoking module handlers or menus', async () => {
  const handle = vi.fn(), menu = vi.fn();
  const probe: AssistantModule = { id: 'probe', name: 'Module test', description: 'Guide test', handle, menu,
    help: { text: `${'A'.repeat(9_500)}\n${'B'.repeat(9_500)}`, topics: [{ label: 'Exemple', text: 'Explication complète du parcours.' }] },
  };
  const h = await harness(env, [probe]);
  try {
    const first = await h.dm('probe help');
    const second = await h.click(first, 'Suivant');
    expect(second.method).toBe('chat.update');
    expect(second.ts).toBe(first.ts);
    expect(renderedText(second)).toContain('B'.repeat(9_500));
    const privatePage = await h.click(second, 'Exemple', bob);
    expect(privatePage.body.text).toContain('indisponible');
    expect(privatePage.body.text).not.toContain('Explication complète');
    const topic = await h.click(second, 'Exemple');
    expect(topic.ts).toBe(first.ts);
    expect(topic.body.text).toContain('Explication complète');
    expect(renderedText(await h.click(topic, 'Retour à l’aide du module'))).toContain('A'.repeat(9_500));
    expect(handle).not.toHaveBeenCalled();
    expect(menu).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it('hides disabled modules from help and refuses their older help links after a restart', async () => {
  const first = await harness();
  const guide = await first.dm('aide');
  const module = await first.click(guide, 'Aide : Messages Slack sans réponse');
  await first.close();
  const h = await harness({ ...env, ENABLED_MODULES: '' });
  try {
    const empty = await h.dm('aide');
    expect(empty.body.text).toContain('Aucun module');
    expect(buttons(empty).map((item: any) => item.text.text.replace(/^🧭 /, ''))).toEqual(['Retour au menu']);
    expect((await h.click(guide, 'Aide : Messages Slack sans réponse')).body.text).toContain('n’est pas activé');
    expect((await h.click(module, 'Ouvrir le module')).body.text).toContain('n’est pas activé');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it('shows every enabled destination on the main menu without action paging', async () => {
  const names = Array.from({ length: 7 }, (_, index) => `Module de démonstration ${index + 1}`);
  const modules: AssistantModule[] = names.map((name, index) => ({
    id: `fixture_${index + 1}`, name, description: name, async handle() {},
  }));
  const h = await harness(env, modules);
  try {
    const menu = await h.dm('menu');
    expect(buttons(menu).map((item: any) => item.text.text)).toEqual([
      'Messages Slack sans réponse', ...names, 'Budget', 'Aide',
    ]);
    expect(findButton(menu, 'Actions ▶')).toBeUndefined();
    expect(blocks(menu).filter((block: any) => block.type === 'actions').map((block: any) => block.elements.length)).toEqual([5, 5]);
    const opened = await h.click(menu, names.at(-1)!);
    expect(opened.method).toBe('chat.update');
    expect(opened.ts).toBe(menu.ts);
    expect(title(opened)).toBe(names.at(-1));
  } finally { await h.close(); }
});

it('namespaces and binds module-menu table actions through signed dispatch', async () => {
  const fixture: AssistantModule = { id: 'table_fixture', name: 'Table fixture', description: 'Table controls', menuActions: ['toggle'],
    async menu() { return { kind: 'Table fixture', text: 'Choix', bindButtons: true,
      table: { columns: ['Nom'], rows: [['Active']], rowButtons: [{ label: '☑ Retirer', action: 'toggle', value: 'Active' }], rowButtonColumn: 'Sélection' },
    }; },
    async handle(actor, payload, eventId, context) {
      expect(payload.type).toBe('menu_action'); expect(payload.action).toBe('toggle');
      const bound = await new Navigation(context.sql, context.messenger).boundTarget(actor, payload.value, payload.timestamp);
      expect(bound?.value).toBe('Active');
      await context.messenger.send(actor, { text: `Modification enregistrée : ${bound!.value}` });
    },
  };
  const h = await harness(env, [fixture]);
  try {
    const menu = await h.dm('menu'), page = await h.click(menu, 'Table fixture');
    const control = page.body.blocks.find((block: any) => block.type === 'data_table').rows[1][1].element;
    expect(control.action_id).toMatch(/^table_fixture:toggle~button-\d+$/);
    const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: alice.team }, user: { id: alice.user }, channel: { id: alice.channel }, message: { ts: page.ts },
      actions: [{ action_id: control.action_id, value: control.value, action_ts: randomUUID() }],
    }) }).toString();
    expect((await h.post('/slack/actions', raw, 'application/x-www-form-urlencoded')).statusCode).toBe(200);
    expect((await h.drain()).body.text).toContain('Modification enregistrée : Active');
  } finally { await h.close(); }
});

it('shows ordinary workflow controls together and pages only unusually large choice sets', async () => {
  const compact: AssistantModule = { id: 'compact', description: 'Compact controls fixture',
    async handle(actor, _payload, _eventId, context) {
      await context.messenger.send(actor, { kind: 'Choix', text: 'Choisissez une action.',
        buttons: Array.from({ length: 6 }, (_, index) => ({ label: `Choix ${index + 1}`, action: 'choose', value: String(index) })) });
    } };
  const wide: AssistantModule = { id: 'wide', description: 'Wide controls fixture',
    async handle(actor, _payload, _eventId, context) {
      await context.messenger.send(actor, { kind: 'Choix', text: 'Choisissez une action.',
        buttons: Array.from({ length: 7 }, (_, index) => ({ label: `Examiner le dossier ${index + 1}`, action: 'choose', value: String(index) })) });
    } };
  const many: AssistantModule = { id: 'many', description: 'Large controls fixture',
    async handle(actor, _payload, _eventId, context) {
      await context.messenger.send(actor, { kind: 'Choix', text: 'Choisissez une action.',
        buttons: Array.from({ length: 21 }, (_, index) => ({ label: `Choix ${index + 1}`, action: 'choose', value: String(index) })) });
    } };
  const twenty: AssistantModule = { id: 'twenty', description: 'Visible controls fixture',
    async handle(actor, _payload, _eventId, context) {
      await context.messenger.send(actor, { kind: 'Choix', text: 'Choisissez une action.',
        buttons: Array.from({ length: 20 }, (_, index) => ({ label: `Choix ${index + 1}`, action: 'choose', value: String(index) })) });
    } };
  const h = await harness(env, [compact, wide, twenty, many]);
  try {
    const short = await h.dm('compact');
    expect(buttons(short).map((item: any) => item.text.text)).toEqual(Array.from({ length: 6 }, (_, index) => `Choix ${index + 1}`));
    expect(blocks(short).filter((block: any) => block.type === 'actions').map((block: any) => block.elements.length)).toEqual([5, 1]);
    const widePage = await h.dm('wide');
    expect(buttons(widePage).map((item: any) => item.text.text)).toEqual(Array.from({ length: 7 }, (_, index) => `Examiner le dossier ${index + 1}`));
    expect(blocks(widePage).filter((block: any) => block.type === 'actions').map((block: any) => block.elements.length)).toEqual([5, 2]);
    const visible = await h.dm('twenty');
    expect(buttons(visible).map((item: any) => item.text.text)).toEqual(Array.from({ length: 20 }, (_, index) => `Choix ${index + 1}`));
    expect(blocks(visible).filter((block: any) => block.type === 'actions').map((block: any) => block.elements.length)).toEqual([5, 5, 5, 5]);
    expect(findButton(visible, 'Actions ▶')).toBeUndefined();
    const first = await h.dm('many');
    let page = first;
    const labels: string[] = [];
    for (let index = 0; index < 20; index++) {
      labels.push(...buttons(page).map((item: any) => item.text.text.replace(/^🧭 /, '')).filter((label: string) => label.startsWith('Choix')));
      if (!findButton(page, 'Actions ▶')) break;
      page = await h.click(page, 'Actions ▶');
      expect(page.method).toBe('chat.update');
      expect(page.ts).toBe(first.ts);
      button(page, '◀ Actions');
    }
    expect(labels).toEqual(Array.from({ length: 21 }, (_, index) => `Choix ${index + 1}`));
    expect(h.messages.filter(message => message.method === 'chat.postMessage')).toHaveLength(4);
  } finally { await h.close(); }
});

it('requests new Mail explanations in French and reopens a retained English proposal without translating or renewing it', async () => {
  const h = await harness(mailEnv);
  const original = { name: 'Old English name', kind: 'sender' as const, category: 'project' as const, condition: 'Original English condition', senders: ['alex@example.com'], labels: ['Projects/Alpha'], action: 'keep' as const, examples: ['Alex matches', 'Bob does not'] };
  const requests: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    expect(new URL(url).hostname).toBe('api.openai.com');
    requests.push(JSON.parse(String(options?.body)));
    if (url.endsWith('/input_tokens')) return Response.json({ input_tokens: 100 });
    return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 40 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify({ intent: 'reply', reply: 'Décrivez la règle souhaitée.', rule: null, ruleId: null, runId: null, messageId: null, correction: null }) }] }] });
  }));
  try {
    expect((await h.dm('courrier Bonjour, aide-moi avec mes règles')).body.text).toBe('Décrivez la règle souhaitée.');
    expect(requests[0].instructions).toContain('Always write reply, new rule names, descriptions, examples and classification reasons in French');
    expect(JSON.parse(requests[0].input).text).toBe('Bonjour, aide-moi avec mes règles');
    const state = await new Store(sql).load(alice), created = new Date().toISOString();
    state.drafts.push({ id: 'legacy-proposal', kind: 'rules', created, rules: [original] });
    await new Store(sql).save(alice, state);
    const pending = await h.click(await h.click(await h.dm('menu'), 'Tri des e-mails'), 'Approbations en attente');
    const reopened = await h.click(pending, 'Ouvrir 1');
    expect(reopened.body.text).toContain('Texte enregistré avant le passage au français');
    expect(reopened.body.text).toContain(original.condition);
    expect(reopened.body.text).toContain(original.labels[0]);
    expect((await new Store(sql).load(alice)).drafts[0]).toEqual({ id: 'legacy-proposal', kind: 'rules', created, rules: [original] });
    expect(requests).toHaveLength(2);
  } finally { await h.close(); }
});

it('accepts a signed button callback when Slack omits its optional value', async () => {
  const h = await harness();
  try {
    const guidance = await h.dm('sort');
    const selected = button(guidance, 'Menu');
    const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: alice.team },
      user: { id: alice.user }, channel: { id: alice.channel }, actions: [{ action_id: selected.action_id, action_ts: randomUUID() }] }) }).toString();
    expect((await h.post('/slack/actions', raw, 'application/x-www-form-urlencoded')).statusCode).toBe(200);
    const menu = await h.drain();
    expect(title(menu)).toBe('Menu');
  } finally { await h.close(); }
});

it('starts menu work through the existing module handlers and explains missing prerequisites', async () => {
  const h = await harness(mailEnv);
  try {
    const main = await h.dm('menu');
    const mail = await h.click(main, "Tri des e-mails");
    expect(buttons(mail).every((item: any) => item.value === undefined || item.value.length > 0)).toBe(true);
    expect(button(mail, "Trier la boîte de réception").style).toBe('primary');
    const sorting = await h.click(mail, "Trier la boîte de réception");
    expect(sorting.method).toBe('chat.postMessage');
    expect(sorting.body.text).toContain("Connectez d’abord Gmail");
    button(sorting, 'Menu');
    const slack = await h.click(await h.click(mail, "Retour au menu"), "Messages Slack sans réponse");
    expect(buttons(slack).every((item: any) => item.value === undefined || item.value.length > 0)).toBe(true);
    expect(button(slack, "Chercher les messages sans réponse").style).toBe('primary');
    const search = await h.click(slack, "Chercher les messages sans réponse");
    expect(search.method).toBe('chat.postMessage');
    expect(search.body.text).toContain('Choisissez les sources');
    button(search, 'Menu');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it('runs one paid mail Preview from signed menu starts and keeps approval separate', async () => {
  const state = await new Store(sql).load(alice);
  state.connection = { id: 'connected', subject: 'alice', email: 'alice@example.com', encryptedTokens: new Vault(Buffer.from(mailEnv.ENCRYPTION_KEY, 'base64'))
    .seal({ access_token: 'fake', refresh_token: 'fake', expires_at: Date.now() + 3600_000 }, 'TTEAM:UALICE') };
  state.rules = [{ ...starterRules()[0]!, id: 'urgent' }];
  await new Store(sql).save(alice, state);
  let gmailLists = 0, paidCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = String(url);
    if (path.endsWith('messages?labelIds=INBOX&maxResults=100')) { gmailLists++; return Response.json({ messages: [{ id: 'm1' }] }); }
    if (path.endsWith('messages/m1?format=full')) return Response.json({ id: 'm1', historyId: '1', labelIds: ['INBOX'],
      payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'sender@example.com' }, { name: 'Subject', value: 'Need help today' }], body: { data: Buffer.from('Please reply today.').toString('base64url') } } });
    if (path.endsWith('/labels')) return Response.json({ labels: [] });
    if (path.endsWith('/responses/input_tokens')) return Response.json({ input_tokens: 100 });
    if (path.endsWith('/responses')) { paidCalls++; return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 50 },
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ matches: [{ ruleId: 'urgent', decision: 'yes', reason: 'Requires reply today' }] }) }] }] }); }
    throw new Error(`Unexpected provider call: ${path}`);
  }));
  const h = await harness(mailEnv);
  try {
    const mail = await h.click(await h.dm('menu'), "Tri des e-mails");
    const control = button(mail, "Trier la boîte de réception");
    for (let n = 0; n < 2; n++) {
      const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: alice.team }, user: { id: alice.user },
        channel: { id: alice.channel }, message: { ts: mail.ts }, actions: [{ action_id: control.action_id, value: control.value, action_ts: randomUUID() }] }) }).toString();
      expect((await h.post('/slack/actions', raw, 'application/x-www-form-urlencoded')).statusCode).toBe(200);
    }
    await h.drain();
    expect(gmailLists).toBe(1);
    expect(paidCalls).toBe(1);
    const preview = h.messages.find(message => title(message) === "Aperçu")!;
    expect(preview).toBeTruthy();
    button(preview, "Confirmer les modifications");
    button(preview, 'Menu');
    expect(h.messages.some(message => title(message) === "Traitement en cours")).toBe(true);
    expect((await new Store(sql).load(alice)).runs[0].status).toBe('preview');
  } finally { await h.close(); }
});

it('associates old-menu and typed duplicate starts with the original request even after it finishes', async () => {
  const h = await harness(mailEnv);
  try {
    const first = await h.click(await h.dm('menu'), "Tri des e-mails");
    const second = await h.click(await h.dm('menu'), "Tri des e-mails");
    const start = async (source: Posted) => {
      const selected = button(source, "Trier la boîte de réception");
      const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: alice.team }, user: { id: alice.user },
        channel: { id: alice.channel }, message: { ts: source.ts }, actions: [{ action_id: selected.action_id, value: selected.value, action_ts: randomUUID() }] }) }).toString();
      expect((await h.post('/slack/actions', raw, 'application/x-www-form-urlencoded')).statusCode).toBe(200);
    };
    const typed = async () => expect((await h.post('/slack/events', JSON.stringify({ type: 'event_callback', team_id: alice.team,
      event_id: randomUUID(), event: { type: 'message', channel_type: 'im', user: alice.user, channel: alice.channel, text: "courrier trier" } }), 'application/json')).statusCode).toBe(200);
    await start(first);
    await start(second);
    await typed();
    const pending = (await sql.query("SELECT id,module,payload FROM jobs WHERE status='queued' AND (module='mail' OR payload->>'type'='operation_busy') ORDER BY created_at,id")).rows;
    expect(pending.filter(job => job.module === 'mail')).toHaveLength(1);
    expect(pending.filter(job => job.payload.type === 'operation_busy')).toHaveLength(2);
    expect(new Set(pending.filter(job => job.payload.type === 'operation_busy').map(job => job.payload.original))).toEqual(new Set([pending.find(job => job.module === 'mail')!.id]));
    await h.drain();
    expect(h.messages.filter(message => message.body.text.includes("déjà en cours"))).toHaveLength(2);
    await typed();
    expect((await sql.query("SELECT count(*)::int AS count FROM jobs WHERE status='queued' AND module='mail'")).rows[0].count).toBe(1);
    const fresh = (await sql.query("SELECT id FROM jobs WHERE status='queued' AND module='mail'")).rows[0].id;
    await sql.query("UPDATE jobs SET status='running',attempts=1 WHERE id=$1", [fresh]);
    await new JobStore(sql).retryOrFail(fresh);
    await typed();
    expect((await sql.query("SELECT count(*)::int AS count FROM jobs WHERE module='core' AND payload->>'original'=$1", [fresh])).rows[0].count).toBe(1);
    await sql.query('UPDATE jobs SET attempts=5 WHERE id=$1', [fresh]);
    await new JobStore(sql).retryOrFail(fresh);
    await typed();
    expect((await sql.query("SELECT count(*)::int AS count FROM jobs WHERE module='mail' AND status='queued'")).rows[0].count).toBe(1);
  } finally { await h.close(); }
});

it('keeps a natural-language sort tied to work active at receipt after later intent resolution', async () => {
  const h = await harness(mailEnv);
  try {
    const postText = async (text: string) => {
      const id = randomUUID();
      expect((await h.post('/slack/events', JSON.stringify({ type: 'event_callback', team_id: alice.team, event_id: id,
        event: { type: 'message', channel_type: 'im', user: alice.user, channel: alice.channel, text } }), 'application/json')).statusCode).toBe(200);
      return `slack:${id}`;
    };
    const original = await postText('mail sort');
    const natural = await postText('mail please sort my inbox now');
    expect((await sql.query('SELECT payload FROM jobs WHERE id=$1', [natural])).rows[0].payload.activeOperation).toBe(original);
    await sql.query("UPDATE jobs SET payload=jsonb_set(payload,'{resolved}',$2::jsonb) WHERE id=$1", [natural,
      JSON.stringify({ intent: 'sort', reply: '', rule: null, ruleId: null, runId: null, messageId: null, correction: null })]);
    await h.drain();
    expect(h.messages.some(message => message.body.text.includes(`Demande existante : ${original}`))).toBe(true);
    expect((await new Store(sql).load(alice)).runs).toHaveLength(0);
  } finally { await h.close(); }
});

it('updates only the clicked menu, checks ownership and keeps module selection out of typed routing', async () => {
  const h = await harness();
  try {
    const first = await h.dm('menu'), second = await h.dm('menu');
    const module = await h.click(first, "Messages Slack sans réponse");
    expect(module.method).toBe('chat.update');
    expect(module.body.blocks[0].width).toBe('full');
    expect(module.ts).toBe(first.ts);
    expect(module.body.text).toContain("slack canaux");
    const main = await h.click(module, "Retour au menu");
    expect(main.ts).toBe(first.ts);
    const budget = await h.click(second, 'Budget');
    expect(budget.ts).toBe(second.ts);
    expect(budget.body.text).toContain('budget');
    const help = await h.click(main, "Aide");
    expect(help.body.text).toContain("préfixe");
    const updates = h.messages.filter(message => message.method === 'chat.update').length;
    await h.click(first, "Messages Slack sans réponse", bob);
    await h.click(first, "Messages Slack sans réponse", alice, second.ts);
    expect(h.messages.filter(message => message.method === 'chat.update')).toHaveLength(updates);
    expect((await h.dm('channels')).body.text).toContain("préfixe");
  } finally { await h.close(); }
});

it('chooses Slack channels across pages in the same DM message without Gmail or AI', async () => {
  let channelCount = 12;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const request = new URL(url);
    expect(request.pathname).toBe('/api/users.conversations');
    return Response.json({ ok: true, channels: Array.from({ length: channelCount }, (_, index) => ({
      id: `CCHANNEL${index}`, name: `channel-${String(index).padStart(2, '0')}`, is_channel: true, is_private: false,
    })), response_metadata: { next_cursor: '' } });
  }));
  const h = await harness();
  try {
    const main = await h.dm('menu');
    const module = await h.click(main, "Messages Slack sans réponse");
    const first = await h.click(module, "Choisir les canaux");
    expect(first.method).toBe('chat.update');
    expect(first.ts).toBe(main.ts);
    expect(first.body.text).toContain('page 1/2');
    const second = await h.click(first, "Suivant");
    expect(second.ts).toBe(first.ts);
    expect(second.body.text).toContain('channel-11');
    const added = await h.click(second, "Ajouter #channel-11");
    expect(added.method).toBe('chat.update');
    expect(added.ts).toBe(first.ts);
    expect(added.body.text).toContain("Canaux sélectionnés : 1");
    button(added, "Retirer #channel-11");
    const removed = await h.click(added, "Retirer #channel-11");
    expect(removed.body.text).toContain("Canaux sélectionnés : 0");
    button(removed, "Ajouter #channel-11");
    channelCount = 1;
    const adjusted = await h.click(first, "Suivant");
    expect(adjusted.body.text).toContain('page 1/1');
    expect(adjusted.body.text).not.toContain('channel-11');
    const back = await h.click(adjusted, "Retour aux messages Slack sans réponse");
    expect(back.ts).toBe(main.ts);
    expect(back.body.text).toContain("Choisissez les canaux");
    expect(h.messages.filter(message => message.method === 'chat.postMessage')).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).includes('users.conversations'))).toBe(true);
  } finally { await h.close(); }
});

it('retains inaccessible selections and rejects another user or stale access on channel clicks', async () => {
  let accessible = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const request = new URL(url);
    expect(request.pathname).toBe('/api/users.conversations');
    return Response.json({ ok: true, channels: request.searchParams.get('user') === 'UALICE' && accessible
      ? [{ id: 'GPRIVATE', name: 'planning', is_group: true, is_private: true }] : [], response_metadata: { next_cursor: '' } });
  }));
  const h = await harness();
  try {
    const first = await h.dm('slack channels');
    const bobAttempt = await h.click(first, "Ajouter #planning", bob);
    expect(bobAttempt.body.text).toContain('indisponible');
    expect(bobAttempt.body.text).not.toContain('planning');
    accessible = false;
    const changed = await h.click(first, "Ajouter #planning");
    expect(changed.body.text).toContain('n’est plus accessible');
    expect(changed.body.text).toContain("Canaux sélectionnés : 0");
    accessible = true;
    const added = await h.click(first, "Ajouter #planning");
    expect(added.body.text).toContain("Canaux sélectionnés : 1");
    accessible = false;
    const unavailable = await h.click(first, "Ajouter #planning");
    expect(unavailable.body.text).toContain('Canal sélectionné indisponible GPRIVATE');
    expect(unavailable.body.text).not.toContain('planning');
    const removed = await h.click(unavailable, 'Retirer GPRIVATE');
    expect(removed.body.text).toContain("Canaux sélectionnés : 0");
    expect(removed.body.text).toContain('Aucun canal public ou privé partagé');
    accessible = true;
    const messagesAfterRemove = h.messages.length;
    await sql.query("UPDATE jobs SET status='queued',available_at=now() WHERE module='slack' AND payload->>'action'='channel_select'");
    await h.drain();
    expect(h.messages).toHaveLength(messagesAfterRemove);
    const current = await h.dm('slack channels');
    expect(current.body.text).toContain("Canaux sélectionnés : 0");
  } finally { await h.close(); }
});

it('keeps saved selections removable if channel discovery fails during refresh', async () => {
  let discoveryCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    discoveryCalls++;
    if (discoveryCalls === 3) throw new Error('Channel discovery unavailable');
    return Response.json({ ok: true, channels: [{ id: 'CPUBLIC', name: 'general', is_channel: true, is_private: false }], response_metadata: { next_cursor: '' } });
  }));
  const h = await harness();
  try {
    const list = await h.dm('slack channels');
    const updated = await h.click(list, "Ajouter #general");
    expect(updated.method).toBe('chat.update');
    expect(updated.body.text).toContain("Canaux sélectionnés : 1");
    expect(updated.body.text).toContain('L’accès aux canaux est momentanément indisponible');
    expect(updated.body.text).not.toContain('selections are unchanged');
    button(updated, 'Retirer CPUBLIC');
  } finally { await h.close(); }
});

it('gives shared guidance for channel controls after Slack Unanswered is disabled', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, channels: [
    { id: 'CPUBLIC', name: 'general', is_channel: true, is_private: false },
  ], response_metadata: { next_cursor: '' } })));
  const enabled = await harness();
  let list: Posted;
  try { list = await enabled.dm('slack channels'); }
  finally { await enabled.close(); }
  const provider = vi.fn(() => { throw new Error('Disabled module accessed Slack'); });
  vi.stubGlobal('fetch', provider);
  const disabled = await harness({ ...env, ENABLED_MODULES: '' });
  try {
    const guidance = await disabled.click(list!, 'Ajouter #general');
    expect(guidance.body.text).toContain("transmise à aucun module");
    expect(guidance.body.text).not.toContain('general');
    expect(provider).not.toHaveBeenCalled();
  } finally { await disabled.close(); }
});

it('connects through the existing invitation and confirms disconnect without erasing saved rules', async () => {
  const h = await harness(mailEnv);
  try {
    const main = await h.dm('menu');
    const mail = await h.click(main, "Tri des e-mails");
    expect(mail.body.text).toContain("courrier trier");
    const connection = await h.click(mail, "Connexion Gmail");
    expect(connection.body.text).toContain("n’est pas connecté");
    const invitation = await h.click(connection, "Connecter Gmail");
    expect(invitation.method).toBe('chat.postMessage');
    expect(invitation.body.text).toContain('à usage unique');
    const connectUrl = richParts(invitation).find((part: any) => part.type === 'link').url;
    const path = new URL(connectUrl).pathname + new URL(connectUrl).search;
    const redirect = await h.get(path);
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toContain('accounts.google.com');
    expect((await h.get(path)).statusCode).toBe(400);
    expect((await h.click(mail, "Connexion Gmail")).body.text).toContain("n’est pas connecté");
    const returned = await h.click(invitation, 'Menu');
    expect(returned.method).toBe('chat.postMessage');
    expect(returned.ts).not.toBe(invitation.ts);

    const store = new Store(sql), state = await store.load(alice);
    state.connection = { id: 'connection-1', subject: 'google-alice', email: 'alice@example.com', encryptedTokens: 'unused' };
    state.rules = starterRules().map((rule, index) => ({ ...rule, id: `rule-${index}` }));
    state.runs.push({ id: 'saved-preview', created: new Date().toISOString(), ruleVersion: state.ruleVersion, connectionId: state.connection.id, status: 'preview', items: [] });
    await store.save(alice, state);
    const connected = await h.click(mail, "Connexion Gmail");
    expect(connected.body.text).toContain('alice@example.com');
    const proposal = await h.click(connected, "Déconnecter Gmail");
    expect(proposal.body.text).toContain('annuler tous les aperçus en attente');
    // Opening the confirmation does not disconnect the account.
    expect((await h.click(mail, "Connexion Gmail")).body.text).toContain('alice@example.com');
    const result = await h.click(proposal, "Déconnecter Gmail");
    expect(result.body.text).toContain('Gmail est déconnecté');
    expect((await h.click(mail, "Connexion Gmail")).body.text).toContain("n’est pas connecté");
    expect((await h.click(proposal, "Déconnecter Gmail")).body.text).toContain('n’est plus valide');
    expect((await h.dm("courrier règles")).body.text).toContain('Urgent');
    expect((await h.dm("courrier rapport")).body.text).toContain('annulé');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it('keeps old menus recoverable across a restart, disablement and an idempotent schema upgrade', async () => {
  const first = await harness();
  const old = await first.dm('menu');
  await first.close();
  await db.exec(schema);
  const h = await harness({ ...env, ENABLED_MODULES: '' });
  try {
    const fresh = await h.dm('menu');
    expect(buttons(fresh).map((item: any) => item.text.text)).toEqual(['Budget', "Aide"]);
    const unavailable = await h.click(old, "Messages Slack sans réponse");
    expect(unavailable.method).toBe('chat.update');
    expect(unavailable.ts).toBe(old.ts);
    expect(unavailable.body.text).toContain("n’est pas activé");
    expect((await h.click(unavailable, "Retour au menu")).body.text).toContain('Aucun module');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it('retries explicit Slack rejections but does not blindly repeat uncertain menu delivery', async () => {
  const h = await harness();
  try {
    h.failNext('reject');
    await expect(h.dm('menu')).rejects.toThrow('rejected');
    expect(h.messages).toHaveLength(0);
    const menu = await h.drain();
    expect(h.messages).toHaveLength(1);
    h.failNext('uncertain');
    await expect(h.click(menu, "Messages Slack sans réponse")).rejects.toThrow('Connection lost');
    const count = h.messages.length;
    await h.drain();
    expect(h.messages).toHaveLength(count);
    const fresh = await h.dm('menu');
    expect(fresh.method).toBe('chat.postMessage');
    expect(fresh.ts).not.toBe(menu.ts);
    h.failNext('uncertain');
    await expect(h.dm('menu')).rejects.toThrow('Connection lost');
    const afterPost = h.messages.length;
    await h.drain();
    expect(h.messages).toHaveLength(afterPost);
  } finally { await h.close(); }
});

it('rejects untrusted ingress and malformed update identities before any Slack delivery', async () => {
  const h = await harness();
  try {
    const event = { type: 'event_callback', team_id: alice.team, event_id: randomUUID(), event: { type: 'message', channel_type: 'im', user: alice.user, channel: alice.channel, text: 'menu' } };
    expect((await h.post('/slack/events', JSON.stringify(event), 'application/json', false)).statusCode).toBe(401);
    expect((await h.post('/slack/events', JSON.stringify({ ...event, team_id: 'TOTHER' }), 'application/json')).statusCode).toBe(403);
    await h.post('/slack/events', JSON.stringify({ ...event, event: { ...event.event, channel_type: 'channel', channel: 'CPUBLIC' } }), 'application/json');
    const action = { type: 'block_actions', team: { id: alice.team }, user: { id: alice.user }, channel: { id: 'GPRIVATE' }, actions: [{ action_id: 'core:navigate', value: 'unknown|main' }] };
    expect((await h.post('/slack/actions', new URLSearchParams({ payload: JSON.stringify(action) }).toString(), 'application/x-www-form-urlencoded')).statusCode).toBe(403);
    expect((await h.post('/slack/actions', new URLSearchParams({ payload: JSON.stringify({ ...action, channel: { id: alice.channel } }) }).toString(), 'application/x-www-form-urlencoded')).statusCode).toBe(400);
    await h.drain();
    expect(h.messages).toHaveLength(0);
  } finally { await h.close(); }
});

it('opens a module named main without confusing it with the shared menu', async () => {
  const h = await harness({ ...env, ENABLED_MODULES: '' }, [{ id: 'main', name: 'Extra module', description: 'An independent capability', async handle() {} }]);
  try {
    const main = await h.dm('menu');
    const module = await h.click(main, 'Extra module');
    expect(module.method).toBe('chat.update');
    expect(module.body.text).toContain('An independent capability');
    expect((await h.click(module, "Retour au menu")).body.text).toContain("Choisissez un module");
  } finally { await h.close(); }
});

it('requires the originating User to approve the mailbox after the complete menu OAuth callback flow', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'navigation-test', alg: 'RS256', use: 'sig' };
  let nonce = '';
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    if (String(url) === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    const token = await new SignJWT({ email: 'alice@example.com', email_verified: true, hd: 'example.com', nonce })
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer('https://accounts.google.com')
      .setAudience('client').setSubject('google-alice').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    return Response.json({ id_token: token, access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/gmail.modify' });
  }));
  const h = await harness(mailEnv);
  try {
    const mail = await h.click(await h.dm('menu'), "Tri des e-mails");
    const connection = await h.click(mail, "Connexion Gmail");
    const invite = await h.click(connection, "Connecter Gmail");
    const link = new URL(richParts(invite).find((part: any) => part.type === 'link').url);
    const start = await h.get(link.pathname + link.search);
    const authorize = new URL(String(start.headers.location));
    nonce = authorize.searchParams.get('nonce')!;
    const callback = `/auth/google/callback?state=${authorize.searchParams.get('state')}&code=fake-code`;
    expect((await h.get(callback, String(start.headers['set-cookie']).split(';')[0])).statusCode).toBe(200);
    const proposal = await h.drain();
    expect(title(proposal)).toBe("Confirmer la boîte e-mail");
    expect(proposal.body.channel).toBe('DALICE');
    expect((await h.click(mail, "Connexion Gmail")).body.text).toContain("n’est pas connecté");
    expect((await h.click(proposal, "Connecter cette boîte", bob)).body.text).toContain('indisponible');
    expect((await h.click(mail, "Connexion Gmail")).body.text).toContain("n’est pas connecté");
    expect((await h.click(proposal, "Connecter cette boîte")).body.text).toContain('Connexion établie pour alice@example.com');
    expect((await h.click(mail, "Connexion Gmail")).body.text).toContain('alice@example.com');
    expect((await h.get(callback, String(start.headers['set-cookie']).split(';')[0])).statusCode).toBe(400);
    expect((await h.click(proposal, "Connecter cette boîte")).body.text).toContain('déjà traitée');
  } finally { await h.close(); }
});

it('browses mail rules in place and posts Add/Edit instructions without changing saved state or routing', async () => {
  const h = await harness(mailEnv);
  try {
    const store = new Store(sql), state = await store.load(alice);
    state.rules = Array.from({ length: 7 }, (_, index) => ({ ...starterRules()[0]!, id: `rule-${index}`, name: `Priority ${index}` }));
    await store.save(alice, state);
    const mail = await h.click(await h.dm('menu'), "Tri des e-mails");
    const rules = await h.click(mail, "Gérer les règles");
    expect(rules.method).toBe('chat.update');
    expect(rules.body.text).toContain('Priority 0');
    expect(rules.body.text).not.toContain('Priority 6');
    const next = await h.click(rules, "Suivant");
    expect(next.ts).toBe(rules.ts);
    expect(next.body.text).toContain('Priority 3');
    const edit = await h.click(next, "Modifier 1");
    expect(edit.method).toBe('chat.postMessage');
    expect(edit.body.text).toContain('courrier');
    expect(edit.body.text).toContain('rule-3');
    expect((await h.click(rules, "Ajouter une règle")).body.text).toContain('courrier');
    expect((await h.dm('change Priority 0')).body.text).toContain("préfixe");
    expect((await h.click(await h.dm('menu', bob), "Tri des e-mails", bob)).body.text).not.toContain('Priority');
    expect((await h.click(mail, "Dernier rapport")).body.text).toContain('Aucun traitement conservé');
    expect(buttons(mail).some((item: any) => item.text.text === "Approbations en attente")).toBe(false);
    const after = await store.load(alice);
    expect(after.rules).toEqual(state.rules);
    expect(after.drafts).toEqual(state.drafts);
    expect(after.history).toEqual(state.history);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it('offers starter rules and removal as separately approved Proposals, then reopens the original Proposal', async () => {
  const h = await harness(mailEnv);
  try {
    const mail = await h.click(await h.dm('menu'), "Tri des e-mails");
    const rules = await h.click(mail, "Gérer les règles");
    expect(rules.body.text).toContain("Aucune règle approuvée");
    const requestId = randomUUID();
    const proposal = await h.click(rules, "Modèles de règles", alice, rules.ts, requestId);
    const delivered = h.messages.length;
    await h.click(rules, "Modèles de règles", alice, rules.ts, requestId);
    expect(h.messages).toHaveLength(delivered);
    const approval = button(proposal, "Approuver les règles");
    expect((await h.click(mail, "Gérer les règles")).body.text).toContain("Aucune règle approuvée");
    const pending = await h.click(await h.click(mail, "Retour au menu").then(main => h.click(main, "Tri des e-mails")), "Approbations en attente");
    const reopened = await h.click(pending, "Ouvrir 1");
    expect(reopened.method).toBe('chat.postMessage');
    expect(button(reopened, "Approuver les règles").value).toBe(approval.value);
    expect(reopened.body.text).toContain('Exemples :');
    expect((await h.click(reopened, "Approuver les règles", bob)).body.text).toContain('indisponible');
    await h.click(reopened, "Approuver les règles");
    const saved = await h.click(mail, "Gérer les règles");
    expect(saved.body.text).toContain('Urgent');
    expect((await h.click(reopened, "Approuver les règles")).body.text).toContain('déjà traitée');
    const savedWithRemove = await h.seek(saved, "Retirer 1");
    const remove = await h.click(savedWithRemove, "Retirer 1");
    expect(remove.body.text).toContain('Supprimer la règle Urgent');
    expect((await h.click(mail, "Gérer les règles")).body.text).toContain('Urgent');
    await h.click(remove, "Approuver les règles");
    expect((await h.click(mail, "Gérer les règles")).body.text).not.toContain('Urgent');
    expect((await h.click(savedWithRemove, "Retirer 1")).body.text).toContain('n’est plus disponible');
    expect((await h.click(pending, "Ouvrir 1")).body.text).toContain('indisponible');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it('reopens saved Previews and Reports without renewing them and excludes stale approvals', async () => {
  const store = new Store(sql), state = await store.load(alice);
  state.connection = { id: 'connection-1', subject: 'alice', email: 'alice@example.com', encryptedTokens: 'unused' };
  const preview: Run = { id: 'preview-1', created: new Date(Date.now() - 3600_000).toISOString(), connectionId: state.connection.id, ruleVersion: 0, status: 'preview', items: [] };
  state.runs = [preview,
    { ...preview, id: 'expired', created: new Date(Date.now() - 25 * 3600_000).toISOString() },
    { ...preview, id: 'wrong-version', ruleVersion: 5 }, { ...preview, id: 'disconnected', connectionId: 'old' },
    { ...preview, id: 'done', status: 'done' }];
  state.drafts = Array.from({ length: 4 }, (_, index) => ({ id: `draft-${index}`, kind: 'rules' as const, created: new Date().toISOString(), rules: starterRules() }));
  state.drafts.push({ id: 'expired-draft', kind: 'rules', created: new Date(Date.now() - 25 * 3600_000).toISOString(), rules: starterRules() });
  await store.save(alice, state);
  const h = await harness(mailEnv);
  try {
    const mail = await h.click(await h.dm('menu'), "Tri des e-mails");
    const pending = await h.click(mail, "Approbations en attente");
    expect(pending.body.text).toContain('page 1/2');
    const next = await h.click(pending, "Suivant");
    expect(next.ts).toBe(pending.ts);
    expect(next.body.text).toContain('preview-1');
    expect(next.body.text).not.toMatch(/expired|wrong-version|disconnected/);
    const reopened = await h.click(next, "Ouvrir 2");
    expect(reopened.method).toBe('chat.postMessage');
    expect(button(reopened, "Confirmer les modifications").value).toBe('preview-1');
    expect((await h.click(next, "Ouvrir 2", bob)).body.text).toContain('indisponible');
    const report = await h.click(mail, "Dernier rapport");
    expect(report.body.text).toContain('done');
    expect(button(report, "Annuler ce traitement").value).toBe('done');
    expect((await h.click(report, "Détails")).body.text).toContain('Traitement done');
    const saved = await store.load(alice);
    expect(saved.runs).toEqual(state.runs);
    expect(saved.drafts).toEqual(state.drafts);
    expect(saved.history).toEqual(state.history);
    saved.ruleVersion++;
    await store.save(alice, saved);
    expect((await h.click(next, "Ouvrir 2")).body.text).toContain("connexion/ses règles ont changé");
    expect((await h.click(reopened, "Confirmer les modifications")).body.text).toContain("connexion/ses règles ont changé");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it('keeps Latest report on the newest completed run while a newer Preview is pending', async () => {
  const store = new Store(sql), state = await store.load(alice);
  state.runs = [
    { id: 'completed', created: new Date(Date.now() - 60_000).toISOString(), connectionId: 'old', ruleVersion: 0, status: 'done', items: [] },
    { id: 'pending', created: new Date().toISOString(), connectionId: 'old', ruleVersion: 0, status: 'preview', items: [] },
  ];
  await store.save(alice, state);
  const h = await harness(mailEnv);
  try {
    const mail = await h.click(await h.dm('menu'), "Tri des e-mails");
    const report = await h.click(mail, "Dernier rapport");
    expect(report.body.text).toContain("Traitement completed: terminé");
    expect(report.body.text).not.toContain('Run pending');
  } finally { await h.close(); }
});

it('retains saved-item identity through a restart and suppresses uncertain redelivery', async () => {
  const store = new Store(sql), state = await store.load(alice);
  state.drafts.push({ id: 'retained', kind: 'rules', created: new Date().toISOString(), rules: starterRules() });
  await store.save(alice, state);
  const first = await harness(mailEnv);
  const pending = await first.click(await first.click(await first.dm('menu'), "Tri des e-mails"), "Approbations en attente");
  await first.close();
  const h = await harness(mailEnv);
  try {
    h.failNext('reject');
    await expect(h.click(pending, "Ouvrir 1")).rejects.toThrow('rejected');
    const reopened = await h.drain();
    expect(button(reopened, "Approuver les règles").value).toBe('retained');
    h.failNext('uncertain');
    await expect(h.click(pending, "Ouvrir 1")).rejects.toThrow('Connection lost');
    const count = h.messages.length;
    await h.drain();
    expect(h.messages).toHaveLength(count);
    const unchanged = await store.load(alice);
    expect(unchanged.drafts).toEqual(state.drafts);
    await h.click(reopened, "Annuler");
    expect((await h.click(pending, "Ouvrir 1")).body.text).toContain('déjà traitée');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it('keeps targeted undo behind the saved Report and does not overwrite later mailbox changes', async () => {
  const store = new Store(sql), state = await store.load(alice);
  state.connection = { id: 'connected', subject: 'alice', email: 'alice@example.com', encryptedTokens: new Vault(Buffer.from(mailEnv.ENCRYPTION_KEY, 'base64')).seal({ access_token: 'fake', refresh_token: 'fake', expires_at: Date.now() + 3600_000 }, 'TTEAM:UALICE') };
  state.runs = [{ id: 'finished', created: new Date().toISOString(), ruleVersion: 0, connectionId: 'connected', status: 'done', items: ['unchanged', 'changed'].map(id => ({ id, from: 'sender@example.com', subject: id, before: ['INBOX'], historyId: 'before', after: ['INBOX', 'URGENT'], afterHistory: 'after', add: ['URGENT'], remove: [], status: 'applied', plan: { labels: ['Urgent'], disposition: 'keep', needsDecision: false, reasons: ['Approved rule'] } })) }];
  await store.save(alice, state);
  const mutations: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    expect(url).toContain('https://gmail.googleapis.com/');
    if (options.method === 'POST') {
      expect(url).toContain('/messages/unchanged/modify');
      mutations.push(JSON.parse(String(options.body)));
      return Response.json({ id: 'unchanged', historyId: 'undone', labelIds: ['INBOX'] });
    }
    const changed = url.includes('/changed?');
    return Response.json({ id: changed ? 'changed' : 'unchanged', historyId: changed ? 'later' : 'after', labelIds: ['INBOX', 'URGENT'] });
  }));
  const h = await harness(mailEnv);
  try {
    const mail = await h.click(await h.dm('menu'), "Tri des e-mails");
    const report = await h.click(mail, "Dernier rapport");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect((await h.click(report, "Annuler ce traitement", bob)).body.text).toContain("n’est pas disponible");
    const result = await h.click(report, "Annuler ce traitement");
    expect(result.body.text).toContain('annulé');
    expect(mutations).toEqual([{ addLabelIds: [], removeLabelIds: ['URGENT'] }]);
    const details = await h.click(result, "Détails");
    expect(details.body.text).toContain('le message a changé depuis ce traitement');
    await h.click(report, "Annuler ce traitement");
    expect(mutations).toHaveLength(1);
  } finally { await h.close(); }
});

it('bounds long rule summaries while retaining every page and action', async () => {
  const store = new Store(sql), state = await store.load(alice);
  state.rules = Array.from({ length: 40 }, (_, index) => ({ ...starterRules()[0]!, id: `long-${index}`, name: `Long rule ${index}`, condition: '*'.repeat(1200), senders: Array.from({ length: 100 }, (_, n) => `${'x'.repeat(60)}${n}@example.com`), labels: Array.from({ length: 10 }, () => '_'.repeat(100)) }));
  await store.save(alice, state);
  const h = await harness(mailEnv);
  try {
    let page = await h.click(await h.click(await h.dm('menu'), "Tri des e-mails"), "Gérer les règles");
    for (let n = 0; n < 14; n++) {
      const text = richParts(page).map((part: any) => part.text).join('\n');
      expect(text.length).toBeLessThan(12_000);
      expect(text).toContain(`Long rule ${n * 3}`);
      expect(text).toContain("résumés");
      button(await h.seek(page, "Modifier 1"), "Modifier 1"); button(await h.seek(page, "Retirer 1"), "Retirer 1"); button(page, "Retour au menu");
      if (n < 13) page = await h.click(page, "Suivant");
    }
    expect(findButton(page, "Suivant")).toBeUndefined();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it('keeps a long answer in one Slack message with bound in-place text pages', async () => {
  const answer = `${'A'.repeat(9_500)}\n${'B'.repeat(9_500)}\n${'C'.repeat(9_500)}`;
  const probe: AssistantModule = { id: 'probe', description: 'Long answer fixture',
    async handle(actor, _payload, _eventId, context) { await context.messenger.send(actor, { text: answer }); } };
  const h = await harness(env, [probe]);
  try {
    const first = await h.dm('probe answer');
    expect(first.method).toBe('chat.postMessage');
    expect(first.body.blocks[0].text).toContain('Réponse — page 1/3');
    expect(first.body.blocks[0].text).toContain('A'.repeat(9_500));
    const second = await h.click(first, 'Suivant');
    expect(second.method).toBe('chat.update');
    expect(second.ts).toBe(first.ts);
    expect(second.body.blocks[0].text).toContain('Réponse — page 2/3');
    expect(second.body.blocks[0].text).toContain('B'.repeat(9_500));
    const third = await h.click(second, 'Suivant');
    expect(third.ts).toBe(first.ts);
    expect(third.body.blocks[0].text).toContain('Réponse — page 3/3');
    expect(third.body.blocks[0].text).toContain('C'.repeat(9_500));
    expect(h.messages.filter(message => message.method === 'chat.postMessage')).toHaveLength(1);
  } finally { await h.close(); }
});

it('pages replies by rendered link length without losing clickable destinations', async () => {
  const urls = Array.from({ length: 70 }, (_, index) => `https://example.com/${String(index).padStart(2, '0')}/${'a'.repeat(85)}`);
  const probe: AssistantModule = { id: 'probe', description: 'Link answer fixture',
    async handle(actor, _payload, _eventId, context) { await context.messenger.send(actor, { text: urls.join('\n') }); } };
  const h = await harness(env, [probe]);
  try {
    let page = await h.dm('probe answer');
    const timestamp = page.ts;
    const displayed: string[] = [];
    for (let index = 0; index < 10; index++) {
      const body = page.body.blocks[0].text as string;
      expect(body.length).toBeLessThanOrEqual(12_000);
      displayed.push(body);
      if (!findButton(page, 'Suivant')) break;
      page = await h.click(page, 'Suivant');
      expect(page.ts).toBe(timestamp);
    }
    for (const url of urls) expect(displayed.join('\n')).toContain(`[${url}](${url})`);
    expect(displayed.length).toBeGreaterThan(1);
    expect(h.messages.filter(message => message.method === 'chat.postMessage')).toHaveLength(1);
  } finally { await h.close(); }
});
