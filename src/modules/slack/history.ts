export type SlackMessage = {
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
};

const validTs = (value: unknown): value is string => typeof value === 'string' && /^\d{10,}(?:\.\d+)?$/.test(value);
const parseMessage = (value: any): SlackMessage | undefined => {
  if (value?.type !== 'message' || ['message_changed', 'message_deleted', 'bot_message'].includes(value.subtype) ||
    !validTs(value.ts) || typeof value.user !== 'string' || !value.user) return;
  return { ts: value.ts, user: value.user, text: typeof value.text === 'string' ? value.text : '',
    ...(validTs(value.thread_ts) ? { thread_ts: value.thread_ts } : {}),
    ...(Number.isInteger(value.reply_count) && value.reply_count >= 0 ? { reply_count: value.reply_count } : {}),
    ...(validTs(value.latest_reply) ? { latest_reply: value.latest_reply } : {}) };
};

export class SlackHistoryAccessLost extends Error {}

export class SlackHistory {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}

  private async request(method: string, params: Record<string, string>): Promise<any> {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Slack ${method} failed.`);
    const data = await response.json() as any;
    if (!data?.ok) {
      if (['channel_not_found', 'not_in_channel', 'no_permission', 'is_archived', 'access_denied'].includes(data?.error)) throw new SlackHistoryAccessLost();
      throw new Error(`Slack ${method} failed.`);
    }
    return data;
  }

  private async pages(method: string, params: Record<string, string>): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    const cursors = new Set<string>();
    let cursor = '';
    do {
      if (cursors.has(cursor)) throw new Error(`Slack ${method} pagination failed.`);
      cursors.add(cursor);
      const data = await this.request(method, { ...params, limit: '200', ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(data.messages)) throw new Error(`Slack ${method} failed.`);
      for (const raw of data.messages) {
        const message = parseMessage(raw);
        if (message) messages.push(message);
      }
      cursor = typeof data.response_metadata?.next_cursor === 'string' ? data.response_metadata.next_cursor : '';
    } while (cursor);
    return messages;
  }

  // Search older roots too: a recent reply can belong to a thread started before the window.
  roots(channel: string, anchorSeconds: number) {
    return this.pages('conversations.history', { channel, latest: String(anchorSeconds), inclusive: 'true' });
  }

  thread(channel: string, rootTs: string) {
    return this.pages('conversations.replies', { channel, ts: rootTs });
  }

  async profile(user: string): Promise<string[]> {
    const data = await this.request('users.info', { user });
    const profile = data.user?.profile ?? {};
    const names = [profile.display_name, profile.real_name, profile.first_name, data.user?.real_name];
    for (const value of [profile.real_name, profile.display_name]) {
      const first = typeof value === 'string' ? value.trim().split(/\s+/)[0] : undefined;
      if (first) names.push(first);
    }
    return [...new Set(names.filter((name): name is string => typeof name === 'string' && name.trim().length > 0).map(name => name.trim()))];
  }

  async permalink(channel: string, ts: string): Promise<string> {
    const data = await this.request('chat.getPermalink', { channel, message_ts: ts });
    const link = data.permalink;
    if (typeof link !== 'string' || !/^https:\/\/[^\s<>]+$/.test(link)) throw new Error('Slack permalink is invalid.');
    return link;
  }
}
