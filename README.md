# Mayassistant — private Slack assistant

Mayassistant is one Slack bot with six independently enabled Modules: Mail Sorter, Slack Unanswered, Documentation, ClickUp, Yousign and Development. Use private DMs to configure Modules and consult personal work. Development also reviews ClickUp links in connected project channels and delegates authorized maintenance fixes to a local Cursor worker.

The application-owned interface is French. Original inventory values, approved rules, message excerpts and URLs remain literal. Timestamps display `DD/MM/YYYY HH:mm (Europe/Paris)`; ClickUp deadlines display the Paris calendar date only. Numbers use French separators. Buttons share horizontal action rows; Slack can wrap them on narrow clients, and Documentation's record selector stays separate. English commands remain compatible alongside the French shortcuts below. See the [presentation contract](docs/product-spec.md#interactive-message-presentation).

The [approved product specification](docs/product-spec.md) describes the scope. The application is implemented locally; a real Slack/Google/OpenAI deployment and model-quality evaluation are still required before team rollout.

## Documentation map

For usage, start with the [module overview](#modules-and-project-structure) and follow the guide for the capability you need. This README owns installation, provider setup and shared operation.

For contributors, [AGENTS.md](AGENTS.md) points to the [product specification](docs/product-spec.md) for assistant-wide behavior and Mail Sorter safeguards, [CONTEXT.md](CONTEXT.md) for terminology, [Adding a module](docs/adding-a-module.md) for extension conventions, and [ADRs](docs/adr/) for architectural rationale. Each other Module's guide owns its feature contract. [Archived plans](docs/archive/) and dated verification records describe history; they do not establish current production status.

## What is included

- Private Slack menus and prefixed commands for all enabled Modules.
- Mail Sorter rule proposals and starter rules, Google Workspace OAuth with hosted-domain/browser checks and encrypted credentials, separately confirmed Previews, individual-message actions, Reports and conservative undo.
- Durable PostgreSQL jobs, per-user and per-module serialization, active-operation admission, duplicate-event protection, and mutation checkpoints.
- A shared $10/month OpenAI allowance, $8 alert, configurable per-user ceilings, and atomic reservations before generation. Development uses separately billed local Cursor calls. Channel selection, approval, reports, and undo do not require AI; contextual Slack matching and mail interpretation do.
- Startup and hourly cleanup follow each enabled Module's retention contract: [Mail Sorter](docs/mail.md#approvals-privacy-and-spending), [Slack Unanswered](docs/slack-unanswered.md#commands-and-results), [Documentation](docs/documentation.md#spending-availability-and-private-state), [ClickUp](docs/clickup.md#reading-results-and-recovering) and [Yousign](docs/yousign.md#receipt-recovery-and-alerts). Disabling a Module pauses its physical cleanup; Documentation inventory/history have lifetime retention.

## Modules and project structure

All Modules use the same Slack bot and database. OpenAI calls share the existing allowance; Development uses separately approved Cursor billing. The Slack interface is French; technical Module IDs and English commands remain supported. Each guide below starts with setup and a quick start, then explains commands and safeguards.

| Module and guide | Enablement ID | What it does | Data ownership | Additional setup |
| --- | --- | --- | --- | --- |
| [Mail Sorter — Tri des e-mails](docs/mail.md) | `mail` | Preview and approve Gmail labels, archive and Trash actions | Personal mailbox, rules and runs | Google OAuth, encryption key and OpenAI |
| [Slack Unanswered — Messages Slack sans réponse](docs/slack-unanswered.md) | `slack` | Find messages needing your reply in selected channels | Personal channel choices and results | Shared-channel/history/profile Slack scopes; OpenAI optional for contextual matching |
| [Documentation](docs/documentation.md) | `documentation` | Browse, question and maintain Projects, Technologies, Components, Hosts/services, Hosting entries and Tools | Workspace-shared inventory/history; private confirmations and context | No extra credentials for structured operations; OpenAI optional for natural language |
| [ClickUp](docs/clickup.md) | `clickup` | Read your directly assigned Mayasquad tasks | Personal OAuth connection and task snapshots | ClickUp OAuth, confirmed numeric Workspace ID and encryption key |
| [Yousign](docs/yousign.md) | `yousign` | Post every event from the existing company webhook to selected channels | Shared destinations and integration-owned delivery checkpoints | Existing webhook secret/subscription/environment and operational alert recipient |
| [Development — Développement](docs/development.md) | `development` | Review channel-linked ClickUp tickets and push tested maintenance commits after Ready for AI | Shared project mappings, frozen tickets and worker checkpoints | Dedicated ClickUp token, worker token, channel events and local Cursor/Git/checks |

ClickUp's [personal status filters](docs/clickup.md#personal-status-filters) are implemented locally. Send `clickup statuts` / `clickup statuses`, or choose **Choisir les statuts** in its menu. **Ajouter/Retirer** and **Réinitialiser le filtre** save automatically; **Fermer** preserves changes. Each User keeps their own filter; new task requests and Refresh apply it. The default excludes Done/Closed, which explicit choices can include. During incomplete discovery, default-mode changes preserve undiscovered unfinished statuses and offer Retry; Personal List-specific discovery is deferred. See [deployment checks](docs/deployment.md#clickup-release-candidate) for live verification.

`ENABLED_MODULES=mail` is the default. To enable all six, set `ENABLED_MODULES=mail,slack,documentation,clickup,yousign,development` after completing their setup. An empty value runs shared menus/help, budget and health endpoints without Module-specific credentials. Unknown or duplicate IDs fail startup. Preserve existing IDs when enabling another Module, then restart to apply the change.

Availability is deployment-wide. Disabled Modules expose no routes, execute no queued work and pause their own retention cleanup; pending jobs and state remain for re-enablement. Re-enabling does not renew expired approvals or result controls. Modules are trusted built-in code deployed together.

The implementation is organized as follows:

- `src/app/`: configuration, Module composition, startup and compatibility migrations.
- `src/core/`: Slack transport, routing, durable jobs, identity/locking, navigation and shared AI budget.
- `src/modules/mail/`, `src/modules/slack/`, `src/modules/documentation/`, `src/modules/clickup/`, `src/modules/yousign/`, `src/modules/development/`: each Module's behavior, providers, state and retention.

Documentation's one-time spreadsheet transition has a separate [operator import procedure](docs/documentation-import.md). Shipping the importer does not switch source authority; the real snapshot and mapping require separate review, approval and verified reconciliation.

### Upgrading an existing installation

Stop the old process before starting this version; do not run old and new workers together during the upgrade. Startup adds module identifiers to existing jobs and AI records, treating old records as Mail Sorter. Mail tables, encrypted credentials, saved rules, previews, and spending totals retain their existing values. Previously queued requests and previously posted buttons still work with their original ownership and approval checks. New DM requests require the `mail` prefix; bare `sort` returns guidance.

## Requirements for the host

Use your preferred provider. The app needs Node.js 24 or later (or Docker), PostgreSQL, persistent storage, backups, secret configuration, a public HTTPS origin, and outbound HTTPS access to Slack and the providers used by enabled Modules (Google, OpenAI and/or ClickUp). Background processing runs in the app process; no Redis, GPU or separate worker host is required initially.

For a single server running both app and database, start with 1 vCPU, 2 GB RAM and 10 GB persistent storage, then measure usage. These are initial sizing estimates. The provider's price is outside the $10 AI budget. Configure your reverse proxy with TLS and disable/redact request-URL logging on `/auth/google*`, since URLs contain short-lived login codes.

## Local installation

1. Install Node.js 24+ and PostgreSQL, or use the Docker configuration below.
2. Run `npm ci`.
3. Copy `.env.example` to `.env` and fill in the values. Do not commit credentials or paste them into chat.
4. If enabling Mail Sorter or ClickUp for a new installation, generate the encryption key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Store it securely as `ENCRYPTION_KEY`; losing it makes stored credentials unreadable. Preserve the existing key when upgrading or enabling another Module.
5. Set `DATABASE_URL` to your PostgreSQL connection string. The app initializes its tables at startup. For managed databases, use the provider's TLS configuration; do not disable certificate verification.
6. Build with `npm run build`, then run `node --env-file=.env dist/main.js`. For development use `node --env-file=.env --import tsx --watch src/main.ts`.

`GET /health` checks the process; `GET /ready` checks database connectivity. These endpoints reveal no mailbox or credential data.

## Slack setup

Documentation browsing uses native Slack tables and an **Open record…** dropdown. Record details resolve relationships to names; saved resource URLs are clickable. Project details offer **Hosting entries** for their environment list. Complete values and confirmation/history comparisons remain accessible through value pages. See the [presentation contract](docs/documentation.md#presentation-redesign).

Create or update the Slack app for your workspace using [slack-manifest.json](slack-manifest.json). Its Event Subscriptions and Interactivity Request URLs use `https://mail.tyrstats.com/slack/events` and `https://mail.tyrstats.com/slack/actions`. Confirm both URLs in the installed app's settings; changing the local manifest alone does not update Slack. Enable the app's Messages tab so users can DM the bot.

The app uses `message.im` events and the bot scopes `im:history`, `chat:write`, `channels:read`, `groups:read`, `channels:history`, `groups:history`, and `users:read`. The read scopes support listing shared channels, reading selected channel histories and threads, and matching Slack profile names. Update the app's scopes and reinstall it to grant them before enabling `slack`; invite the bot to channels users should be able to choose. A private channel appears in `slack channels` only when both the requesting user and the bot belong to it and the installed bot token has `groups:read`. Put the installed bot token, signing secret, and workspace ID in `.env`. Set `SLACK_ADMIN_USER_ID` if one person should receive private operational spending alerts; it grants no access to other users' rules or mail. Otherwise the user whose request crosses the threshold receives the alert.

Slack requests must be signed and belong to the configured workspace. Bot messages, edited-message events, unsigned requests and replayed timestamps are excluded from event dispatch. Signed `message.channels` and `message.groups` events are offered only to enabled Modules explicitly registering channel receipt; currently only Development consumes configured project channels. `slack channels` lists only shared channels using a bot token; `slack unanswered` reads selected channel history only on command. Searching long-lived channels may take time or encounter Slack rate limits because older roots must be inspected for recent thread replies. Events are acknowledged after durable enqueue, before module processing.

## Development setup

Follow [Development](docs/development.md) to configure the new `development` Module, its dedicated ClickUp/worker tokens, Slack channel events, project mapping and local Cursor worker. The worker uses your separately billed Cursor account. It runs while your computer is available, pushes one tested commit per ticket to the configured maintenance branch, changes the ticket to `to build`, and leaves PR/MR creation and merging to you. See [deployment checks](docs/deployment.md#development-release-candidate); this capability is not enabled by default.

## Yousign setup

Pull the release containing the Yousign Module before appending `yousign` to `ENABLED_MODULES`; older releases reject it and fail startup. Set `YOUSIGN_WEBHOOK_SECRET`, `YOUSIGN_SUBSCRIPTION_ID`, `YOUSIGN_SANDBOX` and `SLACK_ADMIN_USER_ID`. Point the existing company webhook to `PUBLIC_URL` plus `/webhooks/yousign`. Preserve raw JSON/signatures through the proxy and omit sensitive body logging. No new subscription, Yousign API key, Gmail, encryption or AI credentials are needed for this Module.

Invite the bot into channels to select and grant `channels:read`, `groups:read` and `chat:write`. In a private DM, open **Yousign → Choisir les canaux** or send `yousign canaux`. **Activer** authorizes future automatic notifications in that channel for the shared company integration. Start empty; skipped events are not backfilled. `yousign statut` shows current accessible delivery outcomes and the last authenticated receipt. See [the feature contract](docs/yousign.md) and [release procedure](docs/deployment.md#yousign-release-candidate) for recovery and live checks.

## ClickUp setup

ClickUp is opt-in: append `clickup` to the existing `ENABLED_MODULES` value while preserving other modules. It needs `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET`, the confirmed numeric `CLICKUP_WORKSPACE_ID` for Mayasquad, and the existing 32-byte base64 `ENCRYPTION_KEY`. Do not replace an existing encryption key; this can make saved credentials unreadable. ClickUp alone requires no Gmail or AI credentials.

Create a ClickUp OAuth application as a Workspace owner/admin and register this exact redirect URI, replacing `YOUR_HOST` with the configured public origin:

```text
https://YOUR_HOST/auth/clickup/callback
```

Configure your HTTPS proxy to omit/redact request-URL logging for `/auth/clickup*`, because callback URLs contain short-lived authorization codes. ClickUp's documented OAuth permissions are broader than a read-only scope; the Module only reads tasks. See [ClickUp authentication](https://developer.clickup.com/docs/authentication) and the [feature contract's provider constraints](docs/clickup.md#verified-provider-constraints).

After configuring the provider, follow the [ClickUp quick start](docs/clickup.md#quick-start) for browser authorization, separate Slack identity confirmation and task retrieval. The guide explains snapshot expiry, access checks and confirmed disconnect. Use the [release checks](docs/deployment.md#clickup-release-candidate) before rollout; live ClickUp deployment remains unverified.

## Google Workspace setup

Use a Google Cloud project owned by your Workspace organization, enable the Gmail API, and configure an internal OAuth audience where your organization supports it. Create a Web application OAuth client with this exact authorized redirect URI:

```
https://YOUR_HOST/auth/google/callback
```

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the comma-separated `GOOGLE_WORKSPACE_DOMAINS`. These are Google's verified hosted-domain values, not merely email suffixes. Request `openid`, `email`, and `https://www.googleapis.com/auth/gmail.modify`. Your Workspace administrator may need to allow the app and scope. Internal-app eligibility and organization policies must be checked in your own Google Cloud/Workspace configuration.

Each teammate opens `menu` → Tri des e-mails → Connexion Gmail → Connecter Gmail (or sends `courrier connecter`), follows their short-lived link, grants access using their own Workspace account, and confirms the resulting email address back in Slack. Authorization is not activated until this last confirmation. An account cannot be activated for two Slack users in the configured workspace.

`mail disconnect` removes the application's active credentials and cancels pending previews after confirmation. It leaves rules in place. Users can additionally revoke the OAuth grant in their Google account. Historical encrypted credentials may remain in database backups until their retention period expires.

## OpenAI and the $10 limit

Use a dedicated OpenAI project/key for this application. The pinned initial model is `gpt-4.1-mini-2025-04-14`, with a reviewed price card of $0.40/million input tokens and $1.60/million output tokens. Unknown model names are rejected until their rates and behavior are reviewed. Mail Sorter and Slack Unanswered enforce this at startup; Documentation rejects interpretation while keeping its free paths available. See [model-budget.md](docs/research/model-budget.md) for sources and assumptions.

The app counts the immutable input through the Responses token-count endpoint, reserves exact input plus bounded output in integer microdollars, then generates with `store:false`, standard service tier, disabled truncation, and no automatic retries. It conservatively charges all input at the uncached rate. Conversation and classification calls, and future modules, use the same team ledger. Usage is attributed to each module; the global `budget` command shows totals and the module breakdown.

Calendar months use UTC. A request with missing usage, timeout, or crash keeps its full reservation. This can pause work early; it is preferable to silently spending the same allowance again. Cost records contain no email bodies. Reconcile uncertain reservations against provider usage before manually settling them; never simply delete them to unblock requests. Alerts include reservations as well as settled charges.

The limit governs this app's recorded generation usage at its configured prices. Taxes, price changes, token-count endpoint commercial terms, and other applications using the same key are outside that accounting; verify pricing and project usage before release. $10 does not promise a fixed number of scans. `store:false` does not imply zero provider retention.

## Using it

Send `menu`, `aide`, `bonjour` or `salut` in a private DM with the bot (`help`, `hello` and `hi` also work). Choose an enabled Module. Navigation updates its menu message; results and approvals remain separate Cards. If a menu is unavailable, send `menu` for a fresh one.

Every typed Module request, including a natural-language follow-up, needs its prefix. Opening a menu does not select a destination for later unprefixed messages. `mail` and its French alias `courrier` address the same Module.

| Start here | French command | English command |
| --- | --- | --- |
| [Connect Gmail, approve rules, then sort](docs/mail.md#quick-start) | `courrier connecter`, then `courrier trier` | `mail connect`, then `mail sort` |
| [Choose Slack channels, then search](docs/slack-unanswered.md#quick-start) | `slack canaux`, then `slack sans-réponse` | `slack channels`, then `slack unanswered` |
| [Browse shared inventory](docs/documentation.md#quick-start) | `documentation projets` | `documentation projects` |
| [Connect ClickUp, then read tasks](docs/clickup.md#quick-start) | `clickup connecter`, then `clickup tâches` | `clickup connect`, then `clickup tasks` |
| [Yousign destinations and status](docs/yousign.md#commands-and-status) | `yousign canaux`, `yousign statut` | `yousign channels`, `yousign status` |
| Read shared recorded/reserved AI usage | `budget` | `budget` |

Menus and saved-result navigation use no AI. Work-start buttons and commands can start paid interpretation/classification where their Module supports it; approval of changes remains separate. Overlapping starts report the existing request. Module guides explain result freshness, expiry and recovery.

## Failure and undo behavior

Mailbox failure handling and conservative undo are documented in [Mail Sorter](docs/mail.md#failure-and-undo-behavior). Slack Unanswered, Documentation, ClickUp and Yousign describe their own access and recovery behavior in their guides. A delivery error can occur after a result or mutation was saved; inspect current state through the relevant Module before assuming it failed.

## Tests

`npm test` runs behavioral workflow, security, OAuth and budget tests using an embedded PostgreSQL implementation with fake external providers. No live Slack messages, Gmail writes, or paid AI calls are made.

Set `WORKER_CONCURRENCY` to 2–4 (default 2) so another lane can serve navigation while one is waiting for a provider. Startup rejects 1. Existing `.env.example` already uses 2.

For actual PostgreSQL locking and concurrency tests, also set `TEST_DATABASE_URL` to a local test database, then run `npm test`. These tests create and remove their own uniquely named schema. Without this environment variable, the real-server tests are explicitly skipped.

Run `npm run check` and `npm run build` for TypeScript validation and production output.

## Docker deployment

Set `POSTGRES_PASSWORD` in `.env` to a strong URL-safe random value. `docker compose up --build -d` starts the app and database, binding the app to `127.0.0.1:3001` on the host and port `3000` inside the container. Compose sets the container's `PORT=3000`; point the HTTPS reverse proxy at host port `3001`. PostgreSQL uses a named persistent volume and is not publicly published. Arrange automated encrypted database backups and test restoring them. This repository does not select or provision a hosting provider.

For an existing production server, pull `main` and run `bash scripts/deploy.sh`. Follow [Updating production](docs/deployment.md) for prerequisites, database backups, readiness checks, and release-specific migration notes. Production uses Docker Compose; preserve the existing checkout's `.env` and Compose project settings.

## Remaining release checks

Follow each enabled Module's guide and the [deployment guide](docs/deployment.md) for its live checks. The list below covers shared operation and Mail Sorter; Slack contextual matching, Documentation answers/import and ClickUp OAuth/API completeness have additional checks in their contracts.

- Configure the real Slack app, Google OAuth client, allowed Workspace domains, and OpenAI project.
- Run a live smoke test with a dedicated test mailbox, including Gmail Trash/restore and reconnection.
- Evaluate urgency, newsletters versus transactional mail, project ambiguity and adversarial email text on representative consented or synthetic messages. Unit tests establish workflow safeguards; they do not establish model accuracy.
- Confirm token-count endpoint availability/commercial terms, API pricing, operational usage, backup retention and secret management.
- Test the chosen host's HTTPS endpoints, Slack acknowledgement latency and restart recovery before adding the whole team.
