import { retainedTextNotice } from '../../core/presentation.js';
import { stateLabel } from './presentation.js';
import { Budget, BudgetExceeded, budgetReport } from '../../core/budget.js';
import type { Intelligence, Intent } from './ai.js';
import { availableRuleProposal, currentPreview, labelSchema, ownerKey, planMessage, sameLabels, starterRules, uid, validateRule, type Actor, type Connection, type Draft, type Item, type Run, type UserState } from './domain.js';
import type { Mailbox } from './gmail.js';
import { escapeCardValue, SlackDeliveryRejected, type Button, type Messenger } from '../../core/slack.js';
import { prune, Store } from './store.js';

export const SORT_OPERATION = 'sort';
export type Event = { type: 'text'; text: string; resolved?: Intent; presentationLanguage?: 'fr'; activeOperation?: string } | { type: 'action'; action : string; value: string } | { type: 'connection'; connection: Connection };
export type EngineDependencies = {
  store: Store; intelligence: Intelligence; messenger: Messenger; budget: Budget;
  mailbox: (actor: Actor, state: UserState) => Mailbox;
  connectUrl: (actor: Actor) => Promise<string>;
  admitSort?: (actor: Actor, eventId: string) => Promise<string>;
};
const HELP = "Je peux trier les 100 derniers messages de votre boîte de réception après votre approbation de l’aperçu.\nCommandes : courrier connecter, courrier modèles, courrier règles, courrier trier, courrier rapport, courrier détails <identifiant> <page>, courrier déconnecter.\nCommencez chaque demande par courrier, même en langage naturel : « courrier Applique le libellé Projets/Alpha aux e-mails d’alex@example.com ». Les changements de règles nécessitent aussi votre approbation. Utilisez les boutons de l’aperçu pour confirmer, annuler, examiner ou revenir sur un traitement. Commandes communes : aide, budget.";

