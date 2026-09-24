export type Channel = { id: string; name: string; private: boolean };

/** A bot token lists only conversations shared by the bot and the named user. */
export class SlackChannelDirectory {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}

  async listFor(user: string): Promise<Channel[]> {
    const channels = new Map<string, Channel>();
    const cursors = new Set<string>();
    let cursor = '';
    do {
      if (cursors.has(cursor)) throw new Error('Slack channel listing failed.');
      cursors.add(cursor);
      const url = new URL('https://slack.com/api/users.conversations');
      url.searchParams.set('user', user);
      url.searchParams.set('types', 'public_channel,private_channel');
      url.searchParams.set('exclude_archived', 'true');
      url.searchParams.set('limit', '200');
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error('Slack channel listing failed.');
      const data = await response.json() as any;
      if (!data?.ok || !Array.isArray(data.channels)) throw new Error('Slack channel listing failed.');
      for (const item of data.channels) {
        const isPrivate = item?.is_private === true && item?.is_group === true;
        const isPublic = item?.is_channel === true && item?.is_private === false;
        if (!isPrivate && !isPublic || item.is_mpim || item.is_im || item.is_archived ||
          typeof item.id !== 'string' || !/^[CG][A-Z0-9]+$/.test(item.id) || typeof item.name !== 'string') continue;
        channels.set(item.id, { id: item.id, name: item.name, private: isPrivate });
      }
      cursor = typeof data.response_metadata?.next_cursor === 'string' ? data.response_metadata.next_cursor : '';
    } while (cursor);
    return [...channels.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
}
