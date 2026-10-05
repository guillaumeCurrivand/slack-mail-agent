# Development — EOA workstation runbook

This is the project-specific setup for the approved Orientaction pilot. The [Development contract](development.md) owns workflow behavior, authorization, billing and recovery. Paths and identifiers below describe the existing Windows workstation as of 04/10/2026; credentials are deliberately omitted.

## Project mapping

Send this command in a private DM to Mayassistant:

```text
development configure {"id":"pilot","name":"Orientaction frontend","channel":"C0624L2EUA0","folder":"901515523304","repository":"https://gitlab.com/mayasquad/orient-action/orient-action-frontend","skill":"maintenance","enabled":true}
development projects
development status pilot
```

Wait for **Projet … enregistré**. The requester and bot must belong to the channel, and the dedicated Development ClickUp token must access the Folder. Apply the repository's [Slack manifest](../slack-manifest.json) to the installed app, reinstall if scopes changed, and invite Mayassistant into that channel. Configuration does not require the local worker to be running.

Post the standard ticket URL in the project channel, for example `https://app.clickup.com/t/1245apux5f7`. The workspace-qualified form `https://app.clickup.com/t/4573809/1245apux5f7` is not supported by the current parser. Investigation answers appear in a thread. A person sets **Ready for AI** to authorize implementation. A confirmed, tested push to **maintenance/ai** precedes **to build**. Reports are French; each ticket's commit message is English. You open the MR and merge into **preprod** yourself.

The worker expects remote `preprod`; publishing `maintenance/ai` does not satisfy a missing base branch. No remote `test` branch is needed. Repository credentials must work unattended in fresh clones; successful access from an already-open checkout alone is insufficient.

## Automatic startup

The configured local worker now prepares the frontend environment and starts **backend → ngrok → frontend** before each review or implementation. Start the worker normally; separate backend/ngrok terminals are no longer required. It runs `npm run develop` in `C:\Work\EOA\orient-action-api` with port 8087 and the installed Node 16.20.2 runtime, then `ngrok http 8087`, then the existing frontend preview. Mayassistant itself remains on Node 24+.

The backend must pass `http://127.0.0.1:8087/_health`. The local tunnel API at `http://127.0.0.1:4040/api/tunnels` must expose the configured HTTPS origin with a loopback target on 8087. The worker does not change the frontend or browser allowlists to trust an unexpected hostname; align them explicitly when changing the tunnel domain.

Healthy existing backend/tunnel services may be reused by this profile and are left running. Processes started by the worker are stopped after the run, including partial startup failure. Failures identify `backend.log`, `ngrok.log` or `preview.log` in the run directory before spending a Cursor attempt. Prerequisites such as the backend's database/services, installed dependencies and ngrok authentication must already be configured.

## Manual startup for diagnosis

To investigate a service independently, use separate terminals for the backend and tunnel. The worker can reuse those services once their readiness checks pass. Leave them running until your manual investigation is complete; the frontend remains owned by the worker.

1. Start the backend from `C:\Work\EOA\orient-action-api`, using its existing local environment and database/services. Its package declares Node `>=12.x.x <=16.x.x`; select a compatible project runtime before running it. Mayassistant requires Node 24+, so do not change a shared Node installation while the worker is running. Use separate runtime paths/environments when necessary.

   ```powershell
   cd C:\Work\EOA\orient-action-api
   node --version
   $env:PORT='8087'
   npm run develop
   ```

   `develop` is the repository's `strapi develop` script. Wait until the backend reports it is listening on port 8087 before starting the tunnel.

2. After the backend starts, open a second terminal and start the tunnel:

   ```powershell
   ngrok http 8087
   ```

   Use the HTTPS forwarding origin printed by ngrok. The last verified frontend configuration used `https://triceps-smith-thing.ngrok-free.dev`; do not assume every later tunnel retains that hostname.

