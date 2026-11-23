import type { FormDefinition, FormField, FormValues, SavedForm } from '../../core/forms.js';
import { ownerKey, type Actor } from '../../core/identity.js';
import type { MenuPage } from '../../core/navigation.js';
import { validResourceUrl, type TableCell } from '../../core/slack.js';
import type { Sql } from '../../core/store.js';
import { transaction } from '../../core/transactions.js';
import { cellView, isTab, literalHyperlink, segments, tabs, type Cell, type Sheet, type SheetRow, type Tab, type Workbook } from './sheets.js';

export type SheetMutation = { operation?: 'edit'; cell: Cell; fields: string } | { operation: 'create'; cells: Cell[] } | { operation: 'delete' };
type RowContext = { operation: 'create' | 'delete'; book: string; tab: Tab; sheetId: number; key: string; cells?: Cell[] };
type EditContext = { book: string; tab: Tab; sheetId: number; key: string; col: number; name: string; original: Cell };
const home = { label: 'Retour au classeur', page: 'main' };
const unavailable = 'La ligne a changé, a été supprimée ou existe en double. Ouvrez à nouveau l’onglet.';
const tabLink = (tab: Tab) => ({ label: tabs[tab].title, page: 'sheet_' + tab + '_0' });
const exact = (sheet: Sheet, key: string) => {
  const rows = sheet.rows.filter(row => row.key === key);
  return rows.length === 1 ? rows[0] : undefined;
};
const rowName = (row: SheetRow, tab: Tab) => row.cells[tabs[tab].name]?.formattedValue || 'Ligne ' + (row.index + 1);

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
  const fields: FormField[] = [];
  parts.forEach((part, i) => {
    const suffix = parts.length > 1 ? ' (' + (i + 1) + '/' + parts.length + ')' : '';
    fields.push({ key: 'v' + i, label: tabs[context.tab].headers[context.col] + suffix, kind: 'lines', max: 3000, initial: context.original.userEnteredValue?.numberValue?.toString() ?? context.original.userEnteredValue?.boolValue?.toString() ?? part.text });
    if (!context.original.userEnteredValue || context.original.userEnteredValue.numberValue === undefined && context.original.userEnteredValue.boolValue === undefined)
      fields.push({ key: 'u' + i, label: 'Lien' + suffix, max: 3000, initial: part.url ?? '', hint: 'Adresse HTTP(S) facultative pour ce texte.' });
  });
  return { title: 'Modifier une cellule', fields, context };
}
export function validateSheet(form: SavedForm, values: FormValues): { data: { workbook: SheetMutation } } | { errors: Record<string, string> } {
  if (form.definition.context.operation === 'create') {
    const { tab } = form.definition.context as RowContext;
    const cells: Cell[] = [];
    for (const [i] of tabs[tab].headers.entries()) {
      const text = String(values['v' + i] ?? ''), url = String(values['u' + i] ?? '').trim();
      if (i === tabs[tab].name && !text.trim()) return { errors: { ['v' + i]: 'Le nom est requis.' } };
      if (url && (!text || !validResourceUrl(url))) return { errors: { ['u' + i]: 'Un lien nécessite un texte et une URL HTTP(S) valide.' } };
      cells.push(text ? { userEnteredValue: { stringValue: text }, ...(url ? { textFormatRuns: [{ startIndex: 0, format: { link: { uri: url } } }] } : {}) } : {});
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
  return { kind: tabs[tab].title, text: 'Choisissez le champ à modifier. Les champs calculés complexes s’éditent dans Sheets.',
    table: { columns: ['Champ', 'Valeur'], rows: sheet.headers.map((h, i) => [h, cellView(row.cells[i]!)]) },
    buttons: [...sheet.headers.flatMap((h, i) => editable(row.cells[i]!) ? [{ label: 'Modifier · ' + h, action: 'form_prepare', bound: true, value: `sheet_${tab}_${row.key}_${i}` }] : []),
      { label: 'Supprimer la ligne', action: 'form_prepare', bound: true, value: `sheet_${tab}_${row.key}_delete` }],
    links: [tabLink(tab), home] };
}
export const workbookHelp = 'Envoyez documentation classeur, choisissez un onglet puis une ligne. Ajouter une ligne crée une proposition. Sur une ligne, Supprimer la ligne affiche les valeurs avant confirmation. Modifier ouvre un champ avec son texte et ses liens. Vérifiez la proposition, puis confirmez pour mettre à jour Google Sheets. Actualisez l’onglet pour voir les changements faits dans Sheets. Pour l’inventaire PostgreSQL et ses questions IA, ajoutez inventaire après documentation, par exemple documentation inventaire projets.';

export class LiveWorkbook {
  constructor(private provider: Workbook, private sql: Sql) {}
  allowed(actor: Actor) { return actor.team === this.provider.team && actor.channel.startsWith('D'); }
  async command(actor: Actor, text: string): Promise<string | MenuPage> {
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
      const rows = sheet.rows.filter(row => rowName(row, tab).localeCompare(name, 'fr', { sensitivity: 'accent' }) === 0);
      if (rows.length === 1) return rowPage(tab, sheet, rows[0]!);
      return { kind: tabs[tab].title, text: rows.length ? 'Plusieurs lignes portent ce nom. Choisissez la ligne dans l’onglet.' : 'Aucune ligne ne porte ce nom dans l’onglet.', links: [tabLink(tab), home] };
    }
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
    const secondary = def.name === 1 ? 0 : 1;
    return { kind: def.title, text: sheet.rows.length + ' lignes · page ' + (p + 1),
      ...(rows.length ? { table: { columns: ['Ligne', sheet.headers[def.name]!, sheet.headers[secondary]!], rows: rows.map(row => [String(row.index + 1), cellView(row.cells[def.name]!), cellView(row.cells[secondary]!)]) },
        recordChoices: rows.map(row => ({ label: rowName(row, tab), page: 'sheet_' + tab + '_' + row.key })) } : {}),
      buttons: [{ label: 'Ajouter une ligne', action: 'form_prepare', bound: true, value: 'sheet_' + tab + '_create' }],
      links: [...(p ? [{ label: 'Précédent', page: 'sheet_' + tab + '_' + (p - 1) }] : []),
        ...((p + 1) * 6 < sheet.rows.length ? [{ label: 'Suivant', page: 'sheet_' + tab + '_' + (p + 1) }] : []),
        { label: 'Actualiser', page: 'sheet_' + tab + '_' + p }, home] };
  }
  async definition(actor: Actor, value: string) {
    const match = /^sheet_([a-z]+)_(?:create|([a-f0-9]{64})_(delete|\d))$/.exec(value);
    if (!this.allowed(actor) || !match || !isTab(match[1]!)) return;
    const tab = match[1], col = Number(match[3]);
    let sheet: Sheet;
    try { sheet = await this.provider.read(tab); } catch { return; }
    if (!match[2]) {
      const context: RowContext = { operation: 'create', book: this.provider.identity, tab, sheetId: sheet.id, key: 'create_' + tab };
      const fields = sheet.headers.flatMap((label, i): FormField[] => [
        { key: 'v' + i, label, kind: 'lines', max: 1500, required: i === tabs[tab].name },
        { key: 'u' + i, label: 'Lien · ' + label, max: 1000, hint: 'Adresse HTTP(S) facultative.' },
      ]);
      return { title: 'Ajouter une ligne', fields, context };
    }
    const row = exact(sheet, match[2]);
    if (!row) return;
    if (match[3] === 'delete') {
      const context: RowContext = { operation: 'delete', book: this.provider.identity, tab, sheetId: sheet.id, key: row.key, cells: row.cells };
      return { title: 'Supprimer la ligne', fields: [], context };
    }
    if (!row.cells[col] || !editable(row.cells[col])) return;
    return sheetDefinition({ book: this.provider.identity, tab, sheetId: sheet.id, key: row.key, col, name: rowName(row, tab), original: row.cells[col] });
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
        table: { columns: ['Champ', 'Valeur'], rows: tabs[ctx.tab].headers.map((label, i) => [label, cellView(cells[i]!)]) },
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
      table: { columns: ['Onglet', 'Ligne', 'Champ', 'Avant', 'Après'], rows: [[tabs[ctx.tab].title, ctx.name, tabs[ctx.tab].headers[ctx.col]!, describe(cellView(ctx.original)), describe(after)]] },
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
      try { sheet = await this.provider.read(ctx.tab, mutation.operation === 'delete'); }
      catch { return finish('submitted', 'Lecture Google impossible. Rouvrez la proposition.'); }
      if (sheet.id !== ctx.sheetId) return finish('stale', 'Cet onglet a été remplacé. Rouvrez le classeur.');
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
