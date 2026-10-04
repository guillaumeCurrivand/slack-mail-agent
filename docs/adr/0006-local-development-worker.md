---
status: accepted
---

# Shared Development projects with a local coding worker

On 03/10/2026 the User approved a `development` Module connecting a Slack channel, ClickUp Folder, repository and existing Cursor skill. Channel members can review tickets together; the human-selected `Ready for AI` status authorizes a frozen implementation request. The Module owns shared configuration, snapshots, attempts and delivery checkpoints. Other Modules retain their existing private state. Signed channel receipt is an opt-in shared-runtime capability; only Development registers it.

Keep the existing hosted Slack ingress and durable PostgreSQL queue. A trusted local worker polls authenticated Module endpoints instead of exposing a local HTTP port or replacing the bot with Socket Mode. It uses independent per-run checkouts, one running operation per repository, a durable local journal and exactly one controller-created commit per ticket on `maintenance`. Review/merge/deploy remain human actions. This fits the existing development environment and tolerates the machine being offline; moving to an always-on machine is deferred.

The User explicitly chose no execution time limit and at most two implementation attempts. Running claims therefore do not expire or get reassigned merely because a heartbeat is missing: an orphaned process must not race a replacement worker. Reusing the saved worker identity recovers the same claim. An uncertain Cursor call is blocked instead of dispatched again; committed work is recovered by its exact SHA. Unknown external writes are not blindly repeated.

The User separately approved Cursor billing for Development. Cursor calls use the local account and its provider-side limits, outside Mayassistant's existing shared OpenAI allowance. Do not record unknown Cursor costs as zero, route them through a fake User budget, or imply that the existing $10 ceiling protects these calls. Current behavior and operator recovery are in [Development](../development.md).

On 04/10/2026 the User approved `maintenance/ai` for the EOA project because existing `maintenance/...` refs prevent creating an exact `maintenance` ref. Keep the destination in trusted local worker configuration and pin it in each run journal; include it in the result so French notifications name the actual branch. Existing configurations default to `maintenance`. The initially assumed base was remote `test`; the EOA correction below supersedes that assumption.

The User also approved a browser MCP instead of the project's unused test suite. Cursor explores the controller-owned local preview through Microsoft's Playwright MCP. For visible changes it returns a bounded interaction scenario; the controller independently replays that scenario with Playwright and requires passing assertions before publication. An isolated browser, screenshot and result file provide evidence, without treating an agent's claim as a passed check. These checks verify the supplied scenario, not its completeness against every possible requirement. Login roles are selected from the operator's explicit allowlist; credential values are loaded from a local file and omitted from the scenario. Existing command-based browser checks remain supported. This is a trusted local worker, not a security sandbox.

On 04/10/2026 the User clarified that EOA calls its integration branch `preprod`. Configure `baseBranch` independently from the maintenance destination on the trusted local worker, defaulting to `test` for existing projects and using `preprod` for EOA. Preserve the selected base in the run journal so recovery cannot switch ancestry mid-run. The worker never pushes to the base branch; human review and merge target `preprod`. No additional `test` branch is required for EOA.
