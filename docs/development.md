# Development — local maintenance automation

The User approved this Module on 03/10/2026. Implementation is local; real Slack, ClickUp, Cursor, browser verification and production deployment require live validation. The technical Module ID is `development`; the Slack name is **Développement**.

## Approved behavior

Each Development project connects one Slack channel, one ClickUp Folder (all non-archived Lists), one repository and one Cursor skill. The pilot starts with one project. Everyone in the channel may interact with it. Configuration and status commands are available through private Module DMs and recheck channel membership. Bot membership is required. Existing personal ClickUp OAuth connections and other Modules' state remain private.

A ticket link posted in the connected channel queues an investigation. The local worker reads the ticket snapshot, comments and repository using the configured skill, then responds in the original Slack thread with an actionable result or specific missing-information questions. Human thread replies before authorization are saved as attributed ClickUp clarification comments and trigger reassessment. Bot messages, edits, unrelated channels and unsigned events are ignored. Standard `https://app.clickup.com/t/<task-id>` links are supported; custom-ID URLs should be replaced with the task's standard link. Arbitrary linked pages are not fetched by the server.

An enabled Folder is polled once per minute. A human selecting `Ready for AI` authorizes implementation, including for subtasks independently carrying that status and tickets never linked in Slack. Already-ready tickets are eligible when the project is first enabled. The first accepted snapshot freezes requirements; the worker does not reread them during implementation. Moving away from Ready for AI must be observed by a poll before moving back can authorize another run. `development retry <run-id>` explicitly retries a blocked run against its frozen snapshot. A repeated delivery or repeated poll never authorizes another attempt.

Implementation runs sequentially per repository with two attempts total (initial plus one retry), no execution deadline, and a separate checkout for each run. The controller runs the configured automated checks; changes to visible behavior require configured browser checks. Missing information or failed necessary verification blocks publication, posts the blocker to Slack/ClickUp, and leaves unfinished work in its private checkout. Other independent queued work may proceed.

After successful verification, the controller creates one descriptive English commit per ticket and pushes it to the locally configured maintenance branch, never force-pushing. `branch` defaults to `maintenance`; the EOA pilot uses the approved `maintenance/ai`. The coding agent supplies a separate English `commitTitle`; the controller adds `fix(clickup:<task-id>):` instead of copying a possibly French ticket title. Missing or multiline titles block publication. ClickUp/Slack reports and clarification questions remain French. It changes the ticket to **`to build`** only after a confirmed push, then posts the commit link, summary and test results. Multiple tickets may accumulate on the configured maintenance branch. Humans review, open the PR/MR, merge to the configured base branch (`preprod` for EOA), deploy and close tickets. If the base branch and that maintenance branch diverge, a human reconciles them; the worker does not create surprise merge commits. After maintenance is merged normally into the base branch, the next run starts from its newer tip.

## Server setup

