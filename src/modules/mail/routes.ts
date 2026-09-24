import type { FastifyInstance } from 'fastify';
import type { GoogleOAuth } from './oauth.js';
import type { JobStore } from '../../core/store.js';

export function registerMailRoutes(app: FastifyInstance, publicUrl: string, store: JobStore, oauth: GoogleOAuth) {
  app.get('/auth/google', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const ticket = String((request.query as any).ticket ?? '');
    if (!/^[\w-]{43}$/.test(ticket)) return reply.code(400).send('Request a connection link in Slack.');
    try {
      const result = await oauth.start(ticket);
      reply.header('Set-Cookie', `gmail_oauth=${result.cookie}; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=600${publicUrl.startsWith('https:') ? '; Secure' : ''}`);
      return reply.redirect(result.url);
    } catch { return reply.code(400).send('This connection link is unavailable. Request a fresh link in Slack.'); }
  });
  app.get('/auth/google/callback', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    reply.header('Set-Cookie', `gmail_oauth=; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=0${publicUrl.startsWith('https:') ? '; Secure' : ''}`);
    const params = request.query as any;
    try {
      if (typeof params.state !== 'string' || typeof params.code !== 'string' || params.error) throw new Error('Incomplete authorization');
      const cookie = String(request.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('gmail_oauth='))?.slice('gmail_oauth='.length) ?? '';
      const result = await oauth.finish(params.state, params.code, cookie);
      await store.enqueue(`connection:${result.connection.id}`, result.actor, { type: 'connection', connection: result.connection }, 'mail');
      return reply.type('text/plain').send('Return to your private Slack conversation and confirm the mailbox address to finish connecting.');
    } catch (error) {
      const known = error instanceof Error ? error.message : '';
      const safe = ['Incomplete authorization', 'Authorization state is expired or already used.', 'Authorization must finish in the browser where it started.', 'Google authorization could not be completed.', 'A verified account in your allowed Google Workspace organization is required.', 'Gmail access was not fully granted.'].includes(known)
        ? known : 'Gmail connection failed or was cancelled. Request a new connection link in Slack.';
      return reply.code(400).type('text/plain').send(`${safe} Request a new connection link in Slack.`);
    }
  });
}
