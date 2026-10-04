# Updating production

Production uses Docker Compose. The confirmed server checkout is `/opt/slack-mail-agent`, running this repository's `compose.yaml` with `app` and `db` services. Keep the same Compose project name, environment file, and any override files used for the original deployment.

The confirmed production host port is **3001**. Compose maps `127.0.0.1:3001` to container port `3000` and explicitly sets the app's internal `PORT=3000`. The reverse proxy and host readiness check use port `3001`; no `.env` port change is required for this Compose setup.

For a documentation-only change, pulling the commit is sufficient if the running app already includes the latest code release. The full procedure below is needed to deploy the module refactor or another runtime change.

## Development release candidate

Target branch: existing `main`. This implementation is a locally verified release candidate; no production update has been performed. Deploy only a reviewed, pushed commit and record its SHA as `TARGET_COMMIT` on the server. Preserve `.env`, the encryption key, Compose project and database volume.

Append `development` to `ENABLED_MODULES` only after configuring `DEVELOPMENT_CLICKUP_TOKEN` and a strong `DEVELOPMENT_WORKER_TOKEN` (32+ characters). The same worker token belongs on the trusted local machine, never in Slack or prompts. Startup creates `development_*` tables automatically; no manual migration command. Apply the updated Slack manifest's `message.channels` and `message.groups` subscriptions; the existing channel/history/read/write scopes remain applicable. Invite the bot to the pilot channel. [Development setup](development.md) owns project and local worker configuration; Cursor usage is billed separately.

After the reviewed candidate is committed and pushed, run on the confirmed server, replacing the placeholder with its actual SHA:

```bash
cd /opt/slack-mail-agent &&
TARGET_COMMIT='<reviewed-main-commit-sha>' &&
git fetch origin main &&
git pull --ff-only origin main &&
test "$(git rev-parse HEAD)" = "$TARGET_COMMIT" &&
bash scripts/deploy.sh &&
curl --fail http://127.0.0.1:3001/ready
```

Stop old app workers before the new image starts (the existing deployment script does so). The local development worker runs separately on the developer's computer, not in the app container. Start it only after the selected project and checks are configured. Its checkout/journal directory must remain persistent and private. Do not expose PostgreSQL or a local inbound port for it.

Post-deploy: verify `/ready`, other Modules' menus and private ownership, Development help, project membership checks and the worker's authentication. With a consented pilot ticket, verify a posted link gets a threaded analysis, a clarification becomes a ClickUp comment, Ready for AI creates one tested maintenance commit, and the status becomes `to build`. Confirm no PR/MR, merge, deployment or base-branch change occurs. Test missing information and failed checks without a push, then a worker restart without duplicate commits. Real PostgreSQL races require `TEST_DATABASE_URL`; fake-provider and local-Git tests do not establish live provider behavior. A successful production release must be observed separately.

