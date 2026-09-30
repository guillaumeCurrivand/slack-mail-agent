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
  name: /\b(name|named|rename|call|called|nom|renomme)\b/i,
  aliases: /\b(alias|aliases|aka)\b/i,
  description: /\b(description|describe)\b/i,
  repositories: /\b(repository|repositories|repo|repos)\b/i,
  documentationLinks: /\b(documentation|docs)\b/i,
  notes: /\b(note|notes|comments?)\b/i,
  category: /\b(category|categorie|catégorie)\b/i,
  type: /\b(type|kind|frontend|backend|api)\b/i,
  technologies: /\b(technology|technologies|using|uses?|stack|utilise)\b/i,
  serviceId: /\b(host|service|provider|on)\b/i,
  projects: /\b(projects?|projets?|link|linked)\b/i,
  role: /\b(role|rôle)\b/i,
  monthlyCost: /\b(cost|costing|price|monthly|coût)\b/i,
  currency: /\b(currency|devise)\b/i,
  environment: /\b(environment|environnement|production|staging)\b/i,
  accountReference: /\b(account|compte)\b/i,
  urls: /\b(urls?|links?|liens?)\b/i,
  accessInstructions: /\b(access|instructions|accès)\b/i,
  usage: /\b(usage|use|used)\b/i,
  referent: /\b(referent|référent|contact)\b/i,
  companyWide: /\b(company[- ]wide|whole company|project[- ]only|global)\b/i,
};

