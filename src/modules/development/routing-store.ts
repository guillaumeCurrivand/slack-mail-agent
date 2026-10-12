import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ownerKey, type Actor } from '../../core/identity.js';
import { transaction, type Database } from '../../core/transactions.js';
import type { Sql } from '../../core/store.js';
import { ready, repositoryKey, type Project, type Ticket } from './domain.js';

export const routingSchema = `
CREATE TABLE IF NOT EXISTS development_ticket_routes (
 team text NOT NULL, ticket text NOT NULL, folder text NOT NULL, channel text NOT NULL,
 snapshot jsonb NOT NULL, thread text, selected jsonb, armed boolean NOT NULL DEFAULT true,
 PRIMARY KEY(team,ticket)
);
CREATE TABLE IF NOT EXISTS development_route_proposals (
 id text PRIMARY KEY, owner text NOT NULL, channel text NOT NULL, ticket text NOT NULL,
 candidates jsonb NOT NULL, selected jsonb NOT NULL DEFAULT '[]', state text NOT NULL DEFAULT 'pending',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS development_route_runs (
 team text NOT NULL, ticket text NOT NULL, cycle text NOT NULL, project text NOT NULL,
 run text NOT NULL UNIQUE, PRIMARY KEY(team,cycle,project)
);`;

export type TicketRoute = { ticket: string; folder: string; channel: string; snapshot: Ticket; thread: string | null; selected: Project[] | null; armed: boolean };
export type RouteProposal = { id: string; ticket: string; candidates: Project[]; selected: string[]; state: string };
const identity = (p: Project) => [p.id, p.channel, p.folder, p.repository, p.skill];
export const sameDestination = (a: Project, b: Project) => isDeepStrictEqual(identity(a), identity(b));

