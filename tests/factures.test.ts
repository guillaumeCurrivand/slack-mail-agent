import { createHmac, generateKeyPairSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readConfig } from '../src/app/config.js';
import { createModules } from '../src/app/modules.js';
import { digest, Vault } from '../src/core/crypto.js';
import { dispatchJob } from '../src/core/dispatch.js';
import { ownerKey, type Actor } from '../src/core/identity.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { createServer } from '../src/core/server.js';
import { SlackDeliveryRejected, type AgentMessage, type Button } from '../src/core/slack.js';
import { coreSchema, JobStore, type Sql } from '../src/core/store.js';
import { createFacturesModule, readFacturesConfig } from '../src/modules/factures/index.js';
import { emptyState } from '../src/modules/mail/domain.js';
import { mailSchema, Store } from '../src/modules/mail/store.js';

const env = {
  ENABLED_MODULES: 'factures', PUBLIC_URL: 'https://example.test', DATABASE_URL: 'unused', SLACK_TEAM_ID: 'TTEAM',
  SLACK_BOT_TOKEN: 'fake', SLACK_SIGNING_SECRET: 'fake', FACTURES_GOOGLE_CLIENT_ID: 'fake',
  FACTURES_GOOGLE_CLIENT_SECRET: 'fake', FACTURES_GOOGLE_REFRESH_TOKEN: 'fake', FACTURES_ANTHROPIC_SENDERS: 'receipts@example.test',
  FACTURES_SLACK_USER_IDS: 'UALICE',
};
const appConfig = readConfig(env);
const db = new PGlite(), sql: Sql = {
  async query(statement, values) {
    if (statement === mailSchema) { await db.exec(statement); return { rows: [] }; }
    return db.query(statement, values);
  },
};
beforeAll(() => db.exec(coreSchema));
afterAll(() => db.close());
const file = Buffer.from('%PDF-1.7\nsynthetic invoice\n');

function provider(request: string | URL | Request) {
  const url = new URL(String(request));
  const path = url.pathname.split('/users/me/')[1];
  if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fake' });
  expect(url.hostname).toBe('gmail.googleapis.com');
  if (path === 'profile') return Response.json({ emailAddress: 'production@mayasquad.com' });
  if (path === 'labels') return Response.json({ labels: [{ name: 'Factures outils', id: 'Label_1' }] });
  if (path === 'messages') {
    expect(url.searchParams.get('labelIds')).toBe('Label_1');
    expect(url.searchParams.get('q')).toContain('from:receipts@example.test');
    return Response.json({ messages: [{ id: 'a1' }, { id: 'b2' }, { id: 'c3' }] });
  }
  if (path === 'messages/a1/attachments/pdf') return Response.json({ data: file.toString('base64url') });
  const id = path?.split('/').at(-1);
  return Response.json({
    id,
    labelIds: id === 'c3' ? [] : ['Label_1'],
    internalDate: String(Date.parse('2026-11-23T11:00:00Z')),
    payload: {
      headers: [{ name: 'From', value: id === 'b2' ? 'spam@example.test' : 'Anthropic <receipts@example.test>' },
        { name: 'Subject', value: 'Your receipt from Anthropic, PBC' }],
      parts: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', body: { attachmentId: 'pdf', size: file.length } }],
    },
  });
}

