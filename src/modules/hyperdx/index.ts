import { sha256Hex } from '../../core/crypto.js';
import { z } from 'zod';
import type { IntegrationActor } from '../../core/identity.js';
import type { AssistantModule } from '../../core/modules.js';
import { SlackDeliveryRejected } from '../../core/slack.js';
import { SlackChannels } from '../../core/slack-channels.js';
import { JobStore } from '../../core/store.js';
import { channelMenu, destinations } from './channels.js';
import { readReport } from './report.js';

const day = 86_400_000;
const guide = 'Chaque jour à 06 h UTC, le bot publie dans chaque canal sélectionné un bilan pour chaque service ayant au moins une erreur ou un avertissement. La période commence la veille à minuit UTC. Les vingt erreurs et avertissements les plus fréquents sont classés par nombre d’occurrences. La commande hyperdx aide ouvre ce guide. Envoyez hyperdx canaux ou ouvrez Choisir les canaux dans le menu. Activer partage les extraits de tous les services avec les membres du canal. L’opérateur configure les services sur le serveur. Aucun appel d’IA.';

export function readHyperdxConfig(env: NodeJS.ProcessEnv) {
  const names = z.string().min(1).parse(env.HYPERDX_SERVICES);
  const services = z.array(z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f]+$/u)).min(1).parse(JSON.parse(names));
  return { apiKey: z.string().trim().min(1).parse(env.HYPERDX_API_KEY),
    services: [...new Set(services)] };
}

export function createHyperdxModule(config: ReturnType<typeof readHyperdxConfig>, team: string, token: string,
  fetcher = fetch, now = Date.now): AssistantModule {
  const identity: IntegrationActor = { kind: 'integration', team, integration: 'hyperdx' };
  const directory = new SlackChannels(token, fetcher);
  return {
    id: 'hyperdx', name: 'Bilan HyperDX', description: 'Recevoir le bilan quotidien des erreurs et avertissements', help: { text: guide },
    async connections(actor) {
      return actor.team === team ? [{ name: 'HyperDX', scope: 'workspace', status: 'Intégration configurée', page: 'main' }] : [];
    },
    ...channelMenu(team, directory, guide),
    async initialize(sql) {
      await sql.query(`CREATE TABLE IF NOT EXISTS hyperdx_channels (
        team text NOT NULL, channel_id text NOT NULL, id uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(), PRIMARY KEY(team,channel_id))`);
      await sql.query('CREATE TABLE IF NOT EXISTS hyperdx_actions (event_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())');
      await sql.query(`CREATE TABLE IF NOT EXISTS hyperdx_deliveries (
        job_id text PRIMARY KEY, state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
      await new JobStore(sql).enqueueIntegration(`hyperdx:${team}:schedule`, identity, { type: 'schedule' }, 'hyperdx');
    },
    async cleanup(sql) {
      await sql.query("DELETE FROM hyperdx_deliveries WHERE created_at < now() - interval '30 days'");
      await sql.query("DELETE FROM hyperdx_actions a WHERE created_at < now()-interval '30 days' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id=a.event_id AND j.status IN ('queued','running'))");
    },
    async handleIntegration(actor, payload, id, { sql, messenger }) {
      if (actor.team !== team || actor.integration !== 'hyperdx') throw new Error('Unexpected digest identity.');
      const time = now();
      if (payload.type === 'schedule') {
        const cutoff = Math.floor(time / day) * day + 6 * 3_600_000;
        if (time < cutoff) return new Date(cutoff);
        const jobs = new JobStore(sql);
        for (const target of await destinations(sql, team)) {
          for (const service of config.services) {
            const key = sha256Hex(service);
            await jobs.enqueueIntegration(`hyperdx:${team}:${cutoff}:${target.channel_id}:${key}`, identity,
              { type: 'report', cutoff, service, channel: target.channel_id, activation: target.id }, 'hyperdx');
          }
        }
        return new Date(cutoff + day);
      }
      const { cutoff, service, channel, activation } = payload;
      if (payload.type !== 'report' || typeof cutoff !== 'number' || typeof service !== 'string') throw new Error('Invalid digest job.');
      if (typeof channel !== 'string' || !z.uuid().safeParse(activation).success || !config.services.includes(service) || time >= cutoff + day) return;
      // A surviving marker means Slack may already have received this report.
      if ((await sql.query('SELECT 1 FROM hyperdx_deliveries WHERE job_id=$1', [id])).rows.length) return;
      const target = [team, channel, activation];
      if (!(await sql.query('SELECT 1 FROM hyperdx_channels WHERE team=$1 AND channel_id=$2 AND id=$3', target)).rows.length) return;
      const message = await readReport(config.apiKey, service, cutoff, fetcher);
      if (!message) return;
      if (!messenger.postChannel || !await directory.canPost(channel)) return new Date(time + 300_000);
      const claim = await sql.query(`INSERT INTO hyperdx_deliveries(job_id,state)
        SELECT $4,'sending' FROM (SELECT id FROM hyperdx_channels WHERE team=$1 AND channel_id=$2 AND id=$3 FOR UPDATE) active
        ON CONFLICT DO NOTHING RETURNING job_id`, [...target, id]);
      if (!claim.rows.length) return;
      try { await messenger.postChannel({ team, channel }, message); }
      catch (error) {
        if (error instanceof SlackDeliveryRejected) {
          await sql.query('DELETE FROM hyperdx_deliveries WHERE job_id=$1', [id]);
          return new Date(now() + Math.max(60, error.retryAfter ?? 0) * 1000);
        }
        await sql.query("UPDATE hyperdx_deliveries SET state='uncertain' WHERE job_id=$1", [id]);
        throw error;
      }
      await sql.query("UPDATE hyperdx_deliveries SET state='sent' WHERE job_id=$1", [id]);
    },
  };
}
