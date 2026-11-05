import { formatDate } from '../../core/presentation.js';
import { stateLabel } from './presentation.js';
import type { MenuPage } from '../../core/navigation.js';
import { escapeCardValue, type Button } from '../../core/slack.js';
import { availableRuleProposal, currentPreview, type UserState } from './domain.js';

const PAGE_SIZE = 6;
const back = [{ label: "Retour au tri des e-mails", page: 'main' }];

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
    const buttons: Button[] = [{ label: "Ajouter une règle", action: 'form_prepare', value: 'new', bound: true, style: 'primary' }, { label: "Modèles de règles", action: 'menu_starters', value: '' }];
    const rows = visible.map((rule, index) => {
      buttons.push({ label: `Modifier ${index + 1}`, action: 'form_prepare', value: rule.id, bound: true }, { label: `Retirer ${index + 1}`, action: 'menu_remove_rule', value: rule.id });
      const short = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit)}…` : value;
      return [String(index + 1), short(rule.name, 100), short(rule.condition, 500), stateLabel(rule.action),
        short(rule.labels.join(', '), 300) || 'aucun', short(rule.senders.join(', '), 360) || 'analyse du contenu'];
    });
    return { kind: "Gérer les règles", text: `Vos règles — page ${current + 1}/${pages}\nLes conditions, libellés et listes d’expéditeurs longs sont résumés.${!rows.length ? '\nAucune règle approuvée. Ajoutez une règle ou examinez les modèles.' : ''}`, buttons,
      ...(rows.length ? { table: { columns: ['N°', 'Règle', 'Condition', 'Action', 'Libellés', 'Expéditeurs'], rows } } : {}),
      links: [...(current > 0 ? [{ label: "Précédent", page: `rules-${current - 1}` }] : []), ...(current + 1 < pages ? [{ label: "Suivant", page: `rules-${current + 1}` }] : []), ...back],
    };
  }
  const pendingPage = /^pending-(\d{1,6})$/.exec(page);
  if (pendingPage) {
    const pages = Math.max(1, Math.ceil(pending.length / PAGE_SIZE));
    const current = Math.min(Number(pendingPage[1]), pages - 1);
    const visible = pending.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
    return { kind: "Approbations en attente", text: `Approbations en attente — page ${current + 1}/${pages}\n${!visible.length ? 'Aucune approbation en attente. Revenez au tri des e-mails pour gérer les règles ou demander un nouveau tri.\n' : ''}Ouvrir un élément enregistré ne prolonge pas sa validité.`,
      ...(visible.length ? { table: { columns: ['N°', 'Proposition', 'Créée le'], rows: visible.map((item, index) => [String(index + 1), item.label.slice(0, 300), formatDate(item.created)]) } } : {}),
      buttons: visible.map((item, index) => ({ label: `Ouvrir ${index + 1}`, action: item.action, value: item.id })),
      links: [...(current > 0 ? [{ label: "Précédent", page: `pending-${current - 1}` }] : []), ...(current + 1 < pages ? [{ label: "Suivant", page: `pending-${current + 1}` }] : []), ...back],
    };
  }
  return { kind: "Tri des e-mails", text: `${status}\nProchaine étape : ${!state.connection ? 'connectez Gmail.' : !state.rules.length ? 'ajoutez une règle ou examinez les modèles, puis approuvez la proposition.' : 'triez la boîte de réception pour préparer un aperçu.'}\nCommandes : courrier trier, courrier règles, courrier modèles, courrier rapport. Le tri prépare un aperçu ; les modifications de la boîte nécessitent une approbation séparée.`,
    buttons: [...(!state.connection ? [{ label: 'Connecter Gmail', action: 'menu_connect', value: '', style: 'primary' as const }] : !state.rules.length ? [{ label: 'Ajouter une règle', action: 'form_prepare', value: 'new', bound: true, style: 'primary' as const }, { label: 'Modèles de règles', action: 'menu_starters', value: '' }] : []), { label: "Trier la boîte de réception", action: 'sort_inbox', value: 'sort', bound: true, ...(state.connection && state.rules.length ? { style: 'primary' as const } : {}) }, { label: "Dernier rapport", action: 'menu_latest_report', value: '' }],
    links: [{ label: "Gérer les règles", page: 'rules-0' }, ...(pending.length ? [{ label: "Approbations en attente", page: 'pending-0' }] : []), { label: "Connexion Gmail", page: 'connection' }],
  };
}
