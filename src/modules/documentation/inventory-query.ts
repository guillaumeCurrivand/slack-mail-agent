import { z } from 'zod';
import type { Actor } from '../../core/identity.js';
import type { MenuPage } from '../../core/navigation.js';
import type { Sql } from '../../core/store.js';
import { escapeCardValue } from '../../core/slack.js';
import { recordTitle, type InventoryValues } from './domain.js';
import { referenceLabel } from './lifecycle.js';

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
export const inventoryQueryHelp = 'Free exact queries: documentation search {"target":"project","filters":[{"kind":"technology","selector":"React"},{"kind":"host","selector":"Compute"}],"scope":"project"}; documentation count with the same JSON. Targets: project, component, technology, host, hosting, tool. Filters use exact identifiers/names (Project aliases too). scope: project allows separate Components; same-component requires one Component. Optional component, environment, includeArchived, and fields:[{field,value}] use saved exact values; null explicitly finds Unknown. Company-wide Tools: target tool, fields:[{"field":"companyWide","value":true}]. Project-specific Tools use a project relationship filter. Missing/ambiguous references require clarification. Results page with free Previous/Next controls.';

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
        return { kind: 'Unsupported filter', text: `Supported exact fields for ${recordTitle(query.target)}: ${allowedFields[query.target].join(', ')}. Unknown is requested explicitly with null. Nothing was queried.` };
    }
    if (query.target === 'project' && query.filters.some(f => f.kind === 'technology') && query.filters.some(f => ['host', 'hosting'].includes(f.kind)) && query.scope === null && !query.component)
      return { kind: 'Clarify filter scope', text: 'May Technology and Host/service matches occur on separate Components of a Project, or must one Component match both? Repeat with scope "project" or "same-component", or select an exact Component. Nothing was queried.' };
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
      if (result.rows.length !== 1) return { kind: result.rows.length ? 'Ambiguous filter' : 'Filter not found', text: `${recordTitle(filter.kind)} selector ${escapeCardValue(filter.selector)} ${result.rows.length ? 'matches multiple records. Repeat with one stable identifier.' : 'does not match an eligible saved record. Unknown or archived references have not been counted as zero matches; check the identifier or explicitly includeArchived.'}` };
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
    coverage AS (SELECT count(*)::int AS total,GREATEST(1,ceil(count(*)/8.0)::int) AS pages FROM matches),
    position AS (SELECT total,pages,fingerprint,CASE WHEN ${previous}::text IS NOT NULL AND fingerprint<>${previous} THEN 0 ELSE LEAST(${requested}::int,pages-1) END AS page FROM coverage CROSS JOIN state)
    SELECT *,clock_timestamp() AS read_at,COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY kind,id) FROM all_nodes n WHERE id=ANY(${sourceIds}::text[])),'[]'::jsonb) AS references,COALESCE((SELECT jsonb_agg(to_jsonb(selected)) FROM
      (SELECT * FROM matches ORDER BY lower(COALESCE(fields->>'name',fields->>'environment','')),id LIMIT 8 OFFSET (SELECT page*8 FROM position)) selected),'[]'::jsonb) AS records FROM position`, values);
    const row = result.rows[0], records: Node[] = row.records;
    const changed = previousFingerprint !== null && previousFingerprint !== row.fingerprint;
    const references: Node[] = row.references;
    const name = (record: Node) => String(record.fields.name ?? record.fields.environment ?? 'Unknown environment');
    const criteria = [references.map(record => `${recordTitle(record.kind)}: ${referenceLabel(name(record), record)} (${record.id})`).join('; '),
      ...query.fields.map(filter => `${filter.field} = ${String(filter.value ?? 'Unknown')}`),
      ...(query.scope ? [`Scope: ${query.scope === 'project' ? 'across Project Components' : 'one Component'}`] : []),
      ...(query.environment ? [`Environment: ${query.environment}`] : []), `Archived records: ${query.includeArchived ? 'included' : 'excluded'}`].filter(Boolean).join('\n');
    const links = [...records, ...references].map(record => ({ label: referenceLabel(name(record), record), page: `${record.kind}_${record.id}` }));
    const resources = records.flatMap(record => ['repositories', 'documentationLinks', 'urls'].flatMap(field => Array.isArray(record.fields[field]) ? (record.fields[field] as string[]).map(url => ({ label: 'Saved record link', url })) : []));
    const identity = (record: Node) => `${recordTitle(record.kind)}: ${escapeCardValue(referenceLabel(name(record), record))} (${record.id})`;
    const header = `Sources: current inventory records at ${new Date(row.read_at).toISOString()}. Saved links have not been read.\nFilters:\n${escapeCardValue(criteria)}\n${changed ? 'Inventory changed since the previous page. Coverage restarted at page 1; earlier pages are not part of this read.\n' : ''}Total matching ${recordTitle(query.target)} records: ${row.total}\nCounts cover all distinct saved matches, not only this page. Unknown relationships are not evidence of a match; missing inventory is not evidence of real-world absence.\n`;
    const coverage = `Results page ${row.page + 1}/${row.pages}; records ${row.total ? row.page * 8 + 1 : 0}–${Math.min(row.total, row.page * 8 + 8)} of ${row.total}. Each page rereads current data.\n`;
    let summaries = records.map(record => `${identity(record)}\n${Object.entries(record.fields).filter(([field]) => allowedFields[record.kind].includes(field)).map(([field, value]) => {
      const text = String(value ?? 'Unknown');
      return `${field}: ${escapeCardValue(text.length > 180 ? `${text.slice(0, 180)}… [abbreviated; open record details]` : text)}`;
    }).join('\n')}`).join('\n\n') || 'No saved matches.';
    // Bound the complete escaped message, since literal markup doubles in size.
    // Identities and controls always fit; large field summaries move to details.
    if (header.length + coverage.length + summaries.length > 9500)
      summaries = records.map(record => `${identity(record)}\nSummary abbreviated; open record details for complete saved fields.`).join('\n\n');
    return { fingerprint: row.fingerprint, page: row.page, pages: query.result === 'count' ? 1 : row.pages,
      content: { kind: 'Inventory answer', text: header + (query.result === 'count' ? 'Count only. Source controls cover up to the first 8 matches; use search for all matches.' : coverage + summaries),
        links, resourceLinks: resources } };
  }
}
