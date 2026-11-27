import { z } from 'zod';
import { parisTime, shiftMonth } from './calendar.js';

const mailboxAddress = z.email().toLowerCase();
const senderAddresses = z.array(mailboxAddress).min(1).max(10);
const providerConfig = z.object({
  name: z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N} .()&'_-]+$/u),
  senders: senderAddresses,
  subjectMatches: z.array(z.string().trim().min(3).max(100)).min(1).max(12),
});
export function readFacturesConfig(env: NodeJS.ProcessEnv) {
  const providers = env.FACTURES_PROVIDERS?.trim() ? z.array(providerConfig).min(1).max(40).parse(JSON.parse(env.FACTURES_PROVIDERS))
    : [{ name: 'Anthropic', senders: senderAddresses.parse(env.FACTURES_ANTHROPIC_SENDERS?.split(',').map(value => value.trim())),
      subjectMatches: ['your receipt from anthropic', 'invoice from anthropic', 'facture anthropic', 'anthropic invoice', 'anthropic receipt'] }];
  if (new Set(providers.map(provider => provider.name.toLowerCase())).size !== providers.length) throw new Error('Duplicate Factures provider.');
  return {
    mailbox: mailboxAddress.parse(env.FACTURES_GMAIL_ADDRESS?.trim() || 'production@mayasquad.com'),
    label: env.FACTURES_GMAIL_LABEL?.trim() || 'Factures outils',
    clientId: z.string().trim().min(1).parse(env.FACTURES_GOOGLE_CLIENT_ID),
    clientSecret: z.string().trim().min(1).parse(env.FACTURES_GOOGLE_CLIENT_SECRET),
    refreshToken: z.string().trim().min(1).parse(env.FACTURES_GOOGLE_REFRESH_TOKEN),
    providers,
    recipients: z.array(z.string().regex(/^[UW][A-Z0-9]+$/)).min(1).max(10)
      .parse(env.FACTURES_SLACK_USER_IDS?.split(',').map(value => value.trim())),
    monthly: z.enum(['true', 'false']).default('false').parse(env.FACTURES_MONTHLY_ENABLED || undefined) === 'true',
  };
}
export type FacturesConfig = ReturnType<typeof readFacturesConfig>;
type PdfPart = { size: number; data?: string; attachmentId?: string };
export type BillingEmail = { id: string; provider: string; date: Date; source: string; document: 'pdf' | 'portail' | 'à vérifier'; pdfs: PdfPart[] };
export type LabelledMailReader = {
  labelId: string;
  listMessages(params: URLSearchParams): Promise<unknown>;
  readMessage(id: string): Promise<unknown>;
};

type Part = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: Part[];
};
type Message = {
  id: string; internalDate: string; labelIds?: string[];
  payload: Part & { headers?: { name: string; value: string }[] };
};
const gmailId = z.string().regex(/^[a-z0-9]+$/i);
const listed = z.object({ messages: z.array(z.object({ id: gmailId })).default([]), nextPageToken: z.string().optional() });
const invoiceUrl = /https:\/\/(?:invoice\.stripe\.com\/i\/|pay\.stripe\.com\/invoice\/|billing\.stripe\.com\/p\/invoice\/)[a-z0-9_-]+/i;

function pdfParts(part: Part): PdfPart[] {
  const size = part.body?.size;
  if (part.filename && (part.mimeType === 'application/pdf' || /\.pdf$/i.test(part.filename)) &&
    size !== undefined && (part.body?.attachmentId || part.body?.data)) return [{ ...part.body, size }];
  return part.parts?.flatMap(pdfParts) ?? [];
}

function hasInvoiceLink(part: Part): boolean {
  const text = /^text\/(plain|html)$/i.test(part.mimeType ?? '') && part.body?.data
    ? Buffer.from(part.body.data.slice(0, 300_000), 'base64url').toString('utf8') : '';
  return invoiceUrl.test(text) || (part.parts?.some(hasInvoiceLink) ?? false);
}

export class MissingInvoiceLabel extends Error {}

