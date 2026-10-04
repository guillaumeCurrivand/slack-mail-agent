import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { browserConfigSchema, browserScenarioSchema, replayBrowser, startPreview } from '../src/modules/development/browser.js';

it('rejects a screenshot-only scenario and preview navigation outside localhost', () => {
  expect(browserScenarioSchema.safeParse({ description: 'Render', steps: [{ action: 'navigate', path: '/' }, { action: 'expectVisible', selector: 'h1' }, { action: 'expectText', selector: 'h1', text: 'Hello' }] }).success).toBe(false);
  expect(browserConfigSchema.safeParse({ url: 'https://example.com', start: ['server'] }).success).toBe(false);
});

it('does not reuse a preview belonging to another checkout', async () => {
  const server = createServer((_, response) => response.end('Other checkout'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const config = browserConfigSchema.parse({ url: `http://127.0.0.1:${port}`, start: ['unused'] });
    await expect(startPreview(config, process.cwd(), os.tmpdir(), {})).rejects.toThrow('déjà utilisé');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it.each([{ timeout: 1000, ready: false }, { timeout: 10000, ready: true }])('honors the preview startup allowance ($timeout ms) and releases its port', async ({ timeout, ready }) => {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mayassistant-preview-test-'));
  let stop: (() => Promise<void>) | undefined;
  try {
    const config = browserConfigSchema.parse({
      url: `http://127.0.0.1:${port}`, startupTimeoutMs: timeout,
      start: [process.execPath, '-e', `const http = require('node:http'); setTimeout(() => http.createServer((_, res) => res.end('Ready')).listen(${port}, '127.0.0.1'), 2500);`],
    });
    if (ready) {
      stop = await startPreview(config, directory, directory, process.env);
      expect(await (await fetch(config.url)).text()).toBe('Ready');
      await stop(); stop = undefined;
    } else {
      const started = performance.now();
      await expect(startPreview(config, directory, directory, process.env)).rejects.toThrow('1000 ms');
      expect(performance.now() - started).toBeLessThan(8000);
    }
    await expect.poll(async () => {
      try { await fetch(config.url, { signal: AbortSignal.timeout(200) }); return false; } catch { return true; }
    }).toBe(true);
  } finally {
    await stop?.();
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('mayassistant-preview-test-')) throw new Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(!existsSync(chromium.executablePath()))('replays real interactions, records evidence, and rejects a failed assertion', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mayassistant-browser-test-'));
  const server = createServer((_, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<button id="go" onclick="document.querySelector(\'h1\').textContent=\'Done\'">Go</button><h1>Before</h1>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = browserConfigSchema.parse({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, start: ['unused'] });
  const scenario = { description: 'Le bouton met à jour le titre', steps: [{ action: 'navigate', path: '/' }, { action: 'click', selector: '#go' }, { action: 'expectText', selector: 'h1', text: 'Done' }] };
  try {
    expect(await replayBrowser(config, scenario, directory)).toContain('3 étapes');
    expect(JSON.parse(await readFile(path.join(directory, 'browser-result.json'), 'utf8')).passed).toBe(true);
    expect(existsSync(path.join(directory, 'browser.png'))).toBe(true);
    await expect(replayBrowser(config, { ...scenario, steps: [...scenario.steps, { action: 'expectURL', path: '/wrong' }] }, directory)).rejects.toThrow('étape 4');
    expect(JSON.parse(await readFile(path.join(directory, 'browser-result.json'), 'utf8')).passed).toBe(false);
    await expect(replayBrowser(config, { ...scenario, steps: [{ action: 'navigate', path: '//example.com' }, ...scenario.steps.slice(1)] }, directory)).rejects.toThrow('hors');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('mayassistant-browser-test-')) throw new Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  }
}, 40000);

it.skipIf(!existsSync(chromium.executablePath()))('uses only the selected account group and reports missing credentials without leaking them', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mayassistant-browser-accounts-'));
  const server = createServer((_, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<input id="email"><input id="password" type="password"><button onclick="document.querySelector(\'h1\').textContent = document.querySelector(\'#email\').value === \'local@example.invalid\' && document.querySelector(\'#password\').value === \'local-password\' ? \'Local login\' : \'Wrong account\'">Login</button><h1>Before</h1>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const accountsFile = path.join(directory, 'accounts.json');
  const local = { admin: { email: 'local@example.invalid', password: 'local-password' } };
  await writeFile(accountsFile, JSON.stringify({ local, live: { admin: { email: 'live@example.invalid', password: 'live-password' } } }));
  const input = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, start: ['unused'], accountsFile, accountsGroup: 'local', accounts: ['admin'] };
  const scenario = { description: 'Connexion locale', steps: [{ action: 'navigate', path: '/' }, { action: 'fillAccount', selector: '#email', account: 'admin', field: 'email' }, { action: 'fillAccount', selector: '#password', account: 'admin', field: 'password' }, { action: 'click', selector: 'button' }, { action: 'expectText', selector: 'h1', text: 'Local login' }] };
  try {
    const config = browserConfigSchema.parse(input);
    expect(await replayBrowser(config, scenario, directory)).toContain('5 étapes');
    const missingLoginWait = { ...scenario, steps: [...scenario.steps.slice(0, 4), { action: 'navigate', path: '/protected' }, scenario.steps[4]] };
    await expect(replayBrowser(config, missingLoginWait, directory)).rejects.toThrow('attendez sa fin avec une assertion');
    // Waiting for a visible authenticated result makes a following navigation valid.
    expect(await replayBrowser(config, { ...scenario, steps: [...scenario.steps, { action: 'navigate', path: '/protected' }, { action: 'expectText', selector: 'h1', text: 'Before' }] }, directory)).toContain('7 étapes');
    await writeFile(accountsFile, JSON.stringify({ live: { admin: { email: 'live@example.invalid', password: 'live-password' } } }));
    await expect(replayBrowser(config, scenario, directory)).rejects.toThrow('groupe de comptes');
    const failure = await readFile(path.join(directory, 'browser-result.json'), 'utf8');
    expect(JSON.parse(failure)).toMatchObject({ passed: false, step: 2, action: 'fillAccount' });
    expect(failure).not.toContain('live-password'); expect(failure).not.toContain('live@example.invalid');
    // Existing flat account files remain supported when no group is configured.
    await writeFile(accountsFile, JSON.stringify(local));
    expect(await replayBrowser(browserConfigSchema.parse({ ...input, accountsGroup: undefined }), scenario, directory)).toContain('5 étapes');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('mayassistant-browser-accounts-')) throw new Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  }
}, 40000);
