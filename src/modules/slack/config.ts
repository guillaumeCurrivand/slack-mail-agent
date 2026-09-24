import { PRICE_CARD } from '../../core/budget.js';

export function readSlackConfig(env: NodeJS.ProcessEnv = process.env) {
  const key = env.OPENAI_API_KEY?.trim() ?? '';
  const model = env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini-2025-04-14';
  if (key && !(model in PRICE_CARD)) throw new Error('No verified price card exists for OPENAI_MODEL.');
  return { key, model };
}