3. Make the frontend API URLs and both browser allowlists match that origin. The frontend source environment is `C:\Work\EOA\orient-action-frontend\.env`. Its API, export and AI endpoints pointed at the same ngrok origin during verification; preserve any required paths when updating URLs. Prepare per-run environments using the next section.

4. Start the worker with its pinned-runtime launcher. The terminal may currently use Node 16; the launcher selects Node 25 independently. Set the token only if it is not already present in this terminal:

   ```powershell
   cd C:\Work\slack-mail-agent
   .\scripts\start-development-worker.ps1 -Check
   $workerSecret = Read-Host 'DEVELOPMENT_WORKER_TOKEN from the server' -AsSecureString
   $env:DEVELOPMENT_WORKER_TOKEN = [System.Net.NetworkCredential]::new('', $workerSecret).Password
   .\scripts\start-development-worker.ps1
   ```

The token must match the server's `DEVELOPMENT_WORKER_TOKEN`. Cursor authentication and billing belong to the local Cursor account, separately from Mayassistant's OpenAI allowance. The current worker command does not specify a Cursor model; it uses the CLI/account's configured default. Inspect that configuration rather than assuming a particular model.

## Keep the worker and project Node versions separate

Use `scripts/start-development-worker.ps1` for this Windows workstation. It defaults to the installed `%LOCALAPPDATA%/nvm/v25.8.1/node.exe`, resolves its physical path, verifies Node 24+ and `fetch`, and starts the worker with that executable. It prepends that directory only for this invocation and restores the caller's PATH and NODE_OPTIONS afterward. It never runs NVM or changes its shared symlink. `-Check` reports the selected runtime without reading a ticket, acquiring a worker lock or starting any services. On another workstation, pass `-NodePath C:/absolute/version-directory/node.exe`; `-Configuration` selects another worker JSON file.

The browser MCP also uses the installed Node 25 executable directly. Cursor's official PowerShell launcher uses its own bundled Node. The EOA setup/test/build/preview and backend commands select Node 16 inside their separate child processes and clear inherited Node options. These processes can run simultaneously; they do not change one another's environment. An already-running process keeps the Node version it started with even if someone changes NVM's selection, but future commands through NVM's shared link can select the wrong runtime.

Cursor's controller prompt explicitly prohibits `nvm use`, other NVM changes, `setx`, and machine/user PATH changes, and tells it to use process-local executable/PATH selection for project commands. This is guidance for a trusted coding agent, not an OS permission boundary. Keep all launcher/MCP executable paths outside the mutable NVM link. The direct worker entry point rejects Node versions below 24 before reading configuration or acquiring its lock, instead of repeatedly logging `fetch is not defined`.

If the worker is already running, stop it normally and wait for its prompt before launching the new script; do not create a second worker or delete an active lock. New Cursor sessions load the updated MCP configuration. This change requires no server restart or global `nvm use` command.

## Local environment files

The User explicitly permits using all existing `.env` files on this computer for Development. The full frontend `.env` may be used in the frontend checkout, and the API uses its own local environment in `orient-action-api`. This permission does not require copying unrelated environments into a checkout or transferring server credentials to the frontend. Never commit these files or paste their contents into reports.

Fresh Git clones do not contain ignored `.env` files. The documented setup below copies the complete existing **frontend** `.env` into the ignored `.env.local` of each run. It leaves the original file intact. If the project depends on additional environment-specific files, map those explicitly to the corresponding process. Do not copy the API's secrets into frontend assets.

The ignored `development-worker.local.json` now uses the authorized full frontend copy below. The earlier selected-key configuration was sufficient for a login-page smoke check, but did not carry the complete project environment. The backend continues to read its own existing environment in its original directory.

## Worker configuration

Use the following EOA profile in `C:\Work\slack-mail-agent\development-worker.local.json`. Update the ngrok origin if it changes. This file is ignored by Git. The paths below reflect the installed local executables; adjust them on another workstation.