it('registers the opt-in module and goes through signed DM routing, verifying the account before reading', async () => {
  expect(createModules(appConfig, sql, env).text('factures aide')).toMatchObject({ module: 'factures', payload: { text: 'help' } });
  const fetcher = vi.fn(async (request: string | URL | Request) => provider(request));
  const config = readFacturesConfig({ ...env, FACTURES_PROVIDERS: JSON.stringify([
    { name: 'Anthropic', senders: ['receipts@example.test'], subjectMatches: ['Your receipt from Anthropic'] },
    { name: 'Vercel', senders: ['billing@example.test'], subjectMatches: ['Vercel invoice'] },
  ]) });
  const module = createFacturesModule(config, undefined, 'TTEAM', fetcher);
  const registry = new ModuleRegistry([module]);
  const server = createServer(appConfig, new JobStore(sql), registry);
  const send = vi.fn();
  const deliver = async (eventId: string, user: string, channel: string) => {
    const payload = JSON.stringify({ type: 'event_callback', team_id: 'TTEAM', event_id: eventId,
      event: { type: 'message', channel_type: channel[0] === 'D' ? 'im' : 'channel', user, channel, text: 'factures 2026-11', ts: '1.2' } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', 'fake').update(`v0:${ts}:${payload}`).digest('hex');
    const res = await server.inject({ method: 'POST', url: '/slack/events', payload,
      headers: { 'content-type': 'application/json', 'x-slack-signature': 'v0=' + sig, 'x-slack-request-timestamp': ts } });
    expect(res.statusCode).toBe(200);
    const job = (await sql.query('SELECT * FROM jobs WHERE id=$1', ['slack:' + eventId])).rows[0];
    if (job) await dispatchJob(sql, appConfig, registry, { send }, job);
  };
  try {
    await deliver('F1', 'UALICE', 'CTEAM');
    await deliver('F2', 'UBOB', 'DBOB');
    expect(fetcher).not.toHaveBeenCalled();
    expect(send.mock.lastCall?.[1].text).toContain('réservée');
    await deliver('F3', 'UALICE', 'DALICE');
    expect(send.mock.lastCall?.[1].text).toContain('PDF joint');
    expect(send.mock.lastCall?.[1].text).toContain('Aucun mail repéré pour Vercel');
    expect(send.mock.lastCall?.[1].text).toContain('#all/a1');
    expect(send.mock.lastCall?.[1].text).not.toContain('#all/b2');
    expect(send.mock.lastCall?.[1].text).not.toContain('#all/c3');
    expect(fetcher.mock.calls.map(([request]) => String(request))).not.toContainEqual(expect.stringContaining('/attachments/'));
    fetcher.mockClear();
    fetcher.mockImplementation(async request => String(request).endsWith('/profile') ? Response.json({ emailAddress: 'other@example.test' }) : provider(request));
    await deliver('F4', 'UALICE', 'DALICE');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(send.mock.lastCall?.[1].text).toContain('indisponible');
  } finally { await server.close(); }
});

it('defers the Paris schedule, archives one PDF across definite and uncertain retries, and sends privately', async () => {
  let now = Date.parse('2026-12-05T07:59:00Z');
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const archive = { folder: 'folder', account: { client_email: 'service@example.test', private_key: privateKey } };
  let uploadAttempts = 0;
  const fetcher = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    const url = String(request);
    if (url.includes('/files/generateIds')) return Response.json({ ids: ['fixed-pdf'] });
    if (url.includes('/upload/drive/')) {
      uploadAttempts++;
      expect(Buffer.from(init?.body as Uint8Array).toString()).toContain('"id":"fixed-pdf"');
      if (uploadAttempts === 1) throw Error('uncertain upload');
      return new Response(null, { status: 409 });
    }
    if (url.includes('/files/fixed-pdf?')) return Response.json({ driveId: 'drive', parents: ['folder'], trashed: false });
    if (url.includes('/files/folder?')) return Response.json({ driveId: 'drive', mimeType: 'application/vnd.google-apps.folder',
      trashed: false, capabilities: { canAddChildren: true } });
    return provider(request);
  });
  const config = { ...readFacturesConfig(env), monthly: true };
  const module = createFacturesModule(config, archive, 'TTEAM', fetcher, () => now);
  const registry = new ModuleRegistry([module]);
  const send = vi.fn()
    .mockRejectedValueOnce(new SlackDeliveryRejected('rejet', 'ratelimited', 120))
    .mockRejectedValueOnce(new Error('uncertain Slack delivery'));
  const run = (job: any) => dispatchJob(sql, appConfig, registry, { send }, job);
  await module.initialize!(sql);
  await module.initialize!(sql);
  const schedule = (await sql.query("SELECT * FROM jobs WHERE id='factures:TTEAM:schedule'")).rows[0];
  expect(await run(schedule)).toEqual(new Date('2026-12-05T08:00:00Z'));
  expect(fetcher).not.toHaveBeenCalled();
  now = Date.parse('2026-12-05T08:00:00Z');
  expect(await run(schedule)).toEqual(new Date('2027-01-05T08:00:00Z'));
  await run(schedule);
  const jobs = (await sql.query("SELECT * FROM jobs WHERE module='factures' AND payload->>'type'='report'")).rows;
  expect(jobs).toHaveLength(1);
  await expect(run(jobs[0])).rejects.toThrow('uncertain upload');
  expect(send).not.toHaveBeenCalled();
  expect(await run(jobs[0])).toEqual(new Date(now + 120_000));
  await expect(run(jobs[0])).rejects.toThrow('uncertain Slack delivery');
  await run(jobs[0]);
  expect(uploadAttempts).toBe(2);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.lastCall?.[0]).toEqual({ team: 'TTEAM', user: 'UALICE', channel: 'UALICE' });
  expect(send.mock.lastCall?.[1].text).toContain('/file/d/fixed-pdf/view');
});

