import { tableBlocks } from './slack-blocks.js';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readConfig } from '../src/app/config.js';
import { createModules } from '../src/app/modules.js';
import { dispatchJob } from '../src/core/dispatch.js';
import { Budget } from '../src/core/budget.js';
import { createServer } from '../src/core/server.js';
import { Slack } from '../src/core/slack.js';
import { logicalAction } from '../src/core/presentation.js';
import { coreSchema, JobStore, type Sql } from '../src/core/store.js';

const alice = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
const bob = { ...alice, user: 'UBOB', channel: 'DBOB' };
const env = { PUBLIC_URL: 'https://agent.example.com', DATABASE_URL: 'postgresql://unused', SLACK_TEAM_ID: 'TTEAM', SLACK_BOT_TOKEN: 'token', SLACK_SIGNING_SECRET: 'secret', ENABLED_MODULES: 'documentation' };
let db: PGlite, sql: Sql;
beforeAll(async () => { db = new PGlite(); sql = { query: (text, values) => db.query(text, values) }; await db.exec(coreSchema); });
beforeEach(async () => {
  await db.exec(`TRUNCATE jobs,ai_calls,ai_months,core_navigation_menus,core_navigation_deliveries,core_operation_slots CASCADE;
    DROP TABLE IF EXISTS documentation_questions,documentation_project_context,documentation_record_history,documentation_records,documentation_history,documentation_projects,documentation_confirmations,documentation_deliveries,documentation_lookups CASCADE;`);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external provider call'); }));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => db.close());

type Posted = { method: string; body: any; ts: string; controls?: any[] };
function parts(message: Posted): any[] { return tableBlocks(message.body.blocks).flatMap((block: any) => block.child_blocks ?? [block]); }
function buttons(message: Posted): any[] { return message.controls ?? parts(message).flatMap(block => block.type === 'actions' ? block.elements.flatMap((element: any) => element.type === 'static_select' ? element.options.map((option: any) => ({ ...element, text: option.text, selected_option: option, value: option.value })) : [{ ...element, text: { ...element.text, text: element.text.text.replace(/^(?:🧭|\?) /, '') } }]) : block.type === 'data_table' ? block.rows.slice(1).flatMap((row: any[]) => row.filter(cell => cell.type === 'action_cell').map(cell => ({ ...cell.element, text: { ...cell.element.text, text: rowName(block.rows[0].map(cellValue), row) } }))) : []); }
function rowName(columns: string[], row: any[]): string { return cellValue(row[columns[0] === 'Champ' && columns[1] === 'Valeur' ? 1 : Math.max(0, columns.indexOf('Nom'))]); }
function findButton(message: Posted, label: string) {
  const direct = buttons(message).find(item => item.text.text.replace(/^(?:🧭|\?) /, '') === label)
    ?? buttons(message).find(item => item.type === 'static_select' && item.text.text.replace(/^\d+\. /, '').split(' / ').includes(label));
  if (direct) return direct;
  const table = parts(message).find(block => block.type === 'data_table');
  const row = table?.rows.slice(1).find((candidate: any[]) => rowName(table.rows[0].map(cellValue), candidate) === label);
  return row?.find((cell: any) => cell.type === 'action_cell')?.element;
}
function button(message: Posted, label: string) { const found = findButton(message, label); expect(found, `${label}; available: ${buttons(message).map(item => item.text.text).join(', ')}`).toBeTruthy(); return found; }
function cellValue(cell: any): string { return typeof cell === 'string' ? cell : Array.isArray(cell) ? cell.map(part => part.text).join('') : cell.type === 'rich_text' ? cell.elements.flatMap((section: any) => section.elements.map((part: any) => part.text)).join('') : cell.type === 'action_cell' ? cell.fallback.text : cell.text; }
function bodyText(message: Posted): string { return parts(message).map(block => block.type === 'rich_text' ? block.elements.flatMap((section: any) => section.elements.map((part: any) => part.text)).join('\n') : ['table', 'data_table'].includes(block.type) ? block.rows.slice(1).map((row: any[]) => row.length === 3 && cellValue(block.rows[0][1]) === "Avant" ? `${cellValue(row[0])}: ${cellValue(row[2])}\n${cellValue(row[0])} (before): ${cellValue(row[1])}` : row.filter(cell => cell.type !== 'action_cell').map(cellValue).join(': ')).join('\n') : '').filter(Boolean).join('\n'); }
const fieldLabel = (value: string) => ({ notes: "Notes", type: "Type", environment: "Environnement", usage: "Utilisation", role: "Rôle", description: "Description", referent: "Référent" })[value] ?? value;
function visibleLinks(message: Posted): string[] {
  const urls: string[] = [];
  const visit = (value: any) => { if (!value || typeof value !== 'object') return; if (value.type === 'link') urls.push(value.url); for (const item of Object.values(value)) { if (Array.isArray(item)) item.forEach(visit); else if (item && typeof item === 'object') visit(item); } };
  tableBlocks(message.body.blocks).forEach(visit); return urls;
}
function tableRows(message: Posted): Record<string, string>[] {
  const table = parts(message).find(block => ['table', 'data_table'].includes(block.type));
  return table ? table.rows.slice(1).map((row: any[]) => Object.fromEntries(row.filter(cell => cell.type !== 'action_cell').map((cell, index) => [cellValue(table.rows[0][index]), cellValue(cell)]))) : [];
}
async function recordId(message: Posted): Promise<string> {
  const control = buttons(message).find(item => /:confirm_|:open_confirmation_record$/.test(logicalAction(item.action_id) ?? ''));
  if (control) return (await sql.query('SELECT target_id FROM documentation_confirmations WHERE id=$1', [control.value])).rows[0].target_id;
  const lifecycle = buttons(message).find(item => /:request_(archive|restore)$/.test(logicalAction(item.action_id) ?? ''));
  expect(lifecycle, 'record identity control').toBeTruthy();
  return lifecycle.value.split('|')[1].split(':')[1];
}
function comparisonValues(message: Posted) {
  const table = parts(message).find(block => ['table', 'data_table'].includes(block.type));
  expect(table?.rows[0].map(cellValue)).toEqual(["Champ", "Avant", "Après"]);
  return Object.fromEntries(table.rows.slice(1).map((row: any[]) => [cellValue(row[0]), [cellValue(row[1]), cellValue(row[2])]]));
}
function kind(message: Posted): string { return message.body.blocks[0]?.title?.text; }

async function harness(enabled = 'documentation', team = 'TTEAM', aiEnv: NodeJS.ProcessEnv = {}) {
  const moduleEnv = { ...env, ...aiEnv, ENABLED_MODULES: enabled, SLACK_TEAM_ID: team };
  const config = readConfig(moduleEnv);
  let modules = createModules(config, sql, moduleEnv);
  const initialize = async () => { for (const module of modules.all()) await module.initialize?.({ query: async text => (await db.exec(text)).at(-1)! }); };
  await initialize();
  const jobs = new JobStore(sql);
  let app = createServer(config, jobs, modules);
  const messages: Posted[] = [];
  let failure: 'reject' | 'uncertain' | undefined;
  const slack = new Slack('token', (async (url, options) => {
    const method = String(url).split('/').at(-1)!;
    expect(['chat.postMessage', 'chat.update']).toContain(method);
    const outcome = failure; failure = undefined;
    if (outcome === 'reject') return Response.json({ ok: false, error: 'ratelimited' });
    const body = JSON.parse(String(options?.body)), ts = body.ts ?? `1234567890.${messages.length + 1}`;
    const values: string[] = [];
    const collect = (value: any) => { if (!value || typeof value !== 'object') return; if (typeof value.value === 'string') values.push(value.value); for (const item of Object.values(value)) { if (Array.isArray(item)) item.forEach(collect); else if (item && typeof item === 'object') collect(item); } };
    body.blocks.forEach(collect);
    const id = values.filter(value => value.includes('|')).map(value => value.split('|')[0]).find(value => /^[0-9a-f-]{36}$/.test(value));
    const saved = id ? (await sql.query('SELECT content FROM core_navigation_menus WHERE id=$1', [id])).rows[0]?.content as { buttons?: Array<{ label: string; action: string; value: string }>; table?: { columns: string[]; rows: any[][]; rowButtons?: Array<{ label: string; action: string; value: string }> } } | undefined : undefined;
    const controls = saved ? [...(saved.buttons ?? []).map(button => ({ type: 'button', action_id: button.action, value: button.value, text: { text: button.label } })),
      ...(saved.table?.rowButtons ?? []).flatMap((button, index) => button ? [{ type: 'button', action_id: button.action, value: button.value, text: { text: rowName(saved.table!.columns, saved.table!.rows[index]!) } }] : [])] : undefined;
    messages.push({ method, body, ts, controls });
    if (outcome === 'uncertain') throw new Error('Lost response after delivery');
    return Response.json({ ok: true, ts });
  }) as typeof fetch);
  const post = (path: string, raw: string, type: string, signed = true) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return app.inject({ method: 'POST', url: path, payload: raw, headers: { 'content-type': type, 'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signed ? `v0=${createHmac('sha256', 'secret').update(`v0:${timestamp}:${raw}`).digest('hex')}` : 'bad' } });
  };
  const enqueueText = (text: string, actor = alice, signed = true, id = randomUUID()) => post('/slack/events', JSON.stringify({ type: 'event_callback', team_id: actor.team, event_id: id, authorizations: [{ is_bot: true, user_id: 'UMAYA' }],
    event: { type: 'message', ts: '123.456', channel_type: actor.channel.startsWith('D') ? 'im' : 'channel', user: actor.user, channel: actor.channel, text } }), 'application/json', signed);
  const enqueueClick = (message: Posted, control: any, actor = alice, signed = true) => post('/slack/actions', new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: actor.team }, user: { id: actor.user }, channel: { id: actor.channel }, message: { ts: message.ts },
    action_ts: randomUUID(), actions: [{ action_id: control.action_id, ...(control.type === 'static_select' ? { type: control.type, selected_option: { ...control.selected_option, value: control.value } } : { value: control.value }) }] }) }).toString(), 'application/x-www-form-urlencoded', signed);
  const drain = async () => {
    for (const job of (await sql.query("SELECT * FROM jobs WHERE status='queued' AND available_at<=now() ORDER BY created_at,id")).rows) {
      if (!modules.enabledIds().includes(job.module)) continue;
      await dispatchJob(sql, config, modules, slack, job); await jobs.complete(job.id);
    }
    return messages.at(-1)!;
  };
  const dm = async (text: string, actor = alice) => { expect((await enqueueText(text, actor)).statusCode).toBe(200); return drain(); };
  const click = async (message: Posted, label: string, actor = alice) => {
    let current = message;
    for (let page = 0; page < 30 && !findButton(current, label); page++) {
      const next = findButton(current, 'Actions ▶');
      expect(next, `Action ${label} unavailable; visible: ${buttons(current).map(item => item.text.text).join(', ')}; kind: ${kind(current)}`).toBeTruthy();
      expect((await enqueueClick(current, next, actor)).statusCode).toBe(200);
      current = await drain();
    }
    expect((await enqueueClick(current, button(current, label), actor)).statusCode).toBe(200);
    return drain();
  };
  return { get app() { return app; }, messages, dm, click, enqueueText, enqueueClick, drain, fail: (outcome: typeof failure) => { failure = outcome; },
    restart: async (ids = enabled) => { await app.close(); modules = createModules(readConfig({ ...moduleEnv, ENABLED_MODULES: ids }), sql, { ...moduleEnv, ENABLED_MODULES: ids }); await initialize(); app = createServer(config, jobs, modules); } };
}

function interpreter(plan: unknown) {
  const provider = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    if (String(url).endsWith('/input_tokens')) return Response.json({ input_tokens: 100 });
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
    expect(JSON.parse(String(options?.body))).toMatchObject({ store: false, service_tier: 'default', truncation: 'disabled' });
    return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 30 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify(plan) }] }] });
  });
  vi.stubGlobal('fetch', provider);
  return provider;
}

