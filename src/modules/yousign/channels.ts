export type Channel = { id: string; name: string; private: boolean };

/** Directory and posting eligibility belong to this Module; no channel history is read. */
export class YousignChannels {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  private async request(method: string, params: Record<string, string>) {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('Slack directory unavailable.');
    const data = await response.json() as any;
    if (!data?.ok) throw new Error('Slack directory unavailable.');
    return data;
  }
  async list(user: string): Promise<Channel[]> {
    const result = new Map<string, Channel>(), visited = new Set<string>();
    let cursor = '';
    do {
      if (visited.has(cursor)) throw new Error('Slack directory pagination stalled.');
      visited.add(cursor);
      const data = await this.request('users.conversations', { user, types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200', ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(data.channels)) throw new Error('Slack directory unavailable.');
      for (const channel of data.channels) {
        if (!channel.is_im && !channel.is_mpim && !channel.is_archived && (channel.is_channel || channel.is_group) &&
          typeof channel.id === 'string' && /^[CG][A-Z0-9]+$/.test(channel.id) && typeof channel.name === 'string')
          result.set(channel.id, { id: channel.id, name: channel.name, private: channel.is_private === true });
      }
      cursor = typeof data.response_metadata?.next_cursor === 'string' ? data.response_metadata.next_cursor : '';
    } while (cursor);
    return [...result.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  async canPost(id: string) {
    const channel = (await this.request('conversations.info', { channel: id })).channel;
    return channel?.id === id && channel.is_member === true && !channel.is_im && !channel.is_mpim && !channel.is_archived &&
      !channel.is_read_only && !channel.is_thread_only && !channel.is_frozen;
  }
}
