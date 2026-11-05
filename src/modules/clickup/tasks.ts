import type { Actor } from '../../core/identity.js';
import { formatDate, formatNumber } from '../../core/presentation.js';
import type { MenuPage } from '../../core/navigation.js';
import type { Button } from '../../core/slack.js';
import { ClickupAPI, ClickupError } from './api.js';
import type { Connection, Scan, StatusFilter, Task } from './domain.js';
import { ClickupStore } from './store.js';
import { filterSummary, matchesStatus } from './status-filter.js';

const day = (value: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
const date = (value: number) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
const eligible = (task: Task, subject: string, filter: StatusFilter) => !task.archived && task.assignees.includes(subject) && matchesStatus(filter, task.status, !['done', 'closed'].includes(task.statusType));
const sort = (a: Task, b: Task) => (a.due === null ? '9999-99-99' : day(a.due)).localeCompare(b.due === null ? '9999-99-99' : day(b.due)) || a.name.localeCompare(b.name, 'fr') || a.id.localeCompare(b.id);

export async function retrieveTasks(store: ClickupStore, api: ClickupAPI, actor: Actor, connection: Connection, workspaceId: string, eventId: string, filter: StatusFilter = { mode: 'default' }): Promise<Scan> {
  let scan = await store.scan(actor, eventId, true);
  if (scan && (scan.connectionId !== connection.id || Date.now() - Date.parse(scan.retrievedAt) >= 86400_000)) return { ...scan, tasks: [], finished: true, complete: false, notice: 'Ces résultats sont expirés ou liés à une ancienne connexion. Relancez clickup tâches.' };
  if (scan?.finished) return scan;
  scan ??= { connectionId: connection.id, filter, page: 0, tasks: [], seen: [], complete: false, finished: false, notice: '', retrievedAt: new Date().toISOString() };
  // Pre-extension snapshots retain their original default, including unfinished retries.
  scan.filter ??= { mode: 'default' };
  await store.saveScan(actor, eventId, scan);
  try {
    const identity = await api.identity();
    if (identity.id !== connection.identity.id) throw new Error('Identity changed');
    const workspace = await api.workspace(workspaceId);
    const seen = new Set(scan.seen);
    while (!scan.finished) {
      // Local name matching preserves unavailable selections without provider-side invalid-name errors.
      const page = await api.tasks(workspaceId, connection.identity.id, scan.page, scan.filter.mode === 'custom' || !!scan.filter.includeNames?.length);
      if (!page.length) { scan.finished = true; scan.complete = !scan.notice; break; }
      let newIds = 0;
      for (let value of page) {
        const id = typeof value === 'object' && value !== null && 'id' in value ? String(value.id) : '';
        if (!/^[\w-]{1,128}$/.test(id)) { scan.notice = 'Certaines tâches ont des métadonnées indisponibles.'; continue; }
        if (seen.has(id)) continue;
        seen.add(id); newIds++;
        try {
          // Workspace responses sometimes omit archived: resolve the task's own flag.
          if (!('archived' in (value as object))) value = await api.task(id);
          const task = api.parseTask(value, workspace);
          if (eligible(task, connection.identity.id, scan.filter)) scan.tasks.push(task);
        } catch { scan.notice = 'Certaines tâches ont des métadonnées ou un accès indisponibles.'; }
      }
      scan.seen = [...seen]; scan.page++;
      if (!newIds) { scan.finished = true; scan.notice = 'La pagination ClickUp n’a pas progressé.'; }
      await store.saveScan(actor, eventId, scan);
    }
  } catch (error) {
    scan.finished = true; scan.complete = false;
    scan.notice = error instanceof ClickupError && [401, 403].includes(error.status) ? 'Le compte ou l’accès à Mayasquad est indisponible. Reconnectez ClickUp.' : 'La récupération ClickUp n’a pas pu être terminée.';
  }
  scan.tasks.sort(sort);
  await store.saveScan(actor, eventId, scan);
  return scan;
}

export async function taskPage(api: ClickupAPI, scan: Scan, connection: Connection, workspaceId: string, sourceId: string, requestedPage: number): Promise<MenuPage> {
  // Keep complete names and locations; use smaller pages when values are long.
  const pages: Task[][] = [[]];
  const tableBudget = Math.max(1000, 16_000 - filterSummary(scan.filter ?? { mode: 'default' }).length);
  let size = 0;
  for (const task of scan.tasks) {
    const length = task.name.length + task.url.length + task.status.length + task.priority.length + task.workspace.length + task.list.length + 80;
    if (pages.at(-1)!.length && (pages.at(-1)!.length >= 40 || size + length > tableBudget)) { pages.push([]); size = 0; }
    pages.at(-1)!.push(task); size += length;
  }
  const count = pages.length, page = Math.max(0, Math.min(requestedPage, count - 1));
  const visible = pages[page]!, accessible: Task[] = [];
  let accessNotice = '';
  try {
    const identity = await api.identity();
    if (identity.id !== connection.identity.id) throw new Error('Identity changed');
    await api.workspace(workspaceId);
    // Bound provider pressure while avoiding one network round trip per visible row.
    // No cross-request access cache: every displayed task is checked on every page.
    for (let offset = 0; offset < visible.length; offset += 4) {
      const batch = visible.slice(offset, offset + 4);
      const checks = await Promise.allSettled(batch.map(saved => api.task(saved.id)));
      checks.forEach((result, index) => {
        if (result.status === 'fulfilled') accessible.push(batch[index]!);
        else accessNotice = 'Certaines tâches ne sont plus accessibles ou leur accès ne peut pas être vérifié ; elles sont masquées.';
      });
    }
  } catch { accessNotice = 'L’accès au compte ou à Mayasquad ne peut pas être vérifié. Aucun contenu de tâche n’est affiché. Reconnectez ClickUp.'; }
  const buttons: Button[] = [];
  if (page > 0) buttons.push({ label: 'Précédent', action: 'page', value: `${sourceId}|${page - 1}` });
  if (page + 1 < count) buttons.push({ label: 'Suivant', action: 'page', value: `${sourceId}|${page + 1}` });
  buttons.push({ label: 'Actualiser', action: 'tasks', value: 'tasks' });
  buttons.push({ label: 'Choisir les statuts', action: 'statuses', value: 'statuses' });
  if (!scan.complete) buttons.push({ label: 'Réessayer', action: 'tasks', value: 'tasks' });
  const text = [
    scan.complete ? `${formatNumber(scan.tasks.length)} tâches · Page ${formatNumber(page + 1)}/${formatNumber(count)}.` : `Résultats incomplets : ${formatNumber(scan.tasks.length)} tâches récupérées · Page ${formatNumber(page + 1)}/${formatNumber(count)}.`,
    `Récupération : ${formatDate(scan.retrievedAt)}. Les pages conservent cet instantané ; les accès sont revérifiés.`,
    `Filtre appliqué : ${filterSummary(scan.filter ?? { mode: 'default' })}.`,
    scan.complete && !scan.tasks.length ? 'Aucune tâche assignée correspondant à ce filtre dans Mayasquad.' : '',
    scan.notice, accessNotice,
  ].filter(Boolean).join('\n');
  // Result paging must revisit this handler and recheck live task access, never cached display rows.
  return { kind: 'Mes tâches ClickUp', text, bindButtons: true, buttons, tablePaging: false,
    ...(accessible.length ? { table: { columns: ['Tâche', 'Statut', 'Échéance', 'Priorité', 'Workspace', 'Liste'], rows: accessible.map(task => [
      [{ text: task.name, url: task.url }], task.status, task.due === null ? '—' : `${date(task.due)}${day(task.due) < day(Date.now()) ? ' · En retard' : ''}`, task.priority, task.workspace, task.list,
    ]) } } : {}),
  };
}
