import { z } from 'zod';
import { ClickupAPI, ClickupError } from './api.js';
import type { DiscoveryStep, StatusCatalogue } from './domain.js';

const id = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String);
const location = z.object({ id });
const statuses = z.array(z.object({ status: z.string().min(1), type: z.enum(['open', 'custom', 'done', 'closed']) })).min(1);
const stepKey = (step: DiscoveryStep) => `${step.kind}:${step.id}:${step.archived ?? ''}`;

/** Persisted pending reads let Retry finish large catalogues after a rate-limit reset. */
export async function discoverStatuses(api: ClickupAPI, workspaceId: string, previous?: StatusCatalogue): Promise<StatusCatalogue> {
  const catalogue: StatusCatalogue = previous ? structuredClone(previous) : {
    choices: [], seen: [], complete: false,
    pending: [{ kind: 'spaces', id: workspaceId, archived: false }, { kind: 'spaces', id: workspaceId, archived: true }, { kind: 'shared', id: workspaceId }],
  };
  const seen = new Set(catalogue.seen), failed: DiscoveryStep[] = [];
  const queued = new Set(catalogue.pending.map(stepKey));
  const enqueue = (step: DiscoveryStep) => { const key = stepKey(step); if (!seen.has(key) && !queued.has(key)) { queued.add(key); catalogue.pending.push(step); } };
  const addStatuses = (value: unknown) => {
    for (const status of statuses.parse(value)) {
      const unfinished = status.type === 'open' || status.type === 'custom';
      const choice = catalogue.choices.find(choice => choice.name === status.status);
      if (choice) choice.unfinished ||= unfinished;
      else catalogue.choices.push({ name: status.status, unfinished });
    }
  };
  const both = (kind: 'folders' | 'folderless' | 'lists', source: string) => {
    enqueue({ kind, id: source, archived: false }); enqueue({ kind, id: source, archived: true });
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const options = { waitForRateLimit: false, signal: controller.signal };
  const get = (path: string) => api.get(path, options);
  const read = async (step: DiscoveryStep) => {
    if (step.kind === 'spaces') {
      const response = z.object({ spaces: z.array(location.extend({ statuses })) }).parse(await get(`team/${workspaceId}/space?archived=${step.archived}`));
      for (const space of response.spaces) { addStatuses(space.statuses); both('folders', space.id); both('folderless', space.id); }
    } else if (step.kind === 'shared') {
      const response = z.object({ shared: z.object({ folders: z.array(location), lists: z.array(location), tasks: z.array(z.object({ id: z.string().regex(/^[\w-]{1,128}$/) })) }) }).parse(await get(`team/${workspaceId}/shared`));
      for (const folder of response.shared.folders) enqueue({ kind: 'folder', id: folder.id });
      for (const list of response.shared.lists) enqueue({ kind: 'list', id: list.id });
      for (const task of response.shared.tasks) enqueue({ kind: 'task', id: task.id });
    } else if (step.kind === 'folders') {
      const response = z.object({ folders: z.array(location) }).parse(await get(`space/${step.id}/folder?archived=${step.archived}`));
      for (const folder of response.folders) enqueue({ kind: 'folder', id: folder.id });
    } else if (step.kind === 'folderless' || step.kind === 'lists') {
      const path = step.kind === 'folderless' ? `space/${step.id}/list` : `folder/${step.id}/list`;
      const response = z.object({ lists: z.array(location) }).parse(await get(`${path}?archived=${step.archived}`));
      for (const list of response.lists) enqueue({ kind: 'list', id: list.id });
    } else if (step.kind === 'folder') {
      const folder = location.extend({ statuses, folders: z.array(location).optional() }).parse(await get(`folder/${step.id}?include_subfolders=true`));
      if (folder.id !== step.id) throw new Error('Folder identity changed');
      addStatuses(folder.statuses); both('lists', folder.id);
      for (const child of folder.folders ?? []) enqueue({ kind: 'folder', id: child.id });
    } else if (step.kind === 'list') {
      const list = location.extend({ statuses }).parse(await get(`list/${step.id}`));
      if (list.id !== step.id) throw new Error('List identity changed');
      addStatuses(list.statuses);
    } else {
      const task = z.object({ list: location }).parse(await api.task(step.id, options));
      enqueue({ kind: 'list', id: task.list.id });
    }
  };
  try {
    while (catalogue.pending.length && !controller.signal.aborted) {
      const batch = catalogue.pending.splice(0, 4).filter(step => !seen.has(stepKey(step)));
      const outcomes = await Promise.allSettled(batch.map(read));
      let stopped = false;
      for (const [index, outcome] of outcomes.entries()) {
        const step = batch[index]!;
        if (outcome.status === 'fulfilled') seen.add(stepKey(step));
        else {
          failed.push(step);
          if (outcome.reason instanceof ClickupError && [401, 403, 429].includes(outcome.reason.status)) stopped = true;
        }
      }
      // Settle in-flight reads before returning; preserve all successful and pending work.
      if (stopped) break;
    }
  } finally { clearTimeout(timeout); }
  catalogue.pending.push(...failed);
  catalogue.seen = [...seen];
  catalogue.choices.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  catalogue.complete = !catalogue.pending.length;
  if (catalogue.complete) catalogue.checkedAt = new Date().toISOString();
  else delete catalogue.checkedAt;
  return catalogue;
}
