import type { MenuPage } from '../../core/navigation.js';
import { escapeCardValue, type Button } from '../../core/slack.js';
import { availableRuleProposal, currentPreview, type UserState } from './domain.js';

const PAGE_SIZE = 3;
const back = [{ label: 'Back to Mail Sorter', page: 'main' }];
const summary = (text: string, limit: number) => escapeCardValue(text.length > limit ? `${text.slice(0, limit)}…` : text);

/** Read-only projection of current, owner-scoped mail state. */
export function mailMenu(state: UserState, page: string): MenuPage {
  const pending = [
    ...state.drafts.filter(draft => availableRuleProposal(state, draft)).map(draft => ({ id: draft.id, action: 'reopen_draft', created: draft.created,
      label: draft.kind === 'delete' ? `Remove rule ${state.rules.find(rule => rule.id === draft.ruleId)?.name}` : `${draft.replaceId ? 'Edit' : 'Add'} rules: ${draft.rules?.map(rule => rule.name).join(', ')}` })),
    ...state.runs.filter(run => run.status === 'preview' && currentPreview(state, run)).map(run => ({ id: run.id, action: 'reopen_preview', created: run.created, label: `Sorting Preview — ${run.items.length} messages` })),
  ].sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  const status = state.connection ? `Connected Gmail: ${escapeCardValue(state.connection.email)}.` : 'Gmail is not connected. Sorting requires a connected mailbox.';
  if (page === 'connection') return { kind: 'Gmail connection', text: `${status}\nConnect only your own Google Workspace mailbox. Google sign-in opens outside Slack. Disconnect requires a separate confirmation and keeps saved rules.`,
    buttons: state.connection ? [{ label: 'Disconnect Gmail', action: 'menu_disconnect', value: state.connection.id }]
      : [{ label: 'Connect Gmail', action: 'menu_connect', value: '' }], links: back,
  };
  const rulesPage = /^rules-(\d{1,6})$/.exec(page);
  if (rulesPage) {
    const pages = Math.max(1, Math.ceil(state.rules.length / PAGE_SIZE));
    const current = Math.min(Number(rulesPage[1]), pages - 1);
    const visible = state.rules.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
    const buttons: Button[] = [{ label: 'Add rule', action: 'menu_add_rule', value: '' }, { label: 'Starter rules', action: 'menu_starters', value: '' }];
    const descriptions = visible.map((rule, index) => {
      buttons.push({ label: `Edit ${index + 1}`, action: 'menu_edit_rule', value: rule.id }, { label: `Remove ${index + 1}`, action: 'menu_remove_rule', value: rule.id });
      return `${index + 1}. ${summary(rule.name, 100)} [${summary(rule.id, 100)}]\n${summary(rule.condition, 500)}\nAction: ${rule.action}; labels: ${rule.labels.slice(0, 3).map(label => summary(label, 100)).join(', ') || 'none'}${rule.labels.length > 3 ? ` (+${rule.labels.length - 3} more)` : ''}\nSenders: ${rule.senders.slice(0, 3).map(sender => summary(sender, 120)).join(', ') || 'semantic matching'}${rule.senders.length > 3 ? ` (+${rule.senders.length - 3} more)` : ''}`;
    });
    return { kind: 'Manage rules', text: `Your rules — page ${current + 1}/${pages}\nLong conditions, labels and sender lists are summarized.\n\n${descriptions.join('\n\n') || 'No approved rules. Add a rule or review starter rules.'}`, buttons,
      links: [...(current > 0 ? [{ label: 'Previous', page: `rules-${current - 1}` }] : []), ...(current + 1 < pages ? [{ label: 'Next', page: `rules-${current + 1}` }] : []), ...back],
    };
  }
  const pendingPage = /^pending-(\d{1,6})$/.exec(page);
  if (pendingPage) {
    const pages = Math.max(1, Math.ceil(pending.length / PAGE_SIZE));
    const current = Math.min(Number(pendingPage[1]), pages - 1);
    const visible = pending.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
    return { kind: 'Pending approvals', text: `Pending approvals — page ${current + 1}/${pages}\n\n${visible.map((item, index) => `${index + 1}. ${escapeCardValue(item.label.slice(0, 300))}\n${escapeCardValue(item.id)} · ${escapeCardValue(item.created)}`).join('\n\n') || 'No pending approvals. Return to Mail Sorter to manage rules or request a new sort.'}\nOpening a saved item does not extend its validity.`,
      buttons: visible.map((item, index) => ({ label: `Open ${index + 1}`, action: item.action, value: item.id })),
      links: [...(current > 0 ? [{ label: 'Previous', page: `pending-${current - 1}` }] : []), ...(current + 1 < pages ? [{ label: 'Next', page: `pending-${current + 1}` }] : []), ...back],
    };
  }
  return { kind: 'Mail Sorter', text: `${status}\nCommands: mail sort, mail rules, mail starters, mail report. Describe rules with the mail prefix. Sorting prepares a preview; mailbox changes require separate approval.`,
    buttons: [{ label: 'Latest report', action: 'menu_latest_report', value: '' }],
    links: [{ label: 'Manage rules', page: 'rules-0' }, ...(pending.length ? [{ label: 'Pending approvals', page: 'pending-0' }] : []), { label: 'Gmail connection', page: 'connection' }],
  };
}
