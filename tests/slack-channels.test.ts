import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readConfig } from '../src/app/config.js';
import { createModules } from '../src/app/modules.js';
import { schema } from '../src/app/schema.js';
import type { Actor } from '../src/core/identity.js';
import { createServer } from '../src/core/server.js';
import { Slack, SlackDeliveryRejected, type AgentMessage, type Messenger } from '../src/core/slack.js';
import { JobStore, type Sql } from '../src/core/store.js';
import { worker } from '../src/core/worker.js';
import { SlackChannelSelections } from '../src/modules/slack/store.js';

const env = { PUBLIC_URL: 'https://agent.example.com', DATABASE_URL: 'postgresql://unused', SLACK_TEAM_ID: 'TTEAM', SLACK_BOT_TOKEN: 'token', SLACK_SIGNING_SECRET: 'secret', ENABLED_MODULES: 'slack' };
const alice: Actor = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
const bob: Actor = { team: 'TTEAM', user: 'UBOB', channel: 'DBOB' };
let db: PGlite, sql: Sql;

beforeAll(async () => { db = new PGlite(); await db.exec(schema); sql = { query: (text, values) => db.query(text, values) }; });
beforeEach(async () => { await db.exec('TRUNCATE users,jobs,oauth_states,ai_calls,ai_months CASCADE; DROP TABLE IF EXISTS slack_selected_channels,slack_handled_events,slack_ai_attempts'); });
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => db.close());

function fakeChannels() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const request = new URL(url);
    expect(request.pathname).toBe('/api/users.conversations');
    expect(request.searchParams.get('user')).toBe('UALICE');
    expect(request.searchParams.get('types')).toBe('public_channel,private_channel');
    const secondPage = request.searchParams.get('cursor') === 'next';
    return { ok: true, json: async () => secondPage
      ? { ok: true, channels: [
        { id: 'GPRIVATE', name: 'planning', is_group: true, is_private: true },
        { id: 'CPRIVATE', name: 'newplanning', is_channel: true, is_group: false, is_private: true },
        { id: 'GMPIM', name: 'group-dm', is_mpim: true },
      ], response_metadata: { next_cursor: '' } }
      : { ok: true, channels: [{ id: 'CPUBLIC', name: 'general', is_channel: true, is_private: false }], response_metadata: { next_cursor: 'next' } } };
  }));
}

async function harness(runtimeEnv: NodeJS.ProcessEnv = env, sendThroughSlack = false) {
  const runtimeConfig = readConfig(runtimeEnv);
  const modules = createModules(runtimeConfig, sql, runtimeEnv);
  for (const module of modules.all()) await module.initialize?.(sql);
  const app = createServer(runtimeConfig, new JobStore(sql), modules);
  const messages: Array<{ actor: Actor; message: AgentMessage }> = [];
  let failAfterDelivery = false;
  let rejectBeforeDelivery = false;
  const messenger: Messenger = { async send(actor, message) {
    if (rejectBeforeDelivery) { rejectBeforeDelivery = false; throw new SlackDeliveryRejected('Rejected'); }
    if (sendThroughSlack) await new Slack(runtimeConfig.SLACK_BOT_TOKEN).send(actor, message);
    messages.push({ actor, message });
    if (failAfterDelivery) { failAfterDelivery = false; throw new Error('Delivery outcome uncertain'); }
  } };
  const query = (text: string, values?: any[]) => text.includes('pg_try_advisory_lock')
    ? Promise.resolve({ rows: [{ locked: true }] }) : text.includes('pg_advisory_unlock')
      ? Promise.resolve({ rows: [{}] }) : sql.query(text, values);
  const pool = { query, async connect() { return { query, release() {} }; } } as unknown as Pool;
  const post = (path: string, raw: string, contentType: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return app.inject({ method: 'POST', url: path, payload: raw, headers: { 'content-type': contentType,
      'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${createHmac('sha256', 'secret').update(`v0:${timestamp}:${raw}`).digest('hex')}` } });
  };
  const receive = async () => {
    const before = messages.length;
    const stop = worker(pool, { ...runtimeConfig, WORKER_CONCURRENCY: 1 }, modules, messenger);
    try {
      const start = Date.now();
      while (messages.length === before && Date.now() - start < 3000) await new Promise(resolve => setTimeout(resolve, 20));
      expect(messages.length).toBeGreaterThan(before);
      return messages.at(-1)!;
    } finally { await stop(); }
  };
  const postDm = async (text: string, actor = alice, requestedAt?: Date) => {
    const eventId = `event-${crypto.randomUUID()}`;
    const raw = JSON.stringify({ type: 'event_callback', team_id: actor.team, event_id: eventId,
      event: { type: 'message', channel_type: 'im', user: actor.user, channel: actor.channel, text } });
    expect((await post('/slack/events', raw, 'application/json')).statusCode).toBe(200);
    if (requestedAt) await sql.query('UPDATE jobs SET created_at=$1 WHERE id=$2', [requestedAt, `slack:${eventId}`]);
  };
  const dm = async (text: string, actor = alice, requestedAt?: Date) => { await postDm(text, actor, requestedAt); return receive(); };
  const postAction = async (button: NonNullable<AgentMessage['buttons']>[number], actor = alice) => {
    const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: actor.team }, user: { id: actor.user },
      channel: { id: actor.channel }, actions: [{ action_id: button.action, value: button.value, action_ts: crypto.randomUUID() }] }) }).toString();
    expect((await post('/slack/actions', raw, 'application/x-www-form-urlencoded')).statusCode).toBe(200);
  };
  const click = async (button: NonNullable<AgentMessage['buttons']>[number], actor = alice) => { await postAction(button, actor); return receive(); };
  const drain = async () => {
    const stop = worker(pool, { ...runtimeConfig, WORKER_CONCURRENCY: 1 }, modules, messenger);
    try { await new Promise(resolve => setTimeout(resolve, 650)); } finally { await stop(); }
  };
  return { dm, postDm, click, postAction, drain, messages, failNextDelivery: () => { failAfterDelivery = true; },
    rejectNextDelivery: () => { rejectBeforeDelivery = true; }, close: () => app.close() };
}

