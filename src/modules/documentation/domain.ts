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
export type RecordKind = 'technology' | 'component';
const componentDefinitions = { name, type: z.string().max(120).nullable(), technologies: z.array(name).max(20).nullable() };
export const componentFields = z.strictObject({ ...componentDefinitions, projectId: z.uuid(), type: componentDefinitions.type.default(null), technologies: componentDefinitions.technologies.default(null) });
export const componentEdit = z.strictObject(componentDefinitions).partial().refine(value => Object.keys(value).length > 0);
export type InventoryValues = Record<string, string | string[] | null>;
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
  const schema = kind === 'technology' ? (operation === 'create' ? technologyFields : technologyEdit)
    : operation === 'create' ? componentFields : componentEdit;
  const parsed = schema.safeParse(fields);
  if (!parsed.success) return false;
  if ('technologies' in parsed.data && Array.isArray(parsed.data.technologies)) {
    return parsed.data.technologies.every(id => z.uuid().safeParse(id).success)
      && new Set(parsed.data.technologies).size === parsed.data.technologies.length;
  }
  return true;
}
