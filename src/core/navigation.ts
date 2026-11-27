import { ownerKey, uid, type Actor } from './identity.js';
import { cellSize, mapRowActions, buttonDisplayLabel, sanitizeReply, SlackDeliveryRejected, VISIBLE_ACTION_BUTTONS, WRAPPED_TABLE_LIMIT, type AgentMessage, type Button, type Messenger, type MessageTable, type TableCell } from './slack.js';
import type { Sql } from './store.js';

export type MenuPage = AgentMessage & { links?: Array<{ label: string; page: string }>; recordChoices?: Array<{ label: string; page: string }>; bindButtons?: boolean };
export type MenuTarget = { id: string; timestamp: string };

export async function boundMenuTarget(sql: Sql, actor: Actor, value: unknown, timestamp: unknown): Promise<{ target: MenuTarget; value: string } | undefined> {
  if (typeof value !== 'string' || typeof timestamp !== 'string') return;
  const separator = value.indexOf('|');
  if (separator < 1) return;
  const id = value.slice(0, separator), boundValue = value.slice(separator + 1);
  if (!boundValue) return;
  const record = (await sql.query("SELECT id FROM core_navigation_menus WHERE id=$1 AND owner=$2 AND channel=$3 AND timestamp=$4 AND created_at>=now()-interval '30 days'", [id, ownerKey(actor), actor.channel, timestamp])).rows[0];
  return record ? { target: { id, timestamp }, value: boundValue } : undefined;
}

const TEXT_PAGE_SIZE = 10_000;
const VISIBLE_BUTTON_LIMIT = 20;
// Slack determines the actual wrap from the client width. Budget for a compact
// desktop action row while keeping every choice reachable on narrower clients.
const ACTION_ROW_WIDTH = 90;
const ACTION_ROW_BUTTONS = 5;
const previousActions = '◀ Actions';
const nextActions = 'Actions ▶';
const buttonWidth = (button: Button) => Math.min(30, [...buttonDisplayLabel(button)].length) + 5;
const pagingButton = (label: string): Button => ({ label, action: 'core:controls', value: '', scope: 'core' });

function controlPages(buttons: Button[], textPaged = false): { pages: Button[][]; pinned: Button[] } {
  const menu = buttons.findLast(button => button.action === 'core:menu' || /^Retour au menu$/i.test(button.label));
  const pinned = menu ? [menu] : [];
  const choices = buttons.filter(button => button !== menu);
  const textWidth = textPaged ? buttonWidth(pagingButton('Précédent')) + buttonWidth(pagingButton('Suivant')) : 0;
  const pages: Button[][] = [];
  for (let start = 0; start < choices.length;) {
    const page: Button[] = [];
    let width = pinned.reduce((sum, button) => sum + buttonWidth(button), textWidth);
    if (start) width += buttonWidth(pagingButton(previousActions));
    while (start + page.length < choices.length) {
      const next = choices[start + page.length]!;
      const hasNextPage = start + page.length + 1 < choices.length;
      const controls = page.length + 1 + pinned.length + Number(start > 0) + Number(hasNextPage) + (textPaged ? 2 : 0);
      const rowWidth = width + page.reduce((sum, button) => sum + buttonWidth(button), 0)
        + buttonWidth(next) + (hasNextPage ? buttonWidth(pagingButton(nextActions)) : 0);
      if (page.length && (controls > ACTION_ROW_BUTTONS || rowWidth > ACTION_ROW_WIDTH)) break;
      page.push(next);
      if (controls >= ACTION_ROW_BUTTONS || rowWidth >= ACTION_ROW_WIDTH) break;
    }
    pages.push(page);
    start += page.length;
  }
  return { pages: pages.length ? pages : [[]], pinned };
}

export const needsControlPaging = (message: AgentMessage) => message.buttonPaging === true || (message.buttons?.length ?? 0) > VISIBLE_BUTTON_LIMIT;

