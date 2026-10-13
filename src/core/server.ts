import Fastify from 'fastify';
import { digest, verifySlack } from './crypto.js';
import { boundMenuTarget } from './navigation.js';
import { logicalAction } from './presentation.js';
import type { ModuleRegistry } from './modules.js';
import type { JobStore } from './store.js';

export function createServer(config: { SLACK_SIGNING_SECRET: string; SLACK_TEAM_ID: string }, store: JobStore, modules: ModuleRegistry) {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000, requestTimeout: 10_000 });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(['application/json', 'application/x-www-form-urlencoded'], { parseAs: 'string' }, (_req, body, done) => done(null, body));
  app.setErrorHandler((_error, _request, reply) => reply.code(400).send({ error: "La demande n’a pas pu être traitée." }));
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
    if (modules.all().some(module => module.receiveChannel || module.channelAccess) && body.type === 'event_callback' && event?.type === 'message' && ['channel', 'group'].includes(event.channel_type) &&
      !event.subtype && !event.bot_id && /^[UW][A-Z0-9]+$/.test(event.user ?? '') && /^[CG][A-Z0-9]+$/.test(event.channel ?? '') && typeof event.text === 'string') {
      if (typeof body.event_id !== 'string' || !body.event_id || event.text.length > 8000 || !/^\d+\.\d+$/.test(event.ts ?? '') ||
        (event.thread_ts !== undefined && !/^\d+\.\d+$/.test(event.thread_ts))) return reply.code(400).send();
      const actor = { team: body.team_id, user: event.user, channel: event.channel, thread: event.thread_ts ?? event.ts };
      const route = modules.text(event.text);
      if (modules.acceptsChannel(route)) {
        await store.enqueue(`slack:${body.event_id}`, actor, route.payload, route.module);
        return { ok: true };
      }
      for (const module of modules.all()) await module.receiveChannel?.(actor, { text: event.text, timestamp: event.ts, thread: event.thread_ts ?? event.ts }, `slack:${body.event_id}`);
      return { ok: true };
    }
    if (body.type !== 'event_callback' || event?.type !== 'message' || event.channel_type !== 'im' || event.subtype || event.bot_id || !/^[UW][A-Z0-9]+$/.test(event.user ?? '') || !/^D[A-Z0-9]+$/.test(event.channel ?? '') || typeof event.text !== 'string') return { ok: true };
    if (!body.event_id || event.text.length > 8000) return reply.code(400).send();
    const route = modules.text(event.text);
    const actor = { team: body.team_id, user: event.user, channel: event.channel };
    const operation = modules.operation(route);
    const receiptOperation = modules.receiptOperation(route);
    if (operation) await store.enqueueOperation(`slack:${body.event_id}`, actor, route.payload, route.module, operation.key, operation.label);
    else if (receiptOperation) await store.enqueueWithOperationSnapshot(`slack:${body.event_id}`, actor, route.payload, route.module, receiptOperation);
    else await store.enqueue(`slack:${body.event_id}`, actor, route.payload, route.module);
    return { ok: true }; // Only durable enqueue is on the acknowledgement path.
  });
  app.post('/slack/actions', async (request, reply) => {
    const raw = String(request.body ?? '');
    if (!verifySlack(raw, String(request.headers['x-slack-request-timestamp'] ?? ''), String(request.headers['x-slack-signature'] ?? ''), config.SLACK_SIGNING_SECRET)) return reply.code(401).send();
    const body = JSON.parse(new URLSearchParams(raw).get('payload') ?? '{}');
    if (body.team?.id !== config.SLACK_TEAM_ID || !/^[UW][A-Z0-9]+$/.test(body.user?.id ?? '')) return reply.code(403).send();
    if (body.type === 'block_suggestion') {
      const view = body.view;
      if (typeof view?.callback_id !== 'string' || typeof view.private_metadata !== 'string' || view.private_metadata.length > 200 ||
        typeof body.block_id !== 'string' || body.block_id.length > 255 || typeof body.action_id !== 'string' || body.action_id.length > 255 ||
        typeof body.value !== 'string' || body.value.length > 500) return reply.code(400).send();
      const forms = modules.formSubmission(view.callback_id);
      if (!forms?.suggest) return reply.code(403).send();
      return forms.suggest({ team: body.team.id, user: body.user.id }, { form: view.private_metadata, block: body.block_id, action: body.action_id, query: body.value });
    }
    if (body.type === 'view_submission') {
      const view = body.view;
      if (typeof view?.callback_id !== 'string' || typeof view.private_metadata !== 'string' || view.private_metadata.length > 200) return reply.code(400).send();
      const forms = modules.formSubmission(view.callback_id);
      if (!forms) return reply.code(403).send();
      // The Module recovers the originating conversation from its actor-owned saved form.
      return forms.submit({ team: body.team.id, user: body.user.id }, view);
    }
    if (!/^[DCG][A-Z0-9]+$/.test(body.channel?.id ?? '')) return reply.code(403).send();
    const action = body.actions?.[0];
    // Only the read-only navigation action accepts a static-select payload.
    if (action?.type === 'static_select') {
      if (action.action_id !== 'core:navigate' || action.value !== undefined || typeof action.selected_option?.value !== 'string') return reply.code(400).send();
      action.value = action.selected_option.value;
    }
    if (body.type !== 'block_actions' || typeof action?.action_id !== 'string' ||
      (action.value !== undefined && (typeof action.value !== 'string' || action.value.length > 500))) return reply.code(400).send();
    if (logicalAction(action.action_id) === undefined) return reply.code(400).send();
    const route = modules.action(action.action_id, action.value ?? '');
    const channel = /^[CG]/.test(body.channel.id);
    if (channel && !modules.acceptsChannel(route)) return reply.code(403).send();
    if (body.message?.ts !== undefined || (route.module === 'core' && ['navigation', 'control_navigation'].includes(String(route.payload.type))) || route.payload.type === 'menu_action') {
      const timestamp = body.message?.ts;
      if (typeof timestamp !== 'string' || !/^\d+\.\d+$/.test(timestamp)) return reply.code(400).send();
      route.payload.timestamp = timestamp;
    }
    const thread = channel ? body.message?.thread_ts ?? body.message?.ts : undefined;
    if (channel && (typeof thread !== 'string' || !/^\d+\.\d+$/.test(thread))) return reply.code(400).send();
    const actor = { team: body.team.id, user: body.user.id, channel: body.channel.id, ...(thread ? { thread } : {}) };
    const forms = modules.formAction(route);
    if (forms) {
      const bound = await boundMenuTarget(store.sql, actor, route.payload.value, route.payload.timestamp);
      if (!bound) {
        await store.enqueue(`action:${digest(raw)}`, actor, { type: 'unavailable' }, channel ? route.module : 'core');
      } else {
        if (typeof body.trigger_id !== 'string' || !body.trigger_id || body.trigger_id.length > 300) return reply.code(400).send();
        await forms.open(actor, { value: bound.value, trigger: body.trigger_id, timestamp: bound.target.timestamp }, `action:${digest(raw)}`);
      }
      return { ok: true };
    }
    const operation = modules.operation(route);
    if (operation && await boundMenuTarget(store.sql, actor, route.payload.value, route.payload.timestamp))
      await store.enqueueOperation(`action:${digest(raw)}`, actor, route.payload, route.module, operation.key, operation.label);
    else await store.enqueue(`action:${digest(raw)}`, actor, route.payload, route.module);
    return { ok: true };
  });
  for (const module of modules.all()) module.registerRoutes?.(app);
  return app;
}
