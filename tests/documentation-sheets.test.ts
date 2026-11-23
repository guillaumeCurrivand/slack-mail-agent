import { describe, expect, it, vi } from 'vitest';
import { parseSheet, tabs, type Cell } from '../src/modules/documentation/sheets.js';
import { LiveWorkbook, sheetDefinition, validateSheet, type SheetMutation } from '../src/modules/documentation/workbook.js';
import type { FormDefinition, SavedForm } from '../src/core/forms.js';

function edit(original: Cell, changes: Record<string, string>) {
  const definition = sheetDefinition({ book: 'example', tab: 'projects', sheetId: 0, key: 'row', col: 5, name: 'Example', original });
  const values = Object.fromEntries(definition.fields.map(field => [field.key, field.initial ?? '']));
  return validateSheet({ id: 'draft', state: 'submitted', timestamp: '1', channel: 'D1', definition, result: null }, { ...values, ...changes });
}
const actor = { team: 'TTEAM', user: 'USER', channel: 'DUSER' };
function liveTab(headings: string[], values: string[]) {
  const state = { headings, values };
  const provider = {
    team: actor.team, identity: 'synthetic',
    async read() {
      return parseSheet('projects', { properties: { sheetId: 17, title: 'projet' }, data: [{ rowData: [
        { values: state.headings.map(formattedValue => ({ formattedValue })) },
        { values: state.values.map(text => ({ userEnteredValue: { stringValue: text }, formattedValue: text })) },
      ] }] });
    },
    write: vi.fn(), remove: vi.fn(), append: vi.fn(),
  };
  const live = new LiveWorkbook(provider, { query: async () => ({ rows: [{ acquired: true }], rowCount: 1 }) });
  return { state, provider, live };
}
function submitted(definition: FormDefinition, workbook: SheetMutation): SavedForm<{ workbook: SheetMutation }> {
  return { id: 'synthetic', channel: actor.channel, timestamp: '1', state: 'submitted', definition, result: { workbook } };
}
it('edits an added column beyond Z by its physical index and discovers renamed and reordered columns on refresh', async () => {
  const headers = ['Section', 'Projet', ...Array.from({ length: 25 }, (_, i) => 'Field ' + i), 'Responsable'];
  const { state, provider, live } = liveTab(headers, ['Work', 'Alpha']);
  const page = await live.page(actor, 'sheet_projects_0');
  const detail = await live.page(actor, page!.recordChoices![0]!.page);
  const control = detail!.table!.rowButtons!.flat().find(b => b?.label === 'Modifier · Responsable')!;
  const definition = (await live.definition(actor, control.value))!;
  const change = validateSheet(submitted(definition, { operation: 'delete' }), { v0: 'Eve', u0: '' });
  if (!('data' in change)) throw new Error('Expected valid proposal');
  const form = submitted(definition, change.data.workbook);
  expect(live.preview(form).table!.rows[0]!.slice(0, 3)).toEqual(['projet', 'Alpha', 'Responsable']);
  expect(await live.apply(actor, form)).toContain('enregistrée');
  expect(provider.write).toHaveBeenCalledWith(17, 1, 27, { userEnteredValue: { stringValue: 'Eve' } }, expect.any(String));
  state.headings = ['Responsable technique', 'Section', 'Projet'];
  state.values = ['Eve', 'Work', 'Alpha'];
  const refreshed = await live.command(actor, 'project Alpha');
  expect(refreshed).toMatchObject({ table: { rows: expect.arrayContaining([['Responsable technique', [{ text: 'Eve' }]]]) } });
  expect(await live.apply(actor, form)).toContain('colonnes ont changé');
  expect(provider.write).toHaveBeenCalledTimes(1);
});
it('creates using the reviewed columns, leaves unnamed cells alone, and detects schema changes even for old drafts', async () => {
  const { state, provider, live } = liveTab(['Équipe', '', 'Projet', 'Lien', 'Lien'], ['First', 'internal', 'Alpha']);
  const create = (await live.definition(actor, 'sheet_projects_create'))!;
  expect(create.fields.filter(f => f.required).map(f => f.key)).toEqual(['v2']);
  expect(create.fields.filter(f => f.key.startsWith('v')).map(f => f.label)).toEqual(['Équipe', 'Projet', 'Lien (col. 4)', 'Lien (col. 5)']);
  const change = validateSheet(submitted(create, { operation: 'delete' }), { v2: 'Beta', v4: 'Docs', u4: 'https://example.test' });
  if (!('data' in change)) throw new Error('Expected valid creation');
  const form = submitted(create, change.data.workbook);
  expect(await live.apply(actor, form)).toContain('ajoutée');
  expect(provider.append.mock.calls[0]![1]).toEqual([{}, {}, { userEnteredValue: { stringValue: 'Beta' } }, {}, expect.objectContaining({ textFormatRuns: expect.any(Array) })]);
  const row = (await provider.read()).rows[0]!;
  const remove = submitted((await live.definition(actor, 'sheet_projects_' + row.key + '_delete'))!, { operation: 'delete' });
  expect(await live.apply(actor, remove)).toContain('hors des colonnes');
  state.headings.splice(0, 0, 'Date');
  expect(await live.apply(actor, remove)).toContain('colonnes ont changé');
  expect(provider.remove).not.toHaveBeenCalled();
  expect(await live.apply(actor, form)).toContain('colonnes ont changé');
  delete create.context.headers;
  expect(await live.apply(actor, form)).toContain('colonnes ont changé');
  expect(provider.append).toHaveBeenCalledTimes(1);
});
it('fits wide tabs in the creation modal and supports a renamed single-column tab', async () => {
  const { state, live } = liveTab(Array.from({ length: 55 }, (_, i) => i === 54 ? 'Projet' : 'Field ' + i), ['Example']);
  expect((await live.definition(actor, 'sheet_projects_create'))!.fields.map(f => f.key)).toEqual(['v54', 'u54']);
  state.headings = ['Nom personnalisé'];
  const page = await live.page(actor, 'sheet_projects_0');
  expect(page!.table!.columns).toEqual(['Ligne', 'Nom personnalisé']);
  expect(page!.recordChoices![0]!.label).toBe('Example');
});