it('opts in to one Courrier label through a signed private menu and stops on removal or replacement of the connection', async () => {
  const key = Buffer.alloc(32, 5), vault = new Vault(key);
  const alice = { team: 'TPERSONAL', user: 'UALICE', channel: 'DALICE' };
  const bob = { team: alice.team, user: 'UBOB', channel: 'DBOB' };
  const options = { ENABLED_MODULES: 'factures,mail', PUBLIC_URL: env.PUBLIC_URL, DATABASE_URL: 'unused',
    SLACK_TEAM_ID: alice.team, SLACK_BOT_TOKEN: 'fake', SLACK_SIGNING_SECRET: 'fake', OPENAI_API_KEY: 'fake',
    ENCRYPTION_KEY: key.toString('base64'), GOOGLE_CLIENT_ID: 'fake', GOOGLE_CLIENT_SECRET: 'fake',
    GOOGLE_WORKSPACE_DOMAINS: 'example.test' };
  const config = readConfig(options);
  const gmail = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname.split('/users/me/')[1];
    expect(url.hostname).toBe('gmail.googleapis.com');
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer alice-test');
    if (path === 'labels') return Response.json({ labels: [
      { id: 'Label_A', name: 'Mes factures', type: 'user' }, { id: 'Label_B', name: 'Privé', type: 'user' },
      { id: 'INBOX', name: 'INBOX', type: 'system' },
    ] });
    if (path === 'messages') {
      expect(url.searchParams.getAll('labelIds')).toEqual(['Label_A']);
      return Response.json({ messages: [{ id: 'a1' }, { id: 'b2' }] });
    }
    if (path === 'messages/a1' || path === 'messages/b2') {
      const id = path.split('/')[1];
      return Response.json({ id, labelIds: [id === 'a1' ? 'Label_A' : 'Label_B'], internalDate: String(Date.parse('2026-11-22T12:00:00Z')),
        payload: { headers: [{ name: 'From', value: 'provider@example.test' }] } });
    }
    throw new Error('Unexpected Gmail request.');
  });
  vi.stubGlobal('fetch', gmail);
  const registry = createModules(config, sql, options);
  for (const module of registry.all()) await module.initialize?.(sql);
  const mail = new Store(sql);
  const connect = (id: string) => mail.save(alice, { ...emptyState(), connection: {
    id, subject: 'alice-google', email: 'alice@example.test',
    encryptedTokens: vault.seal({ access_token: 'alice-test', refresh_token: 'fake', expires_at: Date.now() + 600_000 }, ownerKey(alice)),
  } });
  await connect('original');
  const server = createServer(config, new JobStore(sql), registry);
  let version = 0;
  const messages = new Map<string, { stamp: string; message: AgentMessage }>();
  const latest = (actor: Actor) => messages.get(actor.channel)!;
  const messenger = {
    send: async () => { throw new Error('Expected Slack post or update'); },
    post: async (actor: Actor, message: AgentMessage) => {
      const stamp = `1.${++version}`;
      messages.set(actor.channel, { stamp, message });
      return stamp;
    },
    update: async (actor: Actor, stamp: string, message: AgentMessage) => { messages.set(actor.channel, { stamp, message }); },
  };
  const send = async (url: string, payload: string, type: string, id: string) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', 'fake').update(`v0:${ts}:${payload}`).digest('hex');
    const response = await server.inject({ method: 'POST', url, payload,
      headers: { 'content-type': type, 'x-slack-signature': 'v0=' + sig, 'x-slack-request-timestamp': ts } });
    expect(response.statusCode).toBe(200);
    const job = (await sql.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
    expect(job).toBeDefined();
    await dispatchJob(sql, config, registry, messenger, job);
  };
  let sequence = 0;
  const dm = (actor: Actor, text: string) => {
    const eventId = `personal-${++sequence}`;
    return send('/slack/events', JSON.stringify({ type: 'event_callback', team_id: actor.team, event_id: eventId,
      event: { type: 'message', channel_type: 'im', user: actor.user, channel: actor.channel, text, ts: '1.2' } }),
    'application/json', 'slack:' + eventId);
  };
  const click = (actor: Actor, stamp: string, button: Button) => {
    const raw = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: actor.team }, user: { id: actor.user },
      channel: { id: actor.channel }, message: { ts: stamp }, actions: [{ action_id: button.action, value: button.value, action_ts: String(++sequence) }] }) }).toString();
    return send('/slack/actions', raw, 'application/x-www-form-urlencoded', `action:${digest(raw)}`);
  };
  const navigate = (label: string) => click(alice, latest(alice).stamp, latest(alice).message.buttons!.find(item => item.label === label)!);
  const selectionScreen = async () => {
    await dm(alice, 'menu');
    await navigate('Factures');
    await navigate('Utiliser ma boîte Courrier');
    await navigate('Choisir un libellé');
    expect(latest(alice).message.table?.rows.map(row => row[0])).toEqual(['Mes factures', 'Privé']);
    return { stamp: latest(alice).stamp, choice: latest(alice).message.table!.rowButtons![0] as Button };
  };
  try {
    await dm(alice, 'factures 2026-11');
    expect(gmail).not.toHaveBeenCalled();
    const { stamp, choice } = await selectionScreen();
    const before = gmail.mock.calls.length;
    await click(bob, stamp, choice);
    expect(gmail).toHaveBeenCalledTimes(before);
    expect(latest(bob).message.text).toContain('expiré');
    await click(alice, stamp, choice);
    expect(latest(alice).message.text).toContain('Mes factures');
    await dm(alice, 'factures 2026-11');
    expect(latest(alice).message.text).toContain('authuser=alice%40example.test#all/a1');
    expect(latest(alice).message.text).not.toContain('#all/b2');
    expect((await mail.load(alice)).connection?.id).toBe('original');
    await dm(bob, 'factures 2026-11');
    expect(latest(bob).message.text).toContain('choisissez un libellé');
    await dm(alice, 'menu');
    await navigate('Factures');
    await navigate('Utiliser ma boîte Courrier');
    await navigate('Retirer ma boîte');
    const afterRemoval = gmail.mock.calls.length;
    await dm(alice, 'factures 2026-11');
    expect(gmail).toHaveBeenCalledTimes(afterRemoval);
    const confirmed = await selectionScreen();
    await click(alice, confirmed.stamp, confirmed.choice);
    await connect('replacement');
    const afterReplacement = gmail.mock.calls.length;
    await dm(alice, 'factures 2026-11');
    expect(latest(alice).message.text).toContain('connexion Courrier a changé');
    expect(gmail).toHaveBeenCalledTimes(afterReplacement);
  } finally {
    vi.unstubAllGlobals();
    await server.close();
  }
});
