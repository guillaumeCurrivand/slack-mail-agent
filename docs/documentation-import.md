# One-time Documentation import

Ticket 10 supplies an offline operator workflow. Building, testing or deploying it does **not** authorize reviewing the company's real source, approving a real mapping, applying it, or switching authority. Obtain separate User authorization for that work. The existing spreadsheet stays authoritative until the approved batch applies and reconciles successfully. Subsequent spreadsheet edits do not synchronize; maintain the inventory through Slack afterward. Recurring imports, exports and document-content ingestion remain deferred.

## Snapshot and review

The supported input is a frozen **JSON cell snapshot**, not a live Sheets connection or a binary XLSX file. Prepare it from an independently obtained workbook export, preserving every sheet's nonempty cells, displayed/cached values and original formula strings. Verify its completeness against that export before review; the importer cannot detect cells omitted by an exporter. No exporter, formula engine or source access is introduced by this ticket. Keep the original export and snapshot together in protected operator storage, outside Git.

```json
{
  "version": 1,
  "source": "Inventory export 2026-09-30",
  "sheets": [{
    "name": "Projects",
    "cells": [
      { "address": "A1", "value": "name" },
      { "address": "A2", "value": "Alpha", "formula": "=HYPERLINK(\"https://example.com/alpha\",\"Alpha\")" }
    ]
  }]
}
```

Cell values are literal strings, numbers, booleans or null; formulas are optional strings. Sheet names and addresses must be unique. Blank cells can be included and remain in the exact snapshot. Every nonempty/formula cell needs an explicit review disposition. Snapshot bytes, including formatting, identify the source: changing even whitespace requires a fresh review. Literal two-string `HYPERLINK` formulas with comma or semicolon separators decode escaped quotes and preserve both display text and destination. Other formulas remain unevaluated with their cached value and an explicit warning. Links are never visited. Unsafe links cannot enter URL fields; their original text remains in provenance for an explicit decision.

Use Node 24+ after `npm ci && npm run build`, or the built production container. The CLI needs existing `SLACK_TEAM_ID` and `ENABLED_MODULES` containing `documentation`; only database commands need the existing `DATABASE_URL`. No Gmail, Slack token or AI configuration is needed. These examples use operator-selected file paths:

```bash
node --env-file=.env dist/modules/documentation/import-cli.js review /secure/import/snapshot.json /secure/import/review.json
```

Review/approve do not connect to the database. Output files must be new; existing files are never overwritten. The review includes literal cells, original formulas/links, draft records, field evidence and warnings. Only exact `Projects`, `Technologies`, `Hosts` and `Tools` sheet names with a first-row `name` column suggest records. Each source row gets a distinct key. A Project name's literal hyperlink suggests a documentation link; confirm its actual purpose or move it to the correct field. Other columns/sheets remain literal unresolved cells. Nothing guesses components, environments, combined values, usage relationships or company-wide usage.

Resolve the review with the User, then edit `review.json`:

- Keep `workspace`, `sourceDigest`, `source`, source cells/raw values and generated warnings unchanged.
- Set each cell's `decision` to `mapped`, `retained` or `ignored`, with a nonempty `reason`. `mapped` cells list their reviewed record `keys` in `records`; header/unused cells also require an explicit reason. Retained/ignored originals are kept in lifetime batch provenance.
- Each record has a unique `key`, a `kind` (`project`, `technology`, `host`, `component`, `hosting`, `tool`), fixed `fields`, and `evidence`. Each supplied non-null field needs evidence entries `{ "cell": "Sheet!A2", "reason": "User's resolution and supporting source meaning" }`; that cell's decision must list this record key. Evidence is required for Project/Component assignments, environments, split values and every other supplied fact. Omitted optional values become Unknown under the [existing field contract](documentation.md#initial-record-fields).
- Use `@key` relationships: Component `projectId` and `technologies`, Hosting `componentId` and `serviceId`, Tool `projects`. References can only identify reviewed records of the required kind. Add explicitly supported records where necessary; retain unmatched usage verbatim in `usage` and its source evidence. Unknown Project matches never imply `companyWide: true`.
- Preserve distinct same-named services with separate keys. To consolidate source rows, explicitly combine their evidence into one record. Resolve every warning in `resolutions`, keyed by the warning's exact text with the User's nonempty explanation. The [synthetic resolved fixture](../tests/fixtures/documentation-import-review.ts) demonstrates combined technologies, component/environment evidence, distinct same-named Hosts and unmatched Tool usage; its decisions are synthetic, not decisions about company data.
- To reference an existing inventory record, add its `existingId` and its **complete expected business fields** to that reviewed record. Get fields/identity from Documentation details first. It must exist in this workspace and exactly match the reviewed fields at apply; the importer does not edit it or fabricate initial history. Missing/changed/archived existing records and unreviewed name/identity collisions stop the import.

