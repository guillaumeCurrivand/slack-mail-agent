import type { Actor } from '../../core/identity.js';
import type { MenuPage } from '../../core/navigation.js';
import { cellText, escapeCardValue, validResourceUrl, type MessageTable, type TableCell } from '../../core/slack.js';
import { recordTitle, type InventoryValues, type RecordKind } from './domain.js';
import type { Confirmation, DocumentationStore } from './store.js';
import { formatNumber } from '../../core/presentation.js';

type Kind = 'project' | RecordKind;
type RecordView = { id: string; kind: Kind; fields: InventoryValues; archived: boolean };
const labels: Record<string, string> = { name: "Nom", aliases: "Alias", description: "Description", repositories: "Dépôts", documentationLinks: "Liens de documentation", notes: "Notes", projectId: "Projet", type: "Type", technologies: "Technologies", componentId: "Composant", serviceId: "Hébergeur/service", environment: "Environnement", accountReference: "Référence du compte", urls: 'URLs', accessInstructions: "Instructions d’accès", category: "Catégorie", role: "Rôle", monthlyCost: "Coût mensuel", currency: "Devise", usage: "Utilisation", referent: "Référent", companyWide: "Toute l’entreprise", projects: "Projets", archived: "Archivé" };
const referenceKinds: Record<string, Kind> = { projectId: 'project', projects: 'project', componentId: 'component', serviceId: 'host', technologies: 'technology' };
const urlFields = new Set(['repositories', 'documentationLinks', 'urls']);
const title = (field: string) => labels[field] ?? field;
const abbreviation = (text: string, limit = 180) => text.length > limit ? `${text.slice(0, limit)}… [abrégé ; ouvrir les détails de la fiche]` : text;
export const tableSize = (table: MessageTable) => table.columns.join('').length + table.rows.flat().reduce((sum, cell) => sum + (typeof cell === 'string' ? cell.length : cell.reduce((n, part) => n + part.text.length + (part.url?.length ?? 0), 0)), 0);

