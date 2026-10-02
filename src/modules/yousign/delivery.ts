import { SlackDeliveryRejected, type Messenger } from '../../core/slack.js';
import { notification } from './events.js';
import type { YousignConfig } from './config.js';
import type { YousignChannels } from './channels.js';
import { YousignStore } from './store.js';

const backoff = (attempt: number, seconds?: number) => new Date(Date.now() + Math.max(seconds ?? 0, Math.min(3600, 30 * 2 ** Math.min(attempt, 7))) * 1000);

export async function deliverEvent(store: YousignStore, channels: Pick<YousignChannels, 'canPost'>, messenger: Messenger, config: YousignConfig, event: string) {
  // A persisted sending marker after a restart cannot establish whether Slack accepted it.
  await store.recoverSending(event);
  let processed = 0;
  for (const delivery of await store.deliveries(event)) {
    if (['uncertain', 'failed'].includes(delivery.status)) { await store.problem(delivery.channel_id); continue; }
    if (delivery.status !== 'queued' || new Date(delivery.next_at).getTime() > Date.now() || processed >= 5) continue;
    processed++;
    try {
      if (!messenger.postChannel || !await channels.canPost(delivery.channel_id)) throw new Error('Posting access unavailable.');
    } catch {
      await store.deferDelivery(delivery.id, backoff(delivery.attempts + 1), 'access_unavailable');
      await store.problem(delivery.channel_id);
      continue;
    }
    const claimed = await store.claim(delivery.id);
    if (!claimed) continue;
    try {
      const ts = await messenger.postChannel!({ team: store.actor.team, channel: claimed.channel_id }, notification(claimed.summary));
      await store.finish(claimed.id, 'sent', ts);
    } catch (error) {
      if (error instanceof SlackDeliveryRejected) {
        if (error.code === 'invalid_blocks') await store.finish(claimed.id, 'failed', undefined, 'invalid_message');
        else await store.deferDelivery(claimed.id, backoff(claimed.attempts, error.retryAfter), 'rejected');
      } else await store.finish(claimed.id, 'uncertain', undefined, 'uncertain');
      await store.problem(claimed.channel_id);
    }
  }
  await store.settle(event);
  for (const alert of await store.alerts()) {
    if (alert.status === 'sending') { await store.finishAlert(alert.id, 'uncertain'); continue; }
    if (new Date(alert.next_at).getTime() > Date.now() || !await store.claimAlert(alert.id)) continue;
    try {
      // Generic wording never discloses a private channel or signature request to the operator.
      await messenger.send({ team: config.SLACK_TEAM_ID, user: config.SLACK_ADMIN_USER_ID, channel: config.SLACK_ADMIN_USER_ID }, {
        kind: 'Alerte Yousign', text: 'Une livraison Yousign rencontre un problème ou son résultat est incertain. Ouvrez Yousign → Statut dans votre DM. Seuls les canaux auxquels vous avez accès y sont visibles. Une livraison incertaine n’est pas relancée automatiquement.',
      });
      await store.finishAlert(alert.id, 'sent');
    } catch (error) {
      if (error instanceof SlackDeliveryRejected) await store.finishAlert(alert.id, 'queued', backoff(alert.attempts + 1, error.retryAfter));
      else await store.finishAlert(alert.id, 'uncertain');
    }
  }
  const waiting = [...(await store.deliveries(event)).filter(row => row.status === 'queued').map(row => new Date(row.next_at)),
    ...(await store.alerts()).filter(row => row.status === 'queued').map(row => new Date(row.next_at))];
  if (waiting.length) return new Date(Math.min(...waiting.map(date => date.getTime())));
}
