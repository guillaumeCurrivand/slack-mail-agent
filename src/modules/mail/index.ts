import { Vault } from '../../core/crypto.js';
import { ownerKey } from '../../core/identity.js';
import type { AssistantModule } from '../../core/modules.js';
import { escapeCardValue, menuButton } from '../../core/slack.js';
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
    id: 'mail', name: 'Mail Sorter', description: 'Sort your Gmail using approved personal rules',
    async menu(actor, page, context) {
      const state = await new Store(context.sql).load(actor);
      const status = state.connection ? `Connected Gmail: ${escapeCardValue(state.connection.email)}.` : 'Gmail is not connected. Sorting requires a connected mailbox.';
      if (page === 'connection') return { kind: 'Gmail connection', text: `${status}\nConnect only your own Google Workspace mailbox. Google sign-in opens outside Slack. Disconnect requires a separate confirmation and keeps saved rules.`,
        buttons: state.connection ? [{ label: 'Disconnect Gmail', action: 'menu_disconnect', value: state.connection.id }]
          : [{ label: 'Connect Gmail', action: 'menu_connect', value: '' }],
        links: [{ label: 'Back to Mail Sorter', page: 'main' }],
      };
      return { kind: 'Mail Sorter', text: `${status}\nCommands: mail sort, mail rules, mail starters, mail report. Describe rules with the mail prefix. Sorting prepares a preview; mailbox changes require separate approval.`,
        links: [{ label: 'Gmail connection', page: 'connection' }],
      };
    },
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
      let event = payload as Event;
      if (payload.type === 'action' && ['menu_connect', 'menu_disconnect'].includes(String(payload.action))) {
        const state = await store.load(actor);
        if (payload.action === 'menu_connect' && state.connection) return context.messenger.send(actor, { text: 'Gmail is already connected. Open Menu to review the current connection.', buttons: [menuButton] });
        if (payload.action === 'menu_disconnect' && (!state.connection || payload.value !== state.connection.id)) return context.messenger.send(actor, { text: 'This connection control is no longer current. Open Menu to review the connection.', buttons: [menuButton] });
        event = { type: 'text', text: payload.action === 'menu_connect' ? 'connect' : 'disconnect' };
      }
      const engine = new Engine({ store, budget: context.budget, messenger: { send: (recipient, message) => context.messenger.send(recipient, {
        ...message, buttons: [...(message.buttons ?? []), menuButton],
      }) },
        intelligence: new OpenAI(config.OPENAI_API_KEY, config.OPENAI_MODEL, context.budget),
        connectUrl: user => oauth.invitation(user),
        mailbox: (user, state) => new Gmail(vault.open<Tokens>(state.connection!.encryptedTokens, ownerKey(user)), config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET,
          async tokens => { state.connection!.encryptedTokens = vault.seal(tokens, ownerKey(user)); await store.save(user, state); }),
      });
      await engine.handle(actor, event, eventId);
    },
  };
}
