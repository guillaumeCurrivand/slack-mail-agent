#!/usr/bin/env bash
# Called over SSH by .github/workflows/deploy.yml as ubuntu. No backups.
set -Eeuo pipefail
trap 'echo "VPS deployment failed at line $LINENO; inspect app/worker logs before retrying." >&2' ERR

target="${1:?Pass the GitHub commit SHA}"
[[ "$#" == 1 && "$target" =~ ^[0-9a-f]{40}$ ]]
app_dir="${DEPLOY_APP_DIR:-/opt/slack-mail-agent}"
worker_dir="${DEPLOY_WORKER_DIR:-/home/mayworker/app}"
node_bin="${DEPLOY_NODE_BIN:-/home/mayworker/runtimes/node24/bin}"
cd -- "$app_dir"
exec 9>.git/vps-deploy.lock
flock 9
[[ -f .env && -z "$(git status --porcelain)" && "$(git branch --show-current)" == main ]]
[[ -d "$worker_dir" && ! -L "$worker_dir" && ! -e "$worker_dir/.git" ]]
export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=15'
git fetch --no-tags origin main
git merge-base --is-ancestor "$target" FETCH_HEAD
git merge-base --is-ancestor HEAD "$target"
git merge --ff-only "$target"

# Let an active ticket finish with the old app still available.
sudo -n systemctl stop mayassistant-worker
docker compose build app

# Worker state, config, credentials and project environments live outside app/.
sudo -n rsync -a --delete --chown=mayworker:mayworker src/ "$worker_dir/src/"
sudo -n rsync -a --delete --chown=mayworker:mayworker skills/development-maintenance/ "$worker_dir/skills/development-maintenance/"
sudo -n install -o mayworker -g mayworker -m 644 package.json package-lock.json tsconfig.json "$worker_dir/"
sudo -n -H -u mayworker env PATH="$node_bin:/usr/local/bin:/usr/bin:/bin" "$node_bin/node" -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
sudo -n -H -u mayworker env PATH="$node_bin:/usr/local/bin:/usr/bin:/bin" npm --prefix "$worker_dir" ci
sudo -n -H -u mayworker env PATH="$node_bin:/usr/local/bin:/usr/bin:/bin" npm --prefix "$worker_dir" run build
sudo -n -H -u mayworker "$node_bin/node" "$worker_dir/node_modules/playwright/cli.js" install chromium

docker compose stop --timeout 120 app
docker compose up -d --no-deps app
readiness="$(curl --fail --silent --show-error --retry 12 --retry-all-errors --retry-delay 2 --max-time 5 http://127.0.0.1:3001/ready)"
[[ "${readiness//[[:space:]]/}" == '{"ok":true}' ]]
sudo -n systemctl start mayassistant-worker
sudo -n systemctl is-active --quiet mayassistant-worker
printf 'Deployed app and worker at %s\n' "$target"
