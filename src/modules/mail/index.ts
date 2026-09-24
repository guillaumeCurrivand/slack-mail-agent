import { Vault } from '../../core/crypto.js';
import { ownerKey } from '../../core/identity.js';
import type { AssistantModule } from '../../core/modules.js';
import { JobStore, withOwner, type Sql } from '../../core/store.js';
import { OpenAI } from './ai.js';
import type { MailConfig } from './config.js';
import { Engine, type Event } from './engine.js';
import { Gmail, type Tokens } from './gmail.js';
import { GoogleOAuth } from './oauth.js';
import { registerMailRoutes } from './routes.js';
import { mailSchema, prune, Store } from './store.js';

export function createMailModule(config: MailConfig & { PUBLIC_URL: string }, sql: Sql): AssistantModule {
  const vault = new Vault(Buffer.from(config.ENCRYPTION_KEY, 'base64'));
  const oauth = new GoogleOAuth(config, new Store(sql), vault);
  return {
    id: 'mail', description: 'Sort your Gmail using approved personal rules',
    // Only exact action IDs emitted by pre-module versions are accepted.
    legacyActions: ['approve_draft', 'cancel_draft', 'disconnect', 'details', 'report', 'cancel_run', 'accept_item', 'skip_item', 'confirm_run', 'undo_run'],
    async initialize(database) { await database.query(mailSchema); },
    registerRoutes(app) { registerMailRoutes(app, config.PUBLIC_URL, new JobStore(sql), oauth); },
    async cleanup(pool) {
      await new Store(pool).cleanup();
      const users = await pool.query('SELECT team,slack_user FROM users');
      for (const row of users.rows) {
        const actor = { team: row.team, user: row.slack_user, channel: '' };
        await withOwner(pool, actor, async client => {
          const store = new Store(client), state = await store.load(actor);
          prune(state); await store.save(actor, state);
        });
      }
    },
    async handle(actor, payload, eventId, context) {
      // HTTP ingress constructs text/actions; only the mail OAuth callback can
      // enqueue a connection. Persisted pre-module jobs use the same shape.
      if (!['text', 'action', 'connection'].includes(String(payload.type))) throw new Error('Unsupported mail event.');
      const store = new Store(context.sql);
      const engine = new Engine({ store, budget: context.budget, messenger: context.messenger,
        intelligence: new OpenAI(config.OPENAI_API_KEY, config.OPENAI_MODEL, context.budget),
        connectUrl: user => oauth.invitation(user),
        mailbox: (user, state) => new Gmail(vault.open<Tokens>(state.connection!.encryptedTokens, ownerKey(user)), config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET,
          async tokens => { state.connection!.encryptedTokens = vault.seal(tokens, ownerKey(user)); await store.save(user, state); }),
      });
      await engine.handle(actor, payload as Event, eventId);
    },
  };
}
