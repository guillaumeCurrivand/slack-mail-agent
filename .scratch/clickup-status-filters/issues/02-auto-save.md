# Save personal status changes automatically

Status: ready-for-human
Category: enhancement
Date: 02/10/2026

The User requests: "I dont see the enregistrer button, can't it save automatically when i add/remove ?" This overrides the historical draft/Save/Cancel interaction. The [ClickUp contract](../../../docs/clickup.md#personal-status-filters) owns current behavior.

## Reproduction and scope

The public-dispatch regression command is `npm test -- tests/clickup.test.ts -t "automatically persists"`. Before the fix, removing Unused, closing and reopening after process reconstruction renders Retirer Unused instead of Ajouter Unused. The minimal case requires one connection, picker and removal. The old implementation only saved explicitly; Enregistrer was omitted for incomplete discovery, leaving no way to commit then.

- Persist each Add/Remove/reset immediately and keep the picker usable. Close or leaving does not undo successful changes; no Enregistrer button is needed.
- Keep local controls responsive during cooldowns with zero provider reads. Preserve ownership/DM/message/current-connection/expiry safeguards.
- Commit preference, advancing editor version and replay checkpoint atomically. Reject another editor's stale version and checkpoint rejected last-custom-choice removal.
- During incomplete discovery, modify only an explicit name in an existing custom selection. From default, save inclusions/exclusions without dropping unfinished statuses that have not loaded. Preserve this visible default mode through Retry and later discovery; reset clears exceptions.
- Preserve prior filter snapshots and explicit completed-status inclusion. Do not implicitly commit unsaved legacy drafts; retain compatibility for already-posted legacy Save controls.
- No AI, external task mutations, new secrets, permissions, tables or manual migrations.

## Verification and delivery

Local verification on 02/10/2026: Node v25.8.1 satisfies >=24. All 45 focused ClickUp tests pass, including reopening/restart, partial-discovery preservation, local cooldown saving, rejected/successful action replay, stale editors, immediate reset, legacy controls and frozen task snapshots. The complete suite passes 319 tests; 24 real PostgreSQL tests are skipped because TEST_DATABASE_URL is unset, including the updated concurrent-autosave race. TypeScript check and build pass. Standards and Spec reviews each report zero findings. The complete intended staged diff and documentation local links are checked; unrelated workspace edits remain outside this change.

Deploy through [Updating production](../../../docs/deployment.md#clickup-release-candidate) after the reviewed main commit is pushed. Preserve environment, encryption key and database volume; stop old workers before starting the new image. No environment, secret, scope, table or manual migration changes are required. No production deployment or live Slack/ClickUp integration has been observed for this change.
