import Fastify from 'fastify';
import { digest, verifySlack } from './crypto.js';
import type { Config } from './config.js';
import type { GoogleOAuth } from './oauth.js';
import type { Store } from './store.js';

export function createServer(config: Pick<Config, 'SLACK_SIGNING_SECRET' | 'SLACK_TEAM_ID' | 'PUBLIC_URL'>, store: Store, oauth: GoogleOAuth) {
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
    await store.enqueue(`slack:${body.event_id}`, { team: body.team_id, user: event.user, channel: event.channel }, { type: 'text', text: event.text });
    return { ok: true }; // Only durable enqueue is on the acknowledgement path.
  });
  app.post('/slack/actions', async (request, reply) => {
    const raw = String(request.body ?? '');
    if (!verifySlack(raw, String(request.headers['x-slack-request-timestamp'] ?? ''), String(request.headers['x-slack-signature'] ?? ''), config.SLACK_SIGNING_SECRET)) return reply.code(401).send();
    const body = JSON.parse(new URLSearchParams(raw).get('payload') ?? '{}');
    if (body.team?.id !== config.SLACK_TEAM_ID || !/^[UW][A-Z0-9]+$/.test(body.user?.id ?? '') || !/^D[A-Z0-9]+$/.test(body.channel?.id ?? '')) return reply.code(403).send();
    const action = body.actions?.[0];
    if (body.type !== 'block_actions' || typeof action?.action_id !== 'string' || typeof action.value !== 'string' || action.value.length > 500) return reply.code(400).send();
    await store.enqueue(`action:${digest(raw)}`, { team: body.team.id, user: body.user.id, channel: body.channel.id }, { type: 'action', action: action.action_id, value: action.value });
    return { ok: true };
  });
  app.get('/auth/google', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const ticket = String((request.query as any).ticket ?? '');
    if (!/^[\w-]{43}$/.test(ticket)) return reply.code(400).send('Request a connection link in Slack.');
    try {
      const result = await oauth.start(ticket);
      reply.header('Set-Cookie', `gmail_oauth=${result.cookie}; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=600${config.PUBLIC_URL.startsWith('https:') ? '; Secure' : ''}`);
      return reply.redirect(result.url);
    } catch { return reply.code(400).send('This connection link is unavailable. Request a fresh link in Slack.'); }
  });
  app.get('/auth/google/callback', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    reply.header('Set-Cookie', `gmail_oauth=; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=0${config.PUBLIC_URL.startsWith('https:') ? '; Secure' : ''}`);
    const params = request.query as any;
    try {
      if (typeof params.state !== 'string' || typeof params.code !== 'string' || params.error) throw new Error('Incomplete authorization');
      const cookie = String(request.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('gmail_oauth='))?.slice('gmail_oauth='.length) ?? '';
      const result = await oauth.finish(params.state, params.code, cookie);
      await store.enqueue(`connection:${result.connection.id}`, result.actor, { type: 'connection', connection: result.connection });
      return reply.type('text/plain').send('Return to your private Slack conversation and confirm the mailbox address to finish connecting.');
    } catch { return reply.code(400).type('text/plain').send('Gmail connection failed or was cancelled. Request a new connection link in Slack.'); }
  });
  return app;
}
