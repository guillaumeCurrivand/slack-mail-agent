import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { localServiceSchema, startLocalService, startLocalServices, type LocalService } from '../src/modules/development/local-services.js';

const directories: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('mayassistant-services-')) throw new Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mayassistant-services-')); directories.push(directory);
  return directory;
}
async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
function service(id: string, cwd: string, port: number, before = ''): LocalService {
  return { id, cwd, readyUrl: `http://127.0.0.1:${port}/health`, startupTimeoutMs: 10000,
    start: [process.execPath, '-e', `(async()=>{${before}require('node:http').createServer((q,r)=>r.end('ready')).listen(${port},'127.0.0.1')})().catch(()=>process.exit(1))`] };
}
async function unreachable(url: string) {
  try { await fetch(url, { signal: AbortSignal.timeout(200) }); return false; } catch { return true; }
}

it('starts dependent services in order and stops its own processes', async () => {
  const directory = await fixture(), first = service('backend', directory, await freePort());
  const second = service('tunnel', directory, await freePort(), `if(!(await fetch(${JSON.stringify(first.readyUrl)})).ok)throw Error();`);
  const stop = await startLocalServices([first, second], directory, process.env); stops.push(stop);
  expect(await (await fetch(second.readyUrl)).text()).toBe('ready');
  await stop();
  await expect.poll(() => unreachable(first.readyUrl)).toBe(true);
  await expect.poll(() => unreachable(second.readyUrl)).toBe(true);
});

it('cleans up earlier services when a later service crashes', async () => {
  const directory = await fixture(), first = service('backend', directory, await freePort());
  const second = { ...service('tunnel', directory, await freePort()), start: [process.execPath, '-e', 'process.exit(1)'] };
  await expect(startLocalServices([first, second], directory, process.env)).rejects.toThrow('tunnel : démarrage échoué');
  await expect.poll(() => unreachable(first.readyUrl)).toBe(true);
});

it('reuses only a tunnel matching the approved origin and local upstream, and leaves it running', async () => {
  const directory = await fixture();
  let addr = 'http://localhost:8087';
  const server = createServer((_, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ tunnels: [{ public_url: 'https://test.example.com', config: { addr } }] })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  stops.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const config: LocalService = { ...service('ngrok', directory, (server.address() as { port: number }).port), reuseExisting: true, ngrok: { publicOrigin: 'https://test.example.com', upstreamPort: 8087 } };
  const stop = await startLocalService(config, directory, process.env);
  await stop();
  expect((await fetch(config.readyUrl)).ok).toBe(true);
  await expect(startLocalService({ ...config, ngrok: { ...config.ngrok!, publicOrigin: 'https://other.example.com' } }, directory, process.env)).rejects.toThrow('non conforme');
  addr = 'http://localhost:9090';
  await expect(startLocalService(config, directory, process.env)).rejects.toThrow('non conforme');
  addr = 'http://remote.example.com:8087';
  await expect(startLocalService(config, directory, process.env)).rejects.toThrow('non conforme');
  expect((await fetch(config.readyUrl)).ok).toBe(true);
});

it('does not accept a remote readiness URL or a service name that escapes the log directory', () => {
  const config = service('backend', 'test', 8087);
  expect(localServiceSchema.safeParse(config).success).toBe(true);
  expect(localServiceSchema.safeParse({ ...config, readyUrl: 'https://example.com' }).success).toBe(false);
  expect(localServiceSchema.safeParse({ ...config, id: '../outside' }).success).toBe(false);
});
