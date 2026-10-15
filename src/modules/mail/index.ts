import { Vault } from '../../core/crypto.js';
import { isDeepStrictEqual } from 'node:util';
import { ownerKey } from '../../core/identity.js';
import type { AssistantModule } from '../../core/modules.js';
import { menuButton } from '../../core/slack.js';
import { JobStore, withOwner, type Sql } from '../../core/store.js';
import { boundMenuTarget, Navigation } from '../../core/navigation.js';
import { OpenAI } from './ai.js';
import type { MailConfig } from './config.js';
import { Engine, SORT_OPERATION, type Event } from './engine.js';
import { Gmail, type Tokens } from './gmail.js';
import { GoogleOAuth } from './oauth.js';
import { registerMailRoutes } from './routes.js';
import { mailSchema, prune, Store } from './store.js';
import { mailMenu } from './menu.js';
import { mailHelp } from './help.js';
import { RuleForms } from './forms.js';

export function createMailModule(config: MailConfig & { PUBLIC_URL: string }, sql: Sql, slackToken = ''): AssistantModule {
  const vault = new Vault(Buffer.from(config.ENCRYPTION_KEY, 'base64'));
  const forms = new RuleForms(sql, slackToken);
  const oauth = new GoogleOAuth(config, new Store(sql), vault);
  return {
    id: 'mail', name: "Tri des e-mails", description: "Trier votre Gmail selon vos règles personnelles approuvées",
    help: mailHelp,
    workOperations: [{ key: SORT_OPERATION, label: "Trier la boîte de réception", commands: ['sort', 'sort my inbox', 'sort my mail'], action: 'sort_inbox', snapshotUnknownText: true }],
    menuActions: ['sort_inbox', 'form_prepare', 'form_open'],
    forms: forms.forms,
    async menu(actor, page, context) {
      const state = await new Store(context.sql).load(actor);
      return mailMenu(state, page);
    },
    // Only exact action IDs emitted by pre-module versions are accepted.
    legacyActions: ['approve_draft', 'cancel_draft', 'disconnect', 'details', 'report', 'cancel_run', 'accept_item', 'skip_item', 'confirm_run', 'undo_run'],
    async initialize(database) { await database.query(mailSchema); await forms.initialize(); },
    registerRoutes(app) { registerMailRoutes(app, config.PUBLIC_URL, new JobStore(sql), oauth); },
    async cleanup(pool) {
      await forms.cleanup();
      await new Store(pool).cleanup();
      const users = await pool.query('SELECT team,slack_user FROM users');
      for (const row of users.rows) {
        const actor = { team: row.team, user: row.slack_user, channel: '' };
        await withOwner(pool, actor, async client => {
          const store = new Store(client), state = await store.load(actor);
          prune(state); await store.save(actor, state);
        }, 'mail');
      }
    },
    async handle(actor, payload, eventId, context) {
      if (payload.type === 'guided_form_notice' || (payload.type === 'menu_action' && payload.action === 'form_prepare')) {
        let form;
        if (payload.type === 'menu_action') {
          const bound = await boundMenuTarget(context.sql, actor, payload.value, payload.timestamp);
          const state = await new Store(context.sql).load(actor);
          const base = bound && state.rules.find(rule => rule.id === bound.value);
          if (bound && (bound.value === 'new' || base)) form = await forms.prepare(actor, eventId, bound.target.timestamp, forms.definition(base || undefined));
        } else form = await forms.get(actor, String(payload.form));
        return new Navigation(context.sql, context.messenger).show(actor, eventId, { kind: 'Formulaire de règle',
          text: form?.channel === actor.channel && form.state === 'editing' ? `${payload.type === 'guided_form_notice' ? 'Ouverture non confirmée. Si le formulaire apparaît, utilisez-le ; sinon, réessayez. ' : ''}Complétez la règle puis vérifiez la proposition dans ce message. Aucun appel d’IA pour le formulaire et aucune règle enregistrée avant votre approbation.` : 'Cette règle ou ce formulaire est indisponible. Rouvrez Gérer les règles.',
          buttons: [...(form?.channel === actor.channel && form.state === 'editing' ? [{ label: 'Remplir le formulaire', action: 'form_open', value: form.id, bound: true }] : []), menuButton] });
      }
      if (payload.type === 'guided_form') {
        const form = await forms.get(actor, String(payload.form));
        const state = await new Store(context.sql).load(actor);
        if (!form || form.channel !== actor.channel || form.state !== 'submitted' || !form.result || (form.result.base && !isDeepStrictEqual(state.rules.find(rule => rule.id === form.result!.base!.id), form.result.base)))
          return context.messenger.send(actor, { text: 'Formulaire expiré ou règle modifiée. Rouvrez Gérer les règles pour préparer une nouvelle proposition.', buttons: [menuButton] });
        payload = { type: 'text', text: 'Proposition de règle depuis le formulaire', presentationLanguage: 'fr', resolved: { intent: 'propose_rule', reply: '', rule: form.result.rule, ruleId: form.result.base?.id ?? null, runId: null, messageId: null, correction: null } };
      }
      // HTTP ingress constructs text/actions; only the mail OAuth callback can
      // enqueue a connection. Persisted pre-module jobs use the same shape.
      if (!['text', 'action', 'menu_action', 'connection'].includes(String(payload.type))) throw new Error('Unsupported mail event.');
      const store = new Store(context.sql);
      let event = payload as Event;
      if (payload.type === 'menu_action') {
        const bound = await boundMenuTarget(context.sql, actor, payload.value, payload.timestamp);
        if (!bound || payload.action !== 'sort_inbox' || bound.value !== 'sort') return context.messenger.send(actor, { text: "Ce bouton de lancement est indisponible. Envoyez menu pour en ouvrir un nouveau.", buttons: [menuButton] });
        event = { type: 'text', text: 'sort' };
      }
      if (payload.type === 'action' && ['menu_connect', 'menu_disconnect'].includes(String(payload.action))) {
        const state = await store.load(actor);
        if (payload.action === 'menu_connect' && state.connection) return context.messenger.send(actor, { text: "Gmail est déjà connecté. Ouvrez le menu pour examiner la connexion actuelle.", buttons: [menuButton] });
        if (payload.action === 'menu_disconnect' && (!state.connection || payload.value !== state.connection.id)) return context.messenger.send(actor, { text: "Ce bouton de connexion n’est plus valide. Ouvrez le menu pour examiner la connexion.", buttons: [menuButton] });
        event = { type: 'text', text: payload.action === 'menu_connect' ? 'connect' : 'disconnect' };
      }
      const engine = new Engine({ store, budget: context.budget, messenger: { send: (recipient, message) => context.messenger.send(recipient, {
        ...message, buttons: [...(message.buttons ?? []), menuButton],
      }) },
        admitSort: (user, sourceId) => new JobStore(context.sql).claimOperation(sourceId, user, 'mail', SORT_OPERATION),
        intelligence: new OpenAI(config.OPENAI_API_KEY, config.OPENAI_MODEL, context.budget),
        connectUrl: user => oauth.invitation(user),
        mailbox: (user, state) => new Gmail(vault.open<Tokens>(state.connection!.encryptedTokens, ownerKey(user)), config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET,
          async tokens => { state.connection!.encryptedTokens = vault.seal(tokens, ownerKey(user)); await store.save(user, state); }),
      });
      await engine.handle(actor, event, eventId);
    },
  };
}
