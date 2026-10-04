---
status: accepted
---

# Shared Development projects with a local coding worker

On 03/10/2026 the User approved a `development` Module connecting a Slack channel, ClickUp Folder, repository and existing Cursor skill. Channel members can review tickets together; the human-selected `Ready for AI` status authorizes a frozen implementation request. The Module owns shared configuration, snapshots, attempts and delivery checkpoints. Other Modules retain their existing private state. Signed channel receipt is an opt-in shared-runtime capability; only Development registers it.

Keep the existing hosted Slack ingress and durable PostgreSQL queue. A trusted local worker polls authenticated Module endpoints instead of exposing a local HTTP port or replacing the bot with Socket Mode. It uses independent per-run checkouts, one running operation per repository, a durable local journal and exactly one controller-created commit per ticket on `maintenance`. Review/merge/deploy remain human actions. This fits the existing development environment and tolerates the machine being offline; moving to an always-on machine is deferred.

The User explicitly chose no execution time limit and at most two implementation attempts. Running claims therefore do not expire or get reassigned merely because a heartbeat is missing: an orphaned process must not race a replacement worker. Reusing the saved worker identity recovers the same claim. An uncertain Cursor call is blocked instead of dispatched again; committed work is recovered by its exact SHA. Unknown external writes are not blindly repeated.

The User separately approved Cursor billing for Development. Cursor calls use the local account and its provider-side limits, outside Mayassistant's existing shared OpenAI allowance. Do not record unknown Cursor costs as zero, route them through a fake User budget, or imply that the existing $10 ceiling protects these calls. Current behavior and operator recovery are in [Development](../development.md).
