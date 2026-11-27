import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { readConfig } from '../src/app/config.js';
import { createModules } from '../src/app/modules.js';
import { digest } from '../src/core/crypto.js';
import { dispatchJob } from '../src/core/dispatch.js';
import { ownerKey, type Actor } from '../src/core/identity.js';
import { createServer } from '../src/core/server.js';
import type { AgentMessage, Button } from '../src/core/slack.js';
import { coreSchema, JobStore, type Sql } from '../src/core/store.js';
import { emptyState } from '../src/modules/mail/domain.js';
import { mailSchema, Store } from '../src/modules/mail/store.js';

const baseEnv = { ENABLED_MODULES: 'connexion', SLACK_TEAM_ID: 'TTEAM', SLACK_SIGNING_SECRET: 'fake',
  SLACK_BOT_TOKEN: 'fake', PUBLIC_URL: 'https://example.test', DATABASE_URL: 'unused' };

it('opens an empty connection dashboard without credentials for disabled providers', async () => {
  const sql: Sql = { query: vi.fn() };
  const registry = createModules(readConfig(baseEnv), sql, baseEnv);
  expect(registry.text('connexion')).toEqual({ module: 'connexion', payload: { type: 'text', text: 'menu' } });
  expect(registry.text('connexions aide')).toEqual({ module: 'connexion', payload: { type: 'text', text: 'help' } });
  const page = await registry.all()[0]!.menu!({ team: 'TTEAM', user: 'UALICE', channel: 'DALICE' }, 'main', { sql });
  expect(page.text).toContain('Aucune connexion');
  expect(sql.query).not.toHaveBeenCalled();
});