it('lists only shared public and private channels from a signed Slack DM without Gmail credentials', async () => {
  fakeChannels();
  const h = await harness();
  try {
    const { actor, message } = await h.dm('slack channels');
    expect(actor).toEqual(alice);
    expect(message.text).toContain('general');
    expect(message.text).toContain('planning');
    expect(message.text).toContain('newplanning');
    expect(message.text).not.toContain('group-dm');
    expect(message.buttons?.map(button => button.action)).toEqual(['slack:channel_select', 'slack:channel_select', 'slack:channel_select']);
  } finally { await h.close(); }
});

it('delivers channel selection buttons with distinct action IDs in each Slack actions block', async () => {
  const posted: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const request = new URL(url);
    if (request.pathname.endsWith('/users.conversations')) return Response.json({ ok: true, channels: [
      { id: 'CONE', name: 'one', is_channel: true, is_private: false },
      { id: 'CTWO', name: 'two', is_channel: true, is_private: false },
    ], response_metadata: { next_cursor: '' } });
    if (request.pathname.endsWith('/chat.postMessage')) {
      const body = JSON.parse(String(options?.body));
      posted.push(body);
      const valid = body.blocks.filter((block: any) => block.type === 'actions').every((block: any) =>
        new Set(block.elements.map((element: any) => element.action_id)).size === block.elements.length);
      return Response.json(valid ? { ok: true } : { ok: false, error: 'invalid_blocks' });
    }
    throw new Error(`Unexpected Slack API: ${request.pathname}`);
  }));
  const h = await harness(env, true);
  try {
    await h.postDm('slack channels');
    await h.drain();
    expect(posted).toHaveLength(1);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]!.message.buttons).toHaveLength(2);
  } finally { await h.close(); }
});

it('routes a signed slack request to shared guidance without running a disabled module', async () => {
  const provider = vi.fn(async () => { throw new Error('Disabled Slack module called a provider.'); });
  vi.stubGlobal('fetch', provider);
  const h = await harness({ ...env, ENABLED_MODULES: '' });
  try {
    const reply = await h.dm('slack unanswered');
    expect(reply.actor).toEqual(alice);
    expect(reply.message.kind).toBe('Help');
    expect(reply.message.text).toContain('This request was not sent to a module.');
    expect(reply.message.text).toContain('No modules are currently enabled.');
    expect(provider).not.toHaveBeenCalled();
    expect((await sql.query('SELECT module FROM jobs')).rows).toEqual([{ module: 'core' }]);
  } finally { await h.close(); }
});

it('keeps each user selection across restarts and temporary access loss until that user removes it', async () => {
  let aliceCanSeePrivate = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const user = new URL(url).searchParams.get('user');
    const publicChannel = { id: 'CPUBLIC', name: 'general', is_channel: true, is_private: false };
    const privateChannel = { id: 'GPRIVATE', name: 'planning', is_group: true, is_private: true };
    return { ok: true, json: async () => ({ ok: true, channels: user === alice.user && aliceCanSeePrivate
      ? [publicChannel, privateChannel] : [publicChannel], response_metadata: { next_cursor: '' } }) };
  }));
  const first = await harness();
  try {
    const list = await first.dm('slack channels');
    const selectPrivate = list.message.buttons!.find(button => button.value.startsWith('GPRIVATE|'))!;
    expect((await first.click(selectPrivate)).message.text).toContain('Selected channels: 1');
    expect((await first.click(selectPrivate)).message.text).toContain('Selected channels: 1');
  } finally { await first.close(); }

  const second = await harness();
  try {
    expect((await second.dm('slack channels')).message.text).toContain('Selected channels: 1');
    const bobList = await second.dm('slack channels', bob);
    expect(bobList.actor).toEqual(bob);
    expect(bobList.message.text).toContain('Selected channels: 0');
    expect(bobList.message.text).not.toContain('planning');
    const aliceList = await second.dm('slack channels');
    const oldPrivateButton = aliceList.message.buttons!.find(button => button.value.startsWith('GPRIVATE|'))!;
    expect((await second.click(oldPrivateButton, bob)).message.text).toContain('Selected channels: 0');

    aliceCanSeePrivate = false;
    const unavailable = await second.dm('slack channels');
    expect(unavailable.message.text).toContain('Unavailable selected channel GPRIVATE');
    expect(unavailable.message.text).toContain('Selected channels: 1');
    aliceCanSeePrivate = true;
    const restored = await second.dm('slack channels');
    expect(restored.message.text).toContain('Selected channels: 1');
    const removePrivate = restored.message.buttons!.find(button => button.value.startsWith('GPRIVATE|'))!;
    expect(removePrivate.action).toBe('slack:channel_remove');
    const removed = await second.click(removePrivate);
    expect(removed.message.text).toContain('Selected channels: 0');
    expect((await second.dm('slack channels')).message.text).toContain('Selected channels: 0');
    await second.click(removed.message.buttons!.find(button => button.value.startsWith('GPRIVATE|'))!);
    aliceCanSeePrivate = false;
    const inaccessible = await second.dm('slack channels');
    const removeInaccessible = inaccessible.message.buttons!.find(button => button.value.startsWith('GPRIVATE|'))!;
    expect(removeInaccessible.action).toBe('slack:channel_remove');
    expect((await second.click(removeInaccessible)).message.text).toContain('Selected channels: 0');
    aliceCanSeePrivate = true;
    expect((await second.dm('slack channels')).message.text).toContain('Selected channels: 0');
  } finally { await second.close(); }
});

