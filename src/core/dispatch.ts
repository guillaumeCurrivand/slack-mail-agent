import { Budget } from './budget.js';
import type { Actor } from './identity.js';
import type { ModuleRegistry, RoutedJob } from './modules.js';
import type { Messenger } from './slack.js';
import type { Sql } from './store.js';

export type RuntimeOptions = {
  AI_MONTHLY_LIMIT_USD: number; AI_USER_MONTHLY_LIMIT_USD: number;
  AI_ALERT_USD: number; SLACK_ADMIN_USER_ID: string;
};
export async function dispatchJob(sql: Sql, options: RuntimeOptions, modules: ModuleRegistry, messenger: Messenger,
  job: RoutedJob & { id: string; actor: Actor; created_at?: Date | string }) {
  const budget = new Budget(sql, Math.round(options.AI_MONTHLY_LIMIT_USD * 1e6), Math.round(options.AI_USER_MONTHLY_LIMIT_USD * 1e6), job.module);
  const requestedAt = job.created_at ? new Date(job.created_at) : new Date();
  await modules.dispatch(job, job.actor, job.id, { sql, budget, messenger, requestedAt });
  if (await budget.claimAlert(Math.round(options.AI_ALERT_USD * 1e6))) {
    const recipient = options.SLACK_ADMIN_USER_ID ? { ...job.actor, user: options.SLACK_ADMIN_USER_ID, channel: options.SLACK_ADMIN_USER_ID } : job.actor;
    try { await messenger.send(recipient, { text: 'The team AI allowance has reached its alert threshold, including pending or uncertain requests. Use budget for current totals. New paid work will stop at the configured limit.' }); }
    catch { await budget.releaseAlert(); }
  }
}