it('uses French commands and presentation through signed routing while preserving literal values and old controls', async () => {
  const h = await harness();
  try {
    const fields = { name: 'aide', description: 'Original English content — do not translate', repositories: ['https://example.com/original?name=help'] };
    const proposal = await h.dm(`documentation créer projet ${JSON.stringify(fields)}`);
    expect(kind(proposal)).toBe('Confirmation de création du projet');
    expect(bodyText(proposal)).toMatch(/Expiration : \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} \(Europe\/Paris\)/);
    expect((await sql.query('SELECT fields FROM documentation_confirmations WHERE id=$1', [button(proposal, 'Confirmer la création').value])).rows[0].fields).toMatchObject(fields);
    const legacy = { ...button(proposal, 'Confirmer la création'), action_id: 'documentation:confirm_create' };
    expect((await h.enqueueClick(proposal, legacy)).statusCode).toBe(200);
    const created = await h.drain(), id = await recordId(created);
    const list = await h.dm('documentation projets');
    const details = await h.click(list, 'aide');
    expect(bodyText(details)).toContain(fields.description);
    expect(visibleLinks(details)).toEqual(fields.repositories);
    const actions = parts(details).filter(block => block.type === 'actions');
    expect(actions.length).toBeGreaterThan(1);
    expect(actions.every(block => block.elements.length <= 5)).toBe(true);
    const controls = actions.flatMap(block => block.elements);
    expect(new Set(controls.map((element: any) => element.action_id)).size).toBe(controls.length);
    const edit = await h.dm('documentation modifier projet aide {"notes":"Valeur approuvée"}');
    await h.click(edit, 'Confirmer la modification');
    expect((await sql.query('SELECT fields FROM documentation_projects WHERE id=$1', [id])).rows[0].fields).toMatchObject({ ...fields, notes: 'Valeur approuvée' });
    const archive = await h.dm('documentation archiver projet aide');
    const malformed = { ...button(archive, 'Confirmer l’archivage'), action_id: 'documentation:confirm_archive_project~button-01' };
    expect((await h.enqueueClick(archive, malformed)).statusCode).toBe(400);
    expect((await sql.query('SELECT archived FROM documentation_projects WHERE id=$1', [id])).rows[0].archived).toBe(false);
    await h.click(archive, 'Confirmer l’archivage');
    await h.click(await h.dm('documentation restaurer projet aide'), 'Confirmer la restauration');
    expect((await sql.query('SELECT archived FROM documentation_projects WHERE id=$1', [id])).rows[0].archived).toBe(false);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('displays French amounts without rounding or rewriting the saved cost and currency', async () => {
  const h = await harness();
  try {
    const fields = { name: 'Compute', monthlyCost: 1234.567891, currency: 'USD' };
    const proposal = await h.dm(`documentation créer hébergeur ${JSON.stringify(fields)}`);
    expect(tableRows(proposal).find(row => row.Champ === 'Coût mensuel')?.Valeur).toBe('1 234,567891');
    const created = await h.click(proposal, 'Confirmer la création'), id = await recordId(created);
    expect((await sql.query('SELECT fields FROM documentation_records WHERE id=$1', [id])).rows[0].fields).toMatchObject(fields);
    expect(tableRows(await h.dm('documentation hébergeurs'))[0]['Coût mensuel']).toBe('1 234,567891 USD');
    const filtered = await h.dm(`documentation rechercher ${JSON.stringify({ target: 'host', fields: [{ field: 'monthlyCost', value: fields.monthlyCost }] })}`);
    expect(bodyText(filtered)).toContain('monthlyCost = 1 234,567891');
    expect(tableRows(filtered)[0]['Coût mensuel']).toBe('1 234,567891 USD');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('renders native top-level tables with private row buttons, clickable saved links and hidden identities', async () => {
  const h = await harness();
  try {
    const proposal = await h.dm('documentation create project {"name":"Alpha","repositories":["https://example.com/alpha?branch=main"],"documentationLinks":["http://docs.example.com/alpha"]}');
    const id = await recordId(proposal);
    expect(bodyText(proposal) + proposal.body.text).not.toContain(id);
    expect(visibleLinks(proposal)).toEqual(['https://example.com/alpha?branch=main', 'http://docs.example.com/alpha']);
    await h.click(proposal, "Confirmer la création");
    const list = await h.dm('documentation projects');
    const table = tableBlocks(list.body.blocks).find((block: any) => block.type === 'data_table');
    expect(table.rows[0].map(cellValue)).toEqual(["Nom", "Description", "Liens", "Actions"]);
    expect(table.rows).toHaveLength(2);
    expect(tableBlocks(list.body.blocks).filter((block: any) => block.type === 'data_table')).toHaveLength(1);
    expect(table.rows[1][3].type).toBe('action_cell');
    expect(parts(list).filter(block => block.type === 'actions').flatMap(block => block.elements).filter((element: any) => element.type === 'static_select')).toHaveLength(0);
    expect(parts(list).filter(block => block.type === 'actions').flatMap(block => block.elements).filter((element: any) => element.type === 'button').some((element: any) => element.text.text === 'Alpha')).toBe(false);
    expect(bodyText(list) + list.body.text).not.toContain(id);
    expect(visibleLinks(list)).toContain('https://example.com/alpha?branch=main');
    const control = button(list, 'Alpha');
    expect((await h.enqueueClick(list, control, alice, false)).statusCode).toBe(401);
    expect(kind(await h.click(list, 'Alpha', bob))).toBe("Menu indisponible");
    expect(kind(await h.click(list, 'Alpha', { ...alice, channel: 'DOTHER' }))).toBe("Menu indisponible");
    const wrongTimestamp = { ...list, ts: '1234567890.999999' };
    await h.enqueueClick(wrongTimestamp, control); expect(kind(await h.drain())).toBe("Menu indisponible");
    const details = await h.click(list, 'Alpha');
    expect(details.method).toBe('chat.update'); expect(details.ts).toBe(list.ts);
    expect(await recordId(details)).toBe(id);
    expect(visibleLinks(details)).toEqual(['https://example.com/alpha?branch=main', 'http://docs.example.com/alpha']);
    const action = { ...button(proposal, "Confirmer la création"), type: 'static_select', selected_option: { value: button(proposal, "Confirmer la création").value } };
    expect((await h.enqueueClick(proposal, action)).statusCode).toBe(400);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('labels current relationship names in saved comparisons without changing identities and hides unavailable references', async () => {
  const h = await harness();
  try {
    const parent = await recordId(await h.click(await h.dm("documentation créer projet {\"name\":\"Alpha\"}"), "Confirmer la création"));
    const technology = await recordId(await h.click(await h.dm("documentation créer technologie {\"name\":\"React\"}"), "Confirmer la création"));
    const component = await recordId(await h.click(await h.dm(`documentation créer composant ${JSON.stringify({ name: 'Web', projectId: parent, technologies: ['React'] })}`), "Confirmer la création"));
    const proposal = await h.dm(`documentation edit component ${component} {"technologies":[]}`);
    await h.click(await h.dm('documentation modifier technology React {"name":"React UI"}', bob), "Confirmer la modification", bob);
    const review = await h.click(proposal, "Examiner les valeurs");
    expect(comparisonValues(review).Technologies).toEqual(['React UI (nom actuel)', "Aucun élément enregistré"]);
    expect(bodyText(review) + review.body.text).not.toContain(technology);
    await h.click(proposal, "Confirmer la modification");
    const history = await h.click(await h.dm(`documentation history component ${component}`), "Suivant");
    expect(comparisonValues(history).Technologies).toEqual(['React UI (nom actuel)', "Aucun élément enregistré"]);
    expect((await sql.query('SELECT before_values FROM documentation_record_history WHERE id=$1', [button(proposal, "Confirmer la modification").value])).rows[0].before_values.technologies).toEqual([technology]);
    const foreign = randomUUID();
    await sql.query('INSERT INTO documentation_records(team,id,kind,fields) VALUES($1,$2,$3,$4)', ['TOTHER', foreign, 'technology', JSON.stringify({ name: 'Private foreign name', category: null, notes: null })]);
    await sql.query('UPDATE documentation_confirmations SET before_values=$2 WHERE id=$1', [button(proposal, "Confirmer la modification").value, JSON.stringify({ technologies: [foreign] })]);
    const unavailable = await h.click(proposal, "Examiner les valeurs");
    expect(comparisonValues(unavailable).Technologies).toEqual(["Fiche référencée indisponible", "Aucun élément enregistré"]);
    expect(bodyText(unavailable) + unavailable.body.text).not.toContain(foreign);
    expect(bodyText(unavailable)).not.toContain('Private foreign name');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('preserves all long relationship comparison values across native table pages within Slack limits', async () => {
  const h = await harness();
  try {
    const urls = Array.from({ length: 12 }, (_, i) => `https://example.com/${'a'.repeat(375)}${String(i).padStart(2, '0')}`);
    const creation = await h.dm(`documentation create project ${JSON.stringify({ name: 'Link review', repositories: urls.slice(0, 6), documentationLinks: urls.slice(6) })}`);
    expect(bodyText(creation)).toContain('Link review');
    expect(visibleLinks(creation)).toEqual(urls);
    expect((await sql.query('SELECT applied_at FROM documentation_confirmations WHERE id=$1', [button(creation, "Confirmer la création").value])).rows[0].applied_at).toBeNull();
    const parent = await recordId(await h.click(await h.dm("documentation créer projet {\"name\":\"Large stack\"}"), "Confirmer la création"));
    const technologies = Array.from({ length: 50 }, (_, i) => ({ id: randomUUID(), name: `Technology ${String(i).padStart(2, '0')} ${'x'.repeat(175)}` }));
    for (const technology of technologies) await sql.query('INSERT INTO documentation_records(team,id,kind,fields) VALUES($1,$2,$3,$4)', [alice.team, technology.id, 'technology', JSON.stringify({ name: technology.name, category: null, notes: null })]);
    const ids = technologies.map(record => record.id);
    await h.click(await h.dm(`documentation créer composant ${JSON.stringify({ name: 'App', projectId: parent, technologies: ids })}`), "Confirmer la création");
    const proposal = await h.dm(`documentation edit component App ${JSON.stringify({ technologies: ids.slice().reverse() })}`);
    expect(bodyText(proposal)).toContain("Ouvrez Examiner les valeurs");
    const confirmation = button(proposal, "Confirmer la modification").value;
    const before = (await sql.query('SELECT created_at,applied_at FROM documentation_confirmations WHERE id=$1', [confirmation])).rows[0];
    let page = await h.click(proposal, "Examiner les valeurs"), original = '', replacement = '', pages = 0;
    while (true) {
      const table = tableBlocks(page.body.blocks).find((block: any) => block.type === 'data_table');
      expect(table).toBeTruthy();
      const nativeSize = JSON.stringify(table.rows);
      expect(nativeSize).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      expect(table.rows.flat().reduce((sum: number, cell: any) => sum + cellValue(cell).length, 0)).toBeLessThanOrEqual(20_000);
      for (const row of table.rows.slice(1)) { original += cellValue(row[1]); replacement += cellValue(row[2]); }
      pages++;
      if (!buttons(page).some(control => control.text.text === "Valeurs suivantes")) break;
      page = await h.click(page, "Valeurs suivantes");
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBeGreaterThan(1);
    expect(original).toBe(technologies.map(record => `${record.name} (nom actuel)`).join('\n'));
    expect(replacement).toBe(technologies.slice().reverse().map(record => `${record.name} (nom actuel)`).join('\n'));
    expect((await sql.query('SELECT created_at,applied_at FROM documentation_confirmations WHERE id=$1', [confirmation])).rows[0]).toEqual(before);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it.each(['project', 'technology', 'component', 'host', 'hosting', 'tool'] as const)('saves %s edit before-values for confirmation and retains them through retry and overwrite', async recordKind => {
  const h = await harness();
  try {
    const project = await h.click(await h.dm("documentation créer projet {\"name\":\"Parent\"}"), "Confirmer la création");
    const projectId = await recordId(project);
    await h.click(await h.dm("documentation créer hébergeur {\"name\":\"Compute\"}"), "Confirmer la création");
    const component = await h.click(await h.dm(`documentation créer composant ${JSON.stringify({ name: 'Web', projectId })}`), "Confirmer la création");
    const componentId = await recordId(component);
    const field = recordKind === 'component' ? 'type' : recordKind === 'hosting' ? 'environment' : 'notes';
    const fields = recordKind === 'hosting' ? { componentId, serviceId: 'Compute', [field]: 'Original' }
      : recordKind === 'component' ? { name: 'Target', projectId, [field]: 'Original' } : { name: 'Target', [field]: 'Original' };
    const created = await h.click(await h.dm(`documentation create ${recordKind} ${JSON.stringify(fields)}`), "Confirmer la création");
    const id = await recordId(created);
    const event = randomUUID();
    await h.enqueueText(`documentation edit ${recordKind} ${id} ${JSON.stringify({ [field]: 'Replacement' })}`, alice, true, event);
    h.fail('reject');
    await expect(h.drain()).rejects.toThrow('rejected');
    const pending = (await sql.query("SELECT id FROM jobs WHERE status='queued'")).rows[0];
    await sql.query("UPDATE jobs SET status='running' WHERE id=$1", [pending.id]);
    await h.click(await h.dm(`documentation edit ${recordKind} ${id} ${JSON.stringify({ [field]: 'Intervening' })}`, bob), "Confirmer la modification", bob);
    await h.restart();
    await sql.query("UPDATE jobs SET status='queued' WHERE id=$1", [pending.id]);
    const proposal = await h.drain();
    expect(comparisonValues(proposal)).toEqual({ [fieldLabel(field)]: ['Original', 'Replacement'] });
    const saved = (await sql.query('SELECT before_values FROM documentation_confirmations WHERE id=$1', [button(proposal, "Confirmer la modification").value])).rows[0];
    expect(saved.before_values).toEqual({ [field]: 'Original' });
    await h.click(proposal, "Confirmer la modification");
    const history = (await sql.query(`SELECT before_values,after_values FROM ${recordKind === 'project' ? 'documentation_history' : 'documentation_record_history'} WHERE id=$1`, [button(proposal, "Confirmer la modification").value])).rows[0];
    expect(history.before_values).toEqual({ [field]: 'Intervening' });
    expect(history.after_values).toEqual({ [field]: 'Replacement' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it.each(['technology', 'component'] as const)('guides saved inventory pages when a %s selector becomes archived and resumes after restoration', async referenceKind => {
  const h = await harness();
  try {
    const creation = await h.click(await h.dm("documentation créer technologie {\"name\":\"React\"}"), "Confirmer la création");
    const technologyId = await recordId(creation);
    let componentId = '';
    for (let index = 0; index < 9; index++) {
      const project = await h.click(await h.dm(`documentation créer projet {\"name\":\"Alpha ${index}"}`), "Confirmer la création");
      const projectId = await recordId(project);
      const component = await h.click(await h.dm(`documentation créer composant ${JSON.stringify({ name: `Web ${index}`, projectId, technologies: ['React'] })}`), "Confirmer la création");
      componentId = await recordId(component);
    }
    const selector = referenceKind === 'technology' ? technologyId : componentId;
    const query = { target: referenceKind === 'technology' ? 'project' : 'technology',
      filters: referenceKind === 'technology' ? [{ kind: 'technology', selector }] : [],
      ...(referenceKind === 'component' ? { component: selector } : {}) };
    const first = await h.dm(`documentation search ${JSON.stringify(query)}`);
    // Reopen the saved query through its owner-bound menu after the reference changes.
    const questionId = (await sql.query('SELECT id FROM documentation_questions ORDER BY created_at DESC LIMIT 1')).rows[0].id;
    const recordControl = button(first, 'Fiches des filtres');
    const next = { ...recordControl, value: `${recordControl.value.split('|')[0]}|documentation:question_${questionId}_0` };
    await h.click(await h.dm(`documentation archive ${referenceKind} ${selector}`, bob), 'Confirmer l’archivage', bob);
    await h.enqueueClick(first, next);
    const unavailable = await h.drain();
    expect(kind(unavailable)).toBe("Filtre introuvable");
    expect(bodyText(unavailable)).toContain("Les références inconnues ou archivées ne sont pas comptées comme zéro correspondance");
    expect(bodyText(unavailable)).not.toContain('Total matching');
    const included = await h.dm(`documentation count ${JSON.stringify({ ...query, includeArchived: true })}`);
    expect(bodyText(included)).toContain(`Total de fiches correspondantes — ${referenceKind === 'technology' ? "Projet" : "Technologie"} : ${referenceKind === 'technology' ? 9 : 1}`);
    await h.click(await h.dm(`documentation restore ${referenceKind} ${selector}`, bob), 'Confirmer la restauration', bob);
    await h.enqueueClick(first, next);
    expect(kind(await h.drain())).toBe("Réponse de l’inventaire");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it.each(['project', 'tool'] as const)('pages complete %s before/after comparisons privately without refreshing confirmation expiry', async recordKind => {
  const h = await harness();
  try {
    const fields = recordKind === 'project' ? ['description', 'notes'] : ['usage', 'referent', 'notes'];
    const original = Object.fromEntries(fields.map(field => [field, `Original ${field}:` + '*'.repeat(1400) + ` END ORIGINAL ${field}`]));
    const replacement = Object.fromEntries(fields.map(field => [field, `Replacement ${field}:` + '_'.repeat(1400) + ` END REPLACEMENT ${field}`]));
    await h.click(await h.dm(`documentation create ${recordKind} {"name":"Long comparison"}`), "Confirmer la création");
    for (const field of fields) await h.click(await h.dm(`documentation edit ${recordKind} Long comparison ${JSON.stringify({ [field]: original[field] })}`), "Confirmer la modification");
    const proposal = await h.dm(`documentation edit ${recordKind} Long comparison ${JSON.stringify(replacement)}`);
    expect(button(proposal, "Examiner les valeurs")).toBeTruthy();
    const confirmationId = button(proposal, "Confirmer la modification").value;
    const before = (await sql.query('SELECT created_at,applied_at FROM documentation_confirmations WHERE id=$1', [confirmationId])).rows[0];
    expect(kind(await h.click(proposal, "Examiner les valeurs", bob))).toBe("Confirmation indisponible");
    expect(kind(await h.click(proposal, "Examiner les valeurs", { ...alice, channel: 'DOTHER' }))).toBe("Confirmation indisponible");
    let values = await h.click(proposal, "Examiner les valeurs");
    expect(values.ts).toBe(proposal.ts);
    let combined = bodyText(values), count = 1;
    while (buttons(values).some(control => control.text.text === "Valeurs suivantes")) {
      values = await h.click(values, "Valeurs suivantes");
      expect(bodyText(values).length).toBeLessThan(12_000);
      combined += '\n' + bodyText(values);
      expect(++count).toBeLessThan(10);
    }
    for (const field of fields) {
      expect(combined).toContain(`${fieldLabel(field)} (before): ${original[field]}`);
      expect(combined).toContain(`${fieldLabel(field)}: ${replacement[field]}`);
    }
    const after = (await sql.query('SELECT created_at,applied_at FROM documentation_confirmations WHERE id=$1', [confirmationId])).rows[0];
    expect(after).toEqual(before);
    const reviewed = await h.click(values, "Retour à la confirmation");
    expect(reviewed.ts).toBe(proposal.ts);
    expect(button(reviewed, "Confirmer la modification").value).toBe(confirmationId);
    expect((await sql.query('SELECT created_at,applied_at FROM documentation_confirmations WHERE id=$1', [confirmationId])).rows[0]).toEqual(before);
    expect(kind(await h.click(values, "Retour à la confirmation", bob))).toBe("Confirmation indisponible");
    await h.click(reviewed, "Confirmer la modification");
    expect((await sql.query('SELECT applied_at FROM documentation_confirmations WHERE id=$1', [confirmationId])).rows[0].applied_at).not.toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('labels missing before-values on older confirmations without inventing them on replay', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Legacy\",\"notes\":\"Original\"}"), "Confirmer la création");
    const proposal = await h.dm('documentation edit project Legacy {"notes":"Replacement"}');
    const id = button(proposal, "Confirmer la modification").value;
    await sql.query('UPDATE documentation_confirmations SET before_values=NULL WHERE id=$1', [id]);
    await h.click(await h.dm("documentation modifier projet Legacy {\"notes\":\"Changed\"}", bob), "Confirmer la modification", bob);
    await h.restart();
    const values = await h.click(proposal, "Examiner les valeurs");
    expect(bodyText(values)).toContain('Indisponible pour cette ancienne confirmation');
    expect(bodyText(values)).toContain('Notes: Replacement');
    expect(bodyText(values)).not.toContain('Notes: Changed');
    await h.click(proposal, "Confirmer la modification");
    expect(bodyText(await h.dm('documentation project Legacy'))).toContain('Notes: Replacement');
  } finally { await h.app.close(); }
});

it('preserves free exact lifecycle commands for names beginning with conversational selector words', async () => {
  const h = await harness();
  try {
    for (const name of ['Italy', 'Item', 'this project staging', 'named Alpha', 'this project']) {
      await h.click(await h.dm(`documentation créer projet ${JSON.stringify({ name })}`), "Confirmer la création");
      expect(kind(await h.click(await h.dm(`documentation archive project ${name}`), 'Confirmer l’archivage'))).toBe("Projet : archivage enregistré");
      expect(kind(await h.click(await h.dm(`documentation restore project ${name}`), 'Confirmer la restauration'))).toBe("Projet : restauration enregistrée");
    }
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('counts distinct Projects with Technology and Host matches across separate Components through free queries', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer technologie {\"name\":\"React\"}"), "Confirmer la création");
    await h.click(await h.dm("documentation créer hébergeur {\"name\":\"Compute\"}"), "Confirmer la création");
    await h.click(await h.dm("documentation créer projet {\"name\":\"Alpha\"}"), "Confirmer la création");
    const projectId = await recordId(await h.dm('documentation project Alpha'));
    for (const name of ['Web', 'Other web'])
      await h.click(await h.dm(`documentation créer composant ${JSON.stringify({ name, projectId, technologies: ['React'] })}`), "Confirmer la création");
    await h.click(await h.dm(`documentation créer composant ${JSON.stringify({ name: 'API', projectId })}`), "Confirmer la création");
    const componentId = await recordId(await h.dm('documentation component API'));
    for (const environment of ['production', 'staging'])
      await h.click(await h.dm(`documentation créer hébergement ${JSON.stringify({ componentId, serviceId: 'Compute', environment })}`), "Confirmer la création");
    const query = { target: 'project', filters: [{ kind: 'technology', selector: 'React' }, { kind: 'host', selector: 'Compute' }], scope: 'project' };
    const answer = await h.dm(`documentation search ${JSON.stringify(query)}`);
    expect(kind(answer)).toBe("Réponse de l’inventaire");
    expect(bodyText(answer)).toContain("Total de fiches correspondantes — Projet : 1");
    expect(bodyText(answer)).toContain('Alpha');
    expect(bodyText(await h.dm(`documentation count ${JSON.stringify(query)}`))).toContain("Total de fiches correspondantes — Projet : 1");
    expect(bodyText(await h.dm(`documentation count ${JSON.stringify({ ...query, scope: 'same-component' })}`))).toContain("Total de fiches correspondantes — Projet : 0");
    expect(bodyText(await h.dm(`documentation count ${JSON.stringify({ ...query, environment: 'production' })}`))).toContain("Total de fiches correspondantes — Projet : 1");
    expect(bodyText(await h.dm(`documentation count ${JSON.stringify({ ...query, component: 'Web' })}`))).toContain("Total de fiches correspondantes — Projet : 0");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('pages complete current matches without paying again and restarts coverage after edits', async () => {
  const h = await harness('documentation', 'TTEAM', { OPENAI_API_KEY: 'fake' });
  try {
    for (let i = 0; i < 42; i++)
      await h.click(await h.dm(`documentation créer projet ${JSON.stringify({ name: `Project ${i}`, repositories: ['https://example.com/repo'] })}`), "Confirmer la création");
    const provider = vi.mocked(fetch);
    const first = await h.dm('documentation search {"target":"project"}');
    expect(bodyText(first)).toContain("Total de fiches correspondantes — Projet : 42");
    expect(bodyText(first)).toContain('fiches 1–40 sur 42');
    expect(bodyText(first)).not.toContain('Project 8');
    expect(buttons(first).map(b => b.text.text.replace(/^\d+\. /, ''))).toContain('Project 0');
    expect(JSON.stringify(parts(first))).toContain('https://example.com/repo');
    expect(kind(await h.click(first, "Suivant", bob))).toBe("Menu indisponible");
    expect(kind(await h.click(first, "Suivant", { ...alice, channel: 'DOTHER' }))).toBe("Menu indisponible");
    await h.restart();
    const second = await h.click(first, "Suivant");
    expect(bodyText(second)).toContain('fiches 41–42 sur 42');
    expect(bodyText(second)).toContain('Project 8');
    expect(bodyText(second)).toContain('Project 9');
    expect(provider).not.toHaveBeenCalled();
    await h.click(await h.dm('documentation archive project Project 0', bob), 'Confirmer l’archivage', bob);
    await h.enqueueClick(first, button(first, "Suivant"));
    h.fail('reject');
    await expect(h.drain()).rejects.toThrow('Slack delivery was rejected');
    const changed = await h.drain();
    expect(bodyText(changed)).toContain('L’inventaire a changé depuis la page précédente');
    expect(bodyText(changed)).toContain('fiches 1–40 sur 41');
    expect(bodyText(changed)).not.toContain("Projet : Project 0");
    const newLast = await h.click(changed, "Suivant");
    expect(bodyText(newLast)).toContain('fiches 41–41 sur 41');
    expect(provider).not.toHaveBeenCalled();
    expect(bodyText(await h.dm('documentation count {"target":"project","includeArchived":true}'))).toContain("Total de fiches correspondantes — Projet : 42");
    expect(bodyText(await h.dm('documentation search {"target":"project","includeArchived":true}'))).toContain("Project 0 [Archivé]");
  } finally { await h.app.close(); }
});

it('queries every relationship direction and keeps company-wide Outils separate from Project usage', async () => {
  const h = await harness();
  try {
    const create = async (kind: string, fields: unknown) => h.click(await h.dm(`documentation create ${kind} ${JSON.stringify(fields)}`), "Confirmer la création");
    const id = async (kind: string, name: string) => await recordId(await h.dm(`documentation ${kind} ${name}`));
    await create('project', { name: 'Alpha', aliases: ['A'] });
    await create('project', { name: 'Unlinked' });
    await create('technology', { name: 'React', category: 'Frontend' });
    await create('host', { name: 'Compute' });
    await create('host', { name: 'Other host' });
    const projectId = await id('project', 'Alpha');
    await create('component', { name: 'Web', projectId, type: 'frontend', technologies: ['React'] });
    const componentId = await id('component', 'Web');
    await create('hosting', { componentId, serviceId: 'Compute', environment: 'production', urls: ['https://example.com/app'] });
    await create('hosting', { componentId, serviceId: 'Compute', environment: 'staging' });
    await create('hosting', { componentId, serviceId: 'Other host', environment: 'other' });
    await create('tool', { name: 'Shared', companyWide: true, projects: ['A'] });
    await create('tool', { name: 'Company only', companyWide: true, projects: [] });
    await create('tool', { name: 'Project only', companyWide: false, projects: ['Alpha'] });
    await create('tool', { name: 'Unknown usage' });
    const cases = [
      ['project', 'technology', 'React', 1], ['project', 'host', 'Compute', 1], ['project', 'tool', 'Company only', 0],
      ['project', 'tool', 'Shared', 1], ['component', 'project', 'A', 1], ['component', 'host', 'Compute', 1],
      ['technology', 'project', 'Alpha', 1], ['technology', 'host', 'Compute', 1], ['technology', 'tool', 'Shared', 1],
      ['host', 'technology', 'React', 2], ['host', 'project', 'Alpha', 2], ['host', 'tool', 'Shared', 2],
      ['hosting', 'project', 'Alpha', 3], ['hosting', 'technology', 'React', 3], ['hosting', 'tool', 'Shared', 3],
      ['tool', 'project', 'Alpha', 2], ['tool', 'host', 'Compute', 2], ['tool', 'technology', 'React', 2],
    ] as const;
    const titles = { project: "Projet", component: "Composant", technology: "Technologie", host: "Hébergeur/service", hosting: "Hébergement", tool: "Outil" };
    for (const [target, relatedKind, selector, count] of cases) {
      const answer = await h.dm(`documentation count ${JSON.stringify({ target, filters: [{ kind: relatedKind, selector }] })}`);
      expect(bodyText(answer), `${target} via ${relatedKind}`).toContain(`Total de fiches correspondantes — ${titles[target]} : ${count}`);
    }
    expect(bodyText(await h.dm('documentation count {"target":"tool","fields":[{"field":"companyWide","value":true}]}'))).toContain("Total de fiches correspondantes — Outil : 2");
    expect(bodyText(await h.dm('documentation count {"target":"tool","fields":[{"field":"companyWide","value":null}]}'))).toContain("Total de fiches correspondantes — Outil : 1");
    expect(bodyText(await h.dm('documentation count {"target":"host","fields":[{"field":"monthlyCost","value":0}]}'))).toContain("Total de fiches correspondantes — Hébergeur/service : 0");
    expect(bodyText(await h.dm('documentation count {"target":"host","fields":[{"field":"monthlyCost","value":null}]}'))).toContain("Total de fiches correspondantes — Hébergeur/service : 2");
    expect(bodyText(await h.dm('documentation count {"target":"hosting","filters":[{"kind":"host","selector":"Compute"}],"component":"Web"}'))).toContain("Total de fiches correspondantes — Hébergement : 2");
    const filtered = await h.dm('documentation search {"target":"hosting","filters":[{"kind":"technology","selector":"React"}],"environment":"production"}');
    expect(bodyText(filtered)).toContain("Total de fiches correspondantes — Hébergement : 1");
    expect(JSON.stringify(parts(filtered))).toContain('https://example.com/app');
    expect(bodyText(await h.dm('documentation count {"target":"component","fields":[{"field":"type","value":"frontend"}]}'))).toContain("Total de fiches correspondantes — Composant : 1");
    await h.click(await h.dm('documentation archive technology React'), 'Confirmer l’archivage');
    expect(kind(await h.dm('documentation count {"target":"project","filters":[{"kind":"technology","selector":"React"}]}'))).toBe("Filtre introuvable");
    expect(bodyText(await h.dm('documentation search {"target":"technology","includeArchived":true,"filters":[{"kind":"project","selector":"Alpha"}]}'))).toContain("React [Archivé]");
    const archivedReference = await h.dm('documentation search {"target":"project","includeArchived":true,"filters":[{"kind":"technology","selector":"React"}]}');
    expect(bodyText(archivedReference)).toContain("Technologie: React [Archivé]");
    const filterRecords = await h.click(archivedReference, 'Fiches des filtres');
    expect(buttons(filterRecords).map(b => b.text.text)).toContain("React [Archivé]");
    expect(bodyText(await h.dm('documentation count {"target":"technology","filters":[{"kind":"project","selector":"Alpha"}]}'))).toContain("Total de fiches correspondantes — Technologie : 0");
    const foreign = await harness('documentation', 'TOTHER');
    try { expect(bodyText(await foreign.dm('documentation count {"target":"project"}', { ...alice, team: 'TOTHER' }))).toContain("Total de fiches correspondantes — Projet : 0"); }
    finally { await foreign.app.close(); }
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('keeps complete long-result values and private record controls', async () => {
  const h = await harness();
  try {
    for (let i = 0; i < 9; i++) await h.click(await h.dm(`documentation créer projet ${JSON.stringify({ name: `Long ${i}`, description: 'D'.repeat(1500), notes: 'N'.repeat(1500) })}`), "Confirmer la création");
    const first = await h.dm('documentation search {"target":"project"}');
    const text = bodyText(first);
    for (let i = 0; i < 9; i++) expect(text).toContain(`Long ${i}`);
    expect(text).toContain("D".repeat(1500)); expect(text).not.toContain("abrégé");
    expect(bodyText(await h.click(first, 'Long 7'))).toContain('D'.repeat(1500));
    expect(buttons(first).some(control => control.text.text === 'Suivant')).toBe(false);
  } finally { await h.app.close(); }
});

it('pages complete list values while retaining the correct record action on every page', async () => {
  const h = await harness();
  try {
    const names = Array.from({ length: 16 }, (_, i) => `Long ${String(i).padStart(2, '0')}`);
    for (const name of names) await sql.query('INSERT INTO documentation_projects(team,id,fields) VALUES($1,$2,$3)',
      [alice.team, randomUUID(), JSON.stringify({ name, description: name + 'D'.repeat(1400) })]);
    let current = await h.dm('documentation projects');
    const seen: string[] = [];
    for (let page = 0; page < 4; page++) {
      const table = parts(current).find(block => block.type === 'data_table');
      for (const row of table.rows.slice(1)) {
        const name = cellValue(row[0]); seen.push(name);
        expect(cellValue(row[1])).toBe(name + 'D'.repeat(1400));
        const detail = await h.click(current, name);
        expect(bodyText(detail)).toContain(name + 'D'.repeat(1400));
      }
      const next = buttons(current).find(control => control.text.text === 'Valeurs suivantes');
      if (!next) break;
      current = await h.click(current, 'Valeurs suivantes');
    }
    expect(seen).toEqual(names);
  } finally { await h.app.close(); }
});

it('keeps Tool identities and complete literal markup visible', async () => {
  const h = await harness();
  try {
    for (let i = 0; i < 9; i++) await h.click(await h.dm(`documentation créer outil ${JSON.stringify({ name: `Tool ${i} ${'_'.repeat(110)}`, category: '_'.repeat(120), usage: '_'.repeat(1500), referent: '_'.repeat(1500), companyWide: true })}`), "Confirmer la création");
    const first = await h.dm('documentation search {"target":"tool"}');
    for (let i = 0; i < 9; i++) expect(bodyText(first)).toContain(`Tool ${i}`);
    expect(bodyText(first)).toContain("_".repeat(1500)); expect(bodyText(first)).not.toContain("abrégé");
    expect(buttons(first).some(control => control.text.text === 'Suivant')).toBe(false);
  } finally { await h.app.close(); }
});

it('rejects malformed structured queries and missing or ambiguous references', async () => {
  const h = await harness('documentation', 'TTEAM', { OPENAI_API_KEY: 'fake' });
  try {
    await h.click(await h.dm("documentation créer technologie {\"name\":\"React\"}"), "Confirmer la création");
    await h.click(await h.dm("documentation créer hébergeur {\"name\":\"Compute\"}"), "Confirmer la création");
    expect(kind(await h.dm('documentation search {"target":"project","sql":"DELETE"}'))).toBe("Requête d’inventaire invalide");
    expect(kind(await h.dm('documentation count {"target":"project","filters":[{"kind":"host","selector":"Missing"}]}'))).toBe("Filtre introuvable");
    for (let i = 0; i < 2; i++) await h.click(await h.dm("documentation créer technologie {\"name\":\"Shared\"}"), "Confirmer la création");
    expect(kind(await h.dm('documentation count {"target":"project","filters":[{"kind":"technology","selector":"Shared"}]}'))).toBe("Filtre ambigu");
    expect(bodyText(await h.dm('documentation technologies'))).toContain('3 Technologies');
  } finally { await h.app.close(); }
});

it('archives and restores a Project through actor-bound controls while retaining its identifier and history', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Lifecycle\"}"), "Confirmer la création");
    const details = await h.dm('documentation project Lifecycle');
    const id = await recordId(details);
    const archive = await h.click(details, "Archiver");
    expect(kind(archive)).toBe("Archiver Projet — confirmation");
    expect(kind(await h.click(archive, 'Confirmer l’archivage', bob))).toBe("Confirmation indisponible");
    await h.click(archive, 'Confirmer l’archivage');
    expect(bodyText(await h.dm('documentation projects'))).toContain("Aucun projet");
    const archived = await h.dm(`documentation project ${id}`, bob);
    expect(bodyText(archived)).toContain("État : Archivé");
    const view = await h.dm('documentation archived', bob);
    expect(bodyText(view)).not.toContain(id); expect(button(view, "Lifecycle [Archivé]")).toBeTruthy();
    const restore = await h.click(archived, "Restaurer", bob);
    await h.click(restore, 'Confirmer la restauration', bob);
    await h.click(archive, 'Confirmer l’archivage');
    expect(bodyText(await h.dm(`documentation project ${id}`))).toContain("État : Actif");
    const history = await h.dm(`documentation history ${id}`);
    const archivedHistory = await h.click(history, "Suivant");
    expect(comparisonValues(archivedHistory)).toEqual({ 'Archivé': ['Non', 'Oui'] });
    expect(comparisonValues(await h.click(archivedHistory, "Suivant"))).toEqual({ 'Archivé': ['Oui', 'Non'] });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('labels archived Projects in ambiguous exact-name and alias choices', async () => {
  const h = await harness();
  try {
    for (let index = 0; index < 2; index++) await h.click(await h.dm("documentation créer projet {\"name\":\"Same\",\"aliases\":[\"Shared alias\"]}"), "Confirmer la création");
    const first = await h.click(await h.dm('documentation project Same'), 'Same');
    await h.click(await h.click(first, "Archiver"), 'Confirmer l’archivage');
    for (const selector of ['Same', 'Shared alias']) {
      const choices = await h.dm(`documentation project ${selector}`);
      expect(bodyText(choices)).toContain("Same [Archivé]");
      expect(buttons(choices).map(item => item.text.text.replace(/^\d+\. /, ''))).toContain("Same [Archivé]");
      expect(bodyText(await h.click(choices, "Same [Archivé]"))).toContain("État : Archivé");
    }
  } finally { await h.app.close(); }
});

it.each(['technology', 'component', 'host', 'hosting', 'tool'] as const)('preserves %s relationships and prevents both lifecycle replays through structured/action dispatch', async recordKind => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Parent\"}"), "Confirmer la création");
    const parentId = await recordId(await h.dm('documentation project Parent'));
    await h.click(await h.dm("documentation créer technologie {\"name\":\"Runtime\"}"), "Confirmer la création");
    const technologyId = await recordId(await h.dm('documentation technology Runtime'));
    await h.click(await h.dm(`documentation créer composant ${JSON.stringify({ name: 'API', projectId: parentId, technologies: [technologyId] })}`), "Confirmer la création");
    const componentId = await recordId(await h.dm('documentation component API'));
    await h.click(await h.dm("documentation créer hébergeur {\"name\":\"Compute\"}"), "Confirmer la création");
    const serviceId = await recordId(await h.dm('documentation host Compute'));
    await h.click(await h.dm(`documentation créer hébergement ${JSON.stringify({ componentId, serviceId, environment: 'production' })}`), "Confirmer la création");
    const hostingId = await recordId(await h.click(await h.dm(`documentation hosting ${componentId}`), 'production'));
    await h.click(await h.dm(`documentation créer outil ${JSON.stringify({ name: 'Shared tool', projects: [parentId] })}`), "Confirmer la création");
    const toolId = await recordId(await h.dm('documentation tool Shared tool'));
    const id = { technology: technologyId, component: componentId, host: serviceId, hosting: hostingId, tool: toolId }[recordKind];
    const command = recordKind === 'hosting' ? 'hosting-entry' : recordKind;
    const active = await h.dm(`documentation ${command} ${id}`);
    const originalFields = (await sql.query('SELECT fields FROM documentation_records WHERE team=$1 AND id=$2', [alice.team, id])).rows[0].fields;
    const proposal = await h.click(active, "Archiver");
    expect(kind(proposal)).toMatch(/confirmation/i);
    expect(kind(await h.click(proposal, 'Confirmer l’archivage', bob))).toBe("Confirmation indisponible");
    await h.click(proposal, 'Confirmer l’archivage');
    const detail = await h.dm(`documentation ${command} ${id}`, bob);
    expect(bodyText(detail)).toContain("État : Archivé");
    const currentProject = await h.dm(`documentation project ${parentId}`);
    expect(bodyText(currentProject)).toContain("État : Actif");
    if (recordKind === 'host') expect(bodyText(await h.click(currentProject, "Hébergements"))).toContain("Compute [Archivé]");
    if (recordKind === 'technology') expect(buttons(await h.dm(`documentation component ${componentId}`)).map(b => b.text.text)).toContain("Runtime [Archivé]");
    const ordinary = { technology: 'technologies', component: `components ${parentId}`, host: 'hosts', hosting: `hosting ${componentId}`, tool: 'tools' }[recordKind];
    expect(bodyText(await h.dm(`documentation ${ordinary}`))).not.toContain(id);
    const restore = await h.click(detail, "Restaurer", bob);
    await h.click(restore, 'Confirmer la restauration', bob);
    await h.click(proposal, 'Confirmer l’archivage');
    expect(bodyText(await h.dm(`documentation ${command} ${id}`))).toContain("État : Actif");
    await h.click(await h.dm(`documentation archive ${recordKind} ${id}`, bob), 'Confirmer l’archivage', bob);
    await h.click(restore, 'Confirmer la restauration', bob);
    expect(bodyText(await h.dm(`documentation ${command} ${id}`))).toContain("État : Archivé");
    await h.click(await h.dm(`documentation restore ${recordKind} ${id}`), 'Confirmer la restauration');
    const restored = await h.dm(`documentation ${command} ${id}`);
    expect(bodyText(restored)).toContain("État : Actif");
    expect((await sql.query('SELECT fields FROM documentation_records WHERE team=$1 AND id=$2', [alice.team, id])).rows[0].fields).toEqual(originalFields);
    expect(bodyText(await h.dm(`documentation history ${command} ${id}`))).toContain("Historique — page 1/5");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it.each(['project', 'technology', 'component', 'host', 'hosting', 'tool'] as const)('requires restoration before a pending %s edit can apply and keeps its original expiry', async recordKind => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Parent\"}"), "Confirmer la création");
    const parentId = await recordId(await h.dm('documentation project Parent'));
    await h.click(await h.dm(`documentation créer composant ${JSON.stringify({ name: 'Component', projectId: parentId })}`), "Confirmer la création");
    const componentId = await recordId(await h.dm('documentation component Component'));
    await h.click(await h.dm("documentation créer hébergeur {\"name\":\"Host\"}"), "Confirmer la création");
    const serviceId = await recordId(await h.dm('documentation host Host'));
    const fields = recordKind === 'component' ? { name: 'Target', projectId: parentId, type: 'Initial' }
      : recordKind === 'hosting' ? { componentId, serviceId, environment: 'Initial' } : { name: 'Target', notes: 'Initial' };
    await h.click(await h.dm(`documentation create ${recordKind} ${JSON.stringify(fields)}`), "Confirmer la création");
    const command = recordKind === 'hosting' ? 'hosting-entry' : recordKind;
    const detail = recordKind === 'hosting' ? await h.click(await h.dm(`documentation hosting ${componentId}`), 'Initial') : await h.dm(`documentation ${command} Target`);
    const id = await recordId(detail);
    const field = recordKind === 'component' ? 'type' : recordKind === 'hosting' ? 'environment' : 'notes';
    const edit = await h.dm(`documentation edit ${recordKind} ${id} ${JSON.stringify({ [field]: 'Approved' })}`);
    const expiredArchive = await h.dm(`documentation archive ${recordKind} ${id}`);
    await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '25 hours' WHERE id=$1", [button(expiredArchive, 'Confirmer l’archivage').value]);
    expect(kind(await h.click(expiredArchive, 'Confirmer l’archivage'))).toBe("Confirmation expirée");
    await h.click(await h.dm(`documentation archive ${recordKind} ${id}`, bob), 'Confirmer l’archivage', bob);
    expect(kind(await h.click(edit, "Confirmer la modification"))).toBe("Restauration nécessaire avant modification");
    expect(bodyText(await h.dm(`documentation ${command} ${id}`))).toContain(`${fieldLabel(field)}: Initial`);
    expect(kind(await h.dm(`documentation edit ${recordKind} ${id} ${JSON.stringify({ [field]: 'Rejected' })}`))).toBe("Restauration nécessaire avant modification");
    const expiredRestore = await h.dm(`documentation restore ${recordKind} ${id}`);
    await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '25 hours' WHERE id=$1", [button(expiredRestore, 'Confirmer la restauration').value]);
    expect(kind(await h.click(expiredRestore, 'Confirmer la restauration'))).toBe("Confirmation expirée");
    await h.click(await h.dm(`documentation restore ${recordKind} ${id}`, bob), 'Confirmer la restauration', bob);
    await h.click(await h.dm(`documentation edit ${recordKind} ${id} ${JSON.stringify({ [field]: 'Bob' })}`, bob), "Confirmer la modification", bob);
    await h.click(edit, "Confirmer la modification");
    expect(bodyText(await h.dm(`documentation ${command} ${id}`))).toContain(`${fieldLabel(field)}: Approved`);
    const historyCommand = recordKind === 'project' ? `history ${id}` : `history ${command} ${id}`;
    let history = await h.dm(`documentation ${historyCommand}`);
    for (let page = 0; page < 4; page++) history = await h.click(history, "Suivant");
    expect(comparisonValues(history)).toEqual({ [fieldLabel(field)]: ['Bob', 'Approved'] });
    const expiring = await h.dm(`documentation edit ${recordKind} ${id} ${JSON.stringify({ [field]: 'Expired' })}`);
    await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '25 hours' WHERE id=$1", [button(expiring, "Confirmer la modification").value]);
    await h.click(await h.dm(`documentation archive ${recordKind} ${id}`), 'Confirmer l’archivage');
    await h.restart('');
    await h.restart('documentation');
    await h.click(await h.dm(`documentation restore ${recordKind} ${id}`, bob), 'Confirmer la restauration', bob);
    expect(kind(await h.click(expiring, "Confirmer la modification"))).toBe("Confirmation expirée");
    expect(bodyText(await h.dm(`documentation ${command} ${id}`))).toContain(`${fieldLabel(field)}: Approved`);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('paginates Archived inventory with private controls and saves already-satisfied lifecycle outcomes', async () => {
  const h = await harness();
  try {
    await new Budget(sql, 10_000_000, 10_000_000, 'mail').reserve(alice, 10_000_000);
    await h.dm('budget');
    for (let index = 0; index < 41; index++) {
      const creation = await h.dm(`documentation create project ${JSON.stringify({ name: `Archived ${index}` })}`);
      expect(kind(creation), bodyText(creation)).toBe("Confirmation de création du projet");
      await h.click(creation, "Confirmer la création");
      await h.click(await h.dm(`documentation archive project Archived ${index}`), 'Confirmer l’archivage');
    }
    const first = await h.click(await h.click(await h.dm('menu', bob), 'Documentation', bob), "Archivé", bob);
    expect(bodyText(first)).toContain("page 1/2 · 41 fiches archivées");
    expect(kind(await h.click(first, "Suivant"))).toBe("Menu indisponible");
    expect(bodyText(await h.click(first, "Suivant", bob))).toContain('page 2/2');
    expect(bodyText(await h.dm('documentation archived 999'))).toContain('page 2/2');
    const satisfied = await h.dm('documentation archive project Archived 0');
    expect(kind(await h.click(satisfied, 'Confirmer l’archivage'))).toBe("État déjà satisfait");
    await h.click(await h.dm('documentation restore project Archived 0', bob), 'Confirmer la restauration', bob);
    await h.click(satisfied, 'Confirmer l’archivage');
    expect(bodyText(await h.dm('documentation project Archived 0'))).toContain("État : Actif");
    const restored = await h.dm('documentation restore project Archived 0');
    expect(kind(await h.click(restored, 'Confirmer la restauration'))).toBe("État déjà satisfait");
    await h.click(await h.dm('documentation archive project Archived 0', bob), 'Confirmer l’archivage', bob);
    await h.click(restored, 'Confirmer la restauration');
    expect(bodyText(await h.dm('documentation history Archived 0'))).toContain("Historique — page 1/4");
    const expired = await h.dm('documentation restore project Archived 0');
    await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '25 hours' WHERE id=$1", [button(expired, 'Confirmer la restauration').value]);
    await h.restart(''); await h.restart('documentation');
    expect(kind(await h.click(expired, 'Confirmer la restauration'))).toBe("Confirmation expirée");
    expect(bodyText(await h.dm('documentation project Archived 0'))).toContain("État : Archivé");
    expect(kind(await h.click(await h.dm('documentation project Archived 0'), "Restaurer", bob))).toBe("Menu indisponible");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it.each(['project', 'host'] as const)('rolls back %s lifecycle/history/outcome together and recovers uncertain delivery without repeating the effect', async recordKind => {
  const h = await harness();
  const table = recordKind === 'project' ? 'documentation_history' : 'documentation_record_history';
  try {
    await h.click(await h.dm(`documentation create ${recordKind} {"name":"Atomic lifecycle"}`), "Confirmer la création");
    const proposal = await h.dm(`documentation archive ${recordKind} Atomic lifecycle`);
    await db.exec(`CREATE FUNCTION fail_lifecycle_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'lifecycle history unavailable'; END; $$;
      CREATE TRIGGER fail_lifecycle_history BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_lifecycle_history();`);
    await h.enqueueClick(proposal, button(proposal, 'Confirmer l’archivage'));
    await expect(h.drain()).rejects.toThrow('lifecycle history unavailable');
    await sql.query("UPDATE jobs SET available_at=now()+interval '1 day' WHERE status='queued'");
    expect(bodyText(await h.dm(`documentation ${recordKind} Atomic lifecycle`))).toContain("État : Actif");
    await db.exec(`DROP TRIGGER fail_lifecycle_history ON ${table}; DROP FUNCTION fail_lifecycle_history();`);
    await sql.query("UPDATE jobs SET available_at=now() WHERE status='queued'");
    h.fail('uncertain'); await expect(h.drain()).rejects.toThrow('Lost response');
    const count = h.messages.length;
    await h.restart(); await h.drain();
    expect(h.messages).toHaveLength(count);
    await h.click(await h.dm(`documentation restore ${recordKind} Atomic lifecycle`, bob), 'Confirmer la restauration', bob);
    await h.click(proposal, 'Confirmer l’archivage');
    expect(bodyText(await h.dm(`documentation ${recordKind} Atomic lifecycle`))).toContain("État : Actif");
    const history = recordKind === 'project' ? 'history Atomic lifecycle' : 'history host Atomic lifecycle';
    expect(bodyText(await h.dm(`documentation ${history}`))).toContain("Historique — page 1/3");
    const reject = await h.dm(`documentation archive ${recordKind} Atomic lifecycle`);
    await h.enqueueClick(reject, button(reject, 'Confirmer l’archivage'));
    h.fail('reject'); await expect(h.drain()).rejects.toThrow('Slack delivery was rejected');
    await h.restart(); await h.drain();
    expect(kind(h.messages.at(-1)!)).toContain('archivage enregistré');
    expect(bodyText(await h.dm(`documentation ${history}`))).toContain("Historique — page 1/4");
  } finally { await h.app.close(); }
});

it('creates a shared Project only after its owner confirms and lets another User read initial history without AI or Gmail', async () => {
  const h = await harness();
  try {
    const main = await h.dm('menu');
    const menu = await h.click(main, 'Documentation');
    expect(buttons(menu).map(item => item.text.text)).toEqual(["Ajouter un projet", "Projets", "Technologies", "Hébergeurs/services", "Outils", "Archivé", "Historique", "Aide", "Retour au menu"]);
    const proposal = await h.dm('documentation create project {"name":"Alpha"}');
    expect(kind(proposal)).toBe("Confirmation de création du projet");
    expect(bodyText(proposal)).toContain("Description: Inconnu");
    expect(bodyText(await h.dm('documentation projects', bob))).toContain("Aucun projet");
    const saved = await h.click(proposal, "Confirmer la création");
    expect(kind(saved)).toBe("Projet créé");
    const details = await h.dm('documentation project Alpha', bob);
    expect(bodyText(details)).toContain("Nom: Alpha");
    const history = await h.click(details, "Historique", bob);
    expect(bodyText(history)).toContain('UALICE');
    expect(bodyText(history)).toContain("Source : Commande structurée Slack — création");
    expect(bodyText(history)).toContain("Avant : aucune fiche");
    expect(bodyText(history)).toContain("Nom: Alpha");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('maintains company-wide Outils with descriptive referents, shared edits and actual overwrite history without AI', async () => {
  const h = await harness();
  try {
    const proposal = await h.dm('documentation create tool {"name":"Slack","category":"Communication","companyWide":true,"referent":"Alice"}');
    expect(kind(proposal)).toBe("Créer Outil — confirmation");
    expect(bodyText(proposal)).toContain("Utilisation: Inconnu");
    expect(bodyText(proposal)).toContain("Projets: Inconnu");
    expect(bodyText(await h.dm('documentation tools', bob))).toContain('Aucune fiche : Outils');
    await h.click(proposal, "Confirmer la création");
    const detail = await h.dm('documentation tool slack', bob);
    const id = await recordId(detail);
    expect(bodyText(detail)).toContain("Toute l’entreprise: Oui");
    button(await h.click(detail, "Modifier", bob), 'Remplir le formulaire');
    const pending = await h.dm(`documentation modifier tool ${id} {"name":"Slack Chat","usage":"Company chat","referent":null}`);
    await h.click(await h.dm(`documentation modifier tool ${id} {"usage":"Bob usage","notes":"Bob notes"}`, bob), "Confirmer la modification", bob);
    await h.click(pending, "Confirmer la modification");
    const current = bodyText(await h.dm(`documentation tool ${id}`, bob));
    expect(current).toContain("Nom: Slack Chat"); expect(current).toContain("Utilisation: Company chat");
    expect(current).toContain("Référent: Inconnu"); expect(current).toContain('Notes: Bob notes');
    const history = await h.click(await h.click(await h.dm(`documentation history tool ${id}`, bob), "Suivant", bob), "Suivant", bob);
    expect(comparisonValues(history).Utilisation).toEqual(['Bob usage', 'Company chat']); expect(bodyText(history)).toContain("Utilisation: Company chat");
    expect(bodyText(history)).toContain("Auteur : UALICE");
    await h.click(await h.dm(`documentation modifier tool ${id} {"usage":"Later"}`, bob), "Confirmer la modification", bob);
    await h.restart(); await h.click(pending, "Confirmer la modification"); await h.click(proposal, "Confirmer la création");
    expect(bodyText(await h.dm(`documentation tool ${id}`))).toContain("Utilisation: Later");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('links a Tool to multiple existing Projects and keeps reciprocal navigation through renames', async () => {
  const h = await harness();
  try {
    const ids: string[] = [];
    for (const name of ['Alpha', 'Beta']) {
      await h.click(await h.dm(`documentation créer projet ${JSON.stringify({ name, aliases: [name + ' alias'] })}`), "Confirmer la création");
      ids.push(await recordId(await h.dm(`documentation project ${name}`)));
    }
    const proposal = await h.dm('documentation create tool {"name":"Sentry","companyWide":true,"projects":["Alpha alias","Beta","Alpha"],"usage":"Also used by unmatched Gamma"}');
    expect(bodyText(proposal)).toContain("Projets: Alpha (nom actuel)\nBeta (nom actuel)"); expect((await sql.query('SELECT fields FROM documentation_confirmations WHERE id=$1', [button(proposal, "Confirmer la création").value])).rows[0].fields.projects).toEqual(ids);
    await h.click(proposal, "Confirmer la création");
    const tool = await h.dm('documentation tool Sentry');
    const toolId = await recordId(tool);
    expect(await recordId(await h.click(tool, 'Alpha'))).toBe(ids[0]);
    const tools = await h.click(await h.dm(`documentation project ${ids[1]}`, bob), "Outils", bob);
    expect(bodyText(tools)).toContain('Sentry');
    expect(await recordId(await h.click(tools, 'Sentry', bob))).toBe(toolId);
    await h.click(await h.dm(`documentation modifier projet ${ids[0]} {"name":"Alpha renamed"}`), "Confirmer la modification");
    await h.click(await h.dm(`documentation modifier tool ${toolId} {"name":"Sentry renamed"}`, bob), "Confirmer la modification", bob);
    expect(buttons(await h.dm(`documentation tool ${toolId}`)).map(item => item.text.text)).toContain('Alpha renamed');
    const linked = await h.click(await h.dm(`documentation project ${ids[0]}`), "Outils");
    expect(bodyText(linked)).toContain('Sentry renamed');
    const detach = await h.dm(`documentation modifier tool ${toolId} {"projects":[]}`);
    await h.click(await h.dm(`documentation modifier tool ${toolId} {"notes":"Bob notes"}`, bob), "Confirmer la modification", bob);
    await h.click(detach, "Confirmer la modification");
    expect(bodyText(await h.click(await h.dm(`documentation project ${ids[0]}`), "Outils"))).toContain('Aucune fiche : Outils');
    const current = bodyText(await h.dm(`documentation tool ${toolId}`));
    expect(current).toContain("Toute l’entreprise: Oui"); expect(current).toContain('Notes: Bob notes');
    expect(current).toContain("Projets: Aucun élément enregistré");
    expect(kind(await h.dm('documentation project Gamma'))).toBe("Projet introuvable");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('requires exact existing Project references for Outils and rejects invalid fields without proposing a mutation', async () => {
  const h = await harness(), foreign = await harness('documentation', 'TOTHER');
  try {
    for (let index = 0; index < 2; index++) await h.click(await h.dm("documentation créer projet {\"name\":\"Same\",\"aliases\":[\"ambiguë\"]}"), "Confirmer la création");
    await foreign.click(await foreign.dm("documentation créer projet {\"name\":\"Foreign\"}", { ...alice, team: 'TOTHER' }), "Confirmer la création", { ...alice, team: 'TOTHER' });
    const foreignId = await recordId(await foreign.dm('documentation project Foreign', { ...alice, team: 'TOTHER' }));
    for (const selector of ['Missing', foreignId]) {
      const response = await h.dm(`documentation create tool ${JSON.stringify({ name: 'Rejected', projects: [selector] })}`);
      expect(kind(response)).toBe("Projet introuvable");
      expect(bodyText(response)).toContain("opération séparée confirmée");
    }
    expect(kind(await h.dm("documentation créer outil {\"name\":\"Rejected\",\"projects\":[\"ambiguë\"]}"))).toBe("Référence ambiguë : Projet");
    const choice = await h.click(await h.dm('documentation project Same'), 'Same');
    const projectId = await recordId(choice);
    const pending = await h.dm(`documentation create tool ${JSON.stringify({ name: 'Linked', projects: [projectId] })}`);
    await h.click(await h.dm(`documentation modifier projet ${projectId} {"name":"Renamed"}`, bob), "Confirmer la modification", bob);
    await h.click(pending, "Confirmer la création");
    expect(buttons(await h.dm('documentation tool Linked')).map(item => item.text.text)).toContain('Renamed');
    for (const fields of [{ name: null }, { name: '' }, { id: projectId }, { actor: 'Alice' }, { archived: true }, { companyWide: 'yes' }, { projects: [''] }, { projects: Array(21).fill(projectId) }, { category: 'x'.repeat(121) }, { usage: 'x'.repeat(1501) }, { referent: 'x'.repeat(1501) }, {}, [{ name: 'A' }]]) {
      expect(kind(await h.dm(`documentation modifier tool Linked ${JSON.stringify(fields)}`))).toBe("Valeur invalide : Outil — modification");
    }
    expect(kind(await h.dm('documentation modifier tool Linked {"projects":["Missing"]}'))).toBe("Projet introuvable");
    expect(bodyText(await h.dm('documentation tools'))).toContain('1 Outils');
    expect(bodyText(await h.dm('documentation projects'))).toContain("2 projets");
    expect(bodyText(await h.dm('documentation history tool Linked'))).toContain("Historique — page 1/1");
    // Unknown free text must never become an inferred Project relationship.
    await h.click(await h.dm("documentation créer outil {\"name\":\"Text only\",\"usage\":\"Same, Missing and Foreign\"}"), "Confirmer la création");
    expect(bodyText(await h.dm('documentation tool Text only'))).toContain("Projets: Inconnu");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); await foreign.app.close(); }
});

it('paginates Outils, ambiguous exact lookups, Project relationships and shared history using private controls', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Parent\"}"), "Confirmer la création");
    const projectId = await recordId(await h.dm('documentation project Parent'));
    const toolMenu = await h.click(await h.click(await h.dm('menu'), 'Documentation'), "Outils");
    button(await h.click(toolMenu, "Ajouter un outil"), 'Remplir le formulaire');
    for (let index = 0; index < 41; index++) await h.click(await h.dm(`documentation créer outil ${JSON.stringify({ name: 'Same', projects: [projectId] })}`), "Confirmer la création");
    const list = await h.dm('documentation tools', bob);
    expect(bodyText(list)).toContain('page 1/2 · 41 Outils');
    expect(kind(await h.click(list, "Suivant"))).toBe("Menu indisponible");
    expect(bodyText(await h.click(list, "Suivant", bob))).toContain('page 2/2');
    const choices = await h.dm('documentation tool Same');
    expect(kind(choices)).toBe("Choisir une fiche : Outil");
    const selected = await h.click(await h.click(choices, "Suivant"), 'Same');
    const id = await recordId(selected);
    expect(kind(await h.dm('documentation modifier tool Same {"usage":"Do not guess"}'))).toBe("Référence ambiguë : Outil — modification");
    expect(kind(await h.click(await h.click(await h.dm('documentation history tool Same'), "Suivant"), 'Same'))).toBe('Historique — Outil');
    expect(bodyText(await h.click(await h.click(await h.dm(`documentation project ${projectId}`), "Outils"), "Suivant"))).toContain('page 2/2');
    expect(bodyText(await h.dm('documentation tools 999'))).toContain('page 2/2');
    const history = await h.dm('documentation history');
    expect(bodyText(await h.click(history, "Suivant"))).toContain('Outil:');
    expect(await recordId(await h.dm(`documentation tool ${id}`, bob))).toBe(id);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('maintains shared Hosts/services with explicit costs, overwrite history and replay recovery', async () => {
  const h = await harness();
  try {
    const proposal = await h.dm('documentation create host {"name":"OVH","role":"Compute"}');
    expect(kind(proposal)).toBe("Créer Hébergeur/service — confirmation");
    expect(bodyText(proposal)).toContain("Coût mensuel: Inconnu");
    expect(kind(await h.click(proposal, "Confirmer la création", bob))).toBe("Confirmation indisponible");
    await h.click(proposal, "Confirmer la création");
    const detail = await h.dm('documentation host ovh', bob);
    const id = await recordId(detail);
    button(await h.click(detail, "Modifier", bob), 'Remplir le formulaire');
    const pending = await h.dm(`documentation modifier host ${id} {"monthlyCost":12.5,"currency":"eur","name":"OVH Compute"}`);
    await h.click(await h.dm(`documentation modifier host ${id} {"monthlyCost":20,"currency":"EUR","notes":"Bob notes"}`, bob), "Confirmer la modification", bob);
    await h.click(pending, "Confirmer la modification");
    const current = bodyText(await h.dm(`documentation host ${id}`));
    expect(current).toContain("Coût mensuel: 12,5"); expect(current).toContain("Devise: EUR"); expect(current).toContain('Notes: Bob notes');
    const history = await h.click(await h.click(await h.dm(`documentation history host ${id}`), "Suivant"), "Suivant");
    expect(comparisonValues(history)["Coût mensuel"]).toEqual(['20', '12,5']);
    expect(bodyText(history)).toContain("Coût mensuel: 12,5");
    await h.click(await h.dm(`documentation modifier host ${id} {"role":"Later"}`, bob), "Confirmer la modification", bob);
    await h.restart(); await h.click(pending, "Confirmer la modification");
    expect(bodyText(await h.dm(`documentation host ${id}`))).toContain("Rôle: Later");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('records distinct Component environments, shared services and production-first Project hosting with saved links', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer hébergeur {\"name\":\"Shared cloud\",\"monthlyCost\":30,\"currency\":\"EUR\"}"), "Confirmer la création");
    const hostId = await recordId(await h.dm('documentation host Shared cloud'));
    const projects: string[] = [], components: string[] = [], entries: string[] = [];
    for (const projectName of ['Alpha', 'Beta']) {
      await h.click(await h.dm(`documentation créer projet ${JSON.stringify({ name: projectName })}`), "Confirmer la création");
      const projectId = await recordId(await h.dm(`documentation project ${projectName}`)); projects.push(projectId);
      for (const type of ['frontend', 'backend']) {
        await h.click(await h.dm(`documentation créer composant ${JSON.stringify({ name: `${projectName} ${type}`, projectId, type })}`), "Confirmer la création");
        const component = await h.dm(`documentation component ${projectName} ${type}`);
        const componentId = await recordId(component); components.push(componentId);
        button(await h.click(await h.click(component, "Hébergements"), "Ajouter un hébergement"), 'Remplir le formulaire');
        for (const environment of ['staging', 'production']) {
          const proposal = await h.dm(`documentation create hosting ${JSON.stringify({ componentId, serviceId: 'Shared cloud', environment, urls: ['https://example.com/app'], accessInstructions: 'See password manager' })}`);
          expect(kind(proposal)).toBe("Créer Hébergement — confirmation");
          expect(bodyText(proposal)).toContain('Hébergeur/service: Shared cloud (nom actuel)');
          entries.push(await recordId(proposal));
          await h.click(proposal, "Confirmer la création");
        }
      }
    }
    const project = await h.click(await h.dm(`documentation project ${projects[0]}`, bob), "Hébergements", bob);
    const text = bodyText(project);
    expect(text).toContain('Alpha frontend'); expect(text).toContain('Alpha backend');
    expect(text.indexOf('production')).toBeLessThan(text.indexOf('staging'));
    const hostingDetails = await h.click(project, 'production', bob); expect(bodyText(hostingDetails)).toContain("Référence du compte: Inconnu");
    expect(text).not.toContain('monthlyCost');
    expect(JSON.stringify(project.body)).toContain('https://example.com/app');
    expect(bodyText(await h.dm(`documentation hosting ${components[0]}`)).indexOf('production')).toBeLessThan(bodyText(await h.dm(`documentation hosting ${components[0]}`)).indexOf('staging'));
    expect(bodyText(await h.click(await h.dm(`documentation host ${hostId}`), "Hébergements"))).toContain('8 Hébergements');
    await h.click(await h.dm(`documentation modifier host ${hostId} {"name":"Cloud renamed"}`), "Confirmer la modification");
    await h.click(await h.dm(`documentation edit component ${components[0]} {"name":"Web renamed"}`), "Confirmer la modification");
    const detail = await h.dm(`documentation hosting-entry ${entries[0]}`);
    expect(bodyText(detail)).toContain('Composant: Alpha / Web renamed');
    expect(await recordId(await h.click(detail, 'Cloud renamed'))).toBe(hostId);
    expect(kind(await h.click(detail, "Historique"))).toBe('Historique — Hébergement');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('paginates Hosts/services and Hosting entries and rejects missing, ambiguous, foreign and invalid references', async () => {
  const h = await harness(), foreign = await harness('documentation', 'TOTHER');
  const other = { ...alice, team: 'TOTHER' };
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Parent\"}"), "Confirmer la création");
    const projectId = await recordId(await h.dm('documentation project Parent'));
    await h.click(await h.dm(`documentation créer composant ${JSON.stringify({ name: 'API', projectId })}`), "Confirmer la création");
    const componentId = await recordId(await h.dm('documentation component API'));
    for (let i = 0; i < 41; i++) await h.click(await h.dm("documentation créer hébergeur {\"name\":\"Duplicate\"}"), "Confirmer la création");
    expect(bodyText(await h.dm('documentation hosts 999'))).toContain('page 2/2');
    const choice = await h.dm('documentation history host Duplicate');
    expect(kind(choice)).toBe("Choisir une fiche : Hébergeur/service");
    expect(kind(await h.click(await h.click(choice, "Suivant"), 'Duplicate'))).toBe('Historique — Hébergeur/service');
    const serviceId = await recordId(await h.click(await h.dm('documentation host Duplicate'), 'Duplicate'));
    await foreign.click(await foreign.dm("documentation créer hébergeur {\"name\":\"Foreign\"}", other), "Confirmer la création", other);
    const foreignId = await recordId(await foreign.dm('documentation host Foreign', other));
    const request = (serviceId: string, parent = componentId) => `documentation create hosting ${JSON.stringify({ componentId: parent, serviceId })}`;
    expect(kind(await h.dm(request('Missing')))).toBe("Hébergeur/service introuvable");
    expect(kind(await h.dm(request('Duplicate')))).toBe("Référence d’hébergeur/service ambiguë");
    expect(kind(await h.dm(request(foreignId)))).toBe("Hébergeur/service introuvable");
    expect(kind(await h.dm(request(serviceId, projectId)))).toBe("Composant introuvable");
    expect(kind(await foreign.dm(request(foreignId), other))).toBe("Composant introuvable");
    for (const fields of [{ name: 'Invalid', monthlyCost: 1 }, { name: 'Invalid', monthlyCost: -1, currency: 'EUR' }, { name: 'Invalid', monthlyCost: '20', currency: 'EUR' }, { name: 'Invalid', currency: 'EU' }, { name: 'Invalid', password: 'secret' }]) {
      expect(kind(await h.dm(`documentation créer hébergeur ${JSON.stringify(fields)}`))).toBe("Valeur invalide : Hébergeur/service");
    }
    for (const fields of [{ componentId, serviceId, urls: ['https://user:password@example.com'] }, { componentId, serviceId, environment: 'Two\nLines' }, { componentId, serviceId, apiKey: 'secret' }, [{ componentId, serviceId }]]) {
      expect(kind(await h.dm(`documentation créer hébergement ${JSON.stringify(fields)}`))).toBe("Valeur invalide : Hébergement");
    }
    const invalidated = await h.dm(request(serviceId));
    await sql.query("UPDATE documentation_confirmations SET fields=jsonb_set(fields,'{serviceId}',to_jsonb($2::text)) WHERE id=$1", [button(invalidated, "Confirmer la création").value, foreignId]);
    expect(kind(await h.click(invalidated, "Confirmer la création"))).toBe('Hébergement : échec de l’opération créer');
    expect(bodyText(await h.dm(`documentation hosting ${componentId}`))).toContain('Aucune fiche : Hébergements');
    let entryId = '';
    for (let i = 0; i < 41; i++) {
      const proposal = await h.dm(`documentation create hosting ${JSON.stringify({ componentId, serviceId, environment: i ? 'staging' : 'production' })}`);
      if (!i) entryId = await recordId(proposal);
      await h.click(proposal, "Confirmer la création");
    }
    const entries = await h.dm(`documentation hosting ${componentId}`);
    expect(tableRows(entries)[0]["Projet / Composant"]).toBe('Parent / API');
    expect(bodyText(await h.click(entries, "Suivant"))).toContain('page 2/2');
    expect(bodyText(await h.click(await h.click(await h.dm(`documentation project ${projectId}`), "Hébergements"), "Suivant"))).toContain('Hébergements — page 2/2');
    const pending = await h.dm(`documentation modifier hosting ${entryId} {"environment":"development"}`);
    await h.click(await h.dm(`documentation modifier hosting ${entryId} {"environment":"Bob environment","notes":"Bob notes"}`, bob), "Confirmer la modification", bob);
    await h.click(pending, "Confirmer la modification");
    const current = bodyText(await h.dm(`documentation hosting-entry ${entryId}`));
    expect(current).toContain("Environnement: development"); expect(current).toContain('Notes: Bob notes');
    const history = await h.click(await h.click(await h.dm(`documentation history hosting-entry ${entryId}`), "Suivant"), "Suivant");
    expect(comparisonValues(history)).toEqual({ Environnement: ['Bob environment', 'development'] });
    for (const fields of [{ componentId }, { serviceId: null }, { id: entryId }, { notes: 'x'.repeat(1501) }, {}]) {
      expect(kind(await h.dm(`documentation modifier hosting ${entryId} ${JSON.stringify(fields)}`))).toBe("Valeur invalide : Hébergement — modification");
    }
    await h.click(await h.dm(`documentation modifier host ${serviceId} {"monthlyCost":0,"currency":"EUR"}`), "Confirmer la modification");
    expect(kind(await h.dm(`documentation modifier host ${serviceId} {"currency":null}`))).toBe("Modification d’hébergeur/service invalide");
    const clearCurrency = await h.dm(`documentation modifier host ${serviceId} {"monthlyCost":null,"currency":null}`);
    await h.click(clearCurrency, "Confirmer la modification");
    const currencyOnly = await h.dm(`documentation modifier host ${serviceId} {"currency":null}`);
    await h.click(await h.dm(`documentation modifier host ${serviceId} {"monthlyCost":20,"currency":"EUR"}`, bob), "Confirmer la modification", bob);
    expect(kind(await h.click(currencyOnly, "Confirmer la modification"))).toBe('Hébergeur/service : échec de l’opération modifier');
    expect(bodyText(await h.dm(`documentation host ${serviceId}`))).toContain("Coût mensuel: 20");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); await foreign.app.close(); }
});

it('upgrades existing catalog records and pending controls and preserves empty hosting values in navigation', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Existing\"}"), "Confirmer la création");
    const projectId = await recordId(await h.dm('documentation project Existing'));
    await h.click(await h.dm("documentation créer technologie {\"name\":\"Existing technology\"}"), "Confirmer la création");
    const component = await h.dm(`documentation create component ${JSON.stringify({ name: 'Existing API', projectId, technologies: ['Existing technology'] })}`);
    const edit = await h.dm('documentation modifier technology Existing technology {"notes":"Pending"}');
    // Recreate ticket 03's table shape as an upgrade fixture, with saved inventory
    // and pending controls already present. Assertions use the public workflow.
    await db.exec(`ALTER TABLE documentation_records DROP CONSTRAINT documentation_records_check;
      ALTER TABLE documentation_records DROP CONSTRAINT documentation_records_kind_check;
      ALTER TABLE documentation_records DROP COLUMN component_id CASCADE;
      ALTER TABLE documentation_records ADD CONSTRAINT documentation_records_kind_check CHECK(kind IN ('technology','component'));
      ALTER TABLE documentation_records ADD CONSTRAINT documentation_records_check CHECK((kind='technology' AND parent_id IS NULL) OR (kind='component' AND parent_id IS NOT NULL AND fields->>'projectId'=parent_id));`);
    await h.restart(); await h.restart();
    expect(kind(await h.click(component, "Confirmer la création"))).toBe("Composant : création enregistrée");
    expect(kind(await h.click(edit, "Confirmer la modification"))).toBe("Technologie : modification enregistrée");
    expect(bodyText(await h.dm('documentation technology Existing technology'))).toContain('Notes: Pending');
    const componentId = await recordId(await h.dm('documentation component Existing API'));
    await h.click(await h.dm("documentation créer hébergeur {\"name\":\"New service\"}"), "Confirmer la création");
    const entry = await h.dm(`documentation create hosting ${JSON.stringify({ componentId, serviceId: 'New service', environment: '', accountReference: '', urls: [], accessInstructions: '' })}`);
    const saved = await h.click(entry, "Confirmer la création");
    const entryId = await recordId(saved);
    expect(await recordId(saved)).toBe(entryId); expect(button(saved, "Détails de la fiche")).toBeTruthy();
    const details = await h.click(await h.dm(`documentation hosting ${componentId}`), "(vide)");
    expect(bodyText(details)).toContain('URLs: Aucun élément enregistré');
    expect(bodyText(details)).not.toContain("Environnement: Inconnu");
    expect(bodyText(await h.click(await h.dm('documentation project Existing'), "Hébergements"))).toContain('Existing API');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('maintains the shared Technology catalog with separate confirmations, exact lookup and actual overwrite history', async () => {
  const h = await harness();
  try {
    const proposal = await h.dm('documentation create technology {"name":"React","category":"Frontend","notes":"Initial"}');
    expect(kind(proposal)).toBe("Créer Technologie — confirmation");
    expect(bodyText(await h.dm('documentation technologies', bob))).toContain('Aucune fiche : Technologies');
    expect(kind(await h.click(proposal, "Confirmer la création", bob))).toBe("Confirmation indisponible");
    await h.click(proposal, "Confirmer la création");
    const detail = await h.dm('documentation technology react', bob);
    const id = await recordId(detail);
    button(await h.click(detail, "Modifier", bob), 'Remplir le formulaire');
    const pending = await h.dm(`documentation modifier technology ${id} {"name":"React UI","category":null}`);
    await h.click(await h.dm(`documentation modifier technology ${id} {"category":"Bob category","notes":"Bob notes"}`, bob), "Confirmer la modification", bob);
    await h.click(pending, "Confirmer la modification");
    const current = bodyText(await h.dm(`documentation technology ${id}`));
    expect(current).toContain("Catégorie: Inconnu");
    expect(current).toContain('Notes: Bob notes');
    expect(kind(await h.dm('documentation technology React'))).toBe('Technologie introuvable');
    const history = await h.click(await h.click(await h.dm(`documentation history technology ${id}`), "Suivant"), "Suivant");
    expect(comparisonValues(history)).toEqual({ Nom: ['React', 'React UI'], Catégorie: ['Bob category', "Inconnu"] });

    await h.click(await h.dm(`documentation modifier technology ${id} {"category":"Later"}`, bob), "Confirmer la modification", bob);
    await h.restart(); await h.click(pending, "Confirmer la modification");
    expect(bodyText(await h.dm(`documentation technology ${id}`))).toContain("Catégorie: Later");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('maintains Project Components with many shared Technologies and stable navigation through renames', async () => {
  const h = await harness();
  try {
    const technologyIds: string[] = [];
    for (const name of ['React', 'TypeScript']) {
      await h.click(await h.dm(`documentation créer technologie ${JSON.stringify({ name })}`), "Confirmer la création");
      technologyIds.push(await recordId(await h.dm(`documentation technology ${name}`)));
    }
    const projectIds: string[] = [], componentIds: string[] = [];
    for (const name of ['Alpha', 'Beta']) {
      await h.click(await h.dm(`documentation créer projet ${JSON.stringify({ name })}`), "Confirmer la création");
      const detail = await h.dm(`documentation project ${name}`);
      const projectId = await recordId(detail); projectIds.push(projectId);
      const components = await h.click(detail, "Composants");
      button(await h.click(components, "Ajouter un composant"), 'Remplir le formulaire');
      const proposal = await h.dm(`documentation create component ${JSON.stringify({ name: `${name} UI`, projectId, type: 'frontend', technologies: ['React', technologyIds[1]] })}`);
      expect(kind(proposal)).toBe("Créer Composant — confirmation");
      for (const name of ['React', 'TypeScript']) expect(bodyText(proposal)).toContain(name);
      await h.click(proposal, "Confirmer la création");
      const component = await h.click(await h.dm(`documentation components ${projectId}`), `${name} UI`);
      componentIds.push(await recordId(component));
      expect(await recordId(await h.click(component, 'React'))).toBe(technologyIds[0]);
      expect(await recordId(await h.click(component, name))).toBe(projectId);
    }
    const relationships = await h.click(await h.dm(`documentation technology ${technologyIds[0]}`, bob), "Composants", bob);
    expect(bodyText(relationships)).toContain('Alpha UI'); expect(bodyText(relationships)).toContain('Beta UI');
    await h.click(await h.dm(`documentation modifier technology ${technologyIds[0]} {"name":"React renamed"}`), "Confirmer la modification");
    await h.click(await h.dm(`documentation modifier projet ${projectIds[0]} {"name":"Alpha renamed"}`), "Confirmer la modification");
    const pending = await h.dm(`documentation edit component ${componentIds[0]} {"name":"Web client","technologies":["React renamed"]}`);
    await h.click(await h.dm(`documentation edit component ${componentIds[0]} {"type":"Bob type","technologies":[],"name":"Bob name"}`, bob), "Confirmer la modification", bob);
    await h.click(pending, "Confirmer la modification");
    const component = await h.dm(`documentation component ${componentIds[0]}`);
    expect(bodyText(component)).toContain("Nom: Web client"); expect(bodyText(component)).toContain('Type: Bob type');
    expect(bodyText(component)).toContain("Projet: Alpha");
    expect(buttons(component).map(control => control.text.text)).toContain('React renamed');
    const history = await h.click(await h.click(await h.click(component, "Historique"), "Suivant"), "Suivant");
    expect(comparisonValues(history).Nom).toEqual(['Bob name', 'Web client']);
    expect(comparisonValues(history).Technologies).toEqual(["Aucun élément enregistré", 'React renamed (nom actuel)']);
    expect(bodyText(await h.dm('documentation technologies'))).toContain('2 Technologies');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('confirms a combined Component stack above 20, preserves all 50 references on edit and rejects 51 before proposing', async () => {
  const h = await harness();
  try {
    const technologies = Array.from({ length: 51 }, (_, index) => ({ id: randomUUID(), name: `Stack technology ${index + 1}` }));
    for (const technology of technologies) await sql.query('INSERT INTO documentation_records(team,id,kind,fields) VALUES($1,$2,$3,$4::jsonb)',
      [alice.team, technology.id, 'technology', JSON.stringify({ name: technology.name, category: null, notes: null })]);
    await h.click(await h.dm("documentation créer projet {\"name\":\"Combined stack\"}"), "Confirmer la création");
    const projectId = await recordId(await h.dm('documentation project Combined stack'));
    const first = technologies.slice(0, 26).map(technology => technology.id);
    const proposal = await h.dm(`documentation create component ${JSON.stringify({ name: 'Application', projectId, technologies: first })}`);
    expect(kind(proposal)).toBe("Créer Composant — confirmation");
    for (let i = 1; i <= 26; i++) expect(bodyText(proposal)).toContain(`Stack technology ${i}`);
    expect((await sql.query("SELECT count(*)::int count FROM documentation_records WHERE kind='component'")).rows[0].count).toBe(0);
    await h.click(proposal, "Confirmer la création");
    const componentId = await recordId(await h.dm('documentation component Application'));
    const full = technologies.slice(0, 50).map(technology => technology.id);
    await h.click(await h.dm(`documentation edit component ${componentId} ${JSON.stringify({ technologies: full })}`), "Confirmer la modification");
    const detail = await h.dm(`documentation component ${componentId}`);
    expect(buttons(detail).filter(control => control.text.text.startsWith('Stack technology '))).toHaveLength(50);
    expect(await recordId(await h.click(detail, 'Stack technology 50'))).toBe(full[49]);
    expect((await sql.query('SELECT fields FROM documentation_records WHERE id=$1', [componentId])).rows[0].fields.technologies).toEqual(full);
    const pending = (await sql.query('SELECT count(*)::int count FROM documentation_confirmations')).rows[0].count;
    const excessive = technologies.map(technology => technology.id);
    expect(kind(await h.dm(`documentation créer composant ${JSON.stringify({ name: 'Excessive', projectId, technologies: excessive })}`))).toBe("Valeur invalide : Composant");
    expect(kind(await h.dm(`documentation edit component ${componentId} ${JSON.stringify({ technologies: excessive })}`))).toBe("Valeur invalide : Composant — modification");
    expect((await sql.query('SELECT count(*)::int count FROM documentation_confirmations')).rows[0].count).toBe(pending);
    const history = await h.dm(`documentation history component ${componentId}`);
    const fullHistory = await h.click(history, "Suivant"); expect(bodyText(fullHistory)).toContain('Stack technology 50 (nom actuel)');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('rejects ambiguous, missing, foreign and malformed relationships before proposal and again at apply', async () => {
  const h = await harness(), foreign = await harness('documentation', 'TOTHER');
  const other = { ...alice, team: 'TOTHER' };
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Parent\"}"), "Confirmer la création");
    const projectId = await recordId(await h.dm('documentation project Parent'));
    await foreign.click(await foreign.dm("documentation créer technologie {\"name\":\"Foreign\"}", other), "Confirmer la création", other);
    const foreignId = await recordId(await foreign.dm('documentation technology Foreign', other));
    for (let index = 0; index < 2; index++) await h.click(await h.dm("documentation créer technologie {\"name\":\"Duplicate\"}"), "Confirmer la création");
    const request = (technologies: string[]) => `documentation create component ${JSON.stringify({ name: 'API', projectId, technologies })}`;
    expect(kind(await h.dm(request(['Duplicate'])))).toBe("Référence ambiguë : Technologie");
    const missing = await h.dm(request(['Missing']));
    expect(kind(missing)).toBe('Technologie introuvable');
    expect(bodyText(missing)).toContain("opération séparée confirmée");
    expect(kind(await h.dm(request([foreignId])))).toBe('Technologie introuvable');
    expect(kind(await foreign.dm(`documentation créer composant ${JSON.stringify({ name: 'Foreign parent', projectId })}`, other))).toBe("Projet introuvable");
    const choices = await h.dm('documentation technology Duplicate');
    expect(kind(choices)).toBe("Choisir une fiche : Technologie");
    const technologyId = await recordId(await h.click(choices, 'Duplicate'));
    const proposal = await h.dm(request([technologyId]));
    // Simulate a stale/corrupt saved reference at the database boundary.
    await sql.query("UPDATE documentation_confirmations SET fields=jsonb_set(fields,'{technologies}',$2::jsonb) WHERE id=$1", [button(proposal, "Confirmer la création").value, JSON.stringify([foreignId])]);
    expect(kind(await h.click(proposal, "Confirmer la création"))).toBe('Composant : échec de l’opération créer');
    expect(bodyText(await h.dm(`documentation components ${projectId}`))).toContain("Aucune fiche : Composants");
    await h.click(await h.dm(request([technologyId])), "Confirmer la création");
    const componentId = await recordId(await h.dm('documentation component API'));
    for (const fields of [{}, { projectId }, { id: componentId }, { name: null }, { type: 'x'.repeat(121) }, { technologies: [''] }, { hostingEntries: [] }, [{ name: 'A' }]]) {
      expect(kind(await h.dm(`documentation edit component ${componentId} ${JSON.stringify(fields)}`))).toBe("Valeur invalide : Composant — modification");
    }
    const edit = await h.dm(`documentation edit component ${componentId} {"type":"Backend"}`);
    await sql.query("UPDATE documentation_confirmations SET fields=fields || jsonb_build_object('projectId',$2::text) WHERE id=$1", [button(edit, "Confirmer la modification").value, projectId]);
    expect(kind(await h.click(edit, "Confirmer la modification"))).toBe('Composant : échec de l’opération modifier');
    expect(bodyText(await h.dm(`documentation component ${componentId}`))).toContain("Type: Inconnu");
    expect(bodyText(await h.dm(`documentation history component ${componentId}`))).toContain("Historique — page 1/1");
    expect(bodyText(await h.dm('documentation technologies'))).toContain('2 Technologies');
  } finally { await h.app.close(); await foreign.app.close(); }
});

it('paginates catalog, Component and ambiguity navigation privately and includes all record kinds in shared history', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Project 8\"}"), "Confirmer la création");
    const id = await recordId(await h.dm('documentation project Project 8'));
    let technologyId = '';
    for (let index = 0; index < 41; index++) {
      const proposal = await h.dm('documentation create technology {"name":"Same"}');
      if (!index) technologyId = await recordId(proposal);
      await h.click(proposal, "Confirmer la création");
      await h.click(await h.dm(`documentation créer composant ${JSON.stringify({ name: 'API', projectId: id, technologies: [technologyId] })}`), "Confirmer la création");
    }
    const catalog = await h.dm('documentation technologies', bob);
    expect(bodyText(catalog)).toContain('page 1/2 · 41 Technologies');
    expect(kind(await h.click(catalog, "Suivant"))).toBe("Menu indisponible");
    expect(bodyText(await h.click(catalog, "Suivant", bob))).toContain('page 2/2');
    expect(bodyText(await h.dm('documentation technologies 999'))).toContain('page 2/2');
    const technologyChoice = await h.dm('documentation history technology Same');
    expect(kind(technologyChoice)).toBe("Choisir une fiche : Technologie");
    expect(kind(await h.click(await h.click(technologyChoice, "Suivant"), 'Same'))).toBe('Historique — Technologie');
    const list = await h.dm('documentation components Project 8');
    expect(kind(list)).toBe("Composants");
    expect(bodyText(await h.click(list, "Suivant"))).toContain("page 2/2 · 41 Composants");
    expect(bodyText(await h.dm(`documentation components ${id} 999`))).toContain('page 2/2');
    const componentChoice = await h.dm('documentation component API');
    expect(kind(componentChoice)).toBe("Choisir une fiche : Composant");
    expect(kind(await h.click(await h.click(componentChoice, "Suivant"), 'API'))).toBe("Composant");
    expect(kind(await h.dm('documentation edit component API {"type":"No guess"}'))).toBe("Référence ambiguë : Composant — modification");
    const usage = await h.click(await h.dm(`documentation technology ${technologyId}`), "Composants");
    expect(bodyText(await h.click(usage, "Suivant"))).toContain("page 2/2 · 41 Composants");
    const shared = await h.dm('documentation history', bob);
    expect(bodyText(shared)).toContain("Historique — page 1/83");
    expect(bodyText(await h.click(shared, "Suivant", bob))).toContain('Technologie:');
    expect(bodyText(await h.click(await h.click(shared, "Suivant", bob), "Suivant", bob))).toContain('Composant:');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it.each(['technology', 'component', 'host', 'hosting', 'tool'] as const)('keeps %s approvals actor/DM/workspace-bound, expiring, atomic and recoverable without repeating effects', async recordKind => {
  const h = await harness(), foreign = await harness('documentation', 'TOTHER');
  try {
    await new Budget(sql, 10_000_000, 10_000_000, 'mail').reserve(alice, 10_000_000);
    await h.dm('budget');
    await h.click(await h.dm("documentation créer projet {\"name\":\"Parent\"}"), "Confirmer la création");
    const projectId = await recordId(await h.dm('documentation project Parent'));
    const label = { technology: "Technologie", component: "Composant", host: "Hébergeur/service", hosting: "Hébergement", tool: "Outil" }[recordKind];
    const lookupKind = recordKind === 'hosting' ? 'hosting-entry' : recordKind;
    let componentId = '', serviceId = '';
    if (recordKind === 'hosting') {
      await h.click(await h.dm(`documentation créer composant ${JSON.stringify({ name: 'Parent', projectId })}`), "Confirmer la création");
      componentId = await recordId(await h.dm('documentation component Parent'));
      await h.click(await h.dm("documentation créer hébergeur {\"name\":\"Parent service\"}"), "Confirmer la création");
      serviceId = await recordId(await h.dm('documentation host Parent service'));
    }
    const create = (name: string) => `documentation create ${recordKind} ${JSON.stringify(recordKind === 'technology' || recordKind === 'host' || recordKind === 'tool' ? { name, notes: 'Initial' } : recordKind === 'hosting' ? { componentId, serviceId, environment: name, notes: 'Initial' } : { name, projectId, type: 'Initial' })}`;
    const field = recordKind === 'component' ? 'type' : 'notes';
    const replacement = { [field]: 'A' };
    const proposal = await h.dm(create('Protected'));
    expect(kind(await h.click(proposal, "Confirmer la création", bob))).toBe("Confirmation indisponible");
    expect(kind(await h.click(proposal, "Confirmer la création", { ...alice, channel: 'DOTHER' }))).toBe("Confirmation indisponible");
    expect(kind(await foreign.click(proposal, "Confirmer la création", { ...alice, team: 'TOTHER' }))).toBe("Confirmation indisponible");
    await db.exec(`CREATE FUNCTION fail_catalog_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'catalog creation history unavailable'; END; $$;
      CREATE TRIGGER fail_catalog_creation BEFORE INSERT ON documentation_record_history FOR EACH ROW EXECUTE FUNCTION fail_catalog_creation();`);
    await h.enqueueClick(proposal, button(proposal, "Confirmer la création"));
    await expect(h.drain()).rejects.toThrow('catalog creation history unavailable');
    await sql.query("UPDATE jobs SET available_at=now()+interval '1 day' WHERE status='queued'");
    const targetId = await recordId(proposal);
    expect(kind(await h.dm(`documentation ${lookupKind} ${targetId}`))).toBe(`${label} introuvable`);
    await db.exec('DROP TRIGGER fail_catalog_creation ON documentation_record_history; DROP FUNCTION fail_catalog_creation();');
    await sql.query("UPDATE jobs SET available_at=now() WHERE status='queued'");
    h.fail('uncertain');
    await expect(h.drain()).rejects.toThrow('Lost response');
    const messages = h.messages.length; await h.restart(); await h.drain(); expect(h.messages).toHaveLength(messages);
    await h.click(proposal, "Confirmer la création");
    const detail = await h.dm(`documentation ${lookupKind} ${targetId}`, bob), id = await recordId(detail);
    expect(kind(await foreign.dm(`documentation ${lookupKind} ${id}`, { ...alice, team: 'TOTHER' }))).toBe(`${label} introuvable`);
    expect(kind(await foreign.click(detail, "Historique", { ...alice, team: 'TOTHER' }))).toBe("Menu indisponible");
    const edit = await h.dm(`documentation edit ${recordKind} ${id} ${JSON.stringify(replacement)}`);
    expect(kind(await h.click(edit, "Confirmer la modification", bob))).toBe("Confirmation indisponible");
    expect(kind(await h.click(edit, "Confirmer la modification", { ...alice, channel: 'DOTHER' }))).toBe("Confirmation indisponible");
    await db.exec(`CREATE FUNCTION fail_catalog_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'catalog history unavailable'; END; $$;
      CREATE TRIGGER fail_catalog_history BEFORE INSERT ON documentation_record_history FOR EACH ROW EXECUTE FUNCTION fail_catalog_history();`);
    await h.enqueueClick(edit, button(edit, "Confirmer la modification")); await expect(h.drain()).rejects.toThrow('catalog history unavailable');
    await sql.query("UPDATE jobs SET available_at=now()+interval '1 day' WHERE status='queued'");
    expect(bodyText(await h.dm(`documentation ${lookupKind} ${id}`))).toContain(`${fieldLabel(field)}: Initial`);
    expect(bodyText(await h.dm(`documentation history ${lookupKind} ${id}`))).toContain("Historique — page 1/1");
    await db.exec('DROP TRIGGER fail_catalog_history ON documentation_record_history; DROP FUNCTION fail_catalog_history();');
    await sql.query("UPDATE jobs SET available_at=now() WHERE status='queued'");
    h.fail('reject'); await expect(h.drain()).rejects.toThrow('rejected');
    await h.restart(); await h.drain(); expect(kind(h.messages.at(-1)!)).toBe(`${label} : modification enregistrée`);
    const satisfied = await h.dm(`documentation edit ${recordKind} ${id} ${JSON.stringify(replacement)}`);
    expect(kind(await h.click(satisfied, "Confirmer la modification"))).toBe("Modification déjà satisfaite");
    expect(bodyText(await h.dm(`documentation history ${lookupKind} ${id}`))).toContain("Historique — page 1/2");
    const later = { [field]: 'Later' };
    await h.click(await h.dm(`documentation edit ${recordKind} ${id} ${JSON.stringify(later)}`, bob), "Confirmer la modification", bob);
    await h.click(edit, "Confirmer la modification"); await h.click(proposal, "Confirmer la création");
    expect(bodyText(await h.dm(`documentation ${lookupKind} ${id}`))).toContain(`${fieldLabel(field)}: Later`);
    const expired = await h.dm(`documentation edit ${recordKind} ${id} ${JSON.stringify(replacement)}`);
    await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '24 hours' WHERE id=$1", [button(expired, "Confirmer la modification").value]);
    expect(kind(await h.click(expired, "Confirmer la modification"))).toBe("Confirmation expirée");
    const oldCreation = await h.dm(create('Expired'));
    await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '24 hours' WHERE id=$1", [button(oldCreation, "Confirmer la création").value]);
    expect(kind(await h.click(oldCreation, "Confirmer la création"))).toBe("Confirmation expirée");
    const expiredTarget = await recordId(oldCreation);
    expect(kind(await h.dm(`documentation ${lookupKind} ${expiredTarget}`))).toBe(`${label} introuvable`);
    const clear = recordKind === 'tool' ? { usage: null, projects: [], companyWide: false } : recordKind === 'technology' ? { category: null, notes: '' } : recordKind === 'host' ? { monthlyCost: null, role: null } : recordKind === 'hosting' ? { environment: null, urls: [] } : { type: null, technologies: null };
    await h.click(await h.dm(`documentation edit ${recordKind} ${id} ${JSON.stringify(clear)}`), "Confirmer la modification");
    expect(bodyText(await h.dm(`documentation ${lookupKind} ${id}`))).toContain({ technology: "Catégorie: Inconnu", component: "Technologies: Inconnu", host: "Coût mensuel: Inconnu", hosting: "Environnement: Inconnu", tool: "Utilisation: Inconnu" }[recordKind]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); await foreign.app.close(); }
});

it('overwrites only confirmed fields after another User edits them and records actual before/after history', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Original\",\"description\":\"Initial\",\"notes\":\"Initial notes\"}"), "Confirmer la création");
    const details = await h.dm('documentation project Original');
    const id = await recordId(details);
    button(await h.click(details, "Modifier"), 'Remplir le formulaire');
    const proposal = await h.dm(`documentation edit project ${id} {"name":"Alice name","description":"A"}`);
    expect(kind(proposal)).toBe("Confirmation de modification du projet");
    expect(bodyText(proposal)).toContain("Nom: Alice name");
    expect(bodyText(proposal)).not.toContain('Notes:');
    expect(bodyText(await h.dm('documentation project Original', bob))).toContain('Description: Initial');
    const bobProposal = await h.dm(`documentation edit project ${id} {"description":"B","notes":"Bob notes"}`, bob);
    await h.click(bobProposal, "Confirmer la modification", bob);
    await h.click(proposal, "Confirmer la modification");
    const after = await h.dm(`documentation project ${id}`, bob);
    expect(bodyText(after)).toContain("Nom: Alice name");
    expect(bodyText(after)).toContain('Description: A');
    expect(bodyText(after)).toContain('Notes: Bob notes');
    const history = await h.dm(`documentation history ${id}`, bob);
    expect(bodyText(history)).toContain("Historique — page 1/3");
    const bobHistory = await h.click(history, "Suivant", bob);
    const aliceHistory = await h.click(bobHistory, "Suivant", bob);
    expect(bodyText(aliceHistory)).toContain("Auteur : UALICE");
    expect(comparisonValues(aliceHistory)).toEqual({ Nom: ['Original', 'Alice name'], Description: ['B', 'A'] });

    expect(bodyText(aliceHistory)).not.toContain('Notes:');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('validates one-record edits, optional clearing, alias ambiguity and stable identity across renames', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Alpha\",\"aliases\":[\"Shared\"],\"notes\":\"Keep\"}"), "Confirmer la création");
    await h.click(await h.dm("documentation créer projet {\"name\":\"Other\",\"aliases\":[\"Shared\"]}"), "Confirmer la création");
    expect(kind(await h.dm("documentation modifier projet Shared {\"notes\":\"No\"}"))).toBe("Modification de projet ambiguë");
    expect(kind(await h.dm("documentation modifier projet Missing {\"notes\":\"No\"}"))).toBe("Projet introuvable");
    for (const fields of [{}, { name: null }, { name: ' ' }, { name: 'Two\nLines' }, { aliases: [''] }, { id: 'x' }, { actor: 'x' }, { changed_at: 'x' }, { archived: true }, { repositories: ['javascript:alert(1)'] }, { notes: 'x'.repeat(1501) }, [{ name: 'A' }, { name: 'B' }]]) {
      expect(kind(await h.dm(`documentation modifier projet Alpha ${JSON.stringify(fields)}`))).toBe("Modification de projet invalide");
    }
    const details = await h.dm('documentation project Alpha');
    const id = await recordId(details);
    const pending = await h.dm('documentation edit project Alpha {"description":"Pending"}');
    const rename = await h.dm(`documentation edit project ${id} {"name":"  Renamed  ","aliases":["New alias"],"notes":null,"repositories":[]}`);
    await h.click(rename, "Confirmer la modification");
    await h.click(pending, "Confirmer la modification");
    const current = await h.dm('documentation project new ALIAS', bob);
    expect(await recordId(current)).toBe(id);
    expect(bodyText(current)).toContain("Nom: Renamed");
    expect(bodyText(current)).toContain("Notes: Inconnu");
    expect(bodyText(current)).toContain('Dépôts: Aucun élément enregistré');
    expect(bodyText(current)).toContain('Description: Pending');
    expect(kind(await h.dm('documentation project Alpha'))).toBe("Projet introuvable");
    expect(bodyText(await h.dm(`documentation history ${id}`, bob))).toContain("Historique — page 1/3");
    const shared = await h.dm('documentation history', bob);
    expect(kind(shared)).toBe("Historique partagé");
    expect(bodyText(shared)).toContain("Historique — page 1/4");
    expect(kind(await h.click(shared, "Suivant"))).toBe("Menu indisponible");
    expect(bodyText(await h.click(shared, "Suivant", bob))).toContain("Nom: Other");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it.each(['project', 'technology'] as const)('binds %s edit confirmations to actor, DM, workspace, kind and operation, with fixed expiry', async recordKind => {
  const h = await harness(), foreign = await harness('documentation', 'TOTHER');
  try {
    const suffix = recordKind === 'project' ? '' : '_technology';
    const creation = await h.dm(`documentation create ${recordKind} {"name":"Private edit"}`);
    await h.enqueueClick(creation, { ...button(creation, "Confirmer la création"), action_id: `documentation:confirm_edit${suffix}` });
    expect(kind(await h.drain())).toBe("Confirmation indisponible");
    await h.enqueueClick(creation, { ...button(creation, "Confirmer la création"), action_id: `documentation:confirm_create${recordKind === 'project' ? '_technology' : ''}` });
    expect(kind(await h.drain())).toBe("Confirmation indisponible");
    await h.click(creation, "Confirmer la création");
    const pending = await h.dm(`documentation edit ${recordKind} Private edit {"notes":"Secret replacement"}`);
    expect(kind(await h.click(pending, "Confirmer la modification", bob))).toBe("Confirmation indisponible");
    expect(kind(await h.click(pending, "Confirmer la modification", { ...alice, channel: 'DOTHER' }))).toBe("Confirmation indisponible");
    expect(kind(await foreign.click(pending, "Confirmer la modification", { ...alice, team: 'TOTHER' }))).toBe("Confirmation indisponible");
    await h.enqueueClick(pending, { ...button(pending, "Confirmer la modification"), action_id: `documentation:confirm_create${suffix}` });
    expect(kind(await h.drain())).toBe("Confirmation indisponible");
    await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '24 hours' WHERE id=$1", [button(pending, "Confirmer la modification").value]);
    await h.restart();
    expect(kind(await h.click(pending, "Confirmer la modification"))).toBe("Confirmation expirée");
    expect(bodyText(await h.dm(`documentation ${recordKind} Private edit`))).toContain("Notes: Inconnu");
    expect(bodyText(await h.dm(`documentation history ${recordKind === 'project' ? '' : 'technology '}Private edit`))).toContain("Historique — page 1/1");
  } finally { await h.app.close(); await foreign.app.close(); }
});

it('replays saved edit outcomes after intervening edits, restart, expiry and uncertain or rejected delivery', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Recovery edit\"}"), "Confirmer la création");
    for (const failure of ['uncertain', 'reject'] as const) {
      const pending = await h.dm(`documentation edit project Recovery edit {"description":"${failure}"}`);
      await h.enqueueClick(pending, button(pending, "Confirmer la modification"));
      h.fail(failure); await expect(h.drain()).rejects.toThrow();
      const count = h.messages.length;
      await sql.query("UPDATE jobs SET available_at=now()+interval '1 day' WHERE status='queued'");
      const later = await h.dm('documentation edit project Recovery edit {"description":"Later"}', bob);
      await h.click(later, "Confirmer la modification", bob);
      await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '2 days' WHERE id=$1", [button(pending, "Confirmer la modification").value]);
      await sql.query("UPDATE jobs SET available_at=now() WHERE status='queued'");
      await h.restart(); await h.drain();
      if (failure === 'uncertain') expect(h.messages.length).toBe(count + 2);
      else expect(kind(h.messages.at(-1)!)).toBe("Projet modifié");
      expect(kind(await h.click(pending, "Confirmer la modification"))).toBe("Projet modifié");
      expect(bodyText(await h.dm('documentation project Recovery edit'))).toContain('Description: Later');
    }
    expect(bodyText(await h.dm('documentation history Recovery edit'))).toContain("Historique — page 1/5");
    const satisfied = await h.dm('documentation edit project Recovery edit {"description":"Later"}');
    expect(kind(await h.click(satisfied, "Confirmer la modification"))).toBe("Modification déjà satisfaite");
    await h.click(await h.dm("documentation modifier projet Recovery edit {\"description\":\"New\"}", bob), "Confirmer la modification", bob);
    expect(kind(await h.click(satisfied, "Confirmer la modification"))).toBe("Modification déjà satisfaite");
    expect(bodyText(await h.dm('documentation project Recovery edit'))).toContain('Description: New');
    expect(bodyText(await h.dm('documentation history Recovery edit'))).toContain("Historique — page 1/6");
  } finally { await h.app.close(); }
});

it('rolls back edits and effect checkpoints when history fails, then records values current at retry', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Atomic edit\",\"description\":\"Initial\"}"), "Confirmer la création");
    const proposal = await h.dm('documentation edit project Atomic edit {"description":"A"}');
    await db.exec(`CREATE FUNCTION fail_edit_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'edit history unavailable'; END; $$;
      CREATE TRIGGER fail_edit_history BEFORE INSERT ON documentation_history FOR EACH ROW EXECUTE FUNCTION fail_edit_history();`);
    await h.enqueueClick(proposal, button(proposal, "Confirmer la modification"));
    await expect(h.drain()).rejects.toThrow('edit history unavailable');
    await sql.query("UPDATE jobs SET available_at=now()+interval '1 day' WHERE status='queued'");
    expect(bodyText(await h.dm('documentation project Atomic edit', bob))).toContain('Description: Initial');
    await db.exec('DROP TRIGGER fail_edit_history ON documentation_history; DROP FUNCTION fail_edit_history();');
    await h.click(await h.dm("documentation modifier projet Atomic edit {\"description\":\"B\"}", bob), "Confirmer la modification", bob);
    await sql.query("UPDATE jobs SET available_at=now() WHERE status='queued'");
    await h.restart(); await h.drain();
    const initial = await h.dm('documentation history Atomic edit', bob);
    const bobChange = await h.click(initial, "Suivant", bob);
    const aliceChange = await h.click(bobChange, "Suivant", bob);
    expect(bodyText(aliceChange)).toContain("Historique — page 3/3");
    expect(comparisonValues(aliceChange)).toEqual({ Description: ['B', 'A'] });
  } finally { await h.app.close(); }
});

it('shows every value in long shared history and Projects grown by independent confirmed edits', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Long\"}"), "Confirmer la création");
    const links = Array.from({ length: 10 }, (_, index) => `https://example.com/${index}/` + '-'.repeat(350));
    await h.click(await h.dm(`documentation modifier projet Long ${JSON.stringify({ repositories: links })}`), "Confirmer la modification");
    await h.click(await h.dm(`documentation modifier projet Long ${JSON.stringify({ documentationLinks: links, notes: '*'.repeat(900) + 'FINAL VALUE' })}`), "Confirmer la modification");
    let details = await h.dm('documentation project Long');
    let all = bodyText(details), allLinks = visibleLinks(details);
    while (buttons(details).some(control => control.text.text === "Valeurs suivantes")) { details = await h.click(details, "Valeurs suivantes"); all += bodyText(details); allLinks.push(...visibleLinks(details)); }
    expect(all).toContain('*'.repeat(900) + 'FINAL VALUE');
    for (const url of links) expect(allLinks).toContain(url);
    await h.click(await h.dm(`documentation modifier projet Long ${JSON.stringify({ documentationLinks: links.map(url => url.replaceAll('-', '~')), notes: '*'.repeat(900) + 'FINAL REPLACEMENT' })}`), "Confirmer la modification");
    let history = await h.dm('documentation history Long');
    for (let index = 0; index < 3; index++) history = await h.click(history, "Suivant");
    let historyText = bodyText(history), historyLinks = visibleLinks(history);
    while (buttons(history).some(control => control.text.text === "Valeurs suivantes")) { history = await h.click(history, "Valeurs suivantes"); historyText += bodyText(history); historyLinks.push(...visibleLinks(history)); }
    expect(historyText).toContain('*'.repeat(900) + 'FINAL VALUE');
    expect(historyText).toContain('*'.repeat(900) + 'FINAL REPLACEMENT');
    for (const url of links.map(url => url.replaceAll('-', '~'))) expect(historyLinks).toContain(url);
  } finally { await h.app.close(); }
});

it('preserves the saved edit target and expiry on proposal retry after a rename, and reports missing targets accurately', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Retry target\"}"), "Confirmer la création");
    const initial = await h.dm('documentation project Retry target');
    const id = await recordId(initial);
    await h.enqueueText('documentation edit project Retry target {"notes":"Original replacement"}');
    h.fail('reject'); await expect(h.drain()).rejects.toThrow('rejected');
    await sql.query("UPDATE jobs SET available_at=now()+interval '1 day' WHERE status='queued'");
    await h.click(await h.dm(`documentation modifier projet ${id} {"name":"New name"}`, bob), "Confirmer la modification", bob);
    await h.click(await h.dm("documentation créer projet {\"name\":\"Retry target\"}", bob), "Confirmer la création", bob);
    await sql.query("UPDATE jobs SET available_at=now() WHERE status='queued'");
    await h.restart(); const retry = await h.drain();
    expect(await recordId(retry)).toBe(id); expect(bodyText(retry)).toContain("Modifier le projet partagé : New name");
    await h.click(retry, "Confirmer la modification");
    expect(bodyText(await h.dm('documentation project New name'))).toContain('Notes: Original replacement');
    expect(bodyText(await h.dm('documentation project Retry target'))).toContain("Notes: Inconnu");
    const missing = await h.dm(`documentation edit project ${id} {"notes":"Missing"}`);
    // Simulate a damaged reference; record removal is not a supported User action.
    await sql.query("UPDATE documentation_confirmations SET target_id='missing-target' WHERE id=$1", [button(missing, "Confirmer la modification").value]);
    expect(kind(await h.click(missing, "Confirmer la modification"))).toBe("Modification échouée");
    await h.restart(); expect(kind(await h.click(missing, "Confirmer la modification"))).toBe("Modification échouée");
    expect(bodyText(await h.dm('documentation project New name'))).toContain('Notes: Original replacement');
    expect(bodyText(await h.dm('documentation history New name'))).toContain("Historique — page 1/3");
  } finally { await h.app.close(); }
});

it('edits exact names and aliases containing braces with JSON braces inside replacement strings', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm("documentation créer projet {\"name\":\"Alpha {Beta}\",\"aliases\":[\"Alias {with braces}\"]}"), "Confirmer la création");
    const notes = 'Literal {braces} and a nested-looking {"notes":"value"}';
    const named = await h.dm(`documentation edit project Alpha {Beta} ${JSON.stringify({ notes })}`);
    expect(kind(named)).toBe("Confirmation de modification du projet");
    expect(bodyText(named)).toContain(`Notes: ${notes}`);
    await h.click(named, "Confirmer la modification");
    const aliased = await h.dm('documentation edit project Alias {with braces} {"description":"Alias edit"}', bob);
    expect(kind(aliased)).toBe("Confirmation de modification du projet");
    await h.click(aliased, "Confirmer la modification", bob);
    const current = await h.dm('documentation project Alpha {Beta}');
    expect(bodyText(current)).toContain(`Notes: ${notes}`);
    expect(bodyText(current)).toContain('Description: Alias edit');
  } finally { await h.app.close(); }
});

it('keeps confirmations private and saved effects unique across forged controls, duplicate clicks, restarts and delivery failures', async () => {
  const h = await harness();
  try {
    const proposal = await h.dm('documentation create project {"name":"Recovery"}');
    expect(kind(await h.click(proposal, "Confirmer la création", bob))).toBe("Confirmation indisponible");
    expect(kind(await h.click(proposal, "Confirmer la création", { ...alice, channel: 'DOTHER' }))).toBe("Confirmation indisponible");
    expect(bodyText(await h.dm('documentation projects', bob))).toContain("Aucun projet");
    await h.enqueueClick(proposal, button(proposal, "Confirmer la création"));
    h.fail('uncertain');
    await expect(h.drain()).rejects.toThrow('Lost response');
    const afterDelivery = h.messages.length;
    await h.restart(); await h.drain();
    expect(h.messages).toHaveLength(afterDelivery);
    await h.click(proposal, "Confirmer la création");
    const details = await h.dm('documentation project Recovery', bob);
    const history = await h.click(details, "Historique", bob);
    expect(bodyText(history).match(/Source : Commande structurée Slack — création/g)).toHaveLength(1);
    expect(bodyText(await h.dm('documentation projects'))).toContain("page 1/1 · 1 projets");
    const rejected = await h.dm('documentation create project {"name":"Rejected delivery"}');
    await h.enqueueClick(rejected, button(rejected, "Confirmer la création"));
    h.fail('reject'); await expect(h.drain()).rejects.toThrow('rejected');
    await h.restart(); await h.drain();
    expect(kind(h.messages.at(-1)!)).toBe("Projet créé");
    await h.click(rejected, "Confirmer la création");
    const again = await h.dm('documentation project Rejected delivery');
    expect(bodyText(await h.click(again, "Historique")).match(/Source : Commande structurée Slack — création/g)).toHaveLength(1);
  } finally { await h.app.close(); }
});

it('pages shared Projects and ambiguous exact lookups privately, and renders saved links as links with all fixed values', async () => {
  const h = await harness();
  try {
    for (let index = 0; index < 41; index++) {
      const proposal = await h.dm(`documentation create project ${JSON.stringify({ name: `Project ${index}`, aliases: ['Shared alias'], description: 'A description', repositories: ['https://example.com/repo?q=1&branch=main'], documentationLinks: ['http://docs.example.com/alpha'], notes: 'Notes\nSecond line' })}`);
      expect(bodyText(proposal)).toContain('Notes\nSecond line');
      await h.click(proposal, "Confirmer la création");
    }
    const first = await h.dm('documentation projects', bob);
    expect(bodyText(first)).toContain("page 1/2 · 41 projets");
    const wrongUser = await h.click(first, "Suivant");
    expect(kind(wrongUser)).toBe("Menu indisponible");
    const second = await h.click(first, "Suivant", bob);
    expect(second.ts).toBe(first.ts);
    expect(second.method).toBe('chat.update');
    expect(bodyText(second)).toContain('Project 9');
    expect(bodyText(second)).not.toContain('Project 0');
    const ambiguous = await h.dm('documentation project Shared alias', bob);
    expect(kind(ambiguous)).toBe("Choisir un projet");
    expect(bodyText(ambiguous)).toContain("ambiguë");
    const choices = await h.click(ambiguous, "Suivant", bob);
    const details = await h.click(choices, 'Project 9', bob);
    expect(bodyText(details)).toContain('Notes: Notes\nSecond line');
    const links = visibleLinks(details).map(url => ({ url }));
    expect(links.map(part => part.url)).toEqual(['https://example.com/repo?q=1&branch=main', 'http://docs.example.com/alpha']);
    const ambiguousHistory = await h.dm('documentation history Shared alias', bob);
    const selectedHistory = await h.click(ambiguousHistory, 'Project 0', bob);
    expect(kind(selectedHistory)).toBe("Historique du projet");
    expect(bodyText(selectedHistory)).toContain("Nom: Project 0");
    expect(kind(await h.dm('documentation project Project', bob))).toBe("Projet introuvable");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('shows exact literal values on the confirmation Card and rejects editable metadata, multiple records and unsafe links', async () => {
  const h = await harness();
  try {
    const notes = 'A&B <@UBOB> *bold* [forged](https://evil.example) !here';
    const proposal = await h.dm(`documentation create project ${JSON.stringify({ name: 'Literal', notes })}`);
    expect(bodyText(proposal)).toContain('Notes: A&B <@UBOB> *bold* forged !here');
    expect(visibleLinks(proposal)).toContain('https://evil.example');
    for (const fields of [{ name: '' }, { name: 'A', id: 'editable' }, [{ name: 'A' }, { name: 'B' }], { name: 'A', repositories: ['javascript:alert(1)'] }, { name: 'A', notes: 'x'.repeat(1501) }, { name: 'A', repositories: ['https://user:secret@example.com'] }]) {
      expect(kind(await h.dm(`documentation créer projet ${JSON.stringify(fields)}`))).toBe("Projet invalide");
    }
    expect(bodyText(await h.dm('documentation projects'))).toContain("Aucun projet");
    await h.click(proposal, "Confirmer la création");
    const details = await h.dm('documentation project Literal');
    expect(bodyText(details)).toContain('Notes: A&B <@UBOB> *bold* forged !here');
    expect(visibleLinks(details)).toContain('https://evil.example');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('expires creation after 24 hours, preserves an applied outcome after expiry and does not refresh proposals on retry', async () => {
  const h = await harness();
  try {
    const old = await h.dm('documentation create project {"name":"Expired"}');
    await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '24 hours' WHERE id=$1", [button(old, "Confirmer la création").value]);
    await h.restart();
    expect(kind(await h.click(old, "Confirmer la création"))).toBe("Confirmation expirée");
    expect(bodyText(await h.dm('documentation projects'))).toContain("Aucun projet");
    await h.enqueueText('documentation create project {"name":"Retry"}');
    h.fail('reject'); await expect(h.drain()).rejects.toThrow('rejected');
    await h.restart(); const proposal = await h.drain();
    const id = button(proposal, "Confirmer la création").value;
    await h.click(proposal, "Confirmer la création");
    await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '2 days' WHERE id=$1", [id]);
    expect(kind(await h.click(proposal, "Confirmer la création"))).toBe("Projet créé");
    expect(bodyText(await h.dm('documentation projects'))).toContain("1 projets");
    expect(bodyText(await h.dm('documentation history Retry')).match(/Source : Commande structurée Slack — création/g)).toHaveLength(1);
    await h.enqueueText('documentation create project {"name":"Retry expired"}');
    h.fail('reject'); await expect(h.drain()).rejects.toThrow('rejected');
    await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '2 days' WHERE applied_at IS NULL");
    await h.restart(); const expiredRetry = await h.drain();
    expect(kind(await h.click(expiredRetry, "Confirmer la création"))).toBe("Confirmation expirée");
    expect(bodyText(await h.dm('documentation projects'))).toContain("1 projets");
  } finally { await h.app.close(); }
});

it('scopes shared Projects/history to the configured workspace even with the same User IDs in another installation', async () => {
  const h = await harness(), foreign = await harness('documentation', 'TOTHER');
  const otherAlice = { ...alice, team: 'TOTHER' };
  try {
    const proposal = await h.dm('documentation create project {"name":"Workspace private"}');
    await h.click(proposal, "Confirmer la création");
    const details = await h.dm('documentation project Workspace private');
    const identifier = await recordId(details);
    expect(bodyText(await foreign.dm('documentation projects', otherAlice))).toContain("Aucun projet");
    expect(kind(await foreign.dm(`documentation project ${identifier}`, otherAlice))).toBe("Projet introuvable");
    expect(kind(await foreign.dm(`documentation history ${identifier}`, otherAlice))).toBe("Projet introuvable");
    expect(kind(await foreign.click(proposal, "Confirmer la création", otherAlice))).toBe("Confirmation indisponible");
    expect(kind(await foreign.click(details, "Historique", otherAlice))).toBe("Menu indisponible");
    expect(bodyText(await h.dm('documentation projects'))).toContain("1 projets");
  } finally { await h.app.close(); await foreign.app.close(); }
});

it('answers only real bot mentions, keeps channel replies threaded and reuses the saved answer on retry', async () => {
  const h = await harness('', 'TTEAM', { OPENAI_API_KEY: 'fake' });
  try {
    const provider = interpreter({ source: '', answer: 'A queue processes jobs in order.' });
    const channel = { ...alice, channel: 'CTEAM' };
    await h.dm('<@UOTHER> What is a queue?', channel);
    expect(h.messages).toHaveLength(0);
    await h.dm('What is a queue?', alice);
    expect(provider).not.toHaveBeenCalled();
    const time = await h.dm('<@UMAYA> Tell me which time is it', channel);
    expect(time.body).toMatchObject({ thread_ts: '123.456', text: expect.stringMatching(/It’s \d\d:\d\d in Paris/) });
    expect(provider).not.toHaveBeenCalled();
    const id = randomUUID();
    await h.enqueueText('<@UMAYA> What is a queue?', channel, true, id);
    h.fail('reject');
    await expect(h.drain()).rejects.toThrow('Slack delivery was rejected');
    const reply = await h.drain();
    expect(reply.body).toMatchObject({ text: 'A queue processes jobs in order.', thread_ts: '123.456' });
    expect(reply.body.blocks.map((b: any) => b.type)).toEqual(['markdown']);
    expect(provider).toHaveBeenCalledTimes(2);
    await h.enqueueText('<@UMAYA> What is a queue?', channel, true, id);
    const before = h.messages.length;
    await h.drain();
    expect(h.messages).toHaveLength(before);
  } finally { await h.app.close(); }
});

it('answers ordinary Documentation questions from current cells with sources and sends only headings and the question for interpretation', async () => {
  const project = [['Projet', 'Responsable'], ['Alpha', 'Camille'], ['Beta', '']];
  const sources: Record<string, string[][]> = { projet: project, Technologies: [['Technologie']], hébergement: [['Hébergeur']], Outils: [['Outil', 'Référent'], ['Tracker', 'Alex']] };
  let q = { tab: 'projects', mode: 'values', fields: ['Responsable'], filters: [{ field: 'Projet', match: 'equals', value: 'Alpha' }] };
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic', expires_in: 3600 });
    if (url.hostname === 'sheets.googleapis.com') {
      expect(init?.method).toBe('GET');
      const titles = url.searchParams.getAll('ranges').map(s => s.slice(1, -1));
      return Response.json({ sheets: titles.reverse().map(title => ({ properties: { title, sheetId: Object.keys(sources).indexOf(title) + 3 }, data: [
        { rowData: sources[title]!.map(row => ({ values: row.map(s => ({ formattedValue: s, userEnteredValue: { stringValue: s } })) })) },
      ] })) });
    }
    expect(url.hostname).toBe('api.openai.com');
    const body = JSON.parse(String(init?.body));
    if (body.text.format.name === 'mention_answer') {
      expect(JSON.parse(body.input).sources).toEqual(['documentation']);
      if (url.pathname.endsWith('input_tokens')) return Response.json({ input_tokens: 35 });
      return Response.json({ status: 'completed', usage: { input_tokens: 35, output_tokens: 8 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify({ source: 'documentation', answer: '' }) }] }] });
    }
    expect(JSON.parse(body.input)).toMatchObject({ schema: expect.arrayContaining([{ tab: 'projects', headings: project[0] }]) });
    for (const privateValue of ['Camille', 'Marine', 'Tracker', 'Alex']) expect(body.input).not.toContain(privateValue);
    if (url.pathname.endsWith('input_tokens')) return Response.json({ input_tokens: 80 });
    calls++;
    return Response.json({ status: 'completed', usage: { input_tokens: 80, output_tokens: 35 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify({ queries: [q] }) }] }] });
  }));
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const h = await harness('documentation', 'TTEAM', { OPENAI_API_KEY: 'synthetic', DOCUMENTATION_SPREADSHEET_ID: 'qa-book',
    DOCUMENTATION_GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'test@example.invalid', private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }) }) });
  try {
    const channelReply = await h.dm('<@UMAYA> documentation Qui est responsable du projet Alpha ?', { ...alice, channel: 'CTEAM' });
    expect(channelReply.body.text).toContain('message privé');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    const plain = await h.dm('documentation Qui est responsable du projet Alpha ?');
    expect(plain.body.text).not.toContain('Camille');
    expect(calls).toBe(0);
    const ask = () => h.dm('<@UMAYA> documentation Qui est responsable du projet Alpha ?');
    const first = await ask();
    expect(first.body.text).toContain('Camille');
    expect(first.body.blocks[0].text).toContain('https://docs.google.com/spreadsheets/d/qa-book/edit#gid=3&range=B2');
    project[0]!.splice(1, 0, 'Fonction'); project[1] = ['Alpha', 'Design', 'Marine']; project[2] = ['Beta', '', ''];
    const updated = await h.dm('<@UMAYA> Qui est responsable du projet Alpha ?');
    expect(updated.body.text).toContain('Marine');
    expect(updated.body.blocks[0].text).toContain('https://docs.google.com/spreadsheets/d/qa-book/edit#gid=3&range=C2');
    q = { tab: 'projects', mode: 'count', fields: [], filters: [{ field: 'Responsable', match: 'empty', value: '' }] };
    const counted = await h.dm('<@UMAYA> documentation Combien de projets sans responsable ?');
    expect(counted.body.text).toContain('1 ligne correspond');
    q = { tab: 'projects', mode: 'values', fields: ['Invented'], filters: [] };
    expect((await ask()).body.text).toContain('Précisez');
    q = { ...q, fields: ['Responsable'], filters: [{ field: 'Projet', match: 'equals', value: 'Beta' }] };
    expect((await ask()).body.text).toContain('Précisez');
    const searched = await h.dm('documentation chercher Tracker');
    expect(bodyText(searched)).toContain('Outils!A2');
    expect(calls).toBe(5);
    expect((await sql.query("SELECT count(*)::int AS n FROM documentation_questions WHERE status='workbook_ready' AND reservation_id IS NOT NULL")).rows[0].n).toBeGreaterThanOrEqual(5);
  } finally { await h.app.close(); }
});

it('discovers a new Google column through Slack navigation and prepares its row action', async () => {
  const headers = ['Projet', 'Équipe'], data = ['Alpha', 'Design'];
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic', expires_in: 3600 });
    expect(new URL(url).searchParams.get('ranges')).toBe("'projet'");
    return Response.json({ sheets: [{ properties: { title: 'projet', sheetId: 3 }, data: [{ rowData:
      [headers, data].map(row => ({ values: row.map(s => ({ formattedValue: s, userEnteredValue: { stringValue: s } })) })) }] }] });
  }));
  const h = await harness('documentation', 'TTEAM', { DOCUMENTATION_SPREADSHEET_ID: 'synthetic',
    DOCUMENTATION_GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'test@example.invalid', private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }) }) });
  try {
    const tab = await h.click(await h.dm('documentation classeur'), 'projet');
    headers.splice(1, 0, 'Responsable'); data.splice(1, 0, 'Camille');
    const refreshed = await h.click(tab, 'Actualiser');
    const open = parts(refreshed).find(b => b.type === 'data_table').rows[1].at(-1).element;
    await h.enqueueClick(refreshed, open);
    const detail = await h.drain();
    const row = parts(detail).find(b => b.type === 'data_table').rows.find((r: any[]) => cellValue(r[0]) === 'Responsable');
    expect(cellValue(row[1])).toBe('Camille');
    expect(row[2].element.text.text).toBe('Modifier · Responsable');
    await h.enqueueClick(detail, row[2].element);
    button(await h.drain(), 'Remplir le formulaire');
  } finally { await h.app.close(); }
});

it('keeps signed ingress and workspace validation and pauses disabled Documentation with private navigation intact', async () => {
  const h = await harness();
  try {
    expect((await h.enqueueText('documentation projects', alice, false)).statusCode).toBe(401);
    expect((await h.enqueueText('documentation projects', { ...alice, team: 'TOTHER' })).statusCode).toBe(403);
    const menu = await h.dm('menu');
    const documentation = await h.click(menu, 'Documentation');
    const list = await h.click(documentation, "Projets");
    expect(kind(await h.click(list, "Retour au menu"))).toBe('Menu');
    expect(kind(await h.click(menu, 'Documentation', bob))).toBe("Menu indisponible");
    const add = await h.click(documentation, "Ajouter un projet");
    button(add, 'Remplir le formulaire');
    const beforeUnmentioned = h.messages.length;
    await h.dm('projects');
    expect(h.messages).toHaveLength(beforeUnmentioned);
    const proposal = await h.dm('documentation create project {"name":"Paused"}');
    expect((await h.enqueueClick(proposal, button(proposal, "Confirmer la création"), { ...alice, team: 'TOTHER' })).statusCode).toBe(403);
    expect((await h.enqueueClick(proposal, button(proposal, "Confirmer la création"), alice, false)).statusCode).toBe(401);
    const deliveryId = randomUUID();
    await h.enqueueText('documentation create project {"name":"Queued"}', alice, true, deliveryId);
    await h.enqueueText('documentation create project {"name":"Queued"}', alice, true, deliveryId);
    await h.restart('');
    const count = h.messages.length;
    await h.drain(); expect(h.messages).toHaveLength(count);
    expect(buttons(await h.dm('menu')).map(item => item.text.text)).not.toContain('Documentation');
    expect(kind(await h.click(proposal, "Confirmer la création"))).toBe("Aide");
    expect(kind(await h.click(menu, 'Documentation'))).toBe("Module indisponible");
    await h.restart();
    const queuedProposal = await h.drain();
    expect(kind(queuedProposal)).toBe("Confirmation de création du projet");
    await h.click(queuedProposal, "Confirmer la création");
    await h.click(proposal, "Confirmer la création");
    expect(bodyText(await h.dm('documentation projects', bob))).toContain("2 projets");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('retains lifetime inventory/history while cleaning expired private metadata and preserving checkpoints for pending jobs', async () => {
  const h = await harness();
  try {
    const proposal = await h.dm('documentation create project {"name":"Lifetime"}');
    await h.click(proposal, "Confirmer la création");
    await h.enqueueText('documentation create project {"name":"Pending delivery"}');
    h.fail('uncertain'); await expect(h.drain()).rejects.toThrow('Lost response');
    const attempts = h.messages.length;
    await db.exec(`UPDATE documentation_projects SET created_at=now()-interval '60 days';
      UPDATE documentation_history SET changed_at=now()-interval '60 days';
      UPDATE documentation_confirmations SET created_at=now()-interval '60 days';
      UPDATE documentation_deliveries SET created_at=now()-interval '60 days';`);
    const modules = createModules(readConfig(env), sql, env);
    await modules.all()[0]!.cleanup?.({} as any);
    await h.restart(); await h.drain();
    expect(h.messages).toHaveLength(attempts);
    const details = await h.dm('documentation project Lifetime', bob);
    expect(bodyText(details)).toContain("Nom: Lifetime");
    expect(bodyText(await h.click(details, "Historique", bob))).toContain("Nom: Lifetime");
    expect(bodyText(await h.dm('documentation projects'))).toContain("1 projets");
  } finally { await h.app.close(); }
});

it('rolls back the Project and confirmation effect if initial history fails, then safely retries the saved operation', async () => {
  const h = await harness();
  try {
    const proposal = await h.dm('documentation create project {"name":"Atomic"}');
    await db.exec(`CREATE FUNCTION fail_documentation_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'history unavailable'; END; $$;
      CREATE TRIGGER fail_history BEFORE INSERT ON documentation_history FOR EACH ROW EXECUTE FUNCTION fail_documentation_history();`);
    await h.enqueueClick(proposal, button(proposal, "Confirmer la création"));
    await expect(h.drain()).rejects.toThrow('history unavailable');
    await sql.query("UPDATE jobs SET available_at=now()+interval '1 day' WHERE status='queued'");
    expect(bodyText(await h.dm('documentation projects', bob))).toContain("Aucun projet");
    await db.exec('DROP TRIGGER fail_history ON documentation_history; DROP FUNCTION fail_documentation_history();');
    await sql.query("UPDATE jobs SET available_at=now() WHERE status='queued'");
    await h.restart(); await h.drain();
    expect(kind(h.messages.at(-1)!)).toBe("Projet créé");
    expect(bodyText(await h.dm('documentation history Atomic', bob)).match(/Source : Commande structurée Slack — création/g)).toHaveLength(1);
  } finally { await h.app.close(); }
});

it('keeps all delivered Documentation paths available when the shared AI allowance is exhausted', async () => {
  const h = await harness();
  try {
    await new Budget(sql, 10_000_000, 10_000_000, 'mail').reserve(alice, 10_000_000);
    await h.dm('documentation create project {"name":"No AI needed","aliases":["Budgetless"]}');
    const proposal = h.messages.find(message => kind(message) === "Confirmation de création du projet")!;
    await h.click(proposal, "Confirmer la création");
    const project = await h.dm('documentation project Budgetless', bob);
    expect(bodyText(project)).toContain("Nom: No AI needed");
    const identifier = await recordId(project);
    expect(bodyText(await h.dm(`documentation project ${identifier}`))).toContain("Nom: No AI needed");
    expect(bodyText(await h.dm('documentation history Budgetless', bob))).toContain("Source : Commande structurée Slack — création");
    const edit = await h.dm('documentation edit project Budgetless {"notes":"Still no AI needed"}', bob);
    expect(kind(await h.click(edit, "Confirmer la modification", bob))).toBe("Projet modifié");
    expect(bodyText(await h.dm('documentation project Budgetless'))).toContain('Notes: Still no AI needed');
    expect(kind(await h.dm('documentation'))).toBe("Aide — Documentation");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});