it('paginates long channel lists and keeps page controls private to the requesting user', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true,
    channels: Array.from({ length: 12 }, (_, index) => ({ id: `CCHANNEL${index}`, name: `channel-${String(index).padStart(2, '0')}`, is_channel: true, is_private: false })),
    response_metadata: { next_cursor: '' } }) })));
  const h = await harness();
  try {
    const first = await h.dm('slack channels');
    expect(first.message.text).toContain('page 1/2');
    expect(first.message.text).not.toContain('channel-11');
    const next = first.message.buttons!.find(button => button.action === 'slack:channel_page' && button.label === 'Next')!;
    const second = await h.click(next);
    expect(second.actor).toEqual(alice);
    expect(second.message.text).toContain('page 2/2');
    expect(second.message.buttons?.some(button => button.label.includes('channel-11'))).toBe(true);
    expect(second.message.buttons).toHaveLength(3);
    const selected = await h.click(second.message.buttons!.find(button => button.value.startsWith('CCHANNEL11|'))!);
    expect(selected.message.text).toContain('Selected channels: 1');
    expect(selected.message.text).toContain('page 2/2');
  } finally { await h.close(); }
});

it('does not repeat a private response when a processed selection job is replayed', async () => {
  fakeChannels();
  const h = await harness();
  try {
    const list = await h.dm('slack channels');
    const select = list.message.buttons!.find(button => button.value.startsWith('GPRIVATE|'))!;
    await h.click(select);
    const delivered = h.messages.length;
    await sql.query("UPDATE jobs SET status='queued',available_at=now(),payload=$1 WHERE module='slack' AND id LIKE 'action:%'", [JSON.stringify({ type: 'action', action: 'channel_select', value: select.value })]);
    await h.drain();
    expect(h.messages).toHaveLength(delivered);
    expect((await h.dm('slack channels')).message.text).toContain('Selected channels: 1');
  } finally { await h.close(); }
});

it('does not blindly resend a selection response after an uncertain delivery outcome', async () => {
  fakeChannels();
  const h = await harness();
  try {
    const list = await h.dm('slack channels');
    const select = list.message.buttons!.find(button => button.value.startsWith('GPRIVATE|'))!;
    h.failNextDelivery();
    await h.click(select);
    const delivered = h.messages.length;
    await sql.query("UPDATE jobs SET available_at=now() WHERE module='slack' AND status='queued' AND id LIKE 'action:%'");
    await h.drain();
    expect(h.messages).toHaveLength(delivered);
    expect((await h.dm('slack channels')).message.text).toContain('Selected channels: 1');
  } finally { await h.close(); }
});

it('retains an old handled marker while a disabled Slack job is pending, then expires it after completion', async () => {
  fakeChannels();
  const first = await harness();
  let jobId = '';
  try {
    first.failNextDelivery();
    await first.postDm('slack channels');
    await first.drain();
    expect(first.messages).toHaveLength(1);
    const queued = (await sql.query("SELECT id FROM jobs WHERE module='slack' AND status='queued'")).rows;
    expect(queued).toHaveLength(1);
    jobId = String(queued[0]!.id);
    await sql.query("UPDATE slack_handled_events SET handled_at=now()-interval '31 days' WHERE event_id=$1", [jobId]);
    await sql.query('UPDATE jobs SET available_at=now() WHERE id=$1', [jobId]);
  } finally { await first.close(); }

  const disabled = await harness({ ...env, ENABLED_MODULES: '' });
  try {
    await disabled.drain();
    expect(disabled.messages).toHaveLength(0);
    expect((await sql.query('SELECT status FROM jobs WHERE id=$1', [jobId])).rows[0]!.status).toBe('queued');
  } finally { await disabled.close(); }

  const resumed = await harness();
  try {
    const selections = new SlackChannelSelections(sql);
    await selections.cleanup();
    expect(await selections.handled(alice, jobId)).toBe(true);
    await resumed.drain();
    expect(resumed.messages).toHaveLength(0);
    expect((await sql.query('SELECT status FROM jobs WHERE id=$1', [jobId])).rows[0]!.status).toBe('done');
    await selections.cleanup();
    expect(await selections.handled(alice, jobId)).toBe(false);
  } finally { await resumed.close(); }
});

it('retries a private response when Slack definitely rejects the first delivery', async () => {
  fakeChannels();
  const h = await harness();
  try {
    const list = await h.dm('slack channels');
    const select = list.message.buttons!.find(button => button.value.startsWith('GPRIVATE|'))!;
    h.rejectNextDelivery();
    await h.postAction(select);
    const delivered = h.messages.length;
    await h.drain();
    expect(h.messages).toHaveLength(delivered);
    await sql.query("UPDATE jobs SET available_at=now() WHERE module='slack' AND status='queued' AND id LIKE 'action:%'");
    await h.drain();
    expect(h.messages).toHaveLength(delivered + 1);
    expect(h.messages.at(-1)!.message.text).toContain('Selected channels: 1');
  } finally { await h.close(); }
});

it('lists an unanswered direct mention from a selected channel in a private reply', async () => {
  const messageTs = `${Math.floor(Date.now() / 1000) - 60}.000001`;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const request = new URL(url);
    const channel = { id: 'CPUBLIC', name: 'general', is_channel: true, is_private: false };
    if (request.pathname.endsWith('/users.conversations')) return { ok: true, json: async () => ({ ok: true, channels: [channel], response_metadata: { next_cursor: '' } }) };
    if (request.pathname.endsWith('/users.info')) return { ok: true, json: async () => ({ ok: true, user: request.searchParams.get('user') === 'UALICE'
      ? { id: 'UALICE', profile: { display_name: 'Alice', real_name: 'Alice Smith', first_name: 'Alice' } }
      : { id: 'UBOB', profile: { display_name: 'Bob', real_name: 'Bob Jones', first_name: 'Bob' } } }) };
    if (request.pathname.endsWith('/conversations.history')) {
      const secondPage = request.searchParams.get('cursor') === 'next';
      return { ok: true, json: async () => ({ ok: true, messages: secondPage ? [
        { type: 'message', user: 'UBOB', ts: messageTs, text: 'Hi <@UALICE>, the report is ready.', reply_count: 0 },
      ] : [], response_metadata: { next_cursor: secondPage ? '' : 'next' } }) };
    }
    if (request.pathname.endsWith('/conversations.replies')) return { ok: true, json: async () => ({ ok: true, messages: [
      { type: 'message', user: 'UBOB', ts: messageTs, text: 'Hi <@UALICE>, the report is ready.' },
    ], response_metadata: { next_cursor: '' } }) };
    if (request.pathname.endsWith('/chat.getPermalink')) return { ok: true, json: async () => ({ ok: true, permalink: 'https://example.slack.com/archives/CPUBLIC/p123' }) };
    throw new Error(`Unexpected Slack API: ${request.pathname}`);
  }));
  const h = await harness();
  try {
    const channels = await h.dm('slack channels');
    await h.click(channels.message.buttons![0]!);
    const result = await h.dm('slack unanswered');
    expect(result.actor).toEqual(alice);
    expect(result.message.kind).toBe('Unanswered for you');
    expect(result.message.text).toContain('general');
    expect(result.message.text).toContain('Bob');
    expect(result.message.text).toContain('the report is ready');
    expect(result.message.text).toContain('https://example.slack.com/archives/CPUBLIC/p123');
  } finally { await h.close(); }
});

