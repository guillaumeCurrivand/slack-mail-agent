import { expect, it } from 'vitest';
import { planMessage, starterRules, validateRule, type Rule } from '../src/modules/mail/domain.js';

const mail = { id: 'm', from: 'Alex <alex@example.com>', subject: 'Project', body: '', labels: ['INBOX'], historyId: '1' };
const project = (id: string): Rule => ({ id, name: id, category: 'project', kind: 'sender', condition: 'Sender is Alex', senders: ['alex@example.com'], labels: [`Projects/${id}`], action: 'keep', examples: ['Alex matches'] });
it('requires a decision when one sender matches several projects', () => {
  const plan = planMessage(mail, [project('Alpha'), project('Beta')], []);
  expect(plan.needsDecision).toBe(true);
});
it('allows several labels while keep-in-inbox overrides archive', () => {
  const first = project('Alpha'), second = { ...project('Client'), category: 'custom' as const, action: 'archive' as const };
  const plan = planMessage(mail, [first, second], []);
  expect(plan.labels).toEqual(['Projects/Alpha', 'Projects/Client']); expect(plan.disposition).toBe('keep'); expect(plan.needsDecision).toBe(false);
});
it('treats a custom Trash rule conflicting with a keep rule as unresolved', () => {
  const trash = { ...project('Trash'), category: 'custom' as const, action: 'trash' as const };
  expect(planMessage(mail, [project('Alpha'), trash], []).needsDecision).toBe(true);
});
it('does not classify an oversized message as a confident match', () => {
  const rule = { ...starterRules()[0]!, id: 'Urgent' };
  expect(planMessage({ ...mail, oversized: true }, [rule], [{ ruleId: 'Urgent', decision: 'yes', reason: 'partial' }]).needsDecision).toBe(true);
});
it('does not let a user-label name silently invoke a Gmail system action', () => {
  expect(() => validateRule({ ...project('Alpha'), labels: ['TRASH'] })).toThrow();
});
