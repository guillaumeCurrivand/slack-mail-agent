import { digest, opaque, Vault } from '../../core/crypto.js';
import { ownerKey, uid, type Actor } from '../../core/identity.js';
import { JobStore } from '../../core/store.js';
import { ClickupAPI } from './api.js';
import type { ClickupConfig } from './config.js';
import { ClickupStore } from './store.js';
import { ownedTransition, type ClickupDatabase } from './transactions.js';
type Login = { actor: Actor; expected: string | null; generation: string; cookie: string };

export class ClickupOAuth {
  private store: ClickupStore;
  constructor(private config: ClickupConfig, private database: ClickupDatabase, private vault: Vault, private fetcher: typeof fetch = fetch) { this.store = new ClickupStore(database); }
  async invitation(actor: Actor) {
    const ticket = opaque(), expected = (await this.store.connection(actor))?.id ?? null;
    const generation = await this.store.generation(actor);
    await this.store.putState(digest(ticket), actor, 'ticket', this.vault.seal({ actor, expected, generation }, 'clickup:ticket'));
    return `${this.config.PUBLIC_URL}/auth/clickup?ticket=${ticket}`;
  }
  async start(ticket: string) {
    const encrypted = await this.store.readState(digest(ticket), 'ticket');
    if (!encrypted) throw new Error('Unavailable invitation');
    const data = this.vault.open<Omit<Login, 'cookie'>>(encrypted, 'clickup:ticket');
    const state = opaque(), cookie = opaque();
    const started = await ownedTransition(this.database, data.actor, async sql => {
      const store = new ClickupStore(sql);
      if (!await store.takeState(digest(ticket), 'ticket') || !await this.current(store, data)) return false;
      await store.putState(digest(state), data.actor, 'login', this.vault.seal({ ...data, cookie: digest(cookie) }, 'clickup:login'));
      return true;
    });
    if (!started) throw new Error('Unavailable invitation');
    const url = new URL('https://app.clickup.com/api');
    url.search = new URLSearchParams({ client_id: this.config.CLICKUP_CLIENT_ID, redirect_uri: `${this.config.PUBLIC_URL}/auth/clickup/callback`, state }).toString();
    return { url: url.toString(), cookie };
  }
  async finish(state: string, code: string, cookie: string) {
    const encrypted = await this.store.readState(digest(state), 'login');
    if (!encrypted) throw new Error('Unavailable authorization');
    const login = this.vault.open<Login>(encrypted, 'clickup:login');
    const available = await ownedTransition(this.database, login.actor, async sql => {
      const store = new ClickupStore(sql);
      return !!await store.takeState(digest(state), 'login') && await this.current(store, login);
    });
    if (!available) throw new Error('Unavailable authorization');
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
    await ownedTransition(this.database, login.actor, async sql => {
      const store = new ClickupStore(sql);
      if (!await this.current(store, login)) throw new Error('Authorization cancelled');
      const confirmationId = await store.propose(login.actor, `oauth:${connection.id}`, 'connect', connection, login.expected);
      await new JobStore(sql).enqueue(`clickup-connection:${confirmationId}`, login.actor, { type: 'connection', id: confirmationId }, 'clickup');
    });
  }
  private async current(store: ClickupStore, login: Omit<Login, 'cookie'>) {
    return await store.generation(login.actor) === login.generation && ((await store.connection(login.actor))?.id ?? null) === login.expected;
  }
}
