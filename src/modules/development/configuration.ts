import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Actor } from '../../core/identity.js';
import type { AssistantModule, JobPayload, ModuleContext } from '../../core/modules.js';
import { Navigation } from '../../core/navigation.js';
import { JobStore } from '../../core/store.js';
import { ConfigurationStore, type ConfigurationForm } from './configuration-store.js';
import { projectSchema, type Project } from './domain.js';
import { DevelopmentMenu, projectPage } from './menu.js';
import type { ClickupDevelopment, FolderChoice } from './providers.js';
import type { DevelopmentStore } from './store.js';

const plain = (text: string) => ({ type: 'plain_text', text });
const home = [{ label: 'Retour aux projets', page: 'projects_0' }];
const expired = 'Formulaire indisponible ou expiré. Fermez-le et ouvrez un nouveau formulaire avec development menu dans le canal.';
const fields = z.record(z.string(), z.record(z.string(), z.object({ value: z.string().nullable().optional(), selected_option: z.object({ value: z.string() }).passthrough().nullable().optional(), selected_conversation: z.string().nullable().optional(), selected_options: z.array(z.object({ value: z.string() }).passthrough()).optional() }).passthrough()));
const folderOption = (folder: FolderChoice) => ({ text: plain(`${folder.name.slice(0, 45)} · ${folder.id}`.slice(0, 75)), value: folder.id, description: plain(`${folder.workspace} / ${folder.space}`.slice(0, 75)) });
const folderLabel = (form: ConfigurationForm, id: string) => {
  const folder = form.folders?.find(folder => folder.id === id);
  return folder ? `${folder.workspace} / ${folder.space} / ${folder.name} (${folder.id})` : id;
};

export function configurationView(form: ConfigurationForm) {
  const value = form.candidate ?? form.base;
  const input = (key: string, label: string, max: number, hint?: string) => ({ type: 'input', block_id: key, label: plain(label), ...(hint ? { hint: plain(hint) } : {}),
    element: { type: 'plain_text_input', action_id: 'value', max_length: max, ...(value?.[key as keyof Project] ? { initial_value: String(value[key as keyof Project]) } : {}) } });
  const enabled = { text: plain('Activer le projet'), value: 'enabled' };
  const selected = form.folders?.find(folder => folder.id === value?.folder);
  return { type: 'modal', callback_id: 'development:configuration', private_metadata: form.id, title: plain(form.base ? 'Modifier le projet' : 'Configurer un projet'), submit: plain('Vérifier'), close: plain('Annuler'), blocks: [
    { type: 'section', text: plain('Remplissez les champs puis vérifiez la proposition dans le fil du canal. Rien ne sera enregistré avant votre confirmation.') },
    form.base ? { type: 'section', text: plain(`Identifiant du projet : ${form.base.id} (conservé)`) } : input('id', 'Identifiant du projet', 64, 'Lettres minuscules, chiffres et tirets ; commencez par une lettre. Doit correspondre au worker local.'),
    input('name', 'Nom du projet', 100),
    { type: 'section', block_id: 'channel', text: plain(`Canal du projet : ${form.channel}. La configuration reste dans le canal où ce formulaire a été ouvert.`) },
    ...(value?.folder && !selected ? [{ type: 'section', text: plain('Le dossier enregistré ne figure plus dans les choix disponibles. Sélectionnez un dossier accessible avant de vérifier.') }] : []),
    { type: 'input', block_id: 'folder', label: plain('Dossier ClickUp'), hint: plain('Recherchez un nom de dossier, d’espace, de Workspace ou un identifiant. 100 résultats maximum ; précisez la recherche.'),
      element: { type: 'external_select', action_id: 'value', min_query_length: 0, placeholder: plain('Choisir un dossier ClickUp'), ...(selected ? { initial_option: folderOption(selected) } : {}) } },
    input('repository', 'URL HTTPS du dépôt', 2000, 'Sans identifiants, paramètres ni fragment.'),
    input('skill', 'Skill du worker', 200, 'Nom correspondant à la configuration locale du worker.'),
    { type: 'input', block_id: 'enabled', optional: true, label: plain('Activation'), hint: plain('Activer rend la file et les tickets déjà Ready for AI éligibles. Les appels Cursor sont facturés séparément.'), element: { type: 'checkboxes', action_id: 'value', options: [enabled], ...(value?.enabled ? { initial_options: [enabled] } : {}) } },
  ] };
}

