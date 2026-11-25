import { costMicro, PRICE_CARD, type Budget } from './budget.js';
import type { Actor } from './identity.js';

export type QuestionAIConfig = { key: string; model: string };
export function readQuestionConfig(env: NodeJS.ProcessEnv = process.env): QuestionAIConfig {
  const key = env.OPENAI_API_KEY?.trim() ?? '', model = env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini-2025-04-14';
  return { key, model };
}

export async function requestPlan(config: QuestionAIConfig, actor: Actor, body: { model: string; instructions: string; input: string; text: unknown },
  budget: Budget, checkpointReservation: (id: string) => Promise<void>, fetcher: typeof fetch = fetch): Promise<string> {
  if (!Object.hasOwn(PRICE_CARD, config.model)) throw new Error('No verified price card exists for OPENAI_MODEL.');
  const headers = { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' };
  const counted = await fetcher('https://api.openai.com/v1/responses/input_tokens', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!counted.ok) throw new Error('Token counting unavailable');
  const tokens = (await counted.json() as { input_tokens?: number }).input_tokens;
  if (!Number.isSafeInteger(tokens) || tokens! < 0) throw new Error('Invalid input count');
  const maxOutput = 1536, reservation = await budget.reserve(actor, costMicro(tokens!, maxOutput));
  await checkpointReservation(reservation);
  const response = await fetcher('https://api.openai.com/v1/responses', { method: 'POST', headers,
    body: JSON.stringify({ ...body, store: false, max_output_tokens: maxOutput, service_tier: 'default', truncation: 'disabled' }), signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error('Interpretation unavailable');
  const result = await response.json() as any;
  const usage = result.usage;
  if (!Number.isSafeInteger(usage?.input_tokens) || !Number.isSafeInteger(usage?.output_tokens) || usage.input_tokens < 0 || usage.output_tokens < 0) throw new Error('Unverified usage');
  await budget.settle(reservation, costMicro(usage.input_tokens, usage.output_tokens));
  if (result.status !== 'completed') throw new Error('Incomplete interpretation');
  const text = (result.output ?? []).flatMap((item: any) => (item.content ?? []).filter((content: any) => content.type === 'output_text').map((content: any) => content.text)).join('');
  return text;
}
