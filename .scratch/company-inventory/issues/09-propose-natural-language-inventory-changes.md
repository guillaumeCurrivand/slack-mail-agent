# 09: Propose natural-language inventory changes

**What to build:** A User can describe an individual inventory creation, edit, archive, or restoration conversationally, review the resolved target/values, and confirm it through the same workflow as a structured operation.

**Blocked by:** [06 — Archive and restore inventory records](06-archive-and-restore-inventory-records.md), [07 — Answer natural-language Project questions](07-answer-natural-language-project-questions.md).

**Status:** ready-for-human

**Specification:** [Documentation](../spec.md), especially natural-language edits, fixed fields, single-record scope, confirmation/overwrite, context, and spending.

## Acceptance criteria

- [x] Recognize `documentation`-prefixed requests to create, edit, archive, and restore each supported record type. Interpret them into validated individual-record operations and route them through the existing saved confirmation path; model confidence never applies a mutation.
- [x] Resolve the target, allowed fields, replacement values, and existing relationship references explicitly. Show these on the confirmation Card before any save. Use the private 30-minute Project context only when valid and unambiguous.
- [x] Clarify missing required information, ambiguous Projects/catalog references, or unclear replacement values. A nonexistent referenced catalog record requires a separate confirmed creation; the interpreter cannot silently create/link multiple records.
- [x] Unsupported fields and schema changes are explained using the fixed field set. Bulk requests ask the User to choose an individual-record operation. Account/access information stays within the agreed instructions/reference/link scope; permanent deletion and restoring earlier values directly from history remain unavailable.
- [x] Confirmations remain actor-bound, exact-operation-bound, and valid for 24 hours. Confirmed selected fields overwrite intervening edits while preserving unrelated fields and logging actual prior values. An archived edit target requires explicit restoration; interpreting a request cannot bypass it.
- [x] Natural-language and structured paths share validation, commit/history atomicity, effect deduplication, expiry, and recovery rather than introducing a second mutation implementation. Confirmation and result paging do not incur another interpretation call.
- [x] Paid calls use the existing shared budget and durable attempt checkpoints. Provider/key/budget failure offers structured alternatives without changing records or inventing a resolved proposal. Treat record text and model output as untrusted data, not action authorization.
- [x] Result Cards accurately report creation/edit/lifecycle outcomes and link to the affected record/history; navigation preserves the saved confirmation and result identities.

## Verification and delivery

- [x] Exercise natural-language requests and subsequent actions through public routing/dispatch with fake AI/messaging for every operation/type, ambiguity, invalid/foreign references, multi-record requests, prompt-injection text, cross-user approval, expiry, overwrite races, archived targets, budget exhaustion, restart, and duplicate confirmation after a later edit.
- [x] Follow the [implementation and verification requirements](../spec.md#implementation-and-verification-requirements), update examples and help, run project checks, and review the complete diff. Prepare consented/synthetic live-quality cases without claiming fake-provider tests prove model accuracy or authorize production mutations.

## Comments

Approved as ticket 09. Does not depend on inventory filter/count questions in 08 or import in 10.

Implemented locally on 2026-09-30. All six inventory kinds accept constrained conversational create/edit/archive/restore plans through the existing structured proposal, confirmation and atomic commit/history/effect path. Exact workspace references and copied replacement text are validated before a saved confirmation; private Project context and explicit field/clearing/numeric/boolean intent are checked conservatively. Model confidence or action flags cannot authorize a mutation. Result controls preserve saved identities and open separate record/history navigation. History distinguishes natural-language sources.

Local verification: Node v25.8.1 satisfies package engines. The final full suite passed 222 tests; 18 real PostgreSQL locking/concurrency tests were skipped because TEST_DATABASE_URL was not set. TypeScript check and build passed. Standards and Spec reviews have zero outstanding findings after fixes for reduced bulk proposals, implicit clears, lifecycle-shaped conversational routing, exact free names and short-alias token boundaries. Complete intended diff and local Markdown links were reviewed. Signed public ingress/registry/dispatch tests use fake AI/Slack and cover every operation/type, context, ambiguity, missing/foreign references, literal injection text, cross-User/DM controls, expiry, overwrite, archived targets, history rollback, spending, restart and uncertain delivery/replay.

Prepared [synthetic live-quality cases](../../../docs/testing/documentation-natural-language-changes.md); no live Slack/OpenAI evaluation, model-accuracy claim, production deployment or real import occurred. This ticket remains ready-for-human for live release checks. No new required environment variables, secrets or permissions; startup adds source and resolved-command columns idempotently, with no manual migration. Use the [deployment handoff](../../../docs/deployment.md#documentation-natural-language-changes-release-candidate) after pushing the reviewed main commit.
