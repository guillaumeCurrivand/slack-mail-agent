import { z } from 'zod';

const name = z.string().trim().min(1).max(120).refine(value => !/[\r\n]/.test(value));
const link = z.string().max(400).refine(value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !/[\s<>]/.test(value); }
  catch { return false; }
});
const fieldDefinitions = {
  name,
  aliases: z.array(name).max(20).nullable(),
  description: z.string().max(1500).nullable(),
  repositories: z.array(link).max(10).nullable(),
  documentationLinks: z.array(link).max(10).nullable(),
  notes: z.string().max(1500).nullable(),
};
export const projectFields = z.strictObject({
  ...fieldDefinitions,
  aliases: fieldDefinitions.aliases.default(null),
  description: fieldDefinitions.description.default(null),
  repositories: fieldDefinitions.repositories.default(null),
  documentationLinks: fieldDefinitions.documentationLinks.default(null),
  notes: fieldDefinitions.notes.default(null),
}).refine(value => JSON.stringify(value).length <= 5000);
export const projectEdit = z.strictObject(fieldDefinitions).partial()
  .refine(value => Object.keys(value).length > 0 && JSON.stringify(value).length <= 5000);
export type ProjectFields = z.infer<typeof projectFields>;
export type ProjectEdit = z.infer<typeof projectEdit>;
export type Project = { id: string; fields: ProjectFields; created_at: Date | string };

const technologyDefinitions = { name, category: z.string().max(120).nullable(), notes: fieldDefinitions.notes };
export const technologyFields = z.strictObject({ ...technologyDefinitions, category: technologyDefinitions.category.default(null), notes: technologyDefinitions.notes.default(null) });
export const technologyEdit = z.strictObject(technologyDefinitions).partial().refine(value => Object.keys(value).length > 0);
export type RecordKind = 'technology' | 'component' | 'host' | 'hosting';
const componentDefinitions = { name, type: z.string().max(120).nullable(), technologies: z.array(name).max(20).nullable() };
export const componentFields = z.strictObject({ ...componentDefinitions, projectId: z.uuid(), type: componentDefinitions.type.default(null), technologies: componentDefinitions.technologies.default(null) });
export const componentEdit = z.strictObject(componentDefinitions).partial().refine(value => Object.keys(value).length > 0);
const hostDefinitions = { name, role: z.string().max(120).nullable(), monthlyCost: z.number().finite().min(0).max(1e12).nullable(), currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullable(), notes: fieldDefinitions.notes };
const costCurrency = (value: { monthlyCost?: number | null; currency?: string | null }) => value.monthlyCost == null || value.currency != null;
export const hostFields = z.strictObject({ ...hostDefinitions, role: hostDefinitions.role.default(null), monthlyCost: hostDefinitions.monthlyCost.default(null), currency: hostDefinitions.currency.default(null), notes: hostDefinitions.notes.default(null) }).refine(costCurrency);
// Partial replacements are validated together with current values at commit.
export const hostEdit = z.strictObject(hostDefinitions).partial().refine(value => Object.keys(value).length > 0);
const hostingDefinitions = { environment: z.string().trim().max(120).refine(value => !/[\r\n]/.test(value)).nullable(), serviceId: name, accountReference: z.string().max(1500).nullable(), urls: z.array(link).max(10).nullable(), accessInstructions: z.string().max(1500).nullable(), notes: fieldDefinitions.notes };
export const hostingFields = z.strictObject({ ...hostingDefinitions, componentId: z.uuid(), environment: hostingDefinitions.environment.default(null), accountReference: hostingDefinitions.accountReference.default(null), urls: hostingDefinitions.urls.default(null), accessInstructions: hostingDefinitions.accessInstructions.default(null), notes: hostingDefinitions.notes.default(null) }).refine(value => JSON.stringify(value).length <= 5000);
export const hostingEdit = z.strictObject(hostingDefinitions).partial().refine(value => Object.keys(value).length > 0 && JSON.stringify(value).length <= 5000);
export const recordSchemas = {
  technology: { create: technologyFields, edit: technologyEdit },
  component: { create: componentFields, edit: componentEdit },
  host: { create: hostFields, edit: hostEdit },
  hosting: { create: hostingFields, edit: hostingEdit },
};
export const recordTitle = (kind: RecordKind | 'project') => ({ project: 'Project', technology: 'Technology', component: 'Component', host: 'Host/service', hosting: 'Hosting entry' })[kind];
export const recordName = (record: InventoryRecord) => String(record.fields.name ?? (record.fields.environment === '' ? 'Empty environment' : record.fields.environment) ?? 'Unknown environment');
export type InventoryValues = Record<string, string | string[] | number | null>;
export type InventoryRecord = { id: string; kind: RecordKind; fields: InventoryValues; created_at: Date | string };
export function parseEditRequest(body: string): { selector: string; value: unknown } {
  // Selectors and replacement strings can both contain braces. Find a complete
  // trailing JSON value before validating fields rather than guessing a delimiter.
  for (const boundary of [...body.matchAll(/\s+(?=\{)/g)].reverse()) {
    try { return { selector: body.slice(0, boundary.index).trim(), value: JSON.parse(body.slice(boundary.index + boundary[0].length)) }; }
    catch { continue; }
  }
  throw new Error('Expected one target and a replacement object');
}
export function validSavedFields(kind: RecordKind, operation: 'create' | 'edit', fields: unknown): boolean {
  const schema = recordSchemas[kind][operation];
  const parsed = schema.safeParse(fields);
  if (!parsed.success) return false;
  if ('technologies' in parsed.data && Array.isArray(parsed.data.technologies)) {
    return parsed.data.technologies.every(id => z.uuid().safeParse(id).success)
      && new Set(parsed.data.technologies).size === parsed.data.technologies.length;
  }
  return !('serviceId' in parsed.data) || z.uuid().safeParse(parsed.data.serviceId).success;
}
