import { ModuleRegistry } from '../core/modules.js';
import type { Sql } from '../core/store.js';
import { readMailConfig } from '../modules/mail/config.js';
import { createMailModule } from '../modules/mail/index.js';
import { readSlackConfig } from '../modules/slack/config.js';
import { createSlackModule } from '../modules/slack/index.js';
import { createDocumentationModule } from '../modules/documentation/index.js';
import { readDocumentationAIConfig } from '../modules/documentation/ai.js';
import type { Config } from './config.js';
import { frenchCommand } from './commands.js';
import { readClickupConfig } from '../modules/clickup/config.js';
import { createClickupModule } from '../modules/clickup/index.js';
import { readYousignConfig } from '../modules/yousign/config.js';
import { createYousignModule } from '../modules/yousign/index.js';
import { readDevelopmentConfig } from '../modules/development/config.js';
import { createDevelopmentModule } from '../modules/development/index.js';

export function createModules(config: Config, sql: Sql, env: NodeJS.ProcessEnv = process.env) {
  const factories = {
    mail: () => createMailModule({ ...readMailConfig(env), PUBLIC_URL: config.PUBLIC_URL }, sql),
    slack: () => createSlackModule(config.SLACK_BOT_TOKEN, sql, readSlackConfig(env)),
    documentation: () => createDocumentationModule(sql, readDocumentationAIConfig(env)),
    clickup: () => createClickupModule({ ...readClickupConfig(env), PUBLIC_URL: config.PUBLIC_URL }, sql),
    yousign: () => createYousignModule({ ...readYousignConfig(env), SLACK_TEAM_ID: config.SLACK_TEAM_ID, SLACK_BOT_TOKEN: config.SLACK_BOT_TOKEN }, sql),
    development: () => createDevelopmentModule({ ...readDevelopmentConfig(env), SLACK_TEAM_ID: config.SLACK_TEAM_ID, SLACK_BOT_TOKEN: config.SLACK_BOT_TOKEN }, sql),
  };
  return new ModuleRegistry(config.enabledModules.map(id => {
    if (!Object.hasOwn(factories, id)) throw new Error(`Unknown enabled module: ${id}`);
    return { ...factories[id as keyof typeof factories](), ...(id === 'mail' ? { aliases: ['courrier'] } : {}), normalizeText: (text: string) => frenchCommand(id, text) };
  }));
}
