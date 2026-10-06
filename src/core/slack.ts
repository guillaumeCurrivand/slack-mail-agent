import type { Actor } from './identity.js';
import { logicalAction } from './presentation.js';

export type Button = { label: string; action: string; value: string; style?: 'primary' | 'danger'; scope?: 'core'; bound?: boolean };
export type TableCell = string | Array<{ text: string; url?: string }>;
export type MessageTable = { columns: string[]; rows: TableCell[][]; rowButtons?: Button[] };
export type MessageSelect = { label: string; action: string; options: Array<{ label: string; value: string }> };
export type AgentMessage = { kind?: string; text: string; buttons?: Button[]; buttonPaging?: boolean; resourceLinks?: Array<{ label: string; url: string }>; table?: MessageTable; selects?: MessageSelect[] };
export const validResourceUrl = (value: string) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[\s<>\\]/.test(value); }
  catch { return false; }
};
export const cellText = (cell: TableCell) => typeof cell === 'string' ? cell : cell.map(part => part.text).join('');
export const navigationCue = '🧭';
export const buttonDisplayLabel = (button: Button) => {
  // A core:navigate destination can be a page choice; only structural controls get the cue.
  const navigation = button.action === 'core:controls' || button.action === 'core:menu'
    || /^(?:Précédent|Suivant|Retour|Menu|Valeurs précédentes|Valeurs suivantes|Fermer)(?:\b|$)/i.test(button.label);
  return navigation ? `${navigationCue} ${button.label}` : button.label;
};
export interface Messenger {
  prepare?(message: AgentMessage): AgentMessage;
  send(actor: Actor, message: AgentMessage): Promise<void>;
  post?(actor: Actor, message: AgentMessage): Promise<string>;
  update?(actor: Actor, timestamp: string, message: AgentMessage): Promise<void>;
  postChannel?(destination: { team: string; channel: string }, message: AgentMessage): Promise<string>;
  postThread?(destination: { team: string; channel: string; thread?: string }, message: AgentMessage): Promise<string>;
}
export const menuButton: Button = { label: 'Menu', action: 'menu', value: '', scope: 'core' };
// Slack accepts more elements per actions block but may hide extras behind "+N autres".
const VISIBLE_ACTION_BUTTONS = 5;
/** Slack explicitly rejected the message, so delivery can be retried. */
export class SlackDeliveryRejected extends Error {
  constructor(message = 'Slack delivery was rejected.', readonly code?: string, readonly retryAfter?: number) { super(message); }
}
export const escapeSlack = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const CARD_MARKUP = /[\\`*_{}[\]()#+.!&~>-]/g;
export const escapeCardValue = (value: string) => value.replace(CARD_MARKUP, '\\$&');
const trimDisplayUrl = (raw: string) => {
  let value = raw.replace(/[.,;!?]+$/, '');
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
    while (value.endsWith(close) && [...value].filter(character => character === close).length > [...value].filter(character => character === open).length)
      value = value.slice(0, -1);
  }
  return value.replace(/[.,;!?]+$/, '');
};

function linkifyReply(text: string): string {
  const preserved: string[] = [];
  const token = (value: string) => { preserved.push(value); return `\uE100${preserved.length - 1}\uE101`; };
  const masked = text.replace(/\[([^\]\n]+)]\(((?:https?:\/\/|www\.)(?:[^\s()]|\([^()\s]*\))+)\)|<(https?:\/\/[^>\s]+)>/gi,
    (match, label: string | undefined, raw: string | undefined, angle: string | undefined) => token(raw && validDisplayUrl(raw) ? `[${label}](${displayUrl(raw)})` : angle && validDisplayUrl(angle) ? `[${angle}](${angle})` : match));
  return masked.replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/gi, raw => {
    const url = trimDisplayUrl(raw);
    return validDisplayUrl(url) ? `[${url}](${displayUrl(url)})${raw.slice(url.length)}` : raw;
  }).replace(/\uE100(\d+)\uE101/g, (_, index: string) => preserved[Number(index)]!);
}

export const sanitizeReply = (text: string) => linkifyReply(text
  .replace(/!\[([^\]]*)]\(/g, '[$1](')
  .replace(/\[([^\]\n]*)]\(((?:[^()\n]|\([^()\n]*\))+)\)/g, (match, label: string, url: string) => validDisplayUrl(url) ? match : label)
  .replace(/\[([^\]]*)]\[[^\]]*]/g, '$1')
  .replace(/^\s*\[[^\]]+]:\s*\S+.*$/gm, '')
  .replace(/<(mailto:)[^>\s]+>/gi, '')
  .replace(/<@[^>]+>/g, '')
  .replace(/<!(?:channel|here|everyone)(?:\|[^>]*)?>/g, '')
  .replace(/<#[^>]+>/g, '')
  .replace(/\bmailto:[^\s<]+/gi, ''));

const plainReading = (text: string, keepLinks = false) => {
  const tokens: string[] = [];
  const urls: string[] = [];
  const masked = text.replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/gi, raw => {
    if (!validDisplayUrl(trimDisplayUrl(raw))) return raw;
    urls.push(raw);
    return `\uE200${urls.length - 1}\uE201`;
  });
  return masked
    .replace(/\\([\\`*_{}[\]()#+.!&~>-])/g, (_, ch: string) => { tokens.push(ch); return `\uE000${tokens.length - 1}\uE001`; })
    .replace(/```[\s\S]*?```/g, chunk => chunk.replace(/^```\w*\r?\n?/, '').replace(/```$/, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]*)]\([^)]*\)/g, (match, label: string) => keepLinks ? match : label)
    .replace(/^>\s?/gm, '')
    .replace(/\uE000(\d+)\uE001/g, (_, i: string) => tokens[Number(i)]!)
    .replace(/\uE200(\d+)\uE201/g, (_, i: string) => urls[Number(i)]!);
};