it('uses the command time and full threads for name matches, collisions, and later replies', async () => {
  const anchor = Math.floor(Date.now() / 1000) - 10;
  const stamp = (seconds: number) => `${seconds}.000001`;
  const cutoff = anchor - 48 * 3600;
  const root = (seconds: number, text: string, user = 'UAUTHOR', extra = {}) => ({ type: 'message', ts: stamp(seconds), text, user, ...extra });
  const shared = root(anchor - 20, 'Hello Alice, please look');
  const display = root(anchor - 21, 'Ali: any update?');
  const full = root(anchor - 22, 'Alice Cooper needs to see this');
  const mention = root(anchor - 23, '<@UALICE> can you review?');
  const boundary = root(cutoff, 'Alice at the boundary');
  const expired = root(cutoff - 1, 'Alice too old');
  const future = root(anchor + 1, 'Alice after command');
  const own = root(anchor - 24, 'Alice wrote this', 'UALICE');
  const unrelated = root(anchor - 25, 'Anyone have an update?');
  const answered = root(anchor - 26, 'Alice, please answer', 'UAUTHOR', { reply_count: 1, latest_reply: stamp(anchor - 3) });
  const answeredFile = root(anchor - 27, 'Alice, please inspect the file', 'UAUTHOR', { reply_count: 1, latest_reply: stamp(anchor - 2) });
  const oldRoot = root(cutoff - 7200, 'An old thread', 'UAUTHOR', { reply_count: 1, latest_reply: stamp(anchor - 4) });
  const recentReply = root(anchor - 4, 'Alice, check the old thread', 'UAUTHOR', { subtype: 'thread_broadcast' });
  const roots = [shared, display, full, mention, boundary, expired, future, own, unrelated, answered, answeredFile, oldRoot];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const request = new URL(url), method = request.pathname.split('/').at(-1);
    if (method === 'users.conversations') return { ok: true, json: async () => ({ ok: true, channels: [{ id: 'CPUBLIC', name: 'general', is_channel: true, is_private: false }], response_metadata: { next_cursor: '' } }) };
    if (method === 'users.info') {
      const user = request.searchParams.get('user');
      const profile = user === 'UALICE' ? { display_name: 'Ali', real_name: 'Alice Cooper', first_name: 'Alice' }
        : user === 'UBOB' ? { display_name: 'Bobby', real_name: 'Alice Brown', first_name: 'Alice' }
          : { display_name: 'Author', real_name: 'Author Person', first_name: 'Author' };
      return { ok: true, json: async () => ({ ok: true, user: { id: user, profile } }) };
    }
    if (method === 'conversations.history') return { ok: true, json: async () => ({ ok: true, messages: roots, response_metadata: { next_cursor: '' } }) };
    if (method === 'conversations.replies') {
      const ts = request.searchParams.get('ts');
      return { ok: true, json: async () => ({ ok: true, messages: ts === answered.ts
        ? [answered, root(anchor - 3, 'I replied', 'UALICE', { subtype: 'me_message' })]
        : ts === answeredFile.ts ? [answeredFile, { type: 'message', ts: stamp(anchor - 2), user: 'UALICE', subtype: 'file_share' }]
          : [oldRoot, recentReply], response_metadata: { next_cursor: '' } }) };
    }
    if (method === 'chat.getPermalink') return { ok: true, json: async () => ({ ok: true, permalink: `https://example.slack.com/archives/CPUBLIC/p${request.searchParams.get('message_ts')?.replace('.', '')}` }) };
    throw new Error(`Unexpected Slack API: ${method}`);
  }));
  const h = await harness();
  try {
    const channels = await h.dm('slack channels');
    await h.click(channels.message.buttons![0]!);
    const result = await h.dm('slack unanswered', alice, new Date(anchor * 1000));
    const text = result.message.text;
    for (const expected of ['Hello Alice', 'Ali: any update', 'Alice Cooper', 'can you review', 'at the boundary', 'check the old thread']) expect(text).toContain(expected);
    for (const excluded of ['too old', 'after command', 'wrote this', 'please answer', 'inspect the file', 'Anyone have']) expect(text).not.toContain(excluded);
    expect(text.indexOf('Hello Alice')).toBeLessThan(text.indexOf('at the boundary'));
    const bobBefore = await h.dm('slack unanswered', bob, new Date(anchor * 1000));
    expect(bobBefore.actor).toEqual(bob);
    expect(bobBefore.message.text).toContain('Choose sources with slack channels');
    expect(bobBefore.message.text).not.toContain('Hello Alice');
    const bobChannels = await h.dm('slack channels', bob);
    await h.click(bobChannels.message.buttons![0]!, bob);
    const bobAfter = await h.dm('slack unanswered', bob, new Date(anchor * 1000));
    expect(bobAfter.actor).toEqual(bob);
    expect(bobAfter.message.text).toContain('Hello Alice');
  } finally { await h.close(); }
});

