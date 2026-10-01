# ClickUp module — approved feature contract

Status: target behavior approved by the User on 01/10/2026 after the design interview. Implemented locally and opt-in; live integration/provider completeness and deployment remain unverified. Approval of this contract does not authorize provisioning or deployment.

This document is authoritative for ClickUp's approved target behavior. The [product specification](product-spec.md) owns assistant-wide safeguards; [Adding a module](adding-a-module.md) and [ADR 0002](adr/0002-private-assistant-modules.md) govern extension and routing. The [tracker spec](../.scratch/clickup/spec.md) defines the implementation work; the [interview record](../.scratch/clickup/interview.md) preserves the design history.

## Approved behavior

- Add an independently enabled ClickUp Module with per-User OAuth connection, similar to Gmail's connection experience but independent of Gmail.
- First release provides connection management and read-only assigned-task listing. No task mutations, AI calls, scheduled scans or notifications.
- The canonical typed request is `clickup tasks`; the existing French-interface contract requires a French alias and French application-owned presentation.
- Include currently assigned tasks without creation-date or due-date cutoff; exclude completed tasks (both Done and Closed status types) and tasks individually marked archived.
- Include directly assigned subtasks even when their parent belongs to someone else, and tasks with multiple assignees when the User is among them.
- Search only the Mayasquad ClickUp Workspace, identified by one configured stable Workspace ID. Connection requires access to that ID. Ignore additional OAuth-authorized Workspaces, with no fallback or matching by name. Include only direct personal assignments, not assignment solely through ClickUp Teams.
- Check the task's own archive state only. An archived parent task, List, Folder or Space is not itself grounds for excluding an unarchived assigned task. Additional Lists do not affect this rule.
- One active personal ClickUp account per Slack User. The same ClickUp account cannot be shared between Slack Users within the configured Slack workspace. Do not require matching Slack and ClickUp email addresses.
- Activation/replacement requires a final owner-bound Slack confirmation showing the authenticated ClickUp identity. Disconnect requires separate confirmation.
- Display a table with linked task name, original status, due date, priority, Workspace and List; eight tasks per page with Previous/Next controls. Show due dates as dates only in Europe/Paris; overdue means a displayed date before today. Sort overdue first, then upcoming due dates, then undated tasks; break equal-date ties by task name. Visibly shorten long task/List names with an ellipsis; the task link opens the full ClickUp record.
- Each `clickup tasks` request fetches fresh data; paging uses its saved result and displays retrieval time. Refresh starts a new retrieval. Saved results expire after 24 hours.
- Recheck task access before displaying each saved page; hide inaccessible tasks with a notice. Disconnect or account replacement invalidates old results. Otherwise preserve the original snapshot and retrieval time.
- Overlapping task requests/Refresh reuse the active request and report its status. Retrieve every provider page without silently truncating the task count; stalled pagination produces incomplete coverage.
- If retrieval fails after some pages, show retrieved eligible tasks with a prominent incomplete-results notice and Retry control. The count represents retrieved tasks, not a complete total. Never report a complete empty list after a failed retrieval.
- Confirmed disconnect removes active credentials, pending connection attempts and saved task results. OAuth links expire after 10 minutes; final Slack connection confirmations expire after 24 hours. Results become unreadable after 24 hours even when disabled; physical cleanup pauses while disabled and resumes when enabled. ClickUp-side revocation remains a separate User action.

## Verified provider constraints

