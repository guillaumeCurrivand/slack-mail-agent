import { afterEach, expect, it, vi } from 'vitest';
import { ClickupAPI } from '../src/modules/clickup/api.js';
import { taskPage } from '../src/modules/clickup/tasks.js';
import type { Scan } from '../src/modules/clickup/domain.js';

afterEach(() => vi.useRealTimers());

it('checks a full task page in bounded parallel waves, retaining order and withholding denied tasks', async () => {
  vi.useFakeTimers();
  let active = 0, peak = 0, checked = 0;
  const api = new ClickupAPI('fake', (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/user')) return Response.json({ user: { id: 7, email: 'alice@example.com' } });
    if (path.endsWith('/team')) return Response.json({ teams: [{ id: '42', name: 'Workspace' }] });
    const id = path.split('/').at(-1)!;
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 100));
    active--; checked++;
    return id === '2' ? new Response('', { status: 403 }) : Response.json({ id });
  }) as typeof fetch);
  const scan: Scan = { connectionId: 'connection', page: 1, seen: [], complete: true, finished: true, notice: '', retrievedAt: new Date().toISOString(),
    tasks: Array.from({ length: 40 }, (_, i) => ({ id: String(i), name: `Task ${i}`, status: 'Open', statusType: 'open', archived: false, assignees: ['7'], due: null, priority: '', workspace: 'Workspace', list: 'List', url: `https://app.clickup.com/t/${i}` })) };
  const start = Date.now();
  const result = taskPage(api, scan, { id: 'connection', identity: { id: '7', name: 'Alice', email: 'alice@example.com' }, tokens: '' }, '42', 'source', 0);
  await vi.runAllTimersAsync();
  const page = await result;
  expect(checked).toBe(40);
  expect(peak).toBeLessThanOrEqual(4);
  expect(page.table?.rows.map(row => (row[0] as Array<{ text: string }>)[0]!.text)).toEqual(scan.tasks.filter(task => task.id !== '2').map(task => task.name));
  expect(page.text).toContain('masquées');
  expect(Date.now() - start).toBeLessThanOrEqual(1000);
});
