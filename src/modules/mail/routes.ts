import type { FastifyInstance } from 'fastify';
import type { GoogleOAuth } from './oauth.js';
import type { JobStore } from '../../core/store.js';

export function registerMailRoutes(app: FastifyInstance, publicUrl: string, store: JobStore, oauth: GoogleOAuth) {
  app.get('/auth/google', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const ticket = String((request.query as any).ticket ?? '');
    if (!/^[\w-]{43}$/.test(ticket)) return reply.code(400).send("Demandez un lien de connexion dans Slack.");
    try {
      const result = await oauth.start(ticket);
      reply.header('Set-Cookie', `gmail_oauth=${result.cookie}; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=600${publicUrl.startsWith('https:') ? '; Secure' : ''}`);
      return reply.redirect(result.url);
    } catch { return reply.code(400).send("Ce lien de connexion est indisponible. Demandez un nouveau lien dans Slack."); }
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
      return reply.type('text/plain').send("Revenez à votre conversation privée Slack et confirmez l’adresse de la boîte e-mail pour terminer la connexion.");
    } catch (error) {
      const known = error instanceof Error ? error.message : '';
      const errors: Record<string, string> = {
        'Incomplete authorization': 'Autorisation incomplète.',
        'Authorization state is expired or already used.': 'Cette autorisation a expiré ou a déjà été utilisée.',
        'Authorization must finish in the browser where it started.': 'Terminez l’autorisation dans le navigateur où elle a commencé.',
        'Google authorization could not be completed.': 'L’autorisation Google n’a pas pu aboutir.',
        'A verified account in your allowed Google Workspace organization is required.': 'Un compte vérifié de votre organisation Google Workspace autorisée est requis.',
        'Gmail access was not fully granted.': 'Les accès Gmail requis n’ont pas tous été accordés.',
      };
      const safe = errors[known] ?? 'La connexion Gmail a échoué ou a été annulée.';
      return reply.code(400).type('text/plain').send(`${safe} Demandez un nouveau lien de connexion dans Slack.`);
    }
  });
}
