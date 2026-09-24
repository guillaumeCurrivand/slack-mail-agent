# Prepare the assistant for additional modules

Status: historical plan, completed after the user's shared-understanding confirmation on 2026-09-24. This document preserves the implementation scope and its original verification results; it is not a current specification.

For current behavior, use [the product specification](../product-spec.md). For extension instructions, use [the module guide](../adding-a-module.md). Architectural rationale is recorded in [ADR 0002](../adr/0002-private-assistant-modules.md).

## Agreed behavior

- One Slack bot, with private interactions for each user.
- Mail Sorter remains the only implemented product module in this change.
- Module requests use explicit DM prefixes, including natural-language requests: `mail sort`, `mail change my newsletter rule`, and eventually `tasks list`. No remembered active module or AI-based routing.
- Shared `help` and `budget` commands belong to the assistant. Unprefixed module requests receive guidance; bare `sort` no longer starts sorting.
- Modules are built into this repository and deployed together, with independent enablement and connection requirements.
- All modules share the existing $10 monthly AI ceiling, with usage attributed by module. Existing per-user ceilings and reservation safeguards remain in effect.
- The future Tasks module will identify requests addressed to a person in selected Slack channels they can access, with or without an @mention, and present results privately. Its ingestion, permissions, and task-management behavior will be designed when that module is implemented.

## Proposed implementation

Organize application composition and startup under `src/app`, shared runtime behavior under `src/core`, and the existing mail implementation under `src/modules/mail`. Keep `src/main.ts` as the entry point.

The core owns Slack request verification, user identity, explicit routing, durable jobs, per-user serialization, shared messaging, and budget accounting. A small built-in module registry connects enabled modules to routing and lifecycle behavior. The core must not import Gmail workflows or mail-specific state.

The mail module owns its commands, interactive actions, Gmail connection and OAuth routes, rules, previews, reports, undo, mail-specific AI prompts, persistence, and retention cleanup. Its dependencies are constructed only when enabled; disabling it removes the requirement for mail-only credentials.

Route module work and new interactive actions using a stable module identifier. Buttons identify their originating module independently of subsequent user messages. Unknown or disabled modules produce useful guidance without executing work. Each module accesses its own state; sharing a process and database is not a security sandbox between trusted module implementations.

Separate shared queue and budget persistence from mail persistence. Preserve existing stored mail data, credentials, approvals, queued work, and historical spending through explicit compatibility handling where needed. Existing queued mail work and previously posted mail buttons must retain their ownership and approval checks; new user messages follow the new prefix requirement. Disabling a module must prevent execution of its pending work.

Add module attribution to budget reservations and charges without resetting shared totals; attribute historical calls to Mail Sorter. Continue using the shared atomic spending checks across modules.

Update command guidance, README, configuration examples, and the product specification to match the agreed behavior. Document how to add a built-in module. Do not add a production Tasks placeholder, channel access, slash-command endpoints, runtime plugin installation, or separate deployments in this change.

## Verification

Run the existing mail, security, OAuth, workflow, and budget coverage against the reorganized code. Add focused behavioral checks for explicit routing, independent enablement, namespaced buttons/jobs, retained-data compatibility, and shared budget enforcement across module identifiers. A small test-only module can verify extensibility without implementing Tasks.

Run `npm test`, `npm run check`, and `npm run build`. Run real PostgreSQL concurrency tests if a test database is available, and report any skipped checks. No live Slack messages, mailbox operations, deployment, or paid AI calls are required for this restructuring.

Validation on Node 24.19.0: 74 tests passed; the two real PostgreSQL concurrency tests were skipped because `TEST_DATABASE_URL` was not configured. TypeScript validation and production compilation passed. The embedded-database tests cover module routing, private ownership checks, legacy migration, independent enablement, disabled-job retention and resumption, and shared spending attribution. Live Slack/Gmail integration was not exercised.