export async function openBillingMailbox(config: FacturesConfig, fetcher: typeof fetch) {
  const tokenResponse = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: config.clientId, client_secret: config.clientSecret, refresh_token: config.refreshToken,
    }), signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) throw new Error('Factures Gmail authorization unavailable.');
  const token = z.object({ access_token: z.string().min(1) }).parse(await tokenResponse.json()).access_token;
  const get = async (path: string): Promise<unknown> => {
    const response = await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error('Factures Gmail request failed.');
    return response.json();
  };
  const profile = z.object({ emailAddress: mailboxAddress }).parse(await get('profile'));
  if (profile.emailAddress !== config.mailbox) throw new Error('Factures Gmail account differs from configured address.');
  const labels = z.object({ labels: z.array(z.object({ id: z.string(), name: z.string() })).default([]) }).parse(await get('labels'));
  const label = labels.labels.find(item => item.name === config.label);
  if (!label) throw new MissingInvoiceLabel('Factures Gmail label unavailable.');
  return {
    get, labelId: label.id,
    listMessages: (params: URLSearchParams) => get('messages?' + params),
    readMessage: (id: string) => get(`messages/${id}?format=full`),
  };
}

export async function findBillingEmails(config: { mailbox: string; providers?: FacturesConfig['providers'] },
  period: string, { listMessages, readMessage, labelId }: LabelledMailReader): Promise<BillingEmail[]> {
  const start = parisTime(period).getTime(), end = parisTime(shiftMonth(period, 1)).getTime();
  const addresses = [...new Set(config.providers?.flatMap(provider => provider.senders))];
  const ids = new Set<string>();
  for (let i = 0; i < Math.max(1, addresses.length); i += 20) {
    const from = addresses.slice(i, i + 20).map(sender => `from:${sender}`).join(' ');
    const q = `${from ? `{${from}} ` : ''}after:${start / 1000 - 1} before:${end / 1000}`;
    const params = new URLSearchParams({ q, maxResults: '100', labelIds: labelId });
    const seenPages = new Set<string>();
    for (;;) {
      const result = listed.parse(await listMessages(params));
      result.messages.forEach(entry => ids.add(entry.id));
      if (ids.size > 1000) throw new Error('Too many Factures Gmail results.');
      if (!result.nextPageToken) break;
      if (seenPages.has(result.nextPageToken) || seenPages.size >= 10) throw new Error('Factures Gmail page limit exceeded.');
      seenPages.add(result.nextPageToken);
      params.set('pageToken', result.nextPageToken);
    }
  }
  const messageIds = [...ids];
  const seen = new Set<string>();
  const emails: BillingEmail[] = [];
  for (let i = 0; i < messageIds.length; i += 8) {
    const batch = await Promise.all(messageIds.slice(i, i + 8).map(id => readMessage(id) as Promise<Message>));
    for (const message of batch) {
      const date = Number(message.internalDate);
      if (!Number.isFinite(date) || date < start || date >= end || !gmailId.safeParse(message.id).success || !message.labelIds?.includes(labelId)) continue;
      const header = (name: string) => message.payload.headers?.find(h => h.name.toLowerCase() === name)?.value.trim() ?? '';
      const address = header('from').replace(/^.*<([^<>]+)>$/, '$1').toLowerCase();
      const subject = header('subject').toLowerCase();
      const matches = config.providers?.filter(provider => provider.senders.includes(address) &&
        provider.subjectMatches.some(phrase => subject.includes(phrase.toLowerCase())));
      if (matches && matches.length !== 1) continue;
      const key = header('message-id') || message.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const pdfs = pdfParts(message.payload);
      emails.push({
        id: message.id, provider: matches?.[0]?.name ?? (mailboxAddress.safeParse(address).success ? address : 'Gmail'), date: new Date(date),
        pdfs, document: pdfs.length ? 'pdf' : hasInvoiceLink(message.payload) ? 'portail' : 'à vérifier',
        source: 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(config.mailbox) + '#all/' + message.id,
      });
    }
  }
  return emails.sort((a, b) => b.date.getTime() - a.date.getTime());
}

const maxPdfBytes = 10 * 1024 * 1024;
export async function readInvoicePdf(mailbox: Awaited<ReturnType<typeof openBillingMailbox>>, id: string, part: PdfPart) {
  if (!Number.isSafeInteger(part.size) || part.size < 5 || part.size > maxPdfBytes) return;
  const data = part.attachmentId
    ? z.object({ data: z.string() }).parse(await mailbox.get(`messages/${id}/attachments/${encodeURIComponent(part.attachmentId)}`)).data
    : part.data;
  if (!data || data.length > Math.ceil(maxPdfBytes * 4 / 3) + 4) return;
  const pdf = Buffer.from(data, 'base64url');
  if (pdf.length === part.size && pdf.subarray(0, 5).toString('ascii') === '%PDF-') return pdf;
}
