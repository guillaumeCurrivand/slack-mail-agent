import type { Actor } from '../../core/identity.js';
export { ownerKey, uid, type Actor } from '../../core/identity.js';
import { z } from 'zod';

export const labelSchema = z.string().min(1).max(100).refine(v => !/[\x00-\x1f]/.test(v) && !/^(INBOX|TRASH|SPAM|UNREAD|STARRED|IMPORTANT|SENT|DRAFT|CATEGORY_.*)$/i.test(v), "Utilisez un libellé Gmail personnalisé");
export const ruleSchema = z.object({
  name: z.string().min(1).max(100), category: z.enum(['urgent', 'project', 'newsletter', 'custom']),
  kind: z.enum(['sender', 'semantic']), condition: z.string().min(1).max(1200),
  senders: z.array(z.email()).max(100), labels: z.array(labelSchema).max(10),
  action: z.enum(['label', 'keep', 'archive', 'trash']), examples: z.array(z.string().max(300)).min(1).max(3),
});
export type RuleInput = z.infer<typeof ruleSchema>;
export type Rule = RuleInput & { id: string };
export type Mail = { id: string; from: string; subject: string; body: string; labels: string[]; historyId: string; oversized?: boolean };
export type Match = { ruleId: string; decision: 'yes' | 'no' | 'uncertain'; reason: string };
export type Plan = { labels: string[]; removeLabels?: string[]; disposition: 'keep' | 'archive' | 'trash'; needsDecision: boolean; reasons: string[] };
export type Item = {
  id: string; from: string; subject: string; before: string[]; historyId: string; plan: Plan;
  status: 'pending' | 'skipped' | 'prepared' | 'applied' | 'conflict' | 'unknown' | 'undo_prepared' | 'undone';
  add?: string[]; remove?: string[]; after?: string[]; afterHistory?: string; note?: string;
};
export type Run = { id: string; created: string; ruleVersion: number; connectionId: string; status: 'scanning' | 'preview' | 'applying' | 'done' | 'undoing' | 'undone' | 'cancelled'; items: Item[]; language?: 'fr'; correction?: boolean; sourceId?: string; messageIds?: string[]; newLabels?: string[] };
export type Connection = { id: string; subject: string; email: string; encryptedTokens: string };
export type Draft = { id: string; created: string; kind: 'rules' | 'delete' | 'connection'; language?: 'fr'; rules?: RuleInput[]; replaceId?: string; ruleId?: string; connection?: Connection };
export type UserState = { rules: Rule[]; ruleVersion: number; drafts: Draft[]; runs: Run[]; history: { role: 'user' | 'assistant'; content: string; at: string }[]; connection?: Connection; handled: string[] };
export const emptyState = (): UserState => ({ rules: [], ruleVersion: 0, drafts: [], runs: [], history: [], handled: [] });
export const currentPreview = (state: UserState, run: Run, now = Date.now()) =>
  run.connectionId === state.connection?.id && run.ruleVersion === state.ruleVersion && Date.parse(run.created) >= now - 86400_000;
export const availableRuleProposal = (state: UserState, draft: Draft, now = Date.now()) =>
  draft.kind !== 'connection' && Date.parse(draft.created) > now - 86400_000 &&
  (!(draft.replaceId || draft.kind === 'delete') || state.rules.some(rule => rule.id === (draft.replaceId ?? draft.ruleId)));
export const sameLabels = (a: string[], b: string[]) => [...a].sort().join('\0') === [...b].sort().join('\0');
export const senderAddress = (from: string) => (from.match(/<([^<>]+)>/)?.[1] ?? from).trim().toLowerCase();

export function validateRule(value: unknown): RuleInput {
  const rule = ruleSchema.parse(value);
  if (rule.kind === 'sender' && !rule.senders.length) throw new Error("Une règle d’expéditeur nécessite au moins une adresse e-mail.");
  if (rule.kind === 'semantic' && rule.senders.length) throw new Error("Ajoutez les conditions d’expéditeur dans la description ou utilisez une règle d’expéditeur.");
  return rule;
}

export function planMessage(mail: Mail, rules: Rule[], semantic: Match[]): Plan {
  const matches = rules.map(rule => rule.kind === 'sender'
    ? { ruleId: rule.id, decision: (rule.senders.map(s => s.toLowerCase()).includes(senderAddress(mail.from)) ? 'yes' : 'no') as Match['decision'], reason: "Correspondance exacte de l’expéditeur" }
    : semantic.find(m => m.ruleId === rule.id) ?? { ruleId: rule.id, decision: 'uncertain' as const, reason: "Aucune classification disponible" });
  // Uncertain matches contribute a candidate action, never automatic permission.
  // The preview remains excluded until the owner explicitly accepts that candidate.
  const chosen = rules.filter(r => matches.some(m => m.ruleId === r.id && m.decision !== 'no'));
  const ambiguousProjects = chosen.filter(r => r.category === 'project').length > 1;
  const protectedMail = chosen.some(r => r.category === 'urgent' || r.category === 'project' || r.action === 'keep');
  const archive = chosen.some(r => r.action === 'archive');
  const trash = chosen.some(r => r.action === 'trash' && !(r.category === 'newsletter' && protectedMail));
  const conflicting = trash && chosen.some(r => r.action === 'keep');
  const uncertain = Boolean(mail.oversized) || ambiguousProjects || conflicting || matches.some(m => m.decision === 'uncertain');
  return {
    labels: [...new Set(chosen.flatMap(r => r.labels))],
    disposition: trash ? 'trash' : archive && !chosen.some(r => r.action === 'keep') ? 'archive' : 'keep',
    needsDecision: uncertain,
    reasons: [...matches.filter(m => m.decision !== 'no').map(m => `${rules.find(r => r.id === m.ruleId)?.name}: ${m.reason}`),
      ...(ambiguousProjects ? ["Plusieurs associations de projets correspondent ; choisissez le projet."] : []),
      ...(conflicting ? ["Les règles de conservation et de mise à la corbeille sont contradictoires."] : []),
      ...(mail.oversized ? ["Le message est trop long pour une classification complète."] : [])],
  };
}

export function starterRules(): RuleInput[] {
  return [
    { name: 'Urgent', kind: 'semantic', category: 'urgent', condition: "Nécessite une attention ou une action rapide du destinataire. L’urgence commerciale seule ne suffit pas.", senders: [], labels: ['Urgent'], action: 'keep', examples: ["Un client attend une réponse aujourd’hui → Urgent, conserver dans la boîte de réception.", "Une promotion annonce une dernière chance → cela ne suffit pas à la rendre urgente."] },
    { name: "Lettres d’information", kind: 'semantic', category: 'newsletter', condition: "Lettre d’information promotionnelle ou récapitulatif récurrent. Exclure reçus, factures, alertes de sécurité, notifications transactionnelles, messages urgents et liés aux projets.", senders: [], labels: [], action: 'trash', examples: ["Un récapitulatif promotionnel récurrent → proposer la corbeille.", "Une facture ou une alerte de mot de passe → ne pas modifier."] },
  ];
}
