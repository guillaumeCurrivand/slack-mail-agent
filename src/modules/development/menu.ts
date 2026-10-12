import { createHash } from 'node:crypto';
import type { Actor } from '../../core/identity.js';
import type { JobPayload, ModuleContext } from '../../core/modules.js';
import { Navigation, type MenuPage } from '../../core/navigation.js';
import { formatDate } from '../../core/presentation.js';
import { menuButton } from '../../core/slack.js';
import { canRetry, commitLink, type Project } from './domain.js';
import type { ClickupDevelopment } from './providers.js';
import type { DevelopmentStore } from './store.js';

const pageSize = 8;
const labels: Record<string, string> = { queued: 'En attente du worker', running: 'En cours', reporting: 'Publication en cours', reporting_error: 'Publication à vérifier', blocked: 'Bloqué', completed: 'Terminé' };
export const projectPage = (id: string) => `project_${id}`;
// Fixed-size selectors keep long legacy run identifiers below Slack's control limit.
const runPage = (id: string) => `run_${createHash('sha256').update(id).digest('hex')}`;
const back = [{ label: 'Retour aux projets', page: 'projects_0' }];
const unavailable: MenuPage = { kind: 'Développement indisponible', text: 'Ce projet ou traitement est inaccessible. Revenez aux projets ou envoyez menu.', links: back };
const configureButton = { label: 'Configurer un projet', action: 'configuration_prepare', value: 'new', bound: true };

/** Module-owned browsing and confirmations; core owns message identity and delivery. */
export class DevelopmentMenu {
  constructor(private store: DevelopmentStore, private visible: (actor: Actor, project: Project) => Promise<boolean>, private clickup: ClickupDevelopment) {}

  private async accessible(actor: Actor, project: Project | undefined) {
    if (!project) return false;
    try { return await this.visible(actor, project); } catch { return false; }
  }

