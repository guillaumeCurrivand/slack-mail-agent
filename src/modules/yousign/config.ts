import { z } from 'zod';

export function readYousignConfig(env: NodeJS.ProcessEnv = process.env) {
  return z.object({
    YOUSIGN_WEBHOOK_SECRET: z.string().min(16),
    YOUSIGN_SUBSCRIPTION_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    YOUSIGN_SANDBOX: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
    SLACK_ADMIN_USER_ID: z.string().regex(/^[UW][A-Z0-9]+$/),
  }).parse(env);
}
export type YousignConfig = ReturnType<typeof readYousignConfig> & { SLACK_TEAM_ID: string; SLACK_BOT_TOKEN: string };
