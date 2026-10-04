# Private Slack Assistant

A private Slack assistant for a 10-person Google Workspace team, organized into independently enabled modules. Mail Sorter is the first module. Users connect their own Gmail account, approve personal rules, request a preview of their latest 100 inbox messages, and confirm before any messages are labeled, archived, or moved to Trash.

The application-owned interface is French. Original inventory values, approved rules, message excerpts and URLs remain literal. Dates display `DD/MM/YYYY HH:mm (Europe/Paris)` and numbers use French separators. Buttons share horizontal action rows; Slack can wrap them on narrow clients, and Documentation's record selector stays separate. English commands remain compatible alongside the French shortcuts below. See the [presentation contract](docs/product-spec.md#interactive-message-presentation).

The [approved product specification](docs/product-spec.md) describes the scope. The application is implemented locally; a real Slack/Google/OpenAI deployment and model-quality evaluation are still required before team rollout.

## Documentation map

Start with [AGENTS.md](AGENTS.md) for contributor guidance. The [product specification](docs/product-spec.md) owns assistant-wide behavior and safeguards, [CONTEXT.md](CONTEXT.md) owns terminology, the [module guide](docs/adding-a-module.md) owns extension instructions, and [ADRs](docs/adr/) explain architectural choices. This README covers operation and usage. The [Slack Unanswered contract](docs/slack-unanswered.md) records its approved module behavior; [archived plans](docs/archive/) are historical records.

The [ClickUp feature contract](docs/clickup.md) records its approved behavior and local implementation. Live OAuth/API verification and deployment remain release checks.

The [Yousign feature contract](docs/yousign.md) describes company webhook notifications to shared selected channels, with private configuration and delivery status.

ClickUp's [personal status filters](docs/clickup.md#personal-status-filters) are implemented locally. Send `clickup statuts` / `clickup statuses`, or choose **Choisir les statuts** in its menu. **Ajouter/Retirer** and **Réinitialiser le filtre** save automatically; **Fermer** preserves changes. Each User keeps their own filter; new task requests and Refresh apply it. The default excludes Done/Closed, which explicit choices can include. During incomplete discovery, default-mode changes preserve undiscovered unfinished statuses and offer Retry; Personal List-specific discovery is deferred. See [deployment checks](docs/deployment.md#clickup-release-candidate) for live verification.

## What is included