  async page(actor: Actor, page: string): Promise<MenuPage> {
    if (page === 'main') return { kind: 'Développement', text: 'Suivez vos projets et leurs tickets de maintenance. Pour un dossier partagé, choisissez un ou plusieurs dépôts dans Tickets et dépôts avant l’analyse. Ready for AI dans ClickUp autorise la correction dans les dépôts choisis. Les appels Cursor sont facturés séparément.',
      links: [{ label: 'Projets et traitements', page: 'projects_0' }, { label: 'Tickets et dépôts', page: 'routes_0' }, { label: 'Aide du module', page: 'help' }], buttons: [configureButton] };
    if (page === 'configure') return this.configuration();
    const list = /^projects_(\d{1,6})$/.exec(page);
    if (list) {
      const projects: Project[] = [];
      for (const project of await this.store.projects()) if (await this.accessible(actor, project)) projects.push(project);
      const index = Math.min(Number(list[1]), Math.max(0, Math.ceil(projects.length / pageSize) - 1));
      const rows = projects.slice(index * pageSize, (index + 1) * pageSize);
      return { kind: 'Projets de développement', text: rows.length ? `Page ${index + 1} — choisissez un projet pour consulter ses traitements.\n${rows.map(p => `${p.id} — ${p.name} — ${p.enabled ? 'activé' : 'suspendu'}`).join('\n')}` : 'Aucun projet accessible. Vous et le bot devez être membres du canal du projet. Configurez un projet ou vérifiez les accès Slack.',
        links: [...rows.map(p => ({ label: p.name, page: projectPage(p.id) })),
          ...(index ? [{ label: 'Précédent', page: `projects_${index - 1}` }] : []),
          ...((index + 1) * pageSize < projects.length ? [{ label: 'Suivant', page: `projects_${index + 1}` }] : []),
          { label: 'Actualiser', page: `projects_${index}` }], buttons: [configureButton] };
    }
    const projectMatch = /^(project|configure|history)_([a-z][a-z0-9-]{0,63})(?:_(\d{1,6}))?$/.exec(page);
    if (projectMatch) {
      const project = await this.store.project(projectMatch[2]!);
      if (!project || !await this.accessible(actor, project)) return unavailable;
      if (projectMatch[1] === 'configure') return this.configuration(project);
      if (projectMatch[1] === 'history') return this.history(actor, project, Number(projectMatch[3] ?? 0));
      const health = (await this.store.db.query('SELECT issue,checked_at FROM development_health WHERE team=$1 AND project=$2', [actor.team, project.id])).rows[0];
      return { kind: `Projet — ${project.name}`, text: `${project.enabled ? 'Activé' : 'Suspendu'}\nIdentifiant : ${project.id}\nCanal : ${project.channel}\nDossier ClickUp : ${project.folder}\nSkill : ${project.skill}\n${health ? `Dernière vérification ClickUp : ${formatDate(health.checked_at)}\n${health.issue ?? 'Aucun problème signalé à cette vérification.'}` : 'Aucune vérification ClickUp enregistrée.'}\n\nOuvrez le canal pour partager un lien de ticket. Dans un traitement, ouvrez le ticket pour sélectionner Ready for AI. Le worker doit être connecté ; cet écran ne mesure pas sa disponibilité.`,
        resourceLinks: [{ label: 'Ouvrir le canal Slack', url: `https://app.slack.com/client/${actor.team}/${project.channel}` }, { label: 'Dépôt', url: project.repository }],
        links: [{ label: 'Voir les traitements', page: `history_${project.id}_0` }, { label: 'Actualiser', page }, ...back],
        buttons: [{ label: 'Modifier la configuration', action: 'configuration_prepare', value: `project:${project.id}`, bound: true }, { label: project.enabled ? 'Suspendre le projet' : 'Réactiver le projet', action: 'propose_state', value: project.id, bound: true }] };
    }
    const runMatch = /^run_([a-f0-9]{64})$/.exec(page);
    if (runMatch) {
      const run = await this.store.runByPage(runMatch[1]!);
      const project = run && await this.store.project(run.project);
      if (!run || !project || !await this.accessible(actor, project) || !await this.accessible(actor, run.config)) return unavailable;
      const result = run.result;
      return { kind: `${run.kind === 'build' ? 'Correction' : 'Analyse'} — ${run.ticket.name}`, text: `Projet : ${project.name}\nTraitement : ${run.id}\nÉtat : ${labels[run.state] ?? run.state}\nEssais : ${run.attempts}/2\nMis à jour : ${formatDate(run.updated_at)}\n\n${result?.summary ?? 'Le worker local prendra en charge la demande. Aucun résultat enregistré.'}${result?.tests.length ? `\n\nVérifications :\n${result.tests.join('\n')}` : ''}${result?.commit ? `\n\nCommit : ${result.commit}\nBranche : ${result.branch ?? 'maintenance'}` : ''}\n\n${run.state === 'reporting_error' ? 'Vérifiez les publications ClickUp/Slack avant toute relance. Un commit déjà poussé reste sur sa branche ; une relance lance du nouveau travail.' : result?.outcome === 'actionable' ? 'Ouvrez le ticket et sélectionnez Ready for AI pour autoriser la correction.' : result?.outcome === 'pushed' ? 'Créez le PR/MR, faites relire, fusionnez et déployez selon votre procédure.' : run.state === 'blocked' ? 'Corrigez le blocage avant de relancer. La relance conserve les exigences figées ; pour les changer, faites observer un autre statut puis Ready for AI.' : 'Actualiser relit uniquement le suivi enregistré.'}`,
        resourceLinks: [{ label: 'Ouvrir le ticket ClickUp', url: run.ticket.url }, ...(result?.commit ? [{ label: 'Ouvrir le commit', url: commitLink(run.config.repository, result.commit) }] : [])],
        links: [{ label: 'Actualiser', page }, { label: 'Retour aux traitements', page: `history_${project.id}_0` }, { label: 'Retour au projet', page: projectPage(project.id) }],
        buttons: project.enabled && canRetry(run) ? [{ label: 'Relancer…', action: 'propose_retry', value: runPage(run.id).slice(4), bound: true }] : [] };
    }
    return unavailable;
  }

