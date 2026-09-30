# 06: Archive and restore inventory records

**What to build:** A User can archive any supported inventory record, find it in an Archived view, and restore it with confirmation while retaining relationships and the complete Change history.

**Blocked by:** [04 — Manage Hosts/services and Hosting entries](04-manage-hosts-services-and-hosting-entries.md), [05 — Manage Tools and their usage](05-manage-tools-and-their-usage.md).

**Status:** ready-for-human

**Specification:** [Documentation](../spec.md), especially archive/history, mutation confirmation, and lifecycle rules.

## Acceptance criteria

- [x] Record details and structured commands offer Archive for active records and Restore for archived records across Projects, Components, Technologies, Hosts/services, Hosting entries, and Tools. Both lifecycle changes require the initiating User's saved confirmation within 24 hours and no AI.
- [x] Ordinary browse lists omit archived records. A paginated Archived view and explicit record references retain access to archived details/history, with a clear archived label and restoration control.
- [x] Archiving never permanently deletes a record, removes its references/history, or automatically archives referencing records. In particular, archiving a Host/service leaves its Projects active and shows that host's archived status wherever they reference it.
- [x] Current Project/related-record details expose archived references accurately rather than hiding them or implying that they are active. Restore retains the same stable identifier and prior relationships/history.
- [x] All Documentation Users can propose archive/restore changes for shared records through their own actor-bound controls; no additional roles are introduced.
- [x] A normal edit confirmed after its target becomes archived does not apply until the target is explicitly restored. Restoration does not extend an expired edit confirmation. Intervening ordinary field edits remain permitted under the chosen overwrite policy.
- [x] Lifecycle commits append actual before/after history atomically with their effect identity. Retrying an old Archive confirmation after a later Restore cannot archive the record again; apply the equivalent safeguard to replayed restoration.
- [x] Dedicated earlier-field-value restoration and permanent deletion remain unavailable. Inventory/history survive disable/re-enable, while expired confirmations remain expired.

## Verification and delivery

- [x] Test each record type through public structured/action dispatch with fake messaging, including preserved relationships, current Project details with archived hosts, already-satisfied operations, cross-user clicks, edit/archive races, old confirmation replay after the opposite lifecycle change, and disable/re-enable retention.
- [x] Follow the [implementation and verification requirements](../spec.md#implementation-and-verification-requirements), including relevant real PostgreSQL lifecycle races where configured, project checks, docs, full-diff review, and transparent skip/live-verification reporting.

## Comments

Approved as ticket 06. Restoring an archived record is included; restoring earlier field values from history is deferred.


Implemented locally on 2026-09-30. The [Documentation contract](../../../docs/documentation.md#delivered-locally--ticket-06) records Archive/Restore for all six kinds, the Archived view, preserved relationships/history, archived-reference labels and edit gating. Operations keep initiating-User/DM-bound confirmations and original 24-hour expiry; opposite-transition replays cannot repeat either effect. No production deployment or import was performed.

See the [deployment guide](../../../docs/deployment.md#documentation-archiverestore-release-candidate) for the automatic archival-column migration, preserved environment/database volume, server commands and post-deploy checks. No new required environment variables, credentials or scopes; no manual migration command. This remains a local release candidate pending production readiness and live Slack verification.

Local verification: Node v25.8.1 satisfies >=24. The full npm test suite passed 186 tests; 18 real PostgreSQL tests (including six new all-kind lifecycle/edit/opposite-transition locking tests) were skipped because TEST_DATABASE_URL was not configured. After review fixed Project ambiguity status labels, all 51 Documentation tests and npm run check/build passed. 56 local documentation file links and their heading anchors and git diff --check passed. Tests exercise signed fake Slack ingress/public dispatch, each lifecycle kind, preserved relationships, current Project details with archived hosts, actor ownership, both-operation expiry, already-satisfied operations, edit/archive races, disable/re-enable retention, actual history, atomic rollback, uncertain/rejected delivery, opposite-transition replay and exhausted AI allowance. No live Slack/Gmail/OpenAI integrations were exercised.

Final review against starting commit b57a6fac8c2557acf15a182e496193c9193d0e9d: Standards - 0 outstanding documented violations or actionable smells; Spec - 0 remaining findings. The two axes were reviewed independently. Work is committed locally on main; pushing and deployment are outside this ticket. Pre-existing CONTEXT.md changes and tickets 07-10 are excluded.
