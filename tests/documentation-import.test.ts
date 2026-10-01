import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { reviewSnapshot, approveReview, DocumentationImport } from '../src/modules/documentation/import.js';
import type { Sql } from '../src/core/store.js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, vi } from 'vitest';
import { coreSchema } from '../src/core/store.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { dispatchJob } from '../src/core/dispatch.js';
import { createDocumentationModule } from '../src/modules/documentation/index.js';
import { runImportCommand } from '../src/modules/documentation/import-cli.js';
import { cellText, type AgentMessage, type Messenger } from '../src/core/slack.js';
import { importSnapshot, importConfig, resolvedImportReview } from './fixtures/documentation-import-review.js';

const snapshot = JSON.stringify({ version: 1, source: 'Synthetic workbook', sheets: [
  { name: 'Projects', cells: [{ address: 'A1', value: 'name' }, { address: 'A2', value: 'Alpha', formula: '=HYPERLINK("https://example.com/alpha","Alpha")' }] },
  { name: 'Tools', cells: [{ address: 'A1', value: 'name' }, { address: 'B1', value: 'usage' }, { address: 'A2', value: 'Tracker' }, { address: 'B2', value: 'Alpha / Unknown project' }] },
  { name: 'Hosts', cells: [{ address: 'A1', value: 'name' }, { address: 'A2', value: 'Cloud' }, { address: 'A3', value: 'Cloud' }] },
] });
const config = { workspace: 'TTEAM', enabledModules: ['documentation'] };

it('reviews literal cells and hyperlink display/links without silently resolving usage or duplicate services', () => {
  const review = reviewSnapshot(snapshot, config);
  expect(review.cells.find(cell => cell.cell === 'Projects!A2')).toMatchObject({ text: 'Alpha', link: 'https://example.com/alpha', raw: { formula: '=HYPERLINK("https://example.com/alpha","Alpha")' } });
  expect(review.records.filter(record => record.kind === 'host')).toHaveLength(2);
  expect(review.cells.find(cell => cell.cell === 'Tools!B2')?.text).toBe('Alpha / Unknown project');
  expect(review.warnings.some(warning => warning.includes('Cloud'))).toBe(true);
  expect(() => approveReview(snapshot, review, config, 'User')).toThrow(/unresolved/i);
});

