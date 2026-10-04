import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Work } from '../src/modules/development/domain.js';
import { atomicJson, execute, LocalRunner, type Execute, type LocalProject } from '../src/modules/development/runner.js';
import { workerConfigSchema } from '../src/modules/development/worker-main.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('mayassistant-development-test-')) throw new Error('Unsafe test cleanup path');
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(options: { failChecks?: boolean; browser?: boolean; lostPush?: boolean; commitTitle?: string | null; browserScenario?: unknown } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mayassistant-development-test-')); directories.push(directory);
  const remote = path.join(directory, 'remote.git'), seed = path.join(directory, 'seed'), state = path.join(directory, 'state');
  await mkdir(seed);
  const git = async (cwd: string, ...args: string[]) => {
    const result = await execute(['git', ...args], cwd);
    if (result.code) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  await git(directory, 'init', '--bare', remote);
  await git(seed, 'init', '-b', 'test');
  await git(seed, 'config', 'user.name', 'Synthetic test'); await git(seed, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(seed, 'README.md'), 'Synthetic repository.');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Initial');
  await git(seed, 'push', remote, 'test'); await git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/test');
  const skillPath = path.join(directory, 'SKILL.md'); await writeFile(skillPath, 'Investigate the ticket; fix only the requested issue.');
  const local: LocalProject = { id: 'pilot', repository: remote, skill: 'maintenance', skillPath, checks: [['check']], browserChecks: [], setup: [] };
  const work: Work = { id: randomUUID(), project: { id: 'pilot', name: 'Pilot', repository: remote, skill: 'maintenance', channel: 'CPROJECT', folder: '123', enabled: true }, kind: 'build',
    ticket: { id: 'abc123', name: 'Repair menu', description: 'Close on outside click', status: 'Ready for AI', url: 'https://app.clickup.com/t/abc123', comments: [], attachments: [] }, attempts: 0, thread: null, lease: randomUUID() };
  let agents = 0, checks = 0, pushes = 0;
  const calls: string[][] = [];
  const exec: Execute = async (argv, cwd, input) => {
    calls.push(argv);
    if (argv[0] === 'fake-cursor') {
      agents++;
      if (argv.includes('--force')) await writeFile(path.join(cwd, 'fix.txt'), `Fix ${agents}`);
      return { code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({ actionable: true, summary: 'Menu corrigé.', browserRequired: options.browser ?? false, ...(options.commitTitle === null ? {} : { commitTitle: options.commitTitle ?? 'Repair menu' }), ...(options.browserScenario ? { browserScenario: options.browserScenario } : {}) }) }), stderr: '' };
    }
    if (argv[0] === 'check') { checks++; return { code: options.failChecks ? 1 : 0, stdout: options.failChecks ? 'Assertion failed' : 'Passed', stderr: '' }; }
    if (argv[0] === 'git' && argv[1] === 'push') {
      pushes++;
      const result = await execute(argv, cwd, input);
      if (options.lostPush && result.code === 0) return { code: 1, stdout: '', stderr: 'Simulated lost push response' };
      return result;
    }
    return execute(argv, cwd, input);
  };
  const runner = new LocalRunner(state, ['fake-cursor'], exec);
  let attempts = 0;
  const attempt = async (expected: number) => { expect(expected).toBe(attempts); return ++attempts; };
  const journalPath = path.join(state, 'runs', createHash('sha256').update(work.id).digest('hex'), 'journal.json');
  return { runner, local, work, git, remote, state, directory, attempt, journalPath, calls, count: () => ({ agents, checks, pushes, attempts }) };
}