export class DevelopmentConfiguration {
  private saved: ConfigurationStore;
  constructor(private store: DevelopmentStore, private menus: DevelopmentMenu, private visible: (actor: Actor, project: Project) => Promise<boolean>, private clickup: ClickupDevelopment, private token: string, private fetcher: typeof fetch = fetch) {
    this.saved = new ConfigurationStore(store.db);
  }

  readonly forms: NonNullable<AssistantModule['forms']> = {
    openActions: ['configuration_open'], callbacks: ['configuration'],
    suggest: async (actor, input) => {
      if (input.block !== 'folder' || input.action !== 'value') return { options: [] };
      const form = await this.saved.get(actor, input.form);
      if (!form || !/^[CG]/.test(form.channel) || form.state !== 'editing' || !form.folders) return { options: [] };
      const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr');
      const terms = normalize(input.query).split(/\s+/).filter(Boolean);
      return { options: form.folders.filter(folder => terms.every(term => normalize(`${folder.workspace} ${folder.space} ${folder.name} ${folder.id}`).includes(term))).slice(0, 100).map(folderOption) };
    },
    open: async (actor, input, eventId) => {
      if (!/^[CG]/.test(actor.channel)) return;
      const form = await this.saved.get(actor, input.value);
      if (!form || form.channel !== actor.channel || form.state !== 'editing' || !form.folders?.length) return this.notice(actor, eventId, expired);
      // The draft holds the values and catalogue prepared for this actor.
      // No membership/ClickUp requests may consume Slack's three-second trigger here.
      const claimed = await this.store.db.query('INSERT INTO development_receipts(team,id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id', [actor.team, `form-open:${eventId}`]);
      if (!claimed.rows.length) return;
      try {
        const response = await this.fetcher('https://slack.com/api/views.open', { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ trigger_id: input.trigger, view: { ...configurationView(form), external_id: `development:${eventId}` } }), signal: AbortSignal.timeout(1800) });
        if (!response.ok || !(await response.json() as { ok?: boolean }).ok) throw new Error('Form unavailable');
      } catch {
        await this.notice(actor, eventId, 'Le formulaire n’a pas pu être ouvert avec certitude. S’il apparaît, vous pouvez le remplir. Sinon, recliquez sur Remplir le formulaire. Aucun projet modifié.');
      }
    },
    submit: async (actor, view) => {
      const form = await this.saved.get(actor, view.private_metadata);
      const errors = (message: string) => ({ response_action: 'errors', errors: { name: message } });
      if (!form || !/^[CG]/.test(form.channel) || !form.folders?.length) return errors(expired);
      const parsedFields = fields.safeParse(view.state?.values);
      if (!parsedFields.success) return errors('Champs invalides. Fermez puis rouvrez le formulaire.');
      const data = parsedFields.data;
      const enabled = data.enabled?.value?.selected_options ?? [];
      if (enabled.some(option => option.value !== 'enabled')) return { response_action: 'errors', errors: { enabled: 'Choix d’activation invalide.' } };
      const candidate = projectSchema.safeParse({ id: form.base?.id ?? data.id?.value?.value, name: data.name?.value?.value, channel: form.channel,
        folder: data.folder?.value?.selected_option?.value, repository: data.repository?.value?.value, skill: data.skill?.value?.value, enabled: enabled.length > 0 });
      if (!candidate.success) {
        const messages: Record<string, string> = { id: 'Utilisez 1 à 64 lettres minuscules, chiffres ou tirets, en commençant par une lettre.', name: 'Saisissez un nom de 1 à 100 caractères.', channel: 'Sélectionnez un canal public ou privé.', folder: 'Choisissez un dossier ClickUp dans la liste.', repository: 'Saisissez une URL HTTPS sans identifiants, paramètres ni fragment.', skill: 'Saisissez un skill de 1 à 200 caractères.' };
        return { response_action: 'errors', errors: Object.fromEntries(candidate.error.issues.map(issue => { const field = String(issue.path[0]); return [field, messages[field] ?? 'Valeur invalide.']; })) };
      }
      if (!form.folders.some(folder => folder.id === candidate.data.folder)) return { response_action: 'errors', errors: { folder: 'Ce dossier ne fait pas partie des choix proposés. Fermez le formulaire et actualisez les dossiers.' } };
      if (!form.base && form.state === 'editing' && await this.store.project(candidate.data.id)) return { response_action: 'errors', errors: { id: 'Cet identifiant existe déjà. Choisissez-en un autre ou ouvrez ce projet pour le modifier.' } };
      if (!await this.saved.submit(actor, form.id, candidate.data)) return errors('Ce formulaire a déjà été transmis ou annulé. Ouvrez-en un nouveau depuis le menu.');
      return {}; // Durable submission closes the modal; provider validation runs in the queue.
    },
  };

  private notice(actor: Actor, eventId: string, text: string) {
    return new JobStore(this.store.db).enqueue(`development:form-notice:${eventId}`, actor, { type: 'configuration_notice', text }, 'development').then(() => undefined);
  }

  private async access(actor: Actor, project: Project | null) {
    if (!project) return true;
    try { return await this.visible(actor, project); } catch { return false; }
  }
  private async problem(actor: Actor, form: ConfigurationForm) {
    if (!form.candidate || !await this.access(actor, form.base) || !await this.access(actor, form.candidate)) return 'Vous et le bot devez accéder au canal de ce formulaire. Vérifiez les accès Slack puis rouvrez le formulaire.';
    const current = await this.store.project(form.candidate.id);
    if (!isDeepStrictEqual(current ?? null, form.base)) return 'Le projet a été modifié ou cet identifiant vient d’être utilisé. Rouvrez sa configuration depuis la liste des projets.';
    try { await this.clickup.lists(form.candidate.folder); } catch { return 'Le dossier ClickUp est inaccessible. Vérifiez son identifiant et les accès de l’intégration, puis corrigez le formulaire.'; }
  }

  async handle(actor: Actor, payload: JobPayload, eventId: string, context: ModuleContext) {
    const show = (text: string, buttons: NonNullable<Parameters<DevelopmentMenu['show']>[3]['buttons']> = [], links = home) => this.menus.show(actor, eventId, context, { kind: 'Configuration — Développement', text, buttons, links });
    if (payload.type === 'configuration_notice') return show(String(payload.text));
    if (payload.type === 'configuration_validate') {
      const form = await this.saved.get(actor, String(payload.form));
      if (!form || form.channel !== actor.channel || !['submitted', 'ready'].includes(form.state)) return show(expired);
      const problem = await this.problem(actor, form);
      if (problem) return show(`${problem}\nAucune configuration enregistrée.`, [{ label: 'Corriger le formulaire', action: 'configuration_prepare', value: `form:${form.id}`, bound: true }]);
      await this.saved.validated(actor, form.id);
      const value = form.candidate!;
      return show(`Vérifiez la configuration avant de l’enregistrer :\nIdentifiant : ${value.id}\nNom : ${value.name}\nCanal : ${value.channel}\nDossier ClickUp : ${folderLabel(form, value.folder)}\nDépôt : ${value.repository}\nSkill : ${value.skill}\nÉtat : ${value.enabled ? 'Activé' : 'Suspendu'}\n\n${value.enabled ? 'Les tickets déjà Ready for AI et la file pourront démarrer ; appels Cursor facturés séparément.' : 'Le projet reste suspendu ; les travaux déjà démarrés peuvent terminer.'}\nLe worker local doit avoir la configuration correspondante. Cette confirmation personnelle expire 24 heures après la préparation du formulaire.`, [
        { label: 'Enregistrer la configuration', action: 'configuration_save', value: form.id, bound: true, style: 'primary' },
        { label: 'Corriger le formulaire', action: 'configuration_prepare', value: `form:${form.id}`, bound: true },
        { label: 'Annuler', action: 'configuration_cancel', value: form.id, bound: true },
      ]);
    }
    const bound = payload.type === 'menu_action' && await new Navigation(context.sql, context.messenger).boundTarget(actor, payload.value, payload.timestamp);
    if (!bound) return show(expired);
    if (payload.action === 'configuration_prepare') {
      const prior = bound.value.startsWith('form:') ? await this.saved.get(actor, bound.value.slice(5)) : undefined;
      if (bound.value.startsWith('form:') && (!prior || prior.channel !== actor.channel)) return show(expired);
      const base = prior ? prior.base : bound.value === 'new' ? null : bound.value.startsWith('project:') ? await this.store.project(bound.value.slice(8)) : undefined;
      // Candidate values belong to this User; an invalid destination must remain correctable.
      if (base === undefined || !await this.access(actor, base)) return show('Projet inaccessible. Vérifiez les accès Slack et rouvrez les projets.');
      let folders: FolderChoice[];
      const retry = [{ label: 'Actualiser les dossiers', action: 'configuration_prepare', value: bound.value, bound: true }];
      try { folders = await this.clickup.folders(); }
      catch { return show('Les dossiers ClickUp n’ont pas pu être chargés complètement. Vérifiez les accès de l’intégration puis actualisez les dossiers. Aucun projet modifié.', retry); }
      if (!folders.length) return show('Aucun dossier ClickUp actif accessible à l’intégration Development. Vérifiez ses accès et la présence de dossiers, puis actualisez les dossiers. Aucun projet modifié.', retry);
      if (prior) {
        if (base && !isDeepStrictEqual((await this.store.project(base.id)) ?? null, base)) return show('Configuration modifiée. Ouvrez le projet à nouveau pour récupérer ses valeurs actuelles.');
        await this.saved.finish(actor, prior.id, true);
      }
      const form = await this.saved.create(actor, eventId, base, prior?.candidate ?? base, folders);
      if (!form || form.state !== 'editing') return show(expired);
      return show('Le formulaire est prêt. Cliquez sur Remplir le formulaire, complétez les champs puis choisissez Vérifier. Une confirmation apparaîtra ensuite dans ce fil du canal. Aucun projet modifié à cette étape.', [
        { label: 'Remplir le formulaire', action: 'configuration_open', value: form.id, bound: true, style: 'primary' },
        { label: 'Actualiser les dossiers', action: 'configuration_prepare', value: `form:${form.id}`, bound: true },
        { label: 'Annuler', action: 'configuration_cancel', value: form.id, bound: true },
      ]);
    }
    if (payload.action === 'configuration_save' || payload.action === 'configuration_cancel') {
      const form = await this.saved.get(actor, bound.value);
      if (!form || form.channel !== actor.channel) return show(expired);
      const cancel = payload.action === 'configuration_cancel';
      if (!cancel && form.state === 'ready') {
        const problem = await this.problem(actor, form);
        if (problem) return show(`${problem}\nAucune configuration enregistrée.`, [{ label: 'Corriger le formulaire', action: 'configuration_prepare', value: `form:${form.id}`, bound: true }]);
      }
      const state = await this.saved.finish(actor, form.id, cancel);
      return show(state === 'applied' ? `Projet ${form.candidate!.name} enregistré. ${form.candidate!.enabled ? 'Projet activé.' : 'Projet suspendu.'}` : state === 'already_applied' ? 'Cette configuration a déjà été enregistrée. Aucune nouvelle modification.' : state === 'cancelled' ? 'Configuration annulée. Aucune nouvelle modification.' : 'Configuration non enregistrée : formulaire expiré ou projet modifié. Rouvrez le projet pour continuer.', [], state === 'applied' || state === 'already_applied' ? [{ label: 'Ouvrir le projet', page: projectPage(form.candidate!.id) }, ...home] : home);
    }
    return show(expired);
  }
}
