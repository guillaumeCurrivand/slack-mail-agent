import { ownerKey, uid, type Actor } from '../../core/identity.js';
import type { JobPayload } from '../../core/modules.js';
import type { MenuPage } from '../../core/navigation.js';
import type { Sql } from '../../core/store.js';
import { escapeCardValue, type MessageTable } from '../../core/slack.js';
import { questionPlan, type QuestionPlan } from './ai.js';
import { statusText } from './lifecycle.js';
import { DocumentationStore } from './store.js';
import { InventoryQueries, inventoryQuery, inventoryQueryHelp } from './inventory-query.js';
import { InventoryPresentation, pageLinks } from './presentation.js';

export const questionSchema = `
CREATE TABLE IF NOT EXISTS documentation_project_context (
 owner text NOT NULL, channel text NOT NULL, team text NOT NULL, project_id text NOT NULL,
 selected_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,channel)
);
CREATE TABLE IF NOT EXISTS documentation_questions (
 id text PRIMARY KEY, team text NOT NULL, owner text NOT NULL, channel text NOT NULL, event_id text NOT NULL,
 status text NOT NULL DEFAULT 'started', reservation_id text, plan jsonb, project_id text, candidates jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,event_id)
);
ALTER TABLE documentation_questions ADD COLUMN IF NOT EXISTS resolved_command text;`;
type SavedQuestion = { id: string; status: string; plan: QuestionPlan | null; project_id: string | null; candidates: string[] | null; created_at: Date | string; resolved_command: string | null };
const fallback = "L’interprétation en langage naturel est indisponible. Les parcours gratuits restent disponibles : Menu → Documentation ; documentation projets ; documentation projet <identifiant, nom exact ou alias> ; documentation aide pour les modifications structurées ; documentation historique. Les liens enregistrés n’ont pas été lus." + "\n" + inventoryQueryHelp;
const literal = escapeCardValue;
export class DocumentationQuestions {
  private store: DocumentationStore;
  constructor(private sql: Sql) { this.store = new DocumentationStore(sql); }
  async source(actor: Actor, eventId: string): Promise<string> {
    const saved = (await this.sql.query("SELECT id FROM documentation_questions WHERE team=$1 AND owner=$2 AND channel=$3 AND event_id=$4 AND plan->>'operation'='mutation'", [actor.team, ownerKey(actor), actor.channel, eventId])).rows[0];
    return saved ? 'Slack natural-language' : 'Slack structured';
  }
  async structured(actor: Actor, value: unknown, result: 'list' | 'count', eventId: string): Promise<string | MenuPage> {
    const existing = (await this.sql.query('SELECT id FROM documentation_questions WHERE owner=$1 AND channel=$2 AND event_id=$3', [ownerKey(actor), actor.channel, eventId])).rows[0];
    if (existing) return `question_${existing.id}_0`;
    const parsed = inventoryQuery.safeParse(value);
    if (!parsed.success) return { kind: "Requête d’inventaire invalide", text: inventoryQueryHelp };
    const query = { ...parsed.data, result };
    const validated = await new InventoryQueries(this.sql).validate(actor, query);
    if ('kind' in validated) return validated;
    const id = uid();
    await this.sql.query(`INSERT INTO documentation_questions(id,team,owner,channel,event_id,status,plan) VALUES($1,$2,$3,$4,$5,'validated',$6)`,
      [id, actor.team, ownerKey(actor), actor.channel, eventId, JSON.stringify({ operation: 'inventory', selector: null, query: validated })]);
    return `question_${id}_0`;
  }
  async remember(actor: Actor, projectId: string) {
    await this.sql.query(`INSERT INTO documentation_project_context(owner,channel,team,project_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(owner,channel) DO UPDATE SET project_id=excluded.project_id,selected_at=now()`, [ownerKey(actor), actor.channel, actor.team, projectId]);
  }
  private async saved(actor: Actor, id: string): Promise<SavedQuestion | undefined> {
    return (await this.sql.query(`SELECT * FROM documentation_questions WHERE id=$1 AND team=$2 AND owner=$3 AND channel=$4
      AND created_at>=now()-interval '30 days'`, [id, actor.team, ownerKey(actor), actor.channel])).rows[0];
  }
  async choose(actor: Actor, payload: JobPayload): Promise<string | MenuPage> {
    const match = typeof payload.value === 'string' ? /^([^|]+)\|([^|]+)$/.exec(payload.value) : null;
    const saved = match ? await this.saved(actor, match[1]!) : undefined;
    if (!saved || !saved.candidates?.includes(match![2]!) || new Date(saved.created_at).getTime() <= Date.now() - 30 * 60_000)
      return { kind: "Choix indisponible", text: "Ce choix est privé à son utilisateur et à sa conversation, ou a expiré. Répétez la question documentation." };
    const id = saved.project_id ?? match![2]!;
    if (!await this.store.project(actor, id)) return { kind: "Projet indisponible", text: 'Le projet sélectionné n’existe plus. Répétez la question documentation.' };
    await this.sql.query('UPDATE documentation_questions SET project_id=$2 WHERE id=$1 AND team=$3 AND owner=$4 AND channel=$5 AND project_id IS NULL', [saved.id, id, actor.team, ownerKey(actor), actor.channel]);
    await this.remember(actor, id);
    return `question_${saved.id}_0`;
  }
  async page(actor: Actor, destination: string): Promise<MenuPage | undefined> {
    const choice = /^questionchoice_([^_]+)_([^_]+)$/.exec(destination);
    if (choice) {
      const selected = await this.choose(actor, { value: `${choice[1]}|${choice[2]}` });
      return typeof selected === 'string' ? this.page(actor, selected) : selected;
    }
    const presentation = new InventoryPresentation(this.store, actor);
    const match = /^question(?:refs)?_([^_]+)_(?:([a-f0-9]{32})_)?(\d{1,6})$/.exec(destination);
    if (!match) return;
    const saved = await this.saved(actor, match[1]!);
    if (!saved?.plan) return { kind: "Question indisponible", text: fallback };
    const parsed = questionPlan.parse(saved.plan);
    if (parsed.operation === 'inventory' && parsed.query && saved.status === 'validated') {
      const result = await new InventoryQueries(this.sql).page(actor, parsed.query, Number(match[3]), match[2] ?? null);
      const references = result.content.links ?? [];
      const position = `${saved.id}_${result.fingerprint}_${result.page}`;
      if (destination.startsWith('questionrefs_') && references.length) {
        return { kind: 'Fiches des filtres', text: 'Ouvrez une fiche utilisée par cette requête.',
          table: { columns: ['Référence'], rows: references.map(ref => [ref.label]) }, recordChoices: references,
          links: [{ label: 'Retour aux résultats', page: 'question_' + position }] };
      }
      return { ...result.content, links: [...pageLinks(`question_${saved.id}_${result.fingerprint}`, result.page, result.pages),
        ...(references.length ? [{ label: 'Fiches des filtres', page: 'questionrefs_' + position }] : [])] };
    }
    if (!saved.project_id) {
      if (new Date(saved.created_at).getTime() <= Date.now() - 30 * 60_000) return { kind: "Choix expiré", text: "Répétez la question documentation pour obtenir de nouveaux choix." };
      const ids = saved.candidates ?? [], pages = Math.max(1, Math.ceil(ids.length / 40)), page = Math.min(Number(match[3]), pages - 1);
      const projects = (await Promise.all(ids.slice(page * 40, page * 40 + 40).map(id => this.store.project(actor, id)))).filter(p => p !== undefined);
      return { kind: "Choisir un projet", text: `Projet ambigu. Choisissez une fiche. Aucun contexte de projet n’a été établi.\nChoix — page ${page + 1}/${pages}`,
        ...await presentation.list(projects.map(project => ({ ...project, kind: 'project' as const })), projects.map(project => `questionchoice_${saved.id}_${project.id}`)), links: pageLinks(`question_${saved.id}`, page, pages) };
    }
    const project = await this.store.project(actor, saved.project_id);
    if (!project) return { kind: "Projet indisponible", text: "Ce projet est introuvable. Utilisez documentation projets." };
    const plan = questionPlan.parse(saved.plan);
    const links = [{ label: "Détails du projet", page: `project_${project.id}` }];
    const resources = [...(project.fields.repositories ?? []).map(url => ({ label: "Dépôt enregistré", url })), ...(project.fields.documentationLinks ?? []).map(url => ({ label: "Documentation enregistrée", url }))];
    let text = '', page = 0, pages = 1, table: MessageTable | undefined, recordChoices: MenuPage['recordChoices'];
    if (plan.operation === 'hosting') {
      const result = await this.store.projectHosting(actor, project.id, Number(match[3]));
      const view = await presentation.hosting(result.entries);
      table = view.table; recordChoices = view.recordChoices;
      page = result.page; pages = result.pages;
      if (result.entries.some(entry => !entry.hosting_id)) text = 'Hébergements : inconnus pour les composants sans hébergement enregistré.';
      if (!result.entries.length) text = "Composants : inconnus\nHébergements : inconnus";
    } else if (plan.operation === 'technologies') {
      const result = await this.sql.query(`SELECT id,fields,archived FROM documentation_records WHERE team=$1 AND kind='component' AND parent_id=$2 ORDER BY lower(fields->>'name'),id`, [actor.team, project.id]);
      pages = Math.max(1, Math.ceil(result.rows.length / 40)); page = Math.min(Number(match[3]), pages - 1);
      const view = await presentation.list(result.rows.slice(page * 40, page * 40 + 40).map(component => ({ ...component, kind: 'component' as const })));
      table = view.table; recordChoices = view.recordChoices;
      text = result.rows.length ? '' : "Composants : inconnus\nTechnologies : inconnues";
    }
    return { kind: "Réponse sur le projet", table, recordChoices, text: `Projet : ${literal(project.fields.name)}\n${statusText(project)}\nSources : fiches actuelles de l’inventaire. Les liens enregistrés n’ont pas été lus.\nRéponse — page ${page + 1}/${pages} (cette page uniquement)\n${text}\nChaque demande de suivi écrite doit commencer par documentation.`, resourceLinks: resources, links: [...pageLinks(`question_${saved.id}`, page, pages), ...links] };
  }
  async cleanup() {
    await this.sql.query(`DELETE FROM documentation_project_context WHERE selected_at<now()-interval '30 days'`);
    await this.sql.query(`DELETE FROM documentation_questions q WHERE created_at<now()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner=q.owner AND j.module='documentation' AND j.status IN ('queued','running'))`);
  }
}
