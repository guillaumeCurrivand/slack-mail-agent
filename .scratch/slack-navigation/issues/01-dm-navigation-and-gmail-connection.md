# 01: DM navigation and Gmail connection

Status: resolved

**What to build:** A User can discover the Agent's enabled Modules, browse private DM menus, view Budget and Help, and manage their Gmail connection without remembering commands. Navigation updates the menu being used while keeping workflow Cards intact.

**Blocked by:** None (can start immediately).

**Specification:** [Clickable navigation in private Slack DMs](../spec.md). User stories 1–19, 32, 39–40; acceptance coverage 1–4 and the shared navigation/security portions of 11–14. Later tickets complete module-specific menu actions and responsiveness during active work.

## Acceptance criteria

- [x] `menu` posts a fresh main menu. `help` and plain greetings such as `hello` show the main menu. Unrecognized commands return useful guidance and a Menu button without an AI call.
- [x] The main menu offers enabled Mail Sorter and Slack Unanswered entries plus Budget and Help. Disabled Modules are hidden; Budget and Help remain usable when none are enabled. Help gives actual guidance with a way back rather than repeating itself.
- [x] Each enabled Module has a private menu with Back to menu. Establish extension points for later tickets without exposing dead work buttons: until their ticket lands, clearly describe the existing command where necessary. The final menus gain the full approved actions through tickets 02–04.
- [x] Navigation updates the exact menu message clicked, including when several older menus exist. The shared Menu action can be attached to module-produced Cards without incorrect module namespacing; on a workflow Card it opens a separate menu and preserves the source Card.
- [x] Authenticated action jobs retain enough identity for safe message updates. Recheck workspace, actor, private DM and the intended Agent-owned update target; reject unauthorized or cross-user targets. Namespaces and raw timestamps alone are not authorization.
- [x] Mail Sorter exposes Gmail connection status and Connect Gmail when disconnected. Sorting prerequisites are explained. Connect and disconnect reuse existing single-use Google authorization, mailbox ownership confirmation and explicit disconnect confirmation; preserve rule retention and Preview invalidation.
- [x] Older controls recheck current availability. Disabled Modules receive shared guidance without instantiation or execution; disconnected Gmail receives a route to reconnect. Navigation never changes the meaning of later typed messages.
- [x] Existing commands, exact legacy buttons, Proposal ownership, approval handling and disabled queued-work behavior remain compatible.
- [x] Posts and updates preserve kind headers, sanitization, fallback text, bounded content and unique action IDs. Distinguish definite Slack rejection from uncertain delivery; a failed update permits recovery through `menu` without repeating workflow effects.
- [x] Module-specific menus and data access remain within each Module. Shared runtime handles navigation and delivery without mail-specific queries. Any navigation metadata is owner-scoped, migrated idempotently and retained/cleaned consistently with existing rules.

## Verification and delivery

- [x] Extend existing signed Slack request tests through durable enqueue and dispatch, with fake Slack sends and updates. Cover discovery, Budget/Help, Back, no enabled Modules, historical menus, invalid signatures, other workspaces, non-private conversations, update-target ownership and delivery failure.
- [x] Exercise Gmail connection/disconnect from the public routing path with fake providers, including stale controls and preservation of existing confirmations. Demonstrate Slack navigation without Gmail credentials and zero AI calls for browsing.
- [x] Verify relevant migrations preserve existing jobs and approvals. Update the authoritative product and module-extension/setup documentation for the delivered behavior; keep unfinished redesign behavior labeled as future.
- [x] Check the active Node version, then run relevant tests and project `test`, `check` and `build` scripts. Report real PostgreSQL tests skipped without `TEST_DATABASE_URL` separately from passes, and identify live integrations not exercised.
- [x] Review the full diff and report local/committed/pushed state. This ticket does not authorize deployment. If handing off a release candidate, follow the repository's deployment requirements, including target commit, commands, migration/environment notes and post-deploy checks.

## Comments

Approved as ticket 1 of the four-ticket breakdown. Keep required additive Messenger/routing prefactoring within this slice and preserve old callers while adding update support. Long-running-operation responsiveness is completed by ticket 04.


Completed locally on 2026-09-25. Verified with Node v25.8.1: 114 automated tests passed, 2 real PostgreSQL tests skipped because TEST_DATABASE_URL was not configured; TypeScript check and build passed. Standards review found and resolved a shared/main module-destination collision; Spec review requested and received a complete fake-Google OAuth callback and signed mailbox-approval test. Both axes have zero outstanding findings. Documentation links and the full diff were checked. Live Slack, Google and AI integrations were not exercised, and production was not deployed. Tickets 02–04 remain pending.
