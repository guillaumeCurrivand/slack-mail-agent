import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { opaque } from '../../core/crypto.js';
import { ownerKey, uid, type Actor } from '../../core/identity.js';
import type { WorkObjectRequest } from '../../core/modules.js';
import { Navigation, type MenuPage } from '../../core/navigation.js';
import { type Messenger, type AgentMessage, workObjectMetadata } from '../../core/slack.js';
import { JobStore, type Sql } from '../../core/store.js';
import { embeddedTablePage } from '../../core/embedded-table.js';

type PanelConfig = { PUBLIC_URL: string; SLACK_TEAM_ID: string; SLACK_SIGNING_SECRET: string; SLACK_BOT_TOKEN: string };
const objectType = 'connexion-table';
const path = '/connexion/tableau';
const lifetime = '5m';
const uuid = z.uuid();
const claims = z.object({
  sub: z.string().regex(/^[UW][A-Z0-9]+$/), channel: z.string().regex(/^D[A-Z0-9]+$/),
  timestamp: z.string().regex(/^\d+\.\d+$/), table: uuid, jti: z.string().regex(/^[a-z0-9_-]{1,120}$/i),
  exp: z.number(),
});

export function createConnexionPanel(config: PanelConfig, sql: Sql, fetcher: typeof fetch = fetch) {
  const jobs = new JobStore(sql);
  const key = createHmac('sha256', config.SLACK_SIGNING_SECRET).update('mayassistant:connexion-table:v1').digest();
  const url = (id: string) => `${config.PUBLIC_URL}${path}/${id}`;

  async function savedTable(actor: Actor, id: string, timestamp: string) {
    const record = (await sql.query(`SELECT content FROM core_navigation_menus WHERE id=$1 AND owner=$2 AND channel=$3
      AND timestamp=$4 AND created_at>=now()-interval '30 days'`, [id, ownerKey(actor), actor.channel, timestamp])).rows[0];
    const content = record?.content as AgentMessage | undefined;
    if (content?.workObject?.id !== id || content.workObject.type !== objectType || content.workObject.url !== url(id) || !content.table?.rowButtons) return;
    return { object: content.workObject, table: content.table };
  }

  async function open(actor: Actor, request: WorkObjectRequest) {
    if (actor.team !== config.SLACK_TEAM_ID || !uuid.safeParse(request.id).success || request.url !== url(request.id)) return;
    const saved = await savedTable(actor, request.id, request.timestamp);
    if (!saved) return;
    const token = await new SignJWT({ channel: actor.channel, timestamp: request.timestamp, table: request.id })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer(config.PUBLIC_URL).setAudience(objectType)
      .setSubject(actor.user).setJti(request.eventId).setExpirationTime(lifetime).sign(key);
    // Use the URL fragment so the shell can load without sending a credential through proxy logs.
    const response = await fetcher('https://slack.com/api/entity.presentDetails', {
      method: 'POST', headers: { Authorization: `Bearer ${config.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger_id: request.trigger, metadata: workObjectMetadata(saved.object, `${request.url}#${token}`) }),
      signal: AbortSignal.timeout(2200),
    });
    if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) throw new Error('Slack did not open the Connexion panel.');
  }

  async function session(request: FastifyRequest) {
    const token = /^Bearer ([\w.-]{1,2048})$/.exec(request.headers.authorization ?? '')?.[1];
    if (!token) return;
    const verified = await jwtVerify(token, key, { issuer: config.PUBLIC_URL, audience: objectType, algorithms: ['HS256'] }).catch(() => undefined);
    const result = claims.safeParse(verified?.payload);
    if (!result.success) return;
    const { sub, table, channel, timestamp, jti } = result.data;
    const actor = { team: config.SLACK_TEAM_ID, user: sub, channel };
    const saved = await savedTable(actor, table, timestamp);
    if (saved) return { actor, id: table, timestamp, jti, table: saved.table };
  }

  function allowEmbed(request: FastifyRequest, reply: FastifyReply) {
    const origin = request.headers.origin;
    reply.header('Cache-Control', 'no-store').header('Vary', 'Origin');
    // Slack's default sandbox has an opaque origin. Each request still needs the signed bearer token.
    if (origin === 'null') reply.header('Access-Control-Allow-Origin', 'null');
    return origin === undefined || origin === 'null' || origin === config.PUBLIC_URL;
  }

  function registerRoutes(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>(`${path}/:id`, async (request, reply) => {
      if (!uuid.safeParse(request.params.id).success) return reply.code(404).send();
      const nonce = opaque();
      return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src ${config.PUBLIC_URL}; base-uri 'none'; form-action 'none'; frame-ancestors https://*.slack.com https://*.slack-gov.com https://*.slack-mcps.com https://slack-mcps-host.com`)
        .send(embeddedTablePage(nonce, path));
    });
    for (const [route, method] of [['donnees', 'GET'], ['ouvrir', 'POST']] as const) {
      app.options(`${path}/${route}`, async (request, reply) => {
        if (!allowEmbed(request, reply)) return reply.code(403).send();
        return reply.header('Access-Control-Allow-Methods', method).header('Access-Control-Allow-Headers', 'Authorization, Content-Type').code(204).send();
      });
    }
    app.get(`${path}/donnees`, async (request, reply) => {
      if (!allowEmbed(request, reply)) return reply.code(403).send();
      const current = await session(request);
      if (!current) return reply.code(401).send();
      const { columns, rows } = current.table;
      return { title: 'Connexion', columns, rows, filterColumn: 1 };
    });
    app.post(`${path}/ouvrir`, async (request, reply) => {
      if (!allowEmbed(request, reply)) return reply.code(403).send();
      const current = await session(request);
      if (!current) return reply.code(401).send();
      const input = z.strictObject({ row: z.number().int().nonnegative() }).safeParse(JSON.parse(String(request.body ?? 'null')));
      if (!input.success) return reply.code(400).send();
      const button = current.table.rowButtons?.[input.data.row];
      if (!button || Array.isArray(button) || button.action !== 'core:navigate' || !button.value.startsWith(`${current.id}|`)) return reply.code(404).send();
      await jobs.enqueue(`connexion:tableau:${current.id}:${current.jti}:${input.data.row}`, current.actor, {
        type: 'navigation', value: button.value, timestamp: current.timestamp, newMessage: true,
      });
      return reply.code(202).send({ ok: true });
    });
  }

  return { registerRoutes, workObject: { type: objectType, open },
    launch(actor: Actor, eventId: string, page: MenuPage, messenger: Messenger) {
      const id = uid();
      return new Navigation(sql, messenger).show(actor, eventId, { kind: 'Connexion', table: page.table,
        text: 'Ouvrez la carte pour consulter le tableau interactif. Le tableau classique est disponible avec connexion.',
        workObject: { id, type: objectType, url: url(id), title: 'Connexion · Tableau interactif' },
      }, null);
    },
  };
}
