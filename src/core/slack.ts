import type { Actor } from './identity.js';
import { logicalAction } from './presentation.js';

export type Button = { label: string; action: string; value: string; style?: 'primary' | 'danger'; scope?: 'core'; bound?: boolean };
export type TableCell = string | Array<{ text: string; url?: string }>;
export type MessageTable = { columns: string[]; rows: TableCell[][] };
export type MessageSelect = { label: string; action: string; options: Array<{ label: string; value: string }> };
export type AgentMessage = { kind?: string; text: string; buttons?: Button[]; resourceLinks?: Array<{ label: string; url: string }>; table?: MessageTable; selects?: MessageSelect[] };
export const validResourceUrl = (value: string) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[\s<>]/.test(value); }
  catch { return false; }
};
export const cellText = (cell: TableCell) => typeof cell === 'string' ? cell : cell.map(part => part.text).join('');
export interface Messenger {
  send(actor: Actor, message: AgentMessage): Promise<void>;
  post?(actor: Actor, message: AgentMessage): Promise<string>;
  update?(actor: Actor, timestamp: string, message: AgentMessage): Promise<void>;
  postChannel?(destination: { team: string; channel: string }, message: AgentMessage): Promise<string>;
  postThread?(destination: { team: string; channel: string; thread?: string }, message: AgentMessage): Promise<string>;
}
export const menuButton: Button = { label: 'Menu', action: 'menu', value: '', scope: 'core' };
/** Slack explicitly rejected the message, so delivery can be retried. */
export class SlackDeliveryRejected extends Error {
  constructor(message = 'Slack delivery was rejected.', readonly code?: string, readonly retryAfter?: number) { super(message); }
}
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

type RichTextPart = { type: 'text'; text: string; style?: { bold: true } } | { type: 'link'; text: string; url: string; style: { bold: true } };

