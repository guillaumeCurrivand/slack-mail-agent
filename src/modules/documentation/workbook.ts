import type { FormDefinition, FormField, FormValues, SavedForm } from '../../core/forms.js';
import { ownerKey, type Actor } from '../../core/identity.js';
import type { MenuPage } from '../../core/navigation.js';
import { validResourceUrl, type TableCell } from '../../core/slack.js';
import type { Sql } from '../../core/store.js';
import { transaction } from '../../core/transactions.js';
import { cellView, isTab, nameColumn, literalHyperlink, segments, tabs, type Cell, type Sheet, type SheetRow, type Tab, type Workbook } from './sheets.js';

export type SheetMutation = { operation?: 'edit'; cell: Cell; fields: string } | { operation: 'create'; cells: Cell[] } | { operation: 'delete' };
type SheetContext = { book: string; tab: Tab; sheetId: number; key: string; headers?: string[] };
type RowContext = SheetContext & { operation: 'create' | 'delete'; cells?: Cell[] };
type EditContext = SheetContext & { col: number; name: string; original: Cell };
// Forms saved before live header discovery have no header snapshot.
const legacyHeaders: Record<Tab, string[]> = {
  projects: ['Projet', 'Technologie front', 'Technologie back', 'Hébergement front', 'Hébergement back', 'Accès', 'Repos GitHub', 'Repos GitLab', 'Identifiants sur le Vault ?'],
  technologies: ['Catégorie', 'Technologie', 'Utilisé sur'],
  hosts: ['Hébergeur', 'Rôle', 'Projets', 'Coût Mensuel'],
  tools: ['Catégorie', 'Outil', 'Usage', 'Référent', 'Utilisé sur'],
};
const savedHeaders = (context: SheetContext) => context.headers ?? legacyHeaders[context.tab];
function columns(headers: string[]) {
  const names = headers.map(h => h.trim());
  const seen = new Set<string>(), duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return names.flatMap((name, index) => name ? [{ index, name, label: duplicates.has(name) ? name + ' (col. ' + (index + 1) + ')' : name }] : []);
}
const home = { label: 'Retour au classeur', page: 'main' };
const unavailable = 'La ligne a changé, a été supprimée ou existe en double. Ouvrez à nouveau l’onglet.';
const tabLink = (tab: Tab) => ({ label: tabs[tab].title, page: 'sheet_' + tab + '_0' });
const exact = (sheet: Sheet, key: string) => {
  const rows = sheet.rows.filter(row => row.key === key);
  return rows.length === 1 ? rows[0] : undefined;
};
const rowName = (row: SheetRow, index: number) => row.cells[index]?.formattedValue || row.cells[index]?.userEnteredValue?.stringValue || 'Ligne ' + (row.index + 1);

