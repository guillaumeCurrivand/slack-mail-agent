import { z } from 'zod';

export const branchNameSchema = z.string().max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*$/);

export const projectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const repositorySchema = z.url().max(2000).refine(value => {
  const url = URL.parse(value);
  return url !== null && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !/[\s<>]/.test(value);
}, 'Use a credential-free HTTPS repository URL.');
const configurationSchema = z.object({
  id: projectIdSchema,
  name: z.string().trim().min(1).max(100),
  channel: z.string().regex(/^[CG][A-Z0-9]+$/),
  folder: z.string().regex(/^\d+$/),
  repository: repositorySchema,
  folders: z.array(z.string().regex(/^\d+$/)).min(1).max(100).optional(),
  repositories: z.array(repositorySchema).min(1).max(20).optional(),
  skill: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
}).strict().refine(p => !p.folders || new Set(p.folders).size === p.folders.length, { path: ['folders'], message: 'Duplicate folder.' })
  .refine(p => !p.repositories || new Set(p.repositories.map(url => URL.canParse(url) ? repositoryKey(url) : url)).size === p.repositories.length, { path: ['repositories'], message: 'Duplicate repository.' })
  .refine(p => !p.repositories || p.repositories.join('\n').length <= 3000, { path: ['repositories'], message: 'Repository URLs exceed 3000 characters.' });
// Keep old saved configurations and execution snapshots readable. Collections are
// authoritative when supplied; the scalar fields retain compatibility with old workers.
export const projectSchema = z.preprocess(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const p = value as Record<string, unknown>;
  return { ...p, ...(Array.isArray(p.folders) ? { folder: p.folders[0] } : {}), ...(Array.isArray(p.repositories) ? { repository: p.repositories[0] } : {}) };
}, configurationSchema);
export type Project = z.infer<typeof configurationSchema>;
export const projectFolders = (p: Project) => p.folders ?? [p.folder];
export const projectRepositories = (p: Project) => p.repositories ?? [p.repository];
export const repositoryName = (url: string) => new URL(url).pathname.replace(/\/$/, '').split('/').at(-1)!.replace(/\.git$/, '');
/** Frozen execution destinations, one repository in one authorized folder. */
export function projectTargets(p: Project, folder?: string): Project[] {
  const { folders, repositories, ...base } = p;
  return (folder ? projectFolders(p).filter(id => id === folder) : projectFolders(p)).flatMap(id => projectRepositories(p).map((repository, index) => ({
    ...base, folder: id, repository,
    name: projectRepositories(p).length > 1 ? `${index + 1}. ${repositoryName(repository).slice(0, 40)} — ${p.name}` : p.name,
  })));
}
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
