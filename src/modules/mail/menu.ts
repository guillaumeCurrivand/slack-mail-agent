import { formatDate } from '../../core/presentation.js';
import { stateLabel } from './presentation.js';
import type { MenuPage } from '../../core/navigation.js';
import { escapeCardValue, type Button } from '../../core/slack.js';
import { availableRuleProposal, currentPreview, type UserState } from './domain.js';

const PAGE_SIZE = 3;
const back = [{ label: "Retour au tri des e-mails", page: 'main' }];
const summary = (text: string, limit: number) => escapeCardValue(text.length > limit ? `${text.slice(0, limit)}…` : text);

/** Read-only projection of current, owner-scoped mail state. */
export function mailMenu(state: UserState, page: string): MenuPage {
  const pending = [
    ...state.drafts.filter(draft => availableRuleProposal(state, draft)).map(draft => ({ id: draft.id, action: 'reopen_draft', created: draft.created,
      label: draft.kind === 'delete' ? `Supprimer la règle ${state.rules.find(rule => rule.id === draft.ruleId)?.name}` : `${draft.replaceId ? "Modifier" : "Ajouter"} les règles : ${draft.rules?.map(rule => rule.name).join(', ')}` })),
    ...state.runs.filter(run => run.status === 'preview' && currentPreview(state, run)).map(run => ({ id: run.id, action: 'reopen_preview', created: run.created, label: `Aperçu du tri — ${run.items.length} messages` })),
  ].sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  const status = state.connection ? `Gmail connecté : ${escapeCardValue(state.connection.email)}.` : "Gmail n’est pas connecté. Le tri nécessite une boîte e-mail connectée.";
  if (page === 'connection') return { kind: "Connexion Gmail", text: `${status}\nConnectez uniquement votre propre boîte Google Workspace. La connexion Google s’ouvre hors de Slack. La déconnexion nécessite une confirmation séparée et conserve les règles enregistrées.`,
    buttons: state.connection ? [{ label: "Déconnecter Gmail", action: 'menu_disconnect', value: state.connection.id }]
      : [{ label: "Connecter Gmail", action: 'menu_connect', value: '', style: 'primary' }], links: back,
  };
  const rulesPage = /^rules-(\d{1,6})$/.exec(page);
  if (rulesPage) {
    const pages = Math.max(1, Math.ceil(state.rules.length / PAGE_SIZE));
    const current = Math.min(Number(rulesPage[1]), pages - 1);
    const visible = state.rules.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
    const buttons: Button[] = [{ label: "Ajouter une règle", action: 'menu_add_rule', value: '', style: 'primary' }, { label: "Modèles de règles", action: 'menu_starters', value: '' }];
    const descriptions = visible.map((rule, index) => {
      buttons.push({ label: `Modifier ${index + 1}`, action: 'menu_edit_rule', value: rule.id }, { label: `Retirer ${index + 1}`, action: 'menu_remove_rule', value: rule.id });
      return `${index + 1}. ${summary(rule.name, 100)} [${summary(rule.id, 100)}]\n${summary(rule.condition, 500)}\nAction : ${stateLabel(rule.action)} ; libellés : ${rule.labels.slice(0, 3).map(label => summary(label, 100)).join(', ') || 'aucun'}${rule.labels.length > 3 ? ` (+${rule.labels.length - 3} de plus)` : ''}\nExpéditeurs : ${rule.senders.slice(0, 3).map(sender => summary(sender, 120)).join(', ') || "analyse du contenu"}${rule.senders.length > 3 ? ` (+${rule.senders.length - 3} de plus)` : ''}`;
    });
    return { kind: "Gérer les règles", text: `Vos règles — page ${current + 1}/${pages}\nLes conditions, libellés et listes d’expéditeurs longs sont résumés.\n\n${descriptions.join('\n\n') || "Aucune règle approuvée. Ajoutez une règle ou examinez les modèles."}`, buttons,
      links: [...(current > 0 ? [{ label: "Précédent", page: `rules-${current - 1}` }] : []), ...(current + 1 < pages ? [{ label: "Suivant", page: `rules-${current + 1}` }] : []), ...back],
    };
  }
  const pendingPage = /^pending-(\d{1,6})$/.exec(page);
  if (pendingPage) {
    const pages = Math.max(1, Math.ceil(pending.length / PAGE_SIZE));
    const current = Math.min(Number(pendingPage[1]), pages - 1);
    const visible = pending.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
    return { kind: "Approbations en attente", text: `Approbations en attente — page ${current + 1}/${pages}\n\n${visible.map((item, index) => `${index + 1}. ${escapeCardValue(item.label.slice(0, 300))}\n${escapeCardValue(item.id)} · ${escapeCardValue(formatDate(item.created))}`).join('\n\n') || "Aucune approbation en attente. Revenez au tri des e-mails pour gérer les règles ou demander un nouveau tri."}\nOuvrir un élément enregistré ne prolonge pas sa validité.`,
      buttons: visible.map((item, index) => ({ label: `Ouvrir ${index + 1}`, action: item.action, value: item.id })),
      links: [...(current > 0 ? [{ label: "Précédent", page: `pending-${current - 1}` }] : []), ...(current + 1 < pages ? [{ label: "Suivant", page: `pending-${current + 1}` }] : []), ...back],
    };
  }
  return { kind: "Tri des e-mails", text: `${status}\nCommandes : courrier trier, courrier règles, courrier modèles, courrier rapport. Décrivez vos règles avec le préfixe courrier. Le tri prépare un aperçu ; les modifications de la boîte nécessitent une approbation séparée.`,
    buttons: [{ label: "Trier la boîte de réception", action: 'sort_inbox', value: 'sort', bound: true, style: 'primary' }, { label: "Dernier rapport", action: 'menu_latest_report', value: '' }],
    links: [{ label: "Gérer les règles", page: 'rules-0' }, ...(pending.length ? [{ label: "Approbations en attente", page: 'pending-0' }] : []), { label: "Connexion Gmail", page: 'connection' }],
  };
}