type RichTextPart = { type: 'text'; text: string; style?: { bold: true } } | { type: 'link'; text: string; url: string; style?: { bold: true } };
const validDisplayUrl = (value: string) => validResourceUrl(value.startsWith('www.') ? `https://${value}` : value);
const displayUrl = (value: string) => value.startsWith('www.') ? `https://${value}` : value;
const linkPattern = /\[([^\]\n]+)]\(((?:https?:\/\/|www\.)(?:[^\s()]|\([^()\s]*\))+)\)|\b(https?:\/\/[^\s<>]+|www\.[^\s<>]+)/gi;
function linkedParts(text: string, bold = false): RichTextPart[] {
  const parts: RichTextPart[] = [];
  let offset = 0;
  for (const match of text.matchAll(linkPattern)) {
    const raw = match[2] ?? match[3]!;
    const trimmed = match[2] ? raw : trimDisplayUrl(raw);
    if (!validDisplayUrl(trimmed)) continue;
    const index = match.index;
    if (index > offset) parts.push({ type: 'text', text: text.slice(offset, index), ...(bold ? { style: { bold: true } } : {}) });
    parts.push({ type: 'link', text: match[1] ?? trimmed, url: displayUrl(trimmed), ...(bold ? { style: { bold: true } } : {}) });
    offset = index + (match[2] ? match[0].length : trimmed.length);
  }
  if (offset < text.length) parts.push({ type: 'text', text: text.slice(offset), ...(bold ? { style: { bold: true } } : {}) });
  return parts.length ? parts : [{ type: 'text', text: text || ' ' }];
}

