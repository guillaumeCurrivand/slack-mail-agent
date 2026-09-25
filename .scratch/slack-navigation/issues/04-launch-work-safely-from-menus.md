# 04: Launch work safely from menus

Status: ready-for-agent

**What to build:** A User can click Sort inbox or Find unanswered to start existing work immediately, receive separate private results, and continue navigating or using the other Module. Repeated clicks during active work report that operation instead of starting duplicate paid work.

**Blocked by:** [01: DM navigation and Gmail connection](01-dm-navigation-and-gmail-connection.md), [03: Slack channel management](03-slack-channel-management.md).

**Specification:** [Clickable navigation in private Slack DMs](../spec.md). User stories 20–21, 36–43 and the launch/result portions of 10–16, 31–32; acceptance coverage 8–10 and the execution/security/migration portions of 11–14. Ticket 02 is independent because existing mail workflows already create and handle Previews and Reports.

## Acceptance criteria

- [ ] Sort inbox and Find unanswered are live buttons in their Module menus and start their existing workflow without another start confirmation. Missing Gmail or channel selections produce actionable connection/channel guidance. Recheck prerequisites at execution time.
- [ ] Sorting still prepares the latest-100-message Preview. Applying mailbox changes requires approval bound to the original Preview and User. Preserve Details, cancellation, Reports, targeted undo and partial/uncertain mutation recovery.
- [ ] Unanswered searches retain the original request time for the rolling window, existing matching and response rules, result grouping, source links, pagination, inaccessible-channel notices and deterministic fallback with an incomplete-results notice when paid AI is unavailable.
- [ ] Work results and approval requests arrive as separate private Cards with Menu access. Navigation does not replace these Cards or remove existing workflow controls. No unsolicited scan occurs when menus or saved items are opened.
- [ ] Atomically admit at most one active operation per owner, Module and operation while queued, running or retrying. Distinct click identities, old menus and duplicate Slack deliveries cannot bypass this. Reuse the same admission rules for equivalent existing typed work requests so mixed command/button entry does not bypass the safeguard.
- [ ] A click received during active work remains associated with that operation even when its response is processed after completion. Report the existing request as in progress when applicable without another paid run. A deliberate request received after completion can start new work.
- [ ] Active-operation identity and checkpoints survive worker restarts and retries. Completion or terminal failure does not leave a permanent busy state; uncertain outcomes are reconciled without blindly repeating paid calls or mailbox mutations. A saved Preview awaiting approval is not itself an active scan.
- [ ] With a provider call held open, menu navigation still returns and the other Module remains usable. Address the existing whole-owner worker lock deliberately: preserve safe ordering of conflicting domain mutations, actor isolation, durable jobs and disabled-module pausing instead of simply removing the lock.
- [ ] Concurrent work retains one shared spending allowance, per-user controls, reservations and module attribution. Navigation/status review uses no paid AI. Repeated attempts cannot evade reservations or pay twice for checkpointed work.
- [ ] New operation metadata is durable, owner-scoped, migrated idempotently and cleaned according to existing retention and disabled-module rules. Upgrades preserve queued jobs, approved rules, saved Previews and action records.
- [ ] Old buttons after disconnect/disablement cannot execute prohibited work. Signed action/update authorization, explicit typed routing and exact legacy approval controls remain compatible.

## Implementation boundaries

Reuse existing module domain workflows. Shared runtime may own generic admission/scheduling/delivery mechanisms but must not absorb mail rules, credentials, tables or Slack matching behavior. Keep any necessary prefactoring additive before using it. Record the rationale for a consequential locking/scheduling change in an ADR and update the module guide to match the implemented contract.

This is the largest approved slice. Keep it bounded to the two existing work operations and their navigation responsiveness; do not add a new general workflow platform, scheduler or module system.

## Verification and delivery

- [ ] Exercise signed button and equivalent typed requests through durable enqueue, worker/dispatch, actual Module handlers and fake Slack, Gmail and AI providers. Assert separate result Cards, Menu actions and unchanged workflow safeguards.
- [ ] Test simultaneous starts, different old menus, mixed button/command requests, duplicates delayed until after completion, retries, restarts, terminal failure and a valid new operation after completion. Verify one paid operation rather than merely one rendered response.
- [ ] Extend real PostgreSQL tests to prove atomic operation admission across workers and the chosen lock behavior. Hold fake provider calls open to verify navigation and the other Module proceed while conflicting mutations remain safe; retain concurrent shared-budget reservation tests.
- [ ] Test no Gmail, no channels, provider/budget exhaustion, disabled Modules, cross-user IDs, invalid signatures, stale actions, approval replay and definite/uncertain Slack delivery failures. Verify migration idempotency and preservation of disabled queued work.
- [ ] Update authoritative behavior, extension and operational documentation for the implemented work flow. Do not mark the entire redesign complete if independent ticket 02 remains unfinished.
- [ ] Check Node compatibility; run relevant tests and project `test`, `check` and `build`. Real PostgreSQL tests require `TEST_DATABASE_URL`; if unavailable, report them as skipped and identify the concurrency claims still unverified, separately from passing fake-provider tests.
- [ ] Review the full intended diff. Report local/committed/pushed state, commit identifier if committed, and live integrations not exercised. No live setup or deployment is authorized by this ticket. A release handoff must include the target branch/commit, confirmed-server fetch/rebuild/restart commands, required environment/migration changes or explicitly none, and post-deploy checks. Claim production success only after observing it.

## Comments

Approved as ticket 4 of the four-ticket breakdown. Ticket 01 is listed explicitly as an approved prerequisite even though ticket 03 also depends on it. Ticket 02 can finish before or after this slice; all four tickets must be complete before presenting the full redesign as implemented.
