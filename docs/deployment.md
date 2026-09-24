# Updating production

Production uses Docker Compose. This procedure updates an existing server running this repository's `compose.yaml`, with its `app` and `db` services. Replace `/path/to/slack-mail-agent` with the existing server checkout; keep the same Compose project name, environment file, and any override files used for the original deployment. The actual server checkout path has not been recorded.

For a documentation-only change, pulling the commit is sufficient if the running app already includes the latest code release. The full procedure below is needed to deploy the module refactor or another runtime change.

## Update and restart

Run this in Bash on the production server, as the account that owns the checkout and can run Docker. PostgreSQL must already be running. The host needs Git, Docker Compose, and curl. The checkout must be clean and on `main`; the checks stop the procedure if local changes need attention. Preserve the existing `.env`, particularly `ENCRYPTION_KEY` and database credentials.

The block stops on the first error. It builds before stopping the old app, then backs up the database while application writes are stopped. The database service and its volume remain in place.

```bash
(
  set -eu
  cd /path/to/slack-mail-agent

  test "$(git branch --show-current)" = main
  test -z "$(git status --porcelain)"
  git pull --ff-only origin main
  test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
  git log -1 --oneline

  docker compose build app
  docker compose stop --timeout 120 app

  umask 077
  deployment_backup_dir="$HOME/slack-mail-agent-backups"
  mkdir -p "$deployment_backup_dir"
  deployment_backup="$deployment_backup_dir/before-update-$(date -u +%Y%m%dT%H%M%SZ).dump"
  docker compose exec -T db pg_dump -U agent -d agent -Fc > "$deployment_backup"
  test -s "$deployment_backup"

  docker compose up -d --no-deps app
  curl --fail --silent --show-error --retry 12 --retry-connrefused \
    --retry-delay 2 --max-time 5 http://127.0.0.1:3000/ready
  docker compose ps
  docker compose logs --tail 50 app
)
```

Use your protected backup location instead of the example directory if one is already configured. The dump contains application data; keep it out of the Git checkout and handle it under the existing backup retention policy. A database dump does not back up `.env` or the encryption key; preserve those separately through your existing secret-backup process.

`git pull` updates the checkout to `origin/main`; the displayed commit identifies that revision. The running app changes only after its image is rebuilt and its container recreated. `docker compose up` recreates the app when its image or configuration changes. A plain `docker compose restart` would not rebuild the image or apply changed configuration. `--no-deps` keeps the already-running database out of the app restart. See the Docker references for [up](https://docs.docker.com/reference/cli/docker/compose/up/), [stop](https://docs.docker.com/reference/cli/docker/compose/stop/), and [exec](https://docs.docker.com/reference/cli/docker/compose/exec/).

## Confirm the deployment

The readiness request must return HTTP 200 with `{"ok":true}`. This checks the application and its database connection; it does not verify Slack delivery or Gmail authorization. Check that the app stays running in `docker compose ps`, inspect its recent logs, then DM `help`, `mail help`, and `budget` to the bot. These commands do not modify the mailbox or require a paid AI call. Use the deployed public origin's `/ready` endpoint as well to check the HTTPS proxy path.

If the readiness check fails, inspect the logs and keep the release marked unverified. If failure occurred after stopping the old app but before `docker compose up`, `docker compose start app` can restart the still-existing old container. Once the new app has started, database migrations may already have run: assess schema and queued-work compatibility before reverting code or restoring a backup. Do not remove the database volume to retry an update.

## Module refactor release: `510c05f`

- No new required secrets or Slack/Google permissions. `ENABLED_MODULES` defaults to `mail`; existing configurations keep Mail Sorter enabled. An explicitly empty value disables all modules.
- Startup automatically adds module identifiers to jobs and AI accounting records. Existing mail state, credentials, and spending remain in place. There is no separate migration command.
- Stop the old worker before the new one starts; do not run old and new versions together during this upgrade. The Compose sequence above does this.
- Users now send `mail sort`, `mail rules`, and other prefixed requests. Natural-language requests also need `mail`. Shared `help` and `budget` stay unprefixed. Previously posted mail buttons and already-queued mail work remain supported.
- Local verification after review: 75 automated tests passed, TypeScript checks and build passed. The two real PostgreSQL concurrency tests were skipped without `TEST_DATABASE_URL`; live production integrations remain to be checked on the server.
