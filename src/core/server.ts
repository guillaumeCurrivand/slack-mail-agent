import Fastify from 'fastify';
import { digest, verifySlack } from './crypto.js';
import type { ModuleRegistry } from './modules.js';
import type { JobStore } from './store.js';

export function createServer(config: { SLACK_SIGNING_SECRET: string; SLACK_TEAM_ID: string }, store: JobStore, modules: ModuleRegistry) {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000, requestTimeout: 10_000 });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(['application/json', 'application/x-www-form-urlencoded'], { parseAs: 'string' }, (_req, body, done) => done(null, body));
  app.setErrorHandler((_error, _request, reply) => reply.code(400).send({ error: 'Request could not be processed.' }));
  app.get('/health', async () => ({ ok: true }));
  app.get('/ready', async (_req, reply) => {
    try { await store.sql.query('SELECT 1'); return { ok: true }; } catch { return reply.code(503).send({ ok: false }); }
  });
  app.post('/slack/events', async (request, reply) => {
    const raw = String(request.body ?? '');
    if (!verifySlack(raw, String(request.headers['x-slack-request-timestamp'] ?? ''), String(request.headers['x-slack-signature'] ?? ''), config.SLACK_SIGNING_SECRET)) return reply.code(401).send();
    const body = JSON.parse(raw);
    if (body.type === 'url_verification') return { challenge: body.challenge };
    if (body.team_id !== config.SLACK_TEAM_ID) return reply.code(403).send();
    const event = body.event;
    if (body.type !== 'event_callback' || event?.type !== 'message' || event.channel_type !== 'im' || event.subtype || event.bot_id || !/^[UW][A-Z0-9]+$/.test(event.user ?? '') || !/^D[A-Z0-9]+$/.test(event.channel ?? '') || typeof event.text !== 'string') return { ok: true };
    if (!body.event_id || event.text.length > 8000) return reply.code(400).send();
    const route = modules.text(event.text);
    await store.enqueue(`slack:${body.event_id}`, { team: body.team_id, user: event.user, channel: event.channel }, route.payload, route.module);
    return { ok: true }; // Only durable enqueue is on the acknowledgement path.
  });
  app.post('/slack/actions', async (request, reply) => {
    const raw = String(request.body ?? '');
    if (!verifySlack(raw, String(request.headers['x-slack-request-timestamp'] ?? ''), String(request.headers['x-slack-signature'] ?? ''), config.SLACK_SIGNING_SECRET)) return reply.code(401).send();
    const body = JSON.parse(new URLSearchParams(raw).get('payload') ?? '{}');
    if (body.team?.id !== config.SLACK_TEAM_ID || !/^[UW][A-Z0-9]+$/.test(body.user?.id ?? '') || !/^D[A-Z0-9]+$/.test(body.channel?.id ?? '')) return reply.code(403).send();
    const action = body.actions?.[0];
    if (body.type !== 'block_actions' || typeof action?.action_id !== 'string' || typeof action.value !== 'string' || action.value.length > 500) return reply.code(400).send();
    const route = modules.action(action.action_id, action.value);
    if ((route.module === 'core' && route.payload.type === 'navigation') || route.payload.type === 'menu_action') {
      const timestamp = body.message?.ts;
      if (typeof timestamp !== 'string' || !/^\d+\.\d+$/.test(timestamp)) return reply.code(400).send();
      route.payload.timestamp = timestamp;
    }
    await store.enqueue(`action:${digest(raw)}`, { team: body.team.id, user: body.user.id, channel: body.channel.id }, route.payload, route.module);
    return { ok: true };
  });
  for (const module of modules.all()) module.registerRoutes?.(app);
  return app;
}
