import { createHash, createHmac, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { readConfig } from '../src/app/config.js';
import { frenchCommand } from '../src/app/commands.js';
import { createModules } from '../src/app/modules.js';
import { dispatchJob } from '../src/core/dispatch.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { createServer } from '../src/core/server.js';
import { Slack } from '../src/core/slack.js';
import { coreSchema, JobStore } from '../src/core/store.js';
import type { Database } from '../src/core/transactions.js';
import type { Pool } from 'pg';
import { worker } from '../src/core/worker.js';
import { createYousignModule } from '../src/modules/yousign/index.js';
import { YousignStore } from '../src/modules/yousign/store.js';

const subscription = 'company-subscription', secret = 'a-long-yousign-webhook-secret';
const alice = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' }, bob = { team: 'TTEAM', user: 'UBOB', channel: 'DBOB' };
const env = { PUBLIC_URL: 'https://agent.example.com', DATABASE_URL: 'postgresql://unused', SLACK_TEAM_ID: 'TTEAM', SLACK_BOT_TOKEN: 'bot',
  SLACK_SIGNING_SECRET: 'slack-secret', SLACK_ADMIN_USER_ID: 'UADMIN', ENABLED_MODULES: 'yousign',
  YOUSIGN_SUBSCRIPTION_ID: subscription, YOUSIGN_WEBHOOK_SECRET: secret, YOUSIGN_SANDBOX: 'false' };
const config = readConfig(env), moduleConfig = { ...config, ...{ YOUSIGN_SUBSCRIPTION_ID: subscription, YOUSIGN_WEBHOOK_SECRET: secret, YOUSIGN_SANDBOX: false } };
const identity = { kind: 'integration' as const, team: 'TTEAM', integration: subscription };
let db: PGlite;
const apps: Array<{ close(): Promise<void> }> = [];
beforeAll(async () => { db = new PGlite(); await db.exec(coreSchema); });
beforeEach(async () => { await db.exec('TRUNCATE jobs,ai_calls,ai_months,core_navigation_menus,core_navigation_deliveries,core_operation_slots CASCADE; DROP TABLE IF EXISTS yousign_confirmations,yousign_deliveries,yousign_events,yousign_destinations,yousign_handled_events,yousign_alerts,yousign_integrations CASCADE'); });
afterAll(async () => { for (const app of apps) await app.close(); await db.close(); });

const event = (name = 'signer.done', id = randomUUID()) => ({ event_id: id, event_name: name,
  event_time: String(Date.parse('2026-10-02T12:32:00Z') / 1000), subscription_id: subscription, sandbox: false,
  data: { signature_request: { id: 'request-123', name: 'Contrat Acme', status: 'ongoing', documents: [{ id: 'doc', content: 'private-document' }] },
    signer: { info: { first_name: 'Jean', last_name: 'Dupont', email: 'private@example.com' }, signature_link: 'https://secret.example/sign-token' } } });

async function harness() {
  let failEnqueue = false, failDirectory = false, counter = 0;
  const wrap = (connection: any) => ({ query: async (text: string, values?: any[]) => {
    if (failEnqueue && text.startsWith('INSERT INTO jobs')) throw new Error('Database unavailable');
    return connection.query(text, values);
  } });
  const sql: Database = { ...wrap(db), transaction: work => db.transaction(tx => work(wrap(tx))) };
  const posts: Array<{ channel: string; text: string; blocks: any[]; ts: string; [key: string]: any }> = [];
  const aliceChannels: any[] = [{ id: 'CPUBLIC', name: 'sales', is_channel: true, is_private: false }, { id: 'GPRIVATE', name: 'legal', is_group: true, is_private: true }];
  const access = new Map([['CPUBLIC', true], ['GPRIVATE', true]]);
  const failures = new Map<string, 'rejected' | 'uncertain' | '429' | 'invalid'>();
  let alertFailure: 'rejected' | 'uncertain' | undefined;
  let beforePost: ((channel: string) => Promise<void>) | undefined;
  const fetcher = (async (url: URL | string, init?: RequestInit) => {
    const request = new URL(String(url));
    if (request.pathname.endsWith('/users.conversations')) return Response.json(failDirectory ? { ok: false, error: 'missing_scope' }
      : { ok: true, channels: request.searchParams.get('user') === alice.user ? aliceChannels : aliceChannels.filter(channel => !channel.is_private) });
    if (request.pathname.endsWith('/conversations.info')) {
      const id = request.searchParams.get('channel')!;
      return Response.json({ ok: true, channel: { id, is_member: access.get(id) === true, is_channel: true } });
    }
    expect(['/api/chat.postMessage', '/api/chat.update']).toContain(request.pathname);
    const body = JSON.parse(String(init?.body));
    await beforePost?.(body.channel);
    const failure = body.channel === 'UADMIN' ? alertFailure : failures.get(body.channel);
    if (body.channel === 'UADMIN') alertFailure = undefined;
    else failures.delete(body.channel);
    if (failure === 'rejected') return Response.json({ ok: false, error: 'not_in_channel' });
    if (failure === 'invalid') return Response.json({ ok: false, error: 'invalid_blocks' });
    if (failure === '429') return new Response('Rate limited', { status: 429, headers: { 'retry-after': '120' } });
    const ts = body.ts ?? `1234567890.${String(++counter).padStart(6, '0')}`;
    posts.push({ ...body, ts });
    if (failure === 'uncertain') return Response.json({ ok: false, error: 'internal_error' }, { status: 500 });
    return Response.json({ ok: true, ts });
  }) as typeof fetch;
  const module = { ...createYousignModule(moduleConfig, sql, { fetcher }), normalizeText: (text: string) => frenchCommand('yousign', text) }, modules = new ModuleRegistry([module]);
  await module.initialize!(sql);
  const app = createServer(config, new JobStore(sql), modules); apps.push(app);
  const messenger = new Slack('bot', fetcher);
  const run = async (id: string) => {
    const job = (await sql.query("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id=$1 AND status IN ('queued','running') RETURNING *", [id])).rows[0];
    if (!job) return;
    const retryAt = await dispatchJob(sql, config, modules, messenger, job);
    if (retryAt) await new JobStore(sql).defer(id, retryAt); else await new JobStore(sql).complete(id);
  };
  const webhook = (body: unknown, raw = JSON.stringify(body), signed = raw) => app.inject({ method: 'POST', url: '/webhooks/yousign', payload: raw,
    headers: { 'content-type': 'application/json', 'x-yousign-signature-256': `sha256=${createHmac('sha256', secret).update(signed).digest('hex')}` } });
  const slackRequest = async (path: string, raw: string, type: string) => {
    const stamp = String(Math.floor(Date.now() / 1000));
    return app.inject({ method: 'POST', url: path, payload: raw, headers: { 'content-type': type,
      'x-slack-request-timestamp': stamp, 'x-slack-signature': `v0=${createHmac('sha256', 'slack-secret').update(`v0:${stamp}:${raw}`).digest('hex')}` } });
  };
  const text = async (message: string, actor = alice) => {
    const id = randomUUID();
    const response = await slackRequest('/slack/events', JSON.stringify({ type: 'event_callback', team_id: actor.team, event_id: id,
      event: { type: 'message', channel_type: 'im', channel: actor.channel, user: actor.user, text: message } }), 'application/json');
    expect(response.statusCode).toBe(200); await run(`slack:${id}`);
    return posts.filter(post => post.channel === actor.channel).at(-1)!;
  };
  // Workflow tests identify compact table controls by their channel's row name.
  const buttons = (post: (typeof posts)[number]) => post.blocks.flatMap(block => block.child_blocks ?? [block]).flatMap(block => block.type === 'actions' ? block.elements
    : block.type === 'data_table' ? block.rows.slice(1).flatMap((row: any[]) => row.filter(cell => cell.type === 'action_cell').map(cell => ({ ...cell.element,
      text: { ...cell.element.text, text: `${cell.element.text.text.replace(/^[☐☑] /, '')} ${row[0].text}` },
    }))) : []);
  const click = async (post: (typeof posts)[number], label: string, actor = alice, timestamp = post.ts) => {
    let current = post;
    for (let page = 0; page < 30 && !buttons(current).some(button => button.text?.text.replace(/^🧭 /, '') === label); page++) {
      expect(buttons(current).some(button => button.text?.text.replace(/^🧭 /, '') === 'Actions ▶'), label).toBe(true);
      current = await click(current, 'Actions ▶', actor, timestamp);
    }
    const button = buttons(current).find(button => button.text?.text.replace(/^🧭 /, '') === label); expect(button, label).toBeDefined();
    const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: actor.team }, user: { id: actor.user }, channel: { id: actor.channel },
      message: { ts: timestamp }, actions: [{ action_id: button.action_id, value: button.value, action_ts: String(++counter) }] }) }).toString();
    const response = await slackRequest('/slack/actions', raw, 'application/x-www-form-urlencoded'); expect(response.statusCode).toBe(200);
    await run(`action:${createHash('sha256').update(raw).digest('base64url')}`);
    return posts.filter(post => post.channel === actor.channel).at(-1)!;
  };
  const add = async (channel: string, actor = alice) => click(await text('yousign canaux', actor), `Activer #${channel}`, actor);
  const pending = () => sql.query("SELECT * FROM jobs WHERE module='yousign' AND actor->>'kind'='integration' AND status IN ('queued','running') ORDER BY created_at,id");
  const deliver = async () => {
    for (const job of (await pending()).rows) if (new Date(job.available_at).getTime() <= Date.now()) await run(job.id);
  };
  const due = async () => { await sql.query("UPDATE yousign_deliveries SET next_at=now() WHERE status='queued'"); await sql.query("UPDATE yousign_alerts SET next_at=now() WHERE status='queued'"); await sql.query("UPDATE jobs SET available_at=now() WHERE module='yousign'"); };
  return { sql, module, modules, messenger, app, posts, access, failures, aliceChannels, run, text, click, buttons, webhook, add, deliver, due, pending,
    beforePost(callback: typeof beforePost) { beforePost = callback; },
    setEnqueueFailure(value: boolean) { failEnqueue = value; }, setDirectoryFailure(value: boolean) { failDirectory = value; }, setAlertFailure(value: typeof alertFailure) { alertFailure = value; } };
}

