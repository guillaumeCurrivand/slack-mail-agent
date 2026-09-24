import { z } from 'zod';
import { PRICE_CARD } from '../../core/budget.js';

export function readMailConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = z.object({
    ENCRYPTION_KEY: z.string().min(1),
    GOOGLE_CLIENT_ID: z.string().min(1), GOOGLE_CLIENT_SECRET: z.string().min(1),
    GOOGLE_WORKSPACE_DOMAINS: z.string().min(1), OPENAI_API_KEY: z.string().min(1),
    OPENAI_MODEL: z.string().default('gpt-4.1-mini-2025-04-14'),
  }).parse(env);
  const domains = parsed.GOOGLE_WORKSPACE_DOMAINS.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
  if (!domains.length || domains.some(d => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) throw new Error('Configure verified Google Workspace hosted domains.');
  if (!(parsed.OPENAI_MODEL in PRICE_CARD)) throw new Error('No verified price card exists for OPENAI_MODEL.');
  return { ...parsed, domains };
}
export type MailConfig = ReturnType<typeof readMailConfig>;
