import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { budgetReport, type Budget } from './budget.js';
import type { Actor } from './identity.js';
import type { Messenger } from './slack.js';
import type { Sql } from './store.js';

export type JobPayload = Record<string, unknown>;
export type RoutedJob = { module: string; payload: JobPayload };
export type ModuleContext = { sql: Sql; budget: Budget; messenger: Messenger };
export interface AssistantModule {
  id: string;
  description: string;
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
      if (!/^[a-z][a-z0-9_-]*$/.test(module.id) || ['core', 'help', 'budget'].includes(module.id) || this.modules.has(module.id)) throw new Error('Invalid or duplicate module identifier.');
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
    const separator = action.indexOf(':');
    const id = separator > 0 ? action.slice(0, separator) : this.legacyActions.get(action);
    const name = separator > 0 ? action.slice(separator + 1) : action;
    if (id && name && this.modules.has(id)) return { module: id, payload: { type: 'action', action: name, value } };
    return { module: 'core', payload: { type: 'unavailable' } };
  }
  async dispatch(job: RoutedJob, actor: Actor, eventId: string, context: ModuleContext) {
    if (job.module === 'core') {
      if (job.payload.type === 'text' && String(job.payload.text).toLowerCase() === 'budget') {
        return context.messenger.send(actor, { text: await budgetReport(context.budget) });
      }
      const help = job.payload.type === 'text' && String(job.payload.text).toLowerCase() === 'help';
      return context.messenger.send(actor, { kind: 'Help', text: `${help ? '' : 'Use an enabled module prefix for every request. This request was not sent to a module.\n'}${this.all().map(m => `${m.id} — ${m.description}. Send ${m.id} help.`).join('\n') || 'No modules are currently enabled.'}\nShared commands: help, budget.` });
    }
    const module = this.modules.get(job.module);
    if (!module) throw new Error('Module is not enabled.');
    const messenger: Messenger = { send: (recipient, message) => context.messenger.send(recipient, {
      ...message, ...(message.buttons ? { buttons: message.buttons.map(button => ({ ...button, action: `${module.id}:${button.action}` })) } : {}),
    }) };
    await module.handle(actor, job.payload, eventId, { ...context, messenger });
  }
}