it('is opt-in, validates only enabled credentials, and requires no mail, encryption or AI configuration', async () => {
  const sql: Database = { query: (text, values) => db.query(text, values) };
  expect(createModules(readConfig({ ...env, ENABLED_MODULES: '' }), sql, {}).all()).toEqual([]);
  const app = createServer(config, new JobStore(sql), new ModuleRegistry([])); apps.push(app);
  expect((await app.inject({ method: 'POST', url: '/webhooks/yousign', payload: '{}' })).statusCode).toBe(404);
  expect(() => createModules(config, sql, { ...env, YOUSIGN_WEBHOOK_SECRET: undefined })).toThrow();
  expect(() => createModules(config, sql, { ...env, SLACK_ADMIN_USER_ID: '' })).toThrow();
  expect(createModules(config, sql, env).enabledIds()).toEqual(['core', 'yousign']);
});

it('verifies exact raw bytes, source/environment and Unix event time without accepting forged or malformed ingress', async () => {
  const h = await harness(), body = event();
  expect((await h.webhook(body, JSON.stringify(body) + ' ', JSON.stringify(body))).statusCode).toBe(401);
  expect((await h.webhook({}, '{bad')).statusCode).toBe(400);
  expect((await h.webhook({ ...body, subscription_id: 'other' })).statusCode).toBe(400);
  expect((await h.webhook({ ...body, sandbox: true })).statusCode).toBe(400);
  expect((await h.webhook({ ...body, event_time: 'not-a-timestamp' })).statusCode).toBe(400);
  expect((await h.sql.query('SELECT * FROM yousign_events')).rows).toHaveLength(0);
  expect((await h.webhook(body, JSON.stringify(body, null, 2))).statusCode).toBe(200);
  const saved = (await h.sql.query('SELECT * FROM yousign_events')).rows[0];
  expect(saved.status).toBe('skipped'); expect(saved.summary.time).toBe('2026-10-02T12:32:00.000Z');
  expect(JSON.stringify(saved.summary)).not.toMatch(/private@example|sign-token|private-document/);
  expect(h.posts).toHaveLength(0);
});

