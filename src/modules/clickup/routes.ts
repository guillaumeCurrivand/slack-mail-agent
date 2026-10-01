import type { FastifyInstance } from 'fastify';
import type { JobStore } from '../../core/store.js';
import type { ClickupOAuth } from './oauth.js';

export function registerClickupRoutes(app: FastifyInstance, publicUrl: string, jobs: JobStore, oauth: ClickupOAuth) {
  const cookie = (value: string, maxAge: number) => `clickup_oauth=${value}; HttpOnly; SameSite=Lax; Path=/auth/clickup; Max-Age=${maxAge}${publicUrl.startsWith('https:') ? '; Secure' : ''}`;
  app.get('/auth/clickup', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const ticket = (request.query as Record<string, unknown>).ticket;
    if (typeof ticket !== 'string' || !/^[\w-]{43}$/.test(ticket)) return reply.code(400).send('Demandez un lien de connexion ClickUp dans Slack.');
    try {
      const start = await oauth.start(ticket);
      reply.header('Set-Cookie', cookie(start.cookie, 600));
      return reply.redirect(start.url);
    } catch { return reply.code(400).send('Ce lien est expiré ou déjà utilisé. Demandez un nouveau lien dans Slack.'); }
  });
  app.get('/auth/clickup/callback', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('Set-Cookie', cookie('', 0));
    const { state, code, error } = request.query as Record<string, unknown>;
    try {
      if (typeof state !== 'string' || !/^[\w-]{43}$/.test(state) || typeof code !== 'string' || !code || error) throw new Error('Incomplete authorization');
      const browserCookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('clickup_oauth='))?.slice('clickup_oauth='.length) ?? '';
      const result = await oauth.finish(state, code, browserCookie);
      await jobs.enqueue(`clickup-connection:${result.confirmationId}`, result.actor, { type: 'connection', id: result.confirmationId }, 'clickup');
      return reply.type('text/plain').send('Revenez dans votre conversation privée Slack et confirmez votre compte ClickUp pour terminer la connexion.');
    } catch { return reply.code(400).type('text/plain').send('La connexion ClickUp a échoué ou a expiré. Terminez-la dans le navigateur initial et autorisez Mayasquad. Demandez un nouveau lien dans Slack.'); }
  });
}
