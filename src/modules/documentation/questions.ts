import { BudgetExceeded } from '../../core/budget.js';
import { ownerKey, uid, type Actor } from '../../core/identity.js';
import type { JobPayload, ModuleContext } from '../../core/modules.js';
import type { MenuPage } from '../../core/navigation.js';
import type { Sql } from '../../core/store.js';
import { escapeCardValue, type MessageTable } from '../../core/slack.js';
import { interpretQuestion, questionPlan, type QuestionAIConfig, type QuestionPlan } from './ai.js';
import { referenceLabel, statusText } from './lifecycle.js';
import { DocumentationStore } from './store.js';
import { InventoryQueries, inventoryQuery, inventoryQueryHelp, type InventoryQuery } from './inventory-query.js';
import { resolveMutation, type ResolvedMutation } from './mutations.js';
import { InventoryPresentation } from './presentation.js';

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
  constructor(private sql: Sql, private config: QuestionAIConfig) { this.store = new DocumentationStore(sql); }
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
  private async validateInventory(actor: Actor, saved: SavedQuestion, query: InventoryQuery): Promise<string | MenuPage> {
    if (saved.status === 'validated') return `question_${saved.id}_0`;
    const validated = await new InventoryQueries(this.sql).validate(actor, query);
    if ('kind' in validated) return validated;
    await this.sql.query("UPDATE documentation_questions SET plan=$2,status='validated' WHERE id=$1 AND team=$3 AND owner=$4 AND channel=$5", [saved.id, JSON.stringify({ operation: 'inventory', selector: null, query: validated }), actor.team, ownerKey(actor), actor.channel]);
    return `question_${saved.id}_0`;
  }
  async remember(actor: Actor, projectId: string) {
    await this.sql.query(`INSERT INTO documentation_project_context(owner,channel,team,project_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(owner,channel) DO UPDATE SET project_id=excluded.project_id,selected_at=now()`, [ownerKey(actor), actor.channel, actor.team, projectId]);
  }
  private async saved(actor: Actor, id: string): Promise<SavedQuestion | undefined> {
    return (await this.sql.query(`SELECT * FROM documentation_questions WHERE id=$1 AND team=$2 AND owner=$3 AND channel=$4
      AND created_at>=now()-interval '30 days'`, [id, actor.team, ownerKey(actor), actor.channel])).rows[0];
  }
  async ask(actor: Actor, question: string, eventId: string, context: ModuleContext): Promise<string | MenuPage | ResolvedMutation> {
    const inserted = await this.sql.query(`INSERT INTO documentation_questions(id,team,owner,channel,event_id) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(owner,event_id) DO NOTHING RETURNING id`, [uid(), actor.team, ownerKey(actor), actor.channel, eventId]);
    let saved: SavedQuestion = (await this.sql.query('SELECT * FROM documentation_questions WHERE owner=$1 AND channel=$2 AND event_id=$3', [ownerKey(actor), actor.channel, eventId])).rows[0];
    if (!saved.plan) {
      if (!inserted.rows.length) return { kind: "Question indisponible", text: `${fallback}\nCette demande a une tentative indisponible ou incertaine ; aucun nouvel appel payant ne sera lancé automatiquement.` };
      try {
        if (!this.config.key) throw new Error('No API key');
        const plan = await interpretQuestion(this.config, actor, question, context.budget, async id => {
          await this.sql.query('UPDATE documentation_questions SET reservation_id=$2 WHERE id=$1 AND team=$3 AND owner=$4 AND channel=$5', [saved.id, id, actor.team, ownerKey(actor), actor.channel]);
        });
        await this.sql.query("UPDATE documentation_questions SET plan=$2,status='interpreted' WHERE id=$1 AND team=$3 AND owner=$4 AND channel=$5", [saved.id, JSON.stringify(plan), actor.team, ownerKey(actor), actor.channel]);
        saved = { ...saved, plan };
      } catch (error) {
        const reason = error instanceof BudgetExceeded ? "Le budget d’IA partagé est épuisé ou réservé." : "La clé API, le fournisseur ou l’interprétation validée est indisponible ; les dépenses incertaines restent réservées.";
        await this.sql.query("UPDATE documentation_questions SET status='unavailable' WHERE id=$1 AND team=$2 AND owner=$3 AND channel=$4", [saved.id, actor.team, ownerKey(actor), actor.channel]);
        return { kind: "Question indisponible", text: `${reason}\n${fallback}` };
      }
    }
    const plan = questionPlan.parse(saved.plan);
    if (plan.operation === 'mutation' && plan.mutation) {
      if (saved.resolved_command) return { command: saved.resolved_command, projectId: saved.project_id };
      const result = await resolveMutation(this.sql, actor, plan.mutation, question);
      if ('command' in result) {
        await this.sql.query("UPDATE documentation_questions SET resolved_command=$2,project_id=$3,status='validated' WHERE id=$1 AND team=$4 AND owner=$5 AND channel=$6", [saved.id, result.command, result.projectId, actor.team, ownerKey(actor), actor.channel]);
        if (result.projectId) await this.remember(actor, result.projectId);
      }
      return result;
    }
    if (plan.operation === 'inventory' && plan.query) {
      const query = plan.query;
      if (saved.status !== 'validated' && query.filters.some(filter => filter.kind === 'project' && filter.selector === 'this project')) {
        const projectId = (await this.sql.query(`SELECT project_id FROM documentation_project_context WHERE owner=$1 AND channel=$2 AND team=$3 AND selected_at>now()-interval '30 minutes' AND selected_at<=now()`, [ownerKey(actor), actor.channel, actor.team])).rows[0]?.project_id;
        if (!projectId) return { kind: "Choisir un projet", text: "Votre contexte de projet privé est absent ou expiré. Répétez avec un identifiant de projet exact." };
        query.filters = query.filters.map(filter => filter.kind === 'project' && filter.selector === 'this project' ? { ...filter, selector: projectId } : filter);
      }
      return this.validateInventory(actor, saved, query);
    }
    if (plan.operation === 'clarify') return { kind: "Préciser la question", text: `Choisissez une opération sur une seule fiche, une cible exacte et des valeurs de remplacement explicites ou les champs de création requis. Les fiches manquantes exigent une création séparée confirmée. Pour consulter, précisez les relations et filtres exacts, notamment le périmètre des composants. Rien n’a été sélectionné ni modifié. Utilisez documentation aide pour les champs autorisés.\n${inventoryQueryHelp}` };
    if (plan.operation === 'unsupported') return { kind: "Question non prise en charge", text: `Utilisez les champs métier définis et une seule fiche par opération confirmée. Modifications groupées, changements de schéma, secrets, suppression définitive, restauration de valeurs historiques et contenus de documents ne sont pas disponibles. Les informations de compte et d’accès se limitent aux références, instructions et liens de gestionnaire de mots de passe. Utilisez documentation aide pour les champs autorisés.\n${inventoryQueryHelp}` };
    if (!saved.project_id && !saved.candidates) {
      let projectId: string | undefined;
      if (plan.selector) {
        const matches = await this.store.lookup(actor, plan.selector);
        if (!matches.total) return { kind: "Projet introuvable", text: "Aucun projet ne correspond exactement à cet identifiant, nom ou alias. Utilisez documentation projets ou documentation créer projet pour proposer une création séparée." };
        if (matches.total > 1) {
          // Save every candidate identifier, not a guessed first page.
          const ids = matches.projects.map(p => p.id);
          for (let page = 1; page < matches.pages; page++) ids.push(...(await this.store.projects(actor, page, plan.selector)).projects.map(p => p.id));
          await this.sql.query('UPDATE documentation_questions SET candidates=$2 WHERE id=$1 AND team=$3 AND owner=$4 AND channel=$5', [saved.id, JSON.stringify(ids), actor.team, ownerKey(actor), actor.channel]);
          await this.sql.query('DELETE FROM documentation_project_context WHERE owner=$1 AND channel=$2', [ownerKey(actor), actor.channel]);
          return `question_${saved.id}_0`;
        }
        projectId = matches.projects[0]!.id;
      } else {
        projectId = (await this.sql.query(`SELECT project_id FROM documentation_project_context WHERE owner=$1 AND channel=$2 AND team=$3
          AND selected_at>now()-interval '30 minutes' AND selected_at<=now()`, [ownerKey(actor), actor.channel, actor.team])).rows[0]?.project_id;
      }
      if (!projectId || !await this.store.project(actor, projectId)) return { kind: "Choisir un projet", text: "Quel projet ? Votre contexte de projet privé est absent ou expiré. Ouvrez documentation projet <identifiant, nom exact ou alias>, puis répétez la question avec le préfixe documentation." };
      await this.sql.query('UPDATE documentation_questions SET project_id=$2 WHERE id=$1 AND team=$3 AND owner=$4 AND channel=$5 AND project_id IS NULL', [saved.id, projectId, actor.team, ownerKey(actor), actor.channel]);
      await this.remember(actor, projectId);
    }
    return `question_${saved.id}_0`;
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
    const match = /^question_([^_]+)_(?:([a-f0-9]{32})_)?(\d{1,6})$/.exec(destination);
    if (!match) return;
    const saved = await this.saved(actor, match[1]!);
    if (!saved?.plan) return { kind: "Question indisponible", text: fallback };
    const parsed = questionPlan.parse(saved.plan);
    if (parsed.operation === 'inventory' && parsed.query && saved.status === 'validated') {
      const result = await new InventoryQueries(this.sql).page(actor, parsed.query, Number(match[3]), match[2] ?? null);
      return { ...result.content, links: [...this.pagination(`${saved.id}_${result.fingerprint}`, result.page, result.pages), ...(result.content.links ?? [])] };
    }
    if (!saved.project_id) {
      if (new Date(saved.created_at).getTime() <= Date.now() - 30 * 60_000) return { kind: "Choix expiré", text: "Répétez la question documentation pour obtenir de nouveaux choix." };
      const ids = saved.candidates ?? [], pages = Math.max(1, Math.ceil(ids.length / 40)), page = Math.min(Number(match[3]), pages - 1);
      const projects = (await Promise.all(ids.slice(page * 40, page * 40 + 40).map(id => this.store.project(actor, id)))).filter(p => p !== undefined);
      return { kind: "Choisir un projet", text: `Projet ambigu. Choisissez une fiche. Aucun contexte de projet n’a été établi.\nChoix — page ${page + 1}/${pages}`,
        ...await presentation.list(projects.map(project => ({ ...project, kind: 'project' as const })), projects.map(project => `questionchoice_${saved.id}_${project.id}`)), links: this.pagination(saved.id, page, pages) };
    }
    const project = await this.store.project(actor, saved.project_id);
    if (!project) return { kind: "Projet indisponible", text: "Ce projet est introuvable. Utilisez documentation projets." };
    const plan = questionPlan.parse(saved.plan);
    const links = [{ label: "Détails du projet", page: `project_${project.id}` }];
    const resources = [...(project.fields.repositories ?? []).map(url => ({ label: "Dépôt enregistré", url })), ...(project.fields.documentationLinks ?? []).map(url => ({ label: "Documentation enregistrée", url }))];
    let text = '', page = 0, pages = 1, table: MessageTable | undefined, recordChoices: MenuPage['recordChoices'];
    if (plan.operation === 'hosting') {
      const result = await this.store.projectHosting(actor, project.id, Number(match[3]));
      const view = await presentation.list(result.entries.filter(entry => entry.fields && entry.hosting_id).map(entry => ({ id: entry.hosting_id!, kind: 'hosting' as const, fields: entry.fields!, archived: !!entry.hosting_archived })));
      table = view.table; recordChoices = view.recordChoices;
      page = result.page; pages = result.pages;
      text = result.entries.filter(entry => !entry.hosting_id).map(entry => {
        if (!entry.hosting_id) links.push({ label: `Composant : ${entry.component_name}`, page: `component_${entry.component_id}` });
        return entry.hosting_id ? '' : `Composant : ${literal(entry.component_name)}\nHébergements : inconnus\nEnvironnement : inconnu\nHébergeur/service : inconnu`;
      }).join('\n\n');
      if (!result.entries.length) text = "Composants : inconnus\nHébergements : inconnus";
    } else if (plan.operation === 'technologies') {
      const result = await this.sql.query(`SELECT id,fields,archived FROM documentation_records WHERE team=$1 AND kind='component' AND parent_id=$2 ORDER BY lower(fields->>'name'),id`, [actor.team, project.id]);
      pages = Math.max(1, Math.ceil(result.rows.length / 40)); page = Math.min(Number(match[3]), pages - 1);
      const view = await presentation.list(result.rows.slice(page * 40, page * 40 + 40).map(component => ({ ...component, kind: 'component' as const })));
      table = view.table; recordChoices = view.recordChoices;
      text = result.rows.length ? '' : "Composants : inconnus\nTechnologies : inconnues";
    }
    return { kind: "Réponse sur le projet", table, recordChoices, text: `Projet : ${literal(project.fields.name)}\n${statusText(project)}\nSources : fiches actuelles de l’inventaire. Les liens enregistrés n’ont pas été lus.\nRéponse — page ${page + 1}/${pages} (cette page uniquement)\n${text}\nChaque demande de suivi écrite doit commencer par documentation.`, resourceLinks: resources, links: [...this.pagination(saved.id, page, pages), ...links] };
  }
  private pagination(id: string, page: number, pages: number) {
    return [...(page > 0 ? [{ label: "Précédent", page: `question_${id}_${page - 1}` }] : []), ...(page + 1 < pages ? [{ label: "Suivant", page: `question_${id}_${page + 1}` }] : [])];
  }
  async cleanup() {
    await this.sql.query(`DELETE FROM documentation_project_context WHERE selected_at<now()-interval '30 days'`);
    await this.sql.query(`DELETE FROM documentation_questions q WHERE created_at<now()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner=q.owner AND j.module='documentation' AND j.status IN ('queued','running'))`);
  }
}
