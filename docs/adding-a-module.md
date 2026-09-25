# Adding a built-in module

Modules live in `src/modules/<id>/` and are composed in `src/app/modules.ts`. A module is trusted code in the same process and deployment; independent enablement is not process or security isolation. Mail Sorter and Slack Unanswered ship today.

## Interface and routing

Implement `AssistantModule` from `src/core/modules.ts`. Required fields are a stable lowercase `id`, a short `description` for shared help, and `handle(actor, payload, eventId, context)`.

Each new typed module request starts with the module ID. The core removes the prefix and queues the request with an immutable module identifier. For example, `slack unanswered` reaches the Slack module as `{ type: 'text', text: 'unanswered' }`. A prefix by itself becomes the module's `help` request. Unknown prefixes and unprefixed requests receive shared guidance without paid AI routing. `menu`, `help`, `budget`, `hello` and `hi` are reserved shared commands; `core` is reserved for internal routing. Opening a Module menu does not change routing for later text.

The handler receives the authenticated Slack actor, a durable event ID, the current database connection, a budget attributed to this module, a messenger, and the queued job's request time. Pass local button action IDs to that messenger: it adds the module namespace automatically. The router removes the namespace when the button is clicked. Verify that every referenced object and approval belongs to the actor; a namespaced action is not authorization.

`legacyActions` exists solely for exact pre-module button IDs already posted to Slack. New modules should not use it. Duplicate module IDs, reserved IDs, and ambiguous legacy action registrations are rejected.

### Private DM menus

Optional `name` supplies the user-facing Module name. Optional `menu(actor, page, { sql })` returns a `MenuPage` with a kind header, text, local workflow buttons and optional `{ label, page }` navigation links. It reads the Module's current state without AI calls or workflow mutations. The shared runtime supplies Back to menu, namespaces local page destinations and keeps state queries inside the Module. Without a menu callback, the core shows the Module description and its help command.

Menu links use authenticated core navigation jobs rather than a remembered active Module. Workflow buttons still use normal module jobs and must recheck ownership and current state. Use the exported `menuButton` (a button with `scope: 'core'`) on workflow Cards to open a separate menu without replacing that Card. Do not manually prefix local action IDs. Scoped core buttons explicitly bypass module namespacing; they do not bypass authorization.

`Messenger.send` remains compatible with existing workflow callers. Navigation-capable adapters also implement `post` (return the posted message timestamp) and `update` (edit that timestamp). The production Slack adapter shares rendering/sanitization for posts and updates. Send-only test adapters remain valid for existing workflow tests; navigation tests need message identities and updates.

Core records posted menu identities against owner and DM, then validates those records against signed action message timestamps before editing. A workflow Card is never an in-place navigation target. Menu metadata expires after 30 days; send `menu` to recover. This is shared delivery metadata, not Module state, and it can expire while a Module is disabled without changing that Module's saved work. Navigation delivery markers are written before contacting Slack: definite rejection allows retry, while an uncertain outcome requires a fresh User request. Markers for pending jobs survive cleanup. Existing owner locking still applies; keeping navigation responsive during long work belongs to a later redesign slice.

## State and retries

Own the module's tables, domain types, connection credentials, conversation history, and retention policy. Prefix new table names with the module ID. Scope every user-state lookup and update to `ownerKey(actor)`; do not read another module's state. The mail module retains its original `users` and `oauth_states` table names to preserve existing installations.

The shared worker processes jobs under a `team:user` advisory lock, including across different modules. Work is durable and can be retried after a restart or delivery error. Handlers must deduplicate effects using `eventId`, persist execution checkpoints before external mutations, and handle uncertain outcomes without blindly repeating changes. The existing mail module demonstrates these requirements. Duplicate Slack requests are also deduplicated on enqueue.

Optional lifecycle methods are:

- `initialize(sql)`: apply idempotent module schema changes before the server starts.
- `registerRoutes(app)`: register module-specific endpoints. Authenticate these endpoints and validate external data in the module. Internal jobs must include the module ID when passed to `JobStore.enqueue`.
- `cleanup(pool)`: remove expired module state. Use `withOwner` before changing active per-user records. Cleanup runs at startup and hourly; shutdown waits for an active cleanup to finish.

Only enabled modules are constructed, initialized, and registered. Disabled modules' queued jobs are left untouched and excluded from worker selection, including selection after taking the owner lock. Shared jobs and other modules can still run for that user. A module's cleanup is also paused while disabled; account for that when planning retention and decommissioning.

## Configuration and paid AI work

For module-specific configuration, write a module-local reader and call it inside the factory in `src/app/modules.ts`. This ensures missing credentials for a disabled module cannot prevent startup. Modules may use already-validated shared configuration, such as the Slack bot token, directly. Register the factory and add its ID to the deployment's comma-separated `ENABLED_MODULES`, then restart. Do not instantiate Gmail, Google OAuth, or a mail store for another module.

Use `context.budget` for all paid AI work: reserve an upper bound before making a request and settle verified usage afterward. Uncertain calls retain their reservation. This budget is already tagged with the module ID and enforces the shared monthly ceiling and per-user ceiling across all modules. Do not create independent spending ledgers. Shared alerts and the `budget` command operate across the whole assistant.

Keep prompts and provider-specific domain interpretation in the module. Never put credentials in prompts or treat retrieved messages as authorization. Design any new external permissions and approval flows for the actual feature when adding it.

## Verification

Test routing through `ModuleRegistry` and `dispatchJob`, not just by invoking the handler directly. Include missing prefixes, unknown/disabled modules, namespace collisions, another user's buttons, duplicate events, restart recovery, and shared budget exhaustion. Use fake external providers. `tests/modules.test.ts` includes a test-only capability alongside the real mail module to demonstrate that additional modules need no Gmail connection.

Run `npm test`, `npm run check`, and `npm run build` with Node 24+. Set `TEST_DATABASE_URL` to a disposable PostgreSQL test database to include actual advisory-lock and concurrency tests; otherwise those tests are explicitly skipped.