const quoted = (value: string) => '"' + value.replaceAll('"', '""') + '"';
function editable(cell: Cell) {
  const value = cell.userEnteredValue;
  if (cell.chipRuns?.length || cell.dataSourceFormula || (value?.formulaValue && !literalHyperlink.test(value.formulaValue))) return false;
  if (value?.numberValue !== undefined && ['DATE','TIME','DATE_TIME','DURATION'].includes(cell.userEnteredFormat?.numberFormat?.type ?? '')) return false;
  const parts = segments(cell);
  return parts.length <= 40 && parts.every(part => part.text.length <= 3000 && (!part.url || (part.url.length <= 3000 && validResourceUrl(part.url))));
}
export function sheetDefinition(context: EditContext): FormDefinition {
  const parts = segments(context.original);
  const label = columns(savedHeaders(context)).find(c => c.index === context.col)!.label;
  const fields: FormField[] = [];
  parts.forEach((part, i) => {
    const suffix = parts.length > 1 ? ' (' + (i + 1) + '/' + parts.length + ')' : '';
    fields.push({ key: 'v' + i, label: (label + suffix).slice(0, 2000), kind: 'lines', max: 3000, initial: context.original.userEnteredValue?.numberValue?.toString() ?? context.original.userEnteredValue?.boolValue?.toString() ?? part.text });
    if (!context.original.userEnteredValue || context.original.userEnteredValue.numberValue === undefined && context.original.userEnteredValue.boolValue === undefined)
      fields.push({ key: 'u' + i, label: 'Lien' + suffix, max: 3000, initial: part.url ?? '', hint: 'Adresse HTTP(S) facultative pour ce texte.' });
  });
  return { title: 'Modifier une cellule', fields, context };
}
export function validateSheet(form: SavedForm, values: FormValues): { data: { workbook: SheetMutation } } | { errors: Record<string, string> } {
  if (form.definition.context.operation === 'create') {
    const ctx = form.definition.context as RowContext;
    const headers = savedHeaders(ctx), name = nameColumn(headers, ctx.tab);
    const cells: Cell[] = headers.map(() => ({}));
    for (const { index: i } of columns(headers)) {
      const text = String(values['v' + i] ?? ''), url = String(values['u' + i] ?? '').trim();
      if (i === name && !text.trim()) return { errors: { ['v' + i]: 'Le nom est requis.' } };
      if (url && (!text || !validResourceUrl(url))) return { errors: { ['u' + i]: 'Un lien nécessite un texte et une URL HTTP(S) valide.' } };
      if (text) cells[i] = { userEnteredValue: { stringValue: text }, ...(url ? { textFormatRuns: [{ startIndex: 0, format: { link: { uri: url } } }] } : {}) };
    }
    return { data: { workbook: { operation: 'create', cells } } };
  }
  const { original } = form.definition.context as EditContext;
  const fail = (key: string, error: string) => ({ errors: { [key]: error } });
  if (form.definition.fields.every(f => (f.initial ?? '') === values[f.key])) return fail('v0', 'Aucune modification.');
  const parts = segments(original);
  let text = '';
  const runs: NonNullable<Cell['textFormatRuns']> = [];
  for (const [i, part] of parts.entries()) {
    const str = String(values['v' + i] ?? ''), uri = String(values['u' + i] ?? '');
    if (uri && (!validResourceUrl(uri) || !str)) return fail('u' + i, 'Un lien nécessite un texte et une URL HTTP(S) valide.');
    const { link: _link, ...format } = part.format;
    if (str) runs.push({ startIndex: text.length, format: { ...format, ...(uri ? { link: { uri } } : {}) } });
    text += str;
  }
  const old = original.userEnteredValue;
  let cell: Cell = {}, fields = 'userEnteredValue';
  if (old?.formulaValue && text && values.u0) {
    const separator = literalHyperlink.exec(old.formulaValue)?.[2];
    if (!separator) return fail('v0', 'Formule à modifier dans Sheets.');
    cell = { userEnteredValue: { formulaValue: '=HYPERLINK(' + quoted(String(values.u0)) + separator + quoted(text) + ')' } };
  } else if (old?.numberValue !== undefined && text) {
    if (!/^-?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(text) || !Number.isFinite(Number(text.replace(',', '.')))) return fail('v0', 'Saisissez un nombre.');
    cell = { userEnteredValue: { numberValue: Number(text.replace(',', '.')) } };
  } else if (old?.boolValue !== undefined && text) {
    if (!/^(true|false)$/i.test(text)) return fail('v0', 'Saisissez true ou false.');
    cell = { userEnteredValue: { boolValue: text.toLowerCase() === 'true' } };
  } else {
    fields += ',textFormatRuns';
    if (original.userEnteredFormat?.textFormat?.link) fields += ',userEnteredFormat.textFormat.link';
    if (text) cell = { userEnteredValue: { stringValue: text }, ...(runs.some(run => Object.keys(run.format ?? {}).length) ? { textFormatRuns: runs } : {}) };
  }
  return { data: { workbook: { cell, fields } } };
}
function rowPage(tab: Tab, sheet: Sheet, row: SheetRow): MenuPage {
  const fields = columns(sheet.headers);
  return { kind: tabs[tab].title, text: 'Choisissez le champ à modifier. Les champs calculés complexes s’éditent dans Sheets.',
    table: { columns: ['Champ', 'Valeur'], rows: fields.map(({ index, label }) => [label, cellView(row.cells[index]!)]),
      rowButtons: fields.map(({ index, label }) => editable(row.cells[index]!)
        ? { label: 'Modifier · ' + label, action: 'form_prepare', bound: true, value: `sheet_${tab}_${row.key}_${index}` } : null),
      rowButtonFallback: 'Modifier le champ dans Sheets ou ouvrir cette fiche dans un client Slack à jour.' },
    buttons: [{ label: 'Supprimer la ligne', action: 'form_prepare', bound: true, value: `sheet_${tab}_${row.key}_delete` }],
    links: [tabLink(tab), home] };
}
export const workbookHelp = 'Posez une question, par exemple « documentation qui est responsable du projet Alpha ? », ou envoyez documentation chercher Alpha pour une recherche de texte. Envoyez documentation classeur, choisissez un onglet puis une ligne. Ajouter une ligne crée une proposition. Sur une ligne, Supprimer la ligne affiche les valeurs avant confirmation. Modifier ouvre un champ avec son texte et ses liens. Vérifiez la proposition, puis confirmez pour mettre à jour Google Sheets. Actualisez l’onglet pour voir les changements faits dans Sheets. Pour l’inventaire PostgreSQL et ses questions IA, ajoutez inventaire après documentation, par exemple documentation inventaire projets.';

