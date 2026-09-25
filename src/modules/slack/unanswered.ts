import type { Actor } from '../../core/identity.js';
import type { Channel, SlackChannelDirectory } from './channels.js';
import { SlackHistory, SlackHistoryAccessLost, type SlackMessage } from './history.js';
import type { SlackChannelSelections } from './store.js';

export type UnansweredMatch = { channel: Channel; message: SlackMessage };
export type UnansweredCandidate = UnansweredMatch & { thread: SlackMessage[]; followup: boolean; direct: boolean };
export type UnansweredResults = { matches: UnansweredMatch[]; candidates: UnansweredCandidate[]; names: string[]; selected: string[]; available: string[]; skipped: string[] };

export const isAddressed = (text: string, user: string, names: string[]) => {
  if (text.includes(`<@${user}>`) || text.includes(`<@${user}|`)) return true;
  return names.some(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
  });
};

// Only suppress acknowledgements whose entire message is a short thanks or
// receipt. Anything with additional words may contain a new request.
export const isObviousAcknowledgement = (text: string, names: string[]) => {
  let remainder = text.replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/gi, ' ');
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    remainder = remainder.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu'), ' ');
  }
  remainder = remainder.replace(/[\s,.!:;]+/g, ' ').trim().toLowerCase();
  return /^(?:(?:thanks|thank you|thx|ty)(?: so much)?(?: for (?:the|your) (?:update|help|answer|info|information|details|response|file|draft|figures)| for (?:that|this))?|got it(?: thanks)?|received|noted|sounds good|perfect|great|ok|okay)$/.test(remainder);
};

export class SlackUnansweredSearch {
  constructor(private directory: SlackChannelDirectory, private selections: SlackChannelSelections, private history: SlackHistory) {}

  async search(actor: Actor, anchor: Date): Promise<UnansweredResults> {
    const selected = await this.selections.list(actor);
    if (!selected.length) return { matches: [], candidates: [], names: [], selected, available: [], skipped: [] };
    const available = new Map((await this.directory.listFor(actor.user)).map(channel => [channel.id, channel]));
    const availableIds = selected.filter(id => available.has(id));
    const skipped = selected.filter(id => !available.has(id));
    const names = await this.history.profile(actor.user);
    const anchorSeconds = anchor.getTime() / 1000;
    const cutoff = anchorSeconds - 48 * 60 * 60;
    const matches: UnansweredMatch[] = [];
    const candidates: UnansweredCandidate[] = [];
    for (const id of selected) {
      const channel = available.get(id);
      if (!channel) continue;
      try {
        const channelMatches: UnansweredMatch[] = [];
        const channelCandidates: UnansweredCandidate[] = [];
        const roots = await this.history.roots(id, anchor);
        for (const root of roots) {
          const rootTime = Number(root.ts);
          const latestReply = root.latest_reply ? Number(root.latest_reply) : 0;
          if (rootTime < cutoff && latestReply < cutoff && !(root.reply_count && !root.latest_reply)) continue;
          const thread = root.reply_count || root.latest_reply ? await this.history.thread(id, root.ts) : [root];
          for (const candidate of thread) {
            const posted = Number(candidate.ts);
            if (posted < cutoff || posted > anchorSeconds || candidate.user === actor.user) continue;
            if (thread.some(reply => reply.user === actor.user && Number(reply.ts) > posted)) continue;
            const direct = isAddressed(candidate.text, actor.user, names);
            const followup = thread.some(reply => reply.user === actor.user && Number(reply.ts) < posted);
            if (followup && isObviousAcknowledgement(candidate.text, names)) continue;
            if (direct && !followup) channelMatches.push({ channel, message: candidate });
            else channelCandidates.push({ channel, message: candidate, thread, followup, direct });
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
    return { matches, candidates, names, selected, available: availableIds, skipped: [...new Set(skipped)] };
  }
}