it('groups and paginates private results while reporting inaccessible selected channels', async () => {
  let privateVisible = true;
  const stamp = (offset: number) => `${Math.floor(Date.now() / 1000) - offset}.000001`;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const request = new URL(url), method = request.pathname.split('/').at(-1);
    if (method === 'users.conversations') return { ok: true, json: async () => ({ ok: true, channels: [
      { id: 'CPUBLIC', name: 'general', is_channel: true, is_private: false },
      ...(privateVisible ? [{ id: 'GPRIVATE', name: 'planning', is_group: true, is_private: true }] : []),
    ], response_metadata: { next_cursor: '' } }) };
    if (method === 'users.info') return { ok: true, json: async () => ({ ok: true, user: { profile: request.searchParams.get('user') === 'UALICE'
      ? { display_name: 'Alice', first_name: 'Alice' } : { display_name: 'Author' } } }) };
    if (method === 'conversations.history') return { ok: true, json: async () => ({ ok: true, messages: request.searchParams.get('channel') === 'CPUBLIC'
      ? Array.from({ length: 9 }, (_, i) => ({ type: 'message', ts: stamp(i + 2), user: 'UAUTHOR', text: `Alice public ${i}` }))
      : [{ type: 'message', ts: stamp(1), user: 'UAUTHOR', text: 'Alice private result' }], response_metadata: { next_cursor: '' } }) };
    if (method === 'chat.getPermalink') return { ok: true, json: async () => ({ ok: true, permalink: 'https://example.slack.com/archives/source' }) };
    throw new Error(`Unexpected Slack API: ${method}`);
  }));
  const h = await harness();
  try {
    const channels = await h.dm('slack channels');
    for (const button of channels.message.buttons!) await h.click(button);
    const first = await h.dm('slack unanswered');
    expect(first.actor).toEqual(alice);
    expect(first.message.text).toContain('page 1/2');
    expect(first.message.text).toContain('general');
    expect(first.message.text).toContain('public 0');
    expect(first.message.text).not.toContain('private result');
    const second = await h.click(first.message.buttons!.find(button => button.label === 'Next')!);
    expect(second.actor).toEqual(alice);
    expect(second.message.text).toContain('page 2/2');
    expect(second.message.text).toContain('planning');
    expect(second.message.text).toContain('private result');
    expect(second.message.text).toContain('Open message');
    privateVisible = false;
    const skipped = await h.dm('slack unanswered');
    expect(skipped.message.text).toContain('Skipped inaccessible selected channels: GPRIVATE');
    expect((await h.dm('slack channels')).message.text).toContain('Selected channels: 2');
  } finally { await h.close(); }
});

it('finds clear requests and contextually possible replies without assigning generic channel questions', async () => {
  const now = Math.floor(Date.now() / 1000);
  const stamp = (seconds: number) => `${seconds}.000001`;
  const oldClear = { type: 'message', ts: stamp(now - 60 * 60 * 60), user: 'UTHIRD', text: 'Alice owns the release report.', reply_count: 1, latest_reply: stamp(now - 30) };
  const clear = { type: 'message', ts: stamp(now - 30), user: 'UAUTHOR', text: 'Can the report owner send the latest version?' };
  const oldPossible = { type: 'message', ts: stamp(now - 60 * 60 * 60 - 10), user: 'UALICE', text: 'I have the handoff notes.', reply_count: 1, latest_reply: stamp(now - 20) };
  const possible = { type: 'message', ts: stamp(now - 20), user: 'UAUTHOR', text: 'Could someone finish this handoff?' };
  const oldGeneric = { type: 'message', ts: stamp(now - 60 * 60 * 60 - 20), user: 'UTHIRD', text: 'The office is open.', reply_count: 1, latest_reply: stamp(now - 10) };
  const generic = { type: 'message', ts: stamp(now - 10), user: 'UAUTHOR', text: 'Can anyone help with this?' };
  const answered = { type: 'message', ts: stamp(now - 40), user: 'UAUTHOR', text: 'Can the report owner approve this too?', reply_count: 1, latest_reply: stamp(now - 2) };
  const direct = { type: 'message', ts: stamp(now - 5), user: 'UAUTHOR', text: '<@UALICE> here is your update.' };
  const modelInputs: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const request = new URL(url), method = request.pathname.split('/').at(-1);
    if (request.hostname === 'api.openai.com') {
      const body = JSON.parse(String(options?.body));
      modelInputs.push(body);
      if (method === 'input_tokens') return Response.json({ input_tokens: 200 });
      const input = JSON.parse(body.input);
      const results = input.candidates.map((candidate: any) => ({ id: candidate.id,
        decision: candidate.text.includes('owner') ? 'clear' : 'possible',
        evidenceTs: candidate.text.includes('owner') ? oldClear.ts : candidate.text.includes('handoff') ? oldPossible.ts : oldGeneric.ts,
        reason: candidate.text.includes('owner') ? 'The older thread names Alice as owner.' : candidate.text.includes('handoff') ? 'Alice offered the handoff notes earlier.' : 'The office is open.' }));
      return Response.json({ status: 'completed', usage: { input_tokens: 200, output_tokens: 80 },
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({ results }) }] }] });
    }
    if (method === 'users.conversations') return Response.json({ ok: true, channels: [{ id: 'CPUBLIC', name: 'general', is_channel: true, is_private: false }], response_metadata: { next_cursor: '' } });
    if (method === 'users.info') return Response.json({ ok: true, user: { profile: request.searchParams.get('user') === 'UALICE'
      ? { display_name: 'Alice', real_name: 'Alice Smith', first_name: 'Alice' } : { display_name: 'Author' } } });
    if (method === 'conversations.history') return Response.json({ ok: true, messages: [oldClear, oldPossible, oldGeneric, answered, direct], response_metadata: { next_cursor: '' } });
    if (method === 'conversations.replies') return Response.json({ ok: true, messages: request.searchParams.get('ts') === oldClear.ts ? [oldClear, clear]
      : request.searchParams.get('ts') === oldPossible.ts ? [oldPossible, possible]
        : request.searchParams.get('ts') === answered.ts ? [answered, { type: 'message', ts: stamp(now - 2), user: 'UALICE', text: 'Handled it.', subtype: 'me_message' }]
          : [oldGeneric, generic], response_metadata: { next_cursor: '' } });
    if (method === 'chat.getPermalink') return Response.json({ ok: true, permalink: `https://example.slack.com/archives/CPUBLIC/p${request.searchParams.get('message_ts')?.replace('.', '')}` });
    throw new Error(`Unexpected provider call: ${request.pathname}`);
  }));
  const h = await harness({ ...env, OPENAI_API_KEY: 'fake' });
  try {
    await h.click((await h.dm('slack channels')).message.buttons![0]!);
    const result = await h.dm('slack unanswered');
    expect(result.actor).toEqual(alice);
    expect(result.message.kind).toBe('Unanswered for you');
    expect(result.message.text).toContain('here is your update');
    expect(result.message.text).toContain('report owner send');
    expect(result.message.text).toContain('Possibly for you');
    expect(result.message.text).toContain('finish this handoff');
    expect(result.message.text).not.toContain('Can anyone help');
    expect(result.message.text).not.toContain('approve this too');
    expect(result.message.text).toContain('Open message');
    expect(JSON.stringify(modelInputs)).toContain('Alice owns the release report');
    expect(JSON.stringify(modelInputs)).toContain('I have the handoff notes');
    expect(JSON.stringify(modelInputs)).not.toContain('here is your update');
    expect(JSON.stringify(modelInputs)).not.toContain('approve this too');
    expect(modelInputs.some(input => input.instructions?.includes('untrusted'))).toBe(true);
    expect(modelInputs.some(input => input.store === false)).toBe(true);
    const budget = await h.dm('budget');
    expect(budget.message.text).toContain('slack: $');
  } finally { await h.close(); }
});

