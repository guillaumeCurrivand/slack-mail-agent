import { describe, expect, it } from 'vitest';
import { parseSheet, tabs, type Cell } from '../src/modules/documentation/sheets.js';
import { sheetDefinition, validateSheet } from '../src/modules/documentation/workbook.js';

function edit(original: Cell, changes: Record<string, string>) {
  const definition = sheetDefinition({ book: 'example', tab: 'projects', sheetId: 0, key: 'row', col: 5, name: 'Example', original });
  const values = Object.fromEntries(definition.fields.map(field => [field.key, field.initial ?? '']));
  return validateSheet({ id: 'draft', state: 'submitted', timestamp: '1', channel: 'D1', definition, result: null }, { ...values, ...changes });
}
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
    const source = { properties: { sheetId: 0, title: tabs[tab].title }, data: [{ rowData: [
      { values: tabs[tab].headers.map(formattedValue => ({ formattedValue })) }, {}, { values: [{ userEnteredValue: { stringValue: 'Synthetic' } }] },
    ] }] };
    expect(parseSheet(tab, source)).toMatchObject({ headers: tabs[tab].headers, rows: [{ index: 2 }] });
    source.data[0]!.rowData[0]!.values = [];
    expect(() => parseSheet(tab, source)).toThrow('colonnes');
  });
});
