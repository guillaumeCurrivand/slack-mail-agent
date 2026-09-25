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
  await db.exec('TRUNCATE users,jobs,oauth_states,ai_calls,ai_months,core_navigation_menus,core_navigation_deliveries CASCADE; DROP TABLE IF EXISTS slack_selected_channels,slack_handled_events,slack_ai_attempts');
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
  const click = async (source: Posted, label: string, actor = alice, ts = source.ts, clickId = randomUUID()) => {
    const selected = button(source, label);
    const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: actor.team }, user: { id: actor.user }, channel: { id: actor.channel }, message: { ts }, actions: [{ action_id: selected.action_id, value: selected.value, action_ts: clickId }] }) }).toString();
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
    const module = await h.click(main, 'Slack Unanswered');
    const first = await h.click(module, 'Choose channels');
    expect(first.method).toBe('chat.update');
    expect(first.ts).toBe(main.ts);
    expect(first.body.text).toContain('page 1/2');
    const second = await h.click(first, 'Next');
    expect(second.ts).toBe(first.ts);
    expect(second.body.text).toContain('channel-11');
    const added = await h.click(second, 'Add #channel-11');
    expect(added.method).toBe('chat.update');
    expect(added.ts).toBe(first.ts);
    expect(added.body.text).toContain('Selected channels: 1');
    button(added, 'Remove #channel-11');
    const removed = await h.click(added, 'Remove #channel-11');
    expect(removed.body.text).toContain('Selected channels: 0');
    button(removed, 'Add #channel-11');
    channelCount = 1;
    const adjusted = await h.click(first, 'Next');
    expect(adjusted.body.text).toContain('page 1/1');
    expect(adjusted.body.text).not.toContain('channel-11');
    const back = await h.click(adjusted, 'Back to Slack Unanswered');
    expect(back.ts).toBe(main.ts);
    expect(back.body.text).toContain('Choose channels');
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
    const bobAttempt = await h.click(first, 'Add #planning', bob);
    expect(bobAttempt.body.text).toContain('unavailable');
    expect(bobAttempt.body.text).not.toContain('planning');
    accessible = false;
    const changed = await h.click(first, 'Add #planning');
    expect(changed.body.text).toContain('no longer available');
    expect(changed.body.text).toContain('Selected channels: 0');
    accessible = true;
    const added = await h.click(first, 'Add #planning');
    expect(added.body.text).toContain('Selected channels: 1');
    accessible = false;
    const unavailable = await h.click(first, 'Add #planning');
    expect(unavailable.body.text).toContain('Unavailable selected channel GPRIVATE');
    expect(unavailable.body.text).not.toContain('planning');
    const removed = await h.click(unavailable, 'Remove GPRIVATE');
    expect(removed.body.text).toContain('Selected channels: 0');
    expect(removed.body.text).toContain('No shared public or private channels');
    accessible = true;
    const messagesAfterRemove = h.messages.length;
    await sql.query("UPDATE jobs SET status='queued',available_at=now() WHERE module='slack' AND payload->>'action'='channel_select'");
    await h.drain();
    expect(h.messages).toHaveLength(messagesAfterRemove);
    const current = await h.dm('slack channels');
    expect(current.body.text).toContain('Selected channels: 0');
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
    const updated = await h.click(list, 'Add #general');
    expect(updated.method).toBe('chat.update');
    expect(updated.body.text).toContain('Selected channels: 1');
    expect(updated.body.text).toContain('access unavailable');
    expect(updated.body.text).not.toContain('selections are unchanged');
    button(updated, 'Remove CPUBLIC');
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
    const guidance = await disabled.click(list!, 'Add #general');
    expect(guidance.body.text).toContain('not sent to a module');
    expect(guidance.body.text).not.toContain('general');
    expect(provider).not.toHaveBeenCalled();
  } finally { await disabled.close(); }
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