it('finds new requests after a reply and distinguishes acknowledgements and third-party resolution', async () => {
  const now = Math.floor(Date.now() / 1000);
  const stamp = (seconds: number) => `${seconds}.000001`;
  const root = { type: 'message', ts: stamp(now - 60 * 60 * 60), user: 'UASKER', text: 'Can anyone send the figures?', reply_count: 7, latest_reply: stamp(now - 30) };
  const answer = { type: 'message', ts: stamp(now - 100), user: 'UALICE', text: 'Here are the figures.' };
  const date = { type: 'message', ts: stamp(now - 90), user: 'UASKER', text: 'When is the next update?' };
  const file = { type: 'message', ts: stamp(now - 80), user: 'UASKER', text: 'Can you send the spreadsheet too?' };
  const thanks = { type: 'message', ts: stamp(now - 70), user: 'UASKER', text: 'Thanks <@UALICE>!' };
  const otherAsk = { type: 'message', ts: stamp(now - 60), user: 'UOTHER', text: 'Could you add the region breakdown?' };
  const ambiguous = { type: 'message', ts: stamp(now - 50), user: 'UTHIRD', text: 'Could someone validate the totals?' };
  const resolved = { type: 'message', ts: stamp(now - 40), user: 'UASKER', text: '<@UALICE> can you confirm the owner?' };
  const otherAnswer = { type: 'message', ts: stamp(now - 30), user: 'UOTHER', text: 'I confirmed the owner.' };
  const thread = [root, answer, date, file, thanks, otherAsk, ambiguous, resolved, otherAnswer];
  const modelInputs: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const request = new URL(url), method = request.pathname.split('/').at(-1);
    if (request.hostname === 'api.openai.com') {
      const body = JSON.parse(String(options?.body));
      if (method === 'input_tokens') return Response.json({ input_tokens: 200 });
      const input = JSON.parse(body.input);
      modelInputs.push(input);
      return Response.json({ status: 'completed', usage: { input_tokens: 200, output_tokens: 100 }, output: [{ content: [{
        type: 'output_text', text: JSON.stringify({ results: input.candidates.map((candidate: any) => ({
          id: candidate.id,
          decision: candidate.text.includes('totals') ? 'possible'
            : ['next update', 'spreadsheet', 'region breakdown'].some(value => candidate.text.includes(value)) ? 'clear' : 'none',
          evidenceTs: answer.ts,
          reason: 'The user answered earlier in this thread.',
        })) }),
      }] }] });
    }
    if (method === 'users.conversations') return Response.json({ ok: true, channels: [{ id: 'CPUBLIC', name: 'general', is_channel: true, is_private: false }], response_metadata: { next_cursor: '' } });
    if (method === 'users.info') return Response.json({ ok: true, user: { profile: request.searchParams.get('user') === 'UALICE'
      ? { display_name: 'Alice', first_name: 'Alice' } : { display_name: 'Author' } } });
    if (method === 'conversations.history') return Response.json({ ok: true, messages: [root], response_metadata: { next_cursor: '' } });
    if (method === 'conversations.replies') return Response.json({ ok: true, messages: thread, response_metadata: { next_cursor: '' } });
    if (method === 'chat.getPermalink') return Response.json({ ok: true, permalink: `https://example.slack.com/archives/CPUBLIC/p${request.searchParams.get('message_ts')?.replace('.', '')}` });
    throw new Error(`Unexpected provider call: ${request.pathname}`);
  }));
  const h = await harness({ ...env, OPENAI_API_KEY: 'fake' });
  try {
    await h.click((await h.dm('slack channels')).message.buttons![0]!);
    const result = await h.dm('slack unanswered');
    const text = result.message.text;
    for (const message of [date, file, otherAsk, ambiguous]) {
      expect(text).toContain(message.text);
      expect(text).toContain(`p${message.ts.replace('.', '')}`);
    }
    expect(text).toContain('Possibly for you');
    for (const message of [root, otherAnswer]) expect(text).not.toContain(message.text);
    expect(text).not.toContain('Thanks');
    expect(text).not.toContain('confirm the owner?');
    expect(modelInputs.flatMap(input => input.candidates).some((candidate: any) => candidate.text === thanks.text)).toBe(false);
    expect(modelInputs.flatMap(input => input.candidates).filter((candidate: any) => candidate.text === date.text)[0]).toMatchObject({ followup: true, direct: false });
    expect(modelInputs.flatMap(input => input.candidates).filter((candidate: any) => candidate.text === resolved.text)[0]).toMatchObject({ author: 'UASKER', followup: true, direct: true });

    thread.push({ type: 'message', ts: stamp(now - 5), user: 'UALICE', text: "I'll check." });
    expect((await h.dm('slack unanswered')).message.text).not.toContain(date.text);
    expect((await h.dm('slack unanswered')).message.text).not.toContain(file.text);
  } finally { await h.close(); }
});

