import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Sql } from '../../core/store.js';
import { JobStore } from '../../core/store.js';
import { transaction, type Database } from '../../core/transactions.js';
import { ready, repositoryKey, type Project, type Result, type Ticket, type Work } from './domain.js';

export const developmentSchema = `
CREATE TABLE IF NOT EXISTS development_projects (
 team text NOT NULL, id text NOT NULL, config jsonb NOT NULL, PRIMARY KEY(team,id)
);
CREATE TABLE IF NOT EXISTS development_threads (
 team text NOT NULL, project text NOT NULL, thread text NOT NULL, ticket text NOT NULL,
 PRIMARY KEY(team,project,thread,ticket)
);
CREATE TABLE IF NOT EXISTS development_ticket_state (
 team text NOT NULL, project text NOT NULL, ticket text NOT NULL, armed boolean NOT NULL DEFAULT true,
 PRIMARY KEY(team,project,ticket)
);
CREATE TABLE IF NOT EXISTS development_runs (
 id text PRIMARY KEY, team text NOT NULL, project text NOT NULL, config jsonb NOT NULL, repository_key text NOT NULL,
 kind text NOT NULL, ticket jsonb NOT NULL, thread text, state text NOT NULL DEFAULT 'queued',
 worker text, lease text, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 2), result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS development_queue ON development_runs(team,state,created_at);
CREATE TABLE IF NOT EXISTS development_effects (
 id text PRIMARY KEY, team text NOT NULL, state text NOT NULL DEFAULT 'sending', detail text
);
CREATE TABLE IF NOT EXISTS development_receipts (
 team text NOT NULL, id text NOT NULL, PRIMARY KEY(team,id)
);
CREATE TABLE IF NOT EXISTS development_health (
 team text NOT NULL, project text NOT NULL, issue text, checked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(team,project)
);
`;

