import { createHmac, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { readConfig } from '../src/app/config.js';
import { frenchCommand } from '../src/app/commands.js';
import { digest } from '../src/core/crypto.js';
import { dispatchJob } from '../src/core/dispatch.js';
import { ModuleRegistry, type AssistantModule } from '../src/core/modules.js';
import { createServer } from '../src/core/server.js';
import { Slack } from '../src/core/slack.js';
import { coreSchema, JobStore } from '../src/core/store.js';
import { createConnexionModule } from '../src/modules/connexion/index.js';
import { createConnexionPanel } from '../src/modules/connexion/panel.js';

it('opens an actor-bound Work Object from Connexion and routes each web row back to its owner module', async () => {
  const db = new PGlite();
  const sql = { query: (text: string, values?: unknown[]) => db.query(text, values) };
  await db.exec(coreSchema);
  const config = readConfig({ SLACK_TEAM_ID: 'TTEAM', SLACK_SIGNING_SECRET: 'test-secret', SLACK_BOT_TOKEN: 'fake',
    DATABASE_URL: 'unused', PUBLIC_URL: 'https://panel.example.test' });
  const alice = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
  const bob = { ...alice, user: 'UBOB', channel: 'DBOB' };
  const posts: Array<{ channel: string; text: string; ts: string; blocks?: any[]; metadata?: any }> = [];
  const previews: any[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(input).endsWith('/entity.presentDetails')) { previews.push(body); return Response.json({ ok: true }); }
    expect(String(input)).toBe('https://slack.com/api/chat.postMessage');
    const ts = `123.${posts.length + 1}`;
    posts.push({ ...body, ts });
    return Response.json({ ok: true, ts });
  };
  const owner: AssistantModule = { id: 'source', description: 'Test authority',
    async connections(actor) {
      return [{ name: 'Compte de test', scope: 'personal', status: 'Intégration configurée', account: `${actor.user}@example.test`, page: 'accounts' }];
    },
    async menu(actor, page) { return { kind: 'Gestion', text: `Gestion de ${actor.user} · ${page}` }; },
    handle: vi.fn(),
  };
  const panel = createConnexionPanel(config, sql, fetcher);
  const connexion = { ...createConnexionModule(config.SLACK_TEAM_ID, () => [owner], panel), normalizeText: (text: string) => frenchCommand('connexion', text) };
  const registry = new ModuleRegistry([connexion, owner]);
  const app = createServer(config, new JobStore(sql), registry), slack = new Slack(config.SLACK_BOT_TOKEN, fetcher);
  async function signed(path: string, raw: string, contentType = 'application/json', valid = true) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', config.SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${raw}`).digest('hex');
    return app.inject({ method: 'POST', url: path, payload: raw, headers: { 'content-type': contentType,
      'x-slack-request-timestamp': timestamp, 'x-slack-signature': valid ? `v0=${signature}` : 'invalid' } });
  }
  async function drain() {
    const rows = (await sql.query("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at")).rows;
    for (const job of rows) {
      await dispatchJob(sql, config, registry, slack, job);
      await new JobStore(sql).complete(job.id);
    }
  }

  try {
    const dm = { type: 'event_callback', event_id: 'EvMenu', team_id: alice.team,
      event: { type: 'message', channel: alice.channel, channel_type: 'im', user: alice.user, text: 'connexion', ts: '123.01' } };
    expect((await signed('/slack/events', JSON.stringify(dm))).statusCode).toBe(200);
    await drain();
    const menu = posts[0]!;
    const launcher = menu.blocks!.flatMap(block => block.child_blocks ?? [])
      .flatMap(block => block.elements ?? []).find(item => item.action_id?.startsWith('connexion:open_panel~'));
    expect(launcher?.text.text).toBe('Ouvrir le tableau interactif');
    const click = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: alice.team }, user: { id: alice.user },
      channel: { id: alice.channel }, message: { ts: menu.ts }, actions: [{ action_id: launcher.action_id, value: launcher.value }] }) }).toString();
    expect((await signed('/slack/actions', click, 'application/x-www-form-urlencoded')).statusCode).toBe(200);
    expect((await sql.query('SELECT id FROM jobs WHERE id=$1', [`action:${digest(click)}`])).rows).toHaveLength(1);
    await drain();

    const card = posts[1]!, entity = card.metadata.entities[0];
    expect(card.ts).not.toBe(menu.ts);
    expect(card.blocks).toBeUndefined();
    expect(JSON.stringify(card)).not.toContain('@example.test');
    expect(entity.entity_payload.attributes.full_size_preview).toEqual({ is_supported: true, mime_type: 'application/vnd.slack-embed' });
    const details = { type: 'event_callback', event_id: 'EvDetails', team_id: alice.team,
      event: { type: 'entity_details_requested', user: alice.user, channel: alice.channel, message_ts: card.ts,
        external_ref: entity.external_ref, entity_url: entity.url, trigger_id: '123.456.trigger' } };
    const otherUser = { ...details, event: { ...details.event, user: bob.user, channel: bob.channel } };
    const otherMessage = { ...details, event: { ...details.event, message_ts: menu.ts } };
    expect((await signed('/slack/events', JSON.stringify(details), 'application/json', false)).statusCode).toBe(401);
    expect((await signed('/slack/events', JSON.stringify(otherUser))).statusCode).toBe(200);
    expect((await signed('/slack/events', JSON.stringify(otherMessage))).statusCode).toBe(200);
    expect(previews).toEqual([]);
    expect((await signed('/slack/events', JSON.stringify(details))).statusCode).toBe(200);
    const preview = new URL(previews[0].metadata.entity_payload.attributes.full_size_preview.preview_url);
    expect(preview.search).toBe('');
    expect(preview.hash).not.toBe('');
    const shell = await app.inject({ url: preview.pathname });
    expect(shell.headers['content-security-policy']).toContain('frame-ancestors https://*.slack.com');
    expect(shell.body).not.toContain('UALICE@example.test');
    expect((await app.inject('/connexion/tableau/donnees')).statusCode).toBe(401);
    const headers = { authorization: `Bearer ${preview.hash.slice(1)}`, origin: 'null' };
    const data = await app.inject({ url: '/connexion/tableau/donnees', headers });
    expect(data.headers['access-control-allow-origin']).toBe('null');
    expect(data.headers['cache-control']).toBe('no-store');
    expect(data.json()).toEqual({ title: 'Connexion', columns: ['Application', 'Accès', 'État enregistré', 'Compte'],
      rows: [['Compte de test', 'Personnel', 'Intégration configurée', 'UALICE@example.test']], filterColumn: 1 });
    expect((await app.inject({ url: '/connexion/tableau/donnees', headers: { ...headers, origin: 'https://other.example.test' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/connexion/tableau/donnees', headers: { ...headers, authorization: headers.authorization + randomUUID() } })).statusCode).toBe(401);
    const preflight = await app.inject({ method: 'OPTIONS', url: '/connexion/tableau/ouvrir', headers: { origin: 'null' } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toContain('Authorization');
    const openRow = (row: number) => app.inject({ method: 'POST', url: '/connexion/tableau/ouvrir', headers, payload: { row } });
    expect((await openRow(12)).statusCode).toBe(404);
    expect((await openRow(0)).statusCode).toBe(202);
    expect((await openRow(0)).statusCode).toBe(202);
    await drain();
    expect(posts).toHaveLength(3);
    expect(posts[2]).toMatchObject({ channel: 'DALICE', text: 'Gestion de UALICE · accounts' });
    expect((await app.inject({ url: '/connexion/tableau/donnees', headers })).statusCode).toBe(200);
    await sql.query('DELETE FROM core_navigation_menus WHERE id=$1', [entity.external_ref.id]);
    expect((await openRow(0)).statusCode).toBe(401);
  } finally { await app.close(); await db.close(); }
});