/** Module-owned names, relationships and values. The transport only receives literal cells. */
export class InventoryPresentation {
  constructor(private store: DocumentationStore, private actor: Actor) {}
  private records = new Map<string, Promise<RecordView | undefined>>();
  record(kind: Kind, id: string): Promise<RecordView | undefined> {
    const key = `${kind}:${id}`;
    if (!this.records.has(key)) this.records.set(key, (kind === 'project' ? this.store.project(this.actor, id) : this.store.record(this.actor, kind, id)).then(record => record && { ...record, kind }));
    return this.records.get(key)!;
  }
  async name(kind: Kind, id: string, historical = false): Promise<string> {
    const record = await this.record(kind, id);
    if (!record) return "Fiche référencée indisponible";
    let name = String(record.fields.name ?? record.fields.environment ?? "Environnement inconnu") || "Environnement vide";
    if (kind === 'component') name = `${await this.name('project', String(record.fields.projectId))} / ${name}`;
    if (kind === 'hosting') name = `${await this.name('component', String(record.fields.componentId))} / ${name} / ${await this.name('host', String(record.fields.serviceId))}`;
    return `${name}${record.archived ? " [Archivé]" : ''}${historical ? " (nom actuel)" : ''}`;
  }
  private links(urls: string[], field: string, exact = false, summary = false): TableCell {
    if (!urls.length) return "Aucun élément enregistré";
    const parts = (summary ? urls.slice(0, 1) : urls).flatMap((url, index) => {
      let label = url;
      if (!exact && validResourceUrl(url)) { const parsed = new URL(url); label = `${field === 'repositories' ? "Dépôt" : field === 'documentationLinks' ? 'Documentation' : "Ouvrir"}: ${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`; }
      return [...(index ? [{ text: '\n' }] : []), { text: summary ? abbreviation(label, 100) : label, ...(validResourceUrl(url) ? { url } : {}) }];
    });
    return summary && urls.length > 1 ? [...parts, { text: `\n+ ${urls.length - 1} autres liens (ouvrir les détails de la fiche)` }] : parts;
  }
  async value(field: string, value: unknown, historical = false): Promise<TableCell> {
    if (value === null || value === undefined) return "Inconnu";
    if (referenceKinds[field]) {
      const refs = Array.isArray(value) ? value : [value];
      return refs.length ? (await Promise.all(refs.map(ref => this.name(referenceKinds[field]!, String(ref), historical)))).join('\n') : "Aucun élément enregistré";
    }
    if (urlFields.has(field) && Array.isArray(value)) return this.links(value, field, historical);
    if (Array.isArray(value)) return value.length ? value.join('\n') : "Aucun élément enregistré";
    if (value === '') return "(vide)";
    return typeof value === 'boolean' ? value ? 'Oui' : 'Non' : typeof value === 'number' ? formatNumber(value) : String(value);
  }
  async values(fields: InventoryValues, before?: InventoryValues | null, savedReferences = false): Promise<MessageTable> {
    const comparison = before !== undefined;
    const rows = await Promise.all(Object.entries(fields).map(async ([field, value]) => [title(field), ...(comparison ? [before === null ? "Aucune fiche" : await this.value(field, before[field], true)] : []), await this.value(field, value, comparison || savedReferences)]));
    return { columns: comparison ? ["Champ", "Avant", "Après"] : ["Champ", "Valeur"], rows };
  }
  async details(fields: InventoryValues): Promise<Pick<MenuPage, 'text' | 'table'>> {
    const short: InventoryValues = {}, paragraphs: string[] = [];
    for (const [field, value] of Object.entries(fields)) {
      if (typeof value === 'string' && value.length > 240 && !referenceKinds[field]) paragraphs.push(`*${title(field)}*\n${escapeCardValue(value)}`);
      else short[field] = value;
    }
    return { text: paragraphs.join('\n\n'), table: await this.values(short) };
  }
  async confirmation(saved: Confirmation): Promise<Pick<MenuPage, 'text' | 'table'>> {
    const table = await this.values(saved.fields, saved.operation === 'edit' ? saved.before_values : undefined, true);
    if (saved.operation === 'edit' && saved.before_values === null) table.rows = table.rows.map(row => [row[0]!, "Indisponible (valeurs d’origine non enregistrées)", row[2]!]);
    const text = saved.operation === 'edit' && saved.before_values === null ? "Avant : indisponible pour cette ancienne confirmation ; les valeurs d’origine n’ont pas été enregistrées." : '';
    return tableSize(table) > 8500 ? { text: `${text}\nLes valeurs enregistrées occupent plusieurs pages. Ouvrez Examiner les valeurs pour les consulter avant de confirmer.`.trim() } : { table, text };
  }
  async list(records: RecordView[], destinations?: string[], archived = false): Promise<Pick<MenuPage, 'table' | 'recordChoices'>> {
    if (!records.length) return { recordChoices: [] };
    const kind = records[0]?.kind ?? 'project';
    const fields: Record<Kind, string[]> = { project: ['name', 'description', 'links'], technology: ['name', 'category'], component: ['name', 'projectId', 'type', 'technologies'], host: ['name', 'role', 'cost'], hosting: ['environment', 'componentId', 'serviceId', 'urls'], tool: ['name', 'category', 'usedBy', 'referent'] };
    const columns = archived ? ["Type de fiche", "Nom", "Contexte"] : ({ project: ["Nom", "Description", "Liens"], technology: ["Nom", "Catégorie"], component: ["Nom", "Projet", "Type", "Technologies"], host: ["Nom", "Rôle", "Coût mensuel"], hosting: ["Environnement", "Projet / Composant", "Hébergeur/service", 'URLs'], tool: ["Nom", "Catégorie", "Utilisé par", "Référent"] })[kind];
    const rows = await Promise.all(records.map(async record => {
      if (archived) return [recordTitle(record.kind), `${String(record.fields.name ?? record.fields.environment ?? "Environnement inconnu")} [Archivé]`, await this.name(record.kind, record.id)];
      return Promise.all(fields[kind].map(async field => {
        if (field === 'links') {
          const urls = [...(record.fields.repositories as string[] ?? []), ...(record.fields.documentationLinks as string[] ?? [])];
          const unknown = record.fields.repositories == null || record.fields.documentationLinks == null;
          return urls.length ? this.links(urls, field, false, true) : unknown ? "Inconnu" : "Aucun élément enregistré";
        }
        if (field === 'urls') return record.fields.urls == null ? "Inconnu" : this.links(record.fields.urls as string[], field, false, true);
        if (field === 'cost') return record.fields.monthlyCost == null ? "Inconnu" : `${formatNumber(Number(record.fields.monthlyCost))} ${record.fields.currency}`;
        if (field === 'usedBy') return `${record.fields.companyWide === true ? "Toute l’entreprise\n" : record.fields.companyWide === null ? "Toute l’entreprise : inconnu\n" : ''}${cellText(await this.value('projects', record.fields.projects))}`;
        const value = await this.value(field, record.fields[field]);
        return typeof value === 'string' ? abbreviation(value) + ((field === 'name' || field === 'environment') && record.archived ? " [Archivé]" : '') : value;
      }));
    }));
    // Cap list summaries while keeping all eight records and every destination available.
    const table: MessageTable = { columns, rows };
    if (tableSize(table) > 8500) table.rows = rows.map(row => row.map(cell => typeof cell === 'string' ? abbreviation(cell, 100) : cell));
    const names = await Promise.all(records.map(record => this.name(record.kind, record.id)));
    const choices = names.map((name, index) => ({ label: `${index + 1}. ${name}`.slice(0, 75), page: destinations?.[index] ?? `${records[index]!.kind}_${records[index]!.id}` }));
    return { table, recordChoices: choices };
  }
}

