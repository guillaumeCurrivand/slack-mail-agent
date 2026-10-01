import { z } from 'zod';

export function readClickupConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = z.object({
    CLICKUP_CLIENT_ID: z.string().min(1), CLICKUP_CLIENT_SECRET: z.string().min(1),
    CLICKUP_WORKSPACE_ID: z.string().regex(/^\d+$/), ENCRYPTION_KEY: z.string().min(1),
  }).parse(env);
  if (Buffer.from(config.ENCRYPTION_KEY, 'base64').length !== 32) throw new Error('ENCRYPTION_KEY must decode to 32 bytes.');
  return config;
}
export type ClickupConfig = ReturnType<typeof readClickupConfig> & { PUBLIC_URL: string };
