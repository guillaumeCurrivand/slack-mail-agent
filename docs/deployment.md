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
