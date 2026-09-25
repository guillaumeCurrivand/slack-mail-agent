import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { budgetReport, type Budget } from './budget.js';
import type { Actor } from './identity.js';
import type { Messenger } from './slack.js';
import { Navigation, type MenuPage } from './navigation.js';
import type { Sql } from './store.js';

export type JobPayload = Record<string, unknown>;
export type RoutedJob = { module: string; payload: JobPayload };
export type ModuleContext = { sql: Sql; budget: Budget; messenger: Messenger; requestedAt: Date };
export interface AssistantModule {
  id: string;
  description: string;
  name?: string;
  menu?(actor: Actor, page: string, context: Pick<ModuleContext, 'sql'>): Promise<MenuPage>;
  menuActions?: readonly string[];
  legacyActions?: readonly string[];
  initialize?(sql: Sql): Promise<void>;
  registerRoutes?(app: FastifyInstance): void;
  cleanup?(pool: Pool): Promise<void>;
  handle(actor: Actor, payload: JobPayload, eventId: string, context: ModuleContext): Promise<void>;
}

/** Built-in trusted modules. Only enabled modules are constructed and registered. */
export class ModuleRegistry {
  private modules = new Map<string, AssistantModule>();
  private legacyActions = new Map<string, string>();
  constructor(modules: AssistantModule[]) {
    for (const module of modules) {
      if (!/^[a-z][a-z0-9_-]*$/.test(module.id) || ['core', 'help', 'budget', 'menu', 'hello', 'hi'].includes(module.id) || this.modules.has(module.id)) throw new Error('Invalid or duplicate module identifier.');
      this.modules.set(module.id, module);
      for (const action of module.legacyActions ?? []) {
        if (action.includes(':') || this.legacyActions.has(action)) throw new Error('Duplicate or invalid legacy action.');
        this.legacyActions.set(action, module.id);
      }
    }
  }
  all() { return [...this.modules.values()]; }
  enabledIds() { return ['core', ...this.modules.keys()]; }
  text(text: string): RoutedJob {
    const [prefix = '', rest = ''] = text.trim().split(/\s+([\s\S]*)/, 2);
    const id = prefix.toLowerCase();
    if (this.modules.has(id)) return { module: id, payload: { type: 'text', text: rest.trim() || 'help' } };
    return { module: 'core', payload: { type: 'text', text: text.trim() } };
  }
  action(action: string, value: string): RoutedJob {
    if (action === 'core:menu') return { module: 'core', payload: { type: 'text', text: 'menu' } };
    if (action === 'core:navigate') return { module: 'core', payload: { type: 'navigation', value } };
    const separator = action.indexOf(':');
    const id = separator > 0 ? action.slice(0, separator) : this.legacyActions.get(action);
    const name = separator > 0 ? action.slice(separator + 1) : action;
    if (id && name && this.modules.has(id)) return { module: id, payload: { type: this.modules.get(id)!.menuActions?.includes(name) ? 'menu_action' : 'action', action: name, value } };
    return { module: 'core', payload: { type: 'unavailable' } };
  }
  async dispatch(job: RoutedJob, actor: Actor, eventId: string, context: ModuleContext) {
    if (job.module === 'core') {
      const navigation = new Navigation(context.sql, context.messenger);
      if (job.payload.type === 'navigation') {
        const destination = await navigation.target(actor, job.payload.value, job.payload.timestamp);
        if (!destination) return navigation.show(actor, eventId, { kind: 'Menu unavailable', text: 'This menu is unavailable. Send menu to open a fresh one.', buttons: [{ label: 'Menu', action: 'core:menu', value: '' }] });
        return navigation.show(actor, eventId, await this.page(destination.page, actor, context), destination.target);
      }
      if (job.payload.type === 'text' && String(job.payload.text).toLowerCase() === 'budget') {
        return context.messenger.send(actor, { text: await budgetReport(context.budget) });
      }
      if (job.payload.type === 'text' && ['menu', 'help', 'hello', 'hi'].includes(String(job.payload.text).toLowerCase())) {
        return navigation.show(actor, eventId, await this.page('main', actor, context));
      }
      return navigation.show(actor, eventId, { kind: 'Help', text: `Use an enabled module prefix for every request. This request was not sent to a module.\n${this.all().map(m => `${m.id} — ${m.description}. Send ${m.id} help.`).join('\n') || 'No modules are currently enabled.'}\nShared commands: menu, help, budget. Send menu if a button cannot be updated.`, buttons: [{ label: 'Menu', action: 'core:menu', value: '' }] });
    }
    const module = this.modules.get(job.module);
    if (!module) throw new Error('Module is not enabled.');
    const namespace = (message: MenuPage): MenuPage => ({ ...message,
      ...(message.buttons ? { buttons: message.buttons.map(button => ({ ...button, action: button.action.startsWith('core:') ? button.action : `${button.scope === 'core' ? 'core' : module.id}:${button.action}` })) } : {}),
    });
    const messenger: Messenger = { send: (recipient, message) => context.messenger.send(recipient, namespace(message)),
      ...(context.messenger.post ? { post: (recipient: Actor, message: MenuPage) => context.messenger.post!(recipient, namespace(message)) } : {}),
      ...(context.messenger.update ? { update: (recipient: Actor, timestamp: string, message: MenuPage) => context.messenger.update!(recipient, timestamp, namespace(message)) } : {}),
    };
    await module.handle(actor, job.payload, eventId, { ...context, messenger });
  }

  private async page(destination: string, actor: Actor, context: ModuleContext): Promise<MenuPage> {
    const back = [{ label: 'Back to menu', page: 'main' }];
    if (destination === 'main') return { kind: 'Menu', text: `${this.all().length ? 'Choose a module or shared command.' : 'No modules are currently enabled.'}\nSend menu to open a fresh menu if a button cannot be updated.`, links: [
      ...this.all().map(module => ({ label: module.name ?? module.id, page: `${module.id}:main` })),
      { label: 'Budget', page: 'budget' }, { label: 'Help', page: 'help' },
    ] };
    if (destination === 'budget') return { kind: 'Budget', text: await budgetReport(context.budget), links: back };
    if (destination === 'help') return { kind: 'Help', text: `Use an enabled module prefix for every typed request, including natural language. Opening a menu does not change routing.\n${this.all().map(module => `${module.id} — ${module.description}. Send ${module.id} help.`).join('\n')}\nShared commands: menu, help, budget. Menus use no AI. Send menu to recover from an unavailable control.`, links: back };
    const [id, section = 'main'] = destination.split(':');
    const module = this.modules.get(id!);
    if (!module) return { kind: 'Module unavailable', text: 'That module is not currently enabled. No work was started.', links: back };
    const page = module.menu ? await module.menu(actor, section, context) : { kind: module.name ?? module.id, text: `${module.description}. Send ${module.id} help.` };
    return { ...page, buttons: page.buttons?.map(button => ({ ...button, action: `${button.scope === 'core' ? 'core' : module.id}:${button.action}` })),
      links: [...(page.links ?? []).map(link => ({ ...link, page: `${module.id}:${link.page}` })), ...back] };
  }
}
