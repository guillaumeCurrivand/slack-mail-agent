# ClickUp module spec

Status: resolved (implemented locally; live release checks pending)
Category: enhancement

The User approved the complete design on 01/10/2026 and subsequently requested implementation. The Module is implemented locally; live setup/provider verification and deployment remain release work. This is the feature-tracker specification; the [ClickUp feature contract](../../docs/clickup.md) remains authoritative for current approved behavior and provider constraints. The [interview record](interview.md) preserves decisions and superseded alternatives.

## Problem statement

Users need a private view of the ClickUp tasks assigned to them in Mayasquad, accessible from the same Slack assistant they already use for Gmail. They should connect their own account and retrieve tasks without requiring Gmail, AI interpretation or manual searches across Lists.

## Solution

Add an independently enabled `clickup` Module. Each Slack User connects one personal ClickUp account through OAuth, validates access to the configured Mayasquad Workspace and confirms the authenticated identity in their private Slack DM. `clickup tasks` retrieves directly assigned tasks and subtasks, displaying a linked, paginated table. The first release is read-only.

## User stories

1. As a User, I can connect my personal ClickUp account and confirm its identity in Slack before activation or replacement.
2. As a User, I can request all eligible tasks assigned directly to me in Mayasquad, including subtasks and tasks shared with other assignees.
3. As a User, I can browse a table of linked tasks, their status, due date, priority, Workspace and List, ordered to show overdue work first.
4. As a User, I can page through one saved result and explicitly refresh it without overlapping scans or silently changing earlier pages.
5. As a User, I can distinguish a complete empty result from a retrieval failure, see partial results when available and retry.
6. As a User, I can disconnect after confirmation and prevent future use of my credentials and saved task results.

## Acceptance criteria

### Connection and ownership

- OAuth uses single-use, browser-bound invitation/state with encrypted owner-bound credentials; invitation/login state expires after 10 minutes.
- Connection requires the configured Mayasquad Workspace ID. Ignore additional OAuth-authorized Workspaces; never select another Workspace by name or as a fallback.
- Fetch the authenticated ClickUp identity. Do not infer identity by matching Slack/ClickUp email or accepting a typed assignee ID.
- Activation/replacement requires the initiating User's private Slack confirmation within 24 hours. A pending or failed replacement preserves the existing active connection.
- Each Slack User has one active personal account; the same ClickUp account cannot be activated for multiple Slack Users in the configured Slack workspace.
- Disconnect requires separate confirmation and removes active credentials, pending connection attempts and saved results. Provider-side revocation remains a separate User action.

### Task eligibility and completeness

- Include direct personal assignments, including assigned subtasks with another person's parent task and tasks with multiple assignees. Assignment solely through a ClickUp Team is excluded.
- Exclude Done/Closed status types and tasks individually marked archived. Do not exclude an unarchived task merely because its parent task, List, Folder or Space is archived.
- Apply no creation-date/due-date cutoff or silent task-count limit. Fetch every raw provider page before claiming complete coverage; local filtering cannot determine provider-page completion.
- Respect rate limits and retry temporary failures. Detect stalled pagination. Unknown archive metadata or retrieval failure produces incomplete coverage, never a misleading complete empty result.
- If some pages were retrieved before failure, show eligible retrieved tasks with an incomplete-results notice and Retry. The count is retrieved tasks, not a complete total.

### Private presentation and navigation

- Support `clickup tasks` and French `clickup tâches`/`clickup taches`, connection/disconnection/help shortcuts, and the private module menu defined in the [contract](../../docs/clickup.md#commands-and-menu-implementation-target).
- Use a Slack-native table with linked task name, original status, due date, priority, Workspace and List; eight tasks per page.
- Display due dates as dates only in Europe/Paris. Overdue means a displayed date before today. Sort overdue first, then upcoming dates, then undated tasks; break equal-date ties by task name.
- Preserve original names/statuses. Visibly abbreviate long task/List names with an ellipsis; the task link opens the full record. Application-owned text is French.
- Fetch fresh data per task request; page the saved result with its retrieval time. Refresh starts fresh retrieval. Overlapping typed/menu/Refresh starts reuse the active request and report status.
- Recheck access before showing each saved page; hide inaccessible tasks with a notice. Disconnect/account replacement invalidates old results. Otherwise retain the original snapshot.
- Results expire after 24 hours and cannot be revived by paging. Disabling the Module pauses jobs/physical cleanup without renewing logical expiry; cleanup resumes when enabled.
- Expiry/disconnect blocks future rendering and does not erase text already delivered in Slack.

## Implementation boundaries

Use [Adding a module](../../docs/adding-a-module.md), the [product specification](../../docs/product-spec.md#clickup-module-approved-target), [module architecture ADR](../../docs/adr/0002-private-assistant-modules.md) and [operation-admission ADR](../../docs/adr/0003-operation-admission-and-module-locks.md). Keep ClickUp configuration, OAuth routes, providers, domain state and retention within the Module; compose it in the application layer. Shared runtime remains independent of ClickUp/mail behavior. Register configuration only for the enabled Module. Preserve actor/DM/message ownership, durable operation admission and uncertain Slack-delivery recovery.

Task mutation, AI calls, scheduled scans, notifications, Team-derived assignments, task descriptions/comments/attachments and other Workspaces are outside this release.

## Verification

Test both public routing/dispatch and module workflows with fake ClickUp providers. Cover OAuth expiry/browser binding, account uniqueness and another User's controls; single-Workspace enforcement; direct/subtask/multiple-assignee eligibility; Done/Closed and individual archive exclusions; full raw pagination; table/ordering; overlapping starts; rate limits/partial failures; restart and uncertain-delivery recovery; access changes; result expiry; replacement/disconnect; and disabled-module behavior.

For runtime implementation, check Node against `package.json`, then run the relevant tests and `test`, `check`, `build`. Actual PostgreSQL locking tests require `TEST_DATABASE_URL`; report them as skipped when absent. Live API checks must validate archive-flag availability, active tasks in archived locations, provider pagination termination and shared/guest task access. These release checks are pending, as documented in the [contract](../../docs/clickup.md#implementation-and-release-verification).

## Live setup inputs

Obtain the confirmed Mayasquad Workspace ID, ClickUp OAuth application/client credentials and registered public HTTPS callback before live testing. Missing setup does not change the agreed single-Workspace behavior. This spec does not authorize provisioning or deployment.

## Comments

- 01/10/2026: The User confirmed the design with "Yes it does" after four interview rounds.
- 01/10/2026: Converted the original interview-only tracker file into this feature specification; history is preserved separately in `interview.md`.
