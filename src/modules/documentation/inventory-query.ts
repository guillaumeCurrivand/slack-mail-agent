import { formatDate, formatNumber } from '../../core/presentation.js';
import { z } from 'zod';
import type { Actor } from '../../core/identity.js';
import type { MenuPage } from '../../core/navigation.js';
import type { Sql } from '../../core/store.js';
import { escapeCardValue } from '../../core/slack.js';
import { recordTitle, type InventoryValues } from './domain.js';
import { referenceLabel } from './lifecycle.js';
import { InventoryPresentation } from './presentation.js';
import { DocumentationStore } from './store.js';

const kind = z.enum(['project', 'component', 'technology', 'host', 'hosting', 'tool']);
type Kind = z.infer<typeof kind>;
const selector = z.string().trim().min(1).max(120);
export const inventoryQuery = z.strictObject({
  target: kind,
  filters: z.array(z.strictObject({ kind, selector })).max(6).default([]),
  fields: z.array(z.strictObject({ field: z.string().min(1).max(40), value: z.union([z.string().max(120), z.number().finite(), z.boolean(), z.null()]) })).max(6).default([]),
  scope: z.enum(['project', 'same-component']).nullable().default(null),
  component: selector.nullable().default(null),
  environment: selector.nullable().default(null),
  includeArchived: z.boolean().default(false),
  result: z.enum(['list', 'count']).default('list'),
});
export type InventoryQuery = z.infer<typeof inventoryQuery>;
type Node = { id: string; kind: Kind; fields: InventoryValues; archived: boolean };
export const inventoryQueryHelp = "Requêtes gratuites : documentation rechercher <objet JSON> ou documentation compter <objet JSON>. Exemple : documentation rechercher {\"target\":\"project\",\"filters\":[{\"kind\":\"technology\",\"selector\":\"React\"}],\"fields\":[],\"scope\":\"project\",\"environment\":null,\"includeArchived\":false}. Les clés et valeurs d’énumération JSON restent techniques. target/kind : project, component, technology, host, hosting ou tool ; références exactes par identifiant ou nom (alias pour les projets). filters combine jusqu’à 6 relations explicites par ET ; scope distingue project (ensemble des composants) et same-component (un même composant). component peut désigner un composant exact. environment choisit un environnement d’hébergement exact. fields accepte jusqu’à 6 filtres sur les champs autorisés, par égalité exacte ; aucune relation n’est déduite d’un texte libre. includeArchived vaut false par défaut. Les totaux couvrent les correspondances distinctes enregistrées ; les relations inconnues ne prouvent pas une correspondance. Résultats par pages de 40 ; les sources des comptages couvrent les 40 premières correspondances. Les données sont relues à chaque page ; une modification de l’inventaire redémarre la consultation. Les liens enregistrés ne sont pas lus. Aucun appel IA.";

// The inventory relationship graph is a tree. Each read follows its unique
// simple path, never an arbitrary walk through shared catalogs into other Projects.
const neighbors: Record<Kind, Kind[]> = {
  project: ['component', 'tool'], component: ['project', 'technology', 'hosting'],
  technology: ['component'], hosting: ['component', 'host'], host: ['hosting'], tool: ['project'],
};
function path(from: Kind, to: Kind, visited: Kind[] = []): Kind[] | undefined {
  if (from === to) return [from];
  for (const next of neighbors[from].filter(next => !visited.includes(next))) {
    const rest = path(next, to, [...visited, from]);
    if (rest) return [from, ...rest];
  }
}
function edge(a: string, from: Kind, b: string, to: Kind): string {
  if (from === 'project' && to === 'component') return `${b}.fields->>'projectId'=${a}.id`;
  if (from === 'component' && to === 'technology') return `${a}.fields->'technologies' ? ${b}.id`;
  if (from === 'component' && to === 'hosting') return `${b}.fields->>'componentId'=${a}.id`;
  if (from === 'hosting' && to === 'host') return `${a}.fields->>'serviceId'=${b}.id`;
  if (from === 'project' && to === 'tool') return `${b}.fields->'projects' ? ${a}.id`;
  return edge(b, to, a, from);
}
const allowedFields: Record<Kind, string[]> = {
  project: ['name', 'description', 'notes'], component: ['name', 'type'],
  technology: ['name', 'category'], host: ['name', 'role', 'monthlyCost', 'currency'],
  hosting: ['environment', 'accountReference'], tool: ['name', 'category', 'companyWide', 'usage', 'referent'],
};

