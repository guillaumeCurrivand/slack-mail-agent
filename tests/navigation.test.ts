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
import { JobStore, type Sql } from '../src/core/store.js';
import { Store } from '../src/modules/mail/store.js';
import { starterRules } from '../src/modules/mail/domain.js';

const alice = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
const bob = { ...alice, user: 'UBOB', channel: 'DBOB' };
const env = { PUBLIC_URL: 'https://agent.example.com', DATABASE_URL: 'postgresql://unused', SLACK_TEAM_ID: 'TTEAM', SLACK_BOT_TOKEN: 'token', SLACK_SIGNING_SECRET: 'secret', ENABLED_MODULES: 'slack' };
const mailEnv = { ...env, ENABLED_MODULES: 'mail,slack', ENCRYPTION_KEY: randomBytes(32).toString('base64'), GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_WORKSPACE_DOMAINS: 'example.com', OPENAI_API_KEY: 'unused' };
let db: PGlite, sql: Sql;
beforeAll(async () => { db = new PGlite(); await db.exec(schema); sql = { query: (text, values) => db.query(text, values) }; });
beforeEach(async () => {
  await db.exec('TRUNCATE users,jobs,oauth_states,ai_calls,ai_months,core_navigation_menus,core_navigation_deliveries CASCADE');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external provider call'); }));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => db.close());

type Posted = { method: string; body: any; ts: string };
function buttons(message: Posted) { return message.body.blocks.flatMap((block: any) => block.elements ?? []); }
function button(message: Posted, label: string) { const found = buttons(message).find((item: any) => item.text.text === label); expect(found, label).toBeTruthy(); return found; }
async function harness(overrides: NodeJS.ProcessEnv = env, additionalModules: AssistantModule[] = []) {
  const config = readConfig(overrides), modules = new ModuleRegistry([...createModules(config, sql, overrides).all(), ...additionalModules]);
  for (const module of modules.all()) await module.initialize?.({ query: async text => (await db.exec(text)).at(-1)! });
  const app = createServer(config, new JobStore(sql), modules);
  const messages: Posted[] = [];
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
    for (const job of jobs) { await dispatchJob(sql, config, modules, slack, job); await sql.query("UPDATE jobs SET status='done' WHERE id=$1", [job.id]); }
    return messages.at(-1)!;
  };
  const dm = async (text: string, actor = alice) => {
    expect((await post('/slack/events', JSON.stringify({ type: 'event_callback', team_id: actor.team, event_id: randomUUID(), event: { type: 'message', channel_type: 'im', user: actor.user, channel: actor.channel, text } }), 'application/json')).statusCode).toBe(200);
    return drain();
  };
  const click = async (source: Posted, label: string, actor = alice, ts = source.ts) => {
    const selected = button(source, label);
    const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: actor.team }, user: { id: actor.user }, channel: { id: actor.channel }, message: { ts }, actions: [{ action_id: selected.action_id, value: selected.value, action_ts: randomUUID() }] }) }).toString();
    expect((await post('/slack/actions', raw, 'application/x-www-form-urlencoded')).statusCode).toBe(200);
    return drain();
  };
  return { dm, click, messages, post, drain, get: (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} }), failNext: (outcome: 'reject' | 'uncertain') => { failure = outcome; }, close: () => app.close() };
}

it('discovers enabled modules and shared commands in a private main menu without Gmail or AI', async () => {
  const h = await harness();
  try {
    for (const command of ['menu', 'help', 'hello']) {
      const menu = await h.dm(command);
      expect(menu.body.channel).toBe('DALICE');
      expect(buttons(menu).map((item: any) => item.text.text)).toEqual(['Slack Unanswered', 'Budget', 'Help']);
    }
    const guidance = await h.dm('sort');
    expect(guidance.body.text).toContain('prefix');
    button(guidance, 'Menu');
  } finally { await h.close(); }
});

it('updates only the clicked menu, checks ownership and keeps module selection out of typed routing', async () => {
  const h = await harness();
  try {
    const first = await h.dm('menu'), second = await h.dm('menu');
    const module = await h.click(first, 'Slack Unanswered');
    expect(module.method).toBe('chat.update');
    expect(module.ts).toBe(first.ts);
    expect(module.body.text).toContain('slack channels');
    const main = await h.click(module, 'Back to menu');
    expect(main.ts).toBe(first.ts);
    const budget = await h.click(second, 'Budget');
    expect(budget.ts).toBe(second.ts);
    expect(budget.body.text).toContain('allowance');
    const help = await h.click(main, 'Help');
    expect(help.body.text).toContain('prefix');
    const updates = h.messages.filter(message => message.method === 'chat.update').length;
    await h.click(first, 'Slack Unanswered', bob);
    await h.click(first, 'Slack Unanswered', alice, second.ts);
    expect(h.messages.filter(message => message.method === 'chat.update')).toHaveLength(updates);
    expect((await h.dm('channels')).body.text).toContain('prefix');
  } finally { await h.close(); }
});