it('shares selections through signed private routing while hiding private destinations and rejecting another User’s controls', async () => {
  const h = await harness();
  const list = await h.text('yousign canaux');
  await h.click(list, 'Activer #legal', bob);
  expect((await h.sql.query('SELECT * FROM yousign_destinations')).rows).toHaveLength(0);
  await h.click(list, 'Activer #legal'); await h.add('sales');
  const shared = await h.text('yousign channels', bob);
  expect(shared.text).toContain('sales'); expect(shared.text).not.toContain('legal');
  expect(JSON.stringify(shared)).not.toContain('GPRIVATE');
  expect(h.buttons(shared).some(button => button.text.text === 'Retirer #sales')).toBe(true);
  await h.click(shared, 'Retirer #sales', bob);
  expect((await h.sql.query('SELECT channel_id FROM yousign_destinations WHERE active')).rows).toEqual([{ channel_id: 'GPRIVATE' }]);
  expect((await h.sql.query('SELECT * FROM ai_calls')).rows).toHaveLength(0);
});

it('renders a channel table with signed checkbox-style controls that update and persist in place', async () => {
  const h = await harness(), list = await h.text('yousign canaux');
  const table = list.blocks.find(block => block.type === 'data_table');
  expect(table?.rows[0].map((cell: any) => cell.text)).toEqual(['Canal', 'Visibilité', 'Notifications', 'Sélection']);
  expect(list.blocks.map(block => block.type)).toEqual(['container', 'data_table', 'container']);
  expect(table.rows.slice(1).map((row: any[]) => row.slice(0, 3).map(cell => cell.text))).toEqual([
    ['#legal', 'Privé', 'Désactivées'], ['#sales', 'Public', 'Désactivées'],
  ]);
  const toggle = table.rows[1][3];
  expect(toggle.element.text.text).toBe('☐ Activer');
  expect(toggle.element.action_id).toMatch(/^yousign:channel_add~button-\d+$/);
  expect(toggle.fallback.text).toContain('yousign canaux');
  expect(list.text).toContain('autorise immédiatement');
  await h.click(list, 'Activer #legal', alice, '999.999');
  await h.click(list, 'Activer #legal', { ...alice, channel: 'DOTHER' });
  expect((await h.sql.query('SELECT * FROM yousign_destinations')).rows).toHaveLength(0);
  const activated = await h.click(list, 'Activer #legal');
  expect(activated.ts).toBe(list.ts);
  const activeRow = activated.blocks.find(block => block.type === 'data_table')!.rows[1];
  expect(activeRow[2].text).toBe('Activées');
  expect(activeRow[3].element.text.text).toBe('☑ Retirer');
  expect(activeRow[3].element.style).toBe('danger');
  expect(activeRow[3].element.action_id).toMatch(/^yousign:channel_remove~button-\d+$/);
  const reopened = await h.text('yousign channels');
  expect(reopened.blocks.find(block => block.type === 'data_table')!.rows[1][2].text).toBe('Activées');
  const removed = await h.click(reopened, 'Retirer #legal');
  expect(removed.ts).toBe(reopened.ts);
  expect(removed.blocks.find(block => block.type === 'data_table')!.rows[1][3].element.text.text).toBe('☐ Activer');
});