```json
{
  "server": "https://mail.tyrstats.com",
  "stateDirectory": "C:/Work/mayassistant-development-state",
  "agent": [
    "powershell.exe", "-NoProfile", "-File",
    "C:/Users/gcurr/AppData/Local/cursor-agent/agent.ps1", "--trust"
  ],
  "projects": [{
    "id": "pilot",
    "repository": "https://gitlab.com/mayasquad/orient-action/orient-action-frontend",
    "skill": "maintenance",
    "skillPath": "C:/Work/EOA/.cursor/skills/maintenance/SKILL.md",
    "branch": "maintenance/ai",
    "baseBranch": "preprod",
    "setup": [
      ["powershell.exe", "-NoProfile", "-Command", "$env:PATH='C:/Users/gcurr/AppData/Local/nvm/v16.20.2;'+$env:PATH; Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue; npm ci --legacy-peer-deps"],
      ["powershell.exe", "-NoProfile", "-Command", "$ErrorActionPreference='Stop'; Copy-Item -LiteralPath 'C:/Work/EOA/orient-action-frontend/.env' -Destination '.env.local'"]
    ],
    "checks": [
      ["powershell.exe", "-NoProfile", "-Command", "$env:PATH='C:/Users/gcurr/AppData/Local/nvm/v16.20.2;'+$env:PATH; Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue; npm test -- --watchAll=false"],
      ["powershell.exe", "-NoProfile", "-Command", "$env:PATH='C:/Users/gcurr/AppData/Local/nvm/v16.20.2;'+$env:PATH; Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue; npm run build"]
    ],
    "services": [
      {
        "id": "backend",
        "cwd": "C:/Work/EOA/orient-action-api",
        "start": ["powershell.exe", "-NoProfile", "-Command", "$env:PATH='C:/Users/gcurr/AppData/Local/nvm/v16.20.2;'+$env:PATH; Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue; $env:PORT='8087'; npm run develop"],
        "readyUrl": "http://127.0.0.1:8087/_health",
        "startupTimeoutMs": 180000,
        "reuseExisting": true
      },
      {
        "id": "ngrok",
        "cwd": "C:/Work/EOA/orient-action-api",
        "start": ["C:/Users/gcurr/Downloads/ngrok-v3-stable-windows-amd64/ngrok.exe", "http", "8087"],
        "readyUrl": "http://127.0.0.1:4040/api/tunnels",
        "startupTimeoutMs": 60000,
        "reuseExisting": true,
        "ngrok": { "publicOrigin": "https://triceps-smith-thing.ngrok-free.dev", "upstreamPort": 8087 }
      }
    ],
    "browser": {
      "url": "http://127.0.0.1:3199",
      "startupTimeoutMs": 600000,
      "start": ["powershell.exe", "-NoProfile", "-Command", "$env:PATH='C:/Users/gcurr/AppData/Local/nvm/v16.20.2;'+$env:PATH; Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue; $env:PORT='3199'; $env:HOST='127.0.0.1'; $env:BROWSER='none'; npm start"],
      "allowedOrigins": ["https://triceps-smith-thing.ngrok-free.dev", "https://cdn.weglot.com"],
      "accountsFile": "C:/Work/EOA/browser-accounts.json",
      "accountsGroup": "local",
      "accounts": ["beneficiary", "admin", "beneficiary_2"]
    },
    "browserChecks": []
  }]
}
```

The external state directory holds worker identity, locks, journals and disposable clones; do not point it at the original frontend checkout. `agent` may work interactively in PowerShell, but the worker launches processes directly, hence the explicit PowerShell launcher. `--trust` covers the new per-run workspace. The [maintenance skill template](../skills/development-maintenance/SKILL.md) explains the controller/agent division; the configured EOA skill supplies the project-specific instructions.

