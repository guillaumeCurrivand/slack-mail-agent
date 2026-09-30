# 05: Manage Tools and their usage

**What to build:** A User can maintain Tools with their usage, referents, and Project relationships, including company-wide Tools, then browse the same information from any permitted Documentation interaction.

**Blocked by:** [02 — Edit Projects with overwrite and history](02-edit-projects-with-overwrite-and-history.md).

**Status:** ready-for-human

**Specification:** [Documentation](../spec.md), especially Tool fields, relationships, shared access, and confirmation/history rules.

## Acceptance criteria

- [x] Provide paginated Tool browsing, exact lookup, details, Add/Edit instructions, and structured creation/editing for name, category, usage, referent, Project links, and notes.
- [x] A Tool can be company-wide, linked to one or more existing Projects, or both. Unknown usage/referents remain unknown; no Project relationship is invented merely because a usage description contains unmatched text.
- [x] Project and Tool details allow navigation between their saved relationships. Stable identifiers preserve links through renames. Clarify ambiguous references and require a separate confirmed creation for missing Projects.
- [x] Referent information is descriptive inventory data and does not give exclusive edit authority, trigger notifications, or add a company-membership check. Existing bot/workspace access determines shared inventory access.
- [x] Structured creation and editing require no AI and affect one record per actor-bound 24-hour confirmation. Reuse the chosen overwrite policy, preservation of unrelated fields, atomic actual-before/after history, and duplicate/restart recovery.
- [x] Fixed fields and system metadata retain their boundaries. Another User can view/edit a Tool through their own confirmation, but cannot approve someone else's pending operation or rewrite history.

## Verification and delivery

- [x] Exercise public routing/dispatch and controls with fake messaging for company-wide usage, multiple Project links, missing/ambiguous references, rename preservation, shared access, cross-user confirmation attempts, expiry, replay, and history. Verify no AI calls for these operations.
- [x] Follow the [implementation and verification requirements](../spec.md#implementation-and-verification-requirements) and repository checks/delivery rules; update menu/help and delivered behavior, review the complete diff, and identify skipped PostgreSQL checks and live integrations not exercised.

## Comments

Approved as ticket 05. This may proceed alongside 03–04 after 02 is complete.

Implemented locally on 2026-09-30. The [Documentation contract](../../../docs/documentation.md#delivered-locally--ticket-05) records Tool browsing, exact lookup, structured creation/edits, company-wide usage, descriptive referents, stable Project links and reciprocal navigation. Existing confirmation, overwrite/history and replay safeguards are reused. No production deployment, AI work or data import was performed.

See the [deployment guide](../../../docs/deployment.md#documentation-tools-release-candidate) for automatic constraint migration, preserved environment/volume, server commands and post-deploy checks. This is a local release candidate; production and live Slack verification remain outstanding.

Local verification: Node v25.8.1 satisfies >=24. The full npm test suite passed 171 tests; 12 real PostgreSQL tests (including Tool cross-User overwrite/duplicate-confirmation locking) were skipped because TEST_DATABASE_URL was not configured. npm run check and npm run build passed. After review removed duplicated saved-reference validation, all 35 Documentation tests and check/build passed again. Fifty local documentation file links and git diff --check passed. Tests use signed fake Slack ingress/public dispatch and cover company-wide usage, multiple Project links, missing/ambiguous/foreign references, rename preservation, shared access, private controls, cross-User approval attempts, expiry, actual overwrite history, unrelated fields, rollback, satisfied outcomes, delivery failures and duplicate/restart replay. No live Slack/Gmail/OpenAI integrations were exercised.

Final review against starting commit 881c673ee22367c8b18adc3ac5cb44f98037a56a: Standards — 0 documented violations and 0 remaining actionable smells; Spec — 0 findings. The two axes were reviewed independently. Work is committed locally on main; pushing and deployment are outside this ticket. Pre-existing CONTEXT.md changes and tickets 06–10 are excluded.
