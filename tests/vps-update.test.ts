import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const bash = process.env.TEST_BASH ?? (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash');
const roots: string[] = [];
const sha = 'a'.repeat(40);
const source = readFileSync(new URL('../scripts/update-vps.sh', import.meta.url), 'utf8');
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('slack-agent-vps-update-')) throw Error('Unexpected cleanup path');
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'slack-agent-vps-update-'));
  roots.push(root);
  const app = path.join(root, 'app'), worker = path.join(root, 'worker'), state = path.join(root, 'state');
  const bin = path.join(root, 'bin'), controller = path.join(root, 'controller');
  for (const dir of [app, worker, state, bin, controller, path.join(app, '.git'), path.join(app, 'scripts')]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(app, '.env'), 'DO_NOT_TOUCH=app-secret-fixture\n');
  writeFileSync(path.join(worker, 'package.json'), '{"name":"slack-mail-agent"}');
  writeFileSync(path.join(worker, '.env'), 'DO_NOT_TOUCH=worker-secret-fixture\n');
  writeFileSync(path.join(app, 'scripts', 'update-vps.sh'), source);
  const log = path.join(root, 'commands.log');
  const script = (name: string, body: string) => writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\nset -eu\nprintf '${name} %s\\n' "$*" >> "$UPDATE_TEST_LOG"\n${body}\n`, { mode: 0o755 });
  script('id', 'printf "0\\n"');
  script('sudo', '[[ "$1" == -H && "$2" == -u ]] || exit 64; shift 3; exec "$@"');
  script('flock', '[[ "${TEST_LOCKED:-}" != 1 ]]');
  script('install', 'if [[ "$1" == -d ]]; then mkdir -p -- "${@: -1}"; else cp -- "${@: -2}"; fi');
  script('git', `[[ "$1" == -C ]] || exit 64; shift 2
case "$*" in
 'branch --show-current') printf '%s' "\${TEST_BRANCH:-main}" ;;
 'status --porcelain') printf '%s' "\${TEST_DIRTY:-}" ;;
 'ls-remote --exit-code origin refs/heads/main') [[ "\${TEST_FAILURE:-}" != fetch ]] ;;
 'fetch --no-tags origin main') [[ "\${TEST_FAILURE:-}" != fetch ]] ;;
 'rev-parse FETCH_HEAD'|'rev-parse HEAD') printf '${sha}\\n' ;;
 'merge-base --is-ancestor HEAD ${sha}') [[ "\${TEST_FAILURE:-}" != diverged ]] ;;
 'archive ${sha}') [[ "\${TEST_FAILURE:-}" != archive ]]; printf archive ;;
 'merge --ff-only ${sha}') [[ "\${TEST_FAILURE:-}" != merge ]] ;;
 *) exit 64 ;;
esac`);
  script('systemctl', `case "$*" in
 'cat mayassistant-worker.service') exit 0 ;;
 'show mayassistant-worker.service -p TimeoutStopUSec --value') printf '%s' "\${TEST_STOP_TIMEOUT:-infinity}" ;;
 'show mayassistant-worker.service -p KillMode --value') printf mixed ;;
 'show mayassistant-worker.service -p MainPID --value') printf 0 ;;
 'is-active --quiet mayassistant-worker.service') [[ "\${TEST_WORKER_INACTIVE:-}" != 1 ]] ;;
 'stop mayassistant-worker.service') [[ "\${TEST_FAILURE:-}" != stop-worker ]] ;;
 'start mayassistant-worker.service') [[ "\${TEST_FAILURE:-}" != start-worker ]] ;;
 *) exit 64 ;;
esac`);
  script('docker', `case "$*" in
 'compose exec -T db pg_isready -U agent -d agent') [[ "\${TEST_FAILURE:-}" != database ]] ;;
 'compose build app') [[ "\${TEST_FAILURE:-}" != image ]] ;;
 'compose stop --timeout 120 app') [[ "\${TEST_FAILURE:-}" != stop-app ]] ;;
 'compose up -d --no-deps app') [[ "\${TEST_FAILURE:-}" != start-app ]] ;;
 *) exit 64 ;;
