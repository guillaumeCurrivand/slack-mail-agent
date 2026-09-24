import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const bash = process.env.TEST_BASH ?? (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash');
const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('slack-agent-deploy-')) throw new Error('Unexpected test cleanup path');
    rmSync(resolved, { recursive: true, force: true });
  }
});

function deploy(overrides: Record<string, string> = {}, args: string[] = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'slack-agent-deploy-'));
  temporaryRoots.push(root);
  const checkout = path.join(root, 'checkout');
  mkdirSync(checkout);
  const scripts = path.join(checkout, 'scripts'), bin = path.join(root, 'bin'), backups = path.join(root, 'backups');
  mkdirSync(scripts); mkdirSync(bin);
  writeFileSync(path.join(scripts, 'deploy.sh'), readFileSync(new URL('../scripts/deploy.sh', import.meta.url)));
  writeFileSync(path.join(checkout, '.env'), '# Test fixture: no real credentials\n');
  const log = path.join(root, 'commands.log');
  writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$DEPLOY_TEST_LOG"
case "$*" in
  'branch --show-current') printf '%s\\n' "\${TEST_BRANCH:-main}" ;;
  'status --porcelain') printf '%s' "\${TEST_DIRTY:-}" ;;
  'pull --ff-only origin main') [[ "\${TEST_FAILURE:-}" != pull ]] ;;
  'rev-parse HEAD') printf '%s\\n' "\${TEST_HEAD:-reviewed-commit}" ;;
  'rev-parse origin/main') printf '%s\\n' reviewed-commit ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$DEPLOY_TEST_LOG"
case "$*" in
  'compose exec -T db pg_isready -U agent -d agent') [[ "\${TEST_FAILURE:-}" != database ]] ;;
  'compose build app') [[ "\${TEST_FAILURE:-}" != build ]] ;;
  'compose stop --timeout 120 app') [[ "\${TEST_FAILURE:-}" != stop ]] ;;
  'compose exec -T db pg_dump -U agent -d agent -Fc') printf 'fake database dump'; [[ "\${TEST_FAILURE:-}" != backup ]] ;;
  'compose up -d --no-deps app') [[ "\${TEST_FAILURE:-}" != startup ]] ;;
  'compose ps'|'compose logs --tail 50 app') exit 0 ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$DEPLOY_TEST_LOG"
[[ "\${TEST_FAILURE:-}" != readiness ]] || exit 7
if [[ -n "\${TEST_RESPONSE+x}" ]]; then printf '%s' "$TEST_RESPONSE"; else printf '{"ok":true}'; fi
`, { mode: 0o755 });
  const wrapper = 'mock_bin="$(cd "$DEPLOY_TEST_BIN" && pwd -P)"; export PATH="$mock_bin:/usr/bin:/bin"; for tool in git docker curl; do [[ "$(command -v "$tool")" == "$mock_bin/$tool" ]] || exit 64; done; exec bash "$DEPLOY_TEST_SCRIPT" "$@"';
  const result = spawnSync(bash, ['-c', wrapper, 'deploy-test', ...args], {
    // Run outside the checkout to exercise automatic project-directory discovery.
    cwd: tmpdir(), encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, DEPLOY_TEST_BIN: bin.replaceAll('\\', '/'),
      DEPLOY_TEST_SCRIPT: path.join(scripts, 'deploy.sh').replaceAll('\\', '/'),
      DEPLOY_TEST_LOG: log.replaceAll('\\', '/'), DEPLOY_BACKUP_DIR: backups.replaceAll('\\', '/'), ...overrides },
  });
  if (result.error) throw result.error;
  const commands = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { ...result, commands, backups, files: existsSync(backups) ? readdirSync(backups) : [] };
}

describe.skipIf(!existsSync(bash))('production deployment script (fake external commands)', () => {
  it('backs up after stopping and before starting, then verifies readiness', () => {
    const result = deploy();
    expect(result.status, result.stderr).toBe(0);
    const operations = result.commands.filter(command => command.startsWith('docker ') || command.startsWith('curl '));
    expect(operations.slice(0, 5)).toEqual([
      'docker compose exec -T db pg_isready -U agent -d agent', 'docker compose build app',
      'docker compose stop --timeout 120 app', 'docker compose exec -T db pg_dump -U agent -d agent -Fc',
      'docker compose up -d --no-deps app',
    ]);
    expect(operations[5]).toContain('http://127.0.0.1:3000/ready');
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatch(/\.dump$/);
    expect(readFileSync(path.join(result.backups, result.files[0]!), 'utf8')).toBe('fake database dump');
    expect(result.stdout).toContain('App is ready at commit reviewed-commit');
  });

  it.each([{ TEST_BRANCH: 'feature' }, { TEST_DIRTY: ' M README.md' }])('rejects an unsafe checkout: %j', overrides => {
    const result = deploy(overrides);
    expect(result.status).not.toBe(0);
    expect(result.commands).not.toContain('git pull --ff-only origin main');
    expect(result.commands.some(command => command.startsWith('docker '))).toBe(false);
  });

  it.each(['pull', 'database', 'build'])('keeps the old app running when %s fails', failure => {
    const result = deploy({ TEST_FAILURE: failure });
    expect(result.status).not.toBe(0);
    expect(result.commands).not.toContain('docker compose stop --timeout 120 app');
    expect(result.commands).not.toContain('docker compose up -d --no-deps app');
  });

  it('rejects local commits ahead of the fetched branch', () => {
    const result = deploy({ TEST_HEAD: 'local-only' });
    expect(result.status).not.toBe(0);
    expect(result.commands.some(command => command.startsWith('docker '))).toBe(false);
  });

  it('leaves the app stopped and marks a failed backup incomplete', () => {
    const result = deploy({ TEST_FAILURE: 'backup' });
    expect(result.status).not.toBe(0);
    expect(result.commands).not.toContain('docker compose up -d --no-deps app');
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatch(/\.partial$/);
    expect(result.stderr).toContain('database backup (app is stopped)');
  });

  it.each(['stop', 'startup'])('stops at a failed %s without attempting the next deployment step', failure => {
    const result = deploy({ TEST_FAILURE: failure });
    expect(result.status).not.toBe(0);
    if (failure === 'stop') expect(result.commands).not.toContain('docker compose exec -T db pg_dump -U agent -d agent -Fc');
    else expect(result.commands.some(command => command.startsWith('curl '))).toBe(false);
    expect(result.stdout).not.toContain('App is ready');
  });

  it.each([{ TEST_FAILURE: 'readiness' }, { TEST_RESPONSE: '{"ok":false}' }])('does not report success for a failed readiness check: %j', overrides => {
    const result = deploy(overrides);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('App is ready');
    expect(result.files[0]).toMatch(/\.dump$/);
  });

  it('shows help without contacting Git or Docker', () => {
    const result = deploy({}, ['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: bash scripts/deploy.sh');
    expect(result.commands).toEqual([]);
  });
});
