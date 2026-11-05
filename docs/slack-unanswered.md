# Slack Unanswered — retired

Removed at the User’s request on 05/11/2026. The assistant no longer offers unanswered-message search or its channel picker. See the [current modules](../README.md#modules-and-project-structure) and [historical contract](archive/slack-unanswered.md).

## Upgrade and retained data

The legacy `slack` entry in `ENABLED_MODULES` is ignored. Remove only that entry when updating configuration; preserve other modules and credentials. Old commands/buttons return shared unavailable-module guidance. The worker does not select retired jobs.

Existing `slack_selected_channels`, `slack_handled_events`, `slack_ai_attempts` and `slack_unanswered_results` tables, queued jobs and budget records are not deleted or migrated. Module cleanup no longer runs. Any eventual data purge requires a separate retention decision. Shared navigation retention still applies to its own records. The [deployment guide](deployment.md#module-retirement-and-ui-standardization--05112026) owns update commands and checks.
