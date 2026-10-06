import { ownerKey, uid, type Actor } from './identity.js';
import { buttonDisplayLabel, sanitizeReply, SlackDeliveryRejected, type AgentMessage, type Button, type Messenger } from './slack.js';
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
// Slack determines the actual wrap from the client width. Budget for a compact
// desktop action row while keeping every choice reachable on narrower clients.
const ACTION_ROW_WIDTH = 90;
const ACTION_ROW_BUTTONS = 8;
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

export const needsControlPaging = (buttons: Button[] = []) => controlPages(buttons).pages.length > 1;

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

function visiblePage(message: AgentMessage, id: string, requestedControl = 0, requestedText = 0): AgentMessage {
  const textPages = splitText(message.text, !message.kind);
  const textPage = Math.max(0, Math.min(requestedText, textPages.length - 1));
  // The main menu is an inventory of enabled modules: keep every destination visible.
  const { pages, pinned } = message.kind === 'Menu'
    ? { pages: [message.buttons ?? []], pinned: [] as Button[] }
    : controlPages(message.buttons ?? [], textPages.length > 1);
  const controlPage = Math.max(0, Math.min(requestedControl, pages.length - 1));
  const pageButton = (label: string, nextControl: number, nextText: number) => ({ label, action: 'core:controls', value: `${id}|${nextControl}|${nextText}`, scope: 'core' as const });
  return { ...message, text: textPages.length > 1 ? `Réponse — page ${textPage + 1}/${textPages.length}\n${textPages[textPage]}` : message.text,
    ...(textPage && message.table ? { table: undefined } : {}),
    buttons: [...pages[controlPage]!, ...pinned,
      ...(controlPage ? [pageButton(previousActions, controlPage - 1, textPage)] : []),
      ...(controlPage + 1 < pages.length ? [pageButton(nextActions, controlPage + 1, textPage)] : []),
      ...(textPage ? [pageButton('Précédent', controlPage, textPage - 1)] : []),
      ...(textPage + 1 < textPages.length ? [pageButton('Suivant', controlPage, textPage + 1)] : [])] };
}

/** Recorded Agent messages can update only through owner- and message-bound controls. */
export class Navigation {
  constructor(private sql: Sql, private messenger: Messenger) {}

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
    if (!bound || !/^\d{1,4}\|\d{1,4}$/.test(bound.value)) return;
    const saved = (await this.sql.query('SELECT content FROM core_navigation_menus WHERE id=$1 AND owner=$2 AND channel=$3 AND timestamp=$4',
      [bound.target.id, ownerKey(actor), actor.channel, bound.target.timestamp])).rows[0]?.content as AgentMessage | undefined;
    if (!saved) return;
    const [controlPage, textPage] = bound.value.split('|').map(Number);
    return this.deliver(actor, eventId, bound.target.id, saved, bound.target, false, controlPage, textPage);
  }

  async show(actor: Actor, eventId: string, page: MenuPage, target?: MenuTarget) {
    const id = target?.id ?? uid();
    const { links = [], recordChoices = [], bindButtons = false, ...content } = page;
    const rowChoices = !!content.table && recordChoices.length === content.table.rows.length;
    const rawMessage: AgentMessage = { ...content,
      ...(rowChoices ? { table: { ...content.table!, rowButtons: recordChoices.map(link => ({ label: 'Ouvrir', action: 'core:navigate', value: `${id}|${link.page}` })) } } : {}),
      buttons: [...(content.buttons ?? []).map(button => bindButtons || button.bound ? { ...button, value: `${id}|${button.value}` } : button),
      ...(!rowChoices ? recordChoices.map(link => ({ label: link.label, action: 'core:navigate', value: `${id}|${link.page}` })) : []),
      ...links.map(link => ({ label: link.label, action: 'core:navigate', value: `${id}|${link.page}` }))] };
    const message = this.messenger.prepare?.(rawMessage) ?? rawMessage;
    return this.deliver(actor, eventId, id, message, target, true);
  }

  private async deliver(actor: Actor, eventId: string, id: string, fullMessage: AgentMessage, target?: MenuTarget,
    replaceContent = true, controlPage = 0, textPage = 0) {
    const message = visiblePage(fullMessage, id, controlPage, textPage);
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
