import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { formatDate } from '../../core/presentation.js';
import { escapeCardValue, type AgentMessage } from '../../core/slack.js';

const envelope = z.object({
  event_id: z.uuid(), event_name: z.string().min(1).max(150),
  event_time: z.union([z.string().regex(/^\d{1,12}$/), z.number().int().nonnegative()]),
  subscription_id: z.string().min(1).max(128), sandbox: z.boolean(), data: z.record(z.string(), z.unknown()),
});
export type EventSummary = { id: string; name: string; time: string; request?: string; resource?: string; signer?: string };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const name = (value: unknown) => typeof value === 'string' && value.trim() ? value.replace(/[\r\n\t\u0000-\u001f]/g, ' ').slice(0, 250).trim() : undefined;
const identifier = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;

export function verifyYousign(raw: string, signature: unknown, secret: string) {
  if (typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

/** The raw payload is discarded after extracting only approved display fields. */
export function parseEvent(raw: string, subscription: string, sandbox: boolean): EventSummary {
  const event = envelope.parse(JSON.parse(raw));
  if (event.subscription_id !== subscription || event.sandbox !== sandbox) throw new Error('Unexpected webhook source.');
  const date = new Date(Number(event.event_time) * 1000);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid event time.');
  const request = object(event.data.signature_request), signer = object(object(event.data.signer).info);
  const resource = identifier(request.id) ?? Object.values(event.data).map(value => identifier(object(value).id)).find(Boolean);
  const signerName = [name(signer.first_name), name(signer.last_name)].filter(Boolean).join(' ');
  return { id: event.event_id, name: event.event_name, time: date.toISOString(),
    ...(name(request.name) ? { request: name(request.name) } : {}), ...(resource ? { resource } : {}), ...(signerName ? { signer: signerName } : {}) };
}

export function notification(event: EventSummary): AgentMessage {
  const labels: Record<string, string> = {
    'signature_request.activated': 'Demande de signature activée', 'signature_request.done': 'Demande de signature terminée',
    'signature_request.declined': 'Demande de signature refusée', 'signature_request.expired': 'Demande de signature expirée',
    'signature_request.canceled': 'Demande de signature annulée', 'signature_request.deleted': 'Demande de signature supprimée',
    'signature_request.permanently_deleted': 'Demande de signature supprimée définitivement',
    'signer.done': 'Signature réalisée', 'signer.declined': 'Signature refusée', 'signer.link_opened': 'Lien de signature ouvert',
    'approver.approved': 'Demande approuvée', 'approver.rejected': 'Demande rejetée',
  };
  return { kind: 'Notification Yousign', text: [labels[event.name] ?? `Événement Yousign : ${escapeCardValue(event.name)}`,
    event.request ? `Demande : ${escapeCardValue(event.request)}` : event.resource ? `Identifiant : ${escapeCardValue(event.resource)}` : '',
    event.signer ? `Signataire : ${escapeCardValue(event.signer)}` : '', formatDate(event.time)].filter(Boolean).join('\n') };
}