esac`);
  script('node', `if [[ "$*" == *worker.lock* ]]; then [[ "\${TEST_FAILURE:-}" != worker-state ]];
elif [[ "$*" == *chromium.launch* ]]; then [[ "\${TEST_FAILURE:-}" != browser ]];
else exit 0; fi`);
  script('npm', '[[ "$*" != test || "${TEST_FAILURE:-}" != tests ]]');
  script('curl', `[[ "\${TEST_FAILURE:-}" != readiness ]] || exit 7; if [[ -n "\${TEST_READINESS+x}" ]]; then printf '%s' "$TEST_READINESS"; else printf '{"ok":true}'; fi`);
  script('tar', `[[ "$*" == '-x -C '* ]] || exit 64
cat >/dev/null
mkdir -p "$3/src" "$3/dist" "$3/node_modules" "$3/scripts"
cp "$UPDATE_TEST_SOURCE" "$3/scripts/update-vps.sh"`);
  script('rsync', '[[ "${TEST_FAILURE:-}" != worker-copy ]]');
  // Native placeholder satisfies -x; the mock handles Node validation separately.
  const run = (overrides: Record<string, string> = {}, args: string[] = []) => {
    const wrapper = 'for key in UPDATE_TEST_BIN MAYA_APP_DIR MAYA_WORKER_DIR MAYA_UPDATE_STATE_DIR MAYA_STAGE_PARENT MAYA_NODE_BIN MAYA_CONTROLLER_DIR; do printf -v "$key" "%s" "$(cd "${!key}" && pwd -P)"; export "$key"; done; export PATH="$UPDATE_TEST_BIN:/usr/bin:/bin"; exec bash "$UPDATE_TEST_SOURCE" "$@"';
    const result = spawnSync(bash, ['-c', wrapper, 'vps-update-test', ...args], {
      cwd: root, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, UPDATE_TEST_BIN: bin.replaceAll('\\', '/'), UPDATE_TEST_LOG: log.replaceAll('\\', '/'),
        UPDATE_TEST_SOURCE: path.join(app, 'scripts', 'update-vps.sh').replaceAll('\\', '/'),
        MAYA_APP_DIR: app.replaceAll('\\', '/'), MAYA_WORKER_DIR: worker.replaceAll('\\', '/'),
        MAYA_UPDATE_STATE_DIR: state.replaceAll('\\', '/'), MAYA_STAGE_PARENT: root.replaceAll('\\', '/'),
        MAYA_NODE_BIN: bin.replaceAll('\\', '/'), MAYA_CONTROLLER_DIR: controller.replaceAll('\\', '/'), ...overrides },
    });
    if (result.error) throw result.error;
    return { ...result, commands: existsSync(log) ? readFileSync(log, 'utf8') : '' };
  };
  return { root, app, worker, state, run };
}

describe.skipIf(!existsSync(bash))('VPS automatic deployment (fake external commands)', () => {
  it('pins one commit, waits for the worker, checks before app shutdown, then starts app before worker', () => {
    const f = fixture(), result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const order = ['systemctl stop mayassistant-worker.service', `archive ${sha}`, 'npm ci', 'npm run check', 'npm test', 'npm run build',
      `merge --ff-only ${sha}`, 'docker compose build app', 'docker compose stop --timeout 120 app', 'docker compose up -d --no-deps app',
      'curl --fail', 'rsync -a', 'systemctl start mayassistant-worker.service'];
    let previous = -1;
    for (const command of order) {
      const index = result.commands.indexOf(command);
      expect(index, command).toBeGreaterThan(previous);
      previous = index;
    }
    expect(readFileSync(path.join(f.state, 'deployed'), 'utf8').trim()).toBe(sha);
    expect(existsSync(path.join(f.state, 'in-progress'))).toBe(false);
    expect(existsSync(path.join(f.state, 'block-worker-start'))).toBe(false);
    expect(existsSync(path.join(f.state, 'failed'))).toBe(false);
    expect(readFileSync(path.join(f.app, '.env'), 'utf8')).toContain('app-secret-fixture');
    expect(readFileSync(path.join(f.worker, '.env'), 'utf8')).toContain('worker-secret-fixture');
    expect(result.commands).not.toMatch(/pg_dump|down -v|reset --hard|push /);
    expect(result.stdout).toContain('No backup created');
  });

  it('does nothing when both components already have the fetched commit', () => {
    const f = fixture();
    writeFileSync(path.join(f.state, 'deployed'), sha);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).not.toContain('systemctl stop');
    expect(result.commands).not.toContain('npm ci');
  });

  it('does not start another update while the deployment lock is occupied', () => {
    const result = fixture().run({ TEST_LOCKED: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).not.toContain('fetch --no-tags');
    expect(result.commands).not.toContain('systemctl stop');
  });

  it('updates code without starting an intentionally inactive worker', () => {
    const result = fixture().run({ TEST_WORKER_INACTIVE: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toContain('rsync -a');
    expect(result.commands).not.toContain('systemctl start');
  });

  it.each([{ TEST_BRANCH: 'feature' }, { TEST_DIRTY: ' M src/main.ts' }, { TEST_FAILURE: 'diverged' }, { TEST_STOP_TIMEOUT: '90s' }])('rejects unsafe preflight: %j', overrides => {
    const result = fixture().run(overrides);
    expect(result.status).not.toBe(0);
    expect(result.commands).not.toContain('systemctl stop');
    expect(result.commands).not.toContain('docker compose build');
  });

  it.each(['stop-worker', 'worker-state', 'archive', 'tests', 'browser', 'merge', 'image'])('leaves the old app running and blocks repeats when %s fails', failure => {
    const f = fixture(), result = f.run({ TEST_FAILURE: failure });
    expect(result.status, result.stdout).not.toBe(0);
    expect(result.commands).not.toContain('docker compose stop');
    expect(result.commands).not.toContain('systemctl start');
    expect(existsSync(path.join(f.state, 'failed'))).toBe(true);
    expect(existsSync(path.join(f.state, 'block-worker-start'))).toBe(true);
    const repeated = f.run();
    expect(repeated.status).not.toBe(0);
    expect(repeated.stdout).toContain('paused after a failure');
    expect(repeated.commands.split('systemctl stop').length).toBe(result.commands.split('systemctl stop').length);
  });

  it.each(['stop-app', 'start-app', 'readiness', 'worker-copy', 'start-worker'])('does not record a successful release after %s fails', failure => {
    const f = fixture(), result = f.run({ TEST_FAILURE: failure });
    expect(result.status).not.toBe(0);
    expect(existsSync(path.join(f.state, 'deployed'))).toBe(false);
    expect(existsSync(path.join(f.state, 'failed'))).toBe(true);
    expect(existsSync(path.join(f.state, 'block-worker-start'))).toBe(failure !== 'start-worker');
    if (failure === 'readiness') expect(result.commands).not.toContain('rsync -a');
  });

  it('rejects a malformed readiness success body', () => {
    const f = fixture(), result = f.run({ TEST_READINESS: '{"ok":false}' });
    expect(result.status).not.toBe(0);
    expect(result.commands).not.toContain('systemctl start');
  });

  it('holds an interrupted update until an operator inspects it', () => {
    const f = fixture();
    writeFileSync(path.join(f.state, 'in-progress'), sha);
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('interrupted update');
    expect(result.commands).not.toContain('fetch --no-tags');
  });

  it('supports installation preflight without stopping work or changing Git', () => {
    const f = fixture(), result = f.run({}, ['--check']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toContain('ls-remote --exit-code origin refs/heads/main');
    expect(result.commands).not.toContain('systemctl stop');
    expect(result.commands).not.toContain('merge --ff-only');
    expect(existsSync(path.join(f.state, 'in-progress'))).toBe(false);
  });
});
