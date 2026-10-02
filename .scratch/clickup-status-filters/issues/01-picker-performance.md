# Fix slow status discovery and unresponsive draft controls

Status: ready-for-human
Category: bug
Date: 02/10/2026

The User reports twelve pages of statuses in production, very slow Choisir les statuts loading and Retirer failing to work. Implementation is locally complete; deployment and live checks remain operator work. The [ClickUp contract](../../../docs/clickup.md#personal-status-filters) owns the current behavior.

## Reproduction and diagnosis

The deterministic public-dispatch loop is `npm test -- tests/clickup.test.ts -t "twelve-page|Retirer change"`. Before the fix, 120 independent List definitions ran with peak concurrency 1 and took 3748 ms with 20 ms fake latency per read. A saved two-minute cooldown left Retirer unchanged and replaced its controls with Retry/Menu. Both tests failed. The discovery failure remained with only two independent List reads; the editing failure needs only one existing editor and cooldown.

Confirmed local causes: hierarchy reads were serial; every draft edit made live identity/Workspace calls; reopening repeated complete discovery; rate-limit handling slept inside the owner/Module job. The provider documents token-specific rate limits and 429/reset headers in [its official guide](https://developer.clickup.com/docs/rate-limits). No production logs or live credentials were inspected, so the reproduced mechanisms are not a claim that production cooldowns were directly observed.

## Fix and safeguards

- Read independent discovery steps with bounded concurrency 4. Preserve successful/failed/unread work, return after the eight-second attempt budget or a provider cooldown, and never silently cap catalogue coverage.
- Reuse complete definitions verified within five minutes from existing editors, scoped to User/DM/Workspace/current connection. Preserve the original verification timestamp. Load preferences/version freshly and offer Actualiser les statuts; incomplete discovery remains resumable through Retry.
- Keep draft paging/Add/Remove/Reset/Cancel local with existing ownership, message, connection and expiry checks. Opening, Save and catalogue refresh retain live account/Workspace checks with a five-second budget. Rejected Save attempts checkpoint their rejection for delivery recovery; no later replay can become approval of changed draft values.
- Concurrent cooldown responses cannot shorten the active connection's longest retry deadline. Save/version/effect atomicity, unavailable-name retention, default/custom semantics and task snapshots remain unchanged.
- No additional tables, manual migration, environment variables, permissions, AI or external mutations. Old editors without checkedAt miss the cache and retain their original expiry.

## Verification and delivery

The original 120-List fixture completes in 941 ms with peak concurrency 4 after the fix (historical fake-provider measurement, approximately 4× faster). Local edits perform zero provider reads; warm reopening performs only the two required live identity/Workspace reads. Temporary measurement logging is removed; regression tests assert fanout, full coverage and behavior instead of flaky elapsed-time thresholds.

Local verification on 02/10/2026: the focused ClickUp suite passes 41 tests, including cooldown editing, cache/restart/refresh/expiry, immediate rate-limit deferral, stalled-request cancellation/Retry, monotonic concurrent cooldowns and rejected-Save replay. The complete suite passes 315 tests; 24 real PostgreSQL tests are skipped because TEST_DATABASE_URL is unset. Node v25.8.1 satisfies >=24; TypeScript check and build pass. Standards and Spec reviews each report zero findings. Documentation links/anchors and the complete intended diff pass inspection. No live production verification or deployment has occurred. Use [the deployment procedure](../../../docs/deployment.md#clickup-release-candidate) after the fix is committed and pushed.
