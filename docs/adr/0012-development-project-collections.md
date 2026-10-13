---
status: accepted
---

# Keep repository execution distinct inside one Development project

The User wants one Slack-channel project with several ClickUp Folders and repositories, with every Folder offering every repository. Store the collections on the project and derive frozen single-repository, single-Folder destinations for the existing selection and execution workflow; retain singular saved configurations and historical snapshots without rewriting them. Batch entries and picker choices distinguish project plus repository, while project history, activation and ownership remain attached to the single project. Workers advertise exact project/repository/skill destinations and keep independent local setup, branches and checks for each repository, preventing a partially configured worker from consuming another repository’s run. Existing projects and selected tickets are not automatically merged because that would reinterpret prior authorizations and recovery records. The [Development contract](../development.md#shared-tickets-across-repositories) owns the interface, limits and consolidation procedure.

## Guided revisions — 13/10/2026

The User now permits repository changes and queued cancellation through Slack. Use revisioned assignment proposals and the existing project-row locks shared with worker claims and polling. Preserve historical runs and batch members; cancel removed destinations’ queued analyses and queue only newly added analyses. Reject edits around active execution, uncertain publication and corrections that have not been cancelled before starting. Cancellation retains the consumed Ready authorization, and retry explicitly replaces the cancelled batch member. This keeps displayed states grounded in recorded execution while making routine changes accessible without database edits. See the [guided state contract](../development.md#guided-state-actions).
