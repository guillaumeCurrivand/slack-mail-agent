# ClickUp personal status filters — design interview

Status: historical interview complete; full design confirmed by the User on 02/10/2026. This record describes the design phase. Subsequent implementation and verification are recorded in [the tracker](spec.md).

Date: 02/10/2026.

## Requested outcome

The User reports that the existing `clickup taches` command works well. Each User should have a personal selection of statuses used to filter their assigned tasks. A separate command should display the available statuses in the ClickUp Workspace and let that User choose.

The [ClickUp contract](../../docs/clickup.md#personal-status-filters) is authoritative for the approved extension. Existing unrelated documentation edits are preserved. The decisions below are the historical interview record.

## Verified implementation baseline

- `src/modules/clickup/tasks.ts` currently includes directly assigned, unarchived tasks and excludes both `done` and `closed` status types.
- Task requests retrieve fresh data. Paging preserves the saved result, with access rechecks and a 24-hour expiry.
- The configured Workspace is Mayasquad. Each User has a personal ClickUp connection.

## Round 1 — agreed decisions

The User answered Yes to all three recommendations.

1. Before a User saves a personal filter, preserve current behavior: all directly assigned, unarchived tasks except Done/Closed.
2. Explicitly selecting a Done or Closed status includes matching completed tasks. Assignment and archive rules remain applicable.
3. `clickup statuts` opens a private picker, also reachable through Menu → ClickUp → Choisir les statuts. The picker reopens with saved selections and uses Enregistrer/Annuler; changes apply only after Enregistrer. The recommended English alias is `clickup statuses`.

The resolved term **ClickUp status filter** is recorded in the [glossary](../../CONTEXT.md). Native multi-select versus paginated selection controls remains an implementation choice, subject to complete catalogue coverage.

## Provider findings — documentation verified on 02/10/2026

These are documentation findings, not observed live API behavior.

- Status definitions can differ at Space, Folder, Subfolder and List levels, and identical status names can occur in different Lists. Tasks in multiple Lists use their primary home List's statuses. [Statuses FAQ](https://help.clickup.com/hc/en-us/articles/6309465975063-Statuses-FAQ)
- Hierarchy discovery must respect the connected User's access; inaccessible Subfolders are omitted. Some Folders inherit effective statuses from their ancestors or Space. [Get Folder](https://developer.clickup.com/reference/getfolder)
- Workspace task filtering accepts status names. Closed tasks require `include_closed=true`; the existing provider's `include_closed=false` must change for an explicit selection that includes completed tasks. [Get Filtered Team Tasks](https://developer.clickup.com/reference/getfilteredteamtasks)
- The documented discovery path uses Spaces, Folders and Lists; no Workspace-wide status catalogue endpoint was found. Get Folders returns Subfolders in a flat response, and list-collection responses do not document their full task-status definitions. [Get Spaces](https://developer.clickup.com/reference/getspaces), [Get Folders](https://developer.clickup.com/reference/getfolders), [Get Lists](https://developer.clickup.com/reference/getlists), [Get List](https://developer.clickup.com/reference/getlist), [OpenAPI](https://developer.clickup.com/openapi/clickup-api-v2-reference.json)
- Stable status-ID behavior across rename/template replacement was not established. Exact archived-container query behavior and Personal List discovery remain live/API-contract verification questions; the picker must not silently promise unsupported completeness.
- Space traversal must be supplemented with the authenticated User's shared Folders/Lists. Task-only sharing may expose the task's current status without permission to read its home List's complete status definitions; that is a discovery gap, not a complete catalogue. [Shared Hierarchy](https://developer.clickup.com/reference/sharedhierarchy), [Get List](https://developer.clickup.com/reference/getlist), [Get Task](https://developer.clickup.com/reference/gettask)
- ClickUp's Personal List is separate from the normal Hierarchy. No documented Personal List discovery route was found in the official API index/OpenAPI. Deferring guaranteed Personal List status discovery was proposed during the investigation and explicitly confirmed in question 11. [Use Personal List](https://help.clickup.com/hc/en-us/articles/18377842006167-Use-Personal-List), [API index](https://developer.clickup.com/llms.txt)

## Round 2 — agreed decisions

The User accepted the recommendations for questions 4–7.

4. One choice per status name throughout the Workspace. Selecting a shared name includes matching tasks across Lists; location-specific selections are outside this feature.
5. A custom filter must select at least one status. Provide Réinitialiser le filtre to restore the default unfinished-task behavior.
6. Saved changes apply to new `clickup tâches` requests and Actualiser only. Existing result pages retain their original filter and snapshot; each result displays the filter used for retrieval.
7. Preferences belong to the Slack User in the configured Workspace and survive disconnect/reconnect, account replacement and temporary Module disablement. The User can reset them explicitly. Credential and snapshot deletion safeguards remain applicable.

The first wording of question 8 made Yes ambiguous. The question was restated in Round 3; the latest Yes is taken as accepting the recommendation, with the blocking rule made explicit in the final review.

The requested catalogue covers configured statuses available through the connected account in Mayasquad, including statuses unused by its current assigned tasks. The scope is constrained by the existing personal OAuth access boundary.

## Round 3 — agreed decisions

The User answered Yes to all three questions. Their recommended answers were included explicitly in the final review and confirmed in question 11.

8. Incomplete discovery blocks saving from that picker. Show any discovered choices with an incomplete warning and Réessayer. Retain the existing saved filter.
9. Keep saved names that have been renamed, removed or become unavailable; label them unavailable in the picker and let the User remove/replace them. Continue matching the selected names without automatically resetting or broadening the filter.
10. An older picker cannot overwrite a newer saved filter. Reject its outdated save and ask the User to reopen the latest preferences.

The name-based filter means newly introduced names are not included in a saved custom selection unless the User adds them. Before configuration or after an explicit reset, the default continues to include unfinished tasks regardless of their names.

## Final review — confirmed

11. The User answered: "I confirm this is what I want." This confirms the complete design, including blocking saves from incomplete discovery and deferring Personal List-specific discovery. Guaranteed discovery covers the connected User's accessible Workspace Spaces, Folders/Subfolders and Lists, including shared locations.

The [feature tracker](spec.md) is ready for implementation and links the approved [authoritative contract](../../docs/clickup.md#personal-status-filters). The glossary, README and product specification were updated consistently. No architectural decision met the domain-modeling skill's ADR threshold: these are reversible feature choices within the existing ownership/module architecture.

This interview made documentation-only changes on the existing main branch. No runtime implementation, tests, commit, push or deployment occurred. Local links/anchors and the intended documentation diff were checked; live integrations were not exercised.