it('lists only the caller’s accounts and opens the owner module’s signed confirmation', async () => {
  const db = new PGlite();
  const sql: Sql = { async query(statement, values) {
    if (statement === mailSchema) { await db.exec(statement); return { rows: [] }; }
    return db.query(statement, values);
  } };
  const env = { ...baseEnv, ENABLED_MODULES: 'connexion,mail,clickup,factures,hyperdx', ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
    GOOGLE_CLIENT_ID: 'fake', GOOGLE_CLIENT_SECRET: 'fake', GOOGLE_WORKSPACE_DOMAINS: 'example.test', OPENAI_API_KEY: 'fake',
    CLICKUP_CLIENT_ID: 'fake', CLICKUP_CLIENT_SECRET: 'fake', CLICKUP_WORKSPACE_ID: '123',
    HYPERDX_SERVICES: '["test"]', HYPERDX_API_KEY: 'fake' };
  const config = readConfig(env);
  const fetcher = vi.fn(async () => { throw new Error('The dashboard and its confirmations need no network request.'); });
  vi.stubGlobal('fetch', fetcher);
  const registry = createModules(config, sql, env);
  const app = createServer(config, new JobStore(sql), registry);
  const alice = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
  const bob = { team: 'TTEAM', user: 'UBOB', channel: 'DBOB' };
  const store = new Store(sql);
  const messages = new Map<string, { ts: string; message: AgentMessage }>();
  let step = 0;
  const messenger = {
    async send() { throw new Error('Expected a recorded private Slack reply.'); },
    async post(actor: Actor, message: AgentMessage) {
      const ts = `123.${++step}`;
      messages.set(actor.channel, { ts, message });
      return ts;
    },
    async update(actor: Actor, ts: string, message: AgentMessage) { messages.set(actor.channel, { ts, message }); },
  };
  const latest = (actor: Actor) => messages.get(actor.channel)!;
  async function deliver(url: string, payload: string, contentType: string, id: string) {
    const now = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', 'fake').update(`v0:${now}:${payload}`).digest('hex');
    const response = await app.inject({ method: 'POST', url, payload,
      headers: { 'content-type': contentType, 'x-slack-signature': 'v0=' + sig, 'x-slack-request-timestamp': now } });
    expect(response.statusCode).toBe(200);
    const job = (await sql.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
    if (job) await dispatchJob(sql, config, registry, messenger, job);
    return Boolean(job);
  }
  function dm(actor: Actor, text: string, channelType = 'im') {
    const id = `connexion-${++step}`;
    return deliver('/slack/events', JSON.stringify({ type: 'event_callback', team_id: actor.team, event_id: id,
      event: { type: 'message', channel: actor.channel, channel_type: channelType, user: actor.user, text, ts: '1.2' } }),
    'application/json', `slack:${id}`);
  }
  function click(actor: Actor, ts: string, button: Button) {
    const raw = new URLSearchParams({ payload: JSON.stringify({
      type: 'block_actions', team: { id: actor.team }, user: { id: actor.user }, channel: { id: actor.channel },
      message: { ts }, actions: [{ action_id: button.action, value: button.value, action_ts: String(++step) }],
    }) }).toString();
    return deliver('/slack/actions', raw, 'application/x-www-form-urlencoded', `action:${digest(raw)}`);
  }
  try {
    await db.exec(coreSchema);
    for (const module of registry.all()) await module.initialize?.(sql);
    await store.save(alice, { ...emptyState(), connection: { id: 'gmail-alice', subject: 'alice', email: 'alice@example.test', encryptedTokens: 'private-gmail-token' } });
    await sql.query('INSERT INTO clickup_connections(owner,team,subject,connection_id,identity,tokens) VALUES($1,$2,$3,$4,$5,$6)',
      [ownerKey(alice), alice.team, 'clickup-alice', 'clickup-id', JSON.stringify({ name: 'Alice', email: 'alice@clickup.test' }), 'private-clickup-token']);
    expect(await dm({ ...alice, channel: 'CTEAM' }, 'connexion', 'channel')).toBe(false);
    await dm(alice, 'connexion');
    const aliceHome = latest(alice);
    expect(aliceHome.message.kind).toBe('Connexion');
    expect(aliceHome.message.table?.rows).toEqual([
      ['ClickUp', 'Personnel', 'Connecté', 'alice@clickup.test', ''],
      ['Gmail · Courrier', 'Personnel', 'Connecté', 'alice@example.test', ''],
      ['Gmail · Factures', 'Personnel', 'Libellé à choisir', 'alice@example.test', ''],
      ['HyperDX', 'Équipe', 'Intégration configurée', '', ''],
    ]);
    expect(JSON.stringify(aliceHome.message)).not.toContain('private-');
    await dm(bob, 'menu');
    await click(bob, latest(bob).ts, latest(bob).message.buttons!.find(button => button.label === 'Connexion')!);
    expect(latest(bob).message.table?.rows[0]).toEqual(['ClickUp', 'Personnel', 'À connecter', '', '']);
    expect(JSON.stringify(latest(bob).message)).not.toContain('alice@');
    const gmailRow = aliceHome.message.table!.rowButtons![1] as Button;
    await click(bob, aliceHome.ts, gmailRow);
    expect(latest(bob).message.text).toContain('menu est indisponible');
    await click(alice, aliceHome.ts, gmailRow);
    expect(latest(alice).ts).toBe(aliceHome.ts);
    expect(latest(alice).message.kind).toBe('Connexion Gmail');
    await click(alice, latest(alice).ts, latest(alice).message.buttons!.find(button => button.action === 'mail:menu_disconnect')!);
    expect(latest(alice).message.text).toContain('annuler tous les aperçus');
    expect((await store.load(alice)).connection?.id).toBe('gmail-alice');
    await click(alice, latest(alice).ts, latest(alice).message.buttons!.find(button => button.action === 'mail:disconnect')!);
    await dm(alice, 'connexion');
    expect(latest(alice).message.table?.rows[1]).toEqual(['Gmail · Courrier', 'Personnel', 'À connecter', '', '']);
    await click(alice, latest(alice).ts, latest(alice).message.table!.rowButtons![0] as Button);
    expect(latest(alice).message.buttons?.some(button => button.action === 'clickup:disconnect')).toBe(true);
    await dm(alice, 'connexion');
    await click(alice, latest(alice).ts, latest(alice).message.table!.rowButtons![2] as Button);
    expect(latest(alice).message.text).toContain('Connectez d’abord votre Gmail');
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    await app.close();
    await db.close();
  }
});
