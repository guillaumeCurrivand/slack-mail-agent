import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreSchema, JobStore } from '../src/core/store.js';
import { uid, type Actor } from '../src/core/identity.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { dispatchJob } from '../src/core/dispatch.js';
import { createServer } from '../src/core/server.js';
import type { AgentMessage } from '../src/core/slack.js';
import { createClickupModule } from '../src/modules/clickup/index.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('real PostgreSQL ClickUp account ownership', () => {
  const namespace = `test_clickup_${uid().replaceAll('-', '')}`;
  let admin: pg.Pool, pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${namespace}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${namespace}` }); await pool.query(coreSchema);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); await admin.end(); } });
  it('atomically enforces external-account ownership and accepts only one concurrent preference save', async () => {
    const alice = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' }, bob = { ...alice, user: 'UBOB', channel: 'DBOB' };
    const config = { PUBLIC_URL: 'https://agent.example.com', CLICKUP_CLIENT_ID: 'client', CLICKUP_CLIENT_SECRET: 'secret', CLICKUP_WORKSPACE_ID: '42', ENCRYPTION_KEY: randomBytes(32).toString('base64') };
    const fetcher = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/oauth/token')) return Response.json({ access_token: 'fake' });
      if (path.endsWith('/user')) return Response.json({ user: { id: 7, username: 'Alice', email: 'fake@example.com' } });
      if (path.endsWith('/team')) return Response.json({ teams: [{ id: '42', name: 'Mayasquad' }] });
      if (path.endsWith('/team/42/task')) return Response.json({ tasks: [] });
      if (path.endsWith('/team/42/space')) return Response.json({ spaces: [{ id: '10', statuses: [{ status: 'In progress', type: 'custom' }, { status: 'Closed', type: 'closed' }] }] });
      if (path.endsWith('/team/42/shared')) return Response.json({ shared: { folders: [], lists: [], tasks: [] } });
      if (path.endsWith('/space/10/folder')) return Response.json({ folders: [] });
      if (path.endsWith('/space/10/list')) return Response.json({ lists: [] });
      throw new Error('Unexpected provider call');
    }) as typeof fetch;
    const module = createClickupModule(config, pool, { fetcher }), modules = new ModuleRegistry([module]); await module.initialize!(pool);
    const messages: Array<AgentMessage & { actor: Actor; timestamp: string }> = [];
    const messenger = {
      async send(actor: Actor, message: AgentMessage) { messages.push({ ...message, actor, timestamp: `${messages.length + 1}.000` }); },
      async post(actor: Actor, message: AgentMessage) { const timestamp = `${messages.length + 1}.000`; messages.push({ ...message, actor, timestamp }); return timestamp; },
      async update(actor: Actor, timestamp: string, message: AgentMessage) { messages.push({ ...message, actor, timestamp }); },
    };
    const options = { AI_MONTHLY_LIMIT_USD: 0, AI_USER_MONTHLY_LIMIT_USD: 0, AI_ALERT_USD: 8, SLACK_ADMIN_USER_ID: '' };
    const text = (actor: Actor, request: string) => dispatchJob(pool, options, modules, messenger, { ...modules.text(request), actor, id: uid() });
    const app = createServer({ SLACK_TEAM_ID: 'TTEAM', SLACK_SIGNING_SECRET: 'secret' }, new JobStore(pool), modules);
    const proposal = async (actor: Actor) => {
      await text(actor, 'clickup connect');
      const invitation = new URL(messages.at(-1)!.resourceLinks![0]!.url), start = await app.inject(invitation.pathname + invitation.search);
      const finish = await app.inject({ url: `/auth/clickup/callback?state=${new URL(start.headers.location!).searchParams.get('state')}&code=code`, headers: { cookie: String(start.headers['set-cookie']).split(';')[0]! } });
      expect(finish.statusCode).toBe(200);
      const job = (await pool.query("SELECT * FROM jobs WHERE owner=$1 AND module='clickup'", [`${actor.team}:${actor.user}`])).rows[0];
      await dispatchJob(pool, options, modules, messenger, job); return messages.at(-1)!;
    };
    try {
      const first = await proposal(alice), second = await proposal(bob);
      await Promise.all([first, second].map(message => {
        const button = message.buttons!.find(button => button.action === 'clickup:confirm')!;
        const route = modules.action(button.action, button.value);
        return dispatchJob(pool, options, modules, messenger, { ...route, payload: { ...route.payload, timestamp: message.timestamp }, actor: message.actor, id: uid() });
      }));
      const outcomes = messages.slice(-2).map(message => message.text);
      expect(outcomes.filter(text => text.includes('est connecté à Mayasquad'))).toHaveLength(1);
      expect(outcomes.filter(text => text.includes('déjà connecté par un autre'))).toHaveLength(1);
      await text(alice, 'clickup tasks'); await text(bob, 'clickup tasks');
      expect(messages.slice(-2).filter(message => message.text.includes('0 tâches'))).toHaveLength(1);
      expect(messages.slice(-2).filter(message => message.text.includes('Connectez'))).toHaveLength(1);
      const active = messages.slice(-2).find(message => message.text.includes('0 tâches'))!.actor;
      await text(active, 'clickup statuses'); const older = messages.at(-1)!;
      await text(active, 'clickup statuses'); const newer = messages.at(-1)!;
      const click = (message: typeof older, label: string) => {
        const button = message.buttons!.find(button => button.label === label)!;
        const route = modules.action(button.action, button.value);
        return dispatchJob(pool, options, modules, messenger, { ...route, payload: { ...route.payload, timestamp: message.timestamp }, actor: active, id: uid() });
      };
      await click(older, 'Ajouter Closed'); const firstSave = messages.at(-1)!;
      await click(newer, 'Ajouter Closed'); await click(messages.at(-1)!, 'Retirer In progress'); const secondSave = messages.at(-1)!;
      await Promise.all([click(firstSave, 'Enregistrer'), click(secondSave, 'Enregistrer')]);
      expect(messages.slice(-2).filter(message => message.text.includes('Votre filtre est enregistré'))).toHaveLength(1);
      expect(messages.slice(-2).filter(message => message.text.includes('autre sauvegarde'))).toHaveLength(1);
      await text(active, 'clickup statuses');
      expect(messages.at(-1)!.buttons!.map(button => button.label)).toContain('Retirer Closed');
    } finally { await app.close(); }
  });
});
