import { formatNumber } from '../../core/presentation.js';
import { escapeCardValue } from '../../core/slack.js';
import type { StatusCatalogue, StatusChoice, StatusFilter } from './domain.js';

export function matchesStatus(filter: StatusFilter, name: string, unfinished: boolean): boolean {
  return filter.mode === 'custom' ? filter.names.includes(name)
    : !filter.excludeNames?.includes(name) && (unfinished || !!filter.includeNames?.includes(name));
}

export function filterNames(filter: StatusFilter): string[] {
  return filter.mode === 'custom' ? filter.names : [...(filter.includeNames ?? []), ...(filter.excludeNames ?? [])];
}

export function changeStatus(filter: StatusFilter, catalogue: StatusCatalogue, choice: StatusChoice, add: boolean): StatusFilter {
  // A partial default cannot be converted into an exact list without losing unseen statuses.
  if (filter.mode === 'default' && (!catalogue.complete || filterNames(filter).length)) {
    const includeNames = new Set(filter.includeNames), excludeNames = new Set(filter.excludeNames);
    if (add) { excludeNames.delete(choice.name); includeNames.add(choice.name); }
    else { includeNames.delete(choice.name); excludeNames.add(choice.name); }
    return { mode: 'default', includeNames: [...includeNames], excludeNames: [...excludeNames] };
  }
  const names = new Set(filter.mode === 'custom' ? filter.names : catalogue.choices.filter(item => item.unfinished).map(item => item.name));
  if (add) names.add(choice.name); else names.delete(choice.name);
  return { mode: 'custom', names: [...names] };
}

export function filterSummary(filter: StatusFilter): string {
  const names = filterNames(filter);
  const text = filter.mode === 'custom' ? names.map(escapeCardValue).join(', ')
    : `tous les statuts non terminés${filter.excludeNames?.length ? ` ; sauf : ${filter.excludeNames.map(escapeCardValue).join(', ')}` : ''}${filter.includeNames?.length ? ` ; inclus explicitement : ${filter.includeNames.map(escapeCardValue).join(', ')}` : ''}`;
  return text.length > 1500 ? `${formatNumber(names.length)} ${filter.mode === 'custom' ? 'statuts' : 'exceptions'} : ${text.slice(0, 1499)}… Consultez clickup statuts pour la sélection complète.` : text;
}