- Slack DMs, natural-language rule proposals, explicit rule approval, starter rules, and per-user conversation history.
- Google Workspace OAuth with PKCE, nonce and browser-state checks, hosted-domain enforcement, encrypted credentials, and a final Slack confirmation of the mailbox address.
- Persistent previews, explicit decisions for uncertain messages, individual-message actions, reports, and conservative undo.
- Durable PostgreSQL jobs, per-user and per-module serialization, active-operation admission, duplicate-event protection, and mutation checkpoints.
- A shared $10/month OpenAI allowance, $8 alert, configurable per-user ceilings, and atomic reservations before generation. Development uses separately billed local Cursor calls. Channel selection, approval, reports, and undo do not require AI; contextual Slack matching and mail interpretation do.
- For enabled modules, hourly retention cleanup removes conversations and run records older than 30 days, as well as expired login states and rule proposals. See the [retention policy](docs/product-spec.md#memory-and-undo) for the disabled-module exception.

## Modules and project structure

- `src/app/`: configuration, built-in module composition, startup, and compatibility migrations.
- `src/core/`: Slack transport, explicit routing, durable jobs, identity and locking, messaging, and shared AI budget.
- `src/modules/mail/`: mail commands, Gmail/OAuth, rules, previews, undo, mail AI, state, and retention.
- `src/modules/slack/`: per-user Slack channel choices, shared-channel discovery, and on-demand unanswered-message search with contextual AI matching.
- `src/modules/documentation/`: workspace-shared Projects, Technologies, Components, Hosts/services, Hosting entries and Tools, lifetime history, structured creation/edits/archive/restore with private confirmations, and relationship navigation.
- `src/modules/clickup/`: personal OAuth connections, Mayasquad-only assigned-task retrieval, private table snapshots, access checks and retention.
- `src/modules/yousign/`: authenticated company webhook receipt, shared destinations and integration-owned notification delivery/recovery.

- `src/modules/development/`: shared project-channel investigations, frozen ClickUp authorizations, durable worker claims and local Cursor maintenance commits. See [Development](docs/development.md).

`ENABLED_MODULES=mail` is the default. An empty value starts only shared help, budget, and health endpoints; Gmail, encryption, and AI credentials are then unnecessary. Supported identifiers are `mail`, `slack`, `documentation`, `clickup`, `yousign` and `development`. Unknown or duplicate module identifiers fail startup. Availability is deployment-wide; each user still owns their connections and data. Restart to apply a module configuration change.

Documentation tickets 01–10 are implemented locally and opt-in: add `documentation` to the existing `ENABLED_MODULES` value, or use it alone. Structured operations need no AI or Gmail credentials. Project questions use the existing optional OpenAI credentials and shared budget. Inventory/history are shared within the configured Slack workspace; confirmations and navigation remain private. Send `documentation help`, `documentation projects`, `documentation project <identifier, exact name or alias>`, or `documentation history [identifier, exact name or alias]` (omit the target for shared history). To create one record, send `documentation create project {"name":"Alpha"}`. To edit selected fields, send `documentation edit project Alpha {"description":"Replacement","notes":null}`. Browse Technologies with `documentation technologies` and Project Components with `documentation components Alpha`. Create a Technology with `documentation create technology {"name":"React"}`, then create a Component with `documentation create component {"name":"Web client","projectId":"<Project identifier>","type":"frontend","technologies":["React"]}`. Browse shared services with `documentation hosts`. Create one with `documentation create host {"name":"OVH"}`, then add an entry with `documentation create hosting {"componentId":"<Component identifier>","serviceId":"OVH","environment":"production"}`. Inspect entries with `documentation hosting <Component identifier>` and `documentation hosting-entry <entry identifier>`. Browse Tools with `documentation tools`; create with `documentation create tool {"name":"Slack","usage":"Company chat","companyWide":true,"projects":["Alpha"]}`. Inspect `documentation tool <identifier or exact name>` and edit selected fields with `documentation edit tool <identifier> {"referent":null}`. Project details offer linked Tools; missing Projects require separate confirmed creation. Each record needs separate confirmation; a missing Technology is never silently created. Review the separate Card and confirm within 24 hours. Edits overwrite selected fields despite intervening edits, preserve unrelated fields, and record actual before/after history. Structured paths use no AI. Project-question interpretation uses the existing optional OpenAI credentials and shared budget; see ticket 07 in the linked contract. See [Documentation](docs/documentation.md) for all commands, fields, clearing, constraints and recovery. Archive/Restore controls and `documentation archived [page]` retain identifiers, relationships and history. Typed shortcuts are `documentation archive <kind> <identifier or exact name>` and `documentation restore <kind> <identifier or exact name>`, each separately confirmed within 24 hours. Archived targets require restoration before editing; Project questions and private context are delivered in ticket 07; inventory filters/counts are delivered in ticket 08; natural-language mutations are delivered in ticket 09; the offline operator import is delivered in ticket 10.

Conversational individual-record changes also enter the same saved confirmation path: `documentation please create a project named Alpha with description Team app`; `documentation please set this project description to Updated`; `documentation please archive the tool Tracker`. Exact targets and existing references are resolved before approval; missing catalog records require separate confirmed creation. Interpretation uses the shared budget, while confirmation and result/history controls remain free. See [ticket 09](docs/documentation.md#delivered-locally--ticket-09) and the [synthetic evaluation cases](docs/testing/documentation-natural-language-changes.md).

Disabled modules expose no routes and execute no queued work. Their pending jobs and state are retained for re-enablement, and their module-specific retention cleanup is paused while disabled. Other modules and shared commands continue processing. Modules are trusted code deployed together, not sandboxed plugins.

Slack Unanswered is implemented locally but disabled by default. Set `ENABLED_MODULES=mail,slack` (or `slack` without Mail Sorter) to offer its private menu, `slack channels` and `slack unanswered`. Each user first selects shared public and private channels through Slack Unanswered → Choose channels or `slack channels`; list pagination and Add/Remove update the same message. The module does not read channel history until `slack unanswered` is requested. That command privately lists direct @mentions, profile-name matches, and contextually directed requests posted in the preceding 48 hours if the user has not replied later in the thread. Plausible but uncertain matches appear under **Possibly for you**. The module uses `OPENAI_API_KEY` and the pinned `OPENAI_MODEL` for contextual matching through the shared AI budget; without a key or available budget, it still shows direct matches and discloses that contextual results were not checked. If Slack does not show a response after a delivery error, repeat the command to see current state. See the [feature contract](docs/slack-unanswered.md) and the [architecture decision](docs/adr/0002-private-assistant-modules.md).

Documentation also offers free exact `documentation search {"target":"project","filters":[{"kind":"technology","selector":"React"}]}` and `documentation count` with the same JSON. Natural-language inventory questions use the shared budget; saved result pages need no repeated interpretation. Combined Technology/Host questions clarify Component scope, counts cover all distinct matches, and changed inventory restarts paging visibly. See [ticket 08](docs/documentation.md#delivered-locally--ticket-08) for qualifiers, company-wide Tools, fields, archival and coverage semantics.

The one-time spreadsheet transition is available through the [offline operator import procedure](docs/documentation-import.md), using a complete frozen JSON cell snapshot, explicit reviewed mappings and separate User approval. Review never changes inventory; apply/reconcile retain restart checkpoints and initial history before establishing database authority. Deploying the importer does not authorize real source review/import. See the [release procedure](docs/deployment.md#documentation-import-release-candidate).

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

DM `clickup connecter` (English `clickup connect`) or open Menu → ClickUp → Connecter ClickUp. Authorize Mayasquad in the original browser, return to Slack and separately confirm the displayed ClickUp identity within 24 hours. The OAuth link/login state lasts 10 minutes. Extra authorized Workspaces are ignored. Account email need not match Slack; one ClickUp account cannot be active for two Slack Users in the configured workspace.

DM `clickup tâches` (`clickup tasks`, or `clickup taches`) or click Mes tâches. The free, read-only table lists direct personal assignments, including subtasks/multiple assignees, with eight rows per page. It excludes Done/Closed and individually archived tasks; an archived parent or location does not independently exclude a task. Deadline dates use Europe/Paris; today's tasks are not overdue. Previous/Next uses the saved snapshot and rechecks access. Actualiser/Réessayer retrieves fresh data; overlapping starts report the active request. Incomplete retrieval is labeled, rather than presented as a complete empty list. Results expire after 24 hours.

`clickup aide`/`clickup help` shows connection status. `clickup déconnecter`/`clickup disconnect` requests a separately confirmed disconnect, removing credentials, pending authorizations and snapshots. Replacing the account invalidates old snapshots only after the new identity is approved. Already-posted Slack text and historical backups have separate retention; disconnect does not revoke the grant at ClickUp. Revoked access asks for reconnect without showing cached task text. See the [release checks](docs/deployment.md#clickup-release-candidate) before rollout; no live ClickUp deployment has been observed.

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

Send `menu`, `aide`, `bonjour` or `salut` to open a private menu; `help`, `hello` and `hi` remain compatible. Click an enabled Module, Budget or Aide; Retour navigation updates that same message. Tri des e-mails → Connexion Gmail shows connection status and offers Connecter Gmail or confirmed disconnect. Google sign-in still opens externally, and the resulting mailbox still needs your approval in Slack. Mail workflow Cards include Menu buttons that open separate navigation without replacing the Card.

Tri des e-mails also offers Gérer les règles, Dernier rapport and Approbations en attente when needed. Rule lists paginate in place and summarize long fields. Add/Edit gives instructions for a `courrier`-prefixed description; starter rules and removal still need separate approval. Saved Proposals, Previews and Reports reopen as separate Cards without new AI work or extended validity. Old generated text keeps its original language with a French notice; approved values and posted messages are not rewritten. Expired or invalidated approvals cannot be reopened as current work.

Tri des e-mails → Trier la boîte de réception and Messages Slack sans réponse → Chercher les messages sans réponse start their existing work immediately. The corresponding `courrier trier` and `slack sans-réponse` shortcuts, and their English forms, use the same active-operation admission: another request received while that User's operation is queued, running or retrying reports the original request. After completion or terminal failure, a deliberate new request can start. A Preview still requires separate approval before Gmail changes. Slack search still uses the original request time for its 48-hour window; paging its saved result does not rerun classification or spend AI, and checks current channel access before showing excerpts. Menus do not use AI or remember an active Module. If an older button cannot be updated, send `menu` for a fresh menu; menu update identities expire after 30 days. Navigation and the other Module can continue during a long provider call.

Send these in a private conversation with the bot. Every module request, including natural-language follow-ups, needs its prefix; the assistant does not remember an active module:

- `courrier connecter`: connect Gmail.
- `courrier modèles`: review Urgent and Lettres d’information templates; describe project names and exact sender addresses separately.
- `courrier règles`: inspect approved rules and their IDs.
- `courrier trier`: scan the latest 100 inbox messages and receive a preview.
- `courrier rapport`: inspect the latest run, open detailed pages, or undo a completed run.
- `courrier détails <run-id> <page>`: open a retained run's details (page numbers start at zero).
- `aide`: list enabled modules; `courrier aide` shows mail commands.
- `budget`: see shared recorded and reserved AI usage without paying for a model call.
- `courrier déconnecter`: propose disconnecting Gmail.
- `slack canaux` / `slack sans-réponse`: choose sources, then search their unanswered messages.
- `documentation aide` / `documentation projets` / `documentation projet <cible>`: browse shared inventory. Use `documentation créer projet {"name":"Alpha"}` or `documentation modifier projet Alpha {"notes":null}` for separately confirmed changes. JSON keys remain English. See [Documentation](docs/documentation.md) for all French aliases and compatible English commands.

Natural-language examples: “courrier Applique le libellé Projects/Alpha aux messages de alex@example.com et conserve-les dans ma boîte de réception.” “courrier Modifie ma règle de lettres d’information pour exclure les annonces de produits.” “courrier Pour le message `<message-id>` du traitement `<run-id>`, retire le libellé Urgent et conserve-le dans ma boîte de réception.” Corrections have their own confirmation preview; a future-rule change requires separate approval.

Previews show proposed label creation, archive and Trash counts, and paginated message explanations. Uncertain messages are excluded until explicitly included using their individual proposal button. Confirmation applies only the saved run. Changing rules or reconnecting Gmail invalidates old previews, which also expire after 24 hours.

## Failure and undo behavior

The app checks labels and Gmail history IDs immediately before a write, then journals the exact label additions/removals before calling Gmail. Trash and archive are represented as individual-message system-label changes. A process interruption or ambiguous network failure marks the action unknown; it is not replayed or automatically undone. Inspect Gmail for these cases.

Undo reverses this agent's recorded deltas only when the message still matches the state returned by its write. If another client edits or marks a message read, undo can conservatively skip it rather than overwrite that edit. Newly created empty labels are not deleted by undo. Messages permanently deleted by Gmail or a user cannot be recovered.

Gmail does not provide conditional mutation with a history-ID compare-and-swap. An external client can still race between the precheck and mutation. Application serialization prevents this app from racing with itself, but cannot eliminate Gmail's external-client race. See [integration contracts](docs/research/integration-contracts.md).

## Tests

`npm test` runs behavioral workflow, security, OAuth and budget tests using an embedded PostgreSQL implementation with fake external providers. No live Slack messages, Gmail writes, or paid AI calls are made.

Set `WORKER_CONCURRENCY` to 2–4 (default 2) so another lane can serve navigation while one is waiting for a provider. Startup rejects 1. Existing `.env.example` already uses 2.

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
