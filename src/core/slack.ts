import type { Actor } from './identity.js';

export type Button = { label: string; action: string; value: string; style?: 'primary' | 'danger'; scope?: 'core'; bound?: boolean };
export type AgentMessage = { kind?: string; text: string; buttons?: Button[] };
export interface Messenger {
  send(actor: Actor, message: AgentMessage): Promise<void>;
  post?(actor: Actor, message: AgentMessage): Promise<string>;
  update?(actor: Actor, timestamp: string, message: AgentMessage): Promise<void>;
}
export const menuButton: Button = { label: 'Menu', action: 'menu', value: '', scope: 'core' };
/** Slack explicitly rejected the message, so delivery can be retried. */
export class SlackDeliveryRejected extends Error {}
export const escapeSlack = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const CARD_MARKUP = /[\\`*_{}[\]()#+.!&~>-]/g;
export const escapeCardValue = (value: string) => value.replace(CARD_MARKUP, '\\$&');

const sanitizeReply = (text: string) => text
  .replace(/!\[([^\]]*)]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]*)]\[[^\]]*]/g, '$1')
  .replace(/^\s*\[[^\]]+]:\s*\S+.*$/gm, '')
  .replace(/<(?:https?:\/\/|mailto:)[^>\s]+>/gi, '')
  .replace(/<@[^>]+>/g, '')
  .replace(/<!(?:channel|here|everyone)(?:\|[^>]*)?>/g, '')
  .replace(/<#[^>]+>/g, '')
  .replace(/\bhttps?:\/\/[^\s<]+/gi, '')
  .replace(/\bmailto:[^\s<]+/gi, '')
  .replace(/\bwww\.[^\s<]+/gi, '');

const withMintedConnectUrl = (text: string) => {
  const url = text.match(/\bhttps:\/\/[^\s<]+/gi)?.at(-1);
  const body = sanitizeReply(text).trimEnd();
  return url ? `${body}\n[${url}](${url})` : body;
};

const plainReading = (text: string) => {
  const tokens: string[] = [];
  return text
    .replace(/\\([\\`*_{}[\]()#+.!&~>-])/g, (_, ch: string) => { tokens.push(ch); return `\uE000${tokens.length - 1}\uE001`; })
    .replace(/```[\s\S]*?```/g, chunk => chunk.replace(/^```\w*\r?\n?/, '').replace(/```$/, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/\uE000(\d+)\uE001/g, (_, i: string) => tokens[Number(i)]!);
};

export class Slack implements Messenger {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  async send(actor: Actor, message: AgentMessage) {
    await this.deliver(actor, message);
  }
  async post(actor: Actor, message: AgentMessage) {
    const result = await this.deliver(actor, message);
    if (typeof result.ts !== 'string' || !/^\d+\.\d+$/.test(result.ts)) throw new Error('Slack message identity unavailable.');
    return result.ts;
  }
  async update(actor: Actor, timestamp: string, message: AgentMessage) {
    await this.deliver(actor, message, timestamp);
  }
  private async deliver(actor: Actor, message: AgentMessage, timestamp?: string) {
    const text = message.kind === 'Connect' ? withMintedConnectUrl(message.text) : message.kind ? message.text : sanitizeReply(message.text);
    const buttons = message.buttons ?? [];
    const blocks: any[] = [];
    // Sanitized markdown, not mrkdwn. Cards add a plain-text kind header; Replies have none.
    if (message.kind) blocks.push({ type: 'header', text: { type: 'plain_text', text: message.kind } });
    if (text) blocks.push({ type: 'markdown', text: text.slice(0, 12_000) });
    let actionElements: any[] = [];
    let actionIds = new Set<string>();
    const flushActions = () => {
      if (actionElements.length) blocks.push({ type: 'actions', elements: actionElements });
      actionElements = [];
      actionIds = new Set();
    };
    for (const button of buttons) {
      // Slack requires action IDs to be unique within each actions block.
      if (actionIds.has(button.action) || actionElements.length === 25) flushActions();
      actionElements.push({ type: 'button', text: { type: 'plain_text', text: button.label.slice(0, 75) }, action_id: button.action,
        ...(button.value ? { value: button.value } : {}), ...(button.style ? { style: button.style } : {}) });
      actionIds.add(button.action);
    }
    flushActions();
    const response = await this.fetcher(`https://slack.com/api/${timestamp ? 'chat.update' : 'chat.postMessage'}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: actor.channel, ...(timestamp ? { ts: timestamp } : {}), text: escapeSlack(plainReading(text).slice(0, 3500)), blocks: blocks.slice(0, 50), unfurl_links: false, unfurl_media: false, parse: 'none' }), signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json() as { ok?: boolean; error?: string; ts?: string };
    if (!response.ok || !result.ok) {
      // Transient internal errors can occur after Slack accepted a message.
      const rejected = new Set(['access_denied', 'channel_not_found', 'ekm_access_denied', 'invalid_auth', 'invalid_blocks', 'is_archived', 'missing_scope', 'no_permission', 'not_in_channel', 'rate_limited', 'ratelimited', 'token_expired', 'token_revoked', 'message_not_found', 'cant_update_message']);
      if (result.ok === false && result.error && rejected.has(result.error)) throw new SlackDeliveryRejected('Slack delivery was rejected.');
      throw new Error('Slack delivery failed.');
    }
    return result;
  }
}