export class DevelopmentStore {
  constructor(readonly db: Database, readonly team: string) {}
  async projects(): Promise<Project[]> { return (await this.db.query('SELECT config FROM development_projects WHERE team=$1 ORDER BY id', [this.team])).rows.map(row => row.config); }
  async project(id: string): Promise<Project | undefined> { return (await this.db.query('SELECT config FROM development_projects WHERE team=$1 AND id=$2', [this.team, id])).rows[0]?.config; }
  async save(project: Project, receipt: string) {
    return transaction(this.db, async sql => {
      if (!(await sql.query('INSERT INTO development_receipts(team,id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id', [this.team, receipt])).rows.length) return;
      await sql.query('INSERT INTO development_projects(team,id,config) VALUES($1,$2,$3) ON CONFLICT(team,id) DO UPDATE SET config=excluded.config', [this.team, project.id, JSON.stringify(project)]);
    });
  }
  async threads(project: string, thread: string): Promise<string[]> {
    return (await this.db.query('SELECT ticket FROM development_threads WHERE team=$1 AND project=$2 AND thread=$3', [this.team, project, thread])).rows.map(row => row.ticket);
  }
  async review(project: Project, ticket: Ticket, thread: string, event: string) {
    await transaction(this.db, async sql => {
      await sql.query('INSERT INTO development_threads(team,project,thread,ticket) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [this.team, project.id, thread, ticket.id]);
      await this.insert(sql, `review:${event}:${project.id}:${ticket.id}`, project, ticket, 'review', thread);
    });
  }
  private async insert(sql: Sql, id: string, project: Project, ticket: Ticket, kind: string, thread: string | null) {
    await sql.query('INSERT INTO development_runs(id,team,project,config,kind,ticket,thread,repository_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
      [id, this.team, project.id, JSON.stringify(project), kind, JSON.stringify(ticket), thread, repositoryKey(project.repository)]);
  }
  async observe(project: Project, id: string, status: string, snapshot?: Ticket) {
    await transaction(this.db, async sql => {
      await sql.query('SELECT id FROM development_projects WHERE team=$1 AND id=$2 FOR UPDATE', [this.team, project.id]);
      await sql.query('INSERT INTO development_ticket_state(team,project,ticket) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [this.team, project.id, id]);
      if (!ready(status)) {
        await sql.query('UPDATE development_ticket_state SET armed=true WHERE team=$1 AND project=$2 AND ticket=$3', [this.team, project.id, id]); return;
      }
      const state = (await sql.query('SELECT armed FROM development_ticket_state WHERE team=$1 AND project=$2 AND ticket=$3', [this.team, project.id, id])).rows[0];
      const busy = (await sql.query("SELECT id FROM development_runs WHERE team=$1 AND project=$2 AND ticket->>'id'=$3 AND kind='build' AND (state IN ('queued','running','reporting') OR (state IN ('blocked','reporting_error') AND result->>'commit' IS NOT NULL))", [this.team, project.id, id])).rows.length;
      if (!state.armed || busy || !snapshot) return;
      const thread = (await sql.query('SELECT thread FROM development_threads WHERE team=$1 AND project=$2 AND ticket=$3 ORDER BY thread DESC LIMIT 1', [this.team, project.id, id])).rows[0]?.thread ?? null;
      await this.insert(sql, randomUUID(), project, snapshot, 'build', thread);
      await sql.query('UPDATE development_ticket_state SET armed=false WHERE team=$1 AND project=$2 AND ticket=$3', [this.team, project.id, id]);
    });
  }
  async needsSnapshot(project: string, ticket: string) {
    const row = (await this.db.query('SELECT armed FROM development_ticket_state WHERE team=$1 AND project=$2 AND ticket=$3', [this.team, project, ticket])).rows[0];
    return !row || row.armed;
  }
  async claim(worker: string, projects: string[]): Promise<Work | null> {
    return transaction(this.db, async sql => {
      // Project row locks serialize all users/workers; a running job never expires.
      await sql.query('SELECT id FROM development_projects WHERE team=$1 ORDER BY id FOR UPDATE', [this.team]);
      let row = (await sql.query("SELECT * FROM development_runs WHERE team=$1 AND worker=$2 AND state='running' ORDER BY created_at LIMIT 1", [this.team, worker])).rows[0];
      if (!row) row = (await sql.query(`SELECT r.* FROM development_runs r JOIN development_projects p ON p.team=r.team AND p.id=r.project
        WHERE r.team=$1 AND r.project=ANY($2::text[]) AND r.state='queued' AND (p.config->>'enabled')::boolean
        AND NOT EXISTS (SELECT 1 FROM development_runs busy WHERE busy.team=r.team AND busy.state IN ('running','reporting') AND busy.repository_key=r.repository_key)
        ORDER BY r.created_at,r.id LIMIT 1`, [this.team, projects])).rows[0];
      if (!row) return null;
      if (!row.lease) {
        row.lease = randomUUID();
        await sql.query("UPDATE development_runs SET state='running',worker=$2,lease=$3,updated_at=now() WHERE id=$1", [row.id, worker, row.lease]);
      }
      return { id: row.id, project: row.config, kind: row.kind, ticket: row.ticket, attempts: row.attempts, thread: row.thread, lease: row.lease };
    });
  }
  async attempt(id: string, lease: string, expected: number) {
    const row = (await this.db.query("UPDATE development_runs SET attempts=attempts+1,updated_at=now() WHERE team=$1 AND id=$2 AND lease=$3 AND state='running' AND attempts=$4 AND attempts<2 RETURNING attempts", [this.team, id, lease, expected])).rows[0];
    return row?.attempts as number | undefined;
  }
  async finish(id: string, lease: string, result: Result) {
    return transaction(this.db, async sql => {
      const row = (await sql.query('SELECT * FROM development_runs WHERE team=$1 AND id=$2 AND lease=$3 FOR UPDATE', [this.team, id, lease])).rows[0];
      if (!row) return false;
      if (row.result) return isDeepStrictEqual(row.result, result);
      if (row.state !== 'running' || (result.outcome === 'pushed' && (row.kind !== 'build' || !result.commit || !row.attempts || !result.tests.length)) || (row.kind === 'build' && result.outcome === 'actionable')) return false;
      await sql.query("UPDATE development_runs SET result=$2,state='reporting',updated_at=now() WHERE id=$1", [id, JSON.stringify(result)]);
      await new JobStore(sql).enqueueIntegration(`development:finish:${id}`, { kind: 'integration', team: this.team, integration: 'development' }, { type: 'finish', run: id }, 'development');
      return true;
    });
  }
  async run(id: string) { return (await this.db.query('SELECT * FROM development_runs WHERE team=$1 AND id=$2', [this.team, id])).rows[0]; }
  async retry(id: string, eventId: string, project: string) {
    return transaction(this.db, async sql => {
      await sql.query('SELECT id FROM development_projects WHERE team=$1 AND id=$2 FOR UPDATE', [this.team, project]);
      return (await sql.query(`INSERT INTO development_runs(id,team,project,config,kind,ticket,thread,repository_key)
        SELECT $1,team,project,config,kind,ticket,thread,repository_key FROM development_runs r WHERE id=$2 AND team=$3 AND state='blocked' AND result->>'commit' IS NULL
        AND NOT EXISTS (SELECT 1 FROM development_runs active WHERE active.team=r.team AND active.project=r.project AND active.ticket->>'id'=r.ticket->>'id' AND active.kind=r.kind AND active.state IN ('queued','running','reporting'))
        ON CONFLICT DO NOTHING RETURNING id`, [`retry:${eventId}`, id, this.team])).rows.length > 0;
    });
  }
  async history(project: string) { return (await this.db.query('SELECT id,kind,state,attempts,ticket,result FROM development_runs WHERE team=$1 AND project=$2 ORDER BY created_at DESC LIMIT 10', [this.team, project])).rows; }
  async frozen(project: string, ticket: string) {
    return (await this.db.query("SELECT 1 FROM development_runs WHERE team=$1 AND project=$2 AND ticket->>'id'=$3 AND kind='build' AND state IN ('queued','running','reporting') LIMIT 1", [this.team, project, ticket])).rows.length > 0;
  }
  async health(project: string, issue: string | null) {
    await this.db.query('INSERT INTO development_health(team,project,issue) VALUES($1,$2,$3) ON CONFLICT(team,project) DO UPDATE SET issue=excluded.issue,checked_at=now()', [this.team, project, issue]);
  }
  async effect(id: string, action: () => Promise<string | void>) {
    const inserted = (await this.db.query('INSERT INTO development_effects(id,team) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id', [id, this.team])).rows.length;
    if (!inserted) {
      const row = (await this.db.query('SELECT state,detail FROM development_effects WHERE id=$1 AND team=$2', [id, this.team])).rows[0];
      if (row?.state !== 'done') throw new Error('Résultat externe incertain : intervention nécessaire.');
      return row.detail as string | undefined;
    }
    // A crash/network error after this point is never blindly replayed.
    const detail = await action();
    await this.db.query("UPDATE development_effects SET state='done',detail=$2 WHERE id=$1 AND team=$3", [id, detail ?? null, this.team]);
    return detail;
  }
}
