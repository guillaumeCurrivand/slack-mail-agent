import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../../core/identity.js';
import type { AssistantModule, IntegrationContext } from '../../core/modules.js';
import { menuButton } from '../../core/slack.js';
import { JobStore } from '../../core/store.js';
import type { Database } from '../../core/transactions.js';
import type { DevelopmentConfig } from './config.js';
import { canRetry, commitLink, projectSchema, ready, resultSchema, ticketIds, type Project, type Result, type Ticket } from './domain.js';
import { ClickupDevelopment, DevelopmentChannels, TicketOutsideFolder } from './providers.js';
import { developmentSchema, DevelopmentStore } from './store.js';
import { developmentHelp } from './help.js';
import { DevelopmentMenu, projectPage } from './menu.js';
import { configurationSchema } from './configuration-store.js';
import { DevelopmentConfiguration } from './configuration.js';
import { DevelopmentRouting } from './routing.js';
import { sameDestination, type TicketRoute } from './routing-store.js';

const help = developmentHelp.text;

export function createDevelopmentModule(config: DevelopmentConfig, database: Database, dependencies: {
  clickup?: ClickupDevelopment; channels?: DevelopmentChannels; fetcher?: typeof fetch;
} = {}): AssistantModule {
  const store = new DevelopmentStore(database, config.SLACK_TEAM_ID);
  const clickup = dependencies.clickup ?? new ClickupDevelopment(config.DEVELOPMENT_CLICKUP_TOKEN, dependencies.fetcher);
  const channels = dependencies.channels ?? new DevelopmentChannels(config.SLACK_BOT_TOKEN, dependencies.fetcher);
  const identity = { kind: 'integration' as const, team: config.SLACK_TEAM_ID, integration: 'development' };
  const token = Buffer.from(config.DEVELOPMENT_WORKER_TOKEN);
  const visible = async (actor: Actor, project: Project) => actor.team === config.SLACK_TEAM_ID && channels.accessible(project.channel, actor.user);
  const menus = new DevelopmentMenu(store, visible, clickup);
  const configuration = new DevelopmentConfiguration(store, menus, visible, clickup, config.SLACK_BOT_TOKEN, dependencies.fetcher);
  const routing = new DevelopmentRouting(store, menus, visible, clickup);

  async function post(context: IntegrationContext, project: Project, text: string, thread?: string, links?: Array<{ label: string; url: string }>) {
    if (!await channels.accessible(project.channel)) throw new Error('Canal indisponible.');
    if (!context.messenger.postThread) throw new Error('Publication en fil indisponible.');
    return context.messenger.postThread({ team: config.SLACK_TEAM_ID, channel: project.channel, thread }, { kind: 'Développement', text, resourceLinks: links });
  }

  async function finish(id: string, context: IntegrationContext) {
    const row = await store.run(id);
    if (!row || row.state !== 'reporting') return;
    const result = row.result as Result, project = row.config as Project;
    const batch = await routing.saved.completion(id);
    const complete = !batch || batch.complete;
    const commitUrl = result.commit && result.outcome === 'pushed' ? commitLink(project.repository, result.commit) : undefined;
    const text = `Projet : ${project.name}\n${row.ticket.name}\n${result.summary}\n${result.tests.length ? `Vérifications :\n${result.tests.join('\n')}` : ''}\n${result.outcome === 'pushed' ? `Commit poussé sur ${result.branch ?? 'maintenance'}. ${complete ? 'Tous les dépôts de cette correction sont prêts. Statut : to build. À vous de créer les PR/MR.' : 'En attente des autres dépôts sélectionnés ; le statut ClickUp reste inchangé.'}` : result.outcome === 'actionable' ? 'Informations suffisantes pour ce dépôt. Passez le ticket à Ready for AI pour autoriser le traitement.' : result.commit ? 'Publication à vérifier. Ne relancez pas le code avant réconciliation du commit.' : 'Traitement arrêté. Précisez le ticket puis demandez explicitement une relance.'}`;
    try {
      if (result.outcome === 'pushed' && complete) await store.effect(batch ? `routing:${batch.cycle}:status` : `${id}:status`, () => clickup.built(row.ticket.id));
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

  async function requestRouting(route: TicketRoute, project: Project, context: IntegrationContext) {
    if (route.selected) return;
    try { await store.effect(`routing:${config.SLACK_TEAM_ID}:${route.ticket}:notice`, () => post(context, project,
      `${route.snapshot.name}\nChoisissez les dépôts concernés dans votre DM : menu → Développement → Tickets et dépôts. Vous pouvez sélectionner Frontend, Backend ou les deux. Aucun traitement ne démarre avant ce choix, même si le ticket est Ready for AI.`, route.thread ?? undefined,
      [{ label: 'Ticket ClickUp', url: route.snapshot.url }])); }
    catch { /* An uncertain notice is not replayed and cannot block other tickets. The DM list remains available. */ }
  }

  return {
    id: 'development', name: 'Développement', description: 'Analyse et correction des tickets de maintenance avec un worker Cursor local',
    help: developmentHelp,
    async initialize(sql) {
      for (const statement of developmentSchema.split(';').map(value => value.trim()).filter(Boolean)) await sql.query(statement);
      await sql.query(configurationSchema);
      await new JobStore(sql).enqueueIntegration(`development:poll:${config.SLACK_TEAM_ID}`, identity, { type: 'poll' }, 'development');
    },
    menuActions: ['propose_state', 'propose_retry', 'confirm', 'cancel', 'configuration_prepare', 'configuration_open', 'configuration_save', 'configuration_cancel', 'routing_begin', 'routing_add', 'routing_remove', 'routing_check', 'routing_confirm', 'routing_cancel'],
    forms: configuration.forms,
    menu: (actor, page) => /^routes?_/.test(page) ? routing.page(actor, page) : menus.page(actor, page),
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
      if (payload.type === 'menu_action' && String(payload.action).startsWith('routing_')) return routing.handle(actor, payload, eventId, context);
      if (String(payload.type).startsWith('configuration_') || (payload.type === 'menu_action' && String(payload.action).startsWith('configuration_'))) return configuration.handle(actor, payload, eventId, context);
      if (payload.type !== 'text') return menus.handle(actor, payload, eventId, context);
      const text = String(payload.text ?? '').trim();
      const send = (message: string) => context.messenger.send(actor, { kind: 'Développement', text: message, buttons: [menuButton] });
      if (text.startsWith('configure ')) {
        let input: unknown;
        try { input = JSON.parse(text.slice(10)); } catch { return send('JSON de configuration invalide. ' + help); }
        if (input !== null && typeof input === 'object' && 'repository' in input && typeof input.repository === 'string') {
          // Slack can turn a pasted URL into <url> or <url|label> inside the JSON string.
          input = { ...input, repository: input.repository.replace(/^<(https:\/\/[^<>\s|]+)(?:\|[^<>]*)?>$/, '$1') };
        }
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
        return menus.show(actor, eventId, context, { kind: 'Développement', text: `Projet ${parsed.data.name} enregistré. ${parsed.data.enabled ? 'Les tickets Ready for AI sont autorisés pour le worker local.' : 'Nouveaux traitements suspendus.'}`, links: [{ label: 'Ouvrir le projet', page: projectPage(parsed.data.id) }] });
      }
      if (text === 'projects') {
        return menus.show(actor, eventId, context, await menus.page(actor, 'projects_0'));
      }
      if (text.startsWith('status ')) {
        return menus.show(actor, eventId, context, await menus.page(actor, projectPage(text.slice(7))));
      }
      if (text.startsWith('retry ')) {
        const row = await store.run(text.slice(6)), project = row && await store.project(row.project);
        const republish = row?.kind === 'build' && row.state === 'reporting_error' && row.result?.outcome === 'pushed' && row.result.commit;
        if (!row || !project || !project.enabled || !await visible(actor, project) || !await visible(actor, row.config) || !canRetry(row)) return send('Ce traitement ne peut pas être relancé.');
        // A fresh explicit request is a fresh run; repeated delivery of the same request is not.
        let refreshed: Ticket | undefined;
        if (republish) {
          try { refreshed = await clickup.ticket(project, row.ticket.id); }
          catch { return send('Relance impossible : lecture du ticket ClickUp indisponible.'); }
        }
        const started = await store.retry(row.id, eventId, project.id, refreshed);
        return send(started ? republish
          ? `Nouvelle exécution enregistrée. Le commit ${row.result!.commit} reste sur ${row.result!.branch ?? 'sa branche d’origine'} et n’est pas réécrit. Le worker publiera sur la branche configurée localement.`
          : 'Relance enregistrée avec les exigences déjà figées. Pour modifier les exigences, changez le statut puis remettez Ready for AI.' : 'Une relance existe déjà ou ce traitement ne peut plus être relancé.');
      }
      return send(help);
    },
    async handleIntegration(actor, payload, eventId, context) {
      if (actor.team !== identity.team || actor.integration !== identity.integration) throw new Error('Intégration inconnue.');
      if (payload.type === 'finish') return finish(String(payload.run), context);
      if (payload.type === 'poll') {
        const projects = await store.projects(), handled = new Set<string>();
        for (const project of projects) {
          if (!project.enabled) continue;
          if (handled.has(project.folder)) continue;
          handled.add(project.folder);
          const siblings = projects.filter(p => p.folder === project.folder);
          try {
            for (const task of await clickup.tasks(project)) {
              const existing = await routing.saved.get(task.id);
              if (siblings.length > 1 || existing) {
                if (!ready(task.status) && !existing) continue;
                const ticket = await clickup.ticket(project, task.id);
                const route = existing ?? await routing.saved.ensure(project, ticket);
                if (!route || route.folder !== project.folder) continue;
                const destination = siblings.find(p => p.channel === route.channel);
                if (!destination) continue;
                await requestRouting(route, destination, context);
                if (route.selected && (await Promise.all(route.selected.map(p => channels.accessible(p.channel)))).every(Boolean)) await routing.saved.observe(ticket);
                continue;
              }
              const snapshot = ready(task.status) && await store.needsSnapshot(project.id, task.id) ? await clickup.ticket(project, task.id) : undefined;
              await store.observe(project, task.id, snapshot?.status ?? task.status, snapshot);
            }
            for (const sibling of siblings) await store.health(sibling.id, null);
          } catch { for (const sibling of siblings) await store.health(sibling.id, 'Lecture ClickUp ou routage indisponible. La file existante est conservée ; nouvelle vérification dans une minute.'); }
        }
        return new Date(Date.now() + 60_000);
      }
      if (payload.type !== 'channel') return;
      const user = payload.actor as Actor;
      const projects = await store.projects(), accessible: Project[] = [];
      for (const project of projects) if (project.enabled && project.channel === user.channel && await visible(user, project)) accessible.push(project);
      const links = ticketIds(String(payload.text)), thread = String(payload.thread);
      const ids = new Set(links);
      if (!links.length) {
        for (const p of accessible) for (const id of await store.threads(p.id, thread)) ids.add(id);
        for (const route of await routing.saved.list()) if (route.channel === user.channel && route.thread === thread) ids.add(route.ticket);
      }
      for (const id of ids) {
        let matched = false;
        const folders = new Set<string>();
        for (const project of accessible) {
          if (folders.has(project.folder)) continue;
          folders.add(project.folder);
          try {
            // Folder ownership is established before posting comments or sharing task content.
            const ticket = await clickup.ticket(project, id);
            matched = true;
            const existing = await routing.saved.get(id);
            if (projects.filter(p => p.folder === project.folder).length > 1 || existing) {
              const route = await routing.saved.ensure(project, ticket, thread);
              if (!route) continue;
              await requestRouting(route, project, context);
              if (!route.selected || route.selected.some(p => !accessible.some(c => sameDestination(c, p)))) continue;
              if (!links.length) {
                if (ready(ticket.status) || (await Promise.all(route.selected.map(p => store.frozen(p.id, id)))).some(Boolean)) continue;
                const clarification = `Précision Slack (${user.user}) :\n${String(payload.text)}`;
                await store.effect(`${eventId}:${id}:clarification`, () => clickup.comment(id, clarification));
                ticket.comments.push(clarification);
              }
              await routing.saved.observe(ticket, eventId, thread);
              continue;
            }
            if (!links.length) {
              // Requirements are immutable after authorization, including thread responses.
              if (ready(ticket.status) || await store.frozen(project.id, id)) continue;
              const clarification = `Précision Slack (${user.user}) :\n${String(payload.text)}`;
              await store.effect(`${eventId}:${project.id}:${id}:clarification`, () => clickup.comment(id, clarification));
              ticket.comments.push(clarification);
            }
            await store.review(project, ticket, thread, eventId);
          } catch (error) {
            if (error instanceof TicketOutsideFolder) continue;
            await store.effect(`${eventId}:${project.id}:${id}:unavailable`, () => post(context, project, 'Ce ticket ne peut pas être analysé. Vérifiez son appartenance au dossier configuré et les accès ClickUp.', thread));
            matched = true;
          }
        }
        if (!matched && accessible[0]) await store.effect(`${eventId}:${id}:unavailable`, () => post(context, accessible[0]!, 'Ce ticket ne peut pas être analysé. Vérifiez son appartenance au dossier configuré et les accès ClickUp.', thread));
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
