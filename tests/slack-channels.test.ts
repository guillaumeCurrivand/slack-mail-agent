import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readConfig } from '../src/app/config.js';
import { createModules } from '../src/app/modules.js';
import { schema } from '../src/app/schema.js';
import type { Actor } from '../src/core/identity.js';
import { createServer } from '../src/core/server.js';
import { SlackDeliveryRejected, type AgentMessage, type Messenger } from '../src/core/slack.js';
import { JobStore, type Sql } from '../src/core/store.js';
import { worker } from '../src/core/worker.js';

const env = { PUBLIC_URL: 'https://agent.example.com', DATABASE_URL: 'postgresql://unused', SLACK_TEAM_ID: 'TTEAM', SLACK_BOT_TOKEN: 'token', SLACK_SIGNING_SECRET: 'secret', ENABLED_MODULES: 'slack' };
const config = readConfig(env);
const alice: Actor = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
const bob: Actor = { team: 'TTEAM', user: 'UBOB', channel: 'DBOB' };
let db: PGlite, sql: Sql;

beforeAll(async () => { db = new PGlite(); await db.exec(schema); sql = { query: (text, values) => db.query(text, values) }; });
beforeEach(async () => { await db.exec('TRUNCATE users,jobs,oauth_states,ai_calls,ai_months CASCADE; DROP TABLE IF EXISTS slack_selected_channels,slack_handled_events'); });
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
      ? { ok: true, channels: [{ id: 'GPRIVATE', name: 'planning', is_group: true, is_private: true }, { id: 'GMPIM', name: 'group-dm', is_mpim: true }], response_metadata: { next_cursor: '' } }
      : { ok: true, channels: [{ id: 'CPUBLIC', name: 'general', is_channel: true, is_private: false }], response_metadata: { next_cursor: 'next' } } };
  }));
}

async function harness() {
  const modules = createModules(config, sql, env);
  for (const module of modules.all()) await module.initialize?.(sql);
  const app = createServer(config, new JobStore(sql), modules);
  const messages: Array<{ actor: Actor; message: AgentMessage }> = [];
  let failAfterDelivery = false;
  let rejectBeforeDelivery = false;
  const messenger: Messenger = { async send(actor, message) {
    if (rejectBeforeDelivery) { rejectBeforeDelivery = false; throw new SlackDeliveryRejected('Rejected'); }
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
    const stop = worker(pool, { ...config, WORKER_CONCURRENCY: 1 }, modules, messenger);
    try {
      const start = Date.now();
      while (messages.length === before && Date.now() - start < 3000) await new Promise(resolve => setTimeout(resolve, 20));
      expect(messages.length).toBeGreaterThan(before);
      return messages.at(-1)!;
    } finally { await stop(); }
  };
  const dm = async (text: string, actor = alice) => {
    const raw = JSON.stringify({ type: 'event_callback', team_id: actor.team, event_id: `event-${crypto.randomUUID()}`,
      event: { type: 'message', channel_type: 'im', user: actor.user, channel: actor.channel, text } });
    expect((await post('/slack/events', raw, 'application/json')).statusCode).toBe(200);
    return receive();
  };
  const postAction = async (button: NonNullable<AgentMessage['buttons']>[number], actor = alice) => {
    const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: actor.team }, user: { id: actor.user },
      channel: { id: actor.channel }, actions: [{ action_id: button.action, value: button.value, action_ts: crypto.randomUUID() }] }) }).toString();
    expect((await post('/slack/actions', raw, 'application/x-www-form-urlencoded')).statusCode).toBe(200);
  };
  const click = async (button: NonNullable<AgentMessage['buttons']>[number], actor = alice) => { await postAction(button, actor); return receive(); };
  const drain = async () => {
    const stop = worker(pool, { ...config, WORKER_CONCURRENCY: 1 }, modules, messenger);
    try { await new Promise(resolve => setTimeout(resolve, 650)); } finally { await stop(); }
  };
  return { dm, click, postAction, drain, messages, failNextDelivery: () => { failAfterDelivery = true; },
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
    expect(message.text).not.toContain('group-dm');
    expect(message.buttons?.map(button => button.action)).toEqual(['slack:channel_select', 'slack:channel_select']);
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