it('opens the same channel table from menu navigation and typed commands', async () => {
  const h = await harness(), typed = await h.text('yousign canaux');
  const main = await h.click(await h.text('menu'), 'Yousign');
  const page = await h.click(main, 'Choisir les canaux');
  expect(page.ts).toBe(main.ts);
  const typedTable = typed.blocks.find(block => block.type === 'data_table')!, menuTable = page.blocks.find(block => block.type === 'data_table')!;
  expect(menuTable.rows.map((row: any[]) => row.slice(0, 3))).toEqual(typedTable.rows.map((row: any[]) => row.slice(0, 3)));
  expect(menuTable.rows[1][3].element.action_id).toMatch(/^yousign:channel_add~button-\d+$/);
  const selected = await h.click(page, 'Activer #legal');
  expect(selected.ts).toBe(page.ts);
  expect(selected.blocks.find(block => block.type === 'data_table')!.rows[1][2].text).toBe('Activées');
});

it('retains inaccessible selections and hides their rows when current access is lost', async () => {
  const h = await harness(); await h.add('legal');
  const previous = await h.text('yousign canaux');
  h.aliceChannels.splice(h.aliceChannels.findIndex(channel => channel.id === 'GPRIVATE'), 1);
  const updated = await h.click(previous, 'Retirer #legal');
  expect(JSON.stringify(updated)).not.toMatch(/legal|GPRIVATE/);
  expect((await h.sql.query('SELECT channel_id FROM yousign_destinations WHERE active')).rows).toEqual([{ channel_id: 'GPRIVATE' }]);
});

it('shows recovery navigation without an empty table when no channels can be displayed', async () => {
  const h = await harness(); h.aliceChannels.length = 0;
  const empty = await h.text('yousign canaux');
  expect(empty.blocks.some(block => block.type === 'data_table')).toBe(false);
  expect(empty.text).toContain('Aucun canal partagé');
  expect(h.buttons(empty).map(button => button.text.text.replace(/^🧭 /, ''))).toEqual(['Menu', 'Retour à Yousign']);
  h.setDirectoryFailure(true);
  const unavailable = await h.text('yousign canaux');
  expect(unavailable.blocks.some(block => block.type === 'data_table')).toBe(false);
  expect(unavailable.text).toContain('ne peut pas être vérifié');
  expect(h.buttons(unavailable).map(button => button.text.text.replace(/^🧭 /, ''))).toEqual(['Menu', 'Retour à Yousign']);
});

