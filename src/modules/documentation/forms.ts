import { isDeepStrictEqual } from 'node:util';
import { GuidedForms, type FormDefinition, type FormField, type FormValues, type SavedForm } from '../../core/forms.js';
import type { Actor } from '../../core/identity.js';
import type { Sql } from '../../core/store.js';
import { projectFields, projectEdit, recordSchemas, recordTitle, type InventoryValues, type RecordKind } from './domain.js';
import type { DocumentationStore } from './store.js';

type Kind = 'project' | RecordKind;
export type InventoryFormResult = { command: string };
const labels: Record<string, string> = { name: 'Nom', aliases: 'Autres noms — un par ligne', description: 'Description', repositories: 'Dépôts', documentationLinks: 'Documentation', notes: 'Notes', category: 'Catégorie', type: 'Type', technologies: 'Technologies', projectId: 'Projet', role: 'Rôle', monthlyCost: 'Coût mensuel', currency: 'Devise (EUR, USD…)', environment: 'Environnement', componentId: 'Composant', serviceId: 'Hébergeur/service', accountReference: 'Référence du compte', urls: 'Adresses', accessInstructions: 'Instructions d’accès', usage: 'Utilisation', referent: 'Référent', companyWide: 'Utilisé dans toute l’entreprise', projects: 'Projets utilisateurs' };
const keys: Record<Kind, string[]> = {
  project: ['name', 'aliases', 'description', 'repositories', 'documentationLinks', 'notes'],
  technology: ['name', 'category', 'notes'], component: ['name', 'projectId', 'type', 'technologies'],
  host: ['name', 'role', 'monthlyCost', 'currency', 'notes'],
  hosting: ['componentId', 'environment', 'serviceId', 'accountReference', 'urls', 'accessInstructions', 'notes'],
  tool: ['name', 'category', 'usage', 'referent', 'companyWide', 'projects', 'notes'],
};
const references: Record<string, Kind> = { projectId: 'project', componentId: 'component', serviceId: 'host', technologies: 'technology', projects: 'project' };
const lists = new Set(['aliases', 'repositories', 'documentationLinks', 'urls']);
const urls = new Set(['repositories', 'documentationLinks', 'urls']);

export function inventoryFormDestination(page: string): string | undefined {
  if (page === 'add') return 'create:project';
  const add = /^add(technology|host|tool|component|hosting)(?:_([^_]+))?$/.exec(page);
  if (add) return `create:${add[1]}${add[2] ? `:${add[2]}` : ''}`;
  const edit = /^edit(technology|host|tool|component|hosting)?_([^_]+)$/.exec(page);
  if (edit) return `edit:${edit[1] ?? 'project'}:${edit[2]}`;
}

