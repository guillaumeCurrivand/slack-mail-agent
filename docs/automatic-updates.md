# Automatic app and VPS worker updates

Approved on 22/10/2026: a push to this repository's GitHub `main` authorizes updating Mayassistant and its VPS worker together. This does not change publication, review or deployment of repositories maintained by Development. Only push commits intended for production to `main` after the project's tests, check and build pass.

The VPS uses a [systemd timer](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html), with no inbound webhook, GitHub Actions secret or extra port. It checks GitHub approximately every minute after the previous check/update finishes. Active updates do not overlap. The first run also brings an existing standalone worker snapshot onto the app's current `main` commit, even if GitHub has not advanced. New commits arriving during an update wait for the next check; each update pins one SHA for both components.

**No backups are created by this procedure**, as requested. It preserves `.env`, encryption and worker tokens, Cursor/SSH credentials, worker configuration, worker identity, journals, checkouts, the existing Compose project and both databases/volumes. Existing manual `scripts/deploy.sh` retains its backup behavior; the automatic controller does not invoke it.

## Install once on the recorded VPS

Target: the reviewed, pushed `main` commit containing [the updater](../scripts/update-vps.sh), [installer](../scripts/install-vps-updates.sh) and [systemd units](../scripts/systemd/). The paths below are the recorded Ubuntu installation; the installer verifies prerequisites on the actual host. Local preparation does not establish successful VPS installation or deployment.

As `ubuntu`, using the existing checkout and its existing private repository access:

```bash
cd /opt/slack-mail-agent
git status --short --branch
# Proceed with a clean main checkout. Resolve existing changes instead of resetting them.
git fetch origin main
git pull --ff-only origin main
git rev-parse HEAD
bash scripts/install-vps-updates.sh
```

The three stages review the scope, verify the installation/unattended GitHub access, then install and enable the timer plus a worker startup condition. No secrets or new values are entered or saved. A final activation gate explains that `main` deploys automatically without backups. If authentication fails, fix `ubuntu`'s existing Git/SSH identity on the server; do not copy a personal key into chat, disable host checking or run the updater under the worker's project Git identity.

Expected setup: app `/opt/slack-mail-agent`, Compose services `app`/`db`, readiness `http://127.0.0.1:3001/ready`, worker code `/home/mayworker/app` as a standalone directory, Node 24+ at `/home/mayworker/runtimes/node24/bin`, configuration `/home/mayworker/kit/development-worker.linux.json`, account `mayworker`, and `mayassistant-worker.service`. The worker must already use `TimeoutStopSec=infinity` and `KillMode=mixed`. `rsync`, `flock`, Git, Docker Compose and the existing browser system dependencies are required; missing prerequisites fail preflight. No application environment variable, Slack setting, token change or manual database migration is introduced by this controller. Future commits may have their own migration/environment requirements; prepare them before pushing to `main`.

## What happens after a push

1. Verify a clean `main`, fetch once and require a fast-forward. Divergence/local edits are never overwritten.
2. Stop the worker gracefully, letting its active ticket finish while the current app stays online. A lingering worker lock prevents updating; the controller never clears locks or claims. Worker shutdown has no execution deadline.
3. Export the pinned commit into a temporary source directory owned by `mayworker`. With Node 24+, run `npm ci`, `npm run check`, `npm test`, `npm run build`, install the matching Playwright Chromium and test browser launch. Tests use fake providers and an empty `TEST_DATABASE_URL`; real PostgreSQL locking tests remain skipped.
4. Fast-forward the app checkout to that SHA, build the Docker image, stop the old app, recreate only `app` and require exactly `{"ok":true}` from readiness. Startup runs that release's existing migrations. PostgreSQL and its volume are preserved.
5. Copy the candidate into the standalone worker directory, removing obsolete files only within `src`, `dist` and `node_modules`. Configuration/private state outside this directory remains in place. The worker restarts only if it was active before the update; an intentionally stopped/disabled worker stays stopped/disabled.
6. Record the combined deployed SHA under `/var/lib/mayassistant-update/deployed`, refresh the installed controller for the next update, and delete the temporary candidate. The systemd units themselves change only when the installer is rerun.

Source builds take time, and a long active ticket postpones deployment. The app has a short restart window; the worker is unavailable during candidate checks/build. This is not a zero-downtime or rolling deployment. Existing accounts, environments and EOA OAuth/ngrok origins are not reconfigured.

## Verify and operate

```bash
sudo systemctl list-timers mayassistant-update.timer --no-pager
sudo journalctl -u mayassistant-update.service -n 100 --no-pager
sudo cat /var/lib/mayassistant-update/deployed
git -C /opt/slack-mail-agent rev-parse HEAD
curl --fail http://127.0.0.1:3001/ready
sudo systemctl show mayassistant-worker -p ActiveState -p MainPID
sudo journalctl -u mayassistant-worker -n 80 --no-pager
```

The recorded SHA and checkout must match. Readiness must succeed. For a previously active worker, inspect its logs for successful polling or actual authorized work, without repeated authentication/provider errors; `active` alone does not prove successful polling. Check Slack `help` and `development menu` plus any release-specific checks in [Updating production](deployment.md). Installing the timer or passing fake-command tests is not observed production success.

Pause automatic checks before a manual deployment or configuration change, then wait for any current update to finish:

```bash
sudo systemctl stop mayassistant-update.timer
# Wait; do not force-kill a deployment or its active ticket.
while sudo systemctl is-active --quiet mayassistant-update.service; do sleep 5; done
```

Disable future automatic starts with `sudo systemctl disable --now mayassistant-update.timer`. Stop the timer first when intentionally stopping the worker so an already-running update cannot restore its previously active state. Resume with `sudo systemctl enable --now mayassistant-update.timer`. Run a deliberate immediate check with `sudo systemctl start mayassistant-update.service`.

## Failure recovery

An error after admitting an update writes `/var/lib/mayassistant-update/failed` and leaves `in-progress`; subsequent checks deploy nothing. A machine/process crash leaves `in-progress`, also preventing another update. The worker's installed systemd condition prevents starting it, including at boot, while `block-worker-start` exists. The controller removes that marker only after the app is ready and worker code is fully installed. Preflight/network errors before admission can retry on the next check. Candidate failures keep the old app running and leave the worker stopped. Failures after app replacement can leave the app or worker stopped/partially updated. There is no automatic rollback or data restore.

Stop the timer, inspect both markers, the update journal, Docker logs and worker processes/state. Preserve the worker identity, locks and journals; use [Development recovery](development.md#recovery-access-and-retention) for uncertain claims/publications. Correct the named failure and inspect any release migration before retrying. The candidate path in the command log may remain for inspection; it is reproducible source, not a live-data backup.

Only after resolving the failure, remove the two admission markers and retry:

```bash
sudo rm -f /var/lib/mayassistant-update/failed /var/lib/mayassistant-update/in-progress
sudo systemctl reset-failed mayassistant-update.service
sudo systemctl start mayassistant-update.service
# Inspect readiness, recorded SHA and worker logs before resuming the timer.
sudo systemctl start mayassistant-update.timer
```

A retry after failure sees a stopped worker and preserves that state. Leave `block-worker-start` in place during recovery: a successful retry clears it after code installation. If the worker should run, explicitly start it after a healthy update with `sudo systemctl start mayassistant-worker`. Never clear an update marker while its service is still running, delete either database volume, reset the app checkout, or reset worker state to make a deployment proceed.