/** One shared ticket owns its repository choice and each authorized batch of runs. */
export class RoutingStore {
  constructor(private db: Database, private team: string) {}
  async get(ticket: string): Promise<TicketRoute | undefined> {
    return (await this.db.query('SELECT * FROM development_ticket_routes WHERE team=$1 AND ticket=$2', [this.team, ticket])).rows[0] as TicketRoute | undefined;
  }
  async list(): Promise<TicketRoute[]> {
    return (await this.db.query('SELECT * FROM development_ticket_routes WHERE team=$1 ORDER BY ticket', [this.team])).rows as TicketRoute[];
  }
  async ensure(project: Project, ticket: Ticket, thread?: string) {
    await this.db.query(`INSERT INTO development_ticket_routes(team,ticket,folder,channel,snapshot,thread) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(team,ticket) DO UPDATE SET thread=COALESCE(development_ticket_routes.thread,excluded.thread)
      WHERE development_ticket_routes.folder=excluded.folder AND development_ticket_routes.channel=excluded.channel`,
    [this.team, ticket.id, project.folder, project.channel, JSON.stringify(ticket), thread ?? null]);
    const route = await this.get(ticket.id);
    return route?.folder === project.folder && route.channel === project.channel ? route : undefined;
  }
  async propose(actor: Actor, id: string, ticket: string, candidates: Project[]) {
    await this.db.query('INSERT INTO development_route_proposals(id,owner,channel,ticket,candidates) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [id, ownerKey(actor), actor.channel, ticket, JSON.stringify(candidates)]);
    return this.proposal(actor, id);
  }
  async proposal(actor: Actor, id: string): Promise<RouteProposal | undefined> {
    return (await this.db.query("SELECT * FROM development_route_proposals WHERE id=$1 AND owner=$2 AND channel=$3 AND created_at>=now()-interval '24 hours'", [id, ownerKey(actor), actor.channel])).rows[0] as RouteProposal | undefined;
  }
  async choose(actor: Actor, id: string, project: string, include: boolean, receipt: string) {
    await transaction(this.db, async sql => {
      const proposal = (await sql.query("SELECT * FROM development_route_proposals WHERE id=$1 AND owner=$2 AND channel=$3 AND state='pending' AND created_at>=now()-interval '24 hours' FOR UPDATE", [id, ownerKey(actor), actor.channel])).rows[0] as RouteProposal | undefined;
      if (!proposal?.candidates.some(p => p.id === project)) return;
      if (!(await sql.query('INSERT INTO development_receipts(team,id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id', [this.team, receipt])).rows.length) return;
      const selected = new Set(proposal.selected);
      if (include) selected.add(project); else selected.delete(project);
      await sql.query('UPDATE development_route_proposals SET selected=$2 WHERE id=$1', [id, JSON.stringify([...selected])]);
    });
    return this.proposal(actor, id);
  }
  async confirm(actor: Actor, id: string, cancel: boolean, ticket?: Ticket) {
    return transaction(this.db, async sql => {
      const proposal = (await sql.query("SELECT * FROM development_route_proposals WHERE id=$1 AND owner=$2 AND channel=$3 AND created_at>=now()-interval '24 hours' FOR UPDATE", [id, ownerKey(actor), actor.channel])).rows[0] as RouteProposal | undefined;
      if (!proposal) return 'unavailable';
      if (!['pending', 'ready'].includes(proposal.state)) return proposal.state;
      if (cancel) { await sql.query("UPDATE development_route_proposals SET state='cancelled' WHERE id=$1", [id]); return 'cancelled'; }
      if (proposal.state !== 'ready') return 'unavailable';
      const current = (await sql.query('SELECT config FROM development_projects WHERE team=$1 ORDER BY id FOR UPDATE', [this.team])).rows.map(row => row.config as Project);
      const route = (await sql.query('SELECT * FROM development_ticket_routes WHERE team=$1 AND ticket=$2 FOR UPDATE', [this.team, proposal.ticket])).rows[0] as TicketRoute | undefined;
      const selected = proposal.candidates.filter(p => proposal.selected.includes(p.id));
      if (!route || route.selected || !selected.length || !ticket || ticket.id !== route.ticket ||
        selected.some(p => !p.enabled || p.folder !== route.folder || p.channel !== route.channel || !isDeepStrictEqual(current.find(c => c.id === p.id), p))) return 'changed';
      // Pre-routing work cannot safely be adopted into a new multi-repository authorization.
      if ((await sql.query("SELECT 1 FROM development_runs WHERE team=$1 AND ticket->>'id'=$2 LIMIT 1", [this.team, route.ticket])).rows.length) return 'legacy';
      await sql.query('UPDATE development_ticket_routes SET selected=$3,snapshot=$4 WHERE team=$1 AND ticket=$2', [this.team, route.ticket, JSON.stringify(selected), JSON.stringify(ticket)]);
      await sql.query("UPDATE development_route_proposals SET state='applied' WHERE id=$1", [id]);
      // A Ready ticket is admitted by polling as one atomic batch. Otherwise selection starts analysis.
      if (!ready(ticket.status)) await this.queue(sql, { ...route, selected }, ticket, 'review', `selection:${id}`);
      return 'applied';
    });
  }
  async seal(actor: Actor, id: string) {
    await this.db.query("UPDATE development_route_proposals SET state='ready' WHERE id=$1 AND owner=$2 AND channel=$3 AND state='pending' AND selected<>'[]'::jsonb AND created_at>=now()-interval '24 hours'", [id, ownerKey(actor), actor.channel]);
    return this.proposal(actor, id);
  }
  private async queue(sql: Sql, route: TicketRoute, ticket: Ticket, kind: 'review' | 'build', cycle: string, thread = route.thread) {
    for (const project of route.selected!) {
      const id = `${cycle}:${project.id}`;
      await sql.query(`INSERT INTO development_runs(id,team,project,config,repository_key,kind,ticket,thread)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [id, this.team, project.id, JSON.stringify(project), repositoryKey(project.repository), kind, JSON.stringify(ticket), thread]);
      await sql.query('INSERT INTO development_route_runs(team,ticket,cycle,project,run) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [this.team, ticket.id, cycle, project.id, id]);
      if (thread) await sql.query('INSERT INTO development_threads(team,project,thread,ticket) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [this.team, project.id, thread, ticket.id]);
    }
  }
  async observe(ticket: Ticket, reviewEvent?: string, thread?: string) {
    return transaction(this.db, async sql => {
      const current = (await sql.query('SELECT config FROM development_projects WHERE team=$1 ORDER BY id FOR UPDATE', [this.team])).rows.map(row => row.config as Project);
      const route = (await sql.query('SELECT * FROM development_ticket_routes WHERE team=$1 AND ticket=$2 FOR UPDATE', [this.team, ticket.id])).rows[0] as TicketRoute | undefined;
      if (!route) return;
      if (!ready(ticket.status)) await sql.query('UPDATE development_ticket_routes SET armed=true WHERE team=$1 AND ticket=$2', [this.team, ticket.id]);
      if (!route.selected?.length || route.selected.some(p => !current.some(c => c.enabled && sameDestination(c, p)))) return;
      const busy = (await sql.query("SELECT 1 FROM development_runs WHERE team=$1 AND ticket->>'id'=$2 AND kind='build' AND (state IN ('queued','running','reporting') OR (state IN ('blocked','reporting_error') AND result->>'commit' IS NOT NULL)) LIMIT 1", [this.team, ticket.id])).rows.length;
      if (busy) return;
      if (reviewEvent) {
        if (!ready(ticket.status)) await this.queue(sql, route, ticket, 'review', `review:${reviewEvent}`, thread);
      } else if (ready(ticket.status) && route.armed) {
        await this.queue(sql, route, ticket, 'build', randomUUID());
        await sql.query('UPDATE development_ticket_routes SET armed=false WHERE team=$1 AND ticket=$2', [this.team, ticket.id]);
      }
    });
  }
  async completion(run: string): Promise<{ cycle: string; complete: boolean } | undefined> {
    const entry = (await this.db.query('SELECT cycle FROM development_route_runs WHERE team=$1 AND run=$2', [this.team, run])).rows[0];
    if (!entry) return;
    const rows = (await this.db.query('SELECT r.id,r.result,r.kind FROM development_route_runs m JOIN development_runs r ON r.id=m.run WHERE m.team=$1 AND m.cycle=$2 ORDER BY m.project', [this.team, entry.cycle])).rows;
    const revision = createHash('sha256').update(JSON.stringify(rows.map(r => r.id))).digest('hex');
    return { cycle: `${entry.cycle}:${revision}`, complete: rows.length > 0 && rows.every(r => r.kind === 'build' && r.result?.outcome === 'pushed' && r.result.commit) };
  }
}
