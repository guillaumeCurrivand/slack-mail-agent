import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../../core/identity.js';
import type { AssistantModule, IntegrationContext } from '../../core/modules.js';
import { JobStore } from '../../core/store.js';
import type { Database } from '../../core/transactions.js';
import type { DevelopmentConfig } from './config.js';
import { projectSchema, ready, resultSchema, ticketIds, type Project, type Result } from './domain.js';
import { ClickupDevelopment, DevelopmentChannels } from './providers.js';
import { developmentSchema, DevelopmentStore } from './store.js';

const help = 'Configurez un projet avec development configure {"id":"projet","name":"Projet","channel":"C…","folder":"123","repository":"https://github.com/organisation/projet","skill":"maintenance"}. '
  + 'Les membres du canal peuvent consulter et configurer ce projet. Publiez un lien ClickUp dans le canal pour une analyse. Ready for AI autorise le traitement ; le commit testé est poussé sur la branche de maintenance configurée sur le worker puis le ticket passe à to build. Aucun PR/MR automatique. '
  + 'Commandes : development projects ; development status <projet> ; development retry <identifiant du traitement bloqué>. Le worker local doit être connecté. Les appels Cursor sont facturés séparément ; le budget OpenAI de Mayassistant ne les couvre pas.';

export function createDevelopmentModule(config: DevelopmentConfig, database: Database, dependencies: {
  clickup?: ClickupDevelopment; channels?: DevelopmentChannels; fetcher?: typeof fetch;
} = {}): AssistantModule {
  const store = new DevelopmentStore(database, config.SLACK_TEAM_ID);
  const clickup = dependencies.clickup ?? new ClickupDevelopment(config.DEVELOPMENT_CLICKUP_TOKEN, dependencies.fetcher);
  const channels = dependencies.channels ?? new DevelopmentChannels(config.SLACK_BOT_TOKEN, dependencies.fetcher);
  const identity = { kind: 'integration' as const, team: config.SLACK_TEAM_ID, integration: 'development' };
  const token = Buffer.from(config.DEVELOPMENT_WORKER_TOKEN);
  const visible = async (actor: Actor, project: Project) => actor.team === config.SLACK_TEAM_ID && channels.accessible(project.channel, actor.user);

  async function post(context: IntegrationContext, project: Project, text: string, thread?: string, links?: Array<{ label: string; url: string }>) {
    if (!await channels.accessible(project.channel)) throw new Error('Canal indisponible.');
    if (!context.messenger.postThread) throw new Error('Publication en fil indisponible.');
    return context.messenger.postThread({ team: config.SLACK_TEAM_ID, channel: project.channel, thread }, { kind: 'Développement', text, resourceLinks: links });
  }

  async function finish(id: string, context: IntegrationContext) {
    const row = await store.run(id);
    if (!row || row.state !== 'reporting') return;
    const result = row.result as Result, project = row.config as Project;
    const commitUrl = result.commit && result.outcome === 'pushed' ? `${project.repository.replace(/\.git\/?$/, '').replace(/\/$/, '')}/${new URL(project.repository).hostname === 'github.com' ? 'commit' : '-/commit'}/${result.commit}` : undefined;
    const text = `${row.ticket.name}\n${result.summary}\n${result.tests.length ? `Vérifications :\n${result.tests.join('\n')}` : ''}\n${result.outcome === 'pushed' ? `Commit poussé sur ${result.branch ?? 'maintenance'}. Statut : to build. À vous de créer le PR/MR.` : result.outcome === 'actionable' ? 'Informations suffisantes. Passez le ticket à Ready for AI pour autoriser le traitement.' : result.commit ? 'Publication à vérifier. Ne relancez pas le code avant réconciliation du commit.' : 'Traitement arrêté. Précisez le ticket puis demandez explicitement une relance.'}`;
    try {
      if (result.outcome === 'pushed') await store.effect(`${id}:status`, () => clickup.built(row.ticket.id));
      await store.effect(`${id}:comment`, () => clickup.comment(row.ticket.id, `${text}${commitUrl ? `\nCommit : ${commitUrl}` : ''}`));
      const timestamp = await store.effect(`${id}:slack`, () => post(context, project, text, row.thread ?? undefined,
        [{ label: 'Ticket ClickUp', url: row.ticket.url }, ...(commitUrl ? [{ label: 'Commit', url: commitUrl }] : [])]));
      if (!row.thread && timestamp) await database.query('INSERT INTO development_threads(team,project,thread,ticket) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [config.SLACK_TEAM_ID, project.id, timestamp, row.ticket.id]);
      await database.query('UPDATE development_runs SET state=$2,updated_at=now() WHERE id=$1', [id, ['blocked', 'needs_information'].includes(result.outcome) ? 'blocked' : 'completed']);
    } catch {
      await database.query("UPDATE development_runs SET state='reporting_error',updated_at=now() WHERE id=$1", [id]);
      await store.effect(`${id}:delivery-warning`, () => post(context, project, `Le traitement ${id} nécessite une vérification des publications ClickUp/Slack. ${result.outcome === 'pushed' ? `Le commit ${result.commit} a déjà été poussé : ne relancez pas le code.` : result.commit ? `Vérifiez la publication du commit ${result.commit} avant toute reprise.` : ''} Consultez development status ${project.id}.`, row.thread ?? undefined));
    }
  }

  return {
    id: 'development', name: 'Développement', description: 'Analyse et correction des tickets de maintenance avec un worker Cursor local',
    async initialize(sql) {
      for (const statement of developmentSchema.split(';').map(value => value.trim()).filter(Boolean)) await sql.query(statement);
      await new JobStore(sql).enqueueIntegration(`development:poll:${config.SLACK_TEAM_ID}`, identity, { type: 'poll' }, 'development');
    },
    async menu() { return { kind: 'Développement', text: help }; },
    async receiveChannel(actor, payload, eventId) {
      if (actor.team !== config.SLACK_TEAM_ID) return;
      const projects = (await store.projects()).filter(project => project.enabled && project.channel === actor.channel);
      if (!projects.length) return;
      // Retain rapid replies even when the root's queued handler has not saved its ticket association yet.
      if (!ticketIds(String(payload.text)).length && payload.thread === payload.timestamp) return;
      await new JobStore(database).enqueueIntegration(`development:${eventId}`, identity, { type: 'channel', actor, ...payload }, 'development');
    },
    async handle(actor, payload, eventId, context) {
      if (actor.team !== config.SLACK_TEAM_ID) return;
      const text = String(payload.text ?? '').trim();
      const send = (message: string) => context.messenger.send(actor, { kind: 'Développement', text: message });
      if (text.startsWith('configure ')) {
        let input: unknown;
        try { input = JSON.parse(text.slice(10)); } catch { return send('JSON de configuration invalide. ' + help); }
        const parsed = projectSchema.safeParse(input);
        if (!parsed.success) return send('Configuration invalide. ' + help);
        const existing = await store.project(parsed.data.id);
        let accessible: boolean;
        try { accessible = await visible(actor, parsed.data) && (!existing || await visible(actor, existing)); }
        catch { return send('Configuration non enregistrée : vérification des accès Slack indisponible. Vérifiez les permissions du bot, puis renvoyez la commande development configure.'); }
        if (!accessible) return send('Vous et le bot devez avoir accès au canal actuel et au canal configuré.');
        try { await clickup.lists(parsed.data.folder); }
        catch { return send('Configuration non enregistrée : lecture du dossier ClickUp indisponible. Vérifiez son identifiant et les accès du jeton Development, puis renvoyez la commande development configure.'); }
        await store.save(parsed.data, eventId);
        return send(`Projet ${parsed.data.name} enregistré. ${parsed.data.enabled ? 'Les tickets Ready for AI sont autorisés pour le worker local.' : 'Nouveaux traitements suspendus.'}`);
      }
      if (text === 'projects') {
        const projects: Project[] = [];
        for (const project of await store.projects()) if (await visible(actor, project)) projects.push(project);
        return send(projects.map(project => `${project.id} — ${project.name} — ${project.enabled ? 'activé' : 'suspendu'} — canal ${project.channel}, dossier ${project.folder}, skill ${project.skill}`).join('\n') || 'Aucun projet accessible. ' + help);
      }
      if (text.startsWith('status ')) {
        const project = await store.project(text.slice(7));
        if (!project || !await visible(actor, project)) return send('Projet inaccessible.');
        const rows = await store.history(project.id);
        const health = (await database.query('SELECT issue,checked_at FROM development_health WHERE team=$1 AND project=$2', [config.SLACK_TEAM_ID, project.id])).rows[0];
        const labels: Record<string, string> = { queued: 'en attente', running: 'en cours', reporting: 'publication en cours', reporting_error: 'publication à vérifier', blocked: 'bloqué', completed: 'terminé' };
        return send([health?.issue, rows.map(row => `${row.id} — ${row.ticket.name} — ${labels[row.state] ?? row.state} — essais ${row.attempts}/2${row.result ? `\n${row.result.summary}` : ''}`).join('\n\n') || 'Aucun traitement.'].filter(Boolean).join('\n\n'));
      }
      if (text.startsWith('retry ')) {
        const row = await store.run(text.slice(6)), project = row && await store.project(row.project);
        if (!row || !project || !project.enabled || row.state !== 'blocked' || row.result?.commit || !await visible(actor, project)) return send('Ce traitement ne peut pas être relancé.');
        // A fresh explicit request is a fresh run; repeated delivery of the same request is not.
        const started = await store.retry(row.id, eventId, project.id);
        return send(started ? 'Relance enregistrée avec les exigences déjà figées. Pour modifier les exigences, changez le statut puis remettez Ready for AI.' : 'Une relance existe déjà ou ce traitement ne peut plus être relancé.');
      }
      return send(help);
    },
    async handleIntegration(actor, payload, eventId, context) {
      if (actor.team !== identity.team || actor.integration !== identity.integration) throw new Error('Intégration inconnue.');
      if (payload.type === 'finish') return finish(String(payload.run), context);
      if (payload.type === 'poll') {
        for (const project of await store.projects()) {
          if (!project.enabled) continue;
          try {
            for (const task of await clickup.tasks(project)) {
              const snapshot = ready(task.status) && await store.needsSnapshot(project.id, task.id) ? await clickup.ticket(project, task.id) : undefined;
              await store.observe(project, task.id, snapshot?.status ?? task.status, snapshot);
            }
            await store.health(project.id, null);
          } catch { await store.health(project.id, 'Lecture ClickUp indisponible ou incomplète. La file existante est conservée ; nouvelle vérification dans une minute.'); }
        }
        return new Date(Date.now() + 60_000);
      }
      if (payload.type !== 'channel') return;
      const user = payload.actor as Actor;
      for (const project of await store.projects()) {
        if (!project.enabled || project.channel !== user.channel || !await visible(user, project)) continue;
        const links = ticketIds(String(payload.text)), thread = String(payload.thread);
        const ids = links.length ? links : await store.threads(project.id, thread);
        for (const id of ids) {
          try {
            // Folder ownership is established before posting comments or sharing task content.
            const ticket = await clickup.ticket(project, id);
            if (!links.length) {
              // Requirements are immutable after authorization, including thread responses.
              if (ready(ticket.status) || await store.frozen(project.id, id)) continue;
              const clarification = `Précision Slack (${user.user}) :\n${String(payload.text)}`;
              await store.effect(`${eventId}:${project.id}:${id}:clarification`, () => clickup.comment(id, clarification));
              ticket.comments.push(clarification);
            }
            await store.review(project, ticket, thread, eventId);
          } catch {
            await store.effect(`${eventId}:${project.id}:${id}:unavailable`, () => post(context, project, 'Ce ticket ne peut pas être analysé. Vérifiez son appartenance au dossier configuré et les accès ClickUp.', thread));
          }
        }
      }
    },
    registerRoutes(app) {
      const authorized = (header: string | undefined) => {
        const supplied = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
        return supplied.length === token.length && timingSafeEqual(supplied, token);
      };
      const body = (request: { body: unknown }) => JSON.parse(String(request.body ?? '{}'));
      app.post('/development/worker/claim', async (request, reply) => {
        if (!authorized(request.headers.authorization)) return reply.code(401).send();
        const input = z.object({ worker: z.uuid(), projects: z.array(projectSchema.shape.id).min(1).max(100) }).strict().parse(body(request));
        return { work: await store.claim(input.worker, input.projects) };
      });
      app.post('/development/worker/attempt', async (request, reply) => {
        if (!authorized(request.headers.authorization)) return reply.code(401).send();
        const input = z.object({ id: z.string().max(300), lease: z.uuid(), expected: z.number().int().min(0).max(1) }).strict().parse(body(request));
        const attempt = await store.attempt(input.id, input.lease, input.expected);
        return attempt ? { attempt } : reply.code(409).send({ error: 'Essai déjà démarré ou limite atteinte.' });
      });
      app.post('/development/worker/result', async (request, reply) => {
        if (!authorized(request.headers.authorization)) return reply.code(401).send();
        const input = z.object({ id: z.string().max(300), lease: z.uuid(), result: resultSchema }).strict().parse(body(request));
        return await store.finish(input.id, input.lease, input.result) ? { ok: true } : reply.code(409).send({ error: 'Traitement indisponible.' });
      });
    },
  };
}
