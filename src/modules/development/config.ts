import { z } from 'zod';

export function readDevelopmentConfig(env: NodeJS.ProcessEnv = process.env) {
  return z.object({
    DEVELOPMENT_CLICKUP_TOKEN: z.string().min(1),
    DEVELOPMENT_WORKER_TOKEN: z.string().min(32),
  }).parse(env);
}
export type DevelopmentConfig = ReturnType<typeof readDevelopmentConfig> & { SLACK_TEAM_ID: string; SLACK_BOT_TOKEN: string };
