import { ownerKey, uid, type Actor } from '../../core/identity.js';
import type { Sql } from '../../core/store.js';
import type { Project, ProjectFields, ProjectEdit } from './domain.js';

export const documentationSchema = `
CREATE TABLE IF NOT EXISTS documentation_confirmations (
 id text PRIMARY KEY, team text NOT NULL, owner text NOT NULL, channel text NOT NULL,
 request_id text NOT NULL, target_id text NOT NULL, fields jsonb NOT NULL,
 created_at timestamptz NOT NULL, applied_at timestamptz,
 UNIQUE(owner,request_id)
);
ALTER TABLE documentation_confirmations ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT 'create';
ALTER TABLE documentation_confirmations ADD COLUMN IF NOT EXISTS outcome text;
CREATE TABLE IF NOT EXISTS documentation_projects (
 team text NOT NULL, id text NOT NULL, fields jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(team,id)
);
CREATE TABLE IF NOT EXISTS documentation_history (
 team text NOT NULL, id text NOT NULL, project_id text NOT NULL,
 actor text NOT NULL, source text NOT NULL, before_values jsonb, after_values jsonb NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(team,id),
 FOREIGN KEY(team,project_id) REFERENCES documentation_projects(team,id)
);
CREATE INDEX IF NOT EXISTS documentation_project_history ON documentation_history(team,project_id,changed_at,id);
CREATE TABLE IF NOT EXISTS documentation_deliveries (
 owner text NOT NULL, event_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,event_id)
);
CREATE TABLE IF NOT EXISTS documentation_lookups (
 id text PRIMARY KEY, team text NOT NULL, owner text NOT NULL, channel text NOT NULL,
 event_id text NOT NULL, selector text NOT NULL, destination text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,event_id)
);`;

