# Private Slack Assistant

A private Slack assistant for a 10-person Google Workspace team, organized into independently enabled modules. Mail Sorter is the first module. Users connect their own Gmail account, approve personal rules, request a preview of their latest 100 inbox messages, and confirm before any messages are labeled, archived, or moved to Trash.

The [approved product specification](docs/product-spec.md) describes the scope. The application is implemented locally; a real Slack/Google/OpenAI deployment and model-quality evaluation are still required before team rollout.

## Documentation map

Start with [AGENTS.md](AGENTS.md) for contributor guidance. The [product specification](docs/product-spec.md) owns assistant-wide behavior and safeguards, [CONTEXT.md](CONTEXT.md) owns terminology, the [module guide](docs/adding-a-module.md) owns extension instructions, and [ADRs](docs/adr/) explain architectural choices. This README covers operation and usage. The [Slack Unanswered contract](docs/slack-unanswered.md) records its approved module behavior; [archived plans](docs/archive/) are historical records.

## What is included

- Slack DMs, natural-language rule proposals, explicit rule approval, starter rules, and per-user conversation history.
- Google Workspace OAuth with PKCE, nonce and browser-state checks, hosted-domain enforcement, encrypted credentials, and a final Slack confirmation of the mailbox address.
- Persistent previews, explicit decisions for uncertain messages, individual-message actions, reports, and conservative undo.
- Durable PostgreSQL jobs, per-user serialization, duplicate-event protection, and mutation checkpoints.
- A shared $10/month AI allowance, $8 alert, configurable per-user ceilings, and atomic reservations before generation. Channel selection, approval, reports, and undo do not require AI; contextual Slack matching and mail interpretation do.
- For enabled modules, hourly retention cleanup removes conversations and run records older than 30 days, as well as expired login states and rule proposals. See the [retention policy](docs/product-spec.md#memory-and-undo) for the disabled-module exception.

## Modules and project structure

- `src/app/`: configuration, built-in module composition, startup, and compatibility migrations.
- `src/core/`: Slack transport, explicit routing, durable jobs, identity and locking, messaging, and shared AI budget.
- `src/modules/mail/`: mail commands, Gmail/OAuth, rules, previews, undo, mail AI, state, and retention.
- `src/modules/slack/`: per-user Slack channel choices, shared-channel discovery, and on-demand unanswered-message search with contextual AI matching.

`ENABLED_MODULES=mail` is the default. An empty value starts only shared help, budget, and health endpoints; Gmail, encryption, and AI credentials are then unnecessary. Unknown or duplicate module identifiers fail startup. Availability is deployment-wide; each user still owns their connections and data. Restart to apply a module configuration change.

Disabled modules expose no routes and execute no queued work. Their pending jobs and state are retained for re-enablement, and their module-specific retention cleanup is paused while disabled. Other modules and shared commands continue processing. Modules are trusted code deployed together, not sandboxed plugins.

Slack Unanswered is implemented locally but disabled by default. Set `ENABLED_MODULES=mail,slack` (or `slack` without Mail Sorter) to offer `slack channels` and `slack unanswered` in private DMs. Each user first selects shared public and private channels with `slack channels`; the module does not read channel history until `slack unanswered` is requested. That command privately lists direct @mentions, profile-name matches, and contextually directed requests posted in the preceding 48 hours if the user has not replied later in the thread. Plausible but uncertain matches appear under **Possibly for you**. The module uses `OPENAI_API_KEY` and the pinned `OPENAI_MODEL` for contextual matching through the shared AI budget; without a key or available budget, it still shows direct matches and discloses that contextual results were not checked. If Slack does not show a response after a delivery error, repeat the command to see current state. See the [feature contract](docs/slack-unanswered.md) and the [architecture decision](docs/adr/0002-private-assistant-modules.md).

### Upgrading an existing installation

Stop the old process before starting this version; do not run old and new workers together during the upgrade. Startup adds module identifiers to existing jobs and AI records, treating old records as Mail Sorter. Mail tables, encrypted credentials, saved rules, previews, and spending totals retain their existing values. Previously queued requests and previously posted buttons still work with their original ownership and approval checks. New DM requests require the `mail` prefix; bare `sort` returns guidance.

## Requirements for the host

Use your preferred provider. The app needs Node.js 24 or later (or Docker), PostgreSQL, persistent storage, backups, secret configuration, a public HTTPS origin, and outbound HTTPS access to Slack, Google and OpenAI. Background processing runs in the app process; no Redis, GPU or separate worker host is required initially.

For a single server running both app and database, start with 1 vCPU, 2 GB RAM and 10 GB persistent storage, then measure usage. These are initial sizing estimates. The provider's price is outside the $10 AI budget. Configure your reverse proxy with TLS and disable/redact request-URL logging on `/auth/google*`, since URLs contain short-lived login codes.

## Local installation

1. Install Node.js 24+ and PostgreSQL, or use the Docker configuration below.
2. Run `npm ci`.
3. Copy `.env.example` to `.env` and fill in the values. Do not commit credentials or paste them into chat.
4. Generate the encryption key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Store it securely as `ENCRYPTION_KEY`; losing it makes stored Google credentials unreadable.
5. Set `DATABASE_URL` to your PostgreSQL connection string. The app initializes its tables at startup. For managed databases, use the provider's TLS configuration; do not disable certificate verification.
6. Build with `npm run build`, then run `node --env-file=.env dist/main.js`. For development use `node --env-file=.env --import tsx --watch src/main.ts`.

`GET /health` checks the process; `GET /ready` checks database connectivity. These endpoints reveal no mailbox or credential data.

## Slack setup

Create a Slack app for your workspace using [slack-manifest.json](slack-manifest.json). Replace `https://YOUR_HOST` with your public origin. The endpoints are `/slack/events` and `/slack/actions`. Enable the app's Messages tab so users can DM the bot.

The app uses `message.im` events and the bot scopes `im:history`, `chat:write`, `channels:read`, `groups:read`, `channels:history`, `groups:history`, and `users:read`. The read scopes support listing shared channels, reading selected channel histories and threads, and matching Slack profile names. Update the app's scopes and reinstall it to grant them before enabling `slack`; invite the bot to channels users should be able to choose. A private channel appears in `slack channels` only when both the requesting user and the bot belong to it and the installed bot token has `groups:read`. Put the installed bot token, signing secret, and workspace ID in `.env`. Set `SLACK_ADMIN_USER_ID` if one person should receive private operational spending alerts; it grants no access to other users' rules or mail. Otherwise the user whose request crosses the threshold receives the alert.

Slack requests must be signed and belong to the configured workspace. Incoming channel-message events, bot messages, edited-message events, unsigned requests and replayed timestamps are excluded from event dispatch. `slack channels` lists only shared channels using a bot token; `slack unanswered` reads selected channel history only on command. Searching long-lived channels may take time or encounter Slack rate limits because older roots must be inspected for recent thread replies. Events are acknowledged after durable enqueue, before module processing.

## Google Workspace setup

Use a Google Cloud project owned by your Workspace organization, enable the Gmail API, and configure an internal OAuth audience where your organization supports it. Create a Web application OAuth client with this exact authorized redirect URI:

```
https://YOUR_HOST/auth/google/callback
```

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the comma-separated `GOOGLE_WORKSPACE_DOMAINS`. These are Google's verified hosted-domain values, not merely email suffixes. Request `openid`, `email`, and `https://www.googleapis.com/auth/gmail.modify`. Your Workspace administrator may need to allow the app and scope. Internal-app eligibility and organization policies must be checked in your own Google Cloud/Workspace configuration.

Each teammate sends `mail connect` in a DM, follows their short-lived link, grants access using their own Workspace account, and confirms the resulting email address back in Slack. Authorization is not activated until this last confirmation. An account cannot be activated for two Slack users in the configured workspace.

`mail disconnect` removes the application's active credentials and cancels pending previews after confirmation. It leaves rules in place. Users can additionally revoke the OAuth grant in their Google account. Historical encrypted credentials may remain in database backups until their retention period expires.

## OpenAI and the $10 limit

Use a dedicated OpenAI project/key for this application. The pinned initial model is `gpt-4.1-mini-2025-04-14`, with a reviewed price card of $0.40/million input tokens and $1.60/million output tokens. Unknown model names are rejected until their rates and behavior are reviewed. See [model-budget.md](docs/research/model-budget.md) for sources and assumptions.

The app counts the immutable input through the Responses token-count endpoint, reserves exact input plus bounded output in integer microdollars, then generates with `store:false`, standard service tier, disabled truncation, and no automatic retries. It conservatively charges all input at the uncached rate. Conversation and classification calls, and future modules, use the same team ledger. Usage is attributed to each module; the global `budget` command shows totals and the module breakdown.

Calendar months use UTC. A request with missing usage, timeout, or crash keeps its full reservation. This can pause work early; it is preferable to silently spending the same allowance again. Cost records contain no email bodies. Reconcile uncertain reservations against provider usage before manually settling them; never simply delete them to unblock requests. Alerts include reservations as well as settled charges.

The limit governs this app's recorded generation usage at its configured prices. Taxes, price changes, token-count endpoint commercial terms, and other applications using the same key are outside that accounting; verify pricing and project usage before release. $10 does not promise a fixed number of scans. `store:false` does not imply zero provider retention.

## Using it

Send these in a private conversation with the bot. Every module request, including natural-language follow-ups, needs its prefix; the assistant does not remember an active module:

- `mail connect`: connect Gmail.
- `mail starters`: review Urgent and Newsletter templates; describe project names and exact sender addresses separately.
- `mail rules`: inspect approved rules and their IDs.
- `mail sort`: scan the latest 100 inbox messages and receive a preview.
- `mail report`: inspect the latest run, open detailed pages, or undo a completed run.
- `mail details <run-id> <page>`: open a retained run's details (page numbers start at zero).
- `help`: list enabled modules; `mail help` shows mail commands.
- `budget`: see shared recorded and reserved AI usage without paying for a model call.
- `mail disconnect`: propose disconnecting Gmail.

Natural-language examples: “mail Label messages from alex@example.com as Projects/Alpha and keep them in my inbox.” “mail Change my newsletter rule to exclude product announcements.” “mail For message `<message-id>` in run `<run-id>`, remove the Urgent label and keep it in my inbox.” Corrections have their own confirmation preview; a future-rule change requires separate approval.

Previews show proposed label creation, archive and Trash counts, and paginated message explanations. Uncertain messages are excluded until explicitly included using their individual proposal button. Confirmation applies only the saved run. Changing rules or reconnecting Gmail invalidates old previews, which also expire after 24 hours.

## Failure and undo behavior

The app checks labels and Gmail history IDs immediately before a write, then journals the exact label additions/removals before calling Gmail. Trash and archive are represented as individual-message system-label changes. A process interruption or ambiguous network failure marks the action unknown; it is not replayed or automatically undone. Inspect Gmail for these cases.

Undo reverses this agent's recorded deltas only when the message still matches the state returned by its write. If another client edits or marks a message read, undo can conservatively skip it rather than overwrite that edit. Newly created empty labels are not deleted by undo. Messages permanently deleted by Gmail or a user cannot be recovered.

Gmail does not provide conditional mutation with a history-ID compare-and-swap. An external client can still race between the precheck and mutation. Application serialization prevents this app from racing with itself, but cannot eliminate Gmail's external-client race. See [integration contracts](docs/research/integration-contracts.md).

## Tests

`npm test` runs behavioral workflow, security, OAuth and budget tests using an embedded PostgreSQL implementation with fake external providers. No live Slack messages, Gmail writes, or paid AI calls are made.

For actual PostgreSQL locking and concurrency tests, also set `TEST_DATABASE_URL` to a local test database, then run `npm test`. These tests create and remove their own uniquely named schema. Without this environment variable, the real-server tests are explicitly skipped.

Run `npm run check` and `npm run build` for TypeScript validation and production output.

## Docker deployment

Set `POSTGRES_PASSWORD` in `.env` to a strong URL-safe random value. `docker compose up --build -d` starts the app and database, binding the app to `127.0.0.1:3001` on the host and port `3000` inside the container. Compose sets the container's `PORT=3000`; point the HTTPS reverse proxy at host port `3001`. PostgreSQL uses a named persistent volume and is not publicly published. Arrange automated encrypted database backups and test restoring them. This repository does not select or provision a hosting provider.

For an existing production server, pull `main` and run `bash scripts/deploy.sh`. Follow [Updating production](docs/deployment.md) for prerequisites, database backups, readiness checks, and release-specific migration notes. Production uses Docker Compose; preserve the existing checkout's `.env` and Compose project settings.

## Remaining release checks

- Configure the real Slack app, Google OAuth client, allowed Workspace domains, and OpenAI project.
- Run a live smoke test with a dedicated test mailbox, including Gmail Trash/restore and reconnection.
- Evaluate urgency, newsletters versus transactional mail, project ambiguity and adversarial email text on representative consented or synthetic messages. Unit tests establish workflow safeguards; they do not establish model accuracy.
- Confirm token-count endpoint availability/commercial terms, API pricing, operational usage, backup retention and secret management.
- Test the chosen host's HTTPS endpoints, Slack acknowledgement latency and restart recovery before adding the whole team.
