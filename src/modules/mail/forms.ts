import { GuidedForms, type FormDefinition, type FormField } from '../../core/forms.js';
import type { Sql } from '../../core/store.js';
import { validateRule, type Rule, type RuleInput } from './domain.js';

export type RuleFormResult = { rule: RuleInput; base?: Rule };
export class RuleForms extends GuidedForms<RuleFormResult> {
  constructor(sql: Sql, token: string) {
    super(sql, 'mail', token, (form, values) => {
      const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      // Retained forms from before the split still carry an editable kind field.
      const kind = form.definition.context.kind ?? values.kind;
      try {
        const rule = validateRule({ name: values.name, category: values.category, kind, condition: values.condition,
          senders: form.definition.fields.filter(field => field.key.startsWith('senders_')).flatMap(field => lines(String(values[field.key]))),
          labels: lines(String(values.labels)), action: values.action,
          examples: [values.example0, values.example1, values.example2].map(value => String(value ?? '').trim()).filter(Boolean) });
        return { data: { rule, ...(form.definition.context.base ? { base: form.definition.context.base as Rule } : {}) } };
      } catch {
        return { errors: { condition: `Vérifiez les champs : ${kind === 'sender' ? 'adresse e-mail exacte pour chaque expéditeur, ' : ''}libellés personnalisés, et au moins un exemple.` } };
      }
    });
  }
  definition(base?: Rule, kind: RuleInput['kind'] = base?.kind ?? 'sender'): FormDefinition {
    const choices = (key: string, label: string, entries: Array<[string, string]>, initial: string): FormField => ({ key, label, kind: 'choice', required: true, choices: entries.map(([value, label]) => ({ value, label })), initial });
    const groups: string[][] = [];
    for (const sender of base?.senders ?? []) {
      if (!groups.length || groups.at(-1)!.join('\n').length + sender.length + 1 > 2800) groups.push([]);
      groups.at(-1)!.push(sender);
    }
    if (!groups.length) groups.push([]);
    return { title: kind === 'sender' ? 'Règle par expéditeur' : 'Règle par contenu', context: { kind, ...(base ? { base } : {}) }, fields: [
      { key: 'name', label: 'Nom de la règle', required: true, max: 100, initial: base?.name },
      choices('category', 'Catégorie', [['custom', 'Personnalisée'], ['urgent', 'Urgent'], ['project', 'Projet'], ['newsletter', 'Lettres d’information']], base?.category ?? 'custom'),
      { key: 'condition', label: 'Condition et exceptions', kind: 'lines', max: 1200, required: true, initial: base?.condition,
        ...(kind === 'semantic' ? { hint: 'L’analyse du contenu utilise le budget d’IA lors du tri, pas lors de la création de cette règle.' } : {}) },
      ...(kind === 'sender' ? groups.map((group, index): FormField => ({ key: `senders_${index}`, label: index ? `Expéditeurs — suite ${index + 1}` : 'Expéditeurs — une adresse e-mail par ligne', kind: 'lines', required: groups.length === 1, max: 3000, initial: group.join('\n'), hint: 'Au moins une adresse e-mail exacte. 100 adresses maximum au total.' })) : []),
      { key: 'labels', label: 'Libellés personnalisés — un par ligne', kind: 'lines', max: 1100, initial: base?.labels.join('\n'), hint: '10 libellés maximum ; aucun libellé système Gmail.' },
      choices('action', 'Action proposée', [['label', 'Appliquer les libellés'], ['keep', 'Conserver dans la boîte de réception'], ['archive', 'Archiver'], ['trash', 'Mettre à la corbeille']], base?.action ?? 'keep'),
      ...[0, 1, 2].map((index): FormField => ({ key: `example${index}`, label: `Exemple ${index + 1}`, required: index === 0, max: 300, initial: base?.examples[index] })),
    ] };
  }
}