  private configuration(project?: Project): MenuPage {
    return { kind: project ? `Configuration — ${project.name}` : 'Configurer un projet',
      text: 'Configurez le projet dans un formulaire Slack : nom, dossier ClickUp, dépôt, skill et activation. Le canal est celui où vous avez ouvert le menu. Après validation des accès, confirmez les valeurs dans le fil du canal. Un nouveau projet commence suspendu par défaut. Le worker doit disposer de la configuration locale correspondante.',
      buttons: [{ label: 'Préparer le formulaire', action: 'configuration_prepare', value: project ? `project:${project.id}` : 'new', bound: true }],
      links: project ? [{ label: 'Retour au projet', page: projectPage(project.id) }] : back };
  }

  private async history(actor: Actor, project: Project, index: number): Promise<MenuPage> {
    const found = await this.store.historyPage(project.id, index, pageSize), rows = [];
    // Reuse only this page's access checks, including the current project check above.
    const access = new Map([[project.channel, true]]);
    for (const run of found.slice(0, pageSize)) {
      if (!access.has(run.config.channel)) access.set(run.config.channel, await this.accessible(actor, run.config));
      if (access.get(run.config.channel)) rows.push(run);
    }
    return { kind: `Traitements — ${project.name}`, text: `Page ${index + 1}. ${rows.length ? 'Ouvrez un traitement pour voir le résultat, les vérifications et les actions disponibles.' : 'Aucun traitement sur cette page.'}`,
      ...(rows.length ? { table: { columns: ['Ticket', 'Type', 'État', 'Essais'], rows: rows.map(run => [run.ticket.name.length > 300 ? `${run.ticket.name.slice(0, 299)}…` : run.ticket.name, run.kind === 'build' ? 'Correction' : 'Analyse', labels[run.state] ?? run.state, `${run.attempts}/2`]) },
        recordChoices: rows.map(run => ({ label: run.ticket.name, page: runPage(run.id) })) } : {}),
      links: [...(index ? [{ label: 'Précédent', page: `history_${project.id}_${index - 1}` }] : []), ...(found.length > pageSize ? [{ label: 'Suivant', page: `history_${project.id}_${index + 1}` }] : []),
        { label: 'Actualiser', page: `history_${project.id}_${index}` }, { label: 'Retour au projet', page: projectPage(project.id) }, ...back] };
  }

  async show(actor: Actor, eventId: string, context: ModuleContext, page: MenuPage, target?: Parameters<Navigation['show']>[3]) {
    const channel = /^[CG]/.test(actor.channel);
    return new Navigation(context.sql, context.messenger, channel ? 'development' : 'core').show(actor, eventId, { ...page,
      links: [...(page.links ?? []).map(link => ({ ...link, page: channel ? link.page : `development:${link.page}` })), { label: 'Aide du module', page: channel ? 'help' : 'help:module_development' }],
      recordChoices: page.recordChoices?.map(link => ({ ...link, page: channel ? link.page : `development:${link.page}` })), buttons: [...page.buttons ?? [], channel ? { label: 'Retour au menu', action: 'channel_home', value: 'main' } : menuButton] }, target);
  }

