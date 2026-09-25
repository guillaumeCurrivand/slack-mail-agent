import { z } from 'zod';

const dollar = (fallback: string) => z.coerce.number().min(0).max(10).default(Number(fallback));
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    PUBLIC_URL: z.url(), DATABASE_URL: z.string().min(1),
    SLACK_TEAM_ID: z.string().regex(/^T[A-Z0-9]+$/), SLACK_BOT_TOKEN: z.string().min(1), SLACK_SIGNING_SECRET: z.string().min(1),
    SLACK_ADMIN_USER_ID: z.string().default(''), ENABLED_MODULES: z.string().default('mail'),
    AI_MONTHLY_LIMIT_USD: dollar('10'), AI_ALERT_USD: dollar('8'), AI_USER_MONTHLY_LIMIT_USD: dollar('10'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(2).max(4).default(2),
  }).parse(env);
  const url = new URL(parsed.PUBLIC_URL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('PUBLIC_URL requires HTTPS outside localhost.');
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('PUBLIC_URL must be an origin without path or credentials.');
  const enabledModules = parsed.ENABLED_MODULES.split(',').map(id => id.trim()).filter(Boolean);
  if (new Set(enabledModules).size !== enabledModules.length) throw new Error('Duplicate enabled module.');
  return { ...parsed, PUBLIC_URL: url.origin, enabledModules };
}
export type Config = ReturnType<typeof readConfig>;