const splitText = (value: string, reply: boolean): string[] => {
  const size = (part: string) => reply ? sanitizeReply(part).length : part.length;
  const pages = [''];
  for (const line of value.split('\n')) {
    const current = pages.at(-1)!;
    const joined = current ? `${current}\n${line}` : line;
    if (size(joined) <= TEXT_PAGE_SIZE) { pages[pages.length - 1] = joined; continue; }
    if (current) pages.push('');
    let rest = line;
    while (size(rest) > TEXT_PAGE_SIZE) {
      let low = 1, high = rest.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (size(rest.slice(0, middle)) <= TEXT_PAGE_SIZE) low = middle;
        else high = middle - 1;
      }
      const space = Math.max(rest.lastIndexOf(' ', low), rest.lastIndexOf('\t', low));
      const cut = space > low / 2 ? space + 1 : low;
      pages[pages.length - 1] = rest.slice(0, cut);
      pages.push('');
      rest = rest.slice(cut);
    }
    pages[pages.length - 1] = rest;
  }
  return pages;
};

function splitCell(cell: TableCell, maxSize: number): TableCell[] {
  const split = (text: string, size: number) => {
    const parts: string[] = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + Math.max(2, size), text.length);
      if (/[\uDC00-\uDFFF]/.test(text.charAt(end))) end--;
      parts.push(text.slice(start, end));
      start = end;
    }
    return parts;
  };
  if (typeof cell === 'string') return split(cell, maxSize);
  const pages: Array<Exclude<TableCell, string>> = [[]];
  for (const part of cell) {
    for (const text of split(part.text, maxSize - (part.url?.length ?? 0))) {
      const piece = { ...part, text };
      if (pages.at(-1)!.length && cellSize(pages.at(-1)!) + cellSize([piece]) > maxSize) pages.push([]);
      pages.at(-1)!.push(piece);
    }
  }
  return pages;
}

function tablePages(table: MessageTable, budget: number): MessageTable[] {
  const pages: MessageTable[] = [];
  const headings = table.rowButtons ? [table.rowButtonColumn ?? 'Actions'].flat() : [];
  const headerSize = [...table.columns, ...headings].join('').length;
  const actionSize = headings.length * Math.max(75, table.rowButtonFallback?.length ?? 0);
  const rowBudget = budget - headerSize - actionSize;
  // Reserve ten of Slack's fifty blocks for message context and navigation.
  const maxRows = headings.length ? Math.floor(40 / (1 + Math.ceil(headings.length / VISIBLE_ACTION_BUTTONS))) : 99;
  const createPage = (): MessageTable => ({ ...table, rows: [], ...(table.rowButtons ? { rowButtons: [] } : {}) });
  let page = createPage(), size = headerSize;
  for (const [index, row] of table.rows.entries()) {
    const sizes = row.map(cellSize);
    let pieces = [row];
    if (sizes.reduce((sum, size) => sum + size, 0) > rowBudget) {
      // Keep the short fields (including record names and source links) beside each continuation.
      const long = sizes.map(size => size > rowBudget / row.length);
      const context = row.map((cell, i) => long[i] ? '' : cell);
      const available = rowBudget - context.reduce((sum, cell) => sum + cellSize(cell), 0);
      pieces = row.flatMap((cell, column) => !long[column] ? [] : splitCell(cell, available)
        .map(part => context.map((field, i) => i === column ? part : field)));
    }
    for (const piece of pieces) {
      const rowSize = piece.reduce((sum, cell) => sum + Math.max(1, cellSize(cell)), actionSize);
      if (page.rows.length && (size + rowSize > budget || page.rows.length >= maxRows)) {
        pages.push(page);
        page = createPage();
        size = headerSize;
      }
      page.rows.push(piece);
      page.rowButtons?.push(table.rowButtons?.[index] ?? null);
      size += rowSize;
    }
  }
  pages.push(page);
  return pages;
}

