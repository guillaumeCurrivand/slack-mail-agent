import { isDeepStrictEqual } from 'node:util';
import type { AssistantModule } from './modules.js';
import { ownerKey, uid, type Actor } from './identity.js';
import { JobStore, type Sql } from './store.js';

export type FormChoice = { value: string; label: string };
export type FormField = { key: string; label: string; kind?: 'text' | 'lines' | 'choice' | 'choices'; required?: boolean; max?: number; limit?: number; hint?: string; choices?: FormChoice[]; initial?: string | string[] | null };
export type FormDefinition = { title: string; fields: FormField[]; context: Record<string, unknown> };
export type SavedForm<T = unknown> = { id: string; channel: string; timestamp: string; definition: FormDefinition; state: string; result: T | null };
export type FormValues = Record<string, string | string[]>;
type Validation<T> = { data: T; errors?: never } | { data?: never; errors: Record<string, string> };
const plain = (text: string) => ({ type: 'plain_text', text });
const option = (choice: FormChoice) => ({ text: plain(choice.label.slice(0, 75)), value: choice.value });

/** Delivery and durable input capture only. Modules own fields, validation and proposals. */
export class GuidedForms<T> {
  private table: string;
  constructor(private sql: Sql, private module: string, private token: string,
    private validate: (form: SavedForm<T>, values: FormValues) => Validation<T>, private fetcher: typeof fetch = fetch) {
    if (!/^[a-z][a-z0-9_]*$/.test(module)) throw new Error('Invalid form module.');
    this.table = `${module}_guided_forms`;
  }
  async initialize() {
    await this.sql.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      id text PRIMARY KEY, owner text NOT NULL, channel text NOT NULL, timestamp text NOT NULL,
      source text NOT NULL, definition jsonb NOT NULL, state text NOT NULL DEFAULT 'editing', result jsonb,
      opens text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,source))`);
  }
  async get(actor: Pick<Actor, 'team' | 'user'>, id: string): Promise<SavedForm<T> | undefined> {
    return (await this.sql.query(`SELECT * FROM ${this.table} WHERE id=$1 AND owner=$2 AND created_at>=now()-interval '24 hours'`, [id, ownerKey(actor)])).rows[0];
  }
  async prepare(actor: Actor, source: string, timestamp: string, definition: FormDefinition): Promise<SavedForm<T>> {
    return (await this.sql.query(`INSERT INTO ${this.table}(id,owner,channel,timestamp,source,definition) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(owner,source) DO UPDATE SET source=excluded.source RETURNING *`, [uid(), ownerKey(actor), actor.channel, timestamp, source, JSON.stringify(definition)])).rows[0];
  }
  async cleanup() {
    await this.sql.query(`DELETE FROM ${this.table} f WHERE created_at<now()-interval '24 hours'
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.module=$1 AND j.payload->>'form'=f.id AND j.status IN ('queued','running'))`, [this.module]);
  }
  private view(form: SavedForm<T>) {
    return { type: 'modal', callback_id: `${this.module}:guided`, private_metadata: form.id,
      title: plain(form.definition.title.slice(0, 24)), submit: plain('Vérifier'), close: plain('Annuler'), blocks: [
        { type: 'section', text: plain('Vérifiez les valeurs. Une proposition apparaîtra dans le message de départ ; votre confirmation séparée reste nécessaire.') },
        ...form.definition.fields.map(field => {
          const selected = (field.choices ?? []).filter(choice => Array.isArray(field.initial) ? field.initial.includes(choice.value) : field.initial === choice.value);
          const element = field.kind === 'choices'
            ? { type: 'multi_external_select', action_id: 'value', min_query_length: 0, max_selected_items: field.limit ?? 50, ...(selected.length ? { initial_options: selected.map(option) } : {}) }
            : field.kind === 'choice'
              ? { type: 'external_select', action_id: 'value', min_query_length: 0, ...(selected[0] ? { initial_option: option(selected[0]) } : {}) }
              : { type: 'plain_text_input', action_id: 'value', max_length: field.max ?? 1500, ...(field.kind === 'lines' ? { multiline: true } : {}), ...(typeof field.initial === 'string' && field.initial ? { initial_value: field.initial } : {}) };
          return { type: 'input', block_id: field.key, label: plain(field.label), optional: !field.required, ...(field.hint ? { hint: plain(field.hint) } : {}), element };
        }),
      ] };
  }
  readonly forms: NonNullable<AssistantModule['forms']> = {
    openActions: ['form_open'], callbacks: ['guided'],
    suggest: async (actor, input) => {
      const form = await this.get(actor, input.form);
      if (!form || form.state !== 'editing' || input.action !== 'value') return { options: [] };
      const field = form.definition.fields.find(field => field.key === input.block);
      const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr');
      const terms = normalize(input.query).split(/\s+/).filter(Boolean);
      return { options: (field?.choices ?? []).filter(choice => terms.every(term => normalize(choice.label).includes(term))).slice(0, 100).map(option) };
    },
    open: async (actor, input, eventId) => {
      const form = await this.get(actor, input.value);
      if (!form || form.channel !== actor.channel || form.timestamp !== input.timestamp || form.state !== 'editing') {
        await new JobStore(this.sql).enqueue(`${this.module}:form-notice:${eventId}`, actor, { type: 'guided_form_notice', timestamp: input.timestamp }, this.module);
        return;
      }
      const claimed = await this.sql.query(`UPDATE ${this.table} SET opens=array_append(opens,$3) WHERE id=$1 AND owner=$2 AND NOT ($3=ANY(opens)) RETURNING id`, [form.id, ownerKey(actor), eventId]);
      if (!claimed.rows.length) return;
      try {
        const response = await this.fetcher('https://slack.com/api/views.open', { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ trigger_id: input.trigger, view: this.view(form) }), signal: AbortSignal.timeout(1800) });
        if (!response.ok || !(await response.json() as { ok?: boolean }).ok) throw new Error('Form unavailable');
      } catch {
        await new JobStore(this.sql).enqueue(`${this.module}:form-notice:${eventId}`, actor, { type: 'guided_form_notice', form: form.id, timestamp: form.timestamp }, this.module);
      }
    },
    submit: async (actor, view) => {
      const form = await this.get(actor, view.private_metadata);
      const error = (message: string) => ({ response_action: 'errors', errors: { [form?.definition.fields[0]?.key ?? 'name']: message } });
      if (!form) return error('Formulaire expiré ou inaccessible. Fermez-le et rouvrez le formulaire depuis le menu.');
      const raw = view.state?.values;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return error('Champs invalides.');
      const values: FormValues = {}, errors: Record<string, string> = {};
      for (const field of form.definition.fields) {
        const input = (raw as Record<string, any>)[field.key]?.value;
        if (field.kind === 'choices' && input?.selected_options != null && !Array.isArray(input.selected_options)) {
          errors[field.key] = 'Sélection invalide.'; continue;
        }
        const value = input === undefined ? field.initial ?? (field.kind === 'choices' ? [] : '')
          : field.kind === 'choices' ? input?.selected_options?.map((item: any) => item?.value) ?? []
            : field.kind === 'choice' ? input?.selected_option?.value ?? '' : input?.value ?? '';
        const choices = field.choices?.map(choice => choice.value) ?? [];
        if (field.kind === 'choices') {
          if (!Array.isArray(value) || value.length > (field.limit ?? 50) || new Set(value).size !== value.length || value.some(item => typeof item !== 'string' || !choices.includes(item))) errors[field.key] = 'Sélection invalide. Utilisez les choix proposés.';
        } else if (typeof value !== 'string' || value.length > (field.max ?? 1500) || (field.kind === 'choice' && value && !choices.includes(value))) errors[field.key] = 'Valeur invalide. Utilisez les limites et choix proposés.';
        if (field.required && !value?.length) errors[field.key] = 'Ce champ est requis.';
        values[field.key] = value;
      }
      if (Object.keys(errors).length) return { response_action: 'errors', errors };
      const parsed = this.validate(form, values);
      if (parsed.errors) return { response_action: 'errors', errors: parsed.errors };
      if (form.state !== 'editing') return isDeepStrictEqual(form.result, parsed.data) ? {} : error('Ce formulaire a déjà été transmis. Rouvrez-en un nouveau.');
      // Capture accepted input and its job together; no provider request or mutation here.
      const accepted = await this.sql.query(`WITH accepted AS (
        UPDATE ${this.table} SET state='submitted',result=$3 WHERE id=$1 AND owner=$2 AND state='editing' AND created_at>=now()-interval '24 hours' RETURNING channel,timestamp
      ) INSERT INTO jobs(id,owner,actor,payload,module)
        SELECT $4,$2,$5::jsonb || jsonb_build_object('channel',channel),jsonb_build_object('type','guided_form','form',$1::text,'timestamp',timestamp),$6 FROM accepted
        ON CONFLICT DO NOTHING RETURNING id`, [form.id, ownerKey(actor), JSON.stringify(parsed.data), `${this.module}:form:${form.id}`, JSON.stringify(actor), this.module]);
      if (accepted.rows.length) return {};
      const current = await this.get(actor, form.id);
      return current?.state === 'submitted' && isDeepStrictEqual(current.result, parsed.data) ? {} : error('Ce formulaire est indisponible.');
    },
  };
}