Do not invent missing facts, discard uncertain text or silently merge names. The User's decisions and field evidence establish source meaning; validation checks their presence and identities, not the truth of a human assertion.

## Approve, apply and reconcile

Only after the User has reviewed the complete mapping, freeze it and create the approval artifact, with attribution identifying that User's actual approval:

```bash
node --env-file=.env dist/modules/documentation/import-cli.js approve /secure/import/snapshot.json /secure/import/review.json /secure/import/approval.json "User identity and approval reference"
node --env-file=.env dist/modules/documentation/import-cli.js apply /secure/import/snapshot.json /secure/import/review.json /secure/import/approval.json
node --env-file=.env dist/modules/documentation/import-cli.js reconcile /secure/import/snapshot.json /secure/import/review.json /secure/import/approval.json
node --env-file=.env dist/modules/documentation/import-cli.js status
```

Approval binds the configured workspace, source digest and the full resolved review digest. The operator account is trusted and already possesses database access; artifacts are not a signed authorization system or Slack bulk-edit controls. Protect them and retain the actual User approval. Any changed source/mapping needs a fresh review and approval. A workspace can have only one effect-bearing initial batch. After any effect commits, a different batch is rejected; this is not a recurring import facility.

Apply creates stable identifiers from workspace, snapshot, kind and source key. Dependencies apply before their children. Every effect transaction locks the workspace batch and commits its record, source-attributed initial Change history and checkpoint together. Existing references get checkpoints without mutations/history. Batch artifacts and original source are retained in module-owned lifetime tables. Initial history includes User attribution, commit time, source label/digest, batch/effect identity and exact initial fields. There is no paid call or provider access.

The report gives expected and applied record counts, existing references, initial history count, per-kind reconciled counts, relationship count, status and problems. Reconciliation locks approved targets against concurrent Slack edits, checks fields, references, checkpoints and initial history, and records the authority timestamp **only when all checks succeed**. Confirm `reconciled: true`, `authoritative: true`, no problems and the approved counts. Inspect all kinds through Documentation lists/details/history and compare source links and relationships with the review. Existing referenced records keep their original history. No successful production import is implied by synthetic test results.

## Failure and recovery

Apply/reconcile return a nonzero CLI exit for incomplete reports. A failure reports only durably committed effects; completed writes are never blindly replayed. On interruption or a lost response, inspect `status` and rerun `apply` with exactly the saved artifacts. A history/write error rolls back that effect, leaving earlier effects available; retry resumes at missing checkpoints. Never delete checkpoints, restart with new keys, or remove the database volume to retry.

If files are lost, recover the exact saved snapshot/review/approval into a **new**, protected directory:

```bash
node --env-file=.env dist/modules/documentation/import-cli.js recover /secure/import/recovered
node --env-file=.env dist/modules/documentation/import-cli.js apply /secure/import/recovered/snapshot.json /secure/import/recovered/review.json /secure/import/recovered/approval.json
```

A failed batch with **zero effects** may be replaced by a fresh, fully resolved review and approval (for example, mapping a preexisting Project explicitly). Superseded source/review/outcome information is retained. Once effects exist, the mapping is frozen: resolve an external collision or changed inventory through separately approved ordinary Documentation changes, then resume/reconcile the original batch. If a deeper repair is necessary, inspect the saved artifacts and database backup with the User; there is no automatic destructive reset or rollback procedure.

A successful batch cannot overwrite later Slack edits on replay. Reconciliation reports current drift without resetting the already-established authority timestamp or manufacturing new import history. Corrections after transition use ordinary separately confirmed Slack changes.

## Production readiness

Follow [the release/update procedure](deployment.md#documentation-import-release-candidate), preserve the existing `.env`, Compose project and database volume, and take a protected database backup before any separately authorized real apply. Ensure the snapshot is complete, every ambiguity is resolved, existing identity collisions are handled, Documentation is enabled in the intended workspace, the operator has the exact reviewed artifacts, and the application is ready. Real PostgreSQL recovery/concurrency tests require a disposable `TEST_DATABASE_URL`; synthetic embedded tests alone do not establish cross-connection locking. Verify live Slack reads and the real mapping/import separately. No new environment variables, permissions, infrastructure accounts or manual migration command are required; startup/apply idempotently creates the import tables.
