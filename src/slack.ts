import type { Actor } from './domain.js';

export type Button = { label: string; action: string; value: string; style?: 'primary' | 'danger' };
export interface Messenger { send(actor: Actor, text: string, buttons?: Button[]): Promise<void> }
export const escapeSlack = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export class Slack implements Messenger {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  async send(actor: Actor, text: string, buttons: Button[] = []) {
    const blocks: any[] = [];
    // Plain-text blocks prevent model/email content from mentioning people or inventing links.
    for (let offset = 0; offset < text.length; offset += 2800) blocks.push({ type: 'section', text: { type: 'plain_text', text: text.slice(offset, offset + 2800) } });
    if (buttons.length) blocks.push({ type: 'actions', elements: buttons.map(b => ({ type: 'button', text: { type: 'plain_text', text: b.label.slice(0, 75) }, action_id: b.action, value: b.value, ...(b.style ? { style: b.style } : {}) })) });
    const response = await this.fetcher('https://slack.com/api/chat.postMessage', {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: actor.channel, text: escapeSlack(text.slice(0, 3500)), blocks: blocks.slice(0, 50), unfurl_links: false, unfurl_media: false, parse: 'none' }), signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok || !(await response.json() as any).ok) throw new Error('Slack delivery failed.');
  }
}