  async handle(actor: Actor, payload: JobPayload, eventId: string, context: ModuleContext) {
    const bound = payload.type === 'menu_action' && await new Navigation(context.sql, context.messenger).boundTarget(actor, payload.value, payload.timestamp);
    if (!bound) return this.show(actor, eventId, context, unavailable);
    const value = bound.value, action = payload.action;
    if (action === 'confirm' || action === 'cancel') {
      const proposal = await this.store.confirmation(actor, value);
      const project = proposal && await this.store.project(proposal.project.id);
      if (!proposal || !await this.accessible(actor, project) || !await this.accessible(actor, proposal.project)) return this.show(actor, eventId, context, unavailable);
      const run = proposal.run_id ? await this.store.run(proposal.run_id) : undefined;
      if (run && !await this.accessible(actor, run.config)) return this.show(actor, eventId, context, unavailable);
      let ticket;
      if (action === 'confirm' && proposal.state === 'pending' && run?.result?.outcome === 'pushed') {
        try { ticket = await this.clickup.ticket(project!, run.ticket.id); }
        catch { return this.show(actor, eventId, context, { kind: 'Relance indisponible', text: 'Lecture ClickUp indisponible. Aucune relance enregistrée. Réessayez la confirmation après rétablissement des accès.', links: back }); }
      }
      const state = await this.store.confirm(actor, value, action === 'cancel', ticket);
      return this.show(actor, eventId, context, { kind: 'Développement — confirmation', text: state === 'applied' ? proposal.operation === 'retry' ? 'Relance enregistrée. Cette confirmation ne peut créer qu’un seul traitement.' : proposal.operation === 'pause' ? 'Projet suspendu. Les traitements déjà démarrés peuvent terminer.' : 'Projet réactivé. Les tickets Ready for AI et la file existante sont éligibles au worker.' : state === 'already_applied' ? 'Cette demande a déjà été appliquée. Aucune nouvelle action effectuée ; consultez le projet pour connaître son état actuel.' : state === 'cancelled' ? 'Demande annulée.' : 'Confirmation expirée, configuration modifiée ou traitement indisponible. Revenez au suivi avant de préparer une nouvelle demande.', links: [{ label: 'Voir les traitements', page: `history_${proposal.project.id}_0` }, { label: 'Retour au projet', page: projectPage(proposal.project.id) }] }, bound.target);
    }
    const run = action === 'propose_retry' ? await this.store.runByPage(value) : undefined;
    const project = await this.store.project(run?.project ?? value);
    if (!project || !await this.accessible(actor, project) || (action === 'propose_retry' && (!run || !await this.accessible(actor, run.config) || !project.enabled || !canRetry(run))) || !['propose_state', 'propose_retry'].includes(String(action))) return this.show(actor, eventId, context, unavailable);
    const operation = action === 'propose_retry' ? 'retry' : project.enabled ? 'pause' : 'resume';
    const proposal = await this.store.propose(actor, eventId, project, operation, run?.id);
    if (!proposal || proposal.state !== 'pending') return this.show(actor, eventId, context, unavailable);
    return this.show(actor, eventId, context, { kind: 'Confirmer — Développement', text: `Projet : ${project.name}\n${run ? `Ticket : ${run.ticket.name}\nTraitement : ${run.id}\n` : ''}${operation === 'pause' ? 'Suspendre les nouvelles prises en charge ? Les travaux déjà commencés peuvent terminer ; la file est conservée.' : operation === 'resume' ? 'Réactiver ce projet ? La file conservée et les tickets déjà Ready for AI pourront démarrer. Vérifiez la configuration du worker avant de confirmer.' : run?.result?.outcome === 'pushed' ? `Le commit ${run.result.commit} reste sur ${run.result.branch ?? 'maintenance'}. Cette relance lit le ticket actuel et démarre une nouvelle correction sur la branche configurée localement. Vérifiez les publications existantes avant de confirmer.` : 'Relancer avec les exigences déjà figées ? Le traitement dispose de deux essais au maximum. Modifiez le statut dans ClickUp puis attendez un passage de la surveillance avant Ready for AI si les exigences doivent changer.'}\n\nLes appels Cursor sont facturés séparément du budget OpenAI. Confirmation personnelle valable 24 heures.`,
      buttons: [{ label: operation === 'pause' ? 'Confirmer la suspension' : operation === 'resume' ? 'Confirmer la réactivation' : 'Confirmer la relance', action: 'confirm', value: proposal.id, style: operation === 'pause' ? 'danger' : 'primary', bound: true }, { label: 'Annuler', action: 'cancel', value: proposal.id, bound: true }] });
  }
}