1. Preserve existing Module IDs and append `development` to `ENABLED_MODULES`.
2. Set `DEVELOPMENT_CLICKUP_TOKEN` to a dedicated ClickUp token with access to the intended Folder, comments and status updates. This belongs to Development, not another person's saved ClickUp connection.
3. Generate a strong random `DEVELOPMENT_WORKER_TOKEN` of at least 32 characters. Store the same value securely on the trusted worker. Never paste it into Slack, prompts or source control. Worker endpoints require this bearer token and production HTTPS.
4. Apply the updated [Slack manifest](../slack-manifest.json): add `message.channels` and `message.groups` alongside `message.im`. Existing bot scopes include `channels:read`, `groups:read`, `channels:history`, `groups:history` and `chat:write`; reinstall if granting additional scopes. Invite Mayassistant to the chosen channel. Editing the repository manifest alone does not update the installed Slack app.
5. Restart through [the deployment procedure](deployment.md#development-release-candidate). Startup creates the Module's `development_*` tables and its durable polling job automatically.

In a DM, open **Développement**, then configure the project (replace every example value):

```text
development configure {"id":"pilot","name":"Pilot","channel":"CPROJECT","folder":"123456","repository":"https://github.com/ORGANIZATION/REPOSITORY","skill":"maintenance"}
development projects
development status pilot
```

French aliases are `development configurer`, `development projets`, `development statut` and `development relancer`. Configuration JSON keys and exact ClickUp status values stay unchanged. Repository URLs must be credential-free HTTPS URLs; GitHub and GitLab repository paths are supported. The worker independently allowlists the same project ID, repository and skill. Configuring a Slack project cannot choose arbitrary executables or local paths on the worker. Set `"enabled":false` in the complete configuration to pause new claims; already-started work may finish. Retain the same worker identity until its active claims are resolved.

Configuration checks Slack channel membership and ClickUp Folder access before saving. If either access check fails, the DM identifies Slack or ClickUp and asks the User to resend the command after resolving access; the requested configuration is not saved. The local Cursor worker is not needed for configuration. A successful command replies **Projet … enregistré**. If an older version silently exhausted its queued retries, send a new configuration message after upgrading; do not reset the failed job in the database.

The configuration DM accepts Slack's automatic `<https://…>` and `<https://…|label>` formatting in the JSON `repository` string and stores the link target as the plain URL. The label never selects the repository. Invalid URLs return **Configuration invalide** instead of throwing; HTTPS and the restrictions on credentials, query strings and fragments still apply.

## Local worker setup

Use Node 24+, Git, an authenticated Cursor CLI, repository access and the project's development prerequisites. A long-running app can inherit an older PATH than a newly opened PowerShell session. Check the installed launcher before concluding the CLI is absent. Follow the official [Cursor installation](https://cursor.com/docs/cli/installation), [authentication](https://cursor.com/docs/cli/reference/authentication) and [headless](https://cursor.com/docs/cli/headless) documentation for the actual workstation.

Copy [development-worker.example.json](../development-worker.example.json) to `development-worker.local.json` and edit it. `repository`, `id` and `skill` must match the server's project. Use a dedicated `stateDirectory` outside an existing working checkout; the worker creates separate clones beneath it. `skillPath` points to a worker-compatible `SKILL.md`; the [maintenance skill template](../skills/development-maintenance/SKILL.md) provides investigation, verification, French reports and English commit titles. Unlike an interactive ticket skill, it leaves commits, ClickUp writes and publication to the controller. Include project-owned supporting skill files in the repository or make referenced paths available on the worker.

`agent` is an executable-and-arguments array. It defaults to `["agent"]`; use the installed CLI's executable or interpreter entry point. Child processes do not use implicit shell expansion. On Windows, `.cmd`/`.bat` launchers cannot be passed as native executables: configure a supported executable/interpreter launcher, or run the worker and Cursor in WSL. Do not interpolate ticket contents into shell commands.

For Cursor's Windows PowerShell launcher, use `["powershell.exe", "-NoProfile", "-File", "C:/Users/YOUR_USER/AppData/Local/cursor-agent/agent.ps1", "--trust"]`, replacing the path with the installed launcher. `--trust` acknowledges the per-run workspace in headless mode. This avoids relying on PowerShell command discovery from a native Node child process. An explicit launcher was verified with `--version` on 04/10/2026; that does not verify account authentication or a coding run.

`setup`, `checks` and `browserChecks` are trusted local command arrays. Adapt the example to the project. `setup` prepares each new checkout without modifying non-ignored files. `checks` must contain at least one real validation command. Configure either `browser` for MCP exploration plus independent scenario replay, or `browserChecks` for trusted command-based browser checks. Worker success depends on their exit codes; Cursor's textual claims alone do not count as passing checks. No live browser suite was exercised during implementation.

Cursor's [integrated browser](https://cursor.com/docs/agent/tools/browser) is documented in the editor; this worker uses [CLI MCP support](https://cursor.com/docs/cli/mcp) with [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp). Install worker development dependencies with `npm ci`, then `node node_modules/playwright/cli.js install chromium`. Configure a Cursor MCP named `mayassistant-browser` using the installed Node executable and the absolute path to `node_modules/@playwright/mcp/cli.js`, with `--headless`, `--isolated`, `--block-service-workers` and an external `--output-dir`. Use `--executable-path` with the Chromium path returned by `node -e "console.log(require('playwright').chromium.executablePath())"`, and restrict `--allowed-origins` to the preview and approved test services. Preserve existing MCP entries; enable only this server with `agent mcp enable mayassistant-browser`. No project Cypress/Playwright test suite is required for this mode. Use non-watching unit-test commands (for example `npm test -- --watchAll=false` for Create React App).

The worker requires the remote `baseBranch` (`test` by default; EOA uses `preprod`) and publishes to the separate configured `branch` (`maintenance` or `maintenance/<name>`). Set `"baseBranch":"preprod"` alongside `"branch":"maintenance/ai"` in the EOA local project entry. Base branch names use letters, numbers, underscores and hyphens, optionally separated by single slashes; base and destination must differ. Creating local branches alone does not make them available to fresh remote clones. Git cannot store `maintenance` alongside `maintenance/...`; use `maintenance/ai` when that namespace is already in use. A run pins both branches before execution; restore its original configuration when recovering an in-flight run. Legacy journals without a base branch retain `test`; an already-blocked missing-branch run needs a fresh explicit retry after updating and restarting the worker. New server code must be deployed before workers report the new `branch` result field.

Set `DEVELOPMENT_WORKER_TOKEN` in your local environment, authenticate Git/Cursor normally, then run from the Mayassistant checkout:

```powershell
npm run development:worker -- development-worker.local.json
```

For a compiled installation:

```powershell
npm run build
node dist/modules/development/worker-main.js development-worker.local.json
```

`--once` processes at most one available run and exits. The polling loop otherwise runs while the computer is awake and connected. A normal stop waits for active work; there is no task timeout. Run it under your existing process manager if automatic startup is desired. This implementation does not install a service or change startup settings.

The worker launches trusted repository code and a powerful coding agent on your machine. A separate checkout is not an operating-system sandbox. Use development-only credentials and review the configured skill/tool access. Server ClickUp, Slack and database tokens are removed from child environments. Cursor credentials remain available for its own authentication. Do not enable the pilot on a repository or skill you do not trust.

### Browser MCP and replay configuration

In a local project entry, configure:

```json
{
  "branch": "maintenance/ai",
  "baseBranch": "preprod",
  "browser": {
    "url": "http://127.0.0.1:3199",
    "start": ["powershell.exe", "-NoProfile", "-Command", "$env:PORT='3199'; $env:HOST='127.0.0.1'; $env:BROWSER='none'; npm start"],
    "allowedOrigins": ["https://YOUR_APPROVED_TEST_API"],
    "accountsFile": "C:/YOUR_PROJECT/browser-accounts.json",
    "accounts": ["beneficiary", "admin", "beneficiary_2"]
  }
}
```

Replace the test API and account path with approved local values. Omit account fields when login is unnecessary. Accounts are objects keyed by role, each containing `email` and `password`. Only roles explicitly allowed by the operator may be selected. Credentials stay in that local file; scenario login steps reference the role and field, never a literal password. The MCP exploration session is isolated from the replay browser. Do not copy production credentials into either session.

The controller rejects an occupied preview port, starts the configured command in its own per-run checkout, and stops that process tree after the run. Readiness is bounded to avoid waiting forever on a broken startup; coding itself still has no execution deadline. Project dependencies and required development environment must work in a fresh clone. A missing environment blocks the run.

For a visible change, Cursor uses MCP to explore the preview and returns a `browserScenario` containing navigation, interaction and assertions. The controller validates and independently executes those steps with Playwright in a fresh browser. It saves `browser-<attempt>/browser.png` and `browser-result.json` outside the checkout. Failed/missing scenarios block publication. This proves the supplied scenario passed, not that the agent chose exhaustive coverage. The replay restricts network requests to the preview plus `allowedOrigins`; MCP restrictions are configuration controls, not a sandbox. Keep both allowlists consistent.

Supported steps are `navigate`, `click`, `fill`, `fillAccount`, `press`, `expectVisible`, `expectHidden`, `expectText` and `expectURL`. The exact parameter shapes are supplied in the controller prompt. More complex flows not expressible by these steps require an explicitly configured command-based browser check. An empty `browserChecks` is valid when `browser` is configured; without either, visible changes cannot publish.

## Spending

The User explicitly approved **separate Cursor billing**. Cursor analysis and implementation use the local Cursor account and its provider-side limits. Mayassistant's existing $10 OpenAI budget does not account for or cap this usage; the budget screen must not be interpreted as total Development spend. Two attempts are not a dollar ceiling. Other Modules keep their existing spending safeguards.

## Recovery, access and retention

`development status <project>` shows recent queued/running/completed/blocked operations and folder-read failures. Project data is shared with channel members; the private DM is only a presentation surface. The worker token grants trusted access to Development snapshots and results for the configured Slack workspace. It does not grant access to other Modules' tables.

Running claims do not expire, because there is no execution time limit. `worker.json` stores a stable worker identity; `worker.lock` prevents overlapping local instances. After a hard crash, first establish that the old worker and its Cursor child processes have stopped, then remove only the stale lock file and restart using the same state directory. Do not create a new worker identity to bypass an active claim. An interrupted/uncertain Cursor call is reported as blocked instead of dispatched twice. Local journals retain prompts, outputs, checks and separate checkouts for inspection.

An already-pushed commit is recovered by SHA. Lost push responses are checked against remote ancestry; no new commit is created. If publication cannot be confirmed, the saved SHA is reported and automatic code retry is disabled until an operator reconciles it. This also prevents a status toggle from silently building another fix for that uncertain commit.

External ClickUp/Slack writes receive a durable sending marker first. Unknown outcomes become `reporting_error` and are never blindly replayed; inspect the actual ticket/thread and reconcile that exact effect before recovery. The current pilot requires operator database recovery for uncertain deliveries: inspect `development_runs` and its `development_effects` rows, verify whether each external effect happened, mark verified effects `done` (record the Slack timestamp in `detail` for a verified Slack post) or delete only verified-not-delivered effect rows, then set the run back to `reporting`. Restore its `development:finish:<run-id>` integration job to `queued`, clear `finished_at`, set `available_at=now()`, and restore its payload to `{"type":"finish","run":"<run-id>"}` because completed jobs clear their payload. If queue retention already removed that job, enqueue a new Development integration job with the same payload and configured workspace identity. Stop conflicting work and take a backup first. Never mark an unverified effect done, delete the run, rerun coding for a pushed commit, or clear all delivery markers. An operator UI for this exceptional recovery is future work.

For the pilot, Module configuration, minimal deduplication state, snapshots and effect history are retained until the operator deliberately decommissions the project; local worker evidence is also retained. Protect and back up this data. Do not delete an active run's journal, worker identity or effect checkpoints. A time-based retention policy is deferred until recovery requirements are validated. Disabling the Module preserves state and exposes no worker routes. Other Modules' retention contracts remain unchanged.

## Verification and live rollout

Local verification on 03/10/2026: `npm test` passed 333 tests; 25 real-PostgreSQL tests were skipped without `TEST_DATABASE_URL`. `npm run check`, `npm run build`, Git whitespace checks and local documentation-target checks passed. This verification covered the local release candidate on `main`; no live provider or production deployment was exercised.

Automated tests use fake Slack/ClickUp providers and disposable local Git repositories. They cover signed channel routing, membership, duplicate delivery, frozen snapshots, two attempts, sequential claiming, one commit, failed checks, missing browser checks, lost push responses and interrupted attempts. Real PostgreSQL claim races use `TEST_DATABASE_URL`; they are skipped without a disposable database.

Before enabling real work, run one consented ticket through Slack review, clarification, Ready for AI, local checks, a maintenance commit and `to build`. Verify the original thread, commit URL, GitLab/GitHub permissions and the configured base branch's unchanged tip. Repeat with insufficient information and a failing check. No PR/MR, merge or deployment should be created by the worker. Live tests can incur Cursor charges and push code, so use the selected pilot repository.
