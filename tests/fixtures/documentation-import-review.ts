import { readFileSync } from 'node:fs';
import { reviewSnapshot, type ImportReview } from '../../src/modules/documentation/import.js';

export const importSnapshot = readFileSync(new URL('./documentation-import.json', import.meta.url), 'utf8');
export const importConfig = { workspace: 'TTEAM', enabledModules: ['documentation'] };
// Synthetic User decisions, deliberately independent of automatic suggestions.
export function resolvedImportReview(): ImportReview {
  const review = reviewSnapshot(importSnapshot, importConfig);
  const evidence = (cell: string, reason: string) => [{ cell, reason }];
  const tool = review.records.find(record => record.kind === 'tool')!;
  tool.fields = { name: 'Tracker', usage: 'Alpha / Unknown project', projects: ['@project-1'] };
  tool.evidence.usage = evidence('Tools!B2', 'Retain exact unmatched usage text');
  tool.evidence.projects = evidence('Tools!B2', 'User confirms Alpha means the Project; Unknown project is descriptive unresolved usage, not company-wide use');
  review.records.push(
    { key: 'react', kind: 'technology', fields: { name: 'React' }, evidence: { name: evidence('Components!C2', 'User confirms + separates two technologies') } },
    { key: 'node', kind: 'technology', fields: { name: 'Node' }, evidence: { name: evidence('Components!C2', 'User confirms + separates two technologies') } },
    { key: 'web', kind: 'component', fields: { name: 'Web', projectId: '@project-1', technologies: ['@react', '@node'] }, evidence: {
      name: evidence('Components!A2', 'Explicit component name'), projectId: evidence('Components!B2', 'User confirms Alpha Project identity'), technologies: evidence('Components!C2', 'Both technologies belong to Web'),
    } },
    { key: 'production', kind: 'hosting', fields: { componentId: '@web', serviceId: '@host-3', environment: 'production' }, evidence: {
      componentId: evidence('Components!A2', 'Environment row belongs to Web'), serviceId: evidence('Components!E2', 'User identifies Cloud A2 as compute, A3 as distinct database service'), environment: evidence('Components!D2', 'Explicit environment cell'),
    } },
  );
  for (const warning of review.warnings) review.resolutions[warning] = 'User confirms Cloud A2 and A3 are distinct services; no name merge';
  for (const cell of review.cells) {
    const records = review.records.filter(record => Object.values(record.evidence).flat().some(entry => entry.cell === cell.cell)).map(record => record.key);
    cell.decision = records.length ? { disposition: 'mapped', records, reason: 'Synthetic User resolved mapping with recorded field evidence' }
      : { disposition: 'ignored', records: [], reason: 'Column header, retained in frozen source' };
  }
  return review;
}