function cardBody(_kind: string, text: string) {
  const lines = text.split('\n');
  return { type: 'rich_text', elements: lines.map(line => {
    const bold = /^\*([^*].*)\*$/.test(line);
    return { type: 'rich_text_section', elements: linkedParts(plainReading(line, true), bold) };
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
    const text = message.kind ? message.text : sanitizeReply(message.text);
    if (text.length > 12_000) throw new SlackDeliveryRejected('Message text exceeds Slack limits.');
    const buttons = message.buttons ?? [];
    const blocks: any[] = [];
    // Replies remain sanitized markdown. Cards use grouped rich text and actions.
    if (!message.kind && text) blocks.push({ type: 'markdown', text });
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
      if (actionElements.length === VISIBLE_ACTION_BUTTONS) flushActions();
      if (logicalAction(button.action) !== button.action) throw new SlackDeliveryRejected('Invalid logical button action.');
      const label = buttonDisplayLabel(button);
      actionElements.push({ type: 'button', text: { type: 'plain_text', text: label.slice(0, 75) }, action_id: `${button.action}~button-${index}`,
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
      if (!table.columns.length || table.columns.length + (table.rowButtons ? 1 : 0) > 20 || table.rows.length < 1 || table.rows.length > 200 || table.rows.some(row => row.length !== table.columns.length) || (table.rowButtons && table.rowButtons.length !== table.rows.length))
        throw new SlackDeliveryRejected('Invalid message table.');
      const rows: TableCell[][] = [table.columns, ...table.rows];
      const size = rows.flat().reduce((sum, cell) => sum + (typeof cell === 'string' ? cell.length : cell.reduce((n, part) => n + part.text.length + (part.url?.length ?? 0), 0)), 0) + (table.rowButtons?.reduce((sum, button) => sum + button.label.length, 0) ?? 0);
      const totalSize = size + text.length + (message.resourceLinks?.reduce((sum, link) => sum + link.label.length + link.url.length, 0) ?? 0)
        + buttons.reduce((sum, button) => sum + button.label.length, 0);
      if (totalSize > 20_000) throw new SlackDeliveryRejected('Message table exceeds Slack limits.');
      // Native tables are top-level blocks, between the kind header and controls.
      const selectors = cardBlocks.filter(block => block.type === 'actions' && block.elements.some((element: any) => element.type === 'static_select'));
      const controls = [...selectors, ...cardBlocks.filter(block => ['actions', 'divider'].includes(block.type) && !selectors.includes(block))];
      const body = cardBlocks.filter(block => !['actions', 'divider'].includes(block.type));
      blocks.splice(0);
      if (message.kind) blocks.push({ type: 'container', title: { type: 'plain_text', text: message.kind.slice(0, 150) }, width: 'full', has_header_divider: true, child_blocks: body });
      const cellBlock = (cell: TableCell) => {
        const parts = typeof cell === 'string' ? linkedParts(cell) : cell.flatMap(part => part.url && validResourceUrl(part.url)
          ? [{ type: 'link' as const, text: part.text, url: part.url }] : linkedParts(part.text));
        return parts.some(part => part.type === 'link') ? { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: parts }] } : { type: 'raw_text', text: cellText(cell) || ' ' };
      };
      const dataRows = table.rows.map((row, index) => [...row.map(cellBlock), ...(table.rowButtons?.[index] ? [{ type: 'action_cell', element: {
        type: 'button', text: { type: 'plain_text', text: buttonDisplayLabel(table.rowButtons[index]!).slice(0, 75) },
        action_id: `${table.rowButtons[index]!.action}~button-${index + buttons.length}`, value: table.rowButtons[index]!.value,
      }, fallback: { type: 'raw_text', text: 'Rechercher la fiche dans le DM' } }] : [])]);
      blocks.push({ type: 'data_table', caption: message.kind ?? 'Résultats', page_size: Math.min(100, table.rows.length),
        rows: [[...table.columns.map(column => ({ type: 'raw_text', text: column || ' ' })), ...(table.rowButtons ? [{ type: 'raw_text', text: 'Ouvrir' }] : [])], ...dataRows] });
      for (let index = 0; index < controls.length; index += 10) blocks.push({ type: 'container', title: { type: 'plain_text', text: index ? 'Autres actions' : 'Actions' }, width: 'full', child_blocks: controls.slice(index, index + 10) });
    }
    if (blocks.length > 50) throw new SlackDeliveryRejected('Message has too many Slack blocks.');
    const response = await this.fetcher(`https://slack.com/api/${timestamp ? 'chat.update' : 'chat.postMessage'}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: actor.channel, ...(timestamp ? { ts: timestamp } : {}), ...(thread ? { thread_ts: thread } : {}), text: escapeSlack([plainReading(text), ...(message.table ? [message.table.columns.join(' | '), ...message.table.rows.map(row => row.map(cellText).join(' | '))] : [])].join('\n').slice(0, 3500)), blocks, unfurl_links: false, unfurl_media: false, parse: 'none' }), signal: AbortSignal.timeout(20_000),
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