export class Engine {
  constructor(private d: EngineDependencies) {}
  private send(actor: Actor, text: string, buttons?: Button[]) { return this.d.messenger.send(actor, { text, buttons }); }
  private sendCard(actor: Actor, kind: string, text: string, buttons?: Button[]) { return this.d.messenger.send(actor, { kind, text, buttons }); }
  private sendHelp(actor: Actor) { return this.sendCard(actor, "Aide", HELP); }
  async handle(actor: Actor, event: Event, eventId: string) {
    const state = await this.d.store.load(actor);
    if (state.handled.includes(eventId)) return;
    if (event.type === 'action' && ['menu_add_rule', 'menu_edit_rule', 'menu_latest_report', 'reopen_draft', 'reopen_preview', 'details', 'report'].includes(event.action)) {
      // Only delivery bookkeeping is persisted for reads; prune a private copy
      // afterward so browsing cannot delete or renew saved domain records.
      state.handled = [...state.handled, eventId].slice(-2000); await this.d.store.save(actor, state);
      prune(state);
      try { await this.action(actor, state, event.action, event.value); }
      catch (error) {
        if (error instanceof SlackDeliveryRejected) {
          const saved = await this.d.store.load(actor);
          saved.handled = saved.handled.filter(id => id !== eventId);
          await this.d.store.save(actor, saved);
        }
        throw error;
      }
      return;
    }
    prune(state);
    try {
      if (event.type === 'connection') {
        const draft: Draft = { id: uid(), created: new Date().toISOString(), kind: 'connection', connection: event.connection };
        state.drafts.push(draft); await this.d.store.save(actor, state);
        await this.sendCard(actor, "Confirmer la boîte e-mail", `Confirmez que ${event.connection.email} est VOTRE boîte Google Workspace. La connexion remplace toute connexion précédente et invalide les anciens aperçus.`, [{ label: "Connecter cette boîte", action: 'approve_draft', value: draft.id, style: 'primary' }, { label: "Annuler", action: 'cancel_draft', value: draft.id }]);
      } else if (event.type === 'action') await this.action(actor, state, event.action, event.value);
      else await this.text(actor, state, event, eventId);
      state.handled.push(eventId); await this.d.store.save(actor, state);
    } catch (error) {
      // Do not expose provider payloads, tokens, email content, database errors, or raw stack traces.
      console.error('job failed', error instanceof Error ? error.message : 'unknown');
      const message = error instanceof BudgetExceeded ? error.message : "Cette demande n’a pas pu aboutir. Aucune modification supplémentaire ne sera tentée automatiquement. Utilisez courrier rapport pour examiner les actions terminées ou incertaines, puis réessayez ou reconnectez-vous si l’autorisation a expiré.";
      await this.send(actor, message);
      state.handled.push(eventId); await this.d.store.save(actor, state);
    }
  }
  private async text(actor: Actor, state: UserState, event: Extract<Event, { type: 'text' }>, eventId: string) {
    const text = event.text.trim(), command = text.toLowerCase();
    if (command === 'help' || command === 'hi' || command === 'hello') return this.sendHelp(actor);
    if (command === 'disconnect') {
      return this.sendCard(actor, "Déconnecter Gmail", "Déconnecter Gmail et annuler tous les aperçus en attente ? Les règles enregistrées sont conservées. Vous pouvez aussi révoquer l’application depuis votre compte Google.", [{ label: "Déconnecter Gmail", action: 'disconnect', value: state.connection?.id ?? 'none', style: 'danger' }]);
    }
    if (/^details [\w-]+(?: \d+)?$/.test(command)) {
      const [, id, page] = command.split(' '); return this.details(actor, state, id!, Number(page ?? 0));
    }
    const quick: Record<string, Intent['intent']> = { connect: 'connect', 'connect gmail': 'connect', starters: 'starters', rules: 'rules', sort: 'sort', 'sort my inbox': 'sort', 'sort my mail': 'sort', report: 'report', budget: 'budget' };
    let intent: Intent;
    if (quick[command]) intent = { intent: quick[command]!, reply: '', rule: null, ruleId: null, runId: null, messageId: null, correction: null };
    else if (event.resolved) intent = event.resolved;
    else {
      intent = await this.d.intelligence.converse(actor, text, {
        rules: state.rules, history: state.history.slice(-20), connected: Boolean(state.connection),
        runs: state.runs.slice(-3).map(r => ({ id: r.id, status: r.status, messages: r.items.slice(0, 100).map(i => ({ id: i.id, subject: i.subject.slice(0, 120), plan: i.plan, status: i.status })) })),
      });
      // Persist the interpretation before acting so a worker restart doesn't pay to reinterpret it.
      await this.d.store.sql.query("UPDATE jobs SET payload=jsonb_set(jsonb_set(payload,'{resolved}',$2::jsonb),'{presentationLanguage}','\"fr\"'::jsonb) WHERE id=$1 AND owner=$3", [eventId, JSON.stringify(intent), ownerKey(actor)]);
    }
    state.history.push({ role: 'user', content: text.slice(0, 4000), at: new Date().toISOString() });
    switch (intent.intent) {
      case 'connect': return this.sendCard(actor, "Connexion", `Connectez votre propre boîte Google Workspace avec ce lien à usage unique (expire dans 10 minutes) :\n${await this.d.connectUrl(actor)}`);
      case 'starters': {
        await this.propose(actor, state, { kind: 'rules', rules: starterRules() });
        return this.send(actor, "Modèle de projet : lorsque l’expéditeur correspond à une association approuvée, appliquez un libellé de projet et conservez le message dans la boîte de réception. Commencez votre réponse par courrier, puis indiquez le nom du projet et les adresses e-mail des expéditeurs.");
      }
      case 'rules': return this.sendCard(actor, "Vos règles", state.rules.length ? state.rules.map(r => `${escapeCardValue(r.name)} [${escapeCardValue(r.id)}]\n${escapeCardValue(r.condition)}\nExpéditeurs : ${r.senders.length ? r.senders.map(escapeCardValue).join(', ') : "analyse du contenu"}\nLibellés : ${r.labels.length ? r.labels.map(escapeCardValue).join(', ') : 'aucun'}; action : ${stateLabel(r.action)}`).join('\n\n') : "Vous n’avez aucune règle approuvée. Envoyez courrier modèles ou décrivez votre première règle après le préfixe courrier.");
      case 'budget': return this.send(actor, await budgetReport(this.d.budget));
      case 'sort': {
        const original = event.activeOperation ?? (this.d.admitSort ? await this.d.admitSort(actor, eventId) : eventId);
        if (original !== eventId) return this.sendCard(actor, "Traitement en cours", `Votre demande de tri était déjà en cours à la réception de ce message. Demande existante : ${original}.`);
        return this.scan(actor, state, eventId);
      }
      case 'report': return this.report(actor, state, intent.runId ?? state.runs.at(-1)?.id);
      case 'propose_rule': {
        if (!intent.rule) return this.send(actor, "Commencez votre réponse par courrier et décrivez la condition, les libellés, l’action et les exceptions.");
        if (intent.ruleId && !state.rules.some(r => r.id === intent.ruleId)) return this.send(actor, "Cette règle ne fait pas partie de vos règles enregistrées.");
        return this.propose(actor, state, { kind: 'rules', rules: [validateRule(intent.rule)], language: event.resolved && event.presentationLanguage !== 'fr' ? undefined : 'fr', ...(intent.ruleId ? { replaceId: intent.ruleId } : {}) });
      }
      case 'delete_rule': {
        if (!intent.ruleId || !state.rules.some(r => r.id === intent.ruleId)) return this.send(actor, "Choisissez une règle dans votre liste.");
        return this.propose(actor, state, { kind: 'delete', ruleId: intent.ruleId });
      }
      case 'correction': return this.correction(actor, state, intent);
      default:
        state.history.push({ role: 'assistant', content: intent.reply, at: new Date().toISOString() });
        return intent.reply ? this.send(actor, `${event.resolved && event.presentationLanguage !== 'fr' ? `${retainedTextNotice}\n\n` : ''}${intent.reply}`) : this.sendHelp(actor);
    }
  }
  private async propose(actor: Actor, state: UserState, value: Omit<Draft, 'id' | 'created'>) {
    const draft: Draft = { language: 'fr', ...value, id: uid(), created: new Date().toISOString() };
    state.drafts.push(draft); await this.d.store.save(actor, state);
    return this.showDraft(actor, state, draft);
  }
  private showDraft(actor: Actor, state: UserState, draft: Draft) {
    const description = draft.kind === 'delete' ? `Supprimer la règle ${escapeCardValue(state.rules.find(r => r.id === draft.ruleId)?.name ?? '')}?` :
      `${draft.replaceId ? "Remplacer la règle existante par" : "Règles proposées"}:\n\n${draft.rules!.map(r => `${escapeCardValue(r.name)}\n${escapeCardValue(r.condition)}\n${r.senders.length ? `Expéditeurs : ${r.senders.map(escapeCardValue).join(', ')}\n` : ''}Libellés : ${r.labels.length ? r.labels.map(escapeCardValue).join(', ') : 'aucun'}; action : ${stateLabel(r.action)}\nExemples : ${r.examples.map(escapeCardValue).join(' | ')}`).join('\n\n')}`;
    return this.sendCard(actor, draft.kind === 'delete' ? "Supprimer la règle" : "Proposition de règle", `${draft.language === 'fr' ? '' : `${retainedTextNotice}\n\n`}${description}\n\nAucune règle ne change avant votre approbation.`, [{ label: "Approuver les règles", action: 'approve_draft', value: draft.id, style: draft.kind === 'delete' ? 'danger' : 'primary' }, { label: "Annuler", action: 'cancel_draft', value: draft.id }]);
  }
  private async action(actor: Actor, state: UserState, action: string, value: string) {
    if (action === 'menu_add_rule') return this.send(actor, "Commencez votre réponse par courrier et décrivez la condition, les libellés, l’action et les exceptions. Je proposerai une règle avec des exemples pour votre approbation.");
    if (action === 'menu_edit_rule') {
      const rule = state.rules.find(rule => rule.id === value);
      return this.send(actor, rule ? `Pour modifier ${escapeCardValue(rule.name)}, répondez : courrier modifie la règle ${escapeCardValue(rule.id)} puis indiquez la condition, les libellés, l’action et les exceptions souhaités. Les modifications nécessitent une approbation séparée.` : "Cette règle n’est plus disponible dans votre compte. Ouvrez à nouveau Gérer les règles.");
    }
    if (action === 'menu_latest_report') return this.report(actor, state,
      state.runs.findLast(run => run.status === 'done' || run.status === 'undone')?.id);
    if (action === 'menu_starters') return this.propose(actor, state, { kind: 'rules', rules: starterRules() });
    if (action === 'menu_remove_rule') {
      if (!state.rules.some(rule => rule.id === value)) return this.send(actor, "Cette règle n’est plus disponible dans votre compte. Ouvrez à nouveau Gérer les règles.");
      return this.propose(actor, state, { kind: 'delete', ruleId: value });
    }
    if (action === 'reopen_draft') {
      const draft = state.drafts.find(draft => draft.id === value && availableRuleProposal(state, draft));
      return draft ? this.showDraft(actor, state, draft) : this.send(actor, "Cette proposition est indisponible, expirée ou déjà traitée. Ouvrez à nouveau Approbations en attente.");
    }
    if (action === 'reopen_preview') {
      const run = state.runs.find(run => run.id === value && run.status === 'preview' && currentPreview(state, run));
      return run ? this.preview(actor, run) : this.send(actor, "Cet aperçu est indisponible, expiré, ou sa connexion/ses règles ont changé. Ouvrez Approbations en attente ou envoyez courrier trier pour un nouvel aperçu.");
    }
    if (action === 'approve_draft' || action === 'cancel_draft') {
      const draft = state.drafts.find(d => d.id === value);
      if (!draft) return this.send(actor, "Cette proposition est indisponible ou déjà traitée.");
      if (action === 'approve_draft' && draft.kind !== 'connection' && !availableRuleProposal(state, draft)) return this.send(actor, "Cette proposition n’est plus valide. Ouvrez Gérer les règles pour la proposer à nouveau.");
      if (action === 'approve_draft') {
        if (draft.kind === 'connection') {
          state.connection = draft.connection; state.runs.forEach(r => { if (r.status === 'preview' || r.status === 'scanning') r.status = 'cancelled'; });
        } else {
          if (draft.kind === 'delete') state.rules = state.rules.filter(r => r.id !== draft.ruleId);
          else {
            const additions = draft.rules!.map(r => ({ ...validateRule(r), id: draft.replaceId ?? uid() }));
            if (draft.replaceId && !state.rules.some(r => r.id === draft.replaceId)) return this.send(actor, "La règle d’origine n’existe plus. Proposez-la à nouveau.");
            const next = [...state.rules.filter(r => r.id !== draft.replaceId), ...additions];
            if (next.length > 40) return this.send(actor, "Cette version accepte jusqu’à 40 règles par utilisateur. Supprimez ou regroupez des règles avant de continuer.");
            state.rules = next;
          }
          state.ruleVersion++;
        }
      }
      state.drafts = state.drafts.filter(d => d.id !== value);
      await this.d.store.save(actor, state);
      return this.send(actor, action === 'cancel_draft' ? "Proposition annulée." : draft.kind === 'connection' ? `Connexion établie pour ${state.connection!.email}. Envoyez courrier modèles pour examiner les premières règles, ou courrier trier si vos règles sont prêtes.` : "Vos changements de règles sont enregistrés. Envoyez courrier trier pour créer un aperçu.");
    }
    if (action === 'disconnect') {
      if (value !== state.connection?.id) return this.send(actor, "Cette demande de déconnexion n’est plus valide.");
      delete state.connection; state.drafts = state.drafts.filter(d => d.kind !== 'connection');
      state.runs.forEach(r => { if (['preview', 'scanning'].includes(r.status)) r.status = 'cancelled'; });
      await this.d.store.save(actor, state); return this.send(actor, "Gmail est déconnecté de l’application. Vos règles sont conservées.");
    }
    const [runId, extra, page] = value.split(':');
    const run = state.runs.find(r => r.id === runId);
    if (!run) return this.send(actor, "Ce traitement n’est pas disponible dans votre compte.");
    if (action === 'details') return this.details(actor, state, run.id, Number(extra ?? 0));
    if (action === 'report') return this.report(actor, state, run.id);
    if (action === 'cancel_run') {
      if (run.status === 'preview') run.status = 'cancelled';
      await this.d.store.save(actor, state); return this.send(actor, `État du traitement : ${stateLabel(run.status)}.`);
    }
    if (action === 'accept_item' || action === 'skip_item') {
      if (run.status !== 'preview') return this.send(actor, "Cet aperçu ne peut plus être modifié.");
      const item = run.items.find(i => i.id === extra);
      if (item && item.plan.needsDecision) {
        if (action === 'accept_item') item.plan.needsDecision = false;
        else item.status = 'skipped';
        await this.d.store.save(actor, state);
      }
      return this.details(actor, state, run.id, Number(page ?? 0));
    }
    if (action === 'confirm_run') return this.apply(actor, state, run);
    if (action === 'undo_run') return this.undo(actor, state, run);
    return this.send(actor, "Action non prise en charge.");
  }
  private connected(actor: Actor, state: UserState): Mailbox {
    if (!state.connection) throw new Error("Connectez d’abord Gmail.");
    return this.d.mailbox(actor, state);
  }
  private async scan(actor: Actor, state: UserState, sourceId: string) {
    if (!state.connection) return this.send(actor, "Connectez d’abord Gmail : envoyez courrier connecter.");
    if (!state.rules.length) return this.send(actor, "Approuvez d’abord au moins une règle : envoyez courrier modèles ou décrivez une règle après le préfixe courrier.");
    const mailbox = this.connected(actor, state);
    let run = state.runs.find(r => r.sourceId === sourceId);
    if (!run) {
      run = { id: uid(), sourceId, language: 'fr', created: new Date().toISOString(), ruleVersion: state.ruleVersion, connectionId: state.connection.id, status: 'scanning', items: [], messageIds: await mailbox.list() };
      state.runs.push(run); await this.d.store.save(actor, state);
      await this.send(actor, `Examen de ${run.messageIds!.length} messages de la boîte de réception. Je vous enverrai un aperçu avant toute modification.`);
    }
    if (run.status !== 'scanning') return this.preview(actor, run);
    for (const id of run.messageIds!) {
      if (run.items.some(i => i.id === id)) continue;
      const mail = await mailbox.read(id);
      let matches;
      try { matches = await this.d.intelligence.classify(actor, mail, state.rules.filter(r => r.kind === 'semantic')); }
      catch (error) { if (error instanceof BudgetExceeded) { run.status = 'cancelled'; await this.d.store.save(actor, state); throw error; } throw error; }
      run.items.push({ id, from: mail.from, subject: mail.subject, before: mail.labels, historyId: mail.historyId, plan: planMessage(mail, state.rules, matches), status: 'pending' });
      await this.d.store.save(actor, state);
    }
    const existing = await mailbox.labels();
    run.newLabels = [...new Set(run.items.flatMap(i => i.plan.labels))].filter(name => !existing.some(l => l.name === name));
    run.status = 'preview'; await this.d.store.save(actor, state);
    return this.preview(actor, run);
  }
  private preview(actor: Actor, run: Run) {
    const actionable = run.items.filter(i => !i.plan.needsDecision && i.status === 'pending');
    const newLabelText = run.newLabels?.length ? run.newLabels.map(escapeCardValue).join(', ') : 'aucun';
    return this.sendCard(actor, "Aperçu", `Traitement ${escapeCardValue(run.id)}\n\n- ${run.items.length} messages examinés\n- Libellés proposés sur ${actionable.filter(i => i.plan.labels.length || i.plan.removeLabels?.length).length}\n- archive ${actionable.filter(i => i.plan.disposition === 'archive').length}\n- Corbeille : ${actionable.filter(i => i.plan.disposition === 'trash').length}\n- Votre décision est nécessaire : ${run.items.filter(i => i.plan.needsDecision && i.status === 'pending').length}. Ils sont exclus sauf inclusion explicite de votre part.\n- Nouveaux libellés : ${newLabelText}\n\nExaminez les détails des messages avant de confirmer. Aucune modification n’a encore été effectuée.`, [
      { label: "Examiner les messages", action: 'details', value: `${run.id}:0` },
      { label: "Confirmer les modifications", action: 'confirm_run', value: run.id, style: 'primary' },
      { label: "Annuler", action: 'cancel_run', value: run.id },
    ]);
  }
  private details(actor: Actor, state: UserState, id: string, page = 0) {
    const run = state.runs.find(r => r.id === id);
    if (!run) return this.send(actor, "Traitement introuvable dans votre compte.");
    page = Number.isFinite(page) ? Math.max(0, Math.min(Math.floor(page), Math.max(0, Math.ceil(run.items.length / 5) - 1))) : 0;
    const items = run.items.slice(page * 5, page * 5 + 5), buttons: Button[] = [];
    const text = items.map((i, n) => {
      if (run.status === 'preview' && i.plan.needsDecision && i.status === 'pending') buttons.push({ label: `Inclure la proposition ${n + 1}`, action: 'accept_item', value: `${id}:${i.id}:${page}` }, { label: `Laisser ${n + 1} sans modification`, action: 'skip_item', value: `${id}:${i.id}:${page}` });
      return `${n + 1}. ${escapeCardValue(i.subject) || "(sans objet)"}\nDe : ${escapeCardValue(i.from)}\nMessage : ${escapeCardValue(i.id)}\n${i.plan.needsDecision ? "VOTRE DÉCISION EST NÉCESSAIRE — " : ''}${escapeCardValue(stateLabel(i.plan.disposition))} ; ajouter les libellés : ${i.plan.labels.length ? i.plan.labels.map(escapeCardValue).join(', ') : 'aucun'} ; retirer : ${i.plan.removeLabels?.length ? i.plan.removeLabels.map(escapeCardValue).join(', ') : 'aucun'}\n${i.plan.reasons.map(escapeCardValue).join('\n')}\nÉtat : ${escapeCardValue(stateLabel(i.status))}${i.note ? ` — ${escapeCardValue(i.note)}` : ''}`;
    }).join('\n\n');
    if (page > 0) buttons.push({ label: "Précédent", action: 'details', value: `${id}:${page - 1}` });
    if ((page + 1) * 5 < run.items.length) buttons.push({ label: "Suivant", action: 'details', value: `${id}:${page + 1}` });
    if (run.status === 'preview') buttons.push({ label: "Confirmer la proposition examinée", action: 'confirm_run', value: id, style: 'primary' });
    return this.sendCard(actor, "Détails", `Traitement ${escapeCardValue(id)} — page ${page + 1}/${Math.max(1, Math.ceil(run.items.length / 5))}\n\n${run.language === 'fr' ? '' : `${retainedTextNotice}\n\n`}${text || "Aucun message."}`, buttons);
  }
  private async apply(actor: Actor, state: UserState, run: Run) {
    if (!['preview', 'applying'].includes(run.status)) return this.report(actor, state, run.id);
    if (!currentPreview(state, run)) {
      run.status = 'cancelled'; await this.d.store.save(actor, state);
      return this.send(actor, "Cet aperçu a expiré ou sa connexion/ses règles ont changé. Envoyez courrier trier pour un nouvel aperçu.");
    }
    const mailbox = this.connected(actor, state);
    run.status = 'applying'; await this.d.store.save(actor, state);
    for (const item of run.items) {
      if (item.status === 'prepared') { item.status = 'unknown'; item.note = "Le traitement s’est arrêté pendant une modification. Vérifiez Gmail ; cette modification ne sera ni répétée ni annulée automatiquement."; await this.d.store.save(actor, state); continue; }
      if (item.status !== 'pending') continue;
      if (item.plan.needsDecision) { item.status = 'skipped'; item.note = "Aucune décision explicite pour cette correspondance incertaine."; await this.d.store.save(actor, state); continue; }
      try {
        const labelIds = [];
        for (const label of item.plan.labels) labelIds.push(await mailbox.ensureLabel(label));
        const knownLabels = await mailbox.labels();
        const removeIds = (item.plan.removeLabels ?? []).map(name => knownLabels.find(l => l.name === name)?.id).filter((id): id is string => Boolean(id));
        const current = await mailbox.snapshot(item.id);
        if (!sameLabels(current.labels, item.before) || current.historyId !== item.historyId) { item.status = 'conflict'; item.note = "Le message a changé après l’aperçu ; il n’a pas été modifié."; await this.d.store.save(actor, state); continue; }
        const add = [...new Set([...labelIds, ...(item.plan.disposition === 'trash' ? ['TRASH'] : []), ...(run.correction && item.plan.disposition === 'keep' ? ['INBOX'] : [])])].filter(l => !current.labels.includes(l));
        const remove = [...new Set([...removeIds, ...(item.plan.disposition !== 'keep' ? ['INBOX'] : []), ...(run.correction && item.plan.disposition !== 'trash' ? ['TRASH'] : [])])].filter(l => current.labels.includes(l) && !add.includes(l));
        if (!add.length && !remove.length) { item.status = 'skipped'; item.note = "Le message correspond déjà au plan approuvé."; await this.d.store.save(actor, state); continue; }
        item.add = add; item.remove = remove; item.status = 'prepared'; await this.d.store.save(actor, state);
        const after = await mailbox.mutate(item.id, { kind: 'labels', add, remove });
        item.after = after.labels; item.afterHistory = after.historyId; item.status = 'applied';
      } catch {
        item.note = item.status === 'prepared' ? "Le résultat de la modification est incertain. Vérifiez Gmail avant toute autre action." : "Le message n’a pas pu être préparé ; il n’a pas été modifié.";
        item.status = item.status === 'prepared' ? 'unknown' : 'conflict';
      }
      await this.d.store.save(actor, state);
    }
    run.status = 'done'; await this.d.store.save(actor, state); return this.report(actor, state, run.id);
  }
  private async undo(actor: Actor, state: UserState, run: Run) {
    if (!['done', 'undoing'].includes(run.status) || run.connectionId !== state.connection?.id) return this.send(actor, "Ce traitement ne peut pas être annulé avec votre connexion actuelle.");
    const mailbox = this.connected(actor, state); run.status = 'undoing'; await this.d.store.save(actor, state);
    for (const item of run.items) {
      if (item.status === 'undo_prepared') { item.status = 'unknown'; item.note = "Le traitement s’est arrêté pendant l’annulation ; vérifiez Gmail."; await this.d.store.save(actor, state); continue; }
      if (item.status !== 'applied') continue;
      try {
        const current = await mailbox.snapshot(item.id);
        if (!sameLabels(current.labels, item.after ?? []) || current.historyId !== item.afterHistory) { item.note = "Annulation ignorée : le message a changé depuis ce traitement."; await this.d.store.save(actor, state); continue; }
        item.status = 'undo_prepared'; await this.d.store.save(actor, state);
        await mailbox.mutate(item.id, { kind: 'labels', add: item.remove, remove: item.add });
        item.status = 'undone'; item.note = "Seuls les changements de libellés enregistrés par cet assistant ont été restaurés.";
      } catch { item.note = "L’annulation n’a pas pu être confirmée ; vérifiez Gmail."; item.status = 'unknown'; }
      await this.d.store.save(actor, state);
    }
    run.status = 'undone'; await this.d.store.save(actor, state); return this.report(actor, state, run.id);
  }
  private report(actor: Actor, state: UserState, id?: string) {
    const run = state.runs.find(r => r.id === id);
    if (!run) return this.send(actor, "Aucun traitement conservé n’est disponible.");
    const counts = new Map<string, number>(); for (const item of run.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    return this.sendCard(actor, "Rapport", `Traitement ${escapeCardValue(run.id)}: ${escapeCardValue(stateLabel(run.status))}\n${[...counts].map(([s, n]) => `- ${escapeCardValue(stateLabel(s))}: ${n}`).join('\n')}\nLes résultats incertains nécessitent une vérification dans Gmail. L’annulation ignore les messages modifiés depuis l’intervention de l’assistant.`, [
      { label: "Détails", action: 'details', value: `${run.id}:0` },
      ...(run.status === 'done' ? [{ label: "Annuler ce traitement", action: 'undo_run', value: run.id } as Button] : []),
    ]);
  }
  private async correction(actor: Actor, state: UserState, intent: Intent) {
    const original = state.runs.find(r => r.id === intent.runId), item = original?.items.find(i => i.id === intent.messageId);
    if (!item || !intent.correction || original?.connectionId !== state.connection?.id) return this.send(actor, "Indiquez les identifiants du message et du traitement dans votre rapport, ainsi que la modification souhaitée.");
    const correction = intent.correction;
    const labels = correction.addLabels.map(x => labelSchema.parse(x)), removeLabels = correction.removeLabels.map(x => labelSchema.parse(x));
    const current = await this.connected(actor, state).read(item.id);
    const run: Run = { id: uid(), language: 'fr', created: new Date().toISOString(), ruleVersion: state.ruleVersion, connectionId: state.connection!.id, status: 'preview', correction: true,
      items: [{ id: item.id, from: current.from, subject: current.subject, before: current.labels, historyId: current.historyId, status: 'pending', plan: { labels, removeLabels, disposition: correction.disposition, needsDecision: false, reasons: ["Correction d’un message demandée par vous. Les règles enregistrées ne changent pas."] } }] };
    const existing = await this.connected(actor, state).labels(); run.newLabels = labels.filter(name => !existing.some(l => l.name === name));
    state.runs.push(run); await this.d.store.save(actor, state);
    await this.preview(actor, run);
    return this.send(actor, "Cette correction ne change pas le comportement futur. Commencez votre réponse par courrier et décrivez le changement souhaité de la règle ; je le proposerai séparément pour approbation.");
  }
}