/** Resolves data into the existing structured proposal path; never commits inventory. */
export async function resolveMutation(sql: Sql, actor: Actor, plan: MutationPlan, request: string): Promise<ResolvedMutation | MenuPage> {
  const store = new DocumentationStore(sql);
  const schema = plan.kind === 'project' ? (plan.operation === 'create' ? projectFields : projectEdit) : recordSchemas[plan.kind][plan.operation === 'create' ? 'create' : 'edit'];
  const clarification = (text: string): MenuPage => ({ kind: 'Clarify inventory change', text: `${escapeCardValue(text)} Nothing was proposed or changed.\nAllowed ${recordTitle(plan.kind)} fields: ${Object.keys(schema.shape).join(', ')}. Use documentation help for constraints and structured alternatives.` });
  function checkScope(values: string[]) {
    let scope = request.toLowerCase();
    // Literal replacement text and exact record names cannot authorize actions.
    for (const value of [...values, plan.selector ?? ''].filter(Boolean).sort((a, b) => b.length - a.length)) scope = scope.replace(literalPattern(value), ' ');
    if (/\b(?:all|every|multiple|both|several|two|three)\s+(?:projects?|components?|technolog(?:y|ies)|hosts?|hosting entries|tools?|records?)\b/.test(scope)
      || /\b(?:create|add|edit|update|change|archive|restore)\s+(?:projects|components|technologies|hosts|hosting entries|tools|records)\b/.test(scope))
      throw new MutationClarification('Choose one individual-record operation instead of a bulk change.');
    const conjunctions = [...scope.matchAll(/\b(?:and|or)\s+(?:(?:also|with)\s+)?(\S+)/g)];
    if (conjunctions.some(match => plan.operation === 'archive' || plan.operation === 'restore'
      || !/^(?:notes?|description|aliases?|category|type|technologies|using|projects?|linked|link|cost|currency|environment|account|urls?|access|instructions|usage|referent|company[- ]wide|repositories|repository|documentation|set|clear|remove)\b/i.test(match[1]!)))
      throw new MutationClarification('Choose one individual-record operation; additional targets or unclear combined changes require separate requests.');
    if (/\b(?:permanently?\s+delete|delete\s+permanently?|restore\b.*\b(?:history|previous values)|(?:add|create)\s+(?:a\s+)?(?:field|column)|password(?![- ]manager)|api key)\b/.test(scope))
      throw new MutationClarification('Permanent deletion, history-value restoration, schema changes and secrets are unsupported. Use references, access instructions or password-manager links.');
    return scope;
  }
  async function resolve(kind: MutationPlan['kind'], selector: string): Promise<string> {
    if (selector === 'this project') {
      if (kind !== 'project' || !/\b(this project|it)\b/i.test(request)) throw new MutationClarification('Specify an exact Project.');
      const id = (await sql.query(`SELECT project_id FROM documentation_project_context WHERE owner=$1 AND channel=$2 AND team=$3
        AND selected_at>now()-interval '30 minutes' AND selected_at<=now()`, [ownerKey(actor), actor.channel, actor.team])).rows[0]?.project_id;
      if (!id || !await store.project(actor, id)) throw new MutationClarification('Your private Project context is missing or expired. Specify an exact Project.');
      return id;
    }
    if (!literalPattern(selector).test(request)) throw new MutationClarification('Specify an explicit record reference.');
    const result = kind === 'project' ? await store.lookup(actor, selector) : await store.lookupRecord(actor, kind, selector);
    if (result.total !== 1) {
      if (kind === 'project' && result.total > 1) await sql.query('DELETE FROM documentation_project_context WHERE owner=$1 AND channel=$2', [ownerKey(actor), actor.channel]);
      throw new MutationClarification(result.total ? `${recordTitle(kind)} reference is ambiguous. Inspect the choices and repeat with one stable identifier.` : `${recordTitle(kind)} not found in this workspace. Create a missing record in a separate confirmed operation, then repeat.`);
    }
    return 'projects' in result ? result.projects[0]!.id : result.records[0]!.id;
  }
  try {
    let target: string | null = null;
    if (plan.operation === 'create') {
      if (plan.selector !== null) throw new MutationClarification('Creation must describe one new record.');
    } else {
      if (plan.selector === null && plan.kind !== 'project') throw new MutationClarification('Specify one exact target.');
      if (plan.selector === null && !/\b(this project|it)\b/i.test(request)) throw new MutationClarification('Specify one exact Project target.');
      target = await resolve(plan.kind, plan.selector ?? 'this project');
    }
    if (plan.operation === 'archive' || plan.operation === 'restore') {
      if (plan.fields !== null) throw new MutationClarification('Lifecycle changes cannot replace fields.');
      checkScope([]);
      return { command: `${plan.operation} ${plan.kind} ${target}`, projectId: plan.kind === 'project' ? target : null };
    }
    if (plan.fields === null) throw new MutationClarification('Specify the required fields or clear replacement values.');
    let raw: any;
    try { raw = JSON.parse(plan.fields); }
    catch { throw new MutationClarification('Specify one valid field object with clear replacement values.'); }
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new MutationClarification('Choose one individual-record operation with one field object.');
    const copiedText = Object.entries(raw).flatMap(([key, value]) => key === 'projectId' && value === 'this project' ? [] : typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    if (plan.kind === 'component' && plan.operation === 'create' && typeof raw.projectId === 'string') raw.projectId = await resolve('project', raw.projectId);
    if (plan.kind === 'hosting' && plan.operation === 'create' && typeof raw.componentId === 'string') raw.componentId = await resolve('component', raw.componentId);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new MutationClarification('Required information is missing, a value is invalid, or a field is unsupported. Only the fixed business fields are allowed; no secrets, schema changes or metadata edits.');
    const intentText = checkScope(copiedText);
    if (copiedText.some(value => value !== '' && !literalPattern(value).test(request))) throw new MutationClarification('Specify explicit replacement values; interpreted text must come from your request.');
    for (const [field, value] of Object.entries(raw)) {
      if (plan.operation === 'create' && (value === null || ['name', 'projectId', 'componentId', 'serviceId', 'currency'].includes(field))) continue;
      const selected = (text: string) => text.includes(field.toLowerCase()) || !!fieldIntent[field]?.test(text);
      if (plan.operation === 'edit' && !selected(intentText)) throw new MutationClarification(`Specify the selected ${field} field and its replacement explicitly.`);
      if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
        const explicit = intentText.split(/\b(?:and|or)\b|[,;]/).some(clause => selected(clause) && /\b(clear|remove|unset|unknown|empty|none|forget|efface|vide|inconnu)\b/i.test(clause));
        if (!explicit) throw new MutationClarification(`Specify an explicit clearing or empty-value instruction for ${field}.`);
      } else if (typeof value === 'number') {
        const numeric = String(value).replaceAll('.', '\\.');
        if (!new RegExp(`(?<![\\d.])${numeric}(?![\\d.])`).test(intentText)) throw new MutationClarification(`Specify the exact numeric replacement for ${field} using digits.`);
      } else if (typeof value === 'boolean') {
        const negative = /\b(not company[- ]wide|not global|project[- ]only|false)\b/i.test(intentText);
        const positive = /\b(company[- ]wide|whole company|global|true)\b/i.test(intentText);
        if (value ? !positive || negative : !negative) throw new MutationClarification(`Specify an explicit true/false replacement for ${field}.`);
      }
    }
    const fields: InventoryValues = parsed.data;
    for (const [field, kind] of [['technologies', 'technology'], ['projects', 'project']] as const) {
      if (Array.isArray(fields[field])) fields[field] = [...new Set(await Promise.all((fields[field] as string[]).map(selector => resolve(kind, selector))))];
    }
    if (typeof fields.serviceId === 'string') fields.serviceId = await resolve('host', fields.serviceId);
    if (JSON.stringify(fields).length > 5000) throw new MutationClarification('Resolved fields exceed the 5,000-character limit. Choose fewer fields.');
    return { command: `${plan.operation} ${plan.kind}${target ? ` ${target}` : ''} ${JSON.stringify(fields)}`, projectId: plan.kind === 'project' ? target : null };
  } catch (error) {
    if (!(error instanceof MutationClarification)) throw error;
    return clarification(error.message);
  }
}