// Card bodies are constructed by the application. Keep interpolated values literal;
// only the two application-minted link forms become clickable rich-text links.
function cardBody(kind: string, text: string) {
  const linkPattern = /(?<!\\)\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g;
  const lines = text.slice(0, 12_000).split('\n');
  return { type: 'rich_text', elements: lines.map(line => {
    const bold = /^\*([^*].*)\*$/.test(line);
    const parts: RichTextPart[] = [];
    let offset = 0;
    for (const match of line.matchAll(linkPattern)) {
      const index = match.index;
      const label = match[1]!, url = match[2]!;
      if (!((['Unanswered for you', 'Messages sans réponse'].includes(kind) && ['Open message', 'Ouvrir le message'].includes(label)) || (['Connect', 'Connexion'].includes(kind) && label === url))) continue;
      if (index > offset) parts.push({ type: 'text', text: plainReading(line.slice(offset, index)), ...(bold ? { style: { bold: true } } : {}) });
      parts.push({ type: 'link', text: label, url, style: { bold: true } });
      offset = index + match[0].length;
    }
    if (offset < line.length) parts.push({ type: 'text', text: plainReading(line.slice(offset)), ...(bold ? { style: { bold: true } } : {}) });
    if (!parts.length) parts.push({ type: 'text', text: ' ' });
    return { type: 'rich_text_section', elements: parts };
  }) };
}

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
  async postChannel(destination: { team: string; channel: string }, message: AgentMessage) {
    if (!/^[CG][A-Z0-9]+$/.test(destination.channel) || message.buttons?.length || message.selects?.length)
      throw new SlackDeliveryRejected('Invalid channel notification.');
    const result = await this.deliver(destination, message);
    if (typeof result.ts !== 'string' || !/^\d+\.\d+$/.test(result.ts)) throw new Error('Slack message identity unavailable.');
    return result.ts;
  }
  async update(actor: Actor, timestamp: string, message: AgentMessage) {
    await this.deliver(actor, message, timestamp);
  }
  async postThread(destination: { team: string; channel: string; thread?: string }, message: AgentMessage) {
    if (!/^[CG][A-Z0-9]+$/.test(destination.channel) || (destination.thread && !/^\d+\.\d+$/.test(destination.thread)) || message.buttons?.length || message.selects?.length)
      throw new SlackDeliveryRejected('Invalid channel reply.');
    const result = await this.deliver(destination, message, undefined, destination.thread);
    if (typeof result.ts !== 'string' || !/^\d+\.\d+$/.test(result.ts)) throw new Error('Slack message identity unavailable.');
    return result.ts;
  }
  private async deliver(actor: { channel: string }, message: AgentMessage, timestamp?: string, thread?: string) {
    const text = ['Connect', 'Connexion'].includes(message.kind ?? '') ? withMintedConnectUrl(message.text) : message.kind ? message.text : sanitizeReply(message.text);
    const buttons = message.buttons ?? [];
    const blocks: any[] = [];
    // Replies remain sanitized markdown. Cards use grouped rich text and actions.
    if (!message.kind && text) blocks.push({ type: 'markdown', text: text.slice(0, 12_000) });
    const cardBlocks: any[] = [];
    if (message.kind) cardBlocks.push(cardBody(message.kind, text || ' '));
    if (message.kind && message.resourceLinks?.length) {
      const links = message.resourceLinks.filter(link => validResourceUrl(link.url));
      if (links.length) cardBlocks.push({ type: 'rich_text', elements: links.map(link => ({ type: 'rich_text_section', elements: [{ type: 'link', text: link.label, url: link.url }] })) });
    }
    if (message.kind && buttons.length) cardBlocks.push({ type: 'divider' });
    let actionElements: any[] = [];
    const flushActions = () => {
      if (actionElements.length) (message.kind ? cardBlocks : blocks).push({ type: 'actions', elements: actionElements });
      actionElements = [];
    };
    for (const [index, button] of buttons.entries()) {
      if (actionElements.length === 25) flushActions();
      if (logicalAction(button.action) !== button.action) throw new SlackDeliveryRejected('Invalid logical button action.');
      actionElements.push({ type: 'button', text: { type: 'plain_text', text: button.label.slice(0, 75) }, action_id: `${button.action}~button-${index}`,
        ...(button.value ? { value: button.value } : {}), ...(button.style ? { style: button.style } : {}) });
    }
    flushActions();
    for (const select of message.selects ?? []) {
      if (!select.options.length) continue;
      cardBlocks.push({ type: 'actions', elements: [{ type: 'static_select', action_id: select.action,
        placeholder: { type: 'plain_text', text: select.label.slice(0, 150) },
        options: select.options.map(option => ({ text: { type: 'plain_text', text: option.label.slice(0, 75) }, value: option.value })) }] });
    }
    if (message.kind) {
      // Preserve every control across continuation containers.
      for (let index = 0; index < Math.max(1, cardBlocks.length); index += 10) {
        blocks.push({ type: 'container', title: { type: 'plain_text', text: index ? 'Autres actions' : message.kind.slice(0, 150) },
          width: 'full', has_header_divider: true, child_blocks: cardBlocks.slice(index, index + 10) });
      }
    }
    if (message.table) {
      const table = message.table;
      if (!table.columns.length || table.columns.length > 20 || table.rows.length > 99 || table.rows.some(row => row.length !== table.columns.length))
        throw new SlackDeliveryRejected('Invalid message table.');
      const rows: TableCell[][] = [table.columns, ...table.rows];
      const size = rows.flat().reduce((sum, cell) => sum + (typeof cell === 'string' ? cell.length : cell.reduce((n, part) => n + part.text.length + (part.url?.length ?? 0), 0)), 0);
      if (size > 10_000) throw new SlackDeliveryRejected('Message table exceeds Slack limits.');
      // Native tables are top-level blocks, between the kind header and controls.
      const selectors = cardBlocks.filter(block => block.type === 'actions' && block.elements.some((element: any) => element.type === 'static_select'));
      const controls = [...selectors, ...cardBlocks.filter(block => ['actions', 'divider'].includes(block.type) && !selectors.includes(block))];
      const body = cardBlocks.filter(block => !['actions', 'divider'].includes(block.type));
      blocks.splice(0);
      if (message.kind) blocks.push({ type: 'container', title: { type: 'plain_text', text: message.kind.slice(0, 150) }, width: 'full', has_header_divider: true, child_blocks: body });
      blocks.push({ type: 'table', column_settings: table.columns.map(() => ({ is_wrapped: true })), rows: rows.map(row => row.map(cell =>
        typeof cell === 'string' ? { type: 'raw_text', text: cell || ' ' } : { type: 'rich_text', elements: [{ type: 'rich_text_section', elements:
          cell.length ? cell.map(part => part.url && validResourceUrl(part.url) ? { type: 'link', text: part.text, url: part.url } : { type: 'text', text: part.text || ' ' }) : [{ type: 'text', text: ' ' }] }] })) });
      for (let index = 0; index < controls.length; index += 10) blocks.push({ type: 'container', title: { type: 'plain_text', text: index ? 'Autres actions' : 'Actions' }, width: 'full', child_blocks: controls.slice(index, index + 10) });
    }
    const response = await this.fetcher(`https://slack.com/api/${timestamp ? 'chat.update' : 'chat.postMessage'}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: actor.channel, ...(timestamp ? { ts: timestamp } : {}), ...(thread ? { thread_ts: thread } : {}), text: escapeSlack([plainReading(text), ...(message.table ? [message.table.columns.join(' | '), ...message.table.rows.map(row => row.map(cellText).join(' | '))] : [])].join('\n').slice(0, 3500)), blocks: blocks.slice(0, 50), unfurl_links: false, unfurl_media: false, parse: 'none' }), signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      throw new SlackDeliveryRejected('Slack rate limit.', 'rate_limited', Number.isFinite(seconds) && seconds > 0 ? seconds : 60);
    }
    const result = await response.json() as { ok?: boolean; error?: string; ts?: string };
    if (!response.ok || !result.ok) {
      // Transient internal errors can occur after Slack accepted a message.
      const rejected = new Set(['access_denied', 'channel_not_found', 'ekm_access_denied', 'invalid_auth', 'invalid_blocks', 'is_archived', 'missing_scope', 'no_permission', 'not_in_channel', 'rate_limited', 'ratelimited', 'token_expired', 'token_revoked', 'message_not_found', 'cant_update_message']);
      if (result.ok === false && result.error && rejected.has(result.error)) throw new SlackDeliveryRejected('Slack delivery was rejected.', result.error);
      throw new Error('Slack delivery failed.');
    }
    return result;
  }
}
