import { mentionAssistant } from './mention.js';
import { ModuleRegistry } from '../core/modules.js';
import { createHyperdxModule, readHyperdxConfig } from '../modules/hyperdx/index.js';
import type { Sql } from '../core/store.js';
import { readMailConfig } from '../modules/mail/config.js';
import { createMailModule } from '../modules/mail/index.js';
import { createMailFacturesSource } from '../modules/mail/factures.js';
import { createDocumentationModule } from '../modules/documentation/index.js';
import { configuredWorkbook } from '../modules/documentation/sheets.js';
import { readQuestionConfig } from '../core/question-ai.js';
import type { Config } from './config.js';
import { frenchCommand } from './commands.js';
import { readClickupConfig } from '../modules/clickup/config.js';
import { createClickupModule } from '../modules/clickup/index.js';
import { readYousignConfig } from '../modules/yousign/config.js';
import { createYousignModule } from '../modules/yousign/index.js';
import { readDevelopmentConfig } from '../modules/development/config.js';
import { createDevelopmentModule } from '../modules/development/index.js';
import { createFacturesModule, readArchiveConfig, readFacturesConfig } from '../modules/factures/index.js';

export function createModules(config: Config, sql: Sql, env: NodeJS.ProcessEnv = process.env) {
  const factories = {
    hyperdx: () => createHyperdxModule(readHyperdxConfig(env), config.SLACK_TEAM_ID, config.SLACK_BOT_TOKEN),
    factures: () => {
      const courrier = config.enabledModules.includes('mail') ? createMailFacturesSource(readMailConfig(env)) : undefined;
      const pilot = !courrier || ['FACTURES_GOOGLE_CLIENT_ID', 'FACTURES_GOOGLE_CLIENT_SECRET', 'FACTURES_GOOGLE_REFRESH_TOKEN',
        'FACTURES_SLACK_USER_IDS'].some(key => env[key]?.trim()) || env.FACTURES_MONTHLY_ENABLED === 'true';
      return createFacturesModule(pilot ? readFacturesConfig(env) : undefined, readArchiveConfig(env), config.SLACK_TEAM_ID,
        fetch, Date.now, courrier);
    },
    mail: () => createMailModule({ ...readMailConfig(env), PUBLIC_URL: config.PUBLIC_URL }, sql, config.SLACK_BOT_TOKEN),
    documentation: () => createDocumentationModule(sql, readQuestionConfig(env), config.SLACK_BOT_TOKEN, configuredWorkbook(env, config.SLACK_TEAM_ID)),
    clickup: () => createClickupModule({ ...readClickupConfig(env), PUBLIC_URL: config.PUBLIC_URL }, sql),
    yousign: () => createYousignModule({ ...readYousignConfig(env), SLACK_TEAM_ID: config.SLACK_TEAM_ID, SLACK_BOT_TOKEN: config.SLACK_BOT_TOKEN }, sql),
    development: () => createDevelopmentModule({ ...readDevelopmentConfig(env), SLACK_TEAM_ID: config.SLACK_TEAM_ID, SLACK_BOT_TOKEN: config.SLACK_BOT_TOKEN }, sql),
  };
  return new ModuleRegistry(config.enabledModules.map(id => {
    if (!Object.hasOwn(factories, id)) throw new Error(`Unknown enabled module: ${id}`);
    return { ...factories[id as keyof typeof factories](), ...(id === 'mail' ? { aliases: ['courrier'] } : {}), normalizeText: (text: string) => frenchCommand(id, text) };
  }), mentionAssistant(readQuestionConfig(env)));
}
