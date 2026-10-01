import { z } from 'zod';
import { ownerKey, type Actor } from '../../core/identity.js';
import type { Sql } from '../../core/store.js';
import type { MenuPage } from '../../core/navigation.js';
import { escapeCardValue } from '../../core/slack.js';
import { projectFields, projectEdit, recordSchemas, recordTitle, type InventoryValues } from './domain.js';
import { DocumentationStore } from './store.js';

export const mutationPlan = z.strictObject({
  operation: z.enum(['create', 'edit', 'archive', 'restore']),
  kind: z.enum(['project', 'technology', 'component', 'host', 'hosting', 'tool']),
  selector: z.string().trim().min(1).max(120).nullable(),
  fields: z.string().max(8000).nullable(),
});
export type MutationPlan = z.infer<typeof mutationPlan>;
export type ResolvedMutation = { command: string; projectId: string | null };
class MutationClarification extends Error {}
const literalPattern = (value: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'giu');
const fieldIntent: Record<string, RegExp> = {
  name: /\b(name|named|rename|call|called|nom|renomme|renommer)\b/i,
  aliases: /\b(alias|aliases|aka)\b/i,
  description: /\b(description|describe)\b/i,
  repositories: /\b(repository|repositories|repo|repos|dépôt|dépôts|depot|depots)\b/i,
  documentationLinks: /\b(documentation|docs)\b/i,
  notes: /\b(note|notes|comments?)\b/i,
  category: /\b(category|categorie|catégorie)\b/i,
  type: /\b(type|kind|frontend|backend|api)\b/i,
  technologies: /\b(technology|technologies|using|uses?|stack|utilise)\b/i,
  serviceId: /\b(host|service|provider|on|hébergeur|hebergeur|fournisseur)\b/i,
  projects: /\b(projects?|projets?|link|linked)\b/i,
  role: /\b(role|rôle)\b/i,
  monthlyCost: /\b(cost|costing|price|monthly|coût|cout|prix|mensuel)\b/i,
  currency: /\b(currency|devise)\b/i,
  environment: /\b(environment|environnement|production|staging)\b/i,
  accountReference: /\b(account|compte)\b/i,
  urls: /\b(urls?|links?|liens?)\b/i,
  accessInstructions: /\b(access|instructions|accès)\b/i,
  usage: /\b(usage|use|used|utilisation|utilise|utiliser)\b/i,
  referent: /\b(referent|référent|contact)\b/i,
  companyWide: /\b(company[- ]wide|whole company|project[- ]only|global|toute l[’']entreprise|projet uniquement)\b/i,
};

/** Resolves data into the existing structured proposal path; never commits inventory. */
export async function resolveMutation(sql: Sql, actor: Actor, plan: MutationPlan, request: string): Promise<ResolvedMutation | MenuPage> {
  const store = new DocumentationStore(sql);
  const schema = plan.kind === 'project' ? (plan.operation === 'create' ? projectFields : projectEdit) : recordSchemas[plan.kind][plan.operation === 'create' ? 'create' : 'edit'];
  const clarification = (text: string): MenuPage => ({ kind: "Préciser la modification de l’inventaire", text: `${escapeCardValue(text)} Rien n’a été proposé ni modifié.\nChamps autorisés — ${recordTitle(plan.kind)} : ${Object.keys(schema.shape).join(', ')}. Utilisez documentation aide pour les contraintes et les commandes structurées.` });
  function checkScope(values: string[]) {
    let scope = request.toLowerCase();
    // Literal replacement text and exact record names cannot authorize actions.
    for (const value of [...values, plan.selector ?? ''].filter(Boolean).sort((a, b) => b.length - a.length)) scope = scope.replace(literalPattern(value), ' ');
    if (/\b(?:all|every|multiple|both|several|two|three)\s+(?:projects?|components?|technolog(?:y|ies)|hosts?|hosting entries|tools?|records?)\b/.test(scope)
      || /\b(?:create|add|edit|update|change|archive|restore)\s+(?:projects|components|technologies|hosts|hosting entries|tools|records)\b/.test(scope)
      || /\b(?:tous|toutes|plusieurs|deux|trois)\s+(?:(?:les|des)\s+)?(?:projets|composants|technologies|hébergeurs|hebergeurs|hébergements|hebergements|outils|fiches)\b/.test(scope)
      || /\b(?:créer|creer|ajouter|modifier|changer|archiver|restaurer)\s+(?:(?:les|des)\s+)?(?:projets|composants|technologies|hébergeurs|hebergeurs|hébergements|hebergements|outils|fiches)\b/.test(scope))
      throw new MutationClarification("Choisissez une opération sur une seule fiche plutôt qu’une modification groupée.");
    const conjunctions = [...scope.matchAll(/\b(?:and|or|et|ou)\s+(?:(?:also|with|aussi|avec)\s+)?(\S+)/g)];
    if (conjunctions.some(match => plan.operation === 'archive' || plan.operation === 'restore'
      || !/^(?:notes?|description|aliases?|category|catégorie|categorie|type|technologies|using|projects?|projets?|linked|link|cost|coût|cout|prix|currency|devise|environment|environnement|account|compte|urls?|liens?|access|accès|instructions|usage|utilisation|referent|référent|company[- ]wide|repositories|repository|dépôts?|documentation|set|clear|remove|effacer|vider|retirer)\b/i.test(match[1]!)))
      throw new MutationClarification("Choisissez une opération sur une seule fiche ; les autres cibles et les modifications combinées ambiguës nécessitent des demandes séparées.");
    if (/\b(?:permanently?\s+delete|delete\s+permanently?|restore\b.*\b(?:history|previous values)|(?:add|create)\s+(?:a\s+)?(?:field|column)|password(?![- ]manager)|api key)\b/.test(scope))
      throw new MutationClarification("La suppression définitive, la restauration de valeurs historiques, les changements de schéma et les secrets ne sont pas autorisés. Utilisez des références, instructions d’accès ou liens de gestionnaire de mots de passe.");
    if (/\b(?:supprimer\s+définitivement|suppression\s+définitive|restaurer\b.*\b(?:historique|anciennes valeurs)|(?:ajouter|créer)\s+(?:(?:un|une)\s+)?(?:champ|colonne)|clé\s+api)\b/.test(scope)
      || /mot de passe/.test(scope.replace(/gestionnaire de mots? de passe/g, ' ')))
      throw new MutationClarification("La suppression définitive, la restauration de valeurs historiques, les changements de schéma et les secrets ne sont pas autorisés. Utilisez des références, instructions d’accès ou liens de gestionnaire de mots de passe.");
    return scope;
  }
  async function resolve(kind: MutationPlan['kind'], selector: string): Promise<string> {
    if (selector === 'this project') {
      if (kind !== 'project' || !/\b(this project|it|ce projet)\b/i.test(request)) throw new MutationClarification("Indiquez un projet exact.");
      const id = (await sql.query(`SELECT project_id FROM documentation_project_context WHERE owner=$1 AND channel=$2 AND team=$3
        AND selected_at>now()-interval '30 minutes' AND selected_at<=now()`, [ownerKey(actor), actor.channel, actor.team])).rows[0]?.project_id;
      if (!id || !await store.project(actor, id)) throw new MutationClarification("Votre contexte de projet privé est absent ou expiré. Indiquez un projet exact.");
      return id;
    }
    if (!literalPattern(selector).test(request)) throw new MutationClarification("Indiquez une référence de fiche explicite.");
    const result = kind === 'project' ? await store.lookup(actor, selector) : await store.lookupRecord(actor, kind, selector);
    if (result.total !== 1) {
      if (kind === 'project' && result.total > 1) await sql.query('DELETE FROM documentation_project_context WHERE owner=$1 AND channel=$2', [ownerKey(actor), actor.channel]);
      throw new MutationClarification(result.total ? `${recordTitle(kind)} : référence ambiguë. Examinez les choix et répétez avec un identifiant stable.` : `${recordTitle(kind)} introuvable dans cet espace. Créez la fiche manquante dans une opération séparée confirmée, puis répétez.`);
    }
    return 'projects' in result ? result.projects[0]!.id : result.records[0]!.id;
  }
  try {
    let target: string | null = null;
    if (plan.operation === 'create') {
      if (plan.selector !== null) throw new MutationClarification("La création doit décrire une seule nouvelle fiche.");
    } else {
      if (plan.selector === null && plan.kind !== 'project') throw new MutationClarification("Indiquez une cible exacte.");
      if (plan.selector === null && !/\b(this project|it|ce projet)\b/i.test(request)) throw new MutationClarification("Indiquez un projet cible exact.");
      target = await resolve(plan.kind, plan.selector ?? 'this project');
    }
    if (plan.operation === 'archive' || plan.operation === 'restore') {
      if (plan.fields !== null) throw new MutationClarification("Les changements d’état ne peuvent pas remplacer les champs.");
      checkScope([]);
      return { command: `${plan.operation} ${plan.kind} ${target}`, projectId: plan.kind === 'project' ? target : null };
    }
    if (plan.fields === null) throw new MutationClarification("Indiquez les champs requis ou des valeurs de remplacement explicites.");
    let raw: any;
    try { raw = JSON.parse(plan.fields); }
    catch { throw new MutationClarification("Indiquez un objet de champs valide avec des valeurs de remplacement explicites."); }
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new MutationClarification("Choisissez une opération sur une seule fiche avec un objet de champs.");
    const copiedText = Object.entries(raw).flatMap(([key, value]) => key === 'projectId' && value === 'this project' ? [] : typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    if (plan.kind === 'component' && plan.operation === 'create' && typeof raw.projectId === 'string') raw.projectId = await resolve('project', raw.projectId);
    if (plan.kind === 'hosting' && plan.operation === 'create' && typeof raw.componentId === 'string') raw.componentId = await resolve('component', raw.componentId);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new MutationClarification("Une information requise manque, une valeur est invalide ou un champ n’est pas autorisé. Seuls les champs métier définis sont permis ; aucun secret, changement de schéma ou modification de métadonnées.");
    const intentText = checkScope(copiedText);
    if (copiedText.some(value => value !== '' && !literalPattern(value).test(request))) throw new MutationClarification("Indiquez des valeurs de remplacement explicites ; le texte interprété doit provenir de votre demande.");
    for (const [field, value] of Object.entries(raw)) {
      if (plan.operation === 'create' && (value === null || ['name', 'projectId', 'componentId', 'serviceId', 'currency'].includes(field))) continue;
      const selected = (text: string) => text.includes(field.toLowerCase()) || !!fieldIntent[field]?.test(text);
      if (plan.operation === 'edit' && !selected(intentText)) throw new MutationClarification(`Indiquez explicitement le champ ${field} et sa valeur de remplacement.`);
      if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
        const explicit = intentText.split(/\b(?:and|or|et|ou)\b|[,;]/).some(clause => selected(clause) && /\b(clear|remove|unset|unknown|empty|none|forget|efface|effacer|vide|vider|inconnu|retirer)\b/i.test(clause));
        if (!explicit) throw new MutationClarification(`Indiquez une instruction explicite d’effacement ou de valeur vide pour ${field}.`);
      } else if (typeof value === 'number') {
        const numeric = String(value).replaceAll('.', '[.,]');
        if (!new RegExp(`(?<![\\d.,])${numeric}(?![\\d.,])`).test(intentText)) throw new MutationClarification(`Indiquez la valeur numérique exacte de remplacement pour ${field} avec des chiffres.`);
      } else if (typeof value === 'boolean') {
        const negative = /\b(not company[- ]wide|not global|project[- ]only|false|faux|projet uniquement|pas global|pas (?:(?:pour|à) )?toute l[’']entreprise)\b/i.test(intentText);
        const positive = /\b(company[- ]wide|whole company|global|true|vrai|toute l[’']entreprise)\b/i.test(intentText);
        if (value ? !positive || negative : !negative) throw new MutationClarification(`Indiquez une valeur true/false explicite pour ${field}.`);
      }
    }
    const fields: InventoryValues = parsed.data;
    for (const [field, kind] of [['technologies', 'technology'], ['projects', 'project']] as const) {
      if (Array.isArray(fields[field])) fields[field] = [...new Set(await Promise.all((fields[field] as string[]).map(selector => resolve(kind, selector))))];
    }
    if (typeof fields.serviceId === 'string') fields.serviceId = await resolve('host', fields.serviceId);
    if (JSON.stringify(fields).length > 5000) throw new MutationClarification("Les champs résolus dépassent la limite de 5 000 caractères. Choisissez moins de champs.");
    return { command: `${plan.operation} ${plan.kind}${target ? ` ${target}` : ''} ${JSON.stringify(fields)}`, projectId: plan.kind === 'project' ? target : null };
  } catch (error) {
    if (!(error instanceof MutationClarification)) throw error;
    return clarification(error.message);
  }
}