describe('Documentation workbook values', () => {
  it('preserves the formula, quoted labels and its separator when editing a hyperlink', () => {
    const formulaValue = '=HYPERLINK("https://example.test/old";"Before")';
    expect(edit({ formattedValue: 'Before', userEnteredValue: { formulaValue } }, { v0: 'New "name"', u0: 'https://example.test/new' })).toMatchObject({
      data: { workbook: { cell: { userEnteredValue: { formulaValue: '=HYPERLINK("https://example.test/new";"New ""name""")' } }, fields: 'userEnteredValue' } },
    });
  });
  it('retains rich-text destinations and styling and adjusts offsets for multiline and Unicode edits', () => {
    const original = { userEnteredValue: { stringValue: 'Old link' }, textFormatRuns: [
      { startIndex: 0, format: { bold: true } }, { startIndex: 4, format: { link: { uri: 'https://example.test' } } },
    ] };
    expect(edit(original, { v0: 'New 👋\n' })).toMatchObject({ data: { workbook: { cell: {
      userEnteredValue: { stringValue: 'New 👋\nlink' },
      textFormatRuns: [{ startIndex: 0, format: { bold: true } }, { startIndex: 7, format: { link: { uri: 'https://example.test' } } }],
    } } } });
    expect(edit(original, { u1: 'javascript:alert(1)' })).toHaveProperty('errors.u1');
  });
  it('clears a field, accepts a literal equals sign and preserves numerical types', () => {
    expect(edit({ userEnteredValue: { stringValue: 'x' } }, { v0: '' })).toMatchObject({ data: { workbook: { cell: {} } } });
    expect(edit({}, { v0: '=1+1' })).toMatchObject({ data: { workbook: { cell: { userEnteredValue: { stringValue: '=1+1' } } } } });
    expect(edit({ userEnteredValue: { numberValue: 12 } }, { v0: '13,5' })).toMatchObject({ data: { workbook: { cell: { userEnteredValue: { numberValue: 13.5 } } } } });
  });
  it.each(Object.keys(tabs) as (keyof typeof tabs)[])('preserves the headers and physical position of nonempty %s rows', tab => {
    const headers = [tabs[tab].name, 'Responsable'];
    const source = { properties: { sheetId: 0, title: tabs[tab].title }, data: [{ rowData: [
      { values: headers.map(formattedValue => ({ formattedValue })) }, {}, { values: [{ userEnteredValue: { stringValue: 'Synthetic' } }] },
    ] }] };
    expect(parseSheet(tab, source)).toMatchObject({ headers, rows: [{ index: 2 }] });
    source.data[0]!.rowData[0]!.values = [];
    expect(() => parseSheet(tab, source)).toThrow('colonnes');
  });
});
