import { Vault } from '../../core/crypto.js';
import { ownerKey, type Actor } from '../../core/identity.js';
import type { Sql } from '../../core/store.js';
import type { MailConfig } from './config.js';
import { Gmail, type Tokens } from './gmail.js';
import { Store } from './store.js';

/** Keep token decryption and refresh entirely within Courrier. */
export function createMailFacturesSource(config: MailConfig, fetcher = fetch) {
  const vault = new Vault(Buffer.from(config.ENCRYPTION_KEY, 'base64'));
  return async (actor: Actor, sql: Sql) => {
    if (!/^D[A-Z0-9]+$/.test(actor.channel)) return;
    const store = new Store(sql);
    const connection = (await store.load(actor)).connection;
    if (!connection) return;
    const current = async () => (await store.load(actor)).connection?.id === connection.id;
    let gmail: Gmail | undefined;
    async function connectedGmail() {
      if (!await current()) throw new Error('Courrier account has changed.');
      // A read from Factures must never write a stale snapshot of Courrier state.
      return gmail ??= new Gmail(vault.open<Tokens>(connection!.encryptedTokens, ownerKey(actor)),
        config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, async () => {}, fetcher);
    }
    return {
      connectionId: connection.id, mailbox: connection.email,
      current,
      labels: async () => (await connectedGmail()).labels(),
      listMessages: async (params: URLSearchParams) => (await connectedGmail()).listMessages(params),
      readMessage: async (id: string) => (await connectedGmail()).readMessage(id),
    };
  };
}
