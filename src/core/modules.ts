import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { budgetReport, type Budget } from './budget.js';
import type { Actor, IntegrationActor } from './identity.js';
import { sanitizeReply, type Button, type Messenger } from './slack.js';
import { Navigation, needsControlPaging, type MenuPage } from './navigation.js';
import type { Sql } from './store.js';
import { logicalAction } from './presentation.js';

export type JobPayload = Record<string, unknown>;
export type RoutedJob = { module: string; payload: JobPayload };
export type ModuleContext = { sql: Sql; budget: Budget; messenger: Messenger; requestedAt: Date };
export type IntegrationContext = Pick<ModuleContext, 'sql' | 'messenger' | 'requestedAt'>;
const namespaceMessage = (message: MenuPage, moduleId: string): MenuPage => {
  const button = (control: Button): Button => ({ ...control,
    action: control.action.includes(':') ? control.action : `${control.scope === 'core' ? 'core' : moduleId}:${control.action}`,
  });
  return { ...message,
    ...(message.buttons ? { buttons: message.buttons.map(button) } : {}),
    ...(message.table?.rowButtons ? { table: { ...message.table, rowButtons: message.table.rowButtons.map(control => control ? button(control) : null) } } : {}),
  };
};
export interface AssistantModule {
  id: string;
  description: string;
  name?: string;
  aliases?: readonly string[];
  normalizeText?(text: string): string;
  menu?(actor: Actor, page: string, context: Pick<ModuleContext, 'sql'>): Promise<MenuPage>;
  menuActions?: readonly string[];
  workOperations?: readonly { key: string; label: string; commands: readonly string[]; action: string; snapshotUnknownText?: boolean }[];
  legacyActions?: readonly string[];
  initialize?(sql: Sql): Promise<void>;
  registerRoutes?(app: FastifyInstance): void;
  /** Opt-in signed channel receipt. Only durable enqueue belongs on this path. */
  receiveChannel?(actor: Actor, payload: JobPayload, eventId: string): Promise<void>;
  cleanup?(pool: Pool): Promise<void>;
  handle(actor: Actor, payload: JobPayload, eventId: string, context: ModuleContext): Promise<void>;
  handleIntegration?(actor: IntegrationActor, payload: JobPayload, eventId: string, context: IntegrationContext): Promise<Date | void>;
}

