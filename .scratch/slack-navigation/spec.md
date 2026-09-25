# Clickable navigation in private Slack DMs

Status: ready-for-agent

The product design is approved. This specification describes future implementation, not shipped behavior. Testing follows the project's established signed-request, workflow and database-concurrency patterns.

## Problem Statement

Users must remember module prefixes and commands before they can discover most assistant capabilities. Existing Cards have workflow buttons, but no consistent navigation connects Mail Sorter, Slack Unanswered, settings and pending decisions. Long DM histories make it difficult to find a useful starting point or an approval still waiting for attention.

## Solution

Provide clickable menus entirely within each person's private DM with the Agent. The main menu leads to enabled Modules, Budget and Help. Navigation edits the menu being used; results and approval requests are separate Cards that remain in the conversation. Existing typed commands continue to work. Describing complex mail rules remains conversational, with an explicit `mail` prefix and separate approval.

The authoritative behavior is the [approved navigation contract](../../docs/product-spec.md#approved-dm-navigation-redesign). Existing Mail Sorter and [Slack Unanswered safeguards](../../docs/slack-unanswered.md) continue to apply.

## User Stories

1. As a User, I want to type `menu` to get a fresh main menu, so that I can navigate without remembering commands.
2. As a User, I want `help` and a plain greeting such as `hello` to show the main menu, so that I can discover the interface naturally.
3. As a User, I want an unrecognized command to provide guidance and a Menu button, so that I can recover without guessing syntax.
4. As a User, I want Mail Sorter, Slack Unanswered, Budget and Help on the main menu, so that I can discover the available capabilities.
5. As a User, I want disabled Modules omitted from the main menu, so that it reflects what I can use now.
6. As a User, I want Budget and Help to remain available even when no Modules are enabled, so that I can understand the Agent's current availability.
7. As a User, I want all application navigation and results confined to my private DM, so that my information is not exposed to colleagues.
8. As a User, I want clicking through menus to update the same message, so that navigation does not flood my DM history.
9. As a User, I want Back to menu in each Module menu, so that I can switch capabilities easily.
10. As a User, I want workflow results to offer a Menu button, so that I can continue from a completed task.
11. As a User, I want results and approvals preserved when I navigate, so that I do not lose their context or controls.
12. As a User, I want older menu buttons to recheck current state, so that stale messages cannot bypass changed availability or connections.
13. As a User, I want guidance when an older button refers to an unavailable Module, so that I can return to currently available actions.
14. As a User, I want existing commands to keep working, so that I can use shortcuts when I know them.
15. As a User, I want opening a Module menu to leave subsequent typed-message routing unchanged, so that a later message cannot silently go to the wrong Module.
16. As a User, I want a Mail Sorter menu with Sort inbox, Manage rules, Latest report and Gmail connection, so that I can find routine mail actions.
17. As a User, I want Gmail connection status and a Connect Gmail action when disconnected, so that I can resolve the sorting prerequisite.
18. As a User, I want Gmail authorization to use the existing Google sign-in and mailbox-confirmation flow, so that navigation does not change account ownership safeguards.
19. As a User, I want disconnect available through Gmail connection with its existing confirmation, so that account management is reachable without a command.
20. As a User, I want Sort inbox to begin preparing the existing latest-100-message Preview immediately, so that a clearly labeled click is enough to request work.
21. As a User, I want explicit approval before any proposed mailbox changes are applied, so that starting a sort does not authorize mutations.
22. As a User, I want Manage rules to show my saved rules and starter-rule option, so that I can inspect and maintain my sorting behavior.
23. As a User, I want Add rule and Edit controls to explain how to describe a rule using a `mail`-prefixed message, so that free-form input remains understandable and explicitly routed.
24. As a User, I want rule removal reachable from rule management and separately approved, so that routine management remains clickable without weakening the existing deletion safeguard.
25. As a User, I want rule Proposals and examples before approval, so that I can understand what will be saved.
26. As a User, I want Latest report to show my existing latest Report, so that reviewing results does not start another sort.
27. As a User, I want Details and eligible undo controls to remain attached to Previews and Reports, so that I can inspect and recover from the Agent's changes.
28. As a User, I want Pending approvals shown when there are eligible rule Proposals or sorting Previews, so that I can return to unfinished decisions.
29. As a User, I want reopening an approval to reuse the original Proposal or Preview, so that browsing does not regenerate work or extend its validity.
30. As a User, I want invalid or already resolved approvals to explain their state, so that an old button cannot apply unintended changes.
31. As a User, I want a Slack Unanswered menu with Find unanswered and Choose channels, so that I can manage and use that capability without remembering commands.
32. As a User, I want Slack Unanswered to work without Gmail, so that independent capabilities remain independent.
33. As a User, I want Choose channels to show a paginated list with visible selection status and Add/Remove controls, so that I can manage my sources within DMs.
34. As a User, I want channel-selection changes and pagination to update that list message, so that the current list remains easy to follow.
35. As a User, I want inaccessible selected channels retained with an explanation and Remove control, so that temporary access loss does not silently change my preferences.
36. As a User, I want Find unanswered to start the existing on-demand search immediately, so that one deliberate click starts useful work.
37. As a User, I want empty selections or unavailable access explained with a route to Choose channels, so that I can fix the prerequisite.
38. As a User, I want existing private results, source links, pagination and incomplete-results notices preserved, so that the new entry point does not alter search meaning.
39. As a User, I want browsing menus and reviewing saved state to perform no paid AI work, so that exploration does not consume the allowance.
40. As a User, I want Budget to show the existing shared allowance and module attribution, so that clicking into another capability cannot create a separate spending allowance.
41. As a User, I want repeated clicks during the same queued or running operation to report that work is in progress, so that I do not accidentally pay for duplicate runs.
42. As a User, I want navigation and the other Module usable during a long operation, so that starting work does not make the assistant unusable.
43. As a User, I want retries and restarts to retain operation identity and approval ownership, so that failures cannot repeat paid work or mailbox mutations blindly.

## Implementation Decisions

- Keep DM-only ingress. Do not introduce App Home, modal submissions, a website or remembered active-module routing. Preserve the existing explicit-routing and sanitized-message architectural decisions.
- Extend shared routing to recognize `menu`, supported plain greetings and explicit navigation actions. Reserve shared command/action identities against module collisions. The Help button shows useful guidance with a way back; it must not lead into a self-repeating menu action.
- Keep core responsible for shared navigation, enabled-module discovery, durable delivery and spending enforcement. Each Module owns its action descriptions, domain-aware menus, user-state queries and workflow behavior. Compose capabilities in the application layer; core must not query mail or Slack module tables.
- Extend the Messenger abstraction to support updating an identified Agent message as well as posting a new one. Preserve the distinction between menu updates and separate workflow Cards. A Menu button on a Report or approval opens a menu without replacing that Report or approval.
- Carry the authenticated DM message identity needed for updates through durable action jobs. Authorize update targets against the actor, workspace, DM and intended Agent-owned message; a timestamp, action namespace or button value alone is not ownership proof. Do not trust identifiers supplied by another user's controls.
- Use the same rendering and sanitization guarantees for new and updated messages. Preserve kind headers, readable fallback text, pagination, escaping and distinct action identifiers. Bound lists so Slack message limits never silently hide required controls.
- Keep shared Menu controls explicitly routable even when attached to a module-produced message; existing automatic module namespacing must not accidentally route them as module actions. Preserve exact legacy approval/action compatibility.
- Reuse existing module workflows for sorting, Proposals, connections, Reports, undo, channel selection and unanswered search. Navigation must not create an alternate approval or paid-execution implementation.
- Model navigation and work initiation as separate actions. Looking at a page, opening Pending approvals or reopening a saved item must not invoke classification or conversation AI. Explicit Sort inbox and Find unanswered actions remain subject to the existing shared and per-user allowance.
- Deduplicate operation starts atomically by owner, Module and operation while queued, running or retrying. Distinct clicks have distinct delivery identities, so event deduplication alone is insufficient. A click received during active work must remain a duplicate even if its response is processed after the original completes. This must work across workers and restarts, not through an in-memory flag or a button-only disabled state.
- Ending a scan with a Preview is distinct from applying it. This design does not impose a new ban on intentional later scans merely because a Preview is awaiting approval; preserve existing Preview validity checks. Completed or terminally failed operations must not leave a permanent busy state, and recovery must honor uncertain external outcomes.
- The current worker serializes all work for one owner across Modules. Implementation must deliberately address the approved responsiveness requirement rather than merely enqueueing menus behind slow provider calls. Any narrower locking or separate navigation handling must preserve domain mutation serialization, durable jobs, current-state validation and atomic spending reservations. Do not remove owner locking wholesale.
- Disabled Modules remain unconstructed and their saved work remains paused according to the existing extension contract. A fresh click on an old disabled-module control receives shared availability guidance without executing that Module.
- Treat missing rules, Reports, pending approvals and channel selections as useful empty states with appropriate navigation. Retain inaccessible selected channels without exposing newly inaccessible message content. Revalidate selectable-channel access and owner at mutation time.
- Reopened Proposals and Previews preserve original identifiers, versions, ownership, invalidation and recovery rules. Do not grant fresh authorization or validity merely by reposting a Card. Disconnect retains existing separate confirmation and Preview invalidation.
- Any new durable navigation or operation metadata must use idempotent migrations, owner-scoped access and the established retention/disabled-module rules. Keep shared delivery metadata separate from module-domain state. Exact tables and method names are implementation choices, not new product concepts.
- Update the authoritative behavior and extension/setup documentation when implementation lands, including new shared commands and Messenger/module contracts. Preserve existing environment and database volume. Record any consequential change to locking architecture with its rationale before claiming the implementation complete.

## Testing Decisions

Good tests exercise observable user behavior and safeguards, not private helper structure or snapshots that merely mirror the implementation. Prefer one primary boundary: signed Slack DM events and button requests through durable enqueue, routing, worker/dispatch and fake external providers, asserting the resulting private sends, updates and domain effects.

The test-boundary recommendation was presented to the user, who asked what previous development used. Inspection confirms that the channel-selection suite already exercises signed requests through the server, durable queue and worker with fake providers and an embedded database. That harness stubs advisory locks, so it cannot prove real lock behavior. Prior art also includes the module routing/dispatch suite, signed Slack security tests, mail workflow tests with fake Gmail and AI, message-rendering tests and a separate real PostgreSQL concurrency suite. Extend these harnesses rather than creating a second simulated application. Add focused provider-adapter tests only where the public harness cannot adequately verify message-update payloads or delivery failures. Use real PostgreSQL for actual lock and atomic admission guarantees.

Acceptance coverage:

1. A signed `menu`, `help` or supported greeting delivers a main menu privately; unknown input gets useful guidance and Menu access without an AI call. Enabled/disabled combinations, including no enabled Modules, render correctly.
2. Clicking either Module then Back updates the navigation message; workflow results and approval Cards remain unchanged. A Menu button on a result posts navigation separately. Two historical menu messages do not accidentally update each other.
3. Budget and Help are reachable by buttons. Existing module-prefixed commands, natural-language requests and exact legacy buttons retain behavior; unrelated unprefixed text never inherits the last selected Module.
4. Buttons route all approved Mail Sorter entry points through the real module handler. Empty and disconnected states offer appropriate next steps; connection and disconnect keep their confirmations.
5. Add/Edit rule controls explain the explicit-prefix input flow. Starter rules and removal preserve Proposal approval. Listing rules, Latest report and Pending approvals makes zero AI calls and does not change domain state.
6. Reopened pending items reuse original identity and validity. Cross-user, stale, invalidated, cancelled, already-approved and duplicate approvals cannot execute unauthorized or repeated effects. Details, cancellation and targeted undo retain existing safeguards.
7. Channel selection supports pagination, visible selection state, in-place Add/Remove updates and retained inaccessible selections. Another user's controls cannot list or mutate that user's selections. Shared access is rechecked; repeated deliveries do not repeat mutation or disclosure.
8. Button-triggered searches preserve rolling-window timing from the original work request, result groups, source links, privacy, pagination and no-Gmail independence. Exhausted AI allowance preserves existing deterministic fallback and incomplete-results notices.
9. Two distinct clicks while a sort/search is queued or running produce one operation and an in-progress response. Include simultaneous ingress, delayed duplicate processing after completion, separate workers, restart/retry and repeated clicks from different old menus. A deliberate click after completion can start fresh work.
10. Hold a fake provider call open and verify navigation can still return an updated menu and another Module remains usable, while conflicting domain mutations remain safe. Real PostgreSQL tests must demonstrate that the chosen execution design preserves owner isolation and prevents duplicate operation admission.
11. Menus, status displays and saved-item review work without paid AI availability. Concurrent Modules still share the same allowance; navigation never bypasses reservations or attribution.
12. Reject tampered signatures, other workspaces, public/group conversations, cross-user object IDs and unauthorized update targets. An old button after disablement/disconnection explains current availability and never starts prohibited work.
13. Fake Slack records both posts and updates. Check sanitization, kind headers, readable fallback text, bounded lists and unique action IDs. Definite rejection and uncertain delivery outcomes cannot cause blind repetition of paid work or mailbox changes; an unusable menu update leaves a safe recovery path via `menu`.
14. Existing queued work, approvals and module data survive schema upgrades; migrations are idempotent. Disabled jobs remain paused and cleanup preserves their required state.

For runtime implementation, verify Node satisfies the project requirement, then run the project's test, check and build scripts. Real PostgreSQL tests require `TEST_DATABASE_URL`; report skipped database checks separately from passes. Automated tests use fake Slack, Google and AI providers. A later release needs a real Slack DM smoke test for menu updates, navigation, list pagination and approval preservation; no live integrations are authorized or exercised by this specification task.

## Out of Scope

- App Home, external application dashboards, modal forms and public/channel-based interaction.
- New Modules, new classification behavior, scheduled processing, reminders or persistent Slack task tracking.
- Remembered active Module, AI-based routing and removal of explicit prefixes from conversational requests.
- Replacing free-form rule descriptions with a structured form builder.
- Relaxing approvals, ownership, undo, recovery, module enablement or spending safeguards.
- New automatic work merely from opening menus, browsing results or reconnecting navigation.
- Changing Gmail's required external authorization flow.
- Live credentials, Slack installation changes, deployment, purchases or production database operations.

## Further Notes

- The user confirmed the design after explicitly replacing the initial Home-tab proposal with DM-only navigation. The [interview record](interview.md) is historical decision context; the product specification is the authoritative contract.
- This document is published to the repository's local Markdown tracker with `ready-for-agent`; it does not require triage. The approved implementation is split into four tickets: [DM navigation and Gmail connection](issues/01-dm-navigation-and-gmail-connection.md), [Mail rules and saved work](issues/02-mail-rules-and-saved-work.md), [Slack channel management](issues/03-slack-channel-management.md), and [safe work launch](issues/04-launch-work-safely-from-menus.md). Each ticket records its own completion status; this full redesign is not yet complete.
- The spec intentionally records required concurrency and recovery outcomes without pretending a new persistence or locking design already exists. Implementation planning must account for those cross-cutting changes before calling this a menu-only presentation change.
