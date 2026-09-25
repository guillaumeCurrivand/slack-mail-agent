import { SlackApi } from './api.js';

export type Channel = { id: string; name: string; private: boolean };

const parseChannel = (item: any): Channel | undefined => {
  const isPrivate = item?.is_private === true && (item?.is_channel === true || item?.is_group === true);
  const isPublic = item?.is_channel === true && item?.is_private === false;
  if (!isPrivate && !isPublic || item.is_mpim || item.is_im || item.is_archived ||
    typeof item.id !== 'string' || !/^[CG][A-Z0-9]+$/.test(item.id) || typeof item.name !== 'string') return;
  return { id: item.id, name: item.name, private: isPrivate };
};

/** A bot token lists only conversations shared by the bot and the named user. */
export class SlackChannelDirectory {
  private api: SlackApi;
  constructor(token: string, fetcher: typeof fetch = fetch) { this.api = new SlackApi(token, fetcher); }

  async listFor(user: string): Promise<Channel[]> {
    const channels = new Map<string, Channel>();
    const available = await this.api.pages('users.conversations', { user, types: 'public_channel,private_channel', exclude_archived: 'true' }, 'channels', parseChannel);
    for (const channel of available) channels.set(channel.id, channel);
    return [...channels.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
}
