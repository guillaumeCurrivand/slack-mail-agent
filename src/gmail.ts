import { convert } from 'html-to-text';
import type { Mail } from './domain.js';

export type Snapshot = { id: string; labels: string[]; historyId: string };
export type Mutation = { kind: 'labels' | 'trash' | 'untrash'; add?: string[]; remove?: string[] };
export interface Mailbox {
  list(): Promise<string[]>;
  read(id: string): Promise<Mail>;
  snapshot(id: string): Promise<Snapshot>;
  labels(): Promise<{ id: string; name: string }[]>;
  ensureLabel(name: string): Promise<string>;
  mutate(id: string, mutation: Mutation): Promise<Snapshot>;
}
export type Tokens = { access_token: string; refresh_token: string; expires_at: number };
export class Gmail implements Mailbox {
  constructor(private tokens: Tokens, private clientId: string, private clientSecret: string, private saveTokens: (tokens: Tokens) => Promise<void>, private fetcher: typeof fetch = fetch) {}
  private async token() {
    if (this.tokens.expires_at > Date.now() + 60_000) return this.tokens.access_token;
    const response = await this.fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.tokens.refresh_token, client_id: this.clientId, client_secret: this.clientSecret }), signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error('Gmail authorization expired or was revoked. Reconnect Gmail.');
    const value = await response.json() as any;
    if (typeof value.access_token !== 'string' || !Number.isFinite(value.expires_in)) throw new Error('Invalid Gmail authorization response');
    this.tokens = { ...this.tokens, access_token: value.access_token, expires_at: Date.now() + value.expires_in * 1000 };
    await this.saveTokens(this.tokens); return this.tokens.access_token;
  }
  private async request(path: string, method = 'GET', body?: unknown): Promise<any> {
    const response = await this.fetcher(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      method, headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    // Mutations are never silently retried: the workflow journals ambiguous outcomes.
    if (!response.ok) throw new Error(response.status === 404 ? 'Gmail message is no longer available.' : `Gmail request failed (${response.status}).`);
    return response.json();
  }
  async list(): Promise<string[]> {
    const result = await this.request('messages?labelIds=INBOX&maxResults=100');
    return (result.messages ?? []).map((x: any) => String(x.id)).slice(0, 100);
  }
  async read(id: string): Promise<Mail> { return parseMail(await this.request(`messages/${encodeURIComponent(id)}?format=full`)); }
  async snapshot(id: string) { return asSnapshot(await this.request(`messages/${encodeURIComponent(id)}?format=minimal`)); }
  async labels(): Promise<{ id: string; name: string }[]> {
    const result = await this.request('labels');
    return (result.labels ?? []).filter((x: any) => x.type === 'user').map((x: any) => ({ id: String(x.id), name: String(x.name) }));
  }
  async ensureLabel(name: string) {
    const existing = (await this.labels()).find(x => x.name === name);
    if (existing) return existing.id;
    const result = await this.request('labels', 'POST', { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
    return String(result.id);
  }
  async mutate(id: string, mutation: Mutation) {
    const path = `messages/${encodeURIComponent(id)}/${mutation.kind === 'labels' ? 'modify' : mutation.kind}`;
    return asSnapshot(await this.request(path, 'POST', mutation.kind === 'labels' ? { addLabelIds: mutation.add ?? [], removeLabelIds: mutation.remove ?? [] } : undefined));
  }
}
function asSnapshot(value: any): Snapshot {
  if (!value.id || !value.historyId || !Array.isArray(value.labelIds)) throw new Error('Gmail did not return a complete message state; outcome needs review.');
  return { id: String(value.id), labels: value.labelIds.map(String), historyId: String(value.historyId) };
}
function bodyText(part: any): string {
  if (!part || part.filename || part.body?.attachmentId) return '';
  if (part.mimeType === 'text/plain') return Buffer.from(part.body?.data ?? '', 'base64url').toString('utf8');
  if (part.mimeType === 'text/html') return convert(Buffer.from(part.body?.data ?? '', 'base64url').toString('utf8'), { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }] });
  if (part.mimeType === 'multipart/alternative') {
    const plain = part.parts?.find((p: any) => p.mimeType === 'text/plain' && !p.filename);
    return plain ? bodyText(plain) : (part.parts ?? []).map(bodyText).find(Boolean) ?? '';
  }
  return (part.parts ?? []).map(bodyText).filter(Boolean).join('\n');
}
export function parseMail(value: any): Mail {
  const headers = value.payload?.headers ?? [];
  const header = (name: string) => String(headers.find((x: any) => x.name.toLowerCase() === name)?.value ?? '');
  const body = bodyText(value.payload);
  return { ...asSnapshot(value), from: header('from').slice(0, 1000), subject: header('subject').slice(0, 1000), body, oversized: Buffer.byteLength(body) > 60_000 || (!body && (value.sizeEstimate ?? 0) > 60_000) };
}