it('keeps previously posted unsuffixed channel controls compatible', async () => {
  const h = await harness(), list = await h.text('yousign canaux');
  const row = list.blocks.find(block => block.type === 'data_table')!.rows.find((row: any[]) => row[0].text === '#sales');
  const legacy = { ...list, blocks: [{ type: 'actions', elements: [{ ...row[3].element, action_id: 'yousign:channel_add', text: { type: 'plain_text', text: 'Activer #sales' } }] }] };
  await h.click(legacy, 'Activer #sales');
  expect((await h.sql.query('SELECT channel_id FROM yousign_destinations WHERE active')).rows).toEqual([{ channel_id: 'CPUBLIC' }]);
});

it('acknowledges durable receipt before Slack, broadcasts once per event/channel, and discards unapproved payload fields', async () => {
  const h = await harness(); await h.add('sales'); await h.add('legal');
  const body = event(); expect((await h.webhook(body)).statusCode).toBe(200);
  expect(h.posts.filter(post => /^[CG]/.test(post.channel))).toHaveLength(0);
  const job = (await h.pending()).rows[0];
  expect(job.actor).toEqual(identity); expect(job.owner).toBe('TTEAM:integration:company-subscription'); expect(job.actor.user).toBeUndefined();
  await h.deliver(); await h.webhook(body); await h.deliver();
  const notifications = h.posts.filter(post => /^[CG]/.test(post.channel));
  expect(notifications.map(post => post.channel)).toEqual(['CPUBLIC', 'GPRIVATE']);
  for (const post of notifications) {
    expect(post.text).toContain('Jean Dupont'); expect(post.text).toContain('02/10/2026 14:32');
    expect(JSON.stringify(post)).not.toMatch(/private@example|sign-token|private-document/);
    expect(post.parse).toBe('none'); expect(post.unfurl_links).toBe(false); expect(post.unfurl_media).toBe(false);
  }
  expect((await h.sql.query('SELECT status FROM yousign_deliveries')).rows.every(row => row.status === 'sent')).toBe(true);
});

it('skips empty selections permanently and accepts sparse unknown events without an event filter', async () => {
  const h = await harness(), skipped = event(); await h.webhook(skipped); await h.add('sales'); await h.webhook(skipped); await h.deliver();
  expect(h.posts.filter(post => post.channel === 'CPUBLIC')).toHaveLength(0);
  const unknown = { ...event('future_resource.changed'), data: { resource: { id: 'resource-id', email: 'private@example.com', raw: 'secret-extra' } } };
  await h.webhook(unknown); await h.deliver();
  const post = h.posts.filter(post => post.channel === 'CPUBLIC').at(-1)!;
  expect(post.text).toContain('future'); expect(post.text).toContain('resource'); expect(JSON.stringify(post)).not.toMatch(/private@example|secret-extra/);
});

it('snapshots destinations, cancels removed waiting work, and prevents remove/re-add or stale Remove from reviving it', async () => {
  const h = await harness(); await h.add('sales'); const oldList = await h.text('yousign channels');
  await h.webhook(event()); await h.add('legal');
  await h.click(oldList, 'Retirer #sales'); await h.add('sales');
  await h.click(oldList, 'Retirer #sales');
  expect((await h.sql.query("SELECT channel_id FROM yousign_destinations WHERE active ORDER BY channel_id")).rows).toEqual([{ channel_id: 'CPUBLIC' }, { channel_id: 'GPRIVATE' }]);
  await h.deliver(); expect(h.posts.filter(post => /^[CG]/.test(post.channel))).toHaveLength(0);
  await h.webhook(event()); await h.deliver();
  expect(h.posts.filter(post => /^[CG]/.test(post.channel)).map(post => post.channel)).toEqual(['CPUBLIC', 'GPRIVATE']);
});

