import type { Actor } from '../../core/identity.js';
import type { JobPayload, ModuleContext } from '../../core/modules.js';
import { Navigation, type MenuPage } from '../../core/navigation.js';
import { DevelopmentMenu } from './menu.js';
import { RoutingStore, sameDestination, destinationKey, selectedDestination, type RouteProposal, type TicketRoute } from './routing-store.js';
import { projectTargets, type Project } from './domain.js';
import type { ClickupDevelopment } from './providers.js';
import type { DevelopmentStore } from './store.js';

const back = [{ label: 'Tickets et dépôts', page: 'routes_0' }];
const unavailable: MenuPage = { kind: 'Choix des dépôts indisponible', text: 'Choix expiré, modifié ou inaccessible. Rouvrez le ticket depuis Tickets et dépôts.', links: back };

export class DevelopmentRouting {
  readonly saved: RoutingStore;
  constructor(private store: DevelopmentStore, private menus: DevelopmentMenu, private visible: (actor: Actor, project: Project) => Promise<boolean>, private clickup: ClickupDevelopment) {
    this.saved = new RoutingStore(store.db, store.team);
  }
  private async candidates(actor: Actor, route: TicketRoute) {
    const result: Project[] = [];
    for (const project of await this.store.projects()) {
      if (project.channel !== route.channel) continue;
      const targets = projectTargets(project, route.folder);
      if (!targets.length) continue;
      try { if (await this.visible(actor, project)) result.push(...targets); } catch { /* Fail closed. */ }
    }
    return result;
  }
  async page(actor: Actor, page: string): Promise<MenuPage> {
    if (/^routes_\d+$/.test(page)) {
      const routes = [];
      for (const route of await this.saved.list()) if ((await this.candidates(actor, route)).length) routes.push(route);
      const index = Math.min(Number(page.slice(7)), Math.max(0, Math.ceil(routes.length / 8) - 1));
      const rows = routes.slice(index * 8, (index + 1) * 8);
      return { kind: 'Tickets et dépôts', text: rows.length ? `Page ${index + 1}. Ouvrez un ticket pour choisir ses dépôts ou consulter son affectation.` : 'Aucun ticket partagé enregistré. Publiez son lien dans le canal commun, ou passez-le à Ready for AI dans ClickUp. Il attendra votre choix avant tout travail.',
        ...(rows.length ? { table: { columns: ['Ticket', 'Dépôts'], rows: rows.map(r => [r.snapshot.name.slice(0, 300), r.selected?.map(p => p.name).join(', ') || 'Aucun']),
          rowButtonColumn: 'État / actions', rowButtonFallback: 'Ouvrez le ticket avec les boutons sous le tableau.',
          rowButtons: rows.map(r => ({ label: r.selected ? 'Affecté — gérer' : 'À affecter', action: 'routing_open', value: r.ticket, bound: true })) } } : {}),
        buttons: rows.map(r => ({ label: r.snapshot.name.slice(0, 60), action: 'routing_open', value: r.ticket, bound: true })),
        links: [...(index ? [{ label: 'Précédent', page: `routes_${index - 1}` }] : []), ...((index + 1) * 8 < routes.length ? [{ label: 'Suivant', page: `routes_${index + 1}` }] : []), { label: 'Actualiser', page }, { label: 'Retour aux projets', page: 'projects_0' }] };
    }
    const history = /^route_runs_([\w-]+)_(\d{1,6})$/.exec(page);
    const route = await this.saved.get(history?.[1] ?? page.slice(6));
    if (!route) return unavailable;
    const candidates = await this.candidates(actor, route);
    if (!candidates.length) return unavailable;
    if (history) return this.menus.ticketHistory(actor, route.ticket, route.channel, Number(history[2]));
    const treatments = await this.menus.ticketHistory(actor, route.ticket, route.channel);
    const selected = route.selected;
    const blocked = !!selected && await this.saved.changeBlocked(route.ticket);
    return { kind: `Dépôts — ${route.snapshot.name}`, text: selected
      ? `Dépôts confirmés :\n${selected.map(p => `${p.name} — ${p.repository}`).join('\n')}\n\n${blocked ? 'Modification indisponible : un traitement est en cours, une publication reste à vérifier ou une correction existe. Annulez les corrections encore en attente avant de modifier ; les corrections commencées nécessitent une réconciliation par l’opérateur.' : 'Modifier les dépôts annule les analyses encore en attente des dépôts retirés. Les analyses des dépôts conservés restent inchangées ; les nouveaux dépôts peuvent démarrer après confirmation.'}\nReady for AI autorise une correction dans chaque dépôt choisi ; to build attend la réussite de toutes les corrections.`
      : 'Choisissez un ou plusieurs dépôts. Le dossier et la liste ClickUp restent inchangés. Aucun travail ne démarre avant confirmation du choix ; Ready for AI reste nécessaire pour corriger le code.',
      resourceLinks: [{ label: 'Ouvrir le ticket ClickUp', url: route.snapshot.url }],
      ...(treatments.table ? { table: treatments.table } : {}),
      buttons: [...(blocked ? [] : [{ label: selected ? 'Modifier les dépôts' : 'Choisir les dépôts', action: 'routing_begin', value: route.ticket, bound: true }]), ...(treatments.buttons ?? [])],
      links: [{ label: 'Traitements du ticket', page: `route_runs_${route.ticket}_0` }, ...(selected ?? []).filter(p => candidates.some(c => sameDestination(c, p))).map(p => ({ label: `Suivre ${p.name}`, page: `history_${p.id}_0` })), { label: 'Actualiser', page }, ...back] };
  }
  private picker(proposal: RouteProposal): MenuPage {
    return { kind: 'Choisir les dépôts', text: `Sélectionnez un ou plusieurs dépôts du projet avec Ajouter/Retirer, puis vérifiez votre choix.\nSélection : ${proposal.candidates.filter(p => selectedDestination(proposal.selected, p)).map(p => p.name).join(', ') || 'aucun dépôt'}\n\n${proposal.candidates.map(p => `${p.name} — ${p.repository}${p.enabled ? '' : ' (suspendu)'}`).join('\n')}`,
      buttons: [...proposal.candidates.filter(p => p.enabled).map(p => ({ label: `${selectedDestination(proposal.selected, p) ? 'Retirer' : 'Ajouter'} ${p.name}`, action: selectedDestination(proposal.selected, p) ? 'routing_remove' : 'routing_add', value: `${proposal.id}|${destinationKey(p)}`, bound: true })),
        ...(proposal.selected.length ? [{ label: 'Vérifier les dépôts', action: 'routing_check', value: proposal.id, bound: true, style: 'primary' as const }] : []),
        { label: 'Annuler', action: 'routing_cancel', value: proposal.id, bound: true }], links: back };
  }
  async handle(actor: Actor, payload: JobPayload, eventId: string, context: ModuleContext) {
    const show = (page: MenuPage) => this.menus.show(actor, eventId, context, page);
    const bound = await new Navigation(context.sql, context.messenger).boundTarget(actor, payload.value, payload.timestamp);
    if (!bound) return show(unavailable);
    if (payload.action === 'routing_open') return show(await this.page(actor, `route_${bound.value}`));
    if (payload.action === 'routing_begin') {
      const route = await this.saved.get(bound.value);
      if (!route || (route.selected && await this.saved.changeBlocked(route.ticket))) return show(unavailable);
      const candidates = await this.candidates(actor, route);
      if (!candidates.length) return show(unavailable);
      const proposal = await this.saved.propose(actor, eventId, route.ticket, candidates);
      return show(proposal?.state === 'pending' ? this.picker(proposal) : unavailable);
    }
    const separator = bound.value.lastIndexOf('|');
    const changing = ['routing_add', 'routing_remove'].includes(String(payload.action));
    const id = changing ? bound.value.slice(0, separator) : bound.value;
    let proposal = await this.saved.proposal(actor, id);
    const route = proposal && await this.saved.get(proposal.ticket);
    if (!proposal || !route) return show(unavailable);
    const candidates = await this.candidates(actor, route);
    if (!candidates.length) return show(unavailable);
    if (changing) {
      if (proposal.state !== 'pending' || route.revision !== proposal.base_revision) return show(unavailable);
      const project = bound.value.slice(separator + 1);
      if (!candidates.some(p => p.enabled && (destinationKey(p) === project || p.id === project))) return show(unavailable);
      proposal = await this.saved.choose(actor, id, project, payload.action === 'routing_add', eventId);
      return show(proposal ? this.picker(proposal) : unavailable);
    }
    if (payload.action === 'routing_check') {
      proposal = await this.saved.seal(actor, id);
      if (!proposal || proposal.state !== 'ready') return show(unavailable);
      return show({ kind: 'Confirmer les dépôts', text: `Ticket : ${route.snapshot.name}\n${proposal.candidates.filter(p => selectedDestination(proposal!.selected, p)).map(p => `${p.name} — ${p.repository}`).join('\n')}\n\n${proposal.base_selection ? 'Les analyses en attente des dépôts retirés seront annulées. Les analyses conservées ne sont pas relancées. ' : ''}Confirmer lance les analyses dans les nouveaux dépôts, ou autorise une correction dans chaque dépôt choisi si le ticket est déjà Ready for AI. Les appels Cursor sont facturés séparément pour chaque dépôt. Le choix est partagé avec le canal. Confirmation personnelle valable 24 heures.`, buttons: [
        { label: 'Confirmer les dépôts', action: 'routing_confirm', value: id, bound: true, style: 'primary' }, { label: 'Annuler', action: 'routing_cancel', value: id, bound: true }], links: back });
    }
    if (!['routing_confirm', 'routing_cancel'].includes(String(payload.action))) return show(unavailable);
    const selected = proposal.candidates.filter(p => selectedDestination(proposal!.selected, p));
    let ticket;
    if (payload.action === 'routing_confirm' && proposal.state === 'ready') {
      if (!selected.length || selected.some(p => !candidates.some(c => c.enabled && sameDestination(c, p)))) return show(unavailable);
      try { ticket = await this.clickup.ticket(selected[0]!, route.ticket); }
      catch { return show({ ...unavailable, text: 'Lecture ClickUp indisponible. Aucun choix enregistré ; réessayez après rétablissement des accès.' }); }
    }
    const state = await this.saved.confirm(actor, id, payload.action === 'routing_cancel', ticket);
    return show({ kind: 'Dépôts du ticket', text: state === 'applied' ? 'Choix enregistré. Chaque dépôt sélectionné dispose de son propre traitement ; les clics répétés ne démarrent aucun travail supplémentaire.' : state === 'unchanged' ? 'Les dépôts sont inchangés. Aucun nouveau traitement.' : state === 'busy' ? 'Modification indisponible : une correction existe ou un traitement a démarré. Aucun choix modifié.' : state === 'cancelled' ? 'Choix annulé. Aucun nouveau travail.' : state === 'legacy' ? 'Des traitements antérieurs existent pour ce ticket. Faites réconcilier leurs résultats par l’opérateur avant de l’affecter ; aucun traitement historique n’a été relancé.' : 'Le choix ou la configuration a changé. Rouvrez le ticket ; aucun nouveau travail.', links: [{ label: 'Ouvrir le ticket', page: `route_${route.ticket}` }, ...back] });
  }
}
