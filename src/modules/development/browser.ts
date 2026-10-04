import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { startLocalService } from './local-services.js';

const origin = z.url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.origin === value; });
export const browserConfigSchema = z.object({
  url: origin.refine(value => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname), 'Use a local preview origin.'),
  start: z.array(z.string().min(1)).min(1),
  startupTimeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
  allowedOrigins: z.array(origin).default([]),
  accountsFile: z.string().min(1).optional(),
  accountsGroup: z.string().min(1).max(100).optional(),
  accounts: z.array(z.string().min(1)).default([]),
}).strict();
export type BrowserConfig = z.infer<typeof browserConfigSchema>;
class BrowserStepError extends Error {}

async function accountField(config: BrowserConfig, account: string, field: 'email' | 'password') {
  if (!config.accountsFile || !config.accounts.includes(account)) throw new BrowserStepError('Compte navigateur non autorisé par la configuration.');
  const object = z.record(z.string(), z.unknown());
  let data: Record<string, unknown>;
  try { data = object.parse(JSON.parse(await readFile(config.accountsFile, 'utf8'))); }
  catch { throw new BrowserStepError('Fichier de comptes navigateur absent ou invalide.'); }
  if (config.accountsGroup) {
    const group = object.safeParse(Object.hasOwn(data, config.accountsGroup) ? data[config.accountsGroup] : undefined);
    if (!group.success) throw new BrowserStepError('Le groupe de comptes configuré est absent ou invalide. Vérifiez browser.accountsGroup.');
    data = group.data;
  }
  const credentials = object.safeParse(Object.hasOwn(data, account) ? data[account] : undefined);
  const value = z.string().min(1).safeParse(credentials.success ? credentials.data[field] : undefined);
  if (!value.success) throw new BrowserStepError('Identifiant de connexion absent ou invalide pour le compte sélectionné. Vérifiez browser.accountsGroup et le fichier de comptes.');
  return value.data;
}
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
  return `A controller-owned preview is running at ${config.url}. Use the mayassistant-browser MCP to inspect and exercise this checkout. Keep navigation on that local origin. Return browserScenario for visible changes: {"description":"French behavior checked","steps":[{"action":"navigate","path":"/"},{"action":"click","selector":"button"},{"action":"expectText","selector":"h1","text":"Expected result"}]}. Use actual selectors and expected results from the requested behavior, not this example. After submitting login credentials, assert completion with expectURL, expectHidden on the login form, or an authenticated-page assertion before navigating elsewhere; clicking Login does not await asynchronous authentication. Supported actions: navigate(path), click(selector), fill(selector,value), press(selector,key), expectVisible(selector), expectHidden(selector), expectText(selector,text), expectURL(path). The controller replays this scenario in a fresh browser and rejects failures. Screenshots or claims alone do not pass. ${config.accountsFile && config.accounts.length ? `Authorized test accounts: ${config.accounts.join(', ')}. Choose the role appropriate to the ticket. Read credentials only from ${config.accountsFile}${config.accountsGroup ? `, exclusively under the ${JSON.stringify(config.accountsGroup)} group (never fall back to another group)` : ', using top-level account names'} for MCP login. In the returned scenario use fillAccount(selector,account,field), with field email or password; never embed credentials in the result or report.` : 'No browser login account is authorized in this configuration; request one if necessary.'}`;
}

/** Start only our own preview; a busy port must not silently test another checkout. */
export async function startPreview(config: BrowserConfig, cwd: string, directory: string, env: NodeJS.ProcessEnv): Promise<() => Promise<void>> {
  return startLocalService({ id: 'preview', cwd, start: config.start, readyUrl: config.url, startupTimeoutMs: config.startupTimeoutMs }, directory, env);
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
  let loginPending = false;
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => allowed.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    for (const step of scenario.steps) {
      stepIndex++;
      switch (step.action) {
        case 'navigate':
          if (loginPending) throw new BrowserStepError('Après la connexion, attendez sa fin avec une assertion avant de naviguer vers une autre page.');
          await page.goto(localURL(step.path)); break;
        case 'click': await page.locator(step.selector).click(); break;
        case 'fill': await page.locator(step.selector).fill(step.value); break;
        case 'fillAccount': {
          const value = await accountField(config, step.account, step.field);
          await page.locator(step.selector).fill(value); loginPending = true; break;
        }
        case 'press': await page.locator(step.selector).press(step.key); break;
        case 'expectVisible': await page.locator(step.selector).waitFor({ state: 'visible' }); break;
        case 'expectHidden': await page.locator(step.selector).waitFor({ state: 'hidden' }); break;
        case 'expectURL': await page.waitForURL(localURL(step.path)); break;
        case 'expectText': await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent?.includes(text), { selector: step.selector, text: step.text }); break;
      }
      if (step.action.startsWith('expect')) loginPending = false;
      if (new URL(page.url()).origin !== config.url) throw new Error('Navigation hors de la prévisualisation locale.');
    }
    await page.screenshot({ path: path.join(directory, 'browser.png'), fullPage: true });
    await writeFile(path.join(directory, 'browser-result.json'), JSON.stringify({ passed: true, description: scenario.description, steps: stepIndex }), { mode: 0o600 });
    return `Navigateur : ${scenario.description} (${stepIndex} étapes rejouées avec succès)`;
  } catch (error) {
    const reason = error instanceof BrowserStepError ? error.message : 'Action navigateur non aboutie. Vérifiez la page et le scénario.';
    const action = scenario.steps[stepIndex - 1]?.action;
    await writeFile(path.join(directory, 'browser-result.json'), JSON.stringify({ passed: false, step: stepIndex, action, reason }), { mode: 0o600 });
    throw new Error(`Vérification navigateur échouée à l’étape ${stepIndex}. ${reason} Aucune publication.`);
  } finally { await browser.close(); }
}
