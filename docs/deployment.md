# Updating production

Production uses Docker Compose. The confirmed server checkout is `/opt/slack-mail-agent`, running this repository's `compose.yaml` with `app` and `db` services. Keep the same Compose project name, environment file, and any override files used for the original deployment.

The confirmed production host port is **3001**. Compose maps `127.0.0.1:3001` to container port `3000` and explicitly sets the app's internal `PORT=3000`. The reverse proxy and host readiness check use port `3001`; no `.env` port change is required for this Compose setup.

For a documentation-only change, pulling the commit is sufficient if the running app already includes the latest code release. The full procedure below is needed to deploy the module refactor or another runtime change.

## Update and restart

Run this in Bash on the production server, as the account that owns the checkout and can run Docker. PostgreSQL must already be running. The host needs Git, Docker Compose, and curl **7.71.0 or newer** (check with `curl --version`). The readiness check uses [`--retry-all-errors`](https://curl.se/docs/manpage.html#--retry-all-errors) to retry connection resets as well as refused connections while Node starts behind Docker's published port. The checkout must be clean and on `main`; the checks stop the procedure if local changes need attention. Preserve the existing `.env`, particularly `ENCRYPTION_KEY` and database credentials.

The deployment procedure is implemented in [`scripts/deploy.sh`](../scripts/deploy.sh). On your first update, pull to obtain the script, then run it:

```bash
cd /opt/slack-mail-agent &&
git pull --ff-only origin main &&
bash scripts/deploy.sh
```

The script finds the checkout relative to its own location, so no server path is hardcoded in it. It checks the branch and working tree, pulls `origin/main`, confirms the local revision matches it, and verifies that the existing database is reachable. It builds before stopping the old app, backs up the database while application writes are stopped, recreates only the app, and verifies the readiness response. The database service and its volume remain in place. Errors stop deployment with the failed step identified; there is no automatic rollback.

Backups default to `$HOME/slack-mail-agent-backups`. Each has a unique name; failed or unfinished dumps retain a `.partial` suffix and must not be treated as completed backups. Optional settings are `DEPLOY_BACKUP_DIR` for your protected backup location and `DEPLOY_READY_URL` if your readiness address differs from `http://127.0.0.1:3001/ready`. Use `bash scripts/deploy.sh --help` for usage.

The dump contains application data; keep it out of the Git checkout and handle it under the existing backup retention policy. A database dump does not back up `.env` or the encryption key; preserve those separately through your existing secret-backup process.

`git pull` updates the checkout to `origin/main`; the displayed commit identifies that revision. The running app changes only after its image is rebuilt and its container recreated. `docker compose up` recreates the app when its image or configuration changes. A plain `docker compose restart` would not rebuild the image or apply changed configuration. `--no-deps` keeps the already-running database out of the app restart. See the Docker references for [up](https://docs.docker.com/reference/cli/docker/compose/up/), [stop](https://docs.docker.com/reference/cli/docker/compose/stop/), and [exec](https://docs.docker.com/reference/cli/docker/compose/exec/).

## Confirm the deployment

The script requires a successful readiness request with `{"ok":true}`, then shows container status and recent app logs. This checks the application and its database connection; it does not verify Slack delivery or Gmail authorization. Confirm the app stays running, then DM `help`, `mail help`, and `budget` to the bot. If Slack Unanswered is enabled, also DM `slack channels` and confirm the channel picker lists a private channel shared by you and the bot, select it, then DM `slack unanswered`. These commands do not modify the mailbox; contextual matching in `slack unanswered` may use the shared AI budget. Use the deployed public origin's `/ready` endpoint as well to check the HTTPS proxy path.

If the readiness check fails, inspect the logs and keep the release marked unverified. If failure occurred after stopping the old app but before `docker compose up`, `docker compose start app` can restart the still-existing old container. Once the new app has started, database migrations may already have run: assess schema and queued-work compatibility before reverting code or restoring a backup. Do not remove the database volume to retry an update.

## DM navigation and Gmail connection release candidate

Ticket 02 extends these menus with Manage rules, Latest report and Pending approvals. It adds no environment variables, permissions or schema changes beyond ticket 01's automatic navigation tables. After deploying both slices with the procedure above, open Manage rules and page through the list, open Latest report, and reopen a pending item if one exists. Verify that reopening posts a separate Card without changing the saved item or approving it. Add/Edit instructions must retain the `mail` prefix; opening rule management must not save, delete or apply anything. Starter rules and removal require a subsequent approval, so do not approve them merely for a navigation smoke test.

Ticket 02 local verification on 2026-09-25: 120 tests passed; TypeScript check and build passed. Two PostgreSQL tests were skipped without `TEST_DATABASE_URL`. Standards and Spec reviews each reported zero findings. Live integration and production deployment remain unverified.

Ticket 01 adds DM menus and Gmail connection controls. There are no new environment variables, secrets or Slack/Google scopes. Startup idempotently creates shared navigation-menu and delivery-marker tables; no manual migration command is required. Existing mail state and queued work remain intact. Stop the old app before starting the new image using the update procedure above, preserving `.env` and the database volume.

After readiness succeeds, DM `menu`. Check that Budget, Help, each enabled Module and Back update the clicked menu. Open Mail Sorter → Gmail connection and verify current status; opening the page must not connect or disconnect anything. Confirm a Menu button on a newly posted mail workflow Card opens a separate menu and preserves the Card. Send `menu` again and verify both recent menus navigate independently. If Slack Unanswered is enabled, its menu should explain the existing channel/search commands without requiring Gmail. Full work-launch and management buttons remain future work.

Local verification on 2026-09-25: 114 automated tests passed; TypeScript check and build passed. Two real PostgreSQL locking tests were skipped because `TEST_DATABASE_URL` was not configured. Both Standards and Spec reviews have no outstanding findings. This candidate has not been deployed or verified against live Slack/Google; runtime tests use fake providers.

## Module refactor release: `510c05f`

- No new required secrets or Slack/Google permissions. `ENABLED_MODULES` defaults to `mail`; existing configurations keep Mail Sorter enabled. An explicitly empty value disables all modules.
- Startup automatically adds module identifiers to jobs and AI accounting records. Existing mail state, credentials, and spending remain in place. There is no separate migration command.
- Stop the old worker before the new one starts; do not run old and new versions together during this upgrade. The Compose sequence above does this.
- Users now send `mail sort`, `mail rules`, and other prefixed requests. Natural-language requests also need `mail`. Shared `help` and `budget` stay unprefixed. Previously posted mail buttons and already-queued mail work remain supported.
- Local verification after review: 75 automated tests passed, TypeScript checks and build passed. The two real PostgreSQL concurrency tests were skipped without `TEST_DATABASE_URL`; live production integrations remain to be checked on the server.

## Slack Unanswered channel picker fix

When Slack Unanswered is enabled, `ENABLED_MODULES` must include `slack` (for example, `mail,slack`). This fix changes only how channel-selection buttons are arranged in outgoing Slack messages. It requires no new environment variables, Slack permissions, or manual database migration. Rebuild and restart the app using the procedure above, then verify that `slack channels` displays selectable channels and that a selection is retained. See [Slack Unanswered](slack-unanswered.md) for the feature contract and [README](../README.md) for the required Slack scopes and module configuration.

## Slack Unanswered follow-up fixes: `93c000a` and `dea466d`

These commits detect new requests after a user's reply in a selected channel thread, filter obvious follow-up acknowledgements, guide contextual matching to recognize indirect confirmation requests in any language, and accept a valid AI citation to the asker's intervening explanation. They add no required environment variables, Slack permissions, or manual database migration. Deploy the runtime change with the update-and-restart procedure above.

After deployment, confirm `/ready`, then run `slack unanswered` for a selected channel containing a recent multi-turn exchange. Check that a new request after the user's reply links to that new message, while the earlier request remains cleared. Each candidate message must be within the command's rolling 48-hour window; an older thread root can still provide context. A private notice about incomplete contextual matching means this check did not establish a negative result. The command may use the shared AI budget.

Local verification for `dea466d`: 106 automated tests passed, including a signed-DM replay of an indirect French confirmation request; `npm run check` and `npm run build` passed. Two PostgreSQL tests were skipped because `TEST_DATABASE_URL` was not set. The live model's decision for the reported thread and a successful production deployment of this fix have not been observed.
