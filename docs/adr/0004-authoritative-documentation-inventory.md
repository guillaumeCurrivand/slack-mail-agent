---
status: accepted
---

# Authoritative shared inventory in Documentation

During the design interview, the user selected the database as the authoritative company inventory after importing the existing spreadsheet. Independently editing both Google Sheets and the database would require synchronization and conflict rules; one authority keeps shared edits and their history consistent. Documentation will expose this shared inventory through private Agent interactions, with inventory facts and documentation links as its initial knowledge scope.

The user chose to apply confirmed field changes even when another person edits the record after the preview, favoring simple collaborative editing over rejecting stale confirmations. An implementation must serialize commits, preserve unrelated fields, and record the actual before/after values atomically with each mutation. Record versions may support history but must not become a reason to reject these confirmations.

Confirmations expire after 24 hours; archived targets require explicit restoration before editing. These conditions do not introduce rejection because of intervening field edits. Changes affect individual records; bulk mutations and controls restoring earlier field values are deferred.

Use the existing PostgreSQL with workspace-owned inventory/history and actor-owned interaction state. Existing worker locks serialize only one User's work within a Module; transactional record coordination must serialize shared inventory commits across Users. This extends the ownership assumptions of the [module guide](../adding-a-module.md) and [worker locking decision](0003-operation-admission-and-module-locks.md), while preserving the private ownership of existing Modules.

The User approved the ten-ticket breakdown and authorized implementation of ticket 01. The target contract and delivered-slice status live in [Documentation](../documentation.md), linked from the [product specification](../product-spec.md). The existing spreadsheet remains authoritative until a separately reviewed import is applied and verified; local structured Project creation does not perform that transition. Spreadsheet exports, bulk mutations, history-value restoration controls, document-content ingestion, and vector retrieval are deferred.

Ticket 01 creation commits its Project, initial history and applied confirmation checkpoint in one PostgreSQL statement. A conditional update locks the actor/DM-bound confirmation row, so separate delivery IDs and simultaneous confirmations cannot repeat the effect. Its stable target identifier is reserved when the proposal is saved. This gives creation its needed coordination without changing the shared runtime or serializing all workspace navigation; future editing must lock the affected shared record as well. Lifetime inventory/history are separate from ephemeral actor state, and cleanup retains checkpoints needed by pending work.
