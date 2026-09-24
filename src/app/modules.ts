import { ModuleRegistry } from '../core/modules.js';
import type { Sql } from '../core/store.js';
import { readMailConfig } from '../modules/mail/config.js';
import { createMailModule } from '../modules/mail/index.js';
import type { Config } from './config.js';

export function createModules(config: Config, sql: Sql, env: NodeJS.ProcessEnv = process.env) {
  const factories = {
    mail: () => createMailModule({ ...readMailConfig(env), PUBLIC_URL: config.PUBLIC_URL }, sql),
  };
  return new ModuleRegistry(config.enabledModules.map(id => {
    if (!Object.hasOwn(factories, id)) throw new Error(`Unknown enabled module: ${id}`);
    return factories[id as keyof typeof factories]();
  }));
}