it('recovers a definite rejection after partial fan-out without resending successes or repeating issue alerts', async () => {
  const h = await harness(); await h.add('sales'); await h.add('legal');
  h.failures.set('CPUBLIC', 'rejected'); await h.webhook(event()); await h.deliver();
  expect(h.posts.filter(post => /^[CG]/.test(post.channel)).map(post => post.channel)).toEqual(['GPRIVATE']);
  const alert = h.posts.find(post => post.channel === 'UADMIN')!;
  expect(JSON.stringify(alert)).not.toMatch(/legal|sales|Contrat|Jean|GPRIVATE|CPUBLIC/);
  await h.due(); h.failures.set('CPUBLIC', 'rejected'); await h.deliver();
  expect(h.posts.filter(post => post.channel === 'UADMIN')).toHaveLength(1);
  await h.due(); await h.deliver();
  expect(h.posts.filter(post => /^[CG]/.test(post.channel)).map(post => post.channel)).toEqual(['GPRIVATE', 'CPUBLIC']);
  expect((await h.pending()).rows).toHaveLength(0);
});

it('retains selections on lost bot access and resumes known undelivered work when access returns', async () => {
  const h = await harness(); await h.add('sales'); h.access.set('CPUBLIC', false);
  await h.webhook(event()); await h.deliver();
  expect((await h.sql.query('SELECT * FROM yousign_destinations WHERE active')).rows).toHaveLength(1);
  expect(h.posts.filter(post => post.channel === 'CPUBLIC')).toHaveLength(0);
  h.access.set('CPUBLIC', true); await h.due(); await h.deliver();
  expect(h.posts.filter(post => post.channel === 'CPUBLIC')).toHaveLength(1);
});

it('honors Slack Retry-After even when the rate-limit response is not JSON', async () => {
  const h = await harness(); await h.add('sales'); h.failures.set('CPUBLIC', '429'); await h.webhook(event()); await h.deliver();
  const row = (await h.sql.query('SELECT * FROM yousign_deliveries')).rows[0];
  expect(row.status).toBe('queued'); expect(new Date(row.next_at).getTime()).toBeGreaterThan(Date.now() + 110_000);
  await h.due(); await h.deliver(); expect(h.posts.filter(post => post.channel === 'CPUBLIC')).toHaveLength(1);
});

it('does not repeat uncertain effects and requires exact actor/DM-bound confirmation for a specific resend', async () => {
  const h = await harness(); await h.add('sales'); h.failures.set('CPUBLIC', 'uncertain');
  const body = event(); await h.webhook(body); await h.deliver(); await h.webhook(body); await h.deliver();
  expect(h.posts.filter(post => post.channel === 'CPUBLIC')).toHaveLength(1);
  expect((await h.sql.query('SELECT status FROM yousign_deliveries')).rows[0].status).toBe('uncertain');
  const status = await h.text('yousign statut'); const proposal = await h.click(status, 'Examiner #sales');
  expect(proposal.text).toContain('Contrat'); expect(proposal.text).toContain('doublon');
  await h.click(proposal, 'Confirmer cette relance', bob);
  expect((await h.pending()).rows).toHaveLength(0);
  await h.click(proposal, 'Confirmer cette relance'); await h.click(proposal, 'Confirmer cette relance'); await h.deliver();
  expect(h.posts.filter(post => post.channel === 'CPUBLIC')).toHaveLength(2);
  await h.click(proposal, 'Confirmer cette relance'); await h.deliver();
  expect(h.posts.filter(post => post.channel === 'CPUBLIC')).toHaveLength(2);
});

it('withholds private status details and invalidates an uncertain resend after channel removal or expiry', async () => {
  const h = await harness(); await h.add('legal'); h.failures.set('GPRIVATE', 'uncertain'); await h.webhook(event()); await h.deliver();
  const other = await h.text('yousign status', bob); expect(JSON.stringify(other)).not.toMatch(/legal|Contrat|Jean|GPRIVATE/);
  const proposal = await h.click(await h.text('yousign status'), 'Examiner #legal');
  await h.sql.query("UPDATE yousign_confirmations SET expires_at=now()-interval '1 second'");
  await h.click(proposal, 'Confirmer cette relance'); expect((await h.pending()).rows).toHaveLength(0);
  const next = await h.click(await h.text('yousign status'), 'Examiner #legal');
  await h.click(await h.text('yousign channels'), 'Retirer #legal');
  await h.click(next, 'Confirmer cette relance'); await h.deliver();
  expect(h.posts.filter(post => post.channel === 'GPRIVATE')).toHaveLength(1);
});

