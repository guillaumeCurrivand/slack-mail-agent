import type { Project, Ticket } from './domain.js';

export class ClickupDevelopment {
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
    if (String(task.id) !== id || !(await this.lists(project.folder)).includes(String(task.list?.id))) throw new Error('Ce ticket ne fait pas partie du dossier configuré.');
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
