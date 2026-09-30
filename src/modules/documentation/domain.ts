import { z } from 'zod';

const name = z.string().trim().min(1).max(120).refine(value => !/[\r\n]/.test(value));
const link = z.string().max(400).refine(value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !/[\s<>]/.test(value); }
  catch { return false; }
});
export const projectFields = z.strictObject({
  name,
  aliases: z.array(name).max(20).nullable().default(null),
  description: z.string().max(1500).nullable().default(null),
  repositories: z.array(link).max(10).nullable().default(null),
  documentationLinks: z.array(link).max(10).nullable().default(null),
  notes: z.string().max(1500).nullable().default(null),
}).refine(value => JSON.stringify(value).length <= 5000);
export type ProjectFields = z.infer<typeof projectFields>;
export type Project = { id: string; fields: ProjectFields; created_at: Date | string };