export class InventoryQueries {
  constructor(private sql: Sql) {}
  async validate(actor: Actor, input: InventoryQuery): Promise<InventoryQuery | MenuPage> {
    const query = inventoryQuery.parse(input);
    for (const filter of query.fields) {
      const expected = filter.field === 'companyWide' ? 'boolean' : filter.field === 'monthlyCost' ? 'number' : 'string';
      if (!allowedFields[query.target].includes(filter.field) || (filter.value !== null && typeof filter.value !== expected))
        return { kind: 'Filtre non pris en charge', text: `Champs exacts autorisés — ${recordTitle(query.target)}: ${allowedFields[query.target].join(', ')}. Une valeur inconnue doit être demandée explicitement avec null. Aucune requête n’a été exécutée.` };
    }
    if (query.target === 'project' && query.filters.some(f => f.kind === 'technology') && query.filters.some(f => ['host', 'hosting'].includes(f.kind)) && query.scope === null && !query.component)
      return { kind: 'Préciser le périmètre du filtre', text: "Les correspondances de technologie et d’hébergeur/service peuvent-elles concerner des composants distincts du projet, ou un même composant doit-il correspondre aux deux ? Répétez avec scope \"project\" ou \"same-component\", ou sélectionnez un composant exact. Aucune requête n’a été exécutée." };
    const selectors = [...query.filters, ...(query.component ? [{ kind: 'component' as const, selector: query.component }] : [])];
    const resolved: string[] = [];
    for (const filter of selectors) {
      const result = await this.sql.query(`WITH nodes AS (
        SELECT id,'project'::text AS kind,fields,archived FROM documentation_projects WHERE team=$1
        UNION ALL SELECT id,kind,fields,archived FROM documentation_records WHERE team=$1
      ) SELECT id FROM nodes WHERE kind=$2 AND ($4 OR NOT archived) AND
        (id=$3 OR (NOT EXISTS(SELECT 1 FROM nodes WHERE kind=$2 AND id=$3) AND
          (lower(fields->>'name')=lower($3) OR (kind='project' AND EXISTS(
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(NULLIF(fields->'aliases','null'::jsonb),'[]'::jsonb)) alias WHERE lower(alias)=lower($3))))))`,
      [actor.team, filter.kind, filter.selector, query.includeArchived]);
      if (result.rows.length !== 1) return { kind: result.rows.length ? 'Filtre ambigu' : "Filtre introuvable", text: `${recordTitle(filter.kind)} : référence ${escapeCardValue(filter.selector)} ${result.rows.length ? "correspond à plusieurs fiches. Répétez avec un identifiant stable." : "ne correspond à aucune fiche enregistrée admissible. Les références inconnues ou archivées ne sont pas comptées comme zéro correspondance ; vérifiez l’identifiant ou utilisez explicitement includeArchived."}` };
      resolved.push(result.rows[0].id);
    }
    return { ...query, filters: query.filters.map((filter, index) => ({ ...filter, selector: resolved[index]! })), component: query.component ? resolved.at(-1)! : null };
  }
  async page(actor: Actor, input: InventoryQuery, requestedPage: number, previousFingerprint: string | null): Promise<{ content: MenuPage; fingerprint: string; page: number; pages: number }> {
    const query = inventoryQuery.parse(input), values: unknown[] = [actor.team, query.includeArchived];
    const param = (value: unknown) => { values.push(value); return `$${values.length}`; };
    const environment = query.environment ? param(query.environment) : null;
    let sequence = 0;
    const walk = (from: Kind, root: string, to: Kind, condition: (alias: string) => string): string => {
      const route = path(from, to)!;
      const prefix = `walk${sequence++}`;
      const aliases = route.map((_, index) => index === 0 ? root : `${prefix}n${index}`);
      const conditions = route.map((kind, index) => `${aliases[index]}.kind='${kind}'`).slice(1);
      for (let i = 1; i < route.length; i++) conditions.push(edge(aliases[i - 1]!, route[i - 1]!, aliases[i]!, route[i]!));
      if (environment) route.forEach((kind, index) => { if (kind === 'hosting') conditions.push(`lower(${aliases[index]}.fields->>'environment')=lower(${environment})`); });
      conditions.push(condition(aliases.at(-1)!));
      return route.length === 1 ? `(${conditions.join(' AND ')})` : `EXISTS(SELECT 1 FROM ${aliases.slice(1).map(alias => `nodes ${alias}`).join(',')} WHERE ${conditions.join(' AND ')})`;
    };
    const relationConditions = (from: Kind, root: string) => query.filters.map(filter => {
      const id = param(filter.selector);
      return walk(from, root, filter.kind, alias => `${alias}.id=${id}`);
    });
    const anchored = query.scope === 'same-component' || query.component !== null;
    let relations: string[];
    if (anchored) {
      relations = [...relationConditions(query.target, 'r'), walk(query.target, 'r', 'component', alias => {
        const conditions = relationConditions('component', alias);
        if (query.component) conditions.push(`${alias}.id=${param(query.component)}`);
        if (environment) conditions.push(walk('component', alias, 'hosting', entry => `lower(${entry}.fields->>'environment')=lower(${environment})`));
        return conditions.join(' AND ') || 'true';
      })];
    } else {
      relations = relationConditions(query.target, 'r');
      if (environment) relations.push(walk(query.target, 'r', 'hosting', entry => `lower(${entry}.fields->>'environment')=lower(${environment})`));
    }
    for (const filter of query.fields) {
      const field = param(filter.field);
      relations.push(filter.value === null ? `(r.fields->${field} IS NULL OR r.fields->${field}='null'::jsonb)` :
        typeof filter.value === 'string' ? `lower(r.fields->>${field})=lower(${param(filter.value)})` : `r.fields->${field}=${param(JSON.stringify(filter.value))}::jsonb`);
    }
    const previous = param(previousFingerprint), requested = param(requestedPage);
    const sourceIds = param([...query.filters.map(filter => filter.selector), ...(query.component ? [query.component] : [])]);
    // Matches, total, state fingerprint, page clamp and saved values come from
    // one statement snapshot. An intervening edit restarts coverage at page one.
    const result = await this.sql.query(`WITH all_nodes AS MATERIALIZED (
      SELECT id,'project'::text AS kind,fields,archived FROM documentation_projects WHERE team=$1
      UNION ALL SELECT id,kind,fields,archived FROM documentation_records WHERE team=$1
    ), nodes AS MATERIALIZED (SELECT * FROM all_nodes WHERE $2 OR NOT archived),
    matches AS MATERIALIZED (SELECT r.* FROM nodes r WHERE r.kind='${query.target}' ${relations.length ? `AND ${relations.join(' AND ')}` : ''}),
    state AS (SELECT md5(COALESCE(jsonb_agg(to_jsonb(n) ORDER BY kind,id)::text,'[]')) AS fingerprint FROM all_nodes n),
    coverage AS (SELECT count(*)::int AS total,GREATEST(1,ceil(count(*)/40.0)::int) AS pages FROM matches),
    position AS (SELECT total,pages,fingerprint,CASE WHEN ${previous}::text IS NOT NULL AND fingerprint<>${previous} THEN 0 ELSE LEAST(${requested}::int,pages-1) END AS page FROM coverage CROSS JOIN state)
    SELECT *,clock_timestamp() AS read_at,COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY kind,id) FROM all_nodes n WHERE id=ANY(${sourceIds}::text[])),'[]'::jsonb) AS references,COALESCE((SELECT jsonb_agg(to_jsonb(selected)) FROM
      (SELECT * FROM matches ORDER BY lower(COALESCE(fields->>'name',fields->>'environment','')),id LIMIT 40 OFFSET (SELECT page*40 FROM position)) selected),'[]'::jsonb) AS records FROM position`, values);
    const row = result.rows[0], records: Node[] = row.records;
    const changed = previousFingerprint !== null && previousFingerprint !== row.fingerprint;
    const references: Node[] = row.references;
    const selectors: InventoryQuery['filters'] = [...query.filters, ...(query.component ? [{ kind: 'component' as const, selector: query.component }] : [])];
    const unavailable = selectors.find(filter => !references.some(record => record.id === filter.selector
      && record.kind === filter.kind && (query.includeArchived || !record.archived)));
    if (unavailable) return { fingerprint: row.fingerprint, page: 0, pages: 1,
      content: { kind: "Filtre introuvable", text: `${recordTitle(unavailable.kind)} : la référence ne correspond à aucune fiche enregistrée admissible. Les références inconnues ou archivées ne sont pas comptées comme zéro correspondance ; examinez la référence ou utilisez explicitement includeArchived.` } };
    const name = (record: Node) => String(record.fields.name ?? record.fields.environment ?? "Environnement inconnu");
    const criteria = [references.map(record => `${recordTitle(record.kind)}: ${referenceLabel(name(record), record)}`).join('; '),
      ...query.fields.map(filter => `${filter.field} = ${typeof filter.value === 'number' ? formatNumber(filter.value) : typeof filter.value === 'boolean' ? filter.value ? 'Oui' : 'Non' : String(filter.value ?? "Inconnu")}`),
      ...(query.scope ? [`Périmètre : ${query.scope === 'project' ? "sur les composants du projet" : "un composant"}`] : []),
      ...(query.environment ? [`Environnement : ${query.environment}`] : []), `Fiches archivées : ${query.includeArchived ? "incluses" : "exclues"}`].filter(Boolean).join('\n');
    const links = references.map(record => ({ label: referenceLabel(name(record), record), page: `${record.kind}_${record.id}` }));
    const header = `Sources : fiches actuelles de l’inventaire au ${formatDate(row.read_at)}. Les liens enregistrés n’ont pas été lus.\nFiltres :\n${escapeCardValue(criteria)}\n${changed ? "L’inventaire a changé depuis la page précédente. La consultation reprend à la page 1 ; les pages précédentes ne font pas partie de cette lecture.\n" : ''}Total de fiches correspondantes — ${recordTitle(query.target)} : ${row.total}\nLes totaux couvrent toutes les correspondances enregistrées distinctes, pas seulement cette page. Une relation inconnue ne prouve pas une correspondance ; un inventaire incomplet ne prouve pas une absence réelle.\n`;
    const coverage = `Résultats — page ${row.page + 1}/${row.pages} ; fiches ${row.total ? row.page * 40 + 1 : 0}–${Math.min(row.total, row.page * 40 + 40)} sur ${row.total}. Chaque page relit les données actuelles.\n`;
    return { fingerprint: row.fingerprint, page: row.page, pages: query.result === 'count' ? 1 : row.pages,
      content: { kind: "Réponse de l’inventaire",
        ...await new InventoryPresentation(new DocumentationStore(this.sql), actor).list(records), text: header + (query.result === 'count' ? "Comptage uniquement. Les sources donnent accès aux 40 premières correspondances au maximum ; utilisez rechercher pour toutes les correspondances." : coverage + (records.length ? '' : "Aucune correspondance enregistrée.")),
        links } };
  }
}
