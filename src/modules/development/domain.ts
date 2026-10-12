import { z } from 'zod';

export const branchNameSchema = z.string().max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*$/);

export const projectSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().trim().min(1).max(100),
  channel: z.string().regex(/^[CG][A-Z0-9]+$/),
  folder: z.string().regex(/^\d+$/),
  repository: z.url().refine(value => {
    const url = URL.parse(value);
    return url !== null && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !/[\s<>]/.test(value);
  }, 'Use a credential-free HTTPS repository URL.'),
  skill: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
}).strict();
export type Project = z.infer<typeof projectSchema>;
export function repositoryKey(repository: string) {
  const url = new URL(repository);
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  return `${url.origin}${url.hostname === 'github.com' ? pathname.toLowerCase() : pathname}`;
}
export type Ticket = { id: string; name: string; description: string; url: string; status: string; comments: string[]; attachments: string[] };
export const resultSchema = z.object({
  outcome: z.enum(['actionable', 'needs_information', 'pushed', 'blocked']),
  summary: z.string().min(1).max(8000),
  tests: z.array(z.string().max(2000)).max(30).default([]),
  branch: branchNameSchema.optional(),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
}).strict();
export type Result = z.infer<typeof resultSchema>;
export type Run = { id: string; project: string; config: Project; kind: 'review' | 'build'; state: string; attempts: number; ticket: Ticket; result: Result | null; thread: string | null; created_at: Date; updated_at: Date };
export const canRetry = (run: Pick<Run, 'kind' | 'state' | 'result'>) =>
  (run.state === 'blocked' && !run.result?.commit) ||
  (run.kind === 'build' && run.state === 'reporting_error' && run.result?.outcome === 'pushed' && !!run.result.commit);
export const commitLink = (repository: string, commit: string) => `${repository.replace(/\.git\/?$/, '').replace(/\/$/, '')}/${new URL(repository).hostname === 'github.com' ? 'commit' : '-/commit'}/${commit}`;
export type Work = { id: string; project: Project; kind: 'review' | 'build'; ticket: Ticket; attempts: number; thread: string | null; lease: string };
export const ready = (status: string) => status.trim().toLowerCase() === 'ready for ai';
export function ticketIds(text: string) {
  return [...new Set([...text.matchAll(/https:\/\/app\.clickup\.com\/t\/([a-zA-Z0-9]+)(?=[\s>|?#]|$)/g)].map(match => match[1]!))];
}