/** Preserve complete cells even when two large relationship arrays exceed one table. */
export function valuePages(content: MenuPage): MenuPage[] {
  const textPages = [''];
  for (const line of content.text.split('\n')) {
    if (textPages.at(-1)!.length + line.length + 1 > 9500) textPages.push(line);
    else textPages[textPages.length - 1] += `${textPages.at(-1) ? '\n' : ''}${line}`;
  }
  if (!content.table) return textPages.map(text => ({ ...content, text }));
  const tables: MessageTable[] = [{ columns: content.table.columns, rows: [] }];
  for (const row of content.table.rows) {
    const chunks = row.map(cell => {
      if (typeof cell !== 'string') {
        const pieces: Array<Exclude<TableCell, string>> = [[]];
        for (const part of cell) {
          if (pieces.at(-1)!.reduce((sum, item) => sum + item.text.length + (item.url?.length ?? 0), 0) + part.text.length + (part.url?.length ?? 0) > 2800) pieces.push([]);
          pieces.at(-1)!.push(part);
        }
        return pieces;
      }
      const result: string[] = []; for (let i = 0; i < cell.length; i += 3000) result.push(cell.slice(i, i + 3000));
      return result.length ? result : [''];
    });
    const count = Math.max(...chunks.map(parts => parts.length));
    for (let i = 0; i < count; i++) {
      const piece = chunks.map((parts, index) => parts[i] ?? (index === 0 ? `${cellText(row[0]!)} (suite)` : ''));
      if (tableSize({ ...tables.at(-1)!, rows: [...tables.at(-1)!.rows, piece] }) > 8500) tables.push({ columns: content.table.columns, rows: [] });
      tables.at(-1)!.rows.push(piece);
    }
  }
  return Array.from({ length: Math.max(textPages.length, tables.length) }, (_, index) => ({ ...content, text: textPages[index] ?? "Valeurs enregistrées complètes (suite).", table: tables[index] }));
}

const operations: Record<string, string> = { create: "créer", edit: "modifier", archive: "archiver", restore: "restaurer" };
export const stateLabel = (value: string) => operations[value] ?? value;

/** Translate application-written audit prefixes, preserving imported source references. */
export function sourceLabel(value: string): string {
  const slack = /^(Slack structured|Slack natural-language)(?: (creation|edit|archive|restore))?$/.exec(value);
  if (slack) {
    const operation: Record<string, string> = { creation: 'création', edit: 'modification', archive: 'archivage', restore: 'restauration' };
    return `${slack[1] === 'Slack structured' ? 'Commande structurée Slack' : 'Demande Slack en langage naturel'}${slack[2] ? ` — ${operation[slack[2]]}` : ''}`;
  }
  return value.replace(/^Slack structured(?=\s|$)/, 'Commande structurée Slack')
    .replace(/^Slack natural-language(?=\s|$)/, 'Demande Slack en langage naturel')
    .replace(/^Spreadsheet import(?=\s|$)/, 'Import de feuille de calcul')
    .replace(/; batch /g, '; lot ').replace(/; effect /g, '; effet ');
}
