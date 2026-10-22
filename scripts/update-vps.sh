#!/usr/bin/env bash
# Installed outside the checkout by install-vps-updates.sh. No database backups.
set -Eeuo pipefail

fail() { printf 'Automatic update stopped: %s\n' "$*" >&2; exit 1; }

main() {
  local app_dir="${MAYA_APP_DIR:-/opt/slack-mail-agent}"
  local worker_dir="${MAYA_WORKER_DIR:-/home/mayworker/app}"
  local state_dir="${MAYA_UPDATE_STATE_DIR:-/var/lib/mayassistant-update}"
  local node_bin="${MAYA_NODE_BIN:-/home/mayworker/runtimes/node24/bin}"
  local stage_parent="${MAYA_STAGE_PARENT:-/home/mayworker}"
  local controller_dir="${MAYA_CONTROLLER_DIR:-/usr/local/lib/mayassistant-update}"
  local app_user="${MAYA_APP_USER:-ubuntu}" worker_user="${MAYA_WORKER_USER:-mayworker}"
  local service=mayassistant-worker.service target='' stage='' phase=preflight
  local restart_worker=0
  [[ "$#" == 0 || ( "$#" == 1 && "$1" == --check ) ]] || fail 'Usage: update-vps.sh [--check]'
  [[ $(id -u) == 0 ]] || fail 'Run as root through the systemd service or sudo.'

  app_git() { sudo -H -u "$app_user" env GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=15' git -C "$app_dir" "$@"; }
  worker_command() { sudo -H -u "$worker_user" env PATH="$node_bin:/usr/local/bin:/usr/bin:/bin" TEST_DATABASE_URL= "$@"; }
  stage_command() { worker_command bash -c 'cd -- "$1"; shift; exec "$@"' update-stage "$stage" "$@"; }
  local command
  for command in git docker curl sudo rsync flock mktemp tar install; do
    command -v "$command" >/dev/null || fail "Missing command: $command"
  done
  [[ -d "$app_dir/.git" && -f "$app_dir/.env" ]] || fail 'Expected app checkout and existing .env are missing.'
  [[ -d "$worker_dir" && ! -L "$worker_dir" && ! -e "$worker_dir/.git" ]] || fail 'Expected a standalone worker directory, not a symlink or Git checkout.'
  [[ -f "$worker_dir/package.json" && -x "$node_bin/node" ]] || fail 'Worker installation or Node runtime is missing.'
  worker_command "$node_bin/node" -e 'if (Number(process.versions.node.split(".")[0]) < 24 || require(process.argv[1]).name !== "slack-mail-agent") process.exit(1)' "$worker_dir/package.json"
  [[ "$(app_git branch --show-current)" == main ]] || fail 'The app checkout must be on main.'
  [[ -z "$(app_git status --porcelain)" ]] || fail 'The app checkout has local changes; resolve them first.'
  systemctl cat "$service" >/dev/null
  [[ "$(systemctl show "$service" -p TimeoutStopUSec --value)" == infinity ]] || fail 'Worker service must allow unlimited graceful shutdown (TimeoutStopSec=infinity).'
  [[ "$(systemctl show "$service" -p KillMode --value)" == mixed ]] || fail 'Worker service must use KillMode=mixed.'
  cd -- "$app_dir"
  docker compose exec -T db pg_isready -U agent -d agent
  if [[ "${1:-}" == --check ]]; then
    app_git ls-remote --exit-code origin refs/heads/main >/dev/null
    printf 'Preflight passed. No work was stopped, deployed or backed up.\n'
    return
  fi

  umask 077
  install -d -m 700 "$state_dir"
  exec 9>"$state_dir/update.lock"
  flock -n 9 || return 0
  if [[ -f "$state_dir/failed" ]]; then
    printf 'Automatic updates are paused after a failure; inspect %s/failed and the service journal.\n' "$state_dir"
    return 1
  fi
  # A process/machine crash cannot look like a clean completed update on restart.
  [[ ! -f "$state_dir/in-progress" ]] || fail 'An interrupted update needs operator inspection; in-progress marker remains.'
  phase='Git fetch'
  app_git fetch --no-tags origin main
  target="$(app_git rev-parse FETCH_HEAD)"
  [[ "$target" =~ ^[0-9a-f]{40}$ ]] || fail 'Expected a full Git commit SHA.'
  app_git merge-base --is-ancestor HEAD "$target" || fail 'main diverged from GitHub; automatic updates never reset or force-push.'
  if [[ -f "$state_dir/deployed" && "$(cat "$state_dir/deployed")" == "$target" && "$(app_git rev-parse HEAD)" == "$target" ]]; then
    return
  fi
  printf '%s\n' "$target" > "$state_dir/in-progress"
  # The installed worker unit condition also blocks boot/manual starts while code
  # is being replaced. Only remove this once app and worker code are ready.
  printf '%s\n' "$target" > "$state_dir/block-worker-start"
  on_failure() {
    local code=$?
    printf '%s: failed during %s (exit %s). Inspect services before retrying.\n' "$target" "$phase" "$code" > "$state_dir/failed"
    printf 'Automatic update failed during %s. Worker/app may remain stopped. See docs/deployment.md.\n' "$phase" >&2
    exit "$code"
  }
  trap on_failure ERR

  phase='graceful worker shutdown'
  if systemctl is-active --quiet "$service"; then restart_worker=1; fi
  systemctl stop "$service"
  [[ "$(systemctl show "$service" -p MainPID --value)" == 0 ]]
  # The existing VPS service has TimeoutStopSec=infinity and KillMode=mixed.
  # Never remove a lock, identity or journal to get through an update.
  phase='worker state validation'
  worker_command "$node_bin/node" --input-type=module -e '
    import { readFileSync, existsSync } from "node:fs";
    import path from "node:path";
    const config = JSON.parse(readFileSync("/home/mayworker/kit/development-worker.linux.json", "utf8"));
    const root = path.resolve(config.stateDirectory);
    if (root === path.resolve(process.argv[1]) || root.startsWith(path.resolve(process.argv[1]) + path.sep)) throw Error("State must be outside worker code");
    if (existsSync(path.join(root, "worker.lock"))) throw Error("Worker lock remains; inspect old processes before recovery");
    const identity = JSON.parse(readFileSync(path.join(root, "worker.json"), "utf8"));
    if (!identity.id) throw Error("Missing worker identity; do not regenerate it during an update");
  ' "$worker_dir"

  phase='candidate preparation'
  stage="$(worker_command mktemp -d "$stage_parent/.mayassistant-update-XXXXXXXX")"
  printf 'Updating app and worker to %s; candidate: %s\n' "$target" "$stage"
  app_git archive "$target" | worker_command tar -x -C "$stage"
  phase='candidate checks'
  stage_command npm ci
  stage_command npm run check
  stage_command npm test
  stage_command npm run build
  stage_command "$node_bin/node" node_modules/playwright/cli.js install chromium
  stage_command "$node_bin/node" --input-type=module -e 'import { chromium } from "playwright"; const browser = await chromium.launch({headless:true}); await browser.close();'

  phase='app checkout update'
  app_git merge --ff-only "$target"
  phase='app image build'
  docker compose build app
  phase='app shutdown'
  docker compose stop --timeout 120 app
  phase='app startup'
  docker compose up -d --no-deps app
  phase='app readiness'
  local readiness
  readiness="$(curl --fail --silent --show-error --retry 12 --retry-all-errors --retry-delay 2 --max-time 5 http://127.0.0.1:3001/ready)"
  [[ "${readiness//[[:space:]]/}" == '{"ok":true}' ]]

  phase='worker code installation'
  # Keep operator files. Delete obsolete source/generated dependencies only within
  # these three code directories, never the external worker state or private files.
  worker_command rsync -a "$stage/" "$worker_dir/"
  local directory
  for directory in src dist node_modules; do
    worker_command rsync -a --delete "$stage/$directory/" "$worker_dir/$directory/"
  done
  rm -- "$state_dir/block-worker-start"
  if (( restart_worker )); then
    phase='worker startup'
    systemctl start "$service"
    systemctl is-active --quiet "$service"
  fi
  phase='release recording'
  printf '%s\n' "$target" > "$state_dir/deployed.next"
  mv -- "$state_dir/deployed.next" "$state_dir/deployed"
  # Refresh the installed controller only after this release is healthy. main is
  # fully parsed before execution, so replacing this script cannot alter this run.
  install -m 755 "$app_dir/scripts/update-vps.sh" "$controller_dir/update-vps.sh"
  rm -- "$state_dir/in-progress"
  trap - ERR
  # Staging contains reproducible source/dependencies, never a backup of live data.
  case "$stage" in "$stage_parent"/.mayassistant-update-????????) worker_command rm -rf -- "$stage" ;; *) fail 'Unexpected staging directory; refusing cleanup.' ;; esac
  printf 'Updated app and worker to %s. Worker restarted: %s. No backup created.\n' "$target" "$restart_worker"
}

# Parse the whole procedure before Git or install can replace this file.
main "$@"; exit
