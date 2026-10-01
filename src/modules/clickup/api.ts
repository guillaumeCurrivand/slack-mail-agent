import { z } from 'zod';
import type { Identity, Task } from './domain.js';

export class ClickupError extends Error {
  constructor(readonly status: number, readonly retryAt = 0) { super('ClickUp request failed'); }
}
const id = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String);
const taskId = z.string().regex(/^[\w-]{1,128}$/);
const rawTask = z.object({
  id: taskId, name: z.string(), status: z.object({ status: z.string(), type: z.string() }), archived: z.boolean(),
  assignees: z.array(z.object({ id })), due_date: z.union([z.number().finite(), z.string().regex(/^\d+$/)]).nullish(),
  priority: z.object({ priority: z.string() }).nullish(), list: z.object({ name: z.string() }), url: z.string(),
});
const taskLink = (value: string) => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'app.clickup.com' && !url.username && !url.password && /^\/t\/[\w-]+$/.test(url.pathname) && !url.search && !url.hash; }
  catch { return false; }
};
export class ClickupAPI {
  constructor(private token: string, private fetcher: typeof fetch = fetch, private limit?: { retryAt(): Promise<number>; blockUntil(until: number): Promise<void> }) {}
  async get(path: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const retryAt = await this.limit?.retryAt() ?? 0;
      if (retryAt > Date.now()) throw new ClickupError(429, retryAt);
      let response;
      try { response = await this.fetcher(`https://api.clickup.com/api/v2/${path}`, { headers: { Authorization: this.token }, signal: AbortSignal.timeout(30_000) }); }
      catch (error) {
        if (attempt >= 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt)); continue;
      }
      if (response.ok) return response.json();
      const reset = Number(response.headers.get('X-RateLimit-Reset') ?? 0) * 1000;
      const retryAfter = Number(response.headers.get('Retry-After') ?? 0) * 1000;
      const delay = response.status === 429 ? Math.max(reset - Date.now(), retryAfter, 1000) : 250 * 2 ** attempt;
      if (response.status === 429) await this.limit?.blockUntil(Date.now() + delay);
      if (attempt >= 2 || (response.status !== 429 && response.status < 500)) throw new ClickupError(response.status, reset);
      // Do not retry before the provider's reset. Long waits become an explicit partial result.
      if (delay > 60_000) throw new ClickupError(response.status, Math.max(reset, Date.now() + retryAfter));
      let remaining = delay;
      while (remaining > 0) { const chunk = Math.min(remaining, 30_000); await new Promise(resolve => setTimeout(resolve, chunk)); remaining -= chunk; }
    }
  }
  async identity(): Promise<Identity> {
    const { user } = z.object({ user: z.object({ id, username: z.string().nullish(), email: z.string().min(1) }) }).parse(await this.get('user'));
    return { id: user.id, name: user.username || user.email, email: user.email };
  }
  async workspace(workspaceId: string): Promise<string> {
    const { teams } = z.object({ teams: z.array(z.object({ id, name: z.string() })) }).parse(await this.get('team'));
    const workspace = teams.find(team => team.id === workspaceId);
    if (!workspace) throw new ClickupError(403);
    return workspace.name;
  }
  async tasks(workspaceId: string, userId: string, page: number): Promise<unknown[]> {
    const query = new URLSearchParams({ 'assignees[]': userId, subtasks: 'true', include_closed: 'false', page: String(page), order_by: 'id' });
    return z.object({ tasks: z.array(z.unknown()) }).parse(await this.get(`team/${workspaceId}/task?${query}`)).tasks;
  }
  async task(id: string): Promise<unknown> {
    const result = await this.get(`task/${taskId.parse(id)}`);
    if (z.object({ id: taskId }).parse(result).id !== id) throw new Error('Task identity changed');
    return result;
  }
  parseTask(value: unknown, workspace: string): Task {
    const task = rawTask.parse(value);
    if (!taskLink(task.url) || !['open', 'custom', 'done', 'closed'].includes(task.status.type)) throw new Error('Invalid task metadata');
    const due = task.due_date == null ? null : Number(task.due_date);
    if (due !== null && (!Number.isFinite(due) || !Number.isFinite(new Date(due).getTime()))) throw new Error('Invalid task date');
    return { id: task.id, name: task.name, status: task.status.status, statusType: task.status.type, archived: task.archived, assignees: task.assignees.map(user => user.id), due, priority: task.priority?.priority ?? '—', workspace, list: task.list.name, url: task.url };
  }
}
