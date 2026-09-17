import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { digest, opaque, Vault } from './crypto.js';
import { ownerKey, uid, type Actor, type Connection } from './domain.js';
import type { Config } from './config.js';
import type { Store } from './store.js';

const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
type VerifyIdentity = (token: string, audience: string) => Promise<JWTPayload>;
const verifyIdentity: VerifyIdentity = async (token, audience) => (await jwtVerify(token, keys, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience, algorithms: ['RS256'] })).payload;
type Login = { actor: Actor; verifier: string; nonce: string; cookie: string };
export class GoogleOAuth {
  constructor(private config: Config, private store: Store, private vault: Vault, private fetcher: typeof fetch = fetch, private verify: VerifyIdentity = verifyIdentity) {}
  async invitation(actor: Actor) {
    const ticket = opaque();
    await this.store.putState(digest(ticket), 'ticket', this.vault.seal(actor, 'oauth-ticket'));
    return `${this.config.PUBLIC_URL}/auth/google?ticket=${encodeURIComponent(ticket)}`;
  }
  async start(ticket: string) {
    const envelope = await this.store.takeState(digest(ticket), 'ticket');
    if (!envelope) throw new Error('This connection link has expired or was used. Request a new link in Slack.');
    const actor = this.vault.open<Actor>(envelope, 'oauth-ticket');
    const state = opaque(), verifier = opaque(), nonce = opaque(), cookie = opaque();
    await this.store.putState(digest(state), 'login', this.vault.seal({ actor, verifier, nonce, cookie: digest(cookie) }, 'oauth-login'));
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.config.GOOGLE_CLIENT_ID, redirect_uri: `${this.config.PUBLIC_URL}/auth/google/callback`,
      response_type: 'code', scope: 'openid email https://www.googleapis.com/auth/gmail.modify',
      access_type: 'offline', prompt: 'consent select_account', state, nonce,
      code_challenge: digest(verifier), code_challenge_method: 'S256',
      ...(this.config.domains.length === 1 ? { hd: this.config.domains[0]! } : {}),
    }).toString();
    return { url: url.toString(), cookie };
  }
  async finish(state: string, code: string, cookie: string): Promise<{ actor: Actor; connection: Connection }> {
    const envelope = await this.store.takeState(digest(state), 'login');
    if (!envelope) throw new Error('Authorization state is expired or already used.');
    const login = this.vault.open<Login>(envelope, 'oauth-login');
    if (!cookie || digest(cookie) !== login.cookie) throw new Error('Authorization must finish in the browser where it started.');
    const response = await this.fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST', body: new URLSearchParams({ code, client_id: this.config.GOOGLE_CLIENT_ID, client_secret: this.config.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${this.config.PUBLIC_URL}/auth/google/callback`, grant_type: 'authorization_code', code_verifier: login.verifier }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('Google authorization could not be completed.');
    const tokens = await response.json() as any;
    const expires = Number(tokens.expires_in);
    const scopes = String(tokens.scope ?? '').split(/[\s+,]+/).filter(Boolean);
    const payload = await this.verify(tokens.id_token, this.config.GOOGLE_CLIENT_ID);
    if (payload.nonce !== login.nonce || payload.email_verified !== true || typeof payload.hd !== 'string' || !this.config.domains.includes(payload.hd.toLowerCase()) || typeof payload.email !== 'string' || !payload.sub) throw new Error('A verified account in your allowed Google Workspace organization is required.');
    if (!tokens.access_token || !tokens.refresh_token || !Number.isFinite(expires) || expires <= 0 || (scopes.length > 0 && !scopes.includes('https://www.googleapis.com/auth/gmail.modify'))) throw new Error('Gmail access was not fully granted.');
    const connection: Connection = { id: uid(), subject: payload.sub, email: payload.email,
      encryptedTokens: this.vault.seal({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + expires * 1000 }, ownerKey(login.actor)) };
    return { actor: login.actor, connection };
  }
}