it('keeps a follow-up request when the model cites the asker’s intervening explanation', async () => {
  const now = Math.floor(Date.now() / 1000);
  const stamp = (seconds: number) => `${seconds}.000001`;
  const root = { type: 'message', ts: stamp(now - 100), user: 'UASKER', text: '<@UALICE> tu sais peut-être toi ?', reply_count: 3, latest_reply: stamp(now - 10) };
  const answer = { type: 'message', ts: stamp(now - 30), user: 'UALICE', text: "D'où viennent ces questions ?" };
  const explanation = { type: 'message', ts: stamp(now - 20), user: 'UASKER', text: "C'est juste pour m'assurer que tous les cas de figure seront bien traités." };
  const followup = { type: 'message', ts: stamp(now - 10), user: 'UASKER', text: "Tu me diras si c'est bon pour toi" };
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const request = new URL(url), method = request.pathname.split('/').at(-1);
    if (request.hostname === 'api.openai.com') {
      if (method === 'input_tokens') return Response.json({ input_tokens: 200 });
      const input = JSON.parse(JSON.parse(String(options?.body)).input);
      return Response.json({ status: 'completed', usage: { input_tokens: 200, output_tokens: 80 }, output: [{ content: [{
        type: 'output_text', text: JSON.stringify({ results: input.candidates.map((candidate: any) => ({
          id: candidate.id, decision: candidate.text === followup.text ? 'clear' : 'none',
          evidenceTs: explanation.ts, reason: 'The asker is awaiting confirmation from the user.',
        })) }),
      }] }] });
    }
    if (method === 'users.conversations') return Response.json({ ok: true, channels: [{ id: 'CPUBLIC', name: 'general', is_channel: true, is_private: false }], response_metadata: { next_cursor: '' } });
    if (method === 'users.info') return Response.json({ ok: true, user: { profile: request.searchParams.get('user') === 'UALICE'
      ? { display_name: 'Alice', first_name: 'Alice' } : { display_name: 'Asker' } } });
    if (method === 'conversations.history') return Response.json({ ok: true, messages: [root], response_metadata: { next_cursor: '' } });
    if (method === 'conversations.replies') return Response.json({ ok: true, messages: [root, answer, explanation, followup], response_metadata: { next_cursor: '' } });
    if (method === 'chat.getPermalink') return Response.json({ ok: true, permalink: 'https://example.slack.com/archives/CPUBLIC/followup' });
    throw new Error(`Unexpected provider call: ${request.pathname}`);
  }));
  const h = await harness({ ...env, OPENAI_API_KEY: 'fake' });
  try {
    await h.click((await h.dm('slack channels')).message.buttons![0]!);
    const result = await h.dm('slack unanswered');
    expect(result.message.text).toContain(followup.text);
  } finally { await h.close(); }
});

it('keeps direct follow-up requests but filters obvious thanks without AI budget', async () => {
  const now = Math.floor(Date.now() / 1000);
  const stamp = (seconds: number) => `${seconds}.000001`;
  const root = { type: 'message', ts: stamp(now - 100), user: 'UASKER', text: 'Alice, can you send the draft?', reply_count: 6, latest_reply: stamp(now - 10) };
  const answer = { type: 'message', ts: stamp(now - 40), user: 'UALICE', text: 'Here it is.' };
  const followup = { type: 'message', ts: stamp(now - 30), user: 'UASKER', text: '<@UALICE> can you send the source file?' };
  const thanks = { type: 'message', ts: stamp(now - 20), user: 'UASKER', text: 'Thanks, Alice!' };
  const thanksFor = { type: 'message', ts: stamp(now - 15), user: 'UASKER', text: 'Thanks for the update, Alice!' };
  const newRequest = { type: 'message', ts: stamp(now - 12), user: 'UASKER', text: 'Thanks Alice, can you check the totals?' };
  const unnamed = { type: 'message', ts: stamp(now - 10), user: 'UASKER', text: 'When can we publish?' };
  const outsideFollowup = { type: 'message', ts: stamp(now - 8), user: 'UOTHER', text: 'Thanks <@UALICE>!' };
  let paidCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const request = new URL(url), method = request.pathname.split('/').at(-1);
    if (request.hostname === 'api.openai.com') {
      if (method === 'input_tokens') return Response.json({ input_tokens: 100 });
      paidCalls++;
      throw new Error('Paid generation should not run.');
    }
    if (method === 'users.conversations') return Response.json({ ok: true, channels: [{ id: 'CPUBLIC', name: 'general', is_channel: true, is_private: false }], response_metadata: { next_cursor: '' } });
    if (method === 'users.info') return Response.json({ ok: true, user: { profile: request.searchParams.get('user') === 'UALICE'
      ? { display_name: 'Alice', first_name: 'Alice' } : { display_name: 'Author' } } });
    if (method === 'conversations.history') return Response.json({ ok: true, messages: [root, outsideFollowup], response_metadata: { next_cursor: '' } });
    if (method === 'conversations.replies') return Response.json({ ok: true, messages: [root, answer, followup, thanks, thanksFor, newRequest, unnamed], response_metadata: { next_cursor: '' } });
    if (method === 'chat.getPermalink') return Response.json({ ok: true, permalink: 'https://example.slack.com/archives/source' });
    throw new Error(`Unexpected provider call: ${request.pathname}`);
  }));
  const h = await harness({ ...env, OPENAI_API_KEY: 'fake', AI_MONTHLY_LIMIT_USD: '0' });
  try {
    await h.click((await h.dm('slack channels')).message.buttons![0]!);
    const text = (await h.dm('slack unanswered')).message.text;
    expect(text).toContain('can you send the source file?');
    expect(text).toContain('can you check the totals?');
    expect(text).toContain('Thanks \\&lt;@UALICE\\&gt;');
    expect(text.match(/Thanks/g)).toHaveLength(2);
    expect(text).not.toContain('Thanks for the update');
    expect(text).not.toContain(unnamed.text);
    expect(text).not.toContain(root.text);
    expect(text).toContain('Follow-up resolution could not be fully checked');
    expect(paidCalls).toBe(0);
  } finally { await h.close(); }
});

