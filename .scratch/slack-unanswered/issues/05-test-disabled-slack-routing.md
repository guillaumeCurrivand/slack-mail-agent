Status: resolved
Category: test

# 05: Test disabled Slack routing through a signed DM

The 2026-09-25 code review found that the Slack feature tests always enable the module. Generic disabled-module tests cover mail or a test module, but no test sends a signed `slack` DM while Slack Unanswered is disabled.

- Send a signed `slack` DM through enqueue and dispatch with the module disabled, using fake providers.
- Verify that the Slack module does not execute or read channel history, and that the user receives the shared routing guidance.

This is required by [Slack Unanswered Testing Decisions](../../../docs/slack-unanswered.md#testing-decisions).

## Resolution

A signed-DM regression test now dispatches `slack unanswered` with the module disabled. It verifies private shared guidance, a core-routed job, and zero calls to Slack or AI providers. Verified locally on 2026-09-25.
