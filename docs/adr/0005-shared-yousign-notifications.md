---
status: accepted
---

# Integration-owned Yousign channel notifications

The User chose one company Yousign integration, one shared destination list editable by everyone, and identical automatic notifications in selected Slack channels. Per-User subscriptions would duplicate shared settings and tie company notification delivery to a person's account. Keep configuration interactions authenticated and private, but make event and delivery state belong to the integration in the configured Slack workspace. The User confirmed the complete design and authorized implementation on 02/10/2026. This extends the [private Module architecture](0002-private-assistant-modules.md); current behavior is owned by the [Yousign contract](../yousign.md), with the [interview](../../.scratch/yousign/spec.md) retained as history.

The current queue and worker locks assume an authenticated Slack User. A signed Yousign webhook proves the integration source, not any User's identity. Introduce an explicit integration work scope rather than impersonating the User who last configured a channel. Coordinate shared destination changes, event acceptance and delivery checkpoints under integration-scoped transactions/locks; a per-User Module lock cannot serialize changes made by different Users. This carries a shared-runtime migration cost, but keeps authorization provenance explicit and permits integration delivery to survive a configurator's departure.

Standing posting authorization comes from saved, explicitly activated destinations. Snapshot destinations for each accepted event and checkpoint each event/destination activation separately, while rechecking eligibility and cancellation before an external post. The User chose to cancel waiting deliveries on removal; distinct activation identities prevent remove/re-add from reviving those old deliveries. Already-started provider requests may finish. This supports partial fan-out recovery without repeating successful posts. Private destination visibility and terminal/uncertain recovery are owned by the feature contract. Existing Modules retain their current User isolation, private interaction and spending safeguards.