Frontend setup, tests, preview and build explicitly prepend the installed Node 16.20.2 directory to their child process PATH and clear inherited `NODE_OPTIONS`. The project's `build:preprod` CI job selects Node 16.16.0; this workstation uses the installed 16.20.2 patch release of that major version. This is not an exact CI version match. The frontend package has no `engines` declaration or `.nvmrc`; the preprod job is the relevant runtime evidence. Other CI jobs and the Dockerfile still mention Node 14. Do not change the shared Node installation with `nvm use` while Mayassistant or Cursor is running: Mayassistant requires Node 24+, and its own process remains on Node 25.8.1. The npm build operation is plain `npm run build`, with no `--openssl-legacy-provider` workaround.

The npm compatibility flag still addresses the separate existing Chart.js 3 / pie-chart plugin peer dependency conflict without changing the lockfile. [npm documents matching dependency-resolution options for `npm ci`](https://docs.npmjs.com/cli/v11/commands/npm-ci/). Selecting the intended runtime does not guarantee that dependency or source-code compilation errors disappear.

## Browser MCP

The worker uses **mayassistant-browser**, a Playwright MCP available to the Cursor CLI, plus an independent controller replay. It does not rely on Cursor editor browser tools or the repository's Cypress suite. Install the dependencies/browser using the [module instructions](development.md#local-worker-setup).

The workstation's MCP entry lives in `C:\Users\gcurr\.cursor\mcp.json`. Preserve the other MCP entries. Its verified configuration uses:

- Command: `C:/Users/gcurr/AppData/Local/nvm/v25.8.1/node.exe` (the installed version directory, not NVM's shared `C:/nvm4w/nodejs` link).
- Script: `C:/Work/slack-mail-agent/node_modules/@playwright/mcp/cli.js`.
- Flags: `--headless`, `--isolated`, `--block-service-workers`.
- `--executable-path`: the Chromium executable returned by `node -e "console.log(require('playwright').chromium.executablePath())"` from Mayassistant.
- `--output-dir`: `C:/Work/mayassistant-development-state/browser-mcp`.
- `--allowed-origins`: one argument containing `http://127.0.0.1:3199;https://triceps-smith-thing.ngrok-free.dev;https://cdn.weglot.com`.

Update both this MCP argument and the worker's `browser.allowedOrigins` when the ngrok hostname changes. Also update the frontend environment source before starting a fresh run. The User approved any of `beneficiary`, `admin` and `beneficiary_2`, selected according to the ticket. Passwords stay in `C:/Work/EOA/browser-accounts.json`; scenario steps refer to account names and fields. This file now contains `local` and `live` groups. The configured `accountsGroup: "local"` makes both Cursor and the replay use only `local[role]`; the presence of a `live` group does not authorize using it. A successful login-page render does not prove authentication or backend connectivity.

Enabling an MCP server does not by itself grant headless tool permissions. The CLI's previous `allowlist` configuration permitted only `Shell(ls)`, and real review reports said browser/shell calls were refused. On 04/10/2026 the User explicitly approved these persistent additions to `C:\Users\gcurr\.cursor\cli-config.json` → `permissions.allow`, preserving other settings:

```json
[
  "Mcp(mayassistant-browser:browser_navigate)",
  "Mcp(mayassistant-browser:browser_snapshot)",
  "Mcp(mayassistant-browser:browser_click)",
  "Mcp(mayassistant-browser:browser_type)",
  "Mcp(mayassistant-browser:browser_fill_form)",
  "Mcp(mayassistant-browser:browser_press_key)",
  "Mcp(mayassistant-browser:browser_wait_for)",
  "Read(C:/Work/EOA/browser-accounts.json)"
]
```

These exact rules were applied locally; a subsequent authenticated Cursor browser session remains to be verified. No unrestricted shell or wildcard MCP permission was added. Reviews should use available file-reading/search tools for inspection and the approved browser tools for reproduction. Other shell calls may still require permission. See [Cursor's permission syntax](https://cursor.com/docs/cli/reference/permissions).

## Check whether the worker is running

The worker is quiet while idle and during many long-running operations. It polls the server every five seconds when free, prints errors when requests fail, and prints `<project> / <ticket> : <outcome>` after submitting a result. Silence alone does not establish a failure or a successful server connection.

In another PowerShell terminal, inspect the PID recorded in the configured state directory:

```powershell
$workerLockPath = 'C:\Work\mayassistant-development-state\worker.lock'
if (Test-Path -LiteralPath $workerLockPath) {
  $workerLock = Get-Content -LiteralPath $workerLockPath -Raw | ConvertFrom-Json
  Get-CimInstance Win32_Process -Filter "ProcessId = $($workerLock.pid)" |
    Select-Object ProcessId, ParentProcessId, Name, CommandLine
} else {
  'No worker lock in this state directory.'
}
```

Verify that the process command line identifies `src/modules/development/worker-main.ts` (or the compiled `dist/modules/development/worker-main.js`). An existing lock alone does not prove a live worker; a PID can also have been reused. `development status pilot` in Slack shows server-side runs, not a worker heartbeat. Check the newest run's logs and their modification times for local progress; backend/frontend ports are normally absent while the worker is idle because it stops services it started after each run.

`EEXIST ... worker.lock` means another start found the exclusive lock. Do not start a second worker or delete the lock while the original worker or its Cursor children remain alive. After a crash, inspect those processes first; remove only a confirmed stale lock and restart with the same state directory. Preserve `worker.json`, run journals and checkouts. Normal Ctrl+C requests shutdown, which can wait for active work to finish; wait for the terminal prompt before restarting.

## Diagnose and retry

Inspect the newest run beneath `C:\Work\mayassistant-development-state\runs`. Each run has a hashed directory containing `journal.json`, a `checkout`, and, after preview startup, `preview.log`. Inspect logs locally; do not paste environment values or credentials into Slack.

| Symptom | Meaning and correction |
| --- | --- |
| Configuration receives no response / no saved project | Verify server version, signed DM delivery and job diagnostics. Earlier fixes changed Slack membership API calls to GET query parameters, normalized Slack-formatted repository URLs and added safe error type/location logs. Send a new configure message after correcting the cause; do not reset exhausted database jobs. |
| Ticket link gets no visible reply | Use the short `/t/<task-id>` URL in the configured channel, check `development status pilot`, and ensure the local worker is running. A queued review with zero attempts has not yet been investigated. |
| Remote `test` branch absent | Set EOA `baseBranch` to `preprod`; `branch` remains `maintenance/ai`. Restart the worker and explicitly retry the blocked run. |
| `npm error code ERESOLVE` | The known Chart.js/plugin peer conflict needs `npm ci --legacy-peer-deps` for this existing dependency tree. |
| Preview exits with `ERR_OSSL_EVP_UNSUPPORTED` | Verify that frontend setup, tests, preview and build use the configured Node 16 executable via their child PATH, and clear inherited `NODE_OPTIONS`. The earlier Node 25 legacy-provider workaround is superseded by explicit project runtime selection. |
| Build fails on a `date-fns/.../localize.mjs` named export | Inspect the underlying Webpack diagnostics: the observed failure was untransformed optional chaining in dependency code, which Webpack 4 cannot parse. The frontend repair forces optional-chaining/nullish-coalescing transforms in CRA's dependency Babel loader. Run `node scripts/check-webpack-dependencies.js` and the full build under Node 16. The repair must be published to the frontend branch before a worker clone can use it; changing Node or restoring the OpenSSL workaround alone does not fix this compilation problem. |
| Tests fail with `Cannot find module '@orientaction/utils'` in `App.test.tsx` | The installed alias helper maps `@orientaction/utils/...` but omits the exact barrel name. Repair the frontend's Jest `moduleNameMapper` with exact-name mappings as well as subpath mappings. The original `App.test.tsx` is an obsolete CRA “learn react” sample; its replacement checks actual App provider wiring with external/page boundaries isolated. Do not skip the suite or replace it with a constant assertion. Local frontend changes must reach the remote branch used by the worker before a new clone can use them. |
| Preview does not respond while the log still says compilation is starting | A fresh EOA clone can exceed the old 120-probe readiness loop (roughly two to four minutes). Update the local worker code and set `browser.startupTimeoutMs` to `600000` for ten minutes. Restart and explicitly retry; inspect the log again if the longer deadline expires. |
| HTTP preview is ready but the page is blank with `Invalid URL` | Check the frontend environment. EOA constructs a URL from `REACT_APP_API_ENDPOINT` at startup; a fresh clone without its environment crashes in the browser. |
| Preview port 3199 occupied | Identify and stop the stale preview you own. The worker deliberately refuses to test a different checkout already using the port. |
| Backend requests fail | Confirm API startup on 8087, then the ngrok tunnel, matching frontend URLs and matching MCP/replay allowlists. |
| `Weglot is not defined` overlay | The frontend loads `https://cdn.weglot.com/weglot.min.js`. Keep that CDN in both browser allowlists so the actual translation library can load. Inspect page errors/network failures if it persists; do not suppress the overlay or replace Weglot with a stub to claim a passing test. |
| `Unexpected token 'I', "I'll inves"... is not valid JSON` | Cursor concatenated English progress prose with a valid French JSON report. Update the worker parser: it now accepts a single schema-validated final object after progress text. The two saved reports for this incident both requested clarification; no fix was published. A retry is a new explicit request, not recovery by clearing the old attempt count. |
| Cursor reports that browser tools were refused | Check the named MCP permissions above; `--trust` trusts the workspace but is not the browser-tool allowlist. Keep review mode read-only rather than adding unrestricted `--force` to reviews. |
| Replay fails at the first `fillAccount`, although Cursor logged in successfully | Check the account-file shape. For the grouped EOA file set `browser.accountsGroup` to `local`; the old flat lookup could not find `admin.email`. The worker now reports missing account configuration specifically, without exposing values. Restart the worker to load the setting. |
| Login fills succeed, but the next admin-page interaction fails | The scenario must assert login completion before navigating. The observed game scenario clicked Login and immediately navigated to `/admin/game/edit-page/117`, interrupting authentication. In verification, adding `expectHidden` for `#login-email` after Login allowed all 11 steps to pass. Cursor is now instructed to include the wait, and replay rejects an explicit navigation after `fillAccount` without an intervening assertion. |

The generic blocked message **Précisez le ticket puis demandez explicitement une relance** also appears for installation and preview failures. Those failures require fixing the environment, not necessarily editing the ticket. A blocked journal keeps its result; a configuration edit alone does not retry it.

After changing local configuration, stop the worker with **Ctrl+C** and allow active work to stop normally. In the same terminal (which retains the token), restart:

```powershell
cd C:\Work\slack-mail-agent
.\scripts\start-development-worker.ps1
```

Then send in Slack:

```text
development status pilot
development retry <latest-blocked-run-id>
```

Replace the placeholder with the complete latest blocked identifier returned by status; retries may themselves have `retry:...` identifiers. Do not keep retrying the same original identifier after a newer retry has blocked. Do not bypass the two-attempt limit or uncertain-push recovery. See [recovery rules](development.md#recovery-access-and-retention) for active claims, stale locks and ambiguous delivery.

Local config, environment, skill and MCP changes require the local worker to reload them, not a server deployment. Server code/manifest changes follow the [deployment guide](deployment.md#development-release-candidate).

## Verification record

Observed on 04/10/2026:

- Mayassistant's automated checks for the configurable base branch passed: 365 tests passed, 25 real PostgreSQL tests skipped without `TEST_DATABASE_URL`; TypeScript check and build passed. This is historical verification, not a test run for this documentation update.
- Plain `npm ci` reproduced the Chart.js peer dependency error. `npm ci --legacy-peer-deps` installed 3,444 packages successfully in the failed run's clone without changing tracked project files.
- The OpenSSL failure reproduced under Node 25.8.1 and cleared with the legacy-provider option. The controller's preview startup then returned HTTP success.
- With selected frontend settings loaded from the existing local `.env`, a headless browser rendered the E-Orientaction login page with no JavaScript page errors. The verification browser and preview were stopped; port 3199 was released. The generated `.env.local` was ignored by Git.
- The broader authorization to use complete local `.env` files and the backend → `ngrok http 8087` procedure were documented afterward. The full-copy variant and backend/tunnel startup were not exercised in that verification.
- A later fresh run exhausted the old preview readiness loop while Webpack was still compiling. After adding `startupTimeoutMs` and setting EOA to ten minutes, verification in that failed checkout reached HTTP readiness in 97 seconds and displayed the login page without JavaScript errors. This reused the failed checkout and does not measure a completely cold build. Timeout/success regression tests, TypeScript check and build passed; the full suite passed 367 tests, with 25 PostgreSQL tests skipped without `TEST_DATABASE_URL`. The verification preview was stopped afterward.
- Both saved Cursor responses from the later JSON-parser incident successfully replayed through the corrected parser as French clarification reports (`actionable:false`). Synthetic runner tests cover progress prefixes, fenced reports, braces/quotes in summaries, ambiguous objects and invalid types. The full suite passed 373 tests, with 25 PostgreSQL tests skipped; TypeScript check/build and local documentation links passed. The explicitly approved browser/account-file permissions were applied and read back, but no new paid Cursor run or authenticated browser session was started for this fix. Existing blocked journals and server attempt counts were preserved.
- Automatic environment startup was subsequently exercised locally: the full frontend `.env` copy succeeded; `npm run develop` started Strapi 4.2.0 on Node 16.20.2 and `/_health` returned 204; `ngrok http 8087` exposed the configured hostname and local upstream; the frontend rendered its login page with no JavaScript page errors while enforcing the updated browser origin allowlist. Weglot's CDN was allowed; unrelated font/analytics/image origins remained blocked. The verification started no Cursor coding request and performed no login. Cleanup was checked: ports 8087, 4040 and 3199 no longer responded afterward. Logs are under the local state's `environment-verification` directory.

The automatic-startup change passed 378 automated tests; 25 real PostgreSQL tests were skipped without `TEST_DATABASE_URL`. TypeScript check/build, configuration/example validation and local documentation links passed.

At the end of that startup-only verification, authentication, the actual ticket scenarios, full frontend test/build success, a complete Cursor implementation, a maintenance push and the final ClickUp status transition remained unverified. The login-page check was not an end-to-end acceptance result.

On 05/10/2026, ticket `1245apux992` exposed a grouped-account lookup failure at replay step 2. Setting `accountsGroup: "local"` resolved it. Replaying the saved scenario then exposed an authentication race at step 6; a separate verification copy with an explicit login-completion assertion passed all 11 steps, including local admin login and the Poursuivre preview. This exercised the saved checkout, without changing its journal or publishing its commit. The worker's earlier logs report passing frontend tests/build, but its generated dependency/test changes still require human review; this replay does not certify their scope. A fresh Cursor-generated scenario using the updated instructions and a final push/status transition remain unverified.

The complete local worker change passed 379 automated tests on 05/10/2026; 25 real PostgreSQL tests were skipped without `TEST_DATABASE_URL`. TypeScript check and build passed. Browser regression coverage includes grouped-account selection without fallback, flat-file compatibility, sanitized missing-account errors, and the required assertion before post-login navigation. These results do not establish production deployment or a successful fresh coding run.

Later on 05/10/2026, the frontend npm commands were pinned to the installed Node 16.20.2 runtime (npm 8.19.4), matching preprod's Node 16 major version; CI specifies 16.16.0. Setup, tests, preview and build now clear inherited `NODE_OPTIONS`, replacing the Node 25 OpenSSL workaround. The documented profile matched the local configuration and passed schema validation. A direct `npm run build` in failed run `36308b5516e357d32552a1f294919d162da3213bebfe343783b1908ea8dcc6a1` still exited 1 with a `date-fns/locale/af/_lib/localize.mjs` named-export compilation error. This was the existing checkout/dependency tree, not a fresh Node 16 installation; no dependency repair, new Cursor run, journal reset or publication was performed. A passing frontend build remains outstanding. The Mayassistant runtime code was unchanged, so its full test suite was not rerun for this local configuration/documentation correction.

The subsequent run `695e49d2a56a74a67ec65230ed186f63d74618233e7481a183a58fc055158c98` failed its tests before reaching build: six suites and all sixteen runnable tests passed, but `App.test.tsx` could not resolve the bare `@orientaction/utils` import. A focused alias regression reproduced the failure. A local repair in `C:/Work/EOA/orient-action-frontend` adds exact aliases and replaces the obsolete sample with two tests of real App routing/theme/provider wiring, including navigation and photo state updates. Firebase, page routing and unrelated hook/service boundaries are isolated; these are not end-to-end page tests. The alias regression also checks subpaths and rejects similarly prefixed unrelated names.

The repair passed seven suites/sixteen tests in the original frontend checkout and eight suites/twenty tests when temporarily applied to the failed worker checkout, including its Poursuivre regression. The worker checkout's original files were restored afterward; its journal and attempt count were untouched. The normal parallel Jest command returned exit 0 but emitted a non-fatal worker-shutdown warning; open-handle diagnostics included Jest transform-cache signal handlers and JSDOM storage-event timers, and the installed Babel placeholder plugin schedules a delayed warning. No publication, new worker run or successful build is established by these test results. The frontend repair is local and must be reviewed and published before worker retries can use it.

The build blocker was subsequently repaired on the frontend's local `maintenance/ai` branch on 05/10/2026. A five-second reproduction using the production CRA rules exposed untransformed optional chaining in `date-fns`: Webpack 4 could not parse it, then reported secondary named-export errors. Modern browser targets made this deterministic even in the original checkout. Explicit optional-chaining and nullish-coalescing transforms in the dependency Babel loader resolved the failure without changing package versions, the lockfile or the browser support policy. A new Jest regression compiles a real locale with modern browser targets and fresh Babel output, then checks its generated exports.

Final local validation: Node 16.20.2, `npm test -- --watchAll=false` passed eight suites/seventeen tests, `npm run build` exited 0 with project lint/style warnings, and targeted ESLint checks passed for all five changed code/test files. The frontend README documents the runtime and regression command. This supersedes the earlier unresolved build result; it does not establish a fresh worker run, browser replay or remote publication. The frontend repairs were subsequently committed locally as `d15f16618f7255ca90c9df9131a0696098b8d5a8`; publication to the branch used by new worker clones remains a separate step.

The runtime-separation follow-up on 05/10/2026 passed 379 automated tests; 25 real PostgreSQL tests were skipped without `TEST_DATABASE_URL`. TypeScript check/build, 34 local documentation links/anchors and the documented profile's equality with the schema-validated local profile passed. From a terminal with Node 16 first on PATH, the launcher's `-Check` selected the physical Node 25.8.1 executable and restored the caller's Node 16 environment afterward. Selecting Node 16 explicitly was rejected; the compiled worker also rejected Node 16 before reading configuration or taking a lock. The pinned browser MCP executable returned version 0.0.83. No global NVM selection was changed, no paid Cursor run or ticket claim was started, and no server deployment or new end-to-end workflow was exercised.

During the subsequent publication check on 05/10/2026, GitLab's remote `maintenance/ai` tip was confirmed as `d15f16618f7255ca90c9df9131a0696098b8d5a8`, establishing that the frontend repair is now published. This supersedes the earlier local-only status; it does not establish a successful ticket retry. All 185 local links/anchors in the pending Mayassistant documentation updates passed validation.