type Confirmation = { id: string; target_id: string; fields: ProjectEdit; operation: 'create' | 'edit'; outcome: 'applied' | 'satisfied' | 'missing' | null; created_at: Date | string; applied_at: Date | string | null };
const confirmationColumns = 'id,target_id,fields,operation,outcome,created_at,applied_at';
export class DocumentationStore {
  constructor(private sql: Sql) {}
  async propose(actor: Actor, eventId: string, fields: ProjectFields): Promise<Confirmation> {
    const result = await this.sql.query(`INSERT INTO documentation_confirmations(id,team,owner,channel,request_id,target_id,fields,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(owner,request_id) DO UPDATE SET request_id=excluded.request_id
      RETURNING ${confirmationColumns}`, [uid(), actor.team, ownerKey(actor), actor.channel, eventId, uid(), JSON.stringify(fields)]);
    return result.rows[0];
  }
  async proposeEdit(actor: Actor, eventId: string, project: Project, fields: ProjectEdit): Promise<Confirmation> {
    return (await this.sql.query(`INSERT INTO documentation_confirmations(id,team,owner,channel,request_id,target_id,fields,created_at,operation)
      VALUES($1,$2,$3,$4,$5,$6,$7,now(),'edit') ON CONFLICT(owner,request_id) DO UPDATE SET request_id=excluded.request_id
      RETURNING ${confirmationColumns}`, [uid(), actor.team, ownerKey(actor), actor.channel, eventId, project.id, JSON.stringify(fields)])).rows[0];
  }
  async request(actor: Actor, eventId: string): Promise<Confirmation | undefined> {
    return (await this.sql.query(`SELECT ${confirmationColumns} FROM documentation_confirmations
      WHERE team=$1 AND owner=$2 AND channel=$3 AND request_id=$4`, [actor.team, ownerKey(actor), actor.channel, eventId])).rows[0];
  }
  async confirmation(actor: Actor, id: string): Promise<Confirmation | undefined> {
    return (await this.sql.query(`SELECT ${confirmationColumns} FROM documentation_confirmations
      WHERE id=$1 AND team=$2 AND owner=$3 AND channel=$4`, [id, actor.team, ownerKey(actor), actor.channel])).rows[0];
  }
  async confirm(actor: Actor, id: string): Promise<Confirmation | undefined> {
    // One database statement serializes approvals on the saved confirmation row
    // and commits the record, initial history, and effect checkpoint together.
    await this.sql.query(`WITH claimed AS (
      UPDATE documentation_confirmations SET applied_at=now()
      WHERE id=$1 AND team=$2 AND owner=$3 AND channel=$4 AND operation='create' AND applied_at IS NULL
        AND created_at>now()-interval '24 hours' AND created_at<=now()
      RETURNING id,team,target_id,fields,applied_at
    ), created AS (
      INSERT INTO documentation_projects(team,id,fields,created_at)
      SELECT team,target_id,fields,applied_at FROM claimed RETURNING id
    ) INSERT INTO documentation_history(team,id,project_id,actor,source,before_values,after_values,changed_at)
      SELECT team,id,target_id,$5,'Slack structured creation',NULL,fields,applied_at FROM claimed
      WHERE EXISTS(SELECT 1 FROM created)`, [id, actor.team, ownerKey(actor), actor.channel, actor.user]);
    return this.confirmation(actor, id);
  }
  async confirmEdit(actor: Actor, id: string): Promise<Confirmation | undefined> {
    // Lock the confirmation first, then the shared Project. FOR UPDATE reads the
    // current row after waiting for another actor; history uses those locked values.
    // All effects and the terminal checkpoint are in this one atomic statement.
    await this.sql.query(`WITH eligible AS MATERIALIZED (
      SELECT * FROM documentation_confirmations
      WHERE id=$1 AND team=$2 AND owner=$3 AND channel=$4 AND operation='edit' AND applied_at IS NULL
        AND created_at>now()-interval '24 hours' AND created_at<=now() FOR UPDATE
    ), locked AS MATERIALIZED (
      SELECT p.team,p.id,p.fields FROM documentation_projects p JOIN eligible c ON p.team=c.team AND p.id=c.target_id
      FOR UPDATE OF p
    ), changes AS MATERIALIZED (
      SELECT p.team,p.id,
        COALESCE((SELECT jsonb_object_agg(e.key,p.fields->e.key) FROM jsonb_each(c.fields) e
          WHERE p.fields->e.key IS DISTINCT FROM e.value),'{}'::jsonb) AS before_values,
        COALESCE((SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(c.fields) e
          WHERE p.fields->e.key IS DISTINCT FROM e.value),'{}'::jsonb) AS after_values,
        p.fields || c.fields AS replacement
      FROM locked p JOIN eligible c ON c.team=p.team AND c.target_id=p.id
    ), edited AS (
      UPDATE documentation_projects p SET fields=d.replacement FROM changes d
      WHERE p.team=d.team AND p.id=d.id AND d.after_values<>'{}'::jsonb RETURNING p.id
    ), finished AS (
      UPDATE documentation_confirmations c SET applied_at=clock_timestamp(),
        outcome=CASE WHEN NOT EXISTS(SELECT 1 FROM locked) THEN 'missing'
          WHEN EXISTS(SELECT 1 FROM edited) THEN 'applied' ELSE 'satisfied' END
      FROM eligible e WHERE c.id=e.id RETURNING c.id,c.team,c.target_id,c.applied_at,c.outcome
    ) INSERT INTO documentation_history(team,id,project_id,actor,source,before_values,after_values,changed_at)
      SELECT c.team,c.id,c.target_id,$5,'Slack structured edit',d.before_values,d.after_values,c.applied_at
      FROM finished c JOIN changes d ON d.team=c.team AND d.id=c.target_id WHERE c.outcome='applied'`,
    [id, actor.team, ownerKey(actor), actor.channel, actor.user]);
    return this.confirmation(actor, id);
  }
  async projects(actor: Actor, requestedPage = 0, selector: string | null = null): Promise<{ projects: Project[]; total: number; page: number; pages: number }> {
    const filter = `team=$1 AND ($2::text IS NULL OR id=$2 OR lower(fields->>'name')=lower($2)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(NULLIF(fields->'aliases','null'::jsonb),'[]'::jsonb)) alias WHERE lower(alias)=lower($2)))`;
    const total = Number((await this.sql.query(`SELECT count(*) AS total FROM documentation_projects WHERE ${filter}`, [actor.team, selector])).rows[0].total);
    const pages = Math.max(1, Math.ceil(total / 8)), page = Math.min(requestedPage, pages - 1);
    const projects = (await this.sql.query(`SELECT id,fields,created_at FROM documentation_projects
      WHERE ${filter} ORDER BY lower(fields->>'name'),id LIMIT 8 OFFSET $3`, [actor.team, selector, page * 8])).rows;
    return { projects, total, page, pages };
  }
  async project(actor: Actor, id: string): Promise<Project | undefined> {
    return (await this.sql.query('SELECT id,fields,created_at FROM documentation_projects WHERE team=$1 AND id=$2', [actor.team, id])).rows[0];
  }
  async lookup(actor: Actor, query: string) {
    const exactId = await this.project(actor, query);
    return exactId ? { projects: [exactId], total: 1, page: 0, pages: 1 } : this.projects(actor, 0, query);
  }
  async saveLookup(actor: Actor, eventId: string, selector: string, destination: string): Promise<string> {
    const result = await this.sql.query(`INSERT INTO documentation_lookups(id,team,owner,channel,event_id,selector,destination)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner,event_id) DO UPDATE SET event_id=excluded.event_id RETURNING id`,
    [uid(), actor.team, ownerKey(actor), actor.channel, eventId, selector, destination]);
    return result.rows[0].id;
  }
  async savedLookup(actor: Actor, id: string): Promise<{ selector: string; destination: string } | undefined> {
    return (await this.sql.query(`SELECT selector,destination FROM documentation_lookups
      WHERE id=$1 AND team=$2 AND owner=$3 AND channel=$4 AND created_at>=now()-interval '30 days'`, [id, actor.team, ownerKey(actor), actor.channel])).rows[0];
  }
  async history(actor: Actor, id: string | null, requestedPage = 0) {
    const total = Number((await this.sql.query('SELECT count(*) AS total FROM documentation_history WHERE team=$1 AND ($2::text IS NULL OR project_id=$2)', [actor.team, id])).rows[0].total);
    const pages = Math.max(1, total), page = Math.min(requestedPage, pages - 1);
    const changes = (await this.sql.query(`SELECT project_id,actor,source,before_values,after_values,changed_at FROM documentation_history
      WHERE team=$1 AND ($2::text IS NULL OR project_id=$2) ORDER BY changed_at,id LIMIT 1 OFFSET $3`, [actor.team, id, page])).rows;
    return { changes, total, page, pages };
  }
  async claimDelivery(actor: Actor, eventId: string) {
    return (await this.sql.query('INSERT INTO documentation_deliveries(owner,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id', [ownerKey(actor), eventId])).rows.length > 0;
  }
  async releaseDelivery(actor: Actor, eventId: string) {
    await this.sql.query('DELETE FROM documentation_deliveries WHERE owner=$1 AND event_id=$2', [ownerKey(actor), eventId]);
  }
  async cleanup() {
    await this.sql.query(`DELETE FROM documentation_deliveries d WHERE created_at<now()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.id=d.event_id AND j.owner=d.owner AND j.module='documentation' AND j.status IN ('queued','running'))`);
    await this.sql.query(`DELETE FROM documentation_confirmations c WHERE created_at<now()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner=c.owner AND j.module='documentation' AND j.status IN ('queued','running'))`);
    await this.sql.query(`DELETE FROM documentation_lookups l WHERE created_at<now()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner=l.owner AND j.module='documentation' AND j.status IN ('queued','running'))`);
  }
}
