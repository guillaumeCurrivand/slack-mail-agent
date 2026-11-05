import { projectFolders, type Project, type Ticket } from './domain.js';

export class TicketOutsideFolder extends Error {}
export type FolderChoice = { id: string; name: string; space: string; workspace: string };

export class ClickupDevelopment {
  private catalogue?: { expires: number; folders: FolderChoice[] };
  private catalogueRequest?: Promise<FolderChoice[]>;
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  private async request(path: string, method = 'GET', body?: unknown) {
    const response = await this.fetcher(`https://api.clickup.com/api/v2${path}`, { method,
      headers: { Authorization: this.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`ClickUp indisponible (${response.status}).`);
    return response.json() as Promise<any>;
  }
  async lists(folder: string): Promise<string[]> {
    const data = await this.request(`/folder/${encodeURIComponent(folder)}/list?archived=false`);
    if (!Array.isArray(data.lists)) throw new Error('Liste ClickUp incomplète.');
    return data.lists.map((list: any) => String(list.id));
  }
  async folders(refresh = false): Promise<FolderChoice[]> {
    if (this.catalogueRequest) return structuredClone(await this.catalogueRequest);
    if (!refresh && this.catalogue && this.catalogue.expires > Date.now()) return structuredClone(this.catalogue.folders);
    // Cache only complete discovery, never access checks or failed/partial results.
    this.catalogue = undefined;
    this.catalogueRequest = this.discoverFolders();
    try {
      const folders = await this.catalogueRequest;
      this.catalogue = { expires: Date.now() + 60_000, folders };
      return structuredClone(folders);
    } finally { this.catalogueRequest = undefined; }
  }
  private async discoverFolders(): Promise<FolderChoice[]> {
    const records = (data: any, key: string): Array<{ id: string; name: string }> => {
      if (!Array.isArray(data[key]) || data[key].some((item: any) => !item || !/^\d{1,100}$/.test(String(item.id)) || typeof item.name !== 'string' || !item.name.trim()))
        throw new Error('Catalogue ClickUp incomplet.');
      return data[key].filter((item: any) => !item.archived).map((item: any) => ({ id: String(item.id), name: item.name }));
    };
    // Flatten each level before the next: nested pools could exceed the limit.
    const map = async <T, R>(items: T[], read: (item: T) => Promise<R>): Promise<R[]> => {
      const result: R[] = [];
      for (let i = 0; i < items.length; i += 4) {
        const batch = await Promise.allSettled(items.slice(i, i + 4).map(read));
        const failure = batch.find(entry => entry.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        result.push(...batch.map(entry => (entry as PromiseFulfilledResult<R>).value));
      }
      return result;
    };
    const workspaces = records(await this.request('/team'), 'teams');
    const spaces = (await map(workspaces, async workspace => records(await this.request(`/team/${workspace.id}/space?archived=false`), 'spaces').map(space => ({ ...space, workspace: workspace.name })))).flat();
    const folders = (await map(spaces, async space => records(await this.request(`/space/${space.id}/folder?archived=false`), 'folders').map(folder => ({ ...folder, space: space.name, workspace: space.workspace })))).flat();
    const result = new Map(folders.map(folder => [folder.id, folder]));
    return [...result.values()].sort((a, b) => `${a.workspace}/${a.space}/${a.name}/${a.id}`.localeCompare(`${b.workspace}/${b.space}/${b.name}/${b.id}`, 'fr'));
  }
  async tasks(project: Project): Promise<Array<{ id: string; status: string }>> {
    const result = new Map<string, { id: string; status: string }>();
    for (const list of await this.lists(project.folder)) {
      for (let page = 0; ; page++) {
        const data = await this.request(`/list/${encodeURIComponent(list)}/task?archived=false&include_closed=true&subtasks=true&page=${page}`);
        if (!Array.isArray(data.tasks)) throw new Error('Tickets ClickUp incomplets.');
        for (const task of data.tasks) {
          if (typeof task.id !== 'string' || typeof task.status?.status !== 'string') throw new Error('Ticket ClickUp invalide.');
          if (result.has(task.id) && data.tasks.length === 100 && data.tasks.every((item: any) => result.has(item.id))) throw new Error('Pagination ClickUp bloquée.');
          result.set(task.id, { id: task.id, status: task.status.status });
        }
        if (data.last_page === true || data.tasks.length < 100) break;
        if (page >= 9999) throw new Error('Inventaire ClickUp incomplet.');
      }
    }
    return [...result.values()];
  }
  async ticket(project: Project, id: string): Promise<Ticket> {
    const task = await this.request(`/task/${encodeURIComponent(id)}`);
    let belongs = false;
    if (String(task.id) === id) for (const folder of projectFolders(project)) {
      if ((await this.lists(folder)).includes(String(task.list?.id))) { belongs = true; break; }
    }
    if (!belongs) throw new TicketOutsideFolder('Ce ticket ne fait pas partie des dossiers configurés.');
    const comments: string[] = [], seen = new Set<string>();
    let cursor = '';
    for (;;) {
      const data = await this.request(`/task/${encodeURIComponent(id)}/comment${cursor}`);
      if (!Array.isArray(data.comments)) throw new Error('Commentaires ClickUp incomplets.');
      for (const comment of data.comments) comments.push(String(comment.comment_text ?? (comment.comment ?? []).map((part: any) => part.text ?? '').join('')));
      if (data.comments.length < 25) break;
      const last = data.comments.at(-1);
      const next = `?start=${encodeURIComponent(last.date)}&start_id=${encodeURIComponent(last.id)}`;
      if (seen.has(next)) throw new Error('Pagination des commentaires bloquée.');
      seen.add(next); cursor = next;
    }
    return { id, name: String(task.name ?? id), description: String(task.text_content ?? task.description ?? ''),
      status: String(task.status?.status ?? ''), url: `https://app.clickup.com/t/${id}`, comments,
      attachments: (task.attachments ?? []).map((attachment: any) => String(attachment.url ?? '')).filter((url: string) => /^https:\/\//.test(url)) };
  }
  async comment(id: string, text: string) { await this.request(`/task/${encodeURIComponent(id)}/comment`, 'POST', { comment_text: text, notify_all: false }); }
  async built(id: string) { await this.request(`/task/${encodeURIComponent(id)}`, 'PUT', { status: 'to build' }); }
}

/** Channel membership is checked at configuration, receipt and delivery. */
export class DevelopmentChannels {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  private async request(method: string, parameters: Record<string, string | number>) {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
    const response = await this.fetcher(url.toString(), { method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(20_000) });
    const data = await response.json() as any;
    if (!response.ok || !data.ok) throw new Error('Accès Slack indisponible.');
    return data;
  }
  async accessible(channel: string, user?: string) {
    const info = (await this.request('conversations.info', { channel })).channel;
    if (info?.id !== channel || !info.is_member || info.is_archived || info.is_im || info.is_mpim || info.is_read_only) return false;
    if (!user) return true;
    let cursor = ''; const seen = new Set<string>();
    do {
      if (seen.has(cursor)) throw new Error('Pagination Slack bloquée.');
      seen.add(cursor);
      const data = await this.request('conversations.members', { channel, limit: 200, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(data.members)) throw new Error('Membres Slack indisponibles.');
      if (data.members.includes(user)) return true;
      cursor = data.response_metadata?.next_cursor ?? '';
    } while (cursor);
    return false;
  }
}