/** Built-in trusted modules. Only enabled modules are constructed and registered. */
export class ModuleRegistry {
  private modules = new Map<string, AssistantModule>();
  private prefixes = new Map<string, AssistantModule>();
  private legacyActions = new Map<string, string>();
  constructor(modules: AssistantModule[]) {
    for (const module of modules) {
      if (!/^[a-z][a-z0-9_-]*$/.test(module.id) || ['core', 'help', 'budget', 'menu', 'hello', 'hi', 'aide', 'bonjour', 'salut'].includes(module.id) || this.modules.has(module.id)) throw new Error('Invalid or duplicate module identifier.');
      this.modules.set(module.id, module);
      for (const prefix of [module.id, ...module.aliases ?? []]) {
        if (!/^[a-z][a-z0-9_-]*$/.test(prefix) || ['core', 'help', 'budget', 'menu', 'hello', 'hi', 'aide', 'bonjour', 'salut'].includes(prefix) || this.prefixes.has(prefix)) throw new Error('Invalid or duplicate module prefix.');
        this.prefixes.set(prefix, module);
      }
      for (const action of module.legacyActions ?? []) {
        if (action.includes(':') || this.legacyActions.has(action)) throw new Error('Duplicate or invalid legacy action.');
        this.legacyActions.set(action, module.id);
      }
    }
  }
  all() { return [...this.modules.values()]; }
  enabledIds() { return ['core', ...this.modules.keys()]; }
  async dispatchIntegration(job: RoutedJob, actor: IntegrationActor, eventId: string, context: IntegrationContext) {
    const module = this.modules.get(job.module);
    if (!module?.handleIntegration) throw new Error('Integration module is not enabled.');
    return module.handleIntegration(actor, job.payload, eventId, context);
  }
  operation(job: RoutedJob): NonNullable<AssistantModule['workOperations']>[number] | undefined {
    const module = this.modules.get(job.module);
    return module?.workOperations?.find(operation => job.payload.type === 'text'
      ? operation.commands.includes(String(job.payload.text ?? '').trim().toLowerCase())
      : job.payload.type === 'menu_action' && job.payload.action === operation.action);
  }
  receiptOperation(job: RoutedJob): string | undefined {
    return job.payload.type === 'text' ? this.modules.get(job.module)?.workOperations?.find(operation => operation.snapshotUnknownText)?.key : undefined;
  }
  text(text: string): RoutedJob {
    const [prefix = '', rest = ''] = text.trim().split(/\s+([\s\S]*)/, 2);
    const id = prefix.toLowerCase(), module = this.prefixes.get(id);
    if (module) return { module: module.id, payload: { type: 'text', text: module.normalizeText?.(rest.trim()) || rest.trim() || 'help' } };
    if (['aide', 'bonjour', 'salut'].includes(id) && !rest) text = 'help';
    return { module: 'core', payload: { type: 'text', text: text.trim() } };
  }
  action(action: string, value: string): RoutedJob {
    const normalized = logicalAction(action);
    if (!normalized) return { module: 'core', payload: { type: 'unavailable' } };
    action = normalized;
    if (action === 'core:menu') return { module: 'core', payload: { type: 'text', text: 'menu' } };
    if (action === 'core:navigate') return { module: 'core', payload: { type: 'navigation', value } };
    if (action === 'core:controls') return { module: 'core', payload: { type: 'control_navigation', value } };
    const separator = action.indexOf(':');
    const id = separator > 0 ? action.slice(0, separator) : this.legacyActions.get(action);
    const name = separator > 0 ? action.slice(separator + 1) : action;
    if (id && name && this.modules.has(id)) return { module: id, payload: { type: this.modules.get(id)!.menuActions?.includes(name) ? 'menu_action' : 'action', action: name, value } };
    return { module: 'core', payload: { type: 'unavailable' } };
  }
  async dispatch(job: RoutedJob, actor: Actor, eventId: string, context: ModuleContext) {
    if (job.module === 'core') {
      const navigation = new Navigation(context.sql, context.messenger);
      if (job.payload.type === 'operation_busy') return navigation.show(actor, eventId, {
        kind: "Traitement en cours", text: `Un traitement était déjà en cours à la réception de cette demande. Demande existante : ${job.payload.original}. Ouvrez le menu pour continuer.`,
        buttons: [{ label: 'Menu', action: 'core:menu', value: '' }],
      });
      if (job.payload.type === 'navigation') {
        const destination = await navigation.target(actor, job.payload.value, job.payload.timestamp);
        if (!destination) return navigation.show(actor, eventId, { kind: "Menu indisponible", text: "Ce menu est indisponible. Envoyez menu pour en ouvrir un nouveau.", buttons: [{ label: 'Menu', action: 'core:menu', value: '' }] });
        return navigation.show(actor, eventId, await this.page(destination.page, actor, context), destination.target);
      }
      if (job.payload.type === 'control_navigation') return navigation.controls(actor, eventId, job.payload.value, job.payload.timestamp);
      if (job.payload.type === 'text' && String(job.payload.text).toLowerCase() === 'budget') {
        return context.messenger.send(actor, { text: await budgetReport(context.budget) });
      }
      if (job.payload.type === 'text' && ['menu', 'help', 'hello', 'hi'].includes(String(job.payload.text).toLowerCase())) {
        return navigation.show(actor, eventId, await this.page('main', actor, context));
      }
      return navigation.show(actor, eventId, { kind: "Aide", text: `Commencez chaque demande par le préfixe d’un module activé. Cette demande n’a été transmise à aucun module.\n${this.all().map(m => `${m.id} — ${m.description}. Envoyez ${m.aliases?.[0] ?? m.id} aide.`).join('\n') || "Aucun module n’est actuellement activé."}\nCommandes communes : menu, aide, budget. Envoyez menu si un bouton ne fonctionne plus.`, buttons: [{ label: 'Menu', action: 'core:menu', value: '' }] });
    }
    const module = this.modules.get(job.module);
    if (!module) throw new Error('Module is not enabled.');
    const namespace = (message: MenuPage) => namespaceMessage(message, module.id);
    let pagedMessageIndex = 0;
    const messenger: Messenger = { prepare: namespace, send: (recipient, message) => {
      const prepared = namespace(message);
      if ((prepared.text.length > 10_000 || (!prepared.kind && sanitizeReply(prepared.text).length > 10_000)
        || needsControlPaging(prepared)) && context.messenger.post && context.messenger.update)
        return new Navigation(context.sql, context.messenger).show(recipient, `${eventId}:answer:${pagedMessageIndex++}`, prepared);
      return context.messenger.send(recipient, prepared);
    },
      ...(context.messenger.post ? { post: (recipient: Actor, message: MenuPage) => context.messenger.post!(recipient, namespace(message)) } : {}),
      ...(context.messenger.update ? { update: (recipient: Actor, timestamp: string, message: MenuPage) => context.messenger.update!(recipient, timestamp, namespace(message)) } : {}),
    };
    await module.handle(actor, job.payload, eventId, { ...context, messenger });
  }

  private async page(destination: string, actor: Actor, context: ModuleContext): Promise<MenuPage> {
    const back = [{ label: "Retour au menu", page: 'main' }];
    if (destination === 'main') return { kind: 'Menu', text: `${this.all().length ? "Choisissez un module ou une commande commune." : "Aucun module n’est actuellement activé."}\nEnvoyez menu pour ouvrir un nouveau menu si un bouton ne fonctionne plus.`, links: [
      ...this.all().map(module => ({ label: module.name ?? module.id, page: `${module.id}:main` })),
      { label: 'Budget', page: 'budget' }, { label: "Aide", page: 'help' },
    ] };
    if (destination === 'budget') return { kind: 'Budget', text: await budgetReport(context.budget), links: back };
    if (destination === 'help') return { kind: "Aide", text: `Commencez chaque demande écrite par le préfixe d’un module activé, même en langage naturel. Ouvrir un menu ne change pas le routage.\n${this.all().map(module => `${module.id} — ${module.description}. Envoyez ${module.aliases?.[0] ?? module.id} aide.`).join('\n')}\nCommandes communes : menu, aide, budget. Les menus n’utilisent pas d’IA. Envoyez menu si un bouton est indisponible.`, links: back };
    const [id, section = 'main'] = destination.split(':');
    const module = this.modules.get(id!);
    if (!module) return { kind: "Module indisponible", text: "Ce module n’est pas activé. Aucun traitement n’a été lancé.", links: back };
    const page = module.menu ? await module.menu(actor, section, context) : { kind: module.name ?? module.id, text: `${module.description}. Envoyez ${module.aliases?.[0] ?? module.id} aide.` };
    return { ...namespaceMessage(page, module.id),
      recordChoices: page.recordChoices?.map(link => ({ ...link, page: `${module.id}:${link.page}` })),
      links: [...(page.links ?? []).map(link => ({ ...link, page: `${module.id}:${link.page}` })), ...back] };
  }
}