it('browses mail rules in place and posts Add/Edit instructions without changing saved state or routing', async () => {
  const h = await harness(mailEnv);
  try {
    const store = new Store(sql), state = await store.load(alice);
    state.rules = Array.from({ length: 7 }, (_, index) => ({ ...starterRules()[0]!, id: `rule-${index}`, name: `Priority ${index}` }));
    await store.save(alice, state);
    const mail = await h.click(await h.dm('menu'), 'Mail Sorter');
    const rules = await h.click(mail, 'Manage rules');
    expect(rules.method).toBe('chat.update');
    expect(rules.body.text).toContain('Priority 0');
    expect(rules.body.text).not.toContain('Priority 6');
    const next = await h.click(rules, 'Next');
    expect(next.ts).toBe(rules.ts);
    expect(next.body.text).toContain('Priority 3');
    const edit = await h.click(next, 'Edit 1');
    expect(edit.method).toBe('chat.postMessage');
    expect(edit.body.text).toContain('mail');
    expect(edit.body.text).toContain('rule-3');
    expect((await h.click(rules, 'Add rule')).body.text).toContain('mail');
    expect((await h.dm('change Priority 0')).body.text).toContain('prefix');
    expect((await h.click(await h.dm('menu', bob), 'Mail Sorter', bob)).body.text).not.toContain('Priority');
    expect((await h.click(mail, 'Latest report')).body.text).toContain('No retained run');
    expect(buttons(mail).some((item: any) => item.text.text === 'Pending approvals')).toBe(false);
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
    const mail = await h.click(await h.dm('menu'), 'Mail Sorter');
    const rules = await h.click(mail, 'Manage rules');
    expect(rules.body.text).toContain('No approved rules');
    const requestId = randomUUID();
    const proposal = await h.click(rules, 'Starter rules', alice, rules.ts, requestId);
    const delivered = h.messages.length;
    await h.click(rules, 'Starter rules', alice, rules.ts, requestId);
    expect(h.messages).toHaveLength(delivered);
    const approval = button(proposal, 'Approve rule changes');
    expect((await h.click(mail, 'Manage rules')).body.text).toContain('No approved rules');
    const pending = await h.click(await h.click(mail, 'Back to menu').then(main => h.click(main, 'Mail Sorter')), 'Pending approvals');
    const reopened = await h.click(pending, 'Open 1');
    expect(reopened.method).toBe('chat.postMessage');
    expect(button(reopened, 'Approve rule changes').value).toBe(approval.value);
    expect(reopened.body.text).toContain('Examples:');
    expect((await h.click(reopened, 'Approve rule changes', bob)).body.text).toContain('unavailable');
    await h.click(reopened, 'Approve rule changes');
    const saved = await h.click(mail, 'Manage rules');
    expect(saved.body.text).toContain('Urgent');
    expect((await h.click(reopened, 'Approve rule changes')).body.text).toContain('already handled');
    const remove = await h.click(saved, 'Remove 1');
    expect(remove.body.text).toContain('Remove rule Urgent');
    expect((await h.click(mail, 'Manage rules')).body.text).toContain('Urgent');
    await h.click(remove, 'Approve rule changes');
    expect((await h.click(mail, 'Manage rules')).body.text).not.toContain('Urgent');
    expect((await h.click(saved, 'Remove 1')).body.text).toContain('no longer available');
    expect((await h.click(pending, 'Open 1')).body.text).toContain('unavailable');
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
    const mail = await h.click(await h.dm('menu'), 'Mail Sorter');
    const pending = await h.click(mail, 'Pending approvals');
    expect(pending.body.text).toContain('page 1/2');
    const next = await h.click(pending, 'Next');
    expect(next.ts).toBe(pending.ts);
    expect(next.body.text).toContain('preview-1');
    expect(next.body.text).not.toMatch(/expired|wrong-version|disconnected/);
    const reopened = await h.click(next, 'Open 2');
    expect(reopened.method).toBe('chat.postMessage');
    expect(button(reopened, 'Confirm proposed changes').value).toBe('preview-1');
    expect((await h.click(next, 'Open 2', bob)).body.text).toContain('unavailable');
    const report = await h.click(mail, 'Latest report');
    expect(report.body.text).toContain('done');
    expect(button(report, 'Undo this run').value).toBe('done');
    expect((await h.click(report, 'Details')).body.text).toContain('Run done');
    const saved = await store.load(alice);
    expect(saved.runs).toEqual(state.runs);
    expect(saved.drafts).toEqual(state.drafts);
    expect(saved.history).toEqual(state.history);
    saved.ruleVersion++;
    await store.save(alice, saved);
    expect((await h.click(next, 'Open 2')).body.text).toContain('connection/rules changed');
    expect((await h.click(reopened, 'Confirm proposed changes')).body.text).toContain('connection/rules changed');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it('retains saved-item identity through a restart and suppresses uncertain redelivery', async () => {
  const store = new Store(sql), state = await store.load(alice);
  state.drafts.push({ id: 'retained', kind: 'rules', created: new Date().toISOString(), rules: starterRules() });
  await store.save(alice, state);
  const first = await harness(mailEnv);
  const pending = await first.click(await first.click(await first.dm('menu'), 'Mail Sorter'), 'Pending approvals');
  await first.close();
  const h = await harness(mailEnv);
  try {
    h.failNext('reject');
    await expect(h.click(pending, 'Open 1')).rejects.toThrow('rejected');
    const reopened = await h.drain();
    expect(button(reopened, 'Approve rule changes').value).toBe('retained');
    h.failNext('uncertain');
    await expect(h.click(pending, 'Open 1')).rejects.toThrow('Connection lost');
    const count = h.messages.length;
    await h.drain();
    expect(h.messages).toHaveLength(count);
    const unchanged = await store.load(alice);
    expect(unchanged.drafts).toEqual(state.drafts);
    await h.click(reopened, 'Cancel');
    expect((await h.click(pending, 'Open 1')).body.text).toContain('already handled');
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
    const mail = await h.click(await h.dm('menu'), 'Mail Sorter');
    const report = await h.click(mail, 'Latest report');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect((await h.click(report, 'Undo this run', bob)).body.text).toContain('not available');
    const result = await h.click(report, 'Undo this run');
    expect(result.body.text).toContain('undone');
    expect(mutations).toEqual([{ addLabelIds: [], removeLabelIds: ['URGENT'] }]);
    const details = await h.click(result, 'Details');
    expect(details.body.text).toContain('message changed since this run');
    await h.click(report, 'Undo this run');
    expect(mutations).toHaveLength(1);
  } finally { await h.close(); }
});

it('bounds long rule summaries while retaining every page and action', async () => {
  const store = new Store(sql), state = await store.load(alice);
  state.rules = Array.from({ length: 40 }, (_, index) => ({ ...starterRules()[0]!, id: `long-${index}`, name: `Long rule ${index}`, condition: '*'.repeat(1200), senders: Array.from({ length: 100 }, (_, n) => `${'x'.repeat(60)}${n}@example.com`), labels: Array.from({ length: 10 }, () => '_'.repeat(100)) }));
  await store.save(alice, state);
  const h = await harness(mailEnv);
  try {
    let page = await h.click(await h.click(await h.dm('menu'), 'Mail Sorter'), 'Manage rules');
    for (let n = 0; n < 14; n++) {
      const text = page.body.blocks.find((block: any) => block.type === 'markdown').text;
      expect(text.length).toBeLessThan(12_000);
      expect(text).toContain(`Long rule ${n * 3}`);
      expect(text).toContain('summarized');
      button(page, 'Edit 1'); button(page, 'Remove 1'); button(page, 'Back to menu');
      if (n < 13) page = await h.click(page, 'Next');
    }
    expect(buttons(page).some((item: any) => item.text.text === 'Next')).toBe(false);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.close(); }
});