The 04/10/2026 local follow-up adds English commit titles, configurable maintenance branches and browser MCP verification. Deploy the reviewed, pushed release SHA; production deployment remains unverified. Rebuild/restart the server with the reviewed release before starting the updated worker: the server must accept the new `branch` result field and use it in notifications. No additional server environment variables, Slack scopes or database migrations are required. On the worker, run `npm ci` (including development dependencies), `node node_modules/playwright/cli.js install chromium`, and `npm run build`. Configure the approved MCP and local `branch`/`browser` settings using [Development setup](development.md#browser-mcp-and-replay-configuration); preserve the worker token, identity and journals. Existing pending runs keep their original branch. Local base and maintenance refs do not create GitLab branches: verify the configured remote base (`preprod` for EOA) and non-interactive Git authentication before enabling the worker. Browser smoke checks on synthetic pages do not establish a successful EOA ticket run or production deployment.

### Development configuration fix — 04/10/2026

The production diagnostic showed Slack rejecting JSON POST lookups with `invalid_arguments`, leaving the configuration job failed after five attempts and no saved project. This fix sends channel-info and membership lookups as GET requests with query parameters. Failed Slack/ClickUp configuration access checks now return a French DM explanation before saving anything.

Deploy the reviewed, pushed `main` commit with the Development commands above. No environment, Slack scope, local worker configuration or database migration changes are needed. After `/ready` succeeds, send the original `development configure` command as a **new private DM**, wait for **Projet … enregistré**, then send `development projects` and verify the project appears. The failed historical job does not restart automatically; do not modify its database state. Local fake-provider tests cover the production rejection, membership pagination, successful configuration/listing and access-error replies; a successful live reconfiguration must still be observed.

### Development worker base branch — 04/10/2026

EOA uses `preprod` as its base and `maintenance/ai` as its destination. The local worker now accepts `baseBranch`, defaulting to `test` for older configurations. This change requires restarting the local worker with the updated code and configuration; no server app rebuild/restart, environment change, Slack permission or database migration is required. The server checkout may simply pull the reviewed commit. Preserve the local token, worker identity and journals.

On the worker PC, stop the existing worker normally, pull the reviewed `main` commit if it is not already present, and set `"baseBranch":"preprod"` in the existing project entry. Restart with `npm run development:worker -- development-worker.local.json`; compiled installations must first run `npm run build`. Use `development status pilot` to identify the current blocked run, then `development retry <run-id>` once. Existing finished journals preserve their old result, so restarting alone does not retry them. Runs already in progress retain their original branch settings; do not edit or delete their journals. Confirm the new investigation progresses and the remote `preprod` tip remains unchanged. No `test` branch needs creating or publishing for EOA.

### Development repository URL validation fix — 04/10/2026

The follow-up production failure points to `new URL` in the repository validation refinement. Malformed URLs, including Slack-formatted repository links, reproduced the same uncaught `TypeError` locally even through `safeParse`. The fix accepts Slack link wrappers only in the configuration DM's repository field and uses non-throwing URL validation. Invalid values produce a French error without saving; credential-free HTTPS restrictions remain enforced.

Deploy the reviewed, pushed `main` commit using the Development procedure above. No environment, permissions, local worker or database migration changes are required. After readiness passes, send the configuration command once as a new private DM, verify **Projet … enregistré**, then verify the project in `development projects`. Previous failed jobs remain historical. Automated signed-DM regression tests cover both Slack link forms and malformed/forbidden URLs; successful live configuration remains to be observed after deployment.

### Diagnosing a failed background command

Worker failure logs include the job/Module identity, a fixed error type, recognized Slack/network or PostgreSQL SQLSTATE codes, and the first available application-relative code location. Error messages, raw stacks, SQL details, command contents and credentials are not logged. Retry and delivery behavior is unchanged. This diagnostic update requires an app rebuild/restart through the procedure above, with no environment, scope or migration changes.

After readiness succeeds, reproduce the failing command once as a new DM and run `docker compose logs --since 5m --tail 60 app`. Inspect the new `job_failed` entry's `error_code` and `error_location`; use the deployed commit's source for line numbers. The diagnostic release does not itself establish that the command's underlying failure is fixed. Do not reset historical failed jobs or repeatedly resend a command while its retries are active.

## Yousign release candidate

The opt-in [Yousign Module](yousign.md) receives the existing company subscription at `/webhooks/yousign`. Pull the reviewed release containing `src/modules/yousign/index.ts` before enabling it: older releases reject `ENABLED_MODULES` containing `yousign` and fail startup. Preserve `.env`, the existing encryption key, database volume and Compose project. Add `YOUSIGN_WEBHOOK_SECRET`, `YOUSIGN_SUBSCRIPTION_ID`, `YOUSIGN_SANDBOX` (`false` for production, `true` for sandbox), and the existing operational recipient `SLACK_ADMIN_USER_ID`; append `yousign` to `ENABLED_MODULES`. No Yousign API key, new subscription, Gmail or AI credentials are needed. Invite the bot into approved destinations; verify `channels:read`, `groups:read` and `chat:write` on the installed token.

Enabled startup creates `yousign_*` tables idempotently; no manual migration command is required. New background jobs use an explicit integration identity. Stop old workers through the deployment script before the new image starts; do not run mixed old/new app versions. Existing User jobs keep their ownership and ordering.

After the reviewed `main` change is committed and pushed, run on the confirmed server:

```bash
cd /opt/slack-mail-agent &&
git pull --ff-only origin main &&
git rev-parse HEAD &&
bash scripts/deploy.sh &&
curl --fail http://127.0.0.1:3001/ready
```

Check the printed revision against the handoff's target commit. Update the existing Yousign webhook URL to the configured HTTPS public origin plus `/webhooks/yousign`, with its original secret/subscription/environment. Preserve the raw body and signature header through the proxy and omit sensitive body logging. Observe acknowledgement latency against the provider's one-second initial deadline; local tests do not establish production latency.

Post-deploy, open **Yousign** in a private DM. Confirm the initial empty list, then explicitly activate a consented test channel. Send an approved test event through the existing provider subscription; check the French notification and `yousign statut`. Check actual private/Slack Connect access and hidden-channel privacy with eligible test Users. Verify duplicate suppression, queued removal and restart recovery; inspect an uncertain delivery through its separately saved confirmation before authorizing any resend. Check generic private operational alerts and continued operation of other enabled Modules. Disabled Yousign should expose no webhook route and preserve pending work. Live provider compatibility, actual PostgreSQL concurrency and successful production deployment require separate observation.

## ClickUp release candidate

The `clickup` Module is implemented locally and opt-in. Before enabling it, preserve the existing `.env` and `ENCRYPTION_KEY`; add `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET` and the confirmed numeric `CLICKUP_WORKSPACE_ID` for Mayasquad, then append `clickup` to the existing `ENABLED_MODULES`. ClickUp-only deployments still need the shared Slack/database/public-origin configuration and encryption key, but no Gmail or AI credentials. Disabled ClickUp requires no ClickUp secrets and exposes no OAuth routes.

Create/configure the OAuth application with its exact registered callback at the existing `PUBLIC_URL` plus `/auth/clickup/callback`. The reverse proxy must preserve HTTPS and omit/redact URL logs for `/auth/clickup*`. No new Slack scopes or installation are required. See [README setup](../README.md#clickup-setup); OAuth app configuration and credentials remain operator setup work, not observed results.

Enabled-module startup idempotently creates `clickup_connections`, `clickup_authorizations`, `clickup_oauth_states`, `clickup_confirmations`, `clickup_scans` and `clickup_limits`. There is no manual migration command. Existing Gmail, Slack, Documentation and shared budget data remain; preserve the Compose project, environment and database volume. Use the normal deployment script to stop old workers before starting the new image.

The [personal status-filter extension](clickup.md#personal-status-filters) adds `clickup_status_preferences`, `clickup_status_editors` and `clickup_status_events` through the same idempotent enabled startup. An already configured ClickUp installation requires no environment changes, secrets, Slack scopes or manual migration. Preferences persist across disconnect/replacement/disablement; pre-extension task snapshots retain their original default filter. Stop old workers before deploying the new image because they do not apply personal preferences. This is a locally verified release candidate; live status discovery and production deployment require separate observation.

The picker performance and automatic-saving fixes follow the same runtime rebuild/restart procedure, with no additional environment or schema migration. Discovery uses at most four concurrent reads, an eight-second attempt budget, immediate rate-limit deferral and preserved Retry progress. Reopening reuses a complete catalogue for up to five minutes within the original User/DM/Workspace/connection; old editors without a verification timestamp simply miss the cache. Add/Remove/reset save locally without provider calls; opening and catalogue refresh verify current account/Workspace access. Partial discovery can store default-mode name exceptions in the existing JSON preference/snapshot fields, so stop old workers before starting this version. Stale-editor, expiry and replay safeguards remain. Preserve the environment, encryption key and database volume.

After the reviewed `main` commit is pushed and the environment is prepared, run these commands on the confirmed server:

```bash
cd /opt/slack-mail-agent &&
git pull --ff-only origin main &&
git rev-parse HEAD &&
bash scripts/deploy.sh &&
curl --fail http://127.0.0.1:3001/ready
```

Compare the printed revision with the handoff's target commit. After readiness succeeds, DM `menu`, open ClickUp and connect a consented test account. Check the external browser authorization and final private Slack identity confirmation, with only Mayasquad used despite extra OAuth grants. Confirm `clickup tâches` and `clickup tasks` produce the linked eight-row table with date-only Paris deadlines, original task names/statuses and visible snapshot time. Include assigned subtasks/multiple assignees, Done/Closed exclusions, individually archived tasks and active tasks in archived locations. Verify complete provider pagination and the availability/fallback of the task's own archive flag; fake tests do not establish these live API properties.

Check Previous/Next, Refresh, Retry, repeated starts, private User/DM/message ownership and missing/revoked access. Disconnect or replace the test connection only with its own separately approved controls, then verify old result controls are unavailable. Confirm disabled-module startup without ClickUp secrets and continued operation of other enabled Modules. These paths incur no AI calls or task mutations. No production deployment or live OAuth/API/Slack result has been observed. Actual PostgreSQL concurrency tests, including external-account uniqueness, require disposable `TEST_DATABASE_URL` and are skipped when absent.

For status filters, DM `clickup statuts` and check **Choisir les statuts** from the connected Module menu. Inspect unused/custom/inherited/completed names, shared locations and reachable archived Spaces/Folders/Subfolders/Lists; Personal List-specific discovery is labelled deferred. Confirm all pages are reachable and identical names appear once. With a consented test User, Add/Remove a status, Fermer, then reopen: each change must persist without Enregistrer. Include Done/Closed and check immediate reset. A new task request and Refresh must apply it while an earlier result retains its original filter. Check that another User keeps an independent selection; old editors conflict after a change/reset in another editor and cannot act from another DM/message/connection or after 30 minutes. Rename a consented test status to check unavailable-name retention without fallback. Incomplete discovery must remain visible and offer Retry while explicit changes save without silently dropping undiscovered unfinished statuses or other custom selections. Verify account replacement and disable/re-enable retain preferences. Do not claim live catalogue completeness until actual archive/inheritance/shared-access behavior is observed. The disposable PostgreSQL suite also checks concurrent preference-save conflicts.

For the picker fixes, use the reported twelve-page account to check initial loading, immediate local Retirer/Add/reset saving and page/close response, and faster reopening with the original catalogue timestamp. Actualiser les statuts must force rediscovery. A timeout/cooldown must show incomplete coverage, preserve undiscovered statuses when editing default mode, and resume through Retry after the reset; discovery itself must never replace preferences. Check persistence after leaving/reopening and after an app restart, frozen task filters, rejected last-custom-choice removal, and rejection of an old editor after reconnect/replacement. Local fake-provider timing does not establish production latency; observe these behaviors after deployment.

## Full-width Slack panels

The French interface and horizontal action groups follow the same runtime rebuild/restart procedure after their reviewed `main` changes are committed and pushed. No environment variables, scopes, secrets or database migrations are added. Existing saved values, old controls, approvals, expiry times and AI checkpoints remain compatible. This is locally verified work; successful production deployment and live Slack layout still require observation.

After updating and checking `/ready`, send `aide` and open each enabled Module. Check French menus/help, side-by-side buttons and a separate Documentation record selector on desktop and a narrow client. Open an existing record to verify clickable URLs and French dates/numbers; reopening old generated text should show a French notice while retaining its original content. Check `courrier aide`, `slack aide` and `documentation aide`; English shortcuts should continue to work. Use approved synthetic data for mutation checks, and do not make paid model requests solely to verify translation. Slack may wrap buttons when space is limited.

The shared Slack renderer requests `width: "full"` for every grouped panel, including continuation panels, as specified in [interactive message presentation](product-spec.md#interactive-message-presentation). This runtime change requires the existing [update-and-restart procedure](#update-and-restart) after its `main` commit is pushed. There are no environment, permission, or database migration changes.

After `/ready` succeeds, send `menu` and open a Module to check both newly posted and updated panels fill Slack's available message space. Check a long result or Help Card at different window sizes; Slack controls the actual client layout. Existing messages acquire the new width only when updated or posted again. Live Slack rendering and production deployment require separate verification.

## Documentation review corrections

Components now accept up to 50 existing Technology references, allowing a Project's combined stack to remain on one Component during import. The same limit applies to structured creation/editing, conversational mutations and reviewed import. This requires a runtime rebuild/restart using the existing update procedure, with no additional environment or database migration changes. After deployment, check that Documentation Component help says 50 and that the reviewed import validates its complete Technology selection before approval/apply. This change does not authorize importing real data.

The review fixes on `main` add saved edit before-values, private **Review values** pages, eligibility checks for saved inventory query selectors, and explicit actor/workspace/DM predicates on question checkpoints. Follow the existing [runtime update procedure](#update-and-restart) after the reviewed changes are committed and pushed. Preserve the existing environment, Compose project and database volume. There are no new environment variables or permissions; startup idempotently adds nullable `before_values` to `documentation_confirmations`, with no manual migration command. Old pending confirmations remain valid within their original expiry and label unavailable before-values.

After deployment, check `/ready`, then propose an edit and inspect its before/after comparison without confirming unintended changes. Verify **Review values** opens a separate private Card and large comparisons paginate. In an approved test inventory, open a relationship query, archive its referenced record with separate confirmation, and reopen the saved query: expect guidance instead of a zero count; explicit `includeArchived` should remain usable. Use existing confirmation/history checks to verify intervening edits still overwrite selected fields and record actual replaced values. These checks do not authorize real import or paid model evaluation. Local automated verification does not establish successful production deployment or live Slack behavior.

## Documentation presentation release candidate

The presentation redesign on `main` uses native Slack tables, private record dropdowns, clickable saved URLs and human-readable relationship values. See the [presentation contract](documentation.md#presentation-redesign). This is a local release candidate until a deployment and live Slack rendering are observed. Deploy only after the reviewed changes are committed and pushed; use the handoff's target commit to check the server revision.

No environment changes, new secrets, Slack scopes or database migrations are required. Preserve the existing `.env`, Compose project and database volume. Old navigation buttons and confirmations remain supported; the redesign does not change inventory authority or authorize a real import.

Use the confirmed server checkout and existing update procedure:

```bash
cd /opt/slack-mail-agent &&
git fetch origin main &&
git pull --ff-only origin main &&
bash scripts/deploy.sh &&
git rev-parse HEAD &&
curl --fail http://127.0.0.1:3001/ready
```

Compare the printed revision with the handoff's target commit. After readiness succeeds, privately browse Projects, Technologies, Hosts/services, Tools, Archived and History. Confirm tables render on desktop and mobile, eight-record pagination works, and **Open record…** updates the clicked message. Inspect Components and **Hosting entries** from a Project, click saved repository/documentation/hosting links, and check that ordinary screens show names/context rather than record identifiers. In a consented test record, propose a selected-field edit and inspect the complete before/after review without applying unintended changes. Confirm unavailable historical before-values and current reference names are labeled, value pages stay complete, and a different User/DM cannot use private dropdowns or review controls. Verify existing Mail Sorter and Slack Unanswered navigation remains usable when enabled. These browsing checks use no AI or Gmail.

## Documentation import release candidate

Ticket 10 on `main` adds the [offline operator import workflow](documentation-import.md). Keep the existing `ENABLED_MODULES` with `documentation` enabled for inventory access/import. No new environment variables, credentials, Slack/Google scopes or manual migrations are required. Startup idempotently adds `documentation_import_batches` and `documentation_import_effects`; existing records/history, environment and database volume remain. Deploying the code does not review/apply real source data or change inventory authority. Real source review, User approval, import and rollout remain separately authorized operator actions.

After the reviewed commit is pushed, use the confirmed server checkout and existing deployment script:

```bash
cd /opt/slack-mail-agent &&
git pull --ff-only origin main &&
bash scripts/deploy.sh &&
curl --fail http://127.0.0.1:3001/ready &&
docker compose exec -T app node dist/modules/documentation/import-cli.js --help
```

Check the checkout revision against the handoff's target commit with `git rev-parse HEAD`. The script backs up the database and recreates only the app, preserving `.env`, the Compose project and its existing volume. Post-deploy, confirm `/ready`, normal Documentation lists/details/history and CLI help. These checks do not apply inventory data or use AI/Gmail. Synthetic operator import testing belongs in a disposable test database; do not run fixtures against the production workspace as a deployment smoke test.

For a separately authorized real import, follow the [operator procedure](documentation-import.md), take a new protected database backup immediately before apply, and check workspace, snapshot completeness, mapping evidence/ambiguities, existing-record identities and actual User approval. Container paths below are **operator-selected placeholders**; copy the frozen files into a protected directory readable by the app's `node` user before using them:

```bash
docker compose exec -T app node dist/modules/documentation/import-cli.js apply /operator-selected/snapshot.json /operator-selected/review.json /operator-selected/approval.json
docker compose exec -T app node dist/modules/documentation/import-cli.js reconcile /operator-selected/snapshot.json /operator-selected/review.json /operator-selected/approval.json
docker compose exec -T app node dist/modules/documentation/import-cli.js status
```

Inspect the report and Slack inventory/history against approved counts and relationships. Only a successfully applied and reconciled batch establishes database authority; an incomplete/failed batch retains recoverable checkpoints. Subsequent spreadsheet edits do not synchronize. A local release candidate is distinct from observed deployment/import success. Real PostgreSQL recovery/concurrency checks require disposable `TEST_DATABASE_URL`; live Slack and actual source-data validation remain separate checks.

## Documentation natural-language changes release candidate

Ticket 09 on `main` adds conversational individual-record changes through existing confirmation/commit/history paths. Keep the existing `ENABLED_MODULES` value with `documentation` enabled. No new required environment variables, secrets, Slack/Google permissions or manual migration commands are needed. Natural-language interpretation uses existing optional `OPENAI_API_KEY` and the reviewed pinned `OPENAI_MODEL`; structured alternatives remain free. Startup idempotently adds `resolved_command` to `documentation_questions` and `source` to `documentation_confirmations` (old rows retain `Slack structured` attribution). Stop old workers through the existing deployment script before starting this version; preserve `.env`, the Compose project and database volume.

Deploy the reviewed `main` commit after it is pushed:

```bash
cd /opt/slack-mail-agent &&
git pull --ff-only origin main &&
bash scripts/deploy.sh &&
curl --fail http://127.0.0.1:3001/ready
```

After readiness returns `{"ok":true}`, use the [consented/synthetic evaluation cases](testing/documentation-natural-language-changes.md) under the existing shared allowance. Inspect each proposal's exact target, selected values and resolved relationship identifiers before separately confirming one synthetic record. Check all six kinds across create/edit/archive/restore, Record details/History controls, cross-User/DM rejection, missing/ambiguous references and explicit context expiry. Verify Alice's selected field overwrites Bob's intervening selected-field edit, preserves unrelated fields, logs actual prior values and cannot reapply after a later edit. Archived edits require separate restoration within the original window. Confirm navigation and replay do not pay again, unavailable interpretation offers free alternatives, and history accurately distinguishes natural-language sources. Do not use real production mutations to measure interpretation quality.

This is a local release candidate, not an observed production deployment. Live Slack/OpenAI quality and disposable real PostgreSQL locking tests remain release checks; fake-provider tests do not establish model accuracy. Import and authority transition remain separate work.

## Documentation inventory queries release candidate

Ticket 08 adds constrained inventory questions, exact free `search`/`count` commands and current-data pagination. Keep the existing `ENABLED_MODULES` value with `documentation` enabled. No new required environment variables, secrets, permissions or manual migrations are needed. There are no schema changes; validated queries use the existing question table and inventory fingerprints travel in actor-bound page controls. Natural-language interpretation uses existing optional OpenAI credentials and shared spending safeguards. Preserve `.env`, the Compose project and the database volume; stop old workers through the existing deployment procedure.

Deploy the reviewed `main` commit after it is pushed:

```bash
cd /opt/slack-mail-agent &&
git pull --ff-only origin main &&
bash scripts/deploy.sh &&
curl --fail http://127.0.0.1:3001/ready
```

After readiness returns `{"ok":true}`, use consented synthetic Projects with multiple Components/environments and shared Technologies/Hosts/Tools. Compare `documentation search {"target":"project","filters":[{"kind":"technology","selector":"React"},{"kind":"host","selector":"Compute"}],"scope":"project"}` with `scope:"same-component"` and `documentation count` using the same JSON. Check exact component/environment qualifiers, total distinct counts beyond eight results, reverse relationships, saved links and Unknown values. Compare company-wide Tool fields with explicit Project filters. Page forward, edit or archive a record from another User, then page again: coverage must restart visibly at page one. Another User/DM must not use those controls. Missing/ambiguous selectors must request clarification. With AI unavailable, structured reads and paging must work. Evaluate live natural-language phrasing separately under the shared allowance; fake-provider tests do not establish model accuracy.

This is a locally verified release candidate, not an observed production deployment. Real PostgreSQL locking checks require a disposable `TEST_DATABASE_URL`; live Slack/model evaluation, import and authority transition remain separate work.

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

## Documentation Project questions release candidate

Ticket 07 on `main` adds Project hosting/Technology questions with private 30-minute context. Keep the existing `ENABLED_MODULES` with `documentation` enabled. No new required environment variables, secrets or permissions are introduced. Natural-language interpretation uses the existing optional `OPENAI_API_KEY` and pinned `OPENAI_MODEL`; structured operations work without them. Startup idempotently creates `documentation_questions` and `documentation_project_context`; no manual migration is required. Existing records/history and pending confirmations are retained. Stop old workers before starting the new image and preserve `.env`, the Compose project and database volume.

Deploy the reviewed commit with the existing procedure:

```bash
cd /opt/slack-mail-agent &&
git pull --ff-only origin main &&
bash scripts/deploy.sh
```

After readiness succeeds, use a consented synthetic Project and DM `documentation where is <Project> hosted?`, then `documentation which technologies does this project use?`. Check production-first Components/environments, Unknown fields, archived references, stable detail controls, saved links and pagination. Rename/edit through separately confirmed structured controls and verify a follow-up uses current values. A second User must not inherit context or use the first User's choices. After 30 minutes, a follow-up must ask which Project. Check free lookup/editing/history without a key or remaining budget and inspect `budget` for Documentation attribution. Use the [synthetic cases](testing/documentation-project-questions.md) for separate model-quality evaluation; these checks can spend from the shared allowance.

This is a locally verified release candidate until production readiness, live Slack and model evaluation are observed. Real PostgreSQL locking tests require `TEST_DATABASE_URL`; report skips separately. Spreadsheet import and inventory authority transition remain separate work.

## Documentation Projects release candidate

Documentation tickets 01 and 02 add opt-in shared Projects, lifetime history, private structured creation/edit confirmations, exact lookup and paginated navigation. To expose it, append `documentation` to the server's existing `ENABLED_MODULES` value while preserving other module identifiers. Keeping the current value leaves Documentation disabled. There are no new secrets, Slack permissions, Google permissions or AI credentials. Startup idempotently creates five Module-owned `documentation_*` tables; ticket 02 adds `operation` (existing rows default to creation) and `outcome` columns to confirmations. No manual migration command is required. Existing creation controls remain valid. Existing inventory/history and private state remain when disabled. Lifetime inventory/history are excluded from interaction cleanup.

Deploy the reviewed `main` commit with the [update-and-restart commands](#update-and-restart), preserving `.env`, the Compose project and database volume. Stop the old app before starting the new version as the script does; older workers do not understand edit confirmations. The feature remains a locally verified release candidate until deployment/readiness and live Slack checks are observed. With no `TEST_DATABASE_URL`, the real PostgreSQL confirmation, cross-User overwrite and rollback tests are skipped; run them against a disposable test database before relying on cross-connection concurrency guarantees.

After `/ready` succeeds, DM `menu` and open Documentation → Projects. Check Help, Add Project, Back/Menu and pagination; existing Mail Sorter/Slack Unanswered menus should remain usable. With a consented synthetic test record, send `documentation create project {"name":"Deployment smoke test"}`, review all fields and confirm. Repeat the click and verify exactly one Project/history entry. A second User should see the Project and actor/source-attributed history, while the first User's navigation controls and pending confirmations remain private. Check saved HTTP(S) links on details with a synthetic linked record. These Documentation checks need no AI or Gmail. Do not import the real spreadsheet or switch inventory authority as part of this deployment; import is a later separately approved operator task.

For ticket 02, open the test Project's Edit instructions. Alice proposes `documentation edit project <test-identifier> {"description":"A"}`; Bob proposes and confirms `documentation edit project <test-identifier> {"description":"B","notes":"Bob notes"}`. Confirm Alice's original Card and check description A, notes Bob notes and Alice's B → A history. Save a later description from Bob, click Alice's old confirmation again, and verify it reports the saved outcome while preserving Bob's later value. Inspect both Project History and the Module's shared History list, including pagination. Confirm another User cannot approve Alice's pending Card. These are manual post-deployment checks, not results observed during local implementation.

## Documentation Technologies and Components release candidate

Ticket 03 extends Documentation with Technology catalog maintenance and Project Components linked to existing Technologies. Keep the existing `ENABLED_MODULES` value if Documentation is already enabled; otherwise append `documentation` while preserving other module identifiers. There are no new required environment variables, secrets, Slack scopes, Google permissions or AI credentials. Startup adds `record_kind` to confirmations (existing rows default to Project) and creates `documentation_records` and `documentation_record_history`, including the Component parent foreign key. No manual migration command is required. Existing Projects, history and pending creation/edit controls remain valid. New record/history tables have lifetime retention.

Deploy the reviewed `main` commit with the [update-and-restart procedure](#update-and-restart). Preserve `.env`, the Compose project name and database volume. Stop old workers before new workers start; old versions do not understand the new record confirmations. This is a locally verified release candidate until production readiness and live Slack checks are observed. Real PostgreSQL catalog/Component cross-User locking tests are skipped when `TEST_DATABASE_URL` is unavailable; use a disposable test database for them.

After `/ready` succeeds, DM `documentation help` and open Documentation → Technologies → Add Technology. With a consented synthetic test record, create and separately confirm `documentation create technology {"name":"Deployment test technology","category":"Test"}`. Create a test Project through the existing workflow, copy its identifier, open its Components → Add Component instructions, and create `documentation create component {"name":"Deployment test frontend","projectId":"<test Project identifier>","type":"frontend","technologies":["Deployment test technology"]}`. Confirm it separately. Verify the Component navigates to its Project and Technology, and the Technology's Components list navigates back. A Component in a second test Project may reference the same Technology; the catalog must still contain one test Technology. Rename the test Project, Component and Technology via separately confirmed edits and verify identifiers/relationships are preserved.

Check Technology, Component and shared History, Add/Edit instructions, Back/Menu and pagination where there are enough records. Check another User can read the shared records but cannot approve the first User's pending Card or operate their private navigation. Apply Bob's edit between Alice's proposal and confirmation, verify actual overwrite history and preservation of unrelated fields, then replay Alice's Card after a later edit and verify that later values remain. A Component request referencing a missing or ambiguous Technology must require explicit resolution or separately confirmed Technology creation, without saving a Component. These paths use no AI or Gmail. These are post-deployment checks, not live results observed during local implementation; hosting, import and authority transition remain later work.

## Documentation Hosts/services and Hosting entries release candidate

Ticket 04 extends Documentation's existing typed records/history tables with Hosts/services and Hosting entries. Keep `documentation` in the existing `ENABLED_MODULES`, or append it to enable this opt-in Module. No new required environment variables, secrets, Slack/Google scopes, or AI credentials are needed. Startup idempotently extends the record-kind/parent constraints and adds `component_id` with a workspace-composite self foreign key. No manual migration command is required. Existing inventory/history and pending controls remain compatible. Stop old workers before starting the new version; they do not understand Host/service or Hosting entry confirmations. Preserve `.env`, the Compose project and database volume.

Deploy the reviewed `main` commit using the [update-and-restart procedure](#update-and-restart):

```bash
cd /opt/slack-mail-agent &&
git pull --ff-only origin main &&
bash scripts/deploy.sh
```

After `/ready` returns `{"ok":true}`, check Documentation → Hosts/services → Add Host/service and a consented synthetic Component → Hosting entries → Add Hosting entry. Separately create/confirm `documentation create host {"name":"Hosting smoke test"}`, then `documentation create hosting {"componentId":"<test Component identifier>","serviceId":"Hosting smoke test","environment":"production","urls":["https://example.com"],"accessInstructions":"See password manager"}`. Add a separately confirmed staging entry and another Component using the same service. Project details must show distinct Components/environments, production first, saved links and Unknown missing values; costs appear only on the Host/service record. Check navigation, history, Add/Edit instructions, and private ownership. Rename the service and Component and confirm links still identify the original records. With two Users, apply an intervening selected-field edit plus unrelated notes, confirm the first edit, and inspect actual overwrite history and retained notes. Replay the first confirmation after a later edit and verify that later values remain.

These are manual post-deployment checks, not observed live results. This remains a locally verified release candidate until production readiness and live Slack verification are observed. Without `TEST_DATABASE_URL`, real PostgreSQL locking tests are skipped; use a disposable PostgreSQL database before relying on cross-connection concurrency verification. These structured checks use no AI, Gmail or infrastructure-provider calls. Real data import and authority transition remain separate work.

## Documentation Tools release candidate

Ticket 05 adds shared Tools and Project relationships using the existing typed records/history/confirmation tables. Keep `documentation` in the existing `ENABLED_MODULES`, or append it while preserving other enabled Modules to expose Documentation. No new required environment variables, secrets, Slack/Google scopes or AI credentials are needed. Startup idempotently extends the record-kind/parent constraints for Tools; there are no new tables or manual migration commands. Existing inventory/history and pending controls remain compatible. Stop old workers before starting this version; they do not understand Tool confirmations. Preserve `.env`, the Compose project and database volume.

Deploy the reviewed `main` commit with the [update-and-restart procedure](#update-and-restart):

```bash
cd /opt/slack-mail-agent &&
git pull --ff-only origin main &&
bash scripts/deploy.sh
```

After `/ready` returns `{"ok":true}`, open Documentation → Tools → Add Tool and check Help, pagination and Back/Menu. With consented synthetic records, separately create/confirm two test Projects, then `documentation create tool {"name":"Tool smoke test","companyWide":true,"projects":["<first Project identifier>","<second Project identifier>"],"referent":"Test contact"}`. Check Unknown usage/notes, Tool → each Project and Project → Tools navigation. Rename a Project and the Tool using separately confirmed edits and verify stable links. A second User must see/edit the shared Tool through their own confirmation, but cannot approve the first User's Card or use their private navigation. Propose usage A, let another User confirm usage B and unrelated notes, then confirm A and inspect B → A history with notes retained. Replay A after a later edit and verify the later value remains. Missing/ambiguous Project references must ask for separate creation or explicit resolution without creating a Tool. Browse Tool and shared History. These checks use no AI or Gmail and referents cause no notifications.

These are manual post-deployment checks, not observed live results. This remains a locally verified release candidate until production readiness and live Slack verification are observed. Real PostgreSQL Tool cross-User locking tests require a disposable `TEST_DATABASE_URL`; without it they are skipped. Import, authority transition and production deployment remain separate work.

## Documentation Archive/Restore release candidate

Ticket 06 adds confirmed lifecycle changes across all six inventory kinds and the paginated Archived view. Keep the existing `ENABLED_MODULES` value with `documentation` enabled. There are no new required environment variables, secrets, Slack/Google scopes or AI credentials. Startup idempotently adds `archived boolean NOT NULL DEFAULT false` to `documentation_projects` and `documentation_records`; no manual migration command is required. Existing inventory, history, relationships and pending confirmations are retained. Stop old workers before starting the new image; they do not enforce the archived-target edit guard or understand lifecycle confirmations. Preserve `.env`, the Compose project and database volume.

Deploy the reviewed `main` commit with the [update-and-restart procedure](#update-and-restart):

```bash
cd /opt/slack-mail-agent &&
git pull --ff-only origin main &&
bash scripts/deploy.sh
```

After `/ready` returns `{"ok":true}`, open Documentation → Archived and verify pagination/private ownership with consented synthetic records. Create a test Project, Component and Host/service with a Hosting entry, plus a Technology and Tool. For each kind, open Archive, inspect the separate confirmation, confirm as its initiating User, and verify ordinary lists omit it while exact details/history show Archived and offer Restore. An archived Host/service must leave its Project active and remain visibly labeled in current Project hosting details. Restore as another User through that User's own controls and verify the stable identifier, fields and relationships remain. Replay the old Archive and verify it cannot rearchive; then test the equivalent old Restore replay after a fresh Archive.

Propose an edit, archive its target from another User, and click the edit: it must require restoration without changing fields. Separately restore and retry within the original window, verifying overwrite history and unrelated-field preservation. Confirm expired edits remain expired after restoration or disable/re-enable. Inspect lifecycle actor/time/source and actual before/after history. These are manual post-deployment checks, not observed results. This is a locally verified release candidate until production readiness and live Slack are observed; real PostgreSQL lifecycle races are skipped without a disposable `TEST_DATABASE_URL`. These flows require no AI or Gmail. Import and inventory authority transition remain separate work.

## Safe work-launch release candidate

Ticket 04 adds Sort inbox and Find unanswered to the Module menus. It also creates `core_operation_slots` and the module-owned `slack_unanswered_results` display cache automatically, and changes the worker advisory-lock scope. No manual database migration, new secret, Slack scope, or Google permission is required. Keep `WORKER_CONCURRENCY` at 2–4; the default and existing `.env.example` use 2. Stop the old app before starting this version, as the deployment script does, so old workers cannot process new operation jobs. Result pagination buttons from the old version ask for a fresh search; new result pages reuse the original calculation without another paid AI call and recheck current channel access.

Deploy the reviewed `main` commit with the update-and-restart commands above, preserving the existing `.env`, Compose project and database volume. After `/ready` succeeds, DM `menu` and open each enabled Module. Confirm that Sort inbox reports missing Gmail or starts a separate Preview Card when a valid account and rules are present; no mailbox changes occur until that Preview is approved. Confirm Find unanswered reports missing channel selections or posts a separate private result Card with source links and an incomplete-results notice when contextual AI is unavailable. Open Back/Menu while a test provider call is running and confirm navigation and the other Module respond. Two rapid starts of the same operation should produce one work result and a status Card naming the original request. A later deliberate start should work. These live checks can use paid AI and should be done with the existing shared allowance and a consented test account.

This is a local release candidate until real Slack/Gmail/OpenAI behavior and production readiness are observed. Without `TEST_DATABASE_URL`, embedded-database tests do not prove PostgreSQL's cross-worker admission and advisory-lock behavior; run the real database suite against a disposable PostgreSQL database before relying on those concurrency guarantees.

## Slack channel management release candidate

Ticket 03 adds Slack Unanswered → Choose channels and makes `slack channels` a private list that updates in place for pagination and Add/Remove. It adds no environment variables, Slack scopes, or manual database migration; it uses ticket 01's idempotent navigation tables. Deploy with the update-and-restart procedure above. After readiness succeeds, DM `menu`, open Slack Unanswered → Choose channels, page through eligible shared channels, Add one and Remove it. Verify the same Agent message changes, the selection status changes, and Back returns to the module menu. If you have an inaccessible saved selection, verify it appears by ID with a Remove button and no channel content. Browsing must not start `slack unanswered` or use AI. Slack Unanswered must be enabled in the existing `ENABLED_MODULES` value for this smoke test.

Ticket 03 local verification on 2026-09-25: 124 automated tests passed; TypeScript check and build passed. Two real PostgreSQL tests were skipped without `TEST_DATABASE_URL`. Live Slack, AI, and production deployment remain unverified.

## DM navigation and Gmail connection release candidate

Ticket 02 extends these menus with Manage rules, Latest report and Pending approvals. It adds no environment variables, permissions or schema changes beyond ticket 01's automatic navigation tables. After deploying both slices with the procedure above, open Manage rules and page through the list, open Latest report, and reopen a pending item if one exists. Verify that reopening posts a separate Card without changing the saved item or approving it. Add/Edit instructions must retain the `mail` prefix; opening rule management must not save, delete or apply anything. Starter rules and removal require a subsequent approval, so do not approve them merely for a navigation smoke test.

Ticket 02 local verification on 2026-09-25: 120 tests passed; TypeScript check and build passed. Two PostgreSQL tests were skipped without `TEST_DATABASE_URL`. Standards and Spec reviews each reported zero findings. Live integration and production deployment remain unverified.

Ticket 01 adds DM menus and Gmail connection controls. There are no new environment variables, secrets or Slack/Google scopes. Startup idempotently creates shared navigation-menu and delivery-marker tables; no manual migration command is required. Existing mail state and queued work remain intact. Stop the old app before starting the new image using the update procedure above, preserving `.env` and the database volume.

After readiness succeeds, DM `menu`. Check that Budget, Help, each enabled Module and Back update the clicked menu. Open Mail Sorter → Gmail connection and verify current status; opening the page must not connect or disconnect anything. Confirm a Menu button on a newly posted mail workflow Card opens a separate menu and preserves the Card. Send `menu` again and verify both recent menus navigate independently. If Slack Unanswered is enabled, its menu should explain the channel/search commands without requiring Gmail. Work-launch buttons remain future work.

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