it('marks interrupted sending checkpoints uncertain and never repeats an uncertain operator alert', async () => {
  const h = await harness(); await h.add('sales'); await h.webhook(event());
  await h.sql.query("UPDATE yousign_deliveries SET status='sending',attempts=1"); h.setAlertFailure('uncertain'); await h.deliver();
  expect(h.posts.filter(post => post.channel === 'CPUBLIC')).toHaveLength(0);
  expect((await h.sql.query('SELECT status FROM yousign_deliveries')).rows[0].status).toBe('uncertain');
  expect((await h.sql.query('SELECT status FROM yousign_alerts')).rows[0].status).toBe('uncertain');
  await h.webhook(event()); h.failures.set('CPUBLIC', 'rejected'); await h.deliver(); await h.due(); await h.deliver();
  expect(h.posts.filter(post => post.channel === 'UADMIN')).toHaveLength(1);
});

it('rolls back event acceptance when durable enqueue fails and returns a retryable HTTP response', async () => {
  const h = await harness(); await h.add('sales'); h.setEnqueueFailure(true); const body = event();
  expect((await h.webhook(body)).statusCode).toBe(503);
  expect((await h.sql.query('SELECT * FROM yousign_events')).rows).toHaveLength(0);
  expect((await h.sql.query('SELECT * FROM yousign_deliveries')).rows).toHaveLength(0);
  h.setEnqueueFailure(false); expect((await h.webhook(body)).statusCode).toBe(200); await h.deliver();
  expect(h.posts.filter(post => post.channel === 'CPUBLIC')).toHaveLength(1);
});

it('preserves pending recovery metadata during cleanup and isolates integration dispatch from paid User work', async () => {
  const h = await harness(); await h.add('sales'); await h.webhook(event());
  await h.sql.query("UPDATE yousign_events SET finished_at=now()-interval '40 days'");
  await new YousignStore(h.sql, identity).cleanup(); expect((await h.sql.query('SELECT * FROM yousign_events')).rows).toHaveLength(1);
  const job = (await h.pending()).rows[0];
  await expect(dispatchJob(h.sql, config, h.modules, new Slack('bot'), { ...job, actor: { ...identity, integration: 'other' } })).rejects.toThrow('Unexpected integration');
  expect((await h.sql.query('SELECT * FROM ai_calls')).rows).toHaveLength(0);
  await h.deliver(); await h.sql.query("UPDATE yousign_events SET finished_at=now()-interval '40 days'");
  await new YousignStore(h.sql, identity).cleanup(); expect((await h.sql.query('SELECT * FROM yousign_events')).rows).toHaveLength(0);
});

it('allows an already-started post to finish while cancelling later work after removal', async () => {
  const h = await harness(); await h.add('sales'); await h.webhook(event());
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  h.beforePost(async channel => { if (channel === 'CPUBLIC') { entered(); await gate; } });
  const running = h.deliver(); await inside;
  try {
    expect((await h.sql.query('SELECT status FROM yousign_deliveries')).rows[0].status).toBe('sending');
    await h.click(await h.text('yousign channels'), 'Retirer #sales'); await h.webhook(event());
  } finally { release(); await running; }
  await h.deliver(); expect(h.posts.filter(post => post.channel === 'CPUBLIC')).toHaveLength(1);
  expect((await h.sql.query('SELECT status FROM yousign_events ORDER BY created_at')).rows.map(row => row.status)).toEqual(['accepted', 'skipped']);
});

it('retries a definite terminal failure only for its saved attempt and recovers a rejected private alert', async () => {
  const h = await harness(); await h.add('sales'); h.failures.set('CPUBLIC', 'invalid'); h.setAlertFailure('rejected');
  await h.webhook(event()); await h.deliver();
  expect((await h.sql.query('SELECT status FROM yousign_deliveries')).rows[0].status).toBe('failed');
  const failed = await h.text('yousign status');
  await h.due(); await h.deliver(); expect(h.posts.filter(post => post.channel === 'UADMIN')).toHaveLength(1);
  await h.click(failed, 'Réessayer #sales'); await h.deliver();
  await h.click(failed, 'Réessayer #sales'); await h.deliver();
  expect(h.posts.filter(post => post.channel === 'CPUBLIC')).toHaveLength(1);
  expect((await h.sql.query('SELECT attempts FROM yousign_deliveries')).rows[0].attempts).toBe(2);
});

it('cancels a rejected in-flight attempt removed during posting instead of reviving its retry after lost access', async () => {
  const h = await harness(); await h.add('sales'); await h.webhook(event()); h.failures.set('CPUBLIC', 'rejected');
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  h.beforePost(async channel => { if (channel === 'CPUBLIC') { entered(); await gate; } });
  const running = h.deliver(); await inside;
  try { await h.click(await h.text('yousign channels'), 'Retirer #sales'); h.access.set('CPUBLIC', false); }
  finally { release(); await running; }
  expect((await h.sql.query('SELECT status FROM yousign_deliveries')).rows[0].status).toBe('cancelled');
  expect((await h.pending()).rows).toHaveLength(0); expect(h.posts.filter(post => post.channel === 'CPUBLIC')).toHaveLength(0);
});

