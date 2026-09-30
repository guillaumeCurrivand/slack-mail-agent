# 07: Answer natural-language Project questions

**What to build:** A User can ask Documentation where a Project is hosted or which Technologies it uses, receive answers grounded in current records, and make unambiguous follow-ups using a private 30-minute Project context.

**Blocked by:** [04 — Manage Hosts/services and Hosting entries](04-manage-hosts-services-and-hosting-entries.md).

**Status:** ready-for-human

**Specification:** [Documentation](../spec.md), especially natural-language answers, context, sources, and spending/availability.

## Acceptance criteria

- [x] `documentation`-prefixed Project questions select supported, validated read operations over current records. Answer hosting and Technology questions without executing model-generated arbitrary SQL or performing mutations.
- [x] Answers show the relevant Components and environments with production first, explicit unknown fields, record-detail controls/stable source identifiers, and relevant saved documentation/repository/access links. No linked document or web-page contents are fetched or represented as having been read; embeddings are not required.
- [x] Resolve names, aliases, and identifiers without guessing ambiguous matches. Clarification choices are actor-bound. Missing Projects and unavailable information produce accurate guidance rather than invented facts.
- [x] Remember the most recently unambiguously selected Project for that User's Documentation interaction for 30 minutes. Unresolved choices do not establish context; expired/ambiguous context prompts a question. Renames retain identity, and later reads use current data rather than a remembered snapshot.
- [x] Every typed follow-up retains the module prefix. Another User's context and other Modules' conversations/settings do not affect resolution. Retrieved inventory text is treated as data rather than instructions.
- [x] Reserve and attribute all paid interpretation/generation through the existing shared budget. Retain uncertain reservations and durable attempt/result checkpoints so retries or repeated result controls cannot blindly repeat paid work.
- [x] If the key, provider, or budget is unavailable, explain the limit and expose existing menus, exact lookup, structured editing, and history. Those paths remain usable without AI; selecting Project context or opening details does not itself spend money.
- [x] Read-side rendering honors stored archival status and labels archived references. It does not depend on users being able to trigger archive operations yet; ticket 06 supplies those mutation controls.

## Verification and delivery

- [x] Use a fake interpreter/generator and fake messaging through signed request/routing/dispatch paths for missing/ambiguous names, private clarification/context, 30-minute expiry, updated records, source grounding, malicious record text, disallowed query plans, provider failures, retries, and shared-budget exhaustion. Verify free-path behavior and no linked-page access.
- [x] Follow the [implementation and verification requirements](../spec.md#implementation-and-verification-requirements) and repository checks/delivery rules. Prepare representative synthetic question/answer cases for model-quality evaluation; automated fakes do not establish live-model accuracy.

## Comments

Approved as ticket 07. This is database-grounded retrieval and answering; full inventory filters/counts are delivered by 08 and natural-language mutations by 09.


Implemented locally on 2026-09-30. Hosting/Technology Project questions use strict paid interpretation and deterministic current-record rendering; context and clarification are private, and paid attempts/results have durable replay checkpoints. Synthetic evaluation cases are prepared in [the evaluation guide](../../../docs/testing/documentation-project-questions.md).

Local verification: Node v25.8.1 satisfies package engines; 200 tests passed, 18 real PostgreSQL tests skipped without TEST_DATABASE_URL; TypeScript check/build and local link checks passed. Signed request tests use fake Slack and fake interpretation. Live Slack/OpenAI accuracy, production deployment and import remain unverified. This ticket remains ready-for-human for those release checks. Deployment uses [the existing guide](../../../docs/deployment.md#documentation-project-questions-release-candidate).

Two-axis review completed: Standards and Spec have zero outstanding findings after consolidating hosting rendering and preserving free paths with an unsupported model setting. Additional signed Technology checks cover pagination, archival labels, current renames and Unknown versus empty relationships.
