# ClickUp personal status filters

Status: ready-for-human
Category: enhancement

Date: 02/10/2026.

The User confirmed the complete design in question 11: "I confirm this is what I want," then invoked the implement skill. The [ClickUp feature contract](../../docs/clickup.md#personal-status-filters) owns the approved behavior; the [interview](interview.md) preserves the decisions and provider investigation. Implementation is complete locally; live provider/Slack verification and production deployment remain operator work. The interview itself changed documentation only.

## Problem and scope

Each User needs a private status-name selection for their assigned ClickUp tasks in Mayasquad, edited through `clickup statuts` / `clickup statuses` and the Module menu. The User reports that the existing task command works well.

Implement the contract's [preferences and selection](../../docs/clickup.md#preferences-and-selection), [discovery and unavailable-status handling](../../docs/clickup.md#discovery-and-unavailable-statuses), and [saving/snapshot safeguards](../../docs/clickup.md#saving-and-task-snapshots). Personal List-specific discovery is deferred. Task mutations, AI, schedules, notifications, other Workspaces and location-specific filters remain outside this feature.

## Implementation boundaries

- Follow [Adding a module](../../docs/adding-a-module.md), the [product specification](../../docs/product-spec.md#clickup-module-approved-target) and existing personal ownership/operation-admission architecture.
- Keep providers, discovery, status matching, durable preferences, editor drafts, conflict versions and replay checkpoints inside ClickUp. Register deterministic command aliases in the application layer. Shared runtime remains independent of ClickUp domain semantics.
- Preserve raw task-pagination completion, current table/ordering/access checks and scan recovery. Capture the applied filter in each new scan, including default mode; account for pre-extension saved scans when preserving compatibility.
- Separate durable preferences from connection credentials and expiring editor/snapshot metadata. Use module-owned, User/Workspace-scoped persistence with idempotent startup and atomic save/version/effect changes.
- Support the full catalogue without silently truncating UI options. Existing paginated authenticated controls can support draft multi-selection without requiring native multi-select; any shared ingress/rendering change needs its public-path checks.
- Preserve the unrelated documentation edits already present. After implementation, update the contract's delivery status, README availability and the [deployment guide](../../docs/deployment.md#clickup-release-candidate) around the actual schema/environment/release changes. Do not describe approved target behavior as delivered before verification.

No ADR was needed: these reversible preferences extend the existing Module and personal ownership architecture.

## Verification

Exercise public routing/dispatch and ClickUp workflows with fake providers. Cover:

- User isolation; French/English commands and menu controls; wrong User/DM/message/connection controls.
- Unused/inherited/custom/shared/archived-location statuses; same-name deduplication; complete catalogue traversal and UI coverage.
- Default/custom/reset behavior; explicit Done/Closed selections; direct/subtask/multiple-assignee eligibility and individual archive exclusion.
- Draft selection and save/cancel; empty-selection validation; unavailable names; outdated editors; duplicate events and delivery recovery.
- Partial catalogue failure blocking save while preserving preferences and task retrieval; retries and rate-limit handling.
- Reconnect/account replacement/disabled-module preference retention; frozen filter summaries in task snapshots; restart and raw-pagination recovery.

Check active Node against `package.json` before scripts. Run relevant tests and the project's `test`, `check` and `build` for runtime changes. Real PostgreSQL locking/concurrency tests require `TEST_DATABASE_URL`; report skips separately.

Live provider checks must validate archived collection semantics, complete inherited status definitions for shared-only child access, task-only access gaps, unused-status coverage, status-name matching/case behavior, complete traversal and rate-limit handling. The contract's [provider references](../../docs/clickup.md#verified-provider-constraints) distinguish documentation facts from observed behavior.

## Historical design delivery record

The approved contract, glossary, README/product links and historical interview are saved locally on main. Local documentation links/anchors and whitespace were checked. Runtime tests and live integrations were not exercised because this work changes documentation only.

There are no environment or database migration changes in this documentation update. Once committed and pushed, pulling that documentation commit is sufficient; no app restart is required. A later runtime implementation needs the repository's full release handoff and post-deploy checks. This tracker does not authorize provisioning or production deployment.

## Implementation delivery record

Implemented on the existing main branch with ClickUp-owned progressive status discovery, durable personal preferences, 30-minute draft editors, atomic version/effect checkpoints and per-scan filter snapshots. English/French commands and menu controls share the private routing/dispatch path. No external writes, AI, new environment variables or scopes are added. Enabled startup creates the three status-filter tables idempotently; no manual migration is required. Existing scans without a captured filter keep the original default.

Local verification on 02/10/2026: Node v25.8.1 satisfies the required >=24 engine. The complete suite passes 308 tests with 24 real PostgreSQL tests skipped because TEST_DATABASE_URL is unset, including the ClickUp ownership/preference-race test. After review fixes, the focused ClickUp suite passes all 34 tests again; final TypeScript check and build pass. Standards review found French count formatting and an unused checkpoint column; both are fixed and re-reviewed with zero outstanding findings. Spec review reports zero findings. Feature-document local links/anchors and the complete intended staged diff are checked. No live ClickUp/Slack integration or production deployment is exercised. Unrelated working-tree documentation edits remain outside the feature commit. Use [the release procedure](../../docs/deployment.md#clickup-release-candidate) after the reviewed commit is pushed.
