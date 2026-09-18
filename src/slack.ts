import type { Actor } from './domain.js';

export type Button = { label: string; action: string; value: string; style?: 'primary' | 'danger' };
export type AgentMessage = { kind?: string; text: string; buttons?: Button[] };
export interface Messenger { send(actor: Actor, message: AgentMessage): Promise<void> }
export const escapeSlack = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

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

const plainReading = (text: string) => text
  .replace(/```[\s\S]*?```/g, chunk => chunk.replace(/^```\w*\r?\n?/, '').replace(/```$/, ''))
  .replace(/`([^`]+)`/g, '$1')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/\*([^*]+)\*/g, '$1')
  .replace(/_([^_]+)_/g, '$1')
  .replace(/~~([^~]+)~~/g, '$1')
  .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
  .replace(/^>\s?/gm, '');

export class Slack implements Messenger {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  async send(actor: Actor, message: AgentMessage) {
    const text = message.kind === 'Connect' ? withMintedConnectUrl(message.text) : message.kind ? message.text : sanitizeReply(message.text);
    const buttons = message.buttons ?? [];
    const blocks: any[] = [];
    // Sanitized markdown, not mrkdwn. Cards add a plain-text kind header; Replies have none.
    if (message.kind) blocks.push({ type: 'header', text: { type: 'plain_text', text: message.kind } });
    if (text) blocks.push({ type: 'markdown', text: text.slice(0, 12_000) });
    if (buttons.length) blocks.push({ type: 'actions', elements: buttons.map(b => ({ type: 'button', text: { type: 'plain_text', text: b.label.slice(0, 75) }, action_id: b.action, value: b.value, ...(b.style ? { style: b.style } : {}) })) });
    const response = await this.fetcher('https://slack.com/api/chat.postMessage', {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: actor.channel, text: escapeSlack(plainReading(text).slice(0, 3500)), blocks: blocks.slice(0, 50), unfurl_links: false, unfurl_media: false, parse: 'none' }), signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok || !(await response.json() as any).ok) throw new Error('Slack delivery failed.');
  }
}