it('pushes one tested commit to maintenance, preserves test, and resumes a completed run without repeating work', async () => {
  const h = await fixture(); const base = await h.git(h.remote, 'rev-parse', 'test');
  const result = await h.runner.run(h.work, h.local, h.attempt);
  expect(result.outcome).toBe('pushed'); expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(await h.git(h.remote, 'rev-parse', 'maintenance')).toBe(result.commit);
  expect(await h.git(h.remote, 'rev-parse', 'test')).toBe(base);
  expect(await h.git(h.remote, 'rev-list', '--count', 'test..maintenance')).toBe('1');
  expect(await h.git(h.remote, 'log', '-1', '--format=%B', 'maintenance')).toContain('fix(clickup:abc123): Repair menu');
  expect(await h.runner.run({ ...h.work, attempts: 1 }, h.local, h.attempt)).toEqual(result);
  expect(h.count()).toEqual({ agents: 1, checks: 1, pushes: 1, attempts: 1 });
  expect(h.calls.some(argv => argv.includes('--force') && argv[0] === 'git')).toBe(false);
});

it('stops after exactly two failed check attempts and never creates a remote maintenance branch', async () => {
  const h = await fixture({ failChecks: true });
  const result = await h.runner.run(h.work, h.local, h.attempt);
  expect(result.outcome).toBe('blocked'); expect(h.count()).toEqual({ agents: 2, checks: 2, pushes: 0, attempts: 2 });
  expect(await h.git(h.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/maintenance')).toBe('');
  expect((JSON.parse(await readFile(h.journalPath, 'utf8'))).failure).toContain('Assertion failed');
});

it('uses an English implementation summary for a French ticket and preserves the French report', async () => {
  const h = await fixture({ commitTitle: 'Close the menu when clicking outside' });
  h.work.ticket.name = 'Corriger la fermeture du menu';
  const result = await h.runner.run(h.work, h.local, h.attempt);
  expect(result.outcome).toBe('pushed'); expect(result.summary).toBe('Menu corrigé.');
  expect(await h.git(h.remote, 'log', '-1', '--format=%s', 'maintenance')).toBe('fix(clickup:abc123): Close the menu when clicking outside');
});

it.each([null, 'Repair menu\nUnexpected paragraph'])('blocks invalid commit metadata without publishing: %s', async commitTitle => {
  const h = await fixture({ commitTitle });
  const result = await h.runner.run(h.work, h.local, h.attempt);
  expect(result.outcome).toBe('blocked'); expect(h.count().pushes).toBe(0); expect(h.count().attempts).toBe(2);
  expect(await h.git(h.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/maintenance')).toBe('');
});

it('accumulates exactly one additional commit for the next ticket without overwriting the previous fix', async () => {
  const h = await fixture(); const first = await h.runner.run(h.work, h.local, h.attempt);
  let attempts = 0;
  const secondWork = { ...h.work, id: randomUUID(), ticket: { ...h.work.ticket, id: 'def456', name: 'Second ticket' } };
  const second = await h.runner.run(secondWork, h.local, async expected => { expect(expected).toBe(attempts); return ++attempts; });
  expect(second.outcome).toBe('pushed');
  expect(await h.git(h.remote, 'rev-parse', 'maintenance^')).toBe(first.commit);
  expect(await h.git(h.remote, 'rev-list', '--count', 'test..maintenance')).toBe('2');
});

it('does not publish a visual change without configured browser verification', async () => {
  const h = await fixture({ browser: true });
  const result = await h.runner.run(h.work, h.local, h.attempt);
  expect(result.outcome).toBe('blocked'); expect(result.summary).toContain('browserChecks'); expect(h.count().pushes).toBe(0);
});

it.skipIf(!existsSync(chromium.executablePath())).each([true, false])('gates publication on the managed browser replay (scenario supplied: %s)', async supplied => {
  const browserScenario = { description: 'Le bouton ferme le menu', steps: [{ action: 'navigate', path: '/' }, { action: 'click', selector: '#close' }, { action: 'expectHidden', selector: '#menu' }] };
  const h = await fixture({ browser: true, ...(supplied ? { browserScenario } : {}) });
  const portProbe = net.createServer(); await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = (portProbe.address() as net.AddressInfo).port; await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const html = '<button id="close" onclick="document.querySelector(\'#menu\').remove()">Close</button><div id="menu">Menu</div>';
  h.local.browser = { url: `http://127.0.0.1:${port}`, start: [process.execPath, '-e', `require('node:http').createServer((q,r)=>{r.setHeader('Content-Type','text/html');r.end(${JSON.stringify(html)})}).listen(${port},'127.0.0.1')`], allowedOrigins: [], accounts: [] };
  const result = await h.runner.run(h.work, h.local, h.attempt);
  expect(result.outcome).toBe(supplied ? 'pushed' : 'blocked');
  expect(h.count().pushes).toBe(supplied ? 1 : 0);
  if (supplied) expect(result.tests.some(test => test.includes('étapes rejouées'))).toBe(true);
  else expect(h.count().attempts).toBe(2);
  const probe = net.createServer(); await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise<void>(resolve => probe.close(() => resolve()));
}, 30000);

it('recovers a lost push response by checking the existing SHA, without another commit or Cursor call', async () => {
  const h = await fixture({ lostPush: true });
  const result = await h.runner.run(h.work, h.local, h.attempt);
  expect(result.outcome).toBe('pushed'); expect(h.count().agents).toBe(1); expect(h.count().pushes).toBe(1);
  expect(await h.git(h.remote, 'rev-list', '--count', 'test..maintenance')).toBe('1');
});

it('publishes and recovers maintenance/ai without conflicting with historical maintenance branches', async () => {
  const h = await fixture({ lostPush: true }); h.local.branch = 'maintenance/ai';
  await h.git(h.remote, 'branch', 'maintenance/september', 'test');
  const historical = await h.git(h.remote, 'rev-parse', 'maintenance/september');
  const result = await h.runner.run(h.work, h.local, h.attempt);
  expect(result.outcome).toBe('pushed'); expect(result.branch).toBe('maintenance/ai');
  expect(await h.git(h.remote, 'rev-parse', 'maintenance/ai')).toBe(result.commit);
  expect(await h.git(h.remote, 'rev-parse', 'maintenance/september')).toBe(historical);
  expect(h.count().agents).toBe(1); expect(h.count().pushes).toBe(1);
});

it('refuses a branch change while a previous commit is awaiting publication', async () => {
  const h = await fixture(); h.local.branch = 'maintenance/ai';
  await atomicJson(h.journalPath, { phase: 'committed', branch: 'maintenance', commit: 'a'.repeat(40) });
  await expect(h.runner.run(h.work, h.local, h.attempt)).rejects.toThrow('branche');
  expect(h.calls).toHaveLength(0);
});

it('blocks an interrupted in-flight attempt instead of dispatching it again', async () => {
  const h = await fixture();
  await atomicJson(h.journalPath, { phase: 'attempting', attempt: 1 });
  const result = await h.runner.run({ ...h.work, attempts: 1 }, h.local, h.attempt);
  expect(result.outcome).toBe('blocked'); expect(h.count().agents).toBe(0); expect(result.summary).toContain('interrompu');
});

it('investigates without file modification or publishing and refuses a mismatched remote configuration', async () => {
  const h = await fixture();
  expect((await h.runner.run({ ...h.work, project: { ...h.work.project, repository: 'https://example.com/other' } }, h.local, h.attempt)).outcome).toBe('blocked');
  expect(h.count().agents).toBe(0);
  const result = await h.runner.run({ ...h.work, kind: 'review' }, h.local, h.attempt);
  expect(result.outcome).toBe('actionable'); expect(h.count().pushes).toBe(0); expect(h.calls.find(argv => argv[0] === 'fake-cursor')).not.toContain('--force');
});

it('does not accept remote worker endpoints that expose its bearer token over HTTP', () => {
  const value = { server: 'http://example.com', stateDirectory: 'state', projects: [{ id: 'pilot', repository: 'url', skill: 'maintenance', skillPath: 'skill', checks: [['check']] }] };
  expect(workerConfigSchema.safeParse(value).success).toBe(false);
  expect(workerConfigSchema.safeParse({ ...value, server: 'http://localhost:3000' }).success).toBe(true);
  expect(workerConfigSchema.safeParse({ ...value, server: 'https://user:password@example.com' }).success).toBe(false);
});