it('keeps direct matches and discloses incomplete contextual search when the shared AI budget is exhausted', async () => {
  const now = Math.floor(Date.now() / 1000);
  const direct = { type: 'message', ts: `${now - 10}.000001`, user: 'UAUTHOR', text: '<@UALICE> please review the draft' };
  const contextual = { type: 'message', ts: `${now - 9}.000001`, user: 'UAUTHOR', text: 'Could the owner approve this?' };
  let paidCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const request = new URL(url), method = request.pathname.split('/').at(-1);
    if (request.hostname === 'api.openai.com') {
      if (method === 'input_tokens') return Response.json({ input_tokens: 100 });
      paidCalls++;
      throw new Error('Paid generation should not run.');
    }
    if (method === 'users.conversations') return Response.json({ ok: true, channels: [{ id: 'CPUBLIC', name: 'general', is_channel: true, is_private: false }], response_metadata: { next_cursor: '' } });
    if (method === 'users.info') return Response.json({ ok: true, user: { profile: request.searchParams.get('user') === 'UALICE'
      ? { display_name: 'Alice', first_name: 'Alice' } : { display_name: 'Author' } } });
    if (method === 'conversations.history') return Response.json({ ok: true, messages: [direct, contextual], response_metadata: { next_cursor: '' } });
    if (method === 'chat.getPermalink') return Response.json({ ok: true, permalink: 'https://example.slack.com/archives/CPUBLIC/p1' });
    throw new Error(`Unexpected provider call: ${request.pathname}`);
  }));
  const h = await harness({ ...env, OPENAI_API_KEY: 'fake', AI_MONTHLY_LIMIT_USD: '0' });
  try {
    await h.click((await h.dm('slack channels')).message.buttons![0]!);
    const result = await h.dm('slack unanswered');
    expect(result.actor).toEqual(alice);
    expect(result.message.text).toContain('please review the draft');
    expect(result.message.text).toContain('Possibly for you could not be fully checked');
    expect(result.message.text).not.toContain('owner approve');
    expect(paidCalls).toBe(0);
  } finally { await h.close(); }
});

it('does not pay for the same contextual classification again after Slack rejects its private response and the worker restarts', async () => {
  const now = Math.floor(Date.now() / 1000);
  const old = { type: 'message', ts: `${now - 60 * 60 * 60}.000001`, user: 'UTHIRD', text: 'Alice owns the release.', reply_count: 1, latest_reply: `${now - 10}.000001` };
  const candidate = { type: 'message', ts: `${now - 10}.000001`, user: 'UAUTHOR', text: 'Can the owner send the release report?' };
  let paidCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const request = new URL(url), method = request.pathname.split('/').at(-1);
    if (request.hostname === 'api.openai.com') {
      if (method === 'input_tokens') return Response.json({ input_tokens: 100 });
      paidCalls++;
      const id = JSON.parse(JSON.parse(String(options?.body)).input).candidates[0].id;
      return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 40 },
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({ results: [{ id, decision: 'clear', evidenceTs: old.ts, reason: 'Alice owns the release.' }] }) }] }] });
    }
    if (method === 'users.conversations') return Response.json({ ok: true, channels: [{ id: 'CPUBLIC', name: 'general', is_channel: true, is_private: false }], response_metadata: { next_cursor: '' } });
    if (method === 'users.info') return Response.json({ ok: true, user: { profile: request.searchParams.get('user') === 'UALICE'
      ? { display_name: 'Alice', first_name: 'Alice' } : { display_name: 'Author' } } });
    if (method === 'conversations.history') return Response.json({ ok: true, messages: [old], response_metadata: { next_cursor: '' } });
    if (method === 'conversations.replies') return Response.json({ ok: true, messages: [old, candidate], response_metadata: { next_cursor: '' } });
    if (method === 'chat.getPermalink') return Response.json({ ok: true, permalink: 'https://example.slack.com/archives/CPUBLIC/p1' });
    throw new Error(`Unexpected provider call: ${request.pathname}`);
  }));
  const h = await harness({ ...env, OPENAI_API_KEY: 'fake' });
  try {
    await h.click((await h.dm('slack channels')).message.buttons![0]!);
    h.rejectNextDelivery();
    await h.postDm('slack unanswered');
    await h.drain();
    expect(h.messages).toHaveLength(2);
    await sql.query("UPDATE jobs SET available_at=now() WHERE module='slack' AND status='queued'");
    const restarted = await harness({ ...env, OPENAI_API_KEY: 'fake' });
    try {
      await restarted.drain();
      expect(restarted.messages).toHaveLength(1);
      expect(restarted.messages[0]!.message.text).toContain('owner send the release report');
    } finally { await restarted.close(); }
    expect(paidCalls).toBe(1);
  } finally { await h.close(); }
});