function visiblePage(message: AgentMessage, id: string, requestedControl = 0, requestedText = 0, namespace = 'core', view?: AgentMessage['tableView']): AgentMessage {
  const textPages = splitText(message.text, !message.kind);
  // Retain full rows and their bound actions in saved content; only delivery is paged.
  const budget = Math.min(WRAPPED_TABLE_LIMIT - 500, 19_000 - Math.max(...textPages.map(text => text.length))
    - (message.resourceLinks ?? []).reduce((sum, link) => sum + link.label.length + link.url.length, 0)
    - (message.buttons ?? []).reduce((sum, button) => sum + button.label.length, 0));
  const tables = message.table ? message.tablePaging === false ? [message.table] : tablePages(message.table, budget) : [];
  const contentPages = Math.max(textPages.length, tables.length);
  const textPage = Math.max(0, Math.min(requestedText, contentPages - 1));
  // Ordinary screens keep all choices visible in short Slack action rows.
  const { pages, pinned } = needsControlPaging(message)
    ? controlPages(message.buttons ?? [], contentPages > 1)
    : { pages: [message.buttons ?? []], pinned: [] as Button[] };
  const controlPage = Math.max(0, Math.min(requestedControl, pages.length - 1));
  const table = tables[textPage];
  const tableView = view ?? 'wrapped';
  const pageButton = (label: string, nextControl: number, nextText: number, nextView = view) => ({ label, action: `${namespace}:controls`, value: `${id}|${nextControl}|${nextText}${nextView ? `|${nextView}` : ''}`, ...(namespace === 'core' ? { scope: 'core' as const } : {}) });
  return { ...message, text: contentPages > 1 ? `Réponse — page ${textPage + 1}/${contentPages}\n${textPages[textPage] ?? ''}` : message.text,
    ...(message.table ? { table, tableView } : {}),
    buttons: [...pages[controlPage]!, ...pinned,
      ...(controlPage ? [pageButton(previousActions, controlPage - 1, textPage)] : []),
      ...(controlPage + 1 < pages.length ? [pageButton(nextActions, controlPage + 1, textPage)] : []),
      ...(textPage ? [pageButton(tables.length > 1 ? 'Tableau précédent' : 'Précédent', controlPage, textPage - 1)] : []),
      ...(textPage + 1 < contentPages ? [pageButton(tables.length > 1 ? 'Tableau suivant' : 'Suivant', controlPage, textPage + 1)] : []),
      ...(table ? [tableView === 'wrapped' ? pageButton('Tableau compact', controlPage, textPage, 'compact')
        : pageButton('Tableau avec retour à la ligne', controlPage, textPage, 'wrapped')] : [])] };
}

/** Recorded Agent messages can update only through owner- and message-bound controls. */
export class Navigation {
  constructor(private sql: Sql, private messenger: Messenger, private namespace = 'core') {}

