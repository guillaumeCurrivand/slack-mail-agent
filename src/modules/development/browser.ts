import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const origin = z.url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.origin === value; });
export const browserConfigSchema = z.object({
  url: origin.refine(value => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname), 'Use a local preview origin.'),
  start: z.array(z.string().min(1)).min(1),
  allowedOrigins: z.array(origin).default([]),
  accountsFile: z.string().min(1).optional(),
  accounts: z.array(z.string().min(1)).default([]),
}).strict();
export type BrowserConfig = z.infer<typeof browserConfigSchema>;
const selector = z.string().min(1).max(1000);
export const browserScenarioSchema = z.object({
  description: z.string().min(1).max(1000),
  steps: z.array(z.discriminatedUnion('action', [
    z.object({ action: z.literal('navigate'), path: z.string().startsWith('/').max(2000) }).strict(),
    z.object({ action: z.literal('click'), selector }).strict(),
    z.object({ action: z.literal('fill'), selector, value: z.string().max(4000) }).strict(),
    z.object({ action: z.literal('fillAccount'), selector, account: z.string().min(1), field: z.enum(['email', 'password']) }).strict(),
    z.object({ action: z.literal('press'), selector, key: z.string().min(1).max(100) }).strict(),
    z.object({ action: z.literal('expectVisible'), selector }).strict(),
    z.object({ action: z.literal('expectHidden'), selector }).strict(),
    z.object({ action: z.literal('expectText'), selector, text: z.string().min(1).max(2000) }).strict(),
    z.object({ action: z.literal('expectURL'), path: z.string().startsWith('/').max(2000) }).strict(),
  ])).min(3).max(80),
}).strict().refine(value => value.steps[0]?.action === 'navigate' && value.steps.some((step, index) =>
  ['click', 'fill', 'fillAccount', 'press'].includes(step.action) && value.steps.slice(index + 1).some(next => next.action.startsWith('expect'))),
'A browser scenario must navigate, interact, and then assert the result.');
export type BrowserScenario = z.infer<typeof browserScenarioSchema>;

export function browserInstructions(config: BrowserConfig) {
  return `A controller-owned preview is running at ${config.url}. Use the mayassistant-browser MCP to inspect and exercise this checkout. Keep navigation on that local origin. Return browserScenario for visible changes: {"description":"French behavior checked","steps":[{"action":"navigate","path":"/"},{"action":"click","selector":"button"},{"action":"expectText","selector":"h1","text":"Expected result"}]}. Use actual selectors and expected results from the requested behavior, not this example. Supported actions: navigate(path), click(selector), fill(selector,value), press(selector,key), expectVisible(selector), expectHidden(selector), expectText(selector,text), expectURL(path). The controller replays this scenario in a fresh browser and rejects failures. Screenshots or claims alone do not pass. ${config.accountsFile && config.accounts.length ? `Authorized test accounts: ${config.accounts.join(', ')}. Choose the role appropriate to the ticket. Read credentials only from ${config.accountsFile} for MCP login. In the returned scenario use fillAccount(selector,account,field), with field email or password; never embed credentials in the result or report.` : 'No browser login account is authorized in this configuration; request one if necessary.'}`;
}

/** Start only our own preview; a busy port must not silently test another checkout. */
export async function startPreview(config: BrowserConfig, cwd: string, directory: string, env: NodeJS.ProcessEnv): Promise<() => Promise<void>> {
  const url = new URL(config.url), host = url.hostname.replace(/^\[|\]$/g, ''), port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const portFree = await new Promise<boolean>(resolve => {
    const probe = net.createServer(); probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
  if (!portFree) throw new Error(`Le port du navigateur ${port} est déjà utilisé. Aucun autre checkout ne sera testé.`);
  const log = createWriteStream(path.join(directory, 'preview.log'), { flags: 'a', mode: 0o600 });
  const child = spawn(config.start[0]!, config.start.slice(1), { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let failed: Error | undefined;
  child.on('error', error => { failed = error; });
  const stop = async () => {
    if (child.pid) {
      if (process.platform === 'win32') await new Promise<void>(resolve => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => resolve()); killer.once('close', () => resolve());
      });
      else try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
    }
    log.end();
  };
  try {
    for (let count = 0; count < 120; count++) {
      if (failed || child.exitCode !== null) throw new Error('Le serveur de prévisualisation a échoué. Consultez preview.log.');
      try { if ((await fetch(config.url, { signal: AbortSignal.timeout(1000) })).ok) return stop; } catch { /* Still starting. */ }
      await delay(1000);
    }
    throw new Error('La prévisualisation ne répond pas. Consultez preview.log.');
  } catch (error) { await stop(); throw error; }
}

/** Independent replay; agent-written text is never treated as a successful check. */
export async function replayBrowser(config: BrowserConfig, input: unknown, directory: string) {
  const scenario = browserScenarioSchema.parse(input);
  const allowed = new Set([config.url, ...config.allowedOrigins]);
  const localURL = (relative: string) => { const url = new URL(relative, config.url); if (url.origin !== config.url) throw new Error('Navigation hors de la prévisualisation locale.'); return url.href; };
  for (const step of scenario.steps) if ('path' in step) localURL(step.path);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  await mkdir(directory, { recursive: true });
  let stepIndex = 0;
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => allowed.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    for (const step of scenario.steps) {
      stepIndex++;
      switch (step.action) {
        case 'navigate': await page.goto(localURL(step.path)); break;
        case 'click': await page.locator(step.selector).click(); break;
        case 'fill': await page.locator(step.selector).fill(step.value); break;
        case 'fillAccount': {
          if (!config.accountsFile || !config.accounts.includes(step.account)) throw new Error('Compte non autorisé.');
          const accounts = JSON.parse(await readFile(config.accountsFile, 'utf8'));
          const value = z.string().min(1).parse(accounts[step.account]?.[step.field]);
          await page.locator(step.selector).fill(value); break;
        }
        case 'press': await page.locator(step.selector).press(step.key); break;
        case 'expectVisible': await page.locator(step.selector).waitFor({ state: 'visible' }); break;
        case 'expectHidden': await page.locator(step.selector).waitFor({ state: 'hidden' }); break;
        case 'expectURL': await page.waitForURL(localURL(step.path)); break;
        case 'expectText': await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent?.includes(text), { selector: step.selector, text: step.text }); break;
      }
      if (new URL(page.url()).origin !== config.url) throw new Error('Navigation hors de la prévisualisation locale.');
    }
    await page.screenshot({ path: path.join(directory, 'browser.png'), fullPage: true });
    await writeFile(path.join(directory, 'browser-result.json'), JSON.stringify({ passed: true, description: scenario.description, steps: stepIndex }), { mode: 0o600 });
    return `Navigateur : ${scenario.description} (${stepIndex} étapes rejouées avec succès)`;
  } catch {
    await writeFile(path.join(directory, 'browser-result.json'), JSON.stringify({ passed: false, step: stepIndex }), { mode: 0o600 });
    throw new Error(`Vérification navigateur échouée à l’étape ${stepIndex}. Aucune publication.`);
  } finally { await browser.close(); }
}
