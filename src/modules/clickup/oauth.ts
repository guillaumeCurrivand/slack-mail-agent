import { digest, opaque, Vault } from '../../core/crypto.js';
import { ownerKey, uid, type Actor } from '../../core/identity.js';
import { ClickupAPI } from './api.js';
import type { ClickupConfig } from './config.js';
import { ClickupStore } from './store.js';
type Login = { actor: Actor; expected: string | null; cookie: string };

export class ClickupOAuth {
  constructor(private config: ClickupConfig, private store: ClickupStore, private vault: Vault, private fetcher: typeof fetch = fetch) {}
  async invitation(actor: Actor) {
    const ticket = opaque(), expected = (await this.store.connection(actor))?.id ?? null;
    await this.store.putState(digest(ticket), actor, 'ticket', this.vault.seal({ actor, expected }, 'clickup:ticket'));
    return `${this.config.PUBLIC_URL}/auth/clickup?ticket=${ticket}`;
  }
  async start(ticket: string) {
    const encrypted = await this.store.takeState(digest(ticket), 'ticket');
    if (!encrypted) throw new Error('Unavailable invitation');
    const data = this.vault.open<Omit<Login, 'cookie'>>(encrypted, 'clickup:ticket');
    const state = opaque(), cookie = opaque();
    await this.store.putState(digest(state), data.actor, 'login', this.vault.seal({ ...data, cookie: digest(cookie) }, 'clickup:login'));
    const url = new URL('https://app.clickup.com/api');
    url.search = new URLSearchParams({ client_id: this.config.CLICKUP_CLIENT_ID, redirect_uri: `${this.config.PUBLIC_URL}/auth/clickup/callback`, state }).toString();
    return { url: url.toString(), cookie };
  }
  async finish(state: string, code: string, cookie: string) {
    const encrypted = await this.store.takeState(digest(state), 'login');
    if (!encrypted) throw new Error('Unavailable authorization');
    const login = this.vault.open<Login>(encrypted, 'clickup:login');
    if (!cookie || digest(cookie) !== login.cookie) throw new Error('Wrong browser');
    const response = await this.fetcher('https://api.clickup.com/api/v2/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: this.config.CLICKUP_CLIENT_ID, client_secret: this.config.CLICKUP_CLIENT_SECRET, code }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('Authorization failed');
    const tokens = await response.json() as { access_token?: unknown };
    if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw new Error('Authorization failed');
    const api = new ClickupAPI(tokens.access_token, this.fetcher);
    const identity = await api.identity();
    await api.workspace(this.config.CLICKUP_WORKSPACE_ID);
    const connection = { id: uid(), identity, tokens: this.vault.seal({ token: tokens.access_token }, `clickup:${ownerKey(login.actor)}`) };
    const confirmationId = await this.store.propose(login.actor, `oauth:${connection.id}`, 'connect', connection, login.expected);
    return { actor: login.actor, confirmationId };
  }
}