it('paginates the shared selector and accepts eligible externally shared channels', async () => {
  const h = await harness();
  for (let index = 0; index < 12; index++) h.aliceChannels.push({ id: `CEXTERNAL${index}`, name: `external-${String(index).padStart(2, '0')}`, is_channel: true, is_ext_shared: true });
  const first = await h.text('yousign channels'); expect(first.text).toContain('page 1/2');
  const firstRows = first.blocks.find(block => block.type === 'data_table')!.rows.slice(1);
  expect(firstRows).toHaveLength(10);
  expect(firstRows.every((row: any[]) => row[3].type === 'action_cell')).toBe(true);
  expect(new Set(firstRows.map((row: any[]) => row[3].element.action_id)).size).toBe(10);
  expect(h.buttons(first).some(button => /Actions/.test(button.text.text))).toBe(false);
  const second = await h.click(first, 'Suivant'); expect(second.ts).toBe(first.ts); expect(second.text).toContain('page 2/2');
  expect(second.blocks.find(block => block.type === 'data_table')!.rows.slice(1).map((row: any[]) => row[0].text)).toEqual(['#external-10', '#external-11', '#legal', '#sales']);
  expect(h.buttons(second).some(button => /Actions/.test(button.text.text))).toBe(false);
  const selected = await h.click(second, 'Activer #external-10');
  expect(selected.ts).toBe(first.ts);
  expect(selected.blocks.find(block => block.type === 'data_table')!.rows[1][2].text).toBe('Activées');
  expect((await h.sql.query('SELECT channel_id FROM yousign_destinations WHERE active')).rows).toEqual([{ channel_id: 'CEXTERNAL10' }]);
  const previous = await h.click(selected, 'Précédent');
  expect(previous.ts).toBe(first.ts); expect(previous.text).toContain('page 1/2');
});

it('keeps disabled integration work pending, bypasses deferred integration jobs and preserves User ordering', async () => {
  const h = await harness(); await h.add('sales'); await h.webhook(event());
  const deferred = (await h.pending()).rows[0];
  await new JobStore(h.sql).defer(deferred.id, new Date(Date.now() + 3600_000));
  await h.webhook(event()); const ready = (await h.pending()).rows.find(row => row.id !== deferred.id)!;
  const jobs = new JobStore(h.sql);
  await jobs.enqueue('a-user-deferred', alice, { type: 'text', text: 'help' }, 'yousign');
  await jobs.defer('a-user-deferred', new Date(Date.now() + 3600_000));
  await jobs.enqueue('b-user-following', alice, { type: 'text', text: 'help' }, 'yousign');
  await jobs.enqueue('core-navigation', alice, { type: 'text', text: 'menu' });
  const query = (text: string, values?: any[]) => text.includes('pg_try_advisory_lock') ? Promise.resolve({ rows: [{ locked: true }] })
    : text.includes('pg_advisory_unlock') ? Promise.resolve({ rows: [{}] }) : h.sql.query(text, values);
  const pool = { query, async connect() { return { query, transaction: h.sql.transaction, release() {} }; } } as unknown as Pool;
  const runUntil = async (modules: ModuleRegistry, id: string) => {
    const stop = worker(pool, { ...config, WORKER_CONCURRENCY: 1 }, modules, h.messenger);
    try {
      const deadline = Date.now() + 3000;
      while ((await h.sql.query('SELECT status FROM jobs WHERE id=$1', [id])).rows[0].status !== 'done') {
        if (Date.now() > deadline) throw new Error('Worker did not complete eligible work');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { await stop(); }
  };
  await runUntil(new ModuleRegistry([]), 'core-navigation'); expect((await h.pending()).rows).toHaveLength(2);
  await runUntil(new ModuleRegistry([{ ...h.module, cleanup: undefined }]), ready.id);
  expect(h.posts.filter(post => post.channel === 'CPUBLIC')).toHaveLength(1);
  expect((await h.sql.query("SELECT id,status FROM jobs WHERE id IN ('a-user-deferred','b-user-following') ORDER BY id")).rows).toEqual([
    { id: 'a-user-deferred', status: 'queued' }, { id: 'b-user-following', status: 'queued' }]);
  expect((await h.pending()).rows.map(row => row.id)).toEqual([deferred.id]);
});
