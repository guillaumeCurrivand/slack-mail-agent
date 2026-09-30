import { BudgetExceeded } from '../../core/budget.js';
import { ownerKey, uid, type Actor } from '../../core/identity.js';
import type { JobPayload, ModuleContext } from '../../core/modules.js';
import type { MenuPage } from '../../core/navigation.js';
import type { Sql } from '../../core/store.js';
import { escapeCardValue } from '../../core/slack.js';
import { interpretQuestion, questionPlan, type QuestionAIConfig, type QuestionPlan } from './ai.js';
import { inventoryText, hostingEntryText } from './catalog.js';
import { referenceLabel, statusText } from './lifecycle.js';
import { DocumentationStore } from './store.js';

export const questionSchema = `
CREATE TABLE IF NOT EXISTS documentation_project_context (
 owner text NOT NULL, channel text NOT NULL, team text NOT NULL, project_id text NOT NULL,
 selected_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,channel)
);
CREATE TABLE IF NOT EXISTS documentation_questions (
 id text PRIMARY KEY, team text NOT NULL, owner text NOT NULL, channel text NOT NULL, event_id text NOT NULL,
 status text NOT NULL DEFAULT 'started', reservation_id text, plan jsonb, project_id text, candidates jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,event_id)
);`;
type SavedQuestion = { id: string; status: string; plan: QuestionPlan | null; project_id: string | null; candidates: string[] | null; created_at: Date | string };
const fallback = 'Natural-language interpretation is unavailable. Free paths remain available: Menu → Documentation; documentation projects; documentation project <identifier, exact name or alias>; documentation help for structured editing; documentation history. Saved links have not been read.';
const literal = escapeCardValue;
export class ProjectQuestions {
  private store: DocumentationStore;
  constructor(private sql: Sql, private config: QuestionAIConfig) { this.store = new DocumentationStore(sql); }
  async remember(actor: Actor, projectId: string) {
    await this.sql.query(`INSERT INTO documentation_project_context(owner,channel,team,project_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(owner,channel) DO UPDATE SET project_id=excluded.project_id,selected_at=now()`, [ownerKey(actor), actor.channel, actor.team, projectId]);
  }
  private async saved(actor: Actor, id: string): Promise<SavedQuestion | undefined> {
    return (await this.sql.query(`SELECT * FROM documentation_questions WHERE id=$1 AND team=$2 AND owner=$3 AND channel=$4
      AND created_at>=now()-interval '30 days'`, [id, actor.team, ownerKey(actor), actor.channel])).rows[0];
  }
  async ask(actor: Actor, question: string, eventId: string, context: ModuleContext): Promise<string | MenuPage> {
    const inserted = await this.sql.query(`INSERT INTO documentation_questions(id,team,owner,channel,event_id) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(owner,event_id) DO NOTHING RETURNING id`, [uid(), actor.team, ownerKey(actor), actor.channel, eventId]);
    let saved: SavedQuestion = (await this.sql.query('SELECT * FROM documentation_questions WHERE owner=$1 AND channel=$2 AND event_id=$3', [ownerKey(actor), actor.channel, eventId])).rows[0];
    if (!saved.plan) {
      if (!inserted.rows.length) return { kind: 'Question unavailable', text: `${fallback}\nThis request has an unavailable or uncertain attempt; it will not be paid for again automatically.` };
      try {
        if (!this.config.key) throw new Error('No API key');
        const plan = await interpretQuestion(this.config, actor, question, context.budget, async id => {
          await this.sql.query('UPDATE documentation_questions SET reservation_id=$2 WHERE id=$1', [saved.id, id]);
        });
        await this.sql.query("UPDATE documentation_questions SET plan=$2,status='interpreted' WHERE id=$1", [saved.id, JSON.stringify(plan)]);
        saved = { ...saved, plan };
      } catch (error) {
        const reason = error instanceof BudgetExceeded ? 'The shared AI allowance is exhausted or reserved.' : 'The API key, provider or validated interpretation is unavailable; uncertain spending stays reserved.';
        await this.sql.query("UPDATE documentation_questions SET status='unavailable' WHERE id=$1", [saved.id]);
        return { kind: 'Question unavailable', text: `${reason}\n${fallback}` };
      }
    }
    const plan = questionPlan.parse(saved.plan);
    if (plan.operation === 'clarify') return { kind: 'Clarify question', text: 'Which Project and relationship? Ask documentation where is <Project> hosted? or documentation which technologies does <Project> use? Nothing has been selected.' };
    if (plan.operation === 'unsupported') return { kind: 'Unsupported question', text: 'Ask where one Project is hosted or which Technologies it uses. Filters, counts and natural-language mutations are later slices. Use documentation help for free structured commands.' };
    if (!saved.project_id && !saved.candidates) {
      let projectId: string | undefined;
      if (plan.selector) {
        const matches = await this.store.lookup(actor, plan.selector);
        if (!matches.total) return { kind: 'Project not found', text: 'No Project matches that exact identifier, name or alias. Use documentation projects or documentation create project to propose a separate creation.' };
        if (matches.total > 1) {
          // Save every candidate identifier, not a guessed first page.
          const ids = matches.projects.map(p => p.id);
          for (let page = 1; page < matches.pages; page++) ids.push(...(await this.store.projects(actor, page, plan.selector)).projects.map(p => p.id));
          await this.sql.query('UPDATE documentation_questions SET candidates=$2 WHERE id=$1', [saved.id, JSON.stringify(ids)]);
          await this.sql.query('DELETE FROM documentation_project_context WHERE owner=$1 AND channel=$2', [ownerKey(actor), actor.channel]);
          return `question_${saved.id}_0`;
        }
        projectId = matches.projects[0]!.id;
      } else {
        projectId = (await this.sql.query(`SELECT project_id FROM documentation_project_context WHERE owner=$1 AND channel=$2 AND team=$3
          AND selected_at>now()-interval '30 minutes' AND selected_at<=now()`, [ownerKey(actor), actor.channel, actor.team])).rows[0]?.project_id;
      }
      if (!projectId || !await this.store.project(actor, projectId)) return { kind: 'Choose a Project', text: 'Which Project? Your private Project context is missing or expired. Open documentation project <identifier, exact name or alias>, then repeat the question with the documentation prefix.' };
      await this.sql.query('UPDATE documentation_questions SET project_id=$2 WHERE id=$1 AND project_id IS NULL', [saved.id, projectId]);
      await this.remember(actor, projectId);
    }
    return `question_${saved.id}_0`;
  }
  async choose(actor: Actor, payload: JobPayload): Promise<string | MenuPage> {
    const match = typeof payload.value === 'string' ? /^([^|]+)\|([^|]+)$/.exec(payload.value) : null;
    const saved = match ? await this.saved(actor, match[1]!) : undefined;
    if (!saved || !saved.candidates?.includes(match![2]!) || new Date(saved.created_at).getTime() <= Date.now() - 30 * 60_000)
      return { kind: 'Choice unavailable', text: 'This choice is private to its User and DM or has expired. Repeat the documentation question.' };
    const id = saved.project_id ?? match![2]!;
    if (!await this.store.project(actor, id)) return { kind: 'Project unavailable', text: 'The selected Project no longer exists. Repeat the documentation question.' };
    await this.sql.query('UPDATE documentation_questions SET project_id=$2 WHERE id=$1 AND project_id IS NULL', [saved.id, id]);
    await this.remember(actor, id);
    return `question_${saved.id}_0`;
  }
  async page(actor: Actor, destination: string): Promise<MenuPage | undefined> {
    const match = /^question_([^_]+)_(\d{1,6})$/.exec(destination);
    if (!match) return;
    const saved = await this.saved(actor, match[1]!);
    if (!saved?.plan) return { kind: 'Question unavailable', text: fallback };
    if (!saved.project_id) {
      if (new Date(saved.created_at).getTime() <= Date.now() - 30 * 60_000) return { kind: 'Choice expired', text: 'Repeat the documentation question to get fresh choices.' };
      const ids = saved.candidates ?? [], pages = Math.max(1, Math.ceil(ids.length / 8)), page = Math.min(Number(match[2]), pages - 1);
      const projects = (await Promise.all(ids.slice(page * 8, page * 8 + 8).map(id => this.store.project(actor, id)))).filter(p => p !== undefined);
      return { kind: 'Choose a Project', text: `Ambiguous Project. Choose by identifier. No Project context has been established.\nChoices page ${page + 1}/${pages}\n${projects.map(p => `${literal(referenceLabel(p.fields.name, p))} (${p.id})`).join('\n')}`,
        buttons: projects.map(p => ({ label: referenceLabel(p.fields.name, p), action: 'choose_question_project', value: `${saved.id}|${p.id}` })), links: this.pagination(saved.id, page, pages) };
    }
    const project = await this.store.project(actor, saved.project_id);
    if (!project) return { kind: 'Project unavailable', text: 'That Project was not found. Use documentation projects.' };
    const plan = questionPlan.parse(saved.plan);
    const links = [{ label: 'Project details', page: `project_${project.id}` }];
    const resources = [...(project.fields.repositories ?? []).map(url => ({ label: 'Saved repository', url })), ...(project.fields.documentationLinks ?? []).map(url => ({ label: 'Saved documentation', url }))];
    let text = '', page = 0, pages = 1;
    if (plan.operation === 'hosting') {
      const result = await this.store.projectHosting(actor, project.id, Number(match[2]));
      page = result.page; pages = result.pages;
      text = result.entries.map(entry => {
        links.push({ label: `Component: ${entry.component_name}`, page: `component_${entry.component_id}` });
        if (entry.hosting_id) links.push({ label: `Hosting: ${entry.fields?.environment ?? 'Unknown'}`, page: `hosting_${entry.hosting_id}` });
        if (typeof entry.fields?.serviceId === 'string') links.push({ label: `Host/service: ${entry.service_name ?? 'Unknown'}`, page: `host_${entry.fields.serviceId}` });
        for (const url of Array.isArray(entry.fields?.urls) ? entry.fields.urls : []) resources.push({ label: 'Saved hosting URL', url });
        return hostingEntryText(entry);
      }).join('\n\n') || 'Components: Unknown\nHosting entries: Unknown';
    } else if (plan.operation === 'technologies') {
      const result = await this.sql.query(`SELECT id,fields,archived FROM documentation_records WHERE team=$1 AND kind='component' AND parent_id=$2 ORDER BY lower(fields->>'name'),id`, [actor.team, project.id]);
      pages = Math.max(1, Math.ceil(result.rows.length / 8)); page = Math.min(Number(match[2]), pages - 1);
      const chunks: string[] = [];
      for (const component of result.rows.slice(page * 8, page * 8 + 8)) {
        links.push({ label: `Component: ${component.fields.name}`, page: `component_${component.id}` });
        const technologies: string[] = [];
        for (const id of component.fields.technologies ?? []) {
          const technology = await this.store.record(actor, 'technology', id);
          technologies.push(technology ? `${literal(referenceLabel(String(technology.fields.name), technology))} (${id})\n${inventoryText(technology.fields)}` : `Unknown (${id})`);
          links.push({ label: `Technology: ${technology?.fields.name ?? 'Unknown'}`, page: `technology_${id}` });
        }
        chunks.push(`Component: ${literal(referenceLabel(component.fields.name, component))} (${component.id})\nType: ${literal(component.fields.type ?? 'Unknown')}\nTechnologies: ${component.fields.technologies === null ? 'Unknown' : technologies.length ? technologies.join('\n') : 'None recorded'}`);
      }
      text = chunks.join('\n\n') || 'Components: Unknown\nTechnologies: Unknown';
    }
    return { kind: 'Project answer', text: `Project: ${literal(project.fields.name)} (${project.id})\n${statusText(project)}\nSources: current inventory records. Saved links have not been read.\nAnswer page ${page + 1}/${pages} (this page only)\n${text}\nEvery typed follow-up needs the documentation prefix.`, resourceLinks: resources, links: [...this.pagination(saved.id, page, pages), ...links] };
  }
  private pagination(id: string, page: number, pages: number) {
    return [...(page > 0 ? [{ label: 'Previous', page: `question_${id}_${page - 1}` }] : []), ...(page + 1 < pages ? [{ label: 'Next', page: `question_${id}_${page + 1}` }] : [])];
  }
  async cleanup() {
    await this.sql.query(`DELETE FROM documentation_project_context WHERE selected_at<now()-interval '30 days'`);
    await this.sql.query(`DELETE FROM documentation_questions q WHERE created_at<now()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner=q.owner AND j.module='documentation' AND j.status IN ('queued','running'))`);
  }
}