  async target(actor: Actor, value: unknown, timestamp: unknown): Promise<{ target: MenuTarget; page: string } | undefined> {
    const bound = await this.boundTarget(actor, value, timestamp);
    if (!bound || !/^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)?$/.test(bound.value)) return;
    return { target: bound.target, page: bound.value };
  }

  async boundTarget(actor: Actor, value: unknown, timestamp: unknown): Promise<{ target: MenuTarget; value: string } | undefined> {
    return boundMenuTarget(this.sql, actor, value, timestamp);
  }

  async controls(actor: Actor, eventId: string, value: unknown, timestamp: unknown) {
    const bound = await this.boundTarget(actor, value, timestamp);
    const requested = bound && /^(\d{1,4})\|(\d{1,4})(?:\|(wide|wrapped|compact))?$/.exec(bound.value);
    if (!bound || !requested) return;
    const saved = (await this.sql.query('SELECT content FROM core_navigation_menus WHERE id=$1 AND owner=$2 AND channel=$3 AND timestamp=$4',
      [bound.target.id, ownerKey(actor), actor.channel, bound.target.timestamp])).rows[0]?.content as AgentMessage | undefined;
    if (!saved) return;
    const [, controlPage, textPage, view] = requested;
    return this.deliver(actor, eventId, bound.target.id, saved, bound.target, false, Number(controlPage), Number(textPage),
      view === 'compact' ? view : view ? 'wrapped' : undefined);
  }

  async show(actor: Actor, eventId: string, page: MenuPage, target = this.messenger.replyTarget?.(actor)) {
    const id = target?.id ?? uid();
    const { links = [], recordChoices = [], bindButtons = false, ...content } = page;
    const rowChoices = !!content.table && recordChoices.length === content.table.rows.length;
    const bind = (button: Button) => bindButtons || button.bound ? { ...button, value: `${id}|${button.value}` } : button;
    const rawMessage: AgentMessage = { ...content,
      ...(content.table ? { table: { ...content.table, ...(rowChoices ? { rowButtons: recordChoices.map(link => ({ label: 'Ouvrir', action: `${this.namespace}:navigate`, value: `${id}|${link.page}` })) }
        : content.table.rowButtons ? { rowButtons: content.table.rowButtons.map(row => mapRowActions(row, bind)) } : {}) } } : {}),
      buttons: [...(content.buttons ?? []).map(bind),
      ...(!rowChoices ? recordChoices.map(link => ({ label: link.label, action: `${this.namespace}:navigate`, value: `${id}|${link.page}` })) : []),
      ...links.map(link => ({ label: link.label, action: `${this.namespace}:navigate`, value: `${id}|${link.page}` }))] };
    const message = this.messenger.prepare?.(rawMessage) ?? rawMessage;
    return this.deliver(actor, eventId, id, message, target, true);
  }

  private async deliver(actor: Actor, eventId: string, id: string, fullMessage: AgentMessage, target?: MenuTarget,
    replaceContent = true, controlPage = 0, textPage = 0, view?: AgentMessage['tableView']) {
    const message = visiblePage(fullMessage, id, controlPage, textPage, this.namespace, view);
    // Record intent before contacting Slack: an uncertain response must not be resent.
    const claimed = await this.sql.query('INSERT INTO core_navigation_deliveries(event_id,owner) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id', [eventId, ownerKey(actor)]);
    if (!claimed.rows.length) return;
    let attempted = false;
    let previousContent: AgentMessage | undefined;
    try {
      if (target) {
        if (!this.messenger.update) throw new Error('Message updates unavailable.');
        if (replaceContent) {
          previousContent = (await this.sql.query('SELECT content FROM core_navigation_menus WHERE id=$1 AND owner=$2 AND channel=$3 AND timestamp=$4',
            [id, ownerKey(actor), actor.channel, target.timestamp])).rows[0]?.content;
          await this.sql.query('UPDATE core_navigation_menus SET content=$2 WHERE id=$1 AND owner=$3 AND channel=$4 AND timestamp=$5',
            [id, JSON.stringify(fullMessage), ownerKey(actor), actor.channel, target.timestamp]);
        }
        attempted = true;
        await this.messenger.update(actor, target.timestamp, message);
      } else if (this.messenger.post) {
        await this.sql.query('INSERT INTO core_navigation_menus(id,owner,channel,content) VALUES($1,$2,$3,$4)', [id, ownerKey(actor), actor.channel, JSON.stringify(fullMessage)]);
        attempted = true;
        const timestamp = await this.messenger.post(actor, message);
        await this.sql.query('UPDATE core_navigation_menus SET timestamp=$2 WHERE id=$1', [id, timestamp]);
      } else {
        // Preserve send-only adapters; production menus use post/update identities.
        attempted = true;
        await this.messenger.send(actor, message);
      }
    } catch (error) {
      if (!attempted || error instanceof SlackDeliveryRejected) {
        await this.sql.query('DELETE FROM core_navigation_deliveries WHERE event_id=$1 AND owner=$2', [eventId, ownerKey(actor)]);
        if (target && replaceContent) await this.sql.query('UPDATE core_navigation_menus SET content=$2 WHERE id=$1 AND owner=$3 AND channel=$4 AND timestamp=$5',
          [id, previousContent ? JSON.stringify(previousContent) : null, ownerKey(actor), actor.channel, target.timestamp]);
      }
      throw error;
    }
  }
}