let db: PGlite, sql: Sql;
beforeAll(async () => {
  db = new PGlite();
  sql = { query: async (text, values) => values ? db.query(text, values) : (await db.exec(text)).at(-1) ?? { rows: [] } };
  await sql.query(coreSchema);
  await createDocumentationModule(sql).initialize!(sql);
});
beforeEach(async () => {
  await db.exec('TRUNCATE documentation_import_effects,documentation_import_batches,documentation_records,documentation_projects,documentation_confirmations,documentation_deliveries,documentation_lookups,core_navigation_menus,core_navigation_deliveries,ai_calls,ai_months CASCADE');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external provider call'); }));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => db.close());

async function slackRead(command: string, team = 'TTEAM') {
  const modules = new ModuleRegistry([createDocumentationModule(sql)]), messages: AgentMessage[] = [];
  const messenger: Messenger = { async send(_actor, message) { messages.push(message); }, async post(_actor, message) { messages.push(message); return `1.${messages.length}`; }, async update(_actor, _ts, message) { messages.push(message); } };
  await dispatchJob(sql, { AI_MONTHLY_LIMIT_USD: 0, AI_USER_MONTHLY_LIMIT_USD: 0, AI_ALERT_USD: 8, SLACK_ADMIN_USER_ID: '' }, modules, messenger,
    { ...modules.text(command), actor: { team, user: 'UALICE', channel: 'DALICE' }, id: randomUUID() });
  const message = messages.at(-1)!;
  return { ...message, text: [message.text, ...(message.table?.rows.map(row => row.map(cellText).join(': ')) ?? [])].join('\n') };
}
const identity = (message: AgentMessage) => message.buttons!.find(button => /request_(archive|restore)$/.test(button.action))!.value.split('|')[1]!.split(':')[1]!;

it('imports and reconciles a single Component with 26 reviewed Technologies without dropping references', async () => {
  const workbook = JSON.parse(importSnapshot);
  workbook.sheets.push({ name: 'Additional technologies', cells: Array.from({ length: 24 }, (_, index) => [
    { address: `A${index + 1}`, value: `Extra technology ${index + 1}` }, { address: `B${index + 1}`, value: 'Web' },
  ]).flat() });
  const expandedSnapshot = JSON.stringify(workbook), base = resolvedImportReview();
  const review = reviewSnapshot(expandedSnapshot, importConfig);
  review.records = base.records; review.resolutions = base.resolutions;
  const component = review.records.find(record => record.key === 'web')!;
  for (let index = 0; index < 24; index++) {
    const key = `extra-${index + 1}`, nameCell = `Additional technologies!A${index + 1}`, usageCell = `Additional technologies!B${index + 1}`;
    review.records.push({ key, kind: 'technology', fields: { name: `Extra technology ${index + 1}` }, evidence: { name: [{ cell: nameCell, reason: 'Synthetic explicit Technology name' }] } });
    (component.fields.technologies as string[]).push(`@${key}`);
    component.evidence.technologies!.push({ cell: usageCell, reason: 'Synthetic User confirms the explicitly named Web Component uses this Technology' });
  }
  for (const cell of review.cells) {
    const keys = review.records.filter(record => Object.values(record.evidence).flat().some(entry => entry.cell === cell.cell)).map(record => record.key);
    cell.decision = { disposition: keys.length ? 'mapped' : 'retained', records: keys, reason: 'Synthetic User resolved the complete mapping; original source preserved' };
  }
  const approval = approveReview(expandedSnapshot, review, importConfig, 'Synthetic User');
  const importer = new DocumentationImport(sql, importConfig);
  expect(await importer.apply(expandedSnapshot, review, approval)).toMatchObject({ authoritative: true, reconciled: true, expected: 32, applied: 32, initialHistory: 32, relationships: 30,
    counts: { project: 1, technology: 26, host: 2, component: 1, hosting: 1, tool: 1 }, problems: [] });
  const detail = await slackRead('documentation component Web');
  expect(detail.buttons?.filter(button => /^(React|Node|Extra technology \d+)$/.test(button.label))).toHaveLength(26);
  expect(detail.buttons?.some(button => button.label === 'Extra technology 24')).toBe(true);
  expect(await importer.apply(expandedSnapshot, review, approval)).toMatchObject({ applied: 32, initialHistory: 32, relationships: 30 });
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

it('applies an explicitly reviewed workbook through operator commands and reconciles public Slack lists, relationships and history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'documentation-import-'));
  const source = join(directory, 'snapshot.json'), mapping = join(directory, 'review.json'), approvalFile = join(directory, 'approval.json');
  const env = { SLACK_TEAM_ID: 'TTEAM', ENABLED_MODULES: 'documentation' };
  try {
    await writeFile(source, importSnapshot);
    await runImportCommand(['review', source, mapping], env);
    expect((await slackRead('documentation projects')).text).toContain('0 Projects');
    await expect(runImportCommand(['approve', source, mapping, approvalFile, 'Synthetic User'], env)).rejects.toThrow(/unresolved/i);
    await writeFile(mapping, JSON.stringify(resolvedImportReview()));
    await runImportCommand(['approve', source, mapping, approvalFile, 'Synthetic User'], env);
    const result = await runImportCommand(['apply', source, mapping, approvalFile], env, sql);
    expect(result).toMatchObject({ status: 'reconciled', authoritative: true, reconciled: true, expected: 8, applied: 8, existing: 0, initialHistory: 8, relationships: 6,
      counts: { project: 1, technology: 2, host: 2, component: 1, hosting: 1, tool: 1 }, problems: [] });
    const project = await slackRead('documentation project Alpha');
    expect(project.table?.rows.flat().filter(cell => typeof cell !== 'string').flat().map(part => part.url)).toContain('https://example.com/alpha');
    expect(project.text).toContain('Description: Unknown');
    const hosts = await slackRead('documentation hosts');
    expect(hosts.text).toContain('2 Hosts/services');
    const hostIds = hosts.selects!.flatMap(select => select.options.map(option => option.value.split('host_')[1]!));
    expect(hostIds).toHaveLength(2);
    for (const id of hostIds) {
      expect((await slackRead(`documentation host ${id}`)).text).toContain('Name: Cloud');
      expect((await slackRead(`documentation history host ${id}`)).text).toContain('Spreadsheet import');
    }
    expect((await slackRead('documentation tool Tracker')).text).toContain('Company-wide: Unknown');
    expect((await slackRead('documentation tool Tracker')).text).toContain('Alpha / Unknown project');
    expect((await slackRead('documentation components Alpha')).text).toContain('Web');
    const component = await slackRead('documentation component Web');
    expect(component.buttons?.some(button => button.label.includes('React'))).toBe(true);
    expect(component.buttons?.some(button => button.label.includes('Node'))).toBe(true);
    const hosting = await slackRead('documentation hosting Web');
    expect(hosting.text).toContain('production');
    const hostingId = hosting.selects![0]!.options[0]!.value.split('hosting_')[1]!;
    expect((await slackRead(`documentation hosting-entry ${hostingId}`)).text).toContain('Component: Alpha / Web');
    expect((await slackRead(`documentation history hosting-entry ${hostingId}`)).text).toContain('Spreadsheet import');
    for (const command of ['technology React', 'component Web', 'host Cloud', 'tool Tracker']) {
      const details = await slackRead(`documentation ${command}`);
      if (command === 'host Cloud') { expect(details.kind).toBe('Choose a Host/service'); continue; }
      const history = await slackRead(`documentation history ${command}`);
      expect(history.text).toContain('Spreadsheet import');
    }
    const history = await slackRead('documentation history Alpha');
    expect(history.text).toContain('Synthetic User'); expect(history.text).toContain('Spreadsheet import'); expect(history.text).toContain('batch');
    expect((await slackRead('documentation project Alpha', 'TOTHER')).kind).toBe('Project not found');
    expect(await runImportCommand(['apply', source, mapping, approvalFile], env, sql)).toMatchObject({ applied: 8, initialHistory: 8, relationships: 6 });
    await runImportCommand(['recover', join(directory, 'recovered')], env, sql);
    expect(await readFile(join(directory, 'recovered', 'snapshot.json'), 'utf8')).toBe(importSnapshot);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('retains partial outcomes, rolls back failed record/history together, and resumes after restart without duplicating completed effects', async () => {
  const review = resolvedImportReview(), approval = approveReview(importSnapshot, review, importConfig, 'Synthetic User');
  let fail = true;
  const flaky: Sql = { query: async (text, values) => {
    if (fail && text.startsWith('INSERT INTO documentation_record_history') && values?.at(-1) === 'component') { fail = false; throw new Error('Synthetic history failure'); }
    return sql.query(text, values);
  } };
  const partial = await new DocumentationImport(flaky, importConfig).apply(importSnapshot, review, approval);
  expect(partial).toMatchObject({ status: 'failed', authoritative: false, applied: 5, initialHistory: 5 });
  expect((await slackRead('documentation components Alpha')).text).toContain('0 Components');
  const resumed = await new DocumentationImport(sql, importConfig).apply(importSnapshot, review, approval);
  expect(resumed).toMatchObject({ authoritative: true, applied: 8, initialHistory: 8, relationships: 6, problems: [] });
  expect((await slackRead('documentation technologies')).text).toContain('2 Technologies');
});

it('recovers a committed effect after a lost commit response and never overwrites a later Slack edit on replay', async () => {
  const review = resolvedImportReview(), approval = approveReview(importSnapshot, review, importConfig, 'Synthetic User');
  let loseResponse = true, wroteHistory = false;
  const uncertain: Sql = { query: async (text, values) => {
    const result = await sql.query(text, values);
    if (text.startsWith('INSERT INTO documentation_history')) wroteHistory = true;
    if (loseResponse && wroteHistory && text === 'COMMIT') { loseResponse = false; throw new Error('Synthetic lost COMMIT response'); }
    return result;
  } };
  expect(await new DocumentationImport(uncertain, importConfig).apply(importSnapshot, review, approval)).toMatchObject({ applied: 1, authoritative: false });
  await new DocumentationImport(sql, importConfig).apply(importSnapshot, review, approval);
  const proposal = await slackRead('documentation edit project Alpha {"notes":"Later Slack edit"}');
  await confirmSlack(proposal);
  const replay = await new DocumentationImport(sql, importConfig).apply(importSnapshot, review, approval);
  expect(replay).toMatchObject({ authoritative: true, reconciled: false, applied: 8, initialHistory: 8 });
  expect((await slackRead('documentation project Alpha')).text).toContain('Later Slack edit');
});

async function confirmSlack(message: AgentMessage, team = 'TTEAM') {
  const modules = new ModuleRegistry([createDocumentationModule(sql)]);
  const button = message.buttons!.find(button => button.action.startsWith('documentation:confirm'))!;
  await dispatchJob(sql, { AI_MONTHLY_LIMIT_USD: 0, AI_USER_MONTHLY_LIMIT_USD: 0, AI_ALERT_USD: 8, SLACK_ADMIN_USER_ID: '' }, modules, { async send() {} },
    { ...modules.action(button.action, button.value), actor: { team, user: 'UALICE', channel: 'DALICE' }, id: randomUUID() });
}

it('rejects altered approval/snapshot/mapping, unsupported fields, missing evidence and invalid references before inventory writes', async () => {
  const review = resolvedImportReview(), approval = approveReview(importSnapshot, review, importConfig, 'Synthetic User');
  const changed = structuredClone(review); changed.records[0]!.fields.name = 'Changed';
  await expect(new DocumentationImport(sql, importConfig).apply(importSnapshot, changed, approval)).rejects.toThrow(/approval/i);
  await expect(new DocumentationImport(sql, importConfig).apply(`${importSnapshot}\n`, review, approval)).rejects.toThrow(/snapshot/i);
  expect(() => approveReview(importSnapshot, review, { ...importConfig, workspace: 'TOTHER' }, 'User')).toThrow(/workspace/i);
  expect(() => approveReview(importSnapshot, review, { ...importConfig, enabledModules: [] }, 'User')).toThrow(/enabled/i);
  const invalidRef = structuredClone(review); invalidRef.records.find(record => record.key === 'web')!.fields.projectId = '@react';
  expect(() => approveReview(importSnapshot, invalidRef, importConfig, 'User')).toThrow(/reference/i);
  const noEvidence = structuredClone(review); noEvidence.records.find(record => record.key === 'production')!.evidence.environment = [];
  expect(() => approveReview(importSnapshot, noEvidence, importConfig, 'User')).toThrow();
  const invalidField = structuredClone(review); invalidField.records[0]!.fields.password = 'secret';
  expect(() => approveReview(importSnapshot, invalidField, importConfig, 'User')).toThrow();
  expect((await slackRead('documentation projects')).text).toContain('0 Projects');
});

it('blocks existing-record name collisions, allows explicitly reviewed references and preserves their history', async () => {
  await confirmSlack(await slackRead('documentation create project {"name":"Alpha","documentationLinks":["https://example.com/alpha"]}'));
  const review = resolvedImportReview(), approval = approveReview(importSnapshot, review, importConfig, 'Synthetic User');
  const collision = await new DocumentationImport(sql, importConfig).apply(importSnapshot, review, approval);
  expect(collision).toMatchObject({ authoritative: false, applied: 0 });
  expect(collision.problems.join('\n')).toContain('collision');
  const project = await slackRead('documentation project Alpha');
  review.records[0]!.existingId = identity(project);
  const resolvedApproval = approveReview(importSnapshot, review, importConfig, 'Synthetic User');
  const result = await new DocumentationImport(sql, importConfig).apply(importSnapshot, review, resolvedApproval);
  expect(result).toMatchObject({ authoritative: true, applied: 7, existing: 1, initialHistory: 7, relationships: 6 });
  expect((await slackRead('documentation history Alpha')).text).toContain('Slack structured creation');
});

it('does not evaluate arbitrary formulas and preserves literal escaped hyperlink labels', () => {
  const formulaSource = JSON.stringify({ version: 1, source: 'Formula fixture', sheets: [{ name: 'Projects', cells: [
    { address: 'A1', value: 'name' }, { address: 'A2', value: null, formula: '=WEBSERVICE("https://example.com")' },
    { address: 'A11', value: null, formula: '=HYPERLINK("https://example.com";"A ""quoted"" name")' },
  ] }] });
  const review = reviewSnapshot(formulaSource, importConfig);
  expect(review.records).toHaveLength(1);
  expect(review.records[0]!.fields.name).toBe('A "quoted" name');
  expect(review.cells.find(cell => cell.cell === 'Projects!A2')?.warning).toContain('Unevaluated formula');
});

it('refuses fresh mappings after partial progress and requires reconciliation before authority', async () => {
  const review = resolvedImportReview(), approval = approveReview(importSnapshot, review, importConfig, 'Synthetic User');
  let fail = true;
  const partialSql: Sql = { query: async (text, values) => {
    if (fail && text.startsWith('INSERT INTO documentation_records') && values?.[2] === 'technology') { fail = false; throw new Error('Synthetic interruption'); }
    return sql.query(text, values);
  } };
  expect(await new DocumentationImport(partialSql, importConfig).apply(importSnapshot, review, approval)).toMatchObject({ authoritative: false, applied: 1 });
  const changed = structuredClone(review); changed.cells[0]!.decision.reason = 'Fresh resolution';
  await expect(new DocumentationImport(sql, importConfig).apply(importSnapshot, changed, approveReview(importSnapshot, changed, importConfig, 'Synthetic User'))).rejects.toThrow(/different one-time batch/i);
  // A legitimate Slack edit during incomplete import must not be overwritten
  // by retry, or silently treated as a successful source reconciliation.
  await confirmSlack(await slackRead('documentation edit project Alpha {"notes":"Concurrent edit"}'));
  expect(await new DocumentationImport(sql, importConfig).apply(importSnapshot, review, approval)).toMatchObject({ authoritative: false, reconciled: false, status: 'incomplete', applied: 8 });
  expect((await slackRead('documentation project Alpha')).text).toContain('Concurrent edit');
});

it('requires complete expected existing fields and refuses missing/cross-workspace existing identities', async () => {
  await confirmSlack(await slackRead('documentation create project {"name":"Alpha","notes":"Existing value"}'));
  const existing = await slackRead('documentation project Alpha');
  const review = resolvedImportReview(); review.records[0]!.existingId = identity(existing);
  const report = await new DocumentationImport(sql, importConfig).apply(importSnapshot, review, approveReview(importSnapshot, review, importConfig, 'Synthetic User'));
  expect(report).toMatchObject({ authoritative: false, applied: 0 });
  expect(report.problems.join('\n')).toContain('no overwrite');
  expect((await slackRead('documentation project Alpha')).text).toContain('Existing value');
  review.records[0]!.existingId = randomUUID();
  const missing = await new DocumentationImport(sql, importConfig).apply(importSnapshot, review, approveReview(importSnapshot, review, importConfig, 'Synthetic User'));
  expect(missing).toMatchObject({ authoritative: false, applied: 0 });
  await confirmSlack(await slackRead('documentation create project {"name":"Other workspace Project"}', 'TOTHER'), 'TOTHER');
  const other = await slackRead('documentation project Other workspace Project', 'TOTHER');
  review.records[0]!.existingId = identity(other);
  const crossWorkspace = await new DocumentationImport(sql, importConfig).apply(importSnapshot, review, approveReview(importSnapshot, review, importConfig, 'Synthetic User'));
  expect(crossWorkspace).toMatchObject({ authoritative: false, applied: 0 });
});
