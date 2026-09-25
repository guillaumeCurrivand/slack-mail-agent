export class SlackApiError extends Error {
  constructor(method: string, readonly code?: string) { super(`Slack ${method} failed.`); }
}

export class SlackApi {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}

  async request(method: string, params: Record<string, string>): Promise<any> {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new SlackApiError(method);
    const data = await response.json() as any;
    if (!data?.ok) throw new SlackApiError(method, typeof data?.error === 'string' ? data.error : undefined);
    return data;
  }

  async pages<T>(method: string, params: Record<string, string>, field: 'channels' | 'messages', parse: (value: any) => T | undefined): Promise<T[]> {
    const items: T[] = [];
    const cursors = new Set<string>();
    let cursor = '';
    do {
      if (cursors.has(cursor)) throw new Error(`Slack ${method} pagination failed.`);
      cursors.add(cursor);
      const data = await this.request(method, { ...params, limit: '200', ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(data[field])) throw new SlackApiError(method);
      for (const raw of data[field]) {
        const item = parse(raw);
        if (item) items.push(item);
      }
      cursor = typeof data.response_metadata?.next_cursor === 'string' ? data.response_metadata.next_cursor : '';
    } while (cursor);
    return items;
  }
}