- OAuth lets the User authorize one or more ClickUp Workspaces; the token cannot bypass their task access. The documented token currently does not expire, and the public flow does not document granular read-only scopes, PKCE or Gmail-style refresh tokens. Application read-only scope does not imply a provider-enforced read-only token. [ClickUp authentication](https://developer.clickup.com/docs/authentication)
- Use the [authenticated ClickUp user](https://developer.clickup.com/reference/getauthorizeduser) to identify the assignee, and discover [authorized Workspaces](https://developer.clickup.com/reference/getauthorizedteams). Do not infer identity from matching Slack and ClickUp email addresses.
- [Filtered Workspace tasks](https://developer.clickup.com/reference/getfilteredteamtasks) support assignee filters, subtasks and zero-based pagination of at most 100 tasks per page. Their official response schema does not document a terminal-page flag. Completion detection must use raw provider pages, not pages after module filtering, and must be validated live.
- ClickUp distinguishes Done from Closed; completed-task exclusion must check both `done` and `closed` status types rather than customizable status names. [Task statuses](https://help.clickup.com/hc/en-us/articles/6309452618647-Manage-task-statuses)
- The [official OpenAPI specification](https://developer.clickup.com/openapi/clickup-api-v2-reference.json) shows task archive flags in examples, but the Workspace response schema omits that flag. It does not establish whether all active tasks in archived locations are returned. The task-only archive policy is settled; provider completeness still needs live validation. Never treat unknown task archive state as verified active state.
- Task reads supply Unix-millisecond due dates but do not reliably distinguish explicit deadline times from ClickUp's date-only encoding at 04:00 in the original setter's timezone. The approved design displays the Paris calendar date only; it does not promise recovery of the original setter's date-only timezone semantics. [Date formatting](https://developer.clickup.com/docs/general-time)
- Respect token-specific [rate limits](https://developer.clickup.com/docs/rate-limits). Inaccessible Workspaces, revoked authorization and incomplete retrieval must not be represented as a complete empty list.

Provider facts verified against official documentation on 01/10/2026; no live ClickUp account was exercised.

## Extension and ownership requirements

- Implement a built-in `clickup` Module with module-owned providers, configuration, OAuth routes, credentials and result storage, composed in the application layer. Shared runtime remains independent of ClickUp and mail behavior.
- Preserve signed Slack ingress, configured Slack-workspace validation and private actor/DM/message ownership checks. Another User's controls cannot connect an account, display results or disconnect it.
- Follow existing single-use OAuth invitation/state and browser-binding safeguards with encrypted owner-bound credentials. Use ClickUp's documented flow and authenticated-user endpoint; do not assume Google-specific PKCE, OIDC or hosted-domain guarantees.
- Serialize OAuth state transitions with the owner/Module worker lock. Keep provider calls outside the local transaction; validate the authorization generation again before committing credentials. Activation/disconnect advance that generation, so an in-flight callback cannot recreate a cancelled attempt even across a connect/disconnect cycle. Save pending credentials and their confirmation-delivery job in one transaction.
- Before activation/replacement, validate authenticated ClickUp identity and Mayasquad access. Pending, rejected or failed replacement does not silently replace the existing active connection.
- Connect/disconnect and task retrieval are available through the private Module menu as well as deterministic prefixed commands. The main menu hides the disabled Module. Navigation does not remember an active Module and invokes no AI.
- Task starts from commands, menu and Refresh share owner/Module operation admission. Preserve durable checkpoints and Slack delivery recovery; retries cannot blindly duplicate delivered result messages. Pagination never starts another scan.
- Disabling ClickUp pauses its jobs and physical cleanup while preserving saved state. Logical OAuth/confirmation/result expiry remains enforced after re-enablement. Expired controls cannot revive credentials or old snapshots.
- Saved snapshots contain only fields required for the approved listing and private controls. Task descriptions/comments/attachments are outside the first-release request. Local credential deletion does not promise deletion from historical backups or revocation of the provider's grant.
- Expiry, lost access and disconnect block future snapshot rendering; they do not erase task text already delivered in Slack. Slack and backup retention remain separate from active application-record retention, as in the product specification.

## Commands and menu (implementation target)

- `clickup tasks` / `clickup tâches` (also accept `clickup taches`): retrieve assigned tasks.
- `clickup connect` / `clickup connecter`: obtain the private OAuth invitation.
- `clickup disconnect` / `clickup déconnecter`: request separately confirmed disconnect.
- `clickup help` / `clickup aide`: connection status and module guidance.
- Module menu: connection status, Connect or confirmed Disconnect, Tasks when connected, and Back to the main menu. Results offer Previous/Next as applicable, Refresh, Retry when incomplete, and Menu.

These command spellings apply the existing deterministic routing and French-interface contract; they introduce no natural-language interpreter.

## Implementation and release verification

Implementation exercises public routing/dispatch and module workflows with fake ClickUp providers in `tests/clickup.test.ts`. Coverage includes identity mismatch/ownership, single-Workspace enforcement, expired OAuth/browser state, account uniqueness, replaced/disconnected connections, Done/Closed exclusion, individually archived tasks, subtasks/multiple assignees, complete raw-provider pagination, duplicate starts, permission changes, persisted rate-limit cooldowns, partial failure, expiry and uncertain Slack delivery. `tests/postgres-clickup.test.ts` separately covers actual PostgreSQL concurrent external-account ownership. Check the active Node version before running project scripts; run `test`, `check` and `build` for runtime changes. Report actual PostgreSQL concurrency tests separately when `TEST_DATABASE_URL` is absent.

Live verification must establish task archive-flag availability, coverage of active tasks in archived locations, page termination and shared/guest task access. Missing provider metadata must produce incomplete coverage rather than an unsupported claim of completeness. Configure the OAuth application and confirmed Mayasquad Workspace ID before live testing. No real OAuth setup, external messages, paid calls or deployment occurred in this interview.

## Delivery and setup status

The interview is complete and the User confirmed the full shared understanding, then requested implementation. The runtime Module is implemented locally under `src/modules/clickup/`, composed in `src/app/modules.ts` and enabled only with `ENABLED_MODULES` containing `clickup`. Its startup creates module-owned connection, authorization-generation, OAuth state, confirmation/effect-checkpoint, scan and rate-limit tables. Generation records contain no credentials and persist across disconnect to invalidate in-flight authorization attempts. No existing module tables or mailbox data are changed; no manual migration is needed. Implementation does not establish live API completeness, OAuth setup or production deployment.

The confirmed Mayasquad Workspace ID is still a setup input. No ID was found in nonsecret repository source/documentation; obtain it from the Workspace's normal ClickUp URL or authorized-Workspace response, rather than selecting by name. Live setup also requires the ClickUp OAuth application, client credentials and registered HTTPS callback. Module-specific configuration is read only when ClickUp is enabled, preserving independent startup without Gmail. Use [README setup](../README.md#clickup-setup) and the [release procedure](deployment.md#clickup-release-candidate).
