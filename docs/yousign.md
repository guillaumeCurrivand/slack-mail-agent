# Yousign module

Status: approved complete contract on 02/10/2026; implemented and tested locally. Live Yousign/Slack setup, real PostgreSQL coordination and production deployment remain unverified. The [product specification](product-spec.md) owns shared safeguards; this document owns Yousign behavior. The [interview](../.scratch/yousign/spec.md) preserves the decisions, and the [ownership ADR](adr/0005-shared-yousign-notifications.md) explains integration-owned work.

## Approved behavior

One company integration receives the existing Yousign webhook. Every authenticated event produces the same fresh French notification in every selected destination, with no Module-side event-type filter. Previously unknown event names are supported. The destination list belongs to the configured workspace/integration and is shared by everyone.

Users manage channels through private menus similar to Slack Unanswered. Public, private and externally shared channels are allowed when shared by the User and bot; DMs/group DMs are excluded. Names and controls for channels the viewer cannot access are hidden. List ten channels per page, updating the same message. An explicit **Activer** control immediately authorizes future automatic posts; the screen explains that the settings affect everyone. No separate activation confirmation is required. Signed User/DM/message binding and current channel access apply to mutations. A configuring User's departure does not revoke the company destination.

Start empty. Snapshot active destinations when an event is durably accepted. Later additions receive subsequently accepted events only. With no destinations, record the event as skipped and acknowledge it without backfill, including after a duplicate delivery. Removal cancels posts not yet started to that activation. An attempt already started may finish; previously posted messages remain. Re-adding creates a new activation and cannot revive old waiting work. Replays and old Remove buttons cannot change a later activation.

Notifications contain the event, request name or safe resource identifier when supplied, event time and signer name when supplied. Use French/Europe-Paris presentation, with original names rendered literally. Exclude emails, raw payloads, documents, signing/approval links and invented dashboard links. Sparse/unknown events use their literal event name and a safe available identifier. No Slack history, AI, Gmail or Yousign enrichment API is used; no Yousign API key is required.

## Commands and status

| Purpose | French | English |
| --- | --- | --- |
| Shared destinations | `yousign canaux` | `yousign channels` |
| Delivery status | `yousign statut` | `yousign status` |
| Help | `yousign aide` | `yousign help` |

Open **Yousign → Choisir les canaux** or **Statut** from the private main menu. Status shows the last authenticated receipt and eight delivery entries per page, event/receipt times, per-channel outcomes, failure explanations and the next scheduled retry, filtered through current User/bot access. Refresh reads current state without paid work. Do not disclose another channel's name or request content. Send `menu` for an unavailable/expired menu.

Keep inaccessible destinations selected and preserve recovery state. An eligible User can manage them when access is restored. Permanent decommissioning is operator maintenance with cancellation safeguards, rather than a private-channel override for unrelated Slack Users.

## Receipt, recovery and alerts

`POST /webhooks/yousign` verifies HMAC SHA-256 over the exact raw JSON using `x-yousign-signature-256`. Validate the configured subscription/environment and envelope, including Unix-seconds `event_time`. Incorrect signatures/sources or malformed events are rejected. Database failure returns 503. Event receipt, destination snapshot and durable integration-job insertion commit atomically before 2xx; there are no Slack/provider calls on the acknowledgement path. Retain only approved summary fields and recovery metadata.

Deduplicate by integration/event identity and checkpoint each event/destination activation independently. Save a sending marker before the external call and a returned timestamp after success. Never repeat a successful post while its effect metadata is retained. A sending marker found after interruption becomes uncertain. Temporary failures known to have had no effect recover with bounded backoff and rate-limit handling; queued work survives restart/disablement. A channel failure must not prevent another channel's delivery. Deferred integration work must not block later ready jobs or User navigation.

Uncertain outcomes are never automatically resent. **Examiner** opens a separate saved confirmation identifying the exact event/channel, warning of a possible duplicate and expiring after 24 hours. Recheck User/DM binding, channel access, activation and original attempt on confirmation. Competing/replayed confirmations cannot repeat the new attempt; removal invalidates it. A definite terminal failure can expose **Réessayer** tied to the existing attempt and current activation/access.