export class LiveWorkbook {
  constructor(private provider: Workbook, private sql: Sql) {}
  allowed(actor: Actor) { return actor.team === this.provider.team && actor.channel.startsWith('D'); }
  async command(actor: Actor, text: string, ask?: (question: string) => Promise<MenuPage>): Promise<string | MenuPage> {
    const term = text.trim().toLowerCase();
    const sections: Record<string, Tab> = { projects: 'projects', technologies: 'technologies', tools: 'tools', hosts: 'hosts', hosting: 'hosts', 'hosting-entry': 'hosts' };
    if (Object.hasOwn(sections, term)) return tabLink(sections[term]!).page;
    if (term === 'classeur') return 'main';
    if (term === 'inventaire') return 'inventory';
    const match = /^(project|technology|host|hosting-entry|tool)\s+([\s\S]+)$/i.exec(text);
    if (match && this.allowed(actor)) {
      const singular: Record<string, Tab> = { project: 'projects', technology: 'technologies', host: 'hosts', 'hosting-entry': 'hosts', tool: 'tools' };
      const tab = singular[match[1]!.toLowerCase()]!;
      let sheet;
      try { sheet = await this.provider.read(tab); } catch { return { kind: 'Classeur indisponible', text: 'Réessayez depuis l’onglet.', links: [tabLink(tab)] }; }
      const name = match[2]!.trim();
      const primary = nameColumn(sheet.headers, tab);
      const rows = sheet.rows.filter(row => rowName(row, primary).localeCompare(name, 'fr', { sensitivity: 'accent' }) === 0);
      if (rows.length === 1) return rowPage(tab, sheet, rows[0]!);
      return { kind: tabs[tab].title, text: rows.length ? 'Plusieurs lignes portent ce nom. Choisissez la ligne dans l’onglet.' : 'Aucune ligne ne porte ce nom dans l’onglet.', links: [tabLink(tab), home] };
    }
    if (ask && this.allowed(actor) && term && !['help', 'aide', 'menu', 'bonjour', 'hello', 'hi'].includes(term)) return ask(text);
    return { kind: 'Documentation · Classeur', text: workbookHelp, links: [home, { label: 'Inventaire structuré', page: 'inventory' }] };
  }
  async page(actor: Actor, destination: string): Promise<MenuPage | undefined> {
    if (!this.allowed(actor)) return;
    if (destination === 'main') return { kind: 'Documentation · Classeur', text: 'Choisissez un onglet du classeur partagé.', links: [
      ...Object.keys(tabs).map(tab => tabLink(tab as Tab)), { label: 'Inventaire structuré', page: 'inventory' }, { label: 'Aide', page: 'help' },
    ] };
    const match = /^sheet_([a-z]+)_(\d{1,6}|[a-f0-9]{64})$/.exec(destination);
    if (!match || !isTab(match[1]!)) return;
    const tab = match[1], selector = match[2]!, def = tabs[tab];
    let sheet: Sheet;
    try { sheet = await this.provider.read(tab); }
    catch { return { kind: 'Classeur indisponible', text: 'Vérifiez le partage Google, les noms des onglets et les en-têtes, puis réessayez.', links: [tabLink(tab), home] }; }
    if (selector.length === 64) {
      const row = exact(sheet, selector);
      if (!row) return { kind: 'Ligne indisponible', text: unavailable, links: [tabLink(tab), home] };
      return rowPage(tab, sheet, row);
    }
    const p = Math.min(Number(selector), Math.max(0, Math.ceil(sheet.rows.length / 6) - 1));
    const rows = sheet.rows.slice(p * 6, p * 6 + 6);
    const fields = columns(sheet.headers), primary = nameColumn(sheet.headers, tab);
    const others = fields.filter(c => c.index !== primary);
    const secondary = others.find(c => c.name === def.secondary) ?? others[0];
    const summary = [fields.find(c => c.index === primary)!, ...(secondary ? [secondary] : [])];
    return { kind: def.title, text: sheet.rows.length + ' lignes · page ' + (p + 1) + (fields.length > 49 ? '\nCréez la ligne avec son nom, puis complétez les champs depuis sa fiche.' : ''),
      ...(rows.length ? { table: { columns: ['Ligne', ...summary.map(c => c.label)], rows: rows.map(row => [String(row.index + 1), ...summary.map(c => cellView(row.cells[c.index]!))]) },
        recordChoices: rows.map(row => ({ label: rowName(row, primary), page: 'sheet_' + tab + '_' + row.key })) } : {}),
      buttons: [{ label: 'Ajouter une ligne', action: 'form_prepare', bound: true, value: 'sheet_' + tab + '_create' }],
      links: [...(p ? [{ label: 'Précédent', page: 'sheet_' + tab + '_' + (p - 1) }] : []),
        ...((p + 1) * 6 < sheet.rows.length ? [{ label: 'Suivant', page: 'sheet_' + tab + '_' + (p + 1) }] : []),
        { label: 'Actualiser', page: 'sheet_' + tab + '_' + p }, home] };
  }
  async definition(actor: Actor, value: string) {
    const match = /^sheet_([a-z]+)_(?:create|([a-f0-9]{64})_(delete|\d{1,5}))$/.exec(value);
    if (!this.allowed(actor) || !match || !isTab(match[1]!)) return;
    const tab = match[1], col = Number(match[3]);
    let sheet: Sheet;
    try { sheet = await this.provider.read(tab); } catch { return; }
    if (!match[2]) {
      const context: RowContext = { operation: 'create', book: this.provider.identity, tab, sheetId: sheet.id, key: 'create_' + tab, headers: sheet.headers };
      const visible = columns(sheet.headers), primary = nameColumn(sheet.headers, tab);
      // Slack allows 100 modal blocks. One introduction plus two inputs per column fit 49 columns.
      const inputs = visible.length <= 49 ? visible : visible.filter(c => c.index === primary);
      const fields = inputs.flatMap(({ index: i, label }): FormField[] => [
        { key: 'v' + i, label: label.slice(0, 2000), kind: 'lines', max: 1500, required: i === primary },
        { key: 'u' + i, label: ('Lien · ' + label).slice(0, 2000), max: 1000, hint: 'Adresse HTTP(S) facultative.' },
      ]);
      return { title: 'Ajouter une ligne', fields, context };
    }
    const row = exact(sheet, match[2]);
    if (!row) return;
    if (match[3] === 'delete') {
      const context: RowContext = { operation: 'delete', book: this.provider.identity, tab, sheetId: sheet.id, key: row.key, cells: row.cells, headers: sheet.headers };
      return { title: 'Supprimer la ligne', fields: [], context };
    }
    if (!sheet.headers[col]?.trim() || !row.cells[col] || !editable(row.cells[col])) return;
    return sheetDefinition({ book: this.provider.identity, tab, sheetId: sheet.id, key: row.key, col, name: rowName(row, nameColumn(sheet.headers, tab)), original: row.cells[col], headers: sheet.headers });
  }
  async reviewDeletion(actor: Actor, form: SavedForm): Promise<SavedForm<{ workbook: SheetMutation }> | undefined> {
    if (!this.allowed(actor) || form.channel !== actor.channel || form.definition.context.book !== this.provider.identity || form.definition.context.operation !== 'delete') return;
    return (await this.sql.query(`UPDATE documentation_guided_forms SET state='submitted', result=$4
      WHERE id=$1 AND owner=$2 AND channel=$3 AND state IN ('editing','submitted') AND created_at>=now()-interval '24 hours' RETURNING *`,
    [form.id, ownerKey(actor), actor.channel, JSON.stringify({ workbook: { operation: 'delete' } })])).rows[0];
  }
  async cancel(actor: Actor, id: string) {
    const cancelled = await this.sql.query(`UPDATE documentation_guided_forms SET state='cancelled' WHERE id=$1 AND owner=$2
      AND channel=$3 AND state='submitted' AND definition->'context'->>'book'=$4 RETURNING id`, [id, ownerKey(actor), actor.channel, this.provider.identity]);
    return cancelled.rows.length ? 'Proposition annulée.' : 'Cette proposition a déjà été traitée ou est inaccessible.';
  }
  preview(form: SavedForm<{ workbook: SheetMutation }>): MenuPage {
    const mutation = form.result!.workbook;
    const cancel = { label: 'Annuler', action: 'sheet_cancel', value: form.id, bound: true };
    if (mutation.operation === 'create' || mutation.operation === 'delete') {
      const ctx = form.definition.context as RowContext;
      const creating = mutation.operation === 'create';
      const cells = creating ? mutation.cells : ctx.cells!;
      return { kind: creating ? 'Confirmer la création' : 'Confirmer la suppression',
        text: (creating ? 'Nouvelle ligne' : 'La ligne entière sera supprimée') + ' · ' + tabs[ctx.tab].title,
        table: { columns: ['Champ', 'Valeur'], rows: columns(savedHeaders(ctx)).map(({ label, index }) => [label, cellView(cells[index]!)]) },
        buttons: [{ label: creating ? 'Confirmer la création' : 'Confirmer la suppression', action: 'sheet_apply', value: form.id, bound: true }, cancel] };
    }
    const ctx = form.definition.context as EditContext, change = mutation.cell;
    const value = change.userEnteredValue;
    let after: TableCell = cellView(change);
    if (value?.formulaValue) {
      const match = literalHyperlink.exec(value.formulaValue)!;
      after = [{ text: match[3]!.replaceAll('""','"'), url: match[1]!.replaceAll('""','"') }];
    } else if (value?.numberValue !== undefined || value?.boolValue !== undefined) after = String(value.numberValue ?? value.boolValue);
    const describe = (v: TableCell) => typeof v === 'string' ? v : v.map(part => part.text + (part.url ? ' (' + part.url + ')' : '')).join('');
    return { kind: 'Confirmer la modification dans Sheets', text: 'Vérifiez la valeur et les destinations des liens.',
      table: { columns: ['Onglet', 'Ligne', 'Champ', 'Avant', 'Après'], rows: [[tabs[ctx.tab].title, ctx.name, columns(savedHeaders(ctx)).find(c => c.index === ctx.col)!.label, describe(cellView(ctx.original)), describe(after)]] },
      buttons: [{ label: 'Confirmer dans Sheets', action: 'sheet_apply', value: form.id, bound: true }, cancel] };
  }
  async apply(actor: Actor, form: SavedForm<{ workbook: SheetMutation }>): Promise<string> {
    const ctx = form.definition.context as RowContext | EditContext;
    const mutation = form.result!.workbook;
    if (!this.allowed(actor) || ctx.book !== this.provider.identity || form.channel !== actor.channel) return 'Cette proposition est inaccessible.';
    if (form.state === 'applied') return 'Modification déjà enregistrée dans Sheets.';
    if (form.state !== 'submitted') return 'Proposition déjà traitée. Consultez la cellule dans Sheets.';
    const owner = ownerKey(actor);
    // One in-flight writer per workbook row across all users. A crash after dispatch must never replay the write.
    let claimed;
    try {
      claimed = await this.sql.query("UPDATE documentation_guided_forms SET state='sheet_writing' WHERE id=$1 AND owner=$2 AND channel=$3 AND state='submitted' AND created_at >= now()-interval '24 hours' RETURNING id", [form.id, owner, actor.channel]);
    } catch (err) { if ((err as { code?: string }).code === '23505') return 'Une modification de cette ligne est en cours. Réessayez après actualisation.'; throw err; }
    if (!claimed.rows.length) return 'Proposition expirée ou déjà traitée. Consultez Sheets.';
    // A deletion shifts later row indexes. Serialize the final read and write for every Slack mutation on this tab.
    return transaction(this.sql, async db => {
      const finish = async (state: string, message: string) => {
        await db.query('UPDATE documentation_guided_forms SET state=$2 WHERE id=$1', [form.id, state]);
        return message;
      };
      const lock = await db.query('SELECT pg_try_advisory_xact_lock(hashtext($1), $2::integer) AS acquired', ['documentation:sheet:' + ctx.book, ctx.sheetId]);
      if (!lock.rows[0].acquired) return finish('submitted', 'Une écriture est en cours dans cet onglet. Rouvrez la proposition.');
      let sheet: Sheet;
      try { sheet = await this.provider.read(ctx.tab); }
      catch { return finish('submitted', 'Lecture Google impossible. Rouvrez la proposition.'); }
      if (sheet.id !== ctx.sheetId) return finish('stale', 'Cet onglet a été remplacé. Rouvrez le classeur.');
      const headers = savedHeaders(ctx);
      if (headers.length !== sheet.headers.length || headers.some((h, i) => h !== sheet.headers[i]))
        return finish('stale', 'Les colonnes ont changé. Actualisez l’onglet et préparez une nouvelle proposition.');
      try {
        if (mutation.operation === 'create') {
          const signature = (cells: Cell[]) => JSON.stringify(cells.map(cellView));
          const proposed = signature(mutation.cells);
          if (sheet.rows.some(row => signature(row.cells) === proposed)) return finish('stale', 'Une ligne identique existe déjà.');
          await this.provider.append(sheet.id, mutation.cells);
          return finish('applied', 'Ligne ajoutée dans Google Sheets.');
        }
        const row = exact(sheet, ctx.key);
        if (!row) return finish('stale', unavailable);
        if (mutation.operation === 'delete') {
          if (row.extraData) return finish('stale', 'Cette ligne contient des données hors des colonnes affichées. Vérifiez-la dans Sheets.');
          await this.provider.remove(sheet.id, row.index);
          return finish('applied', 'Ligne supprimée dans Google Sheets.');
        }
        await this.provider.write(sheet.id, row.index, (ctx as EditContext).col, mutation.cell, mutation.fields);
        return finish('applied', 'Modification enregistrée dans Google Sheets.');
      } catch { return finish('uncertain', 'Écriture non confirmée. Vérifiez l’onglet dans Sheets avant de préparer une nouvelle opération.'); }
    });
  }
}
