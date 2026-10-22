# Deploy from GitHub Actions

A push to `main` runs [the deployment workflow](../.github/workflows/deploy.yml): Node 24 checks, tests and build, then SSH to `ubuntu@158.69.219.238` to run [the VPS deployment script](../scripts/deploy-vps.sh) for that exact commit. Deployments run one at a time and do not cancel an active deployment. The workflow can also be run manually from Actions on `main`.

## One-time setup

In the repository's [Actions secrets settings](https://github.com/guillaumeCurrivand/slack-mail-agent/settings/secrets/actions), add:

- `VPS_SSH_KEY`: an SSH private key whose public key is authorized for `ubuntu` on the VPS.
- `VPS_KNOWN_HOSTS`: the VPS host key entry. Obtain it on the VPS with `awk '{print "158.69.219.238 "$1" "$2}' /etc/ssh/ssh_host_ed25519_key.pub`.

GitHub documents [adding repository secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets). No secrets have been configured by this code change. The VPS must already allow `ubuntu` to run Docker Compose, use noninteractive Git access to this repository, and run the deployment's `sudo -n` commands. The recorded worker service already waits indefinitely for active work during shutdown. `rsync` must be installed.

If you installed the previous polling timer, disable it and remove its worker startup condition once before using this workflow:

```bash
sudo systemctl disable --now mayassistant-update.timer
while sudo systemctl is-active --quiet mayassistant-update.service; do sleep 5; done
sudo rm -f /etc/systemd/system/mayassistant-worker.service.d/50-automatic-updates.conf
sudo systemctl daemon-reload
```

## Deployment

The script fast-forwards the clean `/opt/slack-mail-agent` checkout to the workflow SHA, lets active worker work finish, builds the app image, updates/builds the standalone worker in `/home/mayworker/app`, recreates only the app container, checks readiness and starts the worker. It creates no backups. Existing `.env`, worker state/configuration, credentials and both database volumes remain in place. No new app environment variables or manual migrations are required; normal startup migrations still run. Maintenance repositories' own deployment workflow is unchanged.

To deploy manually as `ubuntu`, use the reviewed commit SHA in place of the placeholder:

```bash
cd /opt/slack-mail-agent &&
git fetch origin main &&
git merge --ff-only origin/main &&
bash scripts/deploy-vps.sh '<reviewed-main-commit-sha>'
```

After deployment, check `curl --fail http://127.0.0.1:3001/ready`, `sudo journalctl -u mayassistant-worker -n 80 --no-pager`, and Slack `development menu`. A green SSH command alone does not establish successful worker polling; inspect its logs for authentication/provider errors. If a build or deployment fails, the job stops and reports the error; the worker or app may remain stopped. Correct the error, reconcile any uncertain worker claim using [Development recovery](development.md#recovery-access-and-retention), then rerun the workflow. A long active ticket can delay deployment beyond GitHub's job limit; rerun after it finishes. Never reset worker state or remove a database volume to retry.

This is a locally verified deployment configuration until the workflow successfully deploys and live readiness/worker checks are observed.
