import { expect, it, vi } from 'vitest';
import { ClickupDevelopment } from '../src/modules/development/providers.js';

it('prepares a complete eight-Space form catalogue within four provider round trips', async () => {
  vi.useFakeTimers();
  try {
    let active = 0, peak = 0;
    const client = new ClickupDevelopment('fake', (async input => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 100));
      active--;
      const path = new URL(String(input)).pathname;
      return Response.json(path.endsWith('/team') ? { teams: [{ id: '1', name: 'Workspace' }] }
        : path.endsWith('/space') ? { spaces: Array.from({ length: 8 }, (_, i) => ({ id: String(i + 10), name: `Space ${i}` })) }
          : { folders: [{ id: path.split('/').at(-2), name: 'Folder' }] });
    }) as typeof fetch);
    const start = Date.now();
    const result = client.folders();
    await vi.runAllTimersAsync();
    expect(await result).toHaveLength(8);
    expect(Date.now() - start).toBeLessThanOrEqual(400);
    expect(peak).toBeLessThanOrEqual(4);
  } finally { vi.useRealTimers(); }
});

function provider(responses: Record<string, unknown>) {
  const paths: string[] = [];
  const client = new ClickupDevelopment('integration-token', (async (input, init) => {
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).Authorization).toBe('integration-token');
    const url = new URL(String(input)); const path = url.pathname.replace('/api/v2', '') + url.search;
    paths.push(path);
    return path in responses ? Response.json(responses[path]) : Response.json({}, { status: 403 });
  }) as typeof fetch);
  return { client, paths };
}

it('discovers named folders across authorized Workspaces and active Spaces without merging duplicate names', async () => {
  const { client, paths } = provider({
    '/team': { teams: [{ id: '1', name: 'Maya' }, { id: '2', name: 'Client' }] },
    '/team/1/space?archived=false': { spaces: [{ id: '10', name: 'Frontend' }, { id: '11', name: 'Archive', archived: true }] },
    '/team/2/space?archived=false': { spaces: [{ id: '20', name: 'Backend' }] },
    '/space/10/folder?archived=false': { folders: [{ id: '100', name: 'Maintenance' }, { id: '101', name: 'Archived', archived: true }] },
    '/space/20/folder?archived=false': { folders: [{ id: '200', name: 'Maintenance' }] },
  });
  expect(await client.folders()).toEqual([
    { id: '200', name: 'Maintenance', workspace: 'Client', space: 'Backend' },
    { id: '100', name: 'Maintenance', workspace: 'Maya', space: 'Frontend' },
  ]);
  expect(paths).not.toContain('/space/11/folder?archived=false');
});

it.each([{}, { folders: [{ id: 'not-an-id', name: 'Broken' }] }, { folders: [{ id: '3' }] }])('rejects incomplete folder discovery instead of returning a partial catalogue: %j', async bad => {
  const { client } = provider({
    '/team': { teams: [{ id: '1', name: 'Maya' }] },
    '/team/1/space?archived=false': { spaces: [{ id: '10', name: 'Good' }, { id: '20', name: 'Broken' }] },
    '/space/10/folder?archived=false': { folders: [{ id: '100', name: 'Known folder' }] },
    '/space/20/folder?archived=false': bad,
  });
  await expect(client.folders()).rejects.toThrow('Catalogue ClickUp incomplet');
});

it('fails discovery on a denied Space and distinguishes an empty authorized inventory', async () => {
  await expect(provider({ '/team': { teams: [] } }).client.folders()).resolves.toEqual([]);
  await expect(provider({ '/team': { teams: [{ id: '1', name: 'Maya' }] } }).client.folders()).rejects.toThrow('403');
});

it('shares in-flight catalogue reads, expires successful snapshots and forces refresh without caching failures', async () => {
  vi.useFakeTimers();
  try {
    let calls = 0, denied = false;
    const client = new ClickupDevelopment('fake', (async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 100));
      return Response.json(denied ? {} : { teams: [] }, { status: denied ? 403 : 200 });
    }) as typeof fetch);
    const first = client.folders(), second = client.folders();
    await vi.runAllTimersAsync();
    expect(await first).toEqual(await second);
    expect(calls).toBe(1);
    await client.folders(); expect(calls).toBe(1);
    const refresh = client.folders(true); await vi.runAllTimersAsync(); await refresh;
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(60_001);
    const expired = client.folders(); await vi.runAllTimersAsync(); await expired;
    expect(calls).toBe(3);
    denied = true;
    const failed = expect(client.folders(true)).rejects.toThrow('403');
    await vi.runAllTimersAsync(); await failed;
    denied = false;
    const retry = client.folders(); await vi.runAllTimersAsync(); await retry;
    expect(calls).toBe(5);
  } finally { vi.useRealTimers(); }
});
