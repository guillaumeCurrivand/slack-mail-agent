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