Send a generic private alert to `SLACK_ADMIN_USER_ID` when a new unresolved channel issue appears, rather than once per affected event. Disclose no private channel/request names to that recipient. Alert sends have independent persisted markers; definite rejection can retry, uncertainty cannot blindly resend. Clearing the issue allows an alert for a later incident.

Retain terminal event summaries, delivery/interaction metadata and history for 30 days. Never expire data needed by queued/running work; keep active shared configuration. Provider, Slack and backups have separate retention. Manual replay after deduplication metadata expires is outside the guarantee. Do not promise chronological provider delivery.

## Enablement and setup

Pull the release that contains this Module before appending `yousign` to the existing `ENABLED_MODULES`; older releases reject that identifier and fail startup. Required only when enabled:

- `YOUSIGN_WEBHOOK_SECRET`: the existing webhook signing secret.
- `YOUSIGN_SUBSCRIPTION_ID`: that subscription's exact identifier.
- `YOUSIGN_SANDBOX`: `false` for production (default), `true` for sandbox.
- `SLACK_ADMIN_USER_ID`: the operational alert recipient in the configured workspace.

Use shared Slack/database/public-origin settings. Yousign needs no Gmail, AI or encryption credentials. Point the existing webhook to HTTPS `PUBLIC_URL` plus `/webhooks/yousign`, preserving raw bodies/signatures and omitting sensitive request-body logging. Do not create a second subscription. Invite the bot to selected channels; the installed token needs `channels:read`, `groups:read` and `chat:write`, already described in [Slack setup](../README.md#slack-setup).

Disabled Yousign exposes no webhook route, processes no jobs and pauses cleanup while preserving saved state. Events never accepted during route unavailability rely on finite provider retries; receipt cannot be guaranteed. Re-enabling resumes accepted waiting work without reviving removed activations or expired confirmations.

Enabled startup idempotently creates `yousign_*` tables. Existing data/User jobs retain their ownership and order. Integration jobs have an explicit non-User identity and independent worker scope, bypassing AI budget dispatch. Stop old workers before updating; use [the deployment procedure](deployment.md).

## Provider facts and release checks

The [official handling guide](https://developers.youtrust.com/docs/use-webhooks-in-your-app) specifies raw-body HMAC, unique event IDs, Unix event time and the one-second initial acknowledgement deadline. [Event schemas](https://developers.youtrust.com/openapi/webhook-events.json) support the selected summary fields. [Provider retries](https://developers.youtrust.com/docs/failure-and-retry-policy) are finite; application recovery begins after durable acceptance. [Slack posting](https://docs.slack.dev/reference/methods/chat.postMessage/) can have effects before an internal error response.

Test signed HTTP/DM ingress through durable dispatch, shared selection/privacy, snapshots/removal/re-add, empty/duplicate/unknown events, partial fan-out, rate limits, definite/uncertain recovery, explicit resend ownership/expiry/replay, alerts, disablement and retention using fake providers. Real PostgreSQL coordination tests require disposable `TEST_DATABASE_URL`, with skips separately reported. Observe live payload/signature compatibility, acknowledgement latency, actual Slack scopes/membership/channel audiences, restart recovery and Docker Compose deployment before rollout. Local tests do not establish production deployment.

## Local verification record — 02/10/2026

Using Node v25.8.1, `npm test` passed 293 tests, including 19 Yousign tests through fake Slack and embedded PostgreSQL. Twenty-four real PostgreSQL tests were skipped because `TEST_DATABASE_URL` was unset, including three new Yousign coordination tests. `npm run check`, `npm run build`, whitespace checks and local file-link checks in eight affected documents passed. The complete intended implementation diff, including new files, was reviewed. Existing unrelated documentation edits were preserved.

At this verification, the work remained local and uncommitted on `main`. Live Yousign/Slack behavior, actual PostgreSQL locks, proxy acknowledgement latency and production deployment were not exercised. Commit and push the reviewed changes before following the linked server update procedure.