export class InventoryForms extends GuidedForms<InventoryFormResult> {
  constructor(private database: Sql, private store: DocumentationStore, token: string) { super(database, 'documentation', token, validate); }
  async definition(actor: Actor, destination: string): Promise<FormDefinition | undefined> {
    const match = /^(create|edit):(project|technology|component|host|hosting|tool)(?::([\w-]+))?$/.exec(destination);
    if (!match) return;
    const operation = match[1]!, kind = match[2] as Kind, target = match[3];
    const record = operation === 'edit' && target ? kind === 'project' ? await this.store.project(actor, target) : await this.store.record(actor, kind, target) : undefined;
    if (operation === 'edit' && (!record || record.archived)) return;
    const base = (record?.fields ?? {}) as InventoryValues;
    const defaults: InventoryValues = { ...base, ...(operation === 'create' && target ? { [kind === 'component' ? 'projectId' : 'componentId']: target } : {}) };
    const fields: FormField[] = [];
    for (const key of keys[kind]) {
      if (operation === 'edit' && ['projectId', 'componentId'].includes(key)) continue;
      const initial = defaults[key];
      const field: FormField = { key, label: labels[key]!, required: ['name', 'projectId', 'componentId', 'serviceId'].includes(key), max: ['name', 'category', 'type', 'role', 'environment'].includes(key) ? 120 : 1500 };
      if (key === 'currency') field.max = 3;
      if (key === 'monthlyCost') field.max = 30;
      if (references[key]) {
        const reference = references[key]!;
        const rows = reference === 'project'
          ? (await this.database.query('SELECT id,fields,archived FROM documentation_projects WHERE team=$1 ORDER BY fields->>\'name\',id', [actor.team])).rows
          : (await this.database.query("SELECT r.id,r.fields,r.archived,p.fields->>'name' AS parent FROM documentation_records r LEFT JOIN documentation_projects p ON p.team=r.team AND p.id=r.parent_id WHERE r.team=$1 AND r.kind=$2 ORDER BY r.fields->>'name',r.id", [actor.team, reference])).rows;
        field.kind = ['projects', 'technologies'].includes(key) ? 'choices' : 'choice';
        field.limit = key === 'projects' ? 20 : 50;
        field.choices = rows.filter(row => !row.archived || initial === row.id || (Array.isArray(initial) && initial.includes(row.id))).map(row => ({ value: row.id, label: `${`${row.fields.name}${row.parent ? ` / ${row.parent}` : ''}`.slice(0, row.archived ? 53 : 63)}${row.archived ? ' (archivé)' : ''} · ${row.id.slice(0, 8)}` }));
        field.initial = Array.isArray(initial) || typeof initial === 'string' ? initial : null;
      } else if (key === 'companyWide') {
        field.kind = 'choice'; field.choices = [{ label: 'Oui', value: 'true' }, { label: 'Non', value: 'false' }]; field.initial = typeof initial === 'boolean' ? String(initial) : null;
      } else if (urls.has(key)) {
        // Two optional lists cover the full ten-URL domain limit without truncation.
        const groups: string[][] = [[], []];
        for (const url of Array.isArray(initial) ? initial : []) groups[!groups[1]!.length && groups[0]!.join('\n').length + url.length + 1 <= 2000 ? 0 : 1]!.push(url);
        for (let index = 0; index < 2; index++) fields.push({ key: `${key}_${index}`, label: `${labels[key]}${index ? ' — suite (facultatif)' : ''}`, kind: 'lines', max: 3000, initial: groups[index]!.join('\n'), hint: 'Une URL HTTP(S) par ligne, 10 liens maximum au total. Videz les champs pour retirer les liens.' });
        continue;
      } else {
        field.kind = lists.has(key) || field.max === 1500 ? 'lines' : 'text';
        field.max = key === 'aliases' ? 2500 : field.max;
        field.initial = Array.isArray(initial) ? initial.join('\n') : initial == null ? '' : String(initial);
      }
      fields.push(field);
    }
    return { title: `${operation === 'edit' ? 'Modifier' : 'Créer'} ${recordTitle(kind).toLowerCase()}`, fields, context: { kind, operation, target, base } };
  }
}

function validate(form: SavedForm<InventoryFormResult>, values: FormValues) {
  const { kind, operation, target, base } = form.definition.context as { kind: Kind; operation: 'create' | 'edit'; target?: string; base: InventoryValues };
  const fields: InventoryValues = {};
  for (const key of keys[kind]) {
    if (operation === 'edit' && ['projectId', 'componentId'].includes(key)) continue;
    const value = values[key];
    const inputs = form.definition.fields.filter(field => field.key === key || (urls.has(key) && field.key.startsWith(`${key}_`)));
    if (operation === 'edit' && inputs.every(field => isDeepStrictEqual(values[field.key], field.initial ?? (field.kind === 'choices' ? [] : '')))) continue;
    let parsed: InventoryValues[string];
    if (urls.has(key)) parsed = [0, 1].flatMap(index => String(values[`${key}_${index}`] ?? '').split(/\r?\n/)).map(line => line.trim()).filter(Boolean);
    else if (Array.isArray(value)) parsed = value;
    else if (lists.has(key)) parsed = String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    else if (key === 'companyWide') parsed = value ? value === 'true' : null;
    else if (key === 'monthlyCost') parsed = value?.trim() ? Number(value.trim().replace(',', '.')) : null;
    else parsed = typeof value === 'string' && value.length ? value : null;
    if (Array.isArray(parsed) && !parsed.length && base[key] !== undefined && base[key] !== null) parsed = [];
    else if (Array.isArray(parsed) && !parsed.length) parsed = null;
    if (operation === 'edit' && isDeepStrictEqual(parsed, base[key])) continue;
    fields[key] = parsed;
  }
  const schema = kind === 'project' ? { create: projectFields, edit: projectEdit } : recordSchemas[kind];
  const checked = schema[operation].safeParse(fields);
  if (!checked.success) return { errors: Object.fromEntries(checked.error.issues.map(issue => {
    const key = String(issue.path[0] ?? form.definition.fields[0]!.key);
    return [urls.has(key) ? `${key}_0` : key, Object.keys(fields).length ? 'Valeur invalide : vérifiez le format, les limites et les champs requis.' : 'Aucune valeur modifiée. Fermez le formulaire ou modifiez un champ.'];
  })) };
  if (kind === 'host' && !recordSchemas.host.create.safeParse({ ...base, ...checked.data }).success) return { errors: { currency: 'Un coût mensuel nécessite une devise à trois lettres.' } };
  return { data: { command: `${operation} ${kind} ${operation === 'edit' ? `${target} ` : ''}${JSON.stringify(checked.data)}` } };
}
