import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Vault } from '../src/crypto.js';
import { GoogleOAuth } from '../src/oauth.js';
import { Store, schema } from '../src/store.js';
import type { Config } from '../src/config.js';

let db: PGlite, store: Store;
const config = { PUBLIC_URL: 'https://agent.example.com', GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'secret', domains: ['example.com'] } as Config;
const actor = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
beforeAll(async () => { db = new PGlite(); await db.exec(schema); store = new Store({ query: (q, p) => db.query(q, p) }); });
beforeEach(async () => { await db.exec('TRUNCATE oauth_states'); });
afterAll(async () => db.close());
function setup(overrides: Record<string, unknown> = {}) {
  const vault = new Vault(randomBytes(32)); let nonce = '', calls = 0;
  const fetcher = (async () => { calls++; return Response.json({ id_token: 'jwt', access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/gmail.modify' }); }) as typeof fetch;
  // JWT signature/audience/issuer/expiry are verified by jose in production; here test the app's additional binding checks.
  const oauth = new GoogleOAuth(config, store, vault, fetcher, async (_token, audience) => {
    expect(audience).toBe('client-id');
    return { sub: 'google-alice', email: 'alice@example.com', email_verified: true, hd: 'example.com', nonce, ...overrides };
  });
  const begin = async () => {
    const invitation = await oauth.invitation(actor), ticket = new URL(invitation).searchParams.get('ticket')!;
    const start = await oauth.start(ticket), url = new URL(start.url);
    nonce = url.searchParams.get('nonce')!;
    return { ticket, cookie: start.cookie, state: url.searchParams.get('state')!, url };
  };
  return { oauth, begin, vault, calls: () => calls };
}
it('binds a Workspace authorization to its browser and originating Slack user, without activating it', async () => {
  const h = setup(), flow = await h.begin();
  expect(flow.url.searchParams.get('code_challenge_method')).toBe('S256');
  const result = await h.oauth.finish(flow.state, 'code', flow.cookie);
  expect(result.actor).toEqual(actor); expect(result.connection.email).toBe('alice@example.com');
  expect((await store.load(actor)).connection).toBeUndefined();
  expect(h.vault.open(result.connection.encryptedTokens, 'TTEAM:UALICE')).toMatchObject({ refresh_token: 'refresh' });
  await expect(h.oauth.finish(flow.state, 'code', flow.cookie)).rejects.toThrow();
});
it('rejects a different browser before exchanging an authorization code', async () => {
  const h = setup(), flow = await h.begin();
  await expect(h.oauth.finish(flow.state, 'code', 'wrong-cookie')).rejects.toThrow(); expect(h.calls()).toBe(0);
});
it('rejects a personal account even when its email string resembles the allowed domain', async () => {
  const h = setup({ hd: undefined }), flow = await h.begin();
  await expect(h.oauth.finish(flow.state, 'code', flow.cookie)).rejects.toThrow();
});
it('rejects an ID token with the wrong nonce', async () => {
  const h = setup({ nonce: 'other-login' }), flow = await h.begin();
  await expect(h.oauth.finish(flow.state, 'code', flow.cookie)).rejects.toThrow();
});
