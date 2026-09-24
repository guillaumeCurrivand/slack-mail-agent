import type { Actor } from '../../core/identity.js';
import type { Channel, SlackChannelDirectory } from './channels.js';
import { SlackHistory, SlackHistoryAccessLost, type SlackMessage } from './history.js';
import type { SlackChannelSelections } from './store.js';

export type UnansweredMatch = { channel: Channel; message: SlackMessage };
export type UnansweredCandidate = UnansweredMatch & { thread: SlackMessage[] };
export type UnansweredResults = { matches: UnansweredMatch[]; candidates: UnansweredCandidate[]; names: string[]; skipped: string[] };

export const isAddressed = (text: string, user: string, names: string[]) => {
  if (text.includes(`<@${user}>`) || text.includes(`<@${user}|`)) return true;
  return names.some(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
  });
};

export class SlackUnansweredSearch {
  constructor(private directory: SlackChannelDirectory, private selections: SlackChannelSelections, private history: SlackHistory) {}

  async search(actor: Actor, anchorSeconds: number): Promise<UnansweredResults> {
    const selected = await this.selections.list(actor);
    if (!selected.length) return { matches: [], candidates: [], names: [], skipped: [] };
    const available = new Map((await this.directory.listFor(actor.user)).map(channel => [channel.id, channel]));
    const skipped = selected.filter(id => !available.has(id));
    const names = await this.history.profile(actor.user);
    const cutoff = anchorSeconds - 48 * 60 * 60;
    const matches: UnansweredMatch[] = [];
    const candidates: UnansweredCandidate[] = [];
    for (const id of selected) {
      const channel = available.get(id);
      if (!channel) continue;
      try {
        const channelMatches: UnansweredMatch[] = [];
        const channelCandidates: UnansweredCandidate[] = [];
        const roots = await this.history.roots(id, anchorSeconds);
        for (const root of roots) {
          const rootTime = Number(root.ts);
          const latestReply = root.latest_reply ? Number(root.latest_reply) : 0;
          if (rootTime < cutoff && latestReply < cutoff && !(root.reply_count && !root.latest_reply)) continue;
          const thread = root.reply_count || root.latest_reply ? await this.history.thread(id, root.ts) : [root];
          for (const candidate of thread) {
            const posted = Number(candidate.ts);
            if (posted < cutoff || posted > anchorSeconds || candidate.user === actor.user) continue;
            if (thread.some(reply => reply.user === actor.user && Number(reply.ts) > posted)) continue;
            if (isAddressed(candidate.text, actor.user, names)) channelMatches.push({ channel, message: candidate });
            else channelCandidates.push({ channel, message: candidate, thread });
          }
        }
        matches.push(...channelMatches);
        candidates.push(...channelCandidates);
      } catch (error) {
        if (!(error instanceof SlackHistoryAccessLost)) throw error;
        skipped.push(id);
      }
    }
    const sort = (a: UnansweredMatch, b: UnansweredMatch) => a.channel.name.localeCompare(b.channel.name) || Number(b.message.ts) - Number(a.message.ts);
    matches.sort(sort);
    candidates.sort(sort);
    return { matches, candidates, names, skipped: [...new Set(skipped)] };
  }
}