it('connects through the existing invitation and confirms disconnect without erasing saved rules', async () => {
  const h = await harness(mailEnv);
  try {
    const main = await h.dm('menu');
    const mail = await h.click(main, 'Mail Sorter');
    expect(mail.body.text).toContain('mail sort');
    const connection = await h.click(mail, 'Gmail connection');
    expect(connection.body.text).toContain('not connected');
    const invitation = await h.click(connection, 'Connect Gmail');
    expect(invitation.method).toBe('chat.postMessage');
    expect(invitation.body.text).toContain('single-use');
    const connectUrl = invitation.body.blocks.find((block: any) => block.type === 'markdown').text.match(/https:\/\/agent\.example\.com\/auth\/google\?ticket=[\w-]+/)[0];
    const path = new URL(connectUrl).pathname + new URL(connectUrl).search;
    const redirect = await h.get(path);
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toContain('accounts.google.com');
    expect((await h.get(path)).statusCode).toBe(400);
    expect((await h.click(mail, 'Gmail connection')).body.text).toContain('not connected');
    const returned = await h.click(invitation, 'Menu');
    expect(returned.method).toBe('chat.postMessage');
    expect(returned.ts).not.toBe(invitation.ts);

    const store = new Store(sql), state = await store.load(alice);
    state.connection = { id: 'connection-1', subject: 'google-alice', email: 'alice@example.com', encryptedTokens: 'unused' };
    state.rules = starterRules().map((rule, index) => ({ ...rule, id: `rule-${index}` }));
    state.runs.push({ id: 'saved-preview', created: new Date().toISOString(), ruleVersion: state.ruleVersion, connectionId: state.connection.id, status: 'preview', items: [] });
    await store.save(alice, state);
    const connected = await h.click(mail, 'Gmail connection');
    expect(connected.body.text).toContain('alice@example.com');
    const proposal = await h.click(connected, 'Disconnect Gmail');
    expect(proposal.body.text).toContain('cancel all pending previews');
    // Opening the confirmation does not disconnect the account.
    expect((await h.click(mail, 'Gmail connection')).body.text).toContain('alice@example.com');
    const result = await h.click(proposal, 'Disconnect Gmail');
    expect(result.body.text).toContain('Gmail disconnected');
    expect((await h.click(mail, 'Gmail connection')).body.text).toContain('not connected');
    expect((await h.click(proposal, 'Disconnect Gmail')).body.text).toContain('no longer current');
    expect((await h.dm('mail rules')).body.text).toContain('Urgent');
    expect((await h.dm('mail report')).body.text).toContain('cancelled');
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
    expect(buttons(fresh).map((item: any) => item.text.text)).toEqual(['Budget', 'Help']);
    const unavailable = await h.click(old, 'Slack Unanswered');
    expect(unavailable.method).toBe('chat.update');
    expect(unavailable.ts).toBe(old.ts);
    expect(unavailable.body.text).toContain('not currently enabled');
    expect((await h.click(unavailable, 'Back to menu')).body.text).toContain('No modules');
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
    await expect(h.click(menu, 'Slack Unanswered')).rejects.toThrow('Connection lost');
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
    expect((await h.click(module, 'Back to menu')).body.text).toContain('Choose a module');
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
    const mail = await h.click(await h.dm('menu'), 'Mail Sorter');
    const connection = await h.click(mail, 'Gmail connection');
    const invite = await h.click(connection, 'Connect Gmail');
    const link = new URL(invite.body.blocks.find((block: any) => block.type === 'markdown').text.match(/https:\/\/agent\.example\.com\/auth\/google\?ticket=[\w-]+/)[0]);
    const start = await h.get(link.pathname + link.search);
    const authorize = new URL(String(start.headers.location));
    nonce = authorize.searchParams.get('nonce')!;
    const callback = `/auth/google/callback?state=${authorize.searchParams.get('state')}&code=fake-code`;
    expect((await h.get(callback, String(start.headers['set-cookie']).split(';')[0])).statusCode).toBe(200);
    const proposal = await h.drain();
    expect(proposal.body.blocks[0].text.text).toBe('Confirm mailbox');
    expect(proposal.body.channel).toBe('DALICE');
    expect((await h.click(mail, 'Gmail connection')).body.text).toContain('not connected');
    expect((await h.click(proposal, 'Connect this mailbox', bob)).body.text).toContain('unavailable');
    expect((await h.click(mail, 'Gmail connection')).body.text).toContain('not connected');
    expect((await h.click(proposal, 'Connect this mailbox')).body.text).toContain('Connected alice@example.com');
    expect((await h.click(mail, 'Gmail connection')).body.text).toContain('alice@example.com');
    expect((await h.get(callback, String(start.headers['set-cookie']).split(';')[0])).statusCode).toBe(400);
    expect((await h.click(proposal, 'Connect this mailbox')).body.text).toContain('already handled');
  } finally { await h.close(); }
});
