import { Budget } from './budget.js';
import { isIntegration, ownerKey, type WorkIdentity } from './identity.js';
import type { ModuleRegistry, RoutedJob } from './modules.js';
import type { Messenger } from './slack.js';
import type { Sql } from './store.js';
import { boundMenuTarget } from './navigation.js';

export type RuntimeOptions = {
  AI_MONTHLY_LIMIT_USD: number; AI_USER_MONTHLY_LIMIT_USD: number;
  AI_ALERT_USD: number; SLACK_ADMIN_USER_ID: string;
};
export async function dispatchJob(sql: Sql, options: RuntimeOptions, modules: ModuleRegistry, messenger: Messenger,
  job: RoutedJob & { id: string; actor: WorkIdentity; created_at?: Date | string }) {
  const requestedAt = job.created_at ? new Date(job.created_at) : new Date();
  if (isIntegration(job.actor)) return modules.dispatchIntegration(job, job.actor, job.id, { sql, messenger, requestedAt });
  const actor = job.actor;
  // A signed source timestamp alone is not permission to replace a message.
  // Public launchers and legacy/unavailable cards open an actor-owned screen.
  const boundAction = ['navigation', 'control_navigation', 'menu_action'].includes(String(job.payload.type));
  const validBinding = !boundAction || await boundMenuTarget(sql, actor, job.payload.value, job.payload.timestamp);
  const source = validBinding && typeof job.payload.timestamp === 'string' && (await sql.query(
    "SELECT id,timestamp FROM core_navigation_menus WHERE owner=$1 AND channel=$2 AND timestamp=$3 AND created_at>=now()-interval '30 days'",
    [ownerKey(actor), actor.channel, job.payload.timestamp])).rows[0];
  const replies: Messenger = Object.create(messenger) as Messenger;
  replies.replyTarget = recipient => source && ownerKey(recipient) === ownerKey(actor) && recipient.channel === actor.channel
    ? { id: source.id, timestamp: source.timestamp } : undefined;
  const budget = new Budget(sql, Math.round(options.AI_MONTHLY_LIMIT_USD * 1e6), Math.round(options.AI_USER_MONTHLY_LIMIT_USD * 1e6), job.module);
  await modules.dispatch(job, job.actor, job.id, { sql, budget, messenger: replies, requestedAt });
  // Channel-capable Modules do not expose private budget notices in shared conversations.
  if (/^[CG]/.test(job.actor.channel)) return;
  if (await budget.claimAlert(Math.round(options.AI_ALERT_USD * 1e6))) {
    const recipient = options.SLACK_ADMIN_USER_ID ? { ...job.actor, user: options.SLACK_ADMIN_USER_ID, channel: options.SLACK_ADMIN_USER_ID } : job.actor;
    try { await messenger.send(recipient, { text: "Le budget d’IA de l’équipe a atteint le seuil d’alerte, y compris les demandes en attente ou incertaines. Utilisez budget pour consulter les totaux. Les nouveaux traitements payants s’arrêteront à la limite configurée." }); }
    catch { await budget.releaseAlert(); }
  }
}
