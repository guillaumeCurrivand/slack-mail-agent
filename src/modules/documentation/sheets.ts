import { sha256Hex as digest } from '../../core/crypto.js';
import { SignJWT, importPKCS8 } from 'jose';
import { validResourceUrl, type TableCell } from '../../core/slack.js';

export const tabs = {
  projects: { title: 'projet', name: 'Projet', secondary: 'Technologie front' },
  technologies: { title: 'Technologies', name: 'Technologie', secondary: 'Catégorie' },
  hosts: { title: 'hébergement', name: 'Hébergeur', secondary: 'Rôle' },
  tools: { title: 'Outils', name: 'Outil', secondary: 'Catégorie' },
} as const;
export type Tab = keyof typeof tabs;
export function nameColumn(headers: string[], tab: Tab) {
  const index = headers.findIndex(h => h.trim() === tabs[tab].name);
  return index >= 0 ? index : headers.findIndex(h => h.trim());
}
export const isTab = (key: string): key is Tab => Object.hasOwn(tabs, key);
type Format = { link?: { uri: string }; [key: string]: unknown };
export type Cell = {
  formattedValue?: string; userEnteredValue?: { stringValue?: string; formulaValue?: string; numberValue?: number; boolValue?: boolean };
  hyperlink?: string; textFormatRuns?: { startIndex?: number; format?: Format }[];
  userEnteredFormat?: { textFormat?: Format; numberFormat?: { type?: string } }; chipRuns?: unknown[]; dataSourceFormula?: unknown;
};
export type SheetRow = { index: number; key: string; cells: Cell[]; extraData?: boolean };
export type Sheet = { id: number; headers: string[]; rows: SheetRow[] };
export type Workbook = {
  identity: string; team: string;
  read(tab: Tab): Promise<Sheet>;
  readAll?(): Promise<Array<{ tab: Tab; sheet: Sheet }>>;
  sourceUrl?(sheetId: number, range: string): string;
  append(sheetId: number, cells: Cell[]): Promise<void>;
  remove(sheetId: number, row: number): Promise<void>;
  write(sheetId: number, row: number, column: number, cell: Cell, fields: string): Promise<void>;
};
export { digest };
const display = (cell: Cell) => cell.formattedValue ?? cell.userEnteredValue?.stringValue ?? '';
export const literalHyperlink = /^=HYPERLINK\s*\(\s*"((?:[^"]|"")*)"\s*([;,])\s*"((?:[^"]|"")*)"\s*\)$/i;
export function segments(cell: Cell) {
  const value = cell.userEnteredValue?.stringValue ?? display(cell);
  const runs = [...cell.textFormatRuns ?? []];
  if (!runs.length || runs[0]!.startIndex) runs.unshift({ startIndex: 0 });
  return runs.map((run, i) => ({
    text: value.slice(run.startIndex ?? 0, runs[i + 1]?.startIndex),
    url: run.format?.link?.uri ?? cell.userEnteredFormat?.textFormat?.link?.uri ?? (runs.length === 1
      ? cell.hyperlink ?? literalHyperlink.exec(cell.userEnteredValue?.formulaValue ?? '')?.[1]?.replaceAll('""', '"') : undefined),
    format: run.format ?? {},
  }));
}
export const cellView = (cell: Cell): TableCell => segments(cell).map(({ text, url }) => ({ text, ...(url && validResourceUrl(url) ? { url } : {}) }));
export function parseSheet(tab: Tab, source: { properties: { sheetId: number; title: string }; data?: { rowData?: { values?: Cell[] }[] }[] }): Sheet {
  const template = tabs[tab];
  const [head, ...data] = source.data?.[0]?.rowData ?? [];
  const headers = head?.values?.map(display) ?? [];
  while (headers.length && !headers.at(-1)!.trim()) headers.pop();
  if (source.properties.title !== template.title || !headers.length) throw new Error('Vérifiez les colonnes de la première ligne.');
  const rows = data.flatMap((row, i) => {
    const cells = headers.map((_, j) => row.values?.[j] ?? {});
    if (!cells.some((cell, j) => headers[j]!.trim() && (cell.userEnteredValue || display(cell)))) return [];
    const key = digest(JSON.stringify([source.properties.sheetId, headers, cells]));
    const extraData = row.values?.some((cell, j) => !headers[j]?.trim() && (cell.userEnteredValue || cell.formattedValue || cell.hyperlink || cell.chipRuns?.length || cell.dataSourceFormula || 'note' in cell || 'pivotTable' in cell || 'dataSourceTable' in cell));
    return [{ index: i + 1, key, cells, extraData }];
  });
  return { id: source.properties.sheetId, headers, rows };
}

export function configuredWorkbook(env: NodeJS.ProcessEnv, team: string, request: typeof fetch = fetch): Workbook | undefined {
  const id = env.DOCUMENTATION_SPREADSHEET_ID;
  if (!id && !env.DOCUMENTATION_GOOGLE_SERVICE_ACCOUNT_JSON) return;
  if (!id || !/^[\w-]+$/.test(id) || !env.DOCUMENTATION_GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Incomplete Documentation workbook configuration.');
  let credentials: { client_email?: string; private_key?: string };
  try { credentials = JSON.parse(env.DOCUMENTATION_GOOGLE_SERVICE_ACCOUNT_JSON); }
  catch { throw new Error('Invalid Documentation Google credentials.'); }
  if (!credentials?.client_email || !credentials.private_key) throw new Error('Invalid Documentation Google credentials.');
  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + id;
  let cached: { token: string; until: number } | undefined;
  async function accessToken() {
    if (cached && cached.until > Date.now()) return cached.token;
    try {
      const key = await importPKCS8(credentials.private_key!, 'RS256');
      const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/spreadsheets' }).setProtectedHeader({ alg: 'RS256' })
        .setIssuer(credentials.client_email!).setAudience(tokenUrl).setIssuedAt().setExpirationTime('5m').sign(key);
      const response = await request(tokenUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (typeof result.access_token !== 'string' || !result.access_token) throw new Error();
      cached = { token: result.access_token, until: Date.now() + (Number(result.expires_in) - 60) * 1000 };
      return cached.token;
    } catch { throw new Error('Authentification Google indisponible.'); }
  }
  async function call(url: string, body?: unknown) {
    const token = await accessToken();
    const response = await request(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) cached = undefined;
    if (!response.ok) throw new Error('Google Sheets indisponible (' + response.status + ').');
    return response;
  }
  async function readTabs(selected: Tab[]) {
    const fields = 'formattedValue,userEnteredValue,hyperlink,textFormatRuns,userEnteredFormat(textFormat,numberFormat),chipRuns,dataSourceFormula,note,pivotTable,dataSourceTable';
    const params = new URLSearchParams({ fields: 'sheets(properties(sheetId,title),data(rowData(values(' + fields + '))))' });
    for (const tab of selected) params.append('ranges', "'" + tabs[tab].title + "'");
    const data = await (await call(base + '?' + params)).json() as { sheets?: Array<Parameters<typeof parseSheet>[1]> };
    return selected.map(tab => {
      const source = data.sheets?.find(s => s.properties.title === tabs[tab].title);
      if (!source) throw new Error('Onglet introuvable.');
      return { tab, sheet: parseSheet(tab, source) };
    });
  }
  return {
    identity: digest(id), team,
    async read(tab) { return (await readTabs([tab]))[0]!.sheet; },
    readAll: () => readTabs(Object.keys(tabs) as Tab[]),
    sourceUrl: (sheetId, range) => 'https://docs.google.com/spreadsheets/d/' + id + '/edit#gid=' + sheetId + '&range=' + encodeURIComponent(range),
    async append(sheetId, cells) {
      await call(base + ':batchUpdate', { requests: [{ appendCells: { sheetId, rows: [{ values: cells }], fields: 'userEnteredValue,textFormatRuns' } }] });
    },
    async remove(sheetId, row) {
      if (!Number.isInteger(row) || row < 1) throw new Error('Ligne invalide.');
      await call(base + ':batchUpdate', { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: row, endIndex: row + 1 } } }] });
    },
    async write(sheetId, rowIndex, columnIndex, cell, fields) {
      await call(base + ':batchUpdate', { requests: [{ updateCells: {
        start: { sheetId, rowIndex, columnIndex }, rows: [{ values: [cell] }], fields,
      } }] });
    },
  };
}
