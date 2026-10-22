import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const bash = process.env.TEST_BASH ?? (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash');
const roots: string[] = [], sha = 'a'.repeat(40);
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('slack-agent-vps-deploy-')) throw Error('Unexpected cleanup path');
    rmSync(root, { recursive: true, force: true });
  }
});

function deploy(overrides: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'slack-agent-vps-deploy-'));
  roots.push(root);
  const app = path.join(root, 'app'), worker = path.join(root, 'worker'), bin = path.join(root, 'bin');
  for (const dir of [app, worker, bin, path.join(app, '.git')]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(app, '.env'), 'private-app-fixture');
  writeFileSync(path.join(root, 'worker-state.json'), 'stable-identity-fixture');
  const log = path.join(root, 'commands.log'), source = path.join(root, 'deploy.sh');
  writeFileSync(source, readFileSync(new URL('../scripts/deploy-vps.sh', import.meta.url)));
  const mock = (name: string, body: string) => writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\nset -eu\nprintf '${name} %s\\n' "$*" >> "$TEST_LOG"\n${body}\n`, { mode: 0o755 });
  mock('git', `case "$*" in
    'status --porcelain') printf '%s' "\${TEST_DIRTY:-}" ;;
    'branch --show-current') printf main ;;
    'fetch --no-tags origin main'|'merge-base --is-ancestor ${sha} FETCH_HEAD'|'merge-base --is-ancestor HEAD ${sha}') exit 0 ;;
    'merge --ff-only ${sha}') [[ "\${TEST_FAILURE:-}" != git ]] ;;
    *) exit 64 ;;
  esac`);
  mock('sudo', 'while (( $# )); do case "$1" in -n|-H) shift ;; -u) shift 2 ;; *) break ;; esac; done; exec "$@"');
  mock('systemctl', '[[ "${TEST_FAILURE:-}" != stop-worker || "$*" != "stop mayassistant-worker" ]]');
  mock('flock', 'exit 0');
  mock('rsync', 'exit 0');
  mock('install', 'exit 0');
  mock('node', 'exit 0');
  mock('npm', '[[ "${TEST_FAILURE:-}" != worker-build || "$*" != *"run build" ]]');
  mock('docker', `case "$*" in
    'compose build app') [[ "\${TEST_FAILURE:-}" != image ]] ;;
    'compose stop --timeout 120 app'|'compose up -d --no-deps app') exit 0 ;;
    *) exit 64 ;;
  esac`);
  mock('curl', `[[ "\${TEST_FAILURE:-}" != readiness ]] || exit 7; printf '{"ok":true}'`);
  const wrapper = 'for key in DEPLOY_APP_DIR DEPLOY_WORKER_DIR DEPLOY_NODE_BIN; do printf -v "$key" "%s" "$(cd "${!key}" && pwd -P)"; export "$key"; done; export PATH="$DEPLOY_NODE_BIN:/usr/bin:/bin"; exec bash "$TEST_SCRIPT" "$TEST_SHA"';
  const result = spawnSync(bash, ['-c', wrapper], { cwd: root, encoding: 'utf8', timeout: 15_000, env: {
    ...process.env, DEPLOY_APP_DIR: app.replaceAll('\\', '/'), DEPLOY_WORKER_DIR: worker.replaceAll('\\', '/'),
    DEPLOY_NODE_BIN: bin.replaceAll('\\', '/'), TEST_SCRIPT: source.replaceAll('\\', '/'),
    TEST_LOG: log.replaceAll('\\', '/'), TEST_SHA: sha, ...overrides,
  } });
  if (result.error) throw result.error;
  return { ...result, root, app, commands: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

describe.skipIf(!existsSync(bash))('GitHub Actions VPS deployment (fake external commands)', () => {
  it('deploys the supplied commit, stops the worker first and waits for app readiness before restarting it', () => {
    const result = deploy();
    expect(result.status, result.stderr).toBe(0);
    let previous = -1;
    for (const step of [`git merge --ff-only ${sha}`, 'systemctl stop mayassistant-worker', 'docker compose build app',
      'rsync -a --delete', 'docker compose stop --timeout 120 app', 'docker compose up -d --no-deps app', 'curl --fail', 'systemctl start mayassistant-worker']) {
      const index = result.commands.indexOf(step);
      expect(index, step).toBeGreaterThan(previous);
      previous = index;
    }
    expect(result.stdout).toContain(`Deployed app and worker at ${sha}`);
    expect(readFileSync(path.join(result.app, '.env'), 'utf8')).toBe('private-app-fixture');
    expect(readFileSync(path.join(result.root, 'worker-state.json'), 'utf8')).toBe('stable-identity-fixture');
    expect(result.commands).not.toMatch(/pg_dump|down -v|reset --hard|worker\.lock/);
  });

  it.each(['git', 'stop-worker', 'image', 'worker-build', 'readiness'])('stops a failed %s deployment without starting the worker', failure => {
    const result = deploy({ TEST_FAILURE: failure });
    expect(result.status).not.toBe(0);
    expect(result.commands).not.toContain('systemctl start mayassistant-worker');
    expect(result.stdout).not.toContain('Deployed app and worker');
    if (failure !== 'readiness') expect(result.commands).not.toContain('docker compose stop');
  });

  it('refuses a dirty checkout before fetching or stopping services', () => {
    const result = deploy({ TEST_DIRTY: ' M src/main.ts' });
    expect(result.status).not.toBe(0);
    expect(result.commands).not.toContain('git fetch');
    expect(result.commands).not.toContain('systemctl stop');
  });

  it('rejects a malformed SHA before any external command', () => {
    const result = deploy({ TEST_SHA: 'main; echo unexpected' });
    expect(result.status).not.toBe(0);
    expect(result.commands).toBe('');
  });
});
