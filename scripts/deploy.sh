#!/usr/bin/env bash
# Run on the production host, never inside the app container.
set -Eeuo pipefail

fail() {
  printf 'Deployment stopped: %s\n' "$*" >&2
  exit 1
}

main() {
  if [[ "${1:-}" == '--help' && "$#" == 1 ]]; then
    printf '%s\n' \
      'Usage: bash scripts/deploy.sh' \
      'Updates main, builds and stops the app, backs up PostgreSQL, restarts, and checks readiness.' \
      'Run with the same Compose environment/project settings as the existing deployment.' \
      'Optional: DEPLOY_BACKUP_DIR (default: $HOME/slack-mail-agent-backups)' \
      'Optional: DEPLOY_READY_URL (default: http://127.0.0.1:3000/ready)'
    return
  fi
  [[ "$#" == 0 ]] || fail 'Unexpected arguments. Use --help for usage.'

  local deployment_stage='preflight'
  trap 'printf "Deployment failed during %s (line %s). See docs/deployment.md before retrying.\n" "$deployment_stage" "$LINENO" >&2' ERR

  local project_dir
  project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
  cd -- "$project_dir"

  local executable
  for executable in git docker curl mktemp; do
    command -v "$executable" >/dev/null 2>&1 || fail "Missing command: $executable"
  done
  [[ -f .env ]] || fail 'The existing production .env file is missing.'
  [[ "$(git branch --show-current)" == main ]] || fail 'Run from the main branch.'
  [[ -z "$(git status --porcelain)" ]] || fail 'The checkout has local changes. Resolve them before deploying.'

  deployment_stage='Git update'
  git pull --ff-only origin main
  local deployment_commit
  deployment_commit="$(git rev-parse HEAD)"
  [[ "$deployment_commit" == "$(git rev-parse origin/main)" ]] || fail 'Local main differs from origin/main.'
  printf 'Deploying %s\n' "$deployment_commit"

  deployment_stage='database preflight'
  docker compose exec -T db pg_isready -U agent -d agent

  local backup_dir backup_partial backup_file
  umask 077
  backup_dir="${DEPLOY_BACKUP_DIR:-$HOME/slack-mail-agent-backups}"
  mkdir -p -- "$backup_dir"
  backup_dir="$(cd -- "$backup_dir" && pwd -P)"
  case "$backup_dir/" in
    "$project_dir/"*) fail 'Choose a backup directory outside the Git checkout.' ;;
  esac
  backup_partial="$(mktemp "$backup_dir/before-update-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.dump.partial")"
  backup_file="${backup_partial%.partial}"

  deployment_stage='image build'
  docker compose build app
  deployment_stage='app shutdown'
  docker compose stop --timeout 120 app

  deployment_stage='database backup (app is stopped)'
  docker compose exec -T db pg_dump -U agent -d agent -Fc > "$backup_partial"
  [[ -s "$backup_partial" ]] || fail "Database dump was empty; app remains stopped. Incomplete backup: $backup_partial"
  mv -- "$backup_partial" "$backup_file"
  printf 'Database backup: %s\n' "$backup_file"

  deployment_stage='app startup'
  docker compose up -d --no-deps app
  deployment_stage='readiness check'
  local readiness
  readiness="$(curl --fail --silent --show-error --retry 12 --retry-connrefused \
    --retry-delay 2 --max-time 5 "${DEPLOY_READY_URL:-http://127.0.0.1:3000/ready}")"
  [[ "${readiness//[[:space:]]/}" == '{"ok":true}' ]] || fail "Unexpected readiness response. Inspect docker compose logs --tail 50 app."

  deployment_stage='status inspection'
  docker compose ps
  docker compose logs --tail 50 app
  printf 'App is ready at commit %s. Finish verification in Slack: help, mail help, budget.\n' "$deployment_commit"
  trap - ERR
}

# Parse the full procedure before git pull can update this file on disk, and
# exit without reading any new trailing content from a replacement script.
main "$@"; exit
