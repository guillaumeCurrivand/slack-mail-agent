import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
