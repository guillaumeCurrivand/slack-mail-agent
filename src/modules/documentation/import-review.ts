import { createHash } from 'node:crypto';
import { z } from 'zod';
import { projectFields, recordSchemas, validSavedFields, type InventoryValues, type RecordKind } from './domain.js';

export type ImportConfig = { workspace: string; enabledModules: string[] };
const kind = z.enum(['project', 'technology', 'host', 'component', 'hosting', 'tool']);
const nonempty = z.string().trim().min(1);
const snapshotSchema = z.strictObject({ version: z.literal(1), source: nonempty, sheets: z.array(z.strictObject({
  name: nonempty.refine(value => !value.includes('!')), cells: z.array(z.strictObject({
    address: z.string().regex(/^[A-Z]+[1-9]\d*$/), value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]), formula: z.string().optional(),
  })),
})).min(1) });
const recordSchema = z.strictObject({ key: z.string().regex(/^[\w-]+$/), kind,
  existingId: z.uuid().optional(), fields: z.record(z.string(), z.unknown()),
  evidence: z.record(z.string(), z.array(z.strictObject({ cell: nonempty, reason: nonempty })).min(1)),
});
const reviewSchema = z.strictObject({ version: z.literal(1), workspace: nonempty, sourceDigest: nonempty, source: nonempty,
  cells: z.array(z.strictObject({ cell: nonempty, raw: snapshotSchema.shape.sheets.element.shape.cells.element,
    text: z.string(), link: z.string().nullable(), warning: z.string().nullable(),
    decision: z.strictObject({ disposition: z.enum(['unresolved', 'mapped', 'retained', 'ignored']), records: z.array(z.string()), reason: z.string() }),
  })), records: z.array(recordSchema), warnings: z.array(z.string()),
  resolutions: z.record(z.string(), nonempty),
});
export type ImportReview = z.infer<typeof reviewSchema>;
export type ImportRecord = ImportReview['records'][number];
export type ApprovedRecord = { key: string; kind: 'project' | RecordKind; id: string; existing: boolean; fields: InventoryValues };
export type ImportApproval = { version: 1; workspace: string; sourceDigest: string; reviewDigest: string; batch: string; confirmedBy: string };
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
function checkConfig(config: ImportConfig) {
  if (!/^T[A-Z0-9]+$/.test(config.workspace) || !config.enabledModules.includes('documentation')) throw new Error('Configured workspace and enabled Documentation are required');
}
function cellValue(cell: z.infer<typeof snapshotSchema>['sheets'][number]['cells'][number]) {
  if (!cell.formula) return { text: cell.value == null ? '' : String(cell.value), link: null, warning: null };
  // Only literal HYPERLINK arguments are decoded. No expression evaluation or IO.
  const match = /^=?HYPERLINK\(\s*"((?:[^"]|"")*)"\s*[,;]\s*"((?:[^"]|"")*)"\s*\)$/i.exec(cell.formula);
  if (!match) return { text: cell.value == null ? '' : String(cell.value), link: null, warning: 'Unevaluated formula; confirm its displayed value or explicitly retain/exclude it' };
  const link = match[1]!.replaceAll('""', '"'), text = match[2]!.replaceAll('""', '"');
  return { text, link, warning: null };
}
export function reviewSnapshot(snapshot: string, config: ImportConfig): ImportReview {
  checkConfig(config);
  const workbook = snapshotSchema.parse(JSON.parse(snapshot));
  if (new Set(workbook.sheets.map(sheet => sheet.name)).size !== workbook.sheets.length) throw new Error('Duplicate sheet names');
  const cells: ImportReview['cells'] = [];
  for (const sheet of workbook.sheets) {
    if (new Set(sheet.cells.map(cell => cell.address)).size !== sheet.cells.length) throw new Error('Duplicate cell addresses');
    for (const raw of sheet.cells) {
      if (raw.value == null && !raw.formula) continue;
      if (raw.value === '' && !raw.formula) continue;
      cells.push({ cell: `${sheet.name}!${raw.address}`, raw, ...cellValue(raw), decision: { disposition: 'unresolved', records: [], reason: '' } });
    }
  }
  const records: ImportRecord[] = [];
  const sheets: Record<string, ImportRecord['kind']> = { projects: 'project', technologies: 'technology', hosts: 'host', tools: 'tool' };
  for (const sheet of workbook.sheets) {
    const recordKind = sheets[sheet.name.toLowerCase()];
    if (!recordKind) continue;
    const local = cells.filter(cell => cell.cell.startsWith(`${sheet.name}!`));
    const header = local.find(cell => /^[A-Z]+1$/.test(cell.raw.address) && cell.text.toLowerCase() === 'name');
    if (!header) continue;
    const column = header.raw.address.replace(/\d+$/, '');
    for (const cell of local.filter(cell => cell.raw.address.replace(/\d+$/, '') === column && cell.raw.address !== `${column}1` && !cell.warning)) {
      if (!cell.text.trim()) continue;
      const key = `${recordKind}-${records.length + 1}`;
      const fields: Record<string, unknown> = { name: cell.text };
      const evidence: ImportRecord['evidence'] = { name: [{ cell: cell.cell, reason: 'Name column in the explicitly named sheet' }] };
      if (recordKind === 'project' && cell.link) {
        fields.documentationLinks = [cell.link]; evidence.documentationLinks = [{ cell: cell.cell, reason: 'Literal hyperlink destination; destination has not been visited' }];
      }
      records.push({ key, kind: recordKind, fields, evidence });
    }
  }
  const warnings = cells.filter(cell => cell.warning).map(cell => `${cell.cell}: ${cell.warning}`);
  for (const record of records) {
    if (records.filter(other => other.kind === record.kind && String(other.fields.name).toLowerCase() === String(record.fields.name).toLowerCase()).length > 1) {
      const warning = `Same-named ${record.kind}: ${record.fields.name}; resolve distinct identities explicitly`;
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }
  return { version: 1, workspace: config.workspace, sourceDigest: digest(snapshot), source: workbook.source, cells, records, warnings, resolutions: {} };
}
function stableId(value: string) {
  const hex = digest(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function validateReview(snapshot: string, input: unknown, config: ImportConfig): { review: ImportReview; records: ApprovedRecord[]; reviewDigest: string; batch: string } {
  const review = reviewSchema.parse(input), original = reviewSnapshot(snapshot, config);
  if (review.workspace !== config.workspace || review.sourceDigest !== original.sourceDigest || review.source !== original.source) throw new Error('Snapshot/workspace changed; fresh review required');
  if (canonical(review.cells.map(({ decision, ...cell }) => cell)) !== canonical(original.cells.map(({ decision, ...cell }) => cell)) || canonical(review.warnings) !== canonical(original.warnings)) throw new Error('Source evidence changed; fresh review required');
  if (!review.records.length || new Set(review.records.map(record => record.key)).size !== review.records.length) throw new Error('Unique reviewed record keys required');
  const byKey = new Map(review.records.map(record => [record.key, record]));
  for (const record of review.records) {
    if (record.fields.name == null) continue;
    if (review.records.filter(other => other.kind === record.kind && String(other.fields.name).toLowerCase() === String(record.fields.name).toLowerCase()).length > 1) {
      const warning = `Same-named ${record.kind}: ${record.fields.name}; resolve distinct identities explicitly`;
      if (!review.resolutions[warning]?.trim()) throw new Error(`Unresolved review warning: ${warning}`);
    }
  }
  for (const cell of review.cells) {
    if (cell.decision.disposition === 'unresolved' || !cell.decision.reason.trim()) throw new Error(`Unresolved source cell: ${cell.cell}`);
    if (cell.decision.records.some(key => !byKey.has(key)) || (cell.decision.disposition === 'mapped' && !cell.decision.records.length)) throw new Error(`Invalid cell mapping: ${cell.cell}`);
  }
  for (const warning of review.warnings) if (!review.resolutions[warning]?.trim()) throw new Error(`Unresolved review warning: ${warning}`);
  const ids = new Map(review.records.map(record => [record.key, record.existingId ?? stableId(`${config.workspace}:${review.sourceDigest}:${record.kind}:${record.key}`)]));
  if (new Set(ids.values()).size !== ids.size) throw new Error('One record per identity; explicitly consolidate source evidence');
  const reference = (value: unknown, expectedKind: ImportRecord['kind']): string => {
    if (typeof value !== 'string' || !value.startsWith('@')) throw new Error('Relationships require reviewed @record-key references');
    const target = byKey.get(value.slice(1));
    if (!target || target.kind !== expectedKind) throw new Error('Invalid reviewed reference kind or identity');
    return ids.get(target.key)!;
  };
  const records = review.records.map(record => {
    for (const [field, value] of Object.entries(record.fields)) {
      if (value == null) continue;
      const evidence = record.evidence[field];
      if (!evidence?.length || evidence.some(entry => !review.cells.some(cell => cell.cell === entry.cell && cell.decision.records.includes(record.key)))) throw new Error(`Missing source evidence for ${record.key}.${field}`);
    }
    const fields = { ...record.fields };
    if (record.kind === 'component') {
      fields.projectId = reference(fields.projectId, 'project');
      if (Array.isArray(fields.technologies)) fields.technologies = fields.technologies.map(value => reference(value, 'technology'));
    }
    if (record.kind === 'hosting') { fields.componentId = reference(fields.componentId, 'component'); fields.serviceId = reference(fields.serviceId, 'host'); }
    if (record.kind === 'tool' && Array.isArray(fields.projects)) fields.projects = fields.projects.map(value => reference(value, 'project'));
    const parsed = record.kind === 'project' ? projectFields.parse(fields) : recordSchemas[record.kind].create.parse(fields);
    if (record.kind !== 'project' && !validSavedFields(record.kind, 'create', parsed)) throw new Error('Invalid saved reference identifiers');
    return { key: record.key, kind: record.kind, id: ids.get(record.key)!, existing: !!record.existingId, fields: parsed as InventoryValues };
  });
  const reviewDigest = digest(canonical(review));
  return { review, records, reviewDigest, batch: digest(`${config.workspace}:${original.sourceDigest}:${reviewDigest}`) };
}
export function approveReview(snapshot: string, review: unknown, config: ImportConfig, confirmedBy: string): ImportApproval {
  if (!confirmedBy.trim()) throw new Error('User resolution/approval attribution is required');
  const checked = validateReview(snapshot, review, config);
  return { version: 1, workspace: config.workspace, sourceDigest: checked.review.sourceDigest, reviewDigest: checked.reviewDigest, batch: checked.batch, confirmedBy: confirmedBy.trim() };
}
export function checkApproval(snapshot: string, review: unknown, approval: ImportApproval, config: ImportConfig) {
  const expected = approveReview(snapshot, review, config, approval.confirmedBy ?? '');
  if (canonical(approval) !== canonical(expected)) throw new Error('Approval differs from the exact reviewed batch; fresh review required');
  return validateReview(snapshot, review, config);
}
