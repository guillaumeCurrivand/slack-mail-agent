Status: resolved
Category: bug

# 04: Retain handled-event markers for active jobs

The 2026-09-25 code review found that `SlackChannelSelections.cleanup()` deletes `slack_handled_events` rows older than 30 days without checking whether their jobs are still queued or running. A Slack delivery with an uncertain outcome can leave a handled marker and queued job. If the module is disabled long enough, startup cleanup on re-enablement can remove that marker before the job retries, allowing a duplicate private response.

- Preserve markers while the corresponding job is queued or running, as `SlackAiAttempts.cleanup()` already does for paid-call checkpoints.
- Keep the 30-day retention behavior after the job is no longer active.
- Cover the disabled, re-enabled, and retried job path with fake Slack delivery through the public dispatch seam.

This follows the retry and disabled-job safeguards in [Adding a module](../../../docs/adding-a-module.md).

## Resolution

`SlackChannelSelections.cleanup()` now preserves markers for queued and running Slack jobs, then removes an expired marker once its job is complete. A signed-DM regression test covers uncertain delivery, disabled-module retention, re-enablement, and retry without a duplicate private response. Verified locally on 2026-09-25.
