# Yousign module — approved design and interview

Status: ready-for-human (implemented locally; live setup and release verification outstanding)
Category: enhancement

The User confirmed the complete design and authorized implementation on 02/10/2026. This document retains the interview; the [Yousign feature contract](../../docs/yousign.md) owns approved behavior and release status. The [product specification](../../docs/product-spec.md) and [module guide](../../docs/adding-a-module.md) own shared safeguards. Terminology lives in [CONTEXT.md](../../CONTEXT.md).

## Problem statement

Add a Module to Mayassistant that receives the company's Yousign webhook and posts a notification in user-configurable Slack channels.

## Confirmed decisions

Confirmed by the User on 02/10/2026:

- One shared company Yousign integration, rather than a separate account connection for each User.
- One shared destination list, rather than independent per-User notification settings.
- The webhook already exists in Yousign. Creating a new subscription is not part of the expressed need.
- Forward all events received from that existing webhook, without additional event-type filtering in the Module.
- Everyone can manage the shared destination list through the Module.
- Every selected destination receives the same notification for a given event.
- Use a private channel selector similar to Slack Unanswered. Destinations may be public, private or externally shared channels; eligibility follows the User/bot shared-access model, rather than a company-only audience restriction.
- Post one fresh, short French message per event. Show the event, signature request name or identifier, event time, and signer name when supplied. Do not include emails, raw webhook payloads, documents or signing links.
- Adding a channel immediately enables future automatic notifications, through a control that clearly explains this effect. No separate activation confirmation is required.
- Skip events received while the destination list is empty. Adding a channel does not backfill those events.
- Provide a private Module status screen and send delivery-problem alerts privately to one designated operator.
- Hide destination names and controls from Users who cannot access those channels, even though the destination configuration is shared.
- Removing a destination cancels its waiting posts. A request to Slack already started before removal may finish; previously posted notifications are not deleted. Re-adding the channel authorizes only events received after that new activation.
- Reuse `SLACK_ADMIN_USER_ID` for private delivery-problem alerts. Require that recipient when Yousign is enabled; other Modules retain their existing configuration requirements.
- Recover definitely undelivered work automatically after temporary outages, retaining selected channels if the bot temporarily loses access. Deliveries with uncertain outcomes are flagged for review, never automatically repeated. Recovery respects subsequent channel removal and activation identities.

The existing webhook's provider-side selected event types remain a setup fact, not an additional Module-side filter. “All events” does not authorize unauthenticated requests or distribution to unselected channels.

## Complete-design review

No business-choice questions remain open. The User confirmed shared understanding and said: “Yes it does, you can implement.” Subsequent references to pending confirmation in the interview below describe historical states; the feature contract now owns current behavior.

The approved release includes private channel management and status, authenticated receipt of all events from the existing webhook, automatic channel notifications, durable recovery and private operational alerts. The confirmed defaults include a 30-day terminal history, no AI/provider enrichment calls, integration-owned work and a narrow exception to the existing private-DM contract for selected Yousign notifications.

Implementation is complete locally. Live setup, subscription credentials, actual token permissions and production deployment remain separate release work; their unknown values do not require changing the settled product design.

## User journey

1. A User opens **Yousign → Choisir les canaux** from the private main menu, or sends `yousign canaux` / `yousign channels`.
2. The shared list starts empty. The User sees channels currently shared with the bot and visible shared selections, with Add/Remove and pagination in the same private message. It clearly states that adding enables automatic notifications for everyone in that channel.
3. Adding immediately activates the selected channel for subsequently received events. Another eligible User sees that same saved selection. Users cannot see or act on destination names they cannot access.
4. An authenticated event is durably accepted and produces the same fresh French summary in each destination active at receipt. With no destinations, the event is recorded as skipped and cannot become a backfill later.
5. Removing a destination cancels its waiting posts. Re-adding it creates a new activation and receives only events accepted after that activation. Posts already started before removal may finish; posted history is preserved.
6. **Yousign → Statut** shows accessible delivery outcomes and integration health. Temporary definite failures recover automatically; persistent problems or uncertainty are visible and alert the configured operator privately. Uncertain outcomes require explicit review before a specific resend.

## Approved safeguards and implementation defaults

These were confirmed with the complete design and are implemented locally. The feature contract owns current behavior and verification status.

- Keep configuration/status actions in signed, User/DM/message-bound private controls. Start with no destinations. List public/private channels shared by the viewing User and bot, with ten entries per page and in-place Add/Remove controls. Allow externally shared channels without excluding them by audience. Use `yousign` as the deterministic Module prefix, with `yousign canaux` / `yousign channels`, `yousign statut` / `yousign status`, and help shortcuts.
- Adding is standing authorization to post future authenticated events to that selected channel. List text explains that settings affect everyone. Channel additions require current User/bot access; private channel names and notification details are never exposed to an unrelated viewer or alert recipient.
- Shared selection survives the departure of the User who added it. It belongs to the company integration. Another eligible User can manage it. Inaccessible selections remain saved; a User who regains shared access can remove them. Permanent decommissioning is operator maintenance, without adding private-channel controls for unrelated Users.
- Capture the destination set when an event is accepted, so a newly added destination never receives an event previously accepted by the application. Give each activation a distinct identity so remove/re-add cannot revive cancelled old deliveries. Coordinate shared changes and event admission atomically across Users; cancel deliveries not yet started when their activation is removed. Accepted waiting work survives restart/disablement and resumes when the Module is enabled, subject to that cancellation.
- Authenticate the exact raw request body against the existing subscription's HMAC secret, validate the configured subscription/environment and payload envelope, then durably accept before responding promptly. Never derive a Slack User's authorization from webhook data. Accept recognized and unknown well-formed event names without an event-type allowlist; unknown or sparse payloads use a literal event name and safe available resource identifier rather than raw data.
- Retain only the validated fields needed for approved notification content and recovery, excluding the raw signed payload and unnecessary personal data. Formatting is deterministic and uses no AI, Gmail or Yousign enrichment API calls. Preserve original names, escape untrusted text and suppress mention/link unfurl effects. Display event times in Europe/Paris using the shared French presentation rules.
- Deduplicate by integration and Yousign event identity. Save a distinct delivery checkpoint for each event/destination activation. Successful posts are never repeated by a webhook duplicate, job retry or restart while their recovery metadata is retained. A rejection known to have had no effect can retry; an ambiguous outcome is marked uncertain and never automatically resent. Review controls respect current channel visibility/access. A particular uncertain resend requires a separately saved User/DM-bound confirmation explaining its duplicate risk; competing/replayed confirmations cannot repeat that new attempt, and removal invalidates it.
- Retry temporary definite failures with bounded backoff and Slack rate-limit handling; record terminal/restricted-channel failures in status. One channel's failure must not prevent delivery to another. Alert on a newly detected unresolved channel/integration problem, rather than repeating the same alert for every affected webhook. Alerts themselves retain delivery recovery checkpoints and private-data filtering.
- Retain completed/failed/skipped event summaries and delivery metadata for 30 days. Never expire data needed by queued/running work; retain active shared configuration. This uses the current assistant retention convention rather than creating a lifetime event archive. Manual replay after deduplication metadata expires is outside the delivery guarantee. Status shows receipt/event times and per-destination outcomes only for destinations the viewer can access, without promising provider event ordering.
- Follow independent Module enablement: a disabled Module processes no jobs, registers no webhook/configuration routes, and pauses its cleanup while saved state is retained. Incoming events while its route is unavailable rely on Yousign's documented finite provider retries; the application cannot guarantee receipt of events never delivered to it.
- Use an explicit integration-owned work identity and shared transaction/lock boundary, preserving existing User-owned Module isolation. The [accepted ownership ADR](../../docs/adr/0005-shared-yousign-notifications.md) records the trade-off. Verification exercises signed DM routing, authenticated HTTP ingress, durable dispatch and fake Slack providers, with real PostgreSQL coordination tests available when a disposable test database is configured.

## Setup and release verification still required

- Configure the existing subscription's identity, production/sandbox environment and signing secret through Module-local environment configuration, required only when `yousign` is enabled. Use the existing HTTPS public origin with the proposed Module endpoint `POST /webhooks/yousign`; update the existing subscription's destination if needed. Do not create/manage another subscription or require a Yousign API key for this receive-only feature. No secrets are recorded in this specification or requested through the interview.
- Configure `SLACK_ADMIN_USER_ID` and invite the existing bot to intended channels. Live verification must establish the installed token's directory/posting scopes, User/bot access and channel posting restrictions, including private and externally shared channels.
- Authoritative contracts, the module guide, glossary, accepted ADR, README, environment example and deployment instructions now document this implementation. Follow [the release procedure](../../docs/deployment.md#yousign-release-candidate) for setup and live checks.
- Exercise webhook signature verification over exact raw bytes, wrong subscription/environment, malformed/unknown events, duplicate and empty-list receipt, destination snapshots/removal/re-add, cross-User shared selection, private visibility, successful and partial fan-out, definite/uncertain recovery, explicit resend approval, operator alert recovery, disabled-module behavior and cleanup. Include the public HTTP/DM/dispatch seams and use fake providers.
- Check active Node against `package.json` before runtime scripts. Run relevant tests plus `test`, `check` and `build` for implementation. Actual PostgreSQL coordination tests require disposable `TEST_DATABASE_URL`; report skips separately. Then verify consented live Yousign/Slack behavior and the confirmed Docker Compose deployment procedure. This design review is not a release candidate or observed deployment.

## Verified provider facts

Current official API v3 documentation says Yousign events have a globally unique `event_id`, and duplicate delivery is expected. The signed raw request body uses HMAC SHA-256 through `x-yousign-signature-256`. The receiving endpoint must respond quickly; the initial timeout is one second, making durable asynchronous processing relevant. These are provider facts, not approval of a complete recovery policy. See [handling webhooks](https://developers.youtrust.com/docs/use-webhooks-in-your-app) and [failure and retry policy](https://developers.youtrust.com/docs/failure-and-retry-policy).

`signer.done` describes one signer completing their action; `signature_request.done` describes the request completing after all required signers. The existing subscription's selected events remain unknown. See the [event list](https://developers.youtrust.com/docs/webhooks).

The official [webhook event schema](https://developers.youtrust.com/openapi/webhook-events.json) provides a signature request's `name`, `id` and status for the examined ordinary request/signer events. `signer.done` additionally includes that signer's first/last name and email. The request's embedded signer list has no signer names, and its document list has no document titles. Deletion events may supply only identifiers. No verified dashboard/document URL is provided by these schemas. Signing and approval links are recipient credentials, as described in the [signature-link guide](https://developers.youtrust.com/docs/manage-signature-link-delivery).

Slack's [users.conversations](https://docs.slack.dev/reference/methods/users.conversations/) documentation supports the existing User/bot intersection when using a bot token and a named User. [Posting](https://docs.slack.dev/reference/methods/chat.postMessage/) still may fail due to channel restrictions, lost access or rate limits. The official posting contract does not establish an indefinite idempotent-send guarantee; some processing can succeed before an error response. Externally shared channels may expose posted notifications to external members; they are permitted by the User's audience decision, not silently excluded.

## Repository constraints

Automatic channel notifications would extend the current private interaction contract. Existing signed Slack configuration controls can remain in DMs, while the Module owns authenticated webhook ingress and its own event/delivery state. The current durable queue assumes a Slack User; webhook receipt does not authenticate one. The system authorization boundary must be designed explicitly before implementation. See [module architecture](../../docs/adr/0002-private-assistant-modules.md) and [operation admission and locks](../../docs/adr/0003-operation-admission-and-module-locks.md).

## Comments

### 02/10/2026 — Interview round 1

The User chose “One shared company integration” and “One shared destination list.” In response to event selection, the User clarified: “The wwebhook is already created in yousign.” That establishes reuse of an existing webhook, without settling whether additional Module-side filtering is wanted.

### 02/10/2026 — Interview round 2

The User chose “All events,” “Everyone,” and “Yes same notification.” For destinations, the User said: “Any channels, we select the channel via the module (similarly to unanswered).” This settles event selection, shared management, identical broadcast content, and the channel-selector approach. Detailed notification presentation and delivery/configuration edge cases remain open.

### 02/10/2026 — Interview round 3

The User answered Q8 “Yes,” Q9 “Yes,” Q10 “Skip them,” Q11 “Yes,” and Q12 “Hide.” These accept the recommended fresh French summary, immediate explicit activation, skipping events with no destinations, private status plus designated-operator alerts, and hiding inaccessible destinations. Pending-work cancellation, recovery and alert-recipient selection remain to be settled.

### 02/10/2026 — Interview round 4

The User chose Q13 “Cancel waiting posts when removed,” Q15 “Use the existing operational-alert recipient,” and subsequently answered Q14 “Yes.” This accepts automatic recovery of known undelivered work while retaining selections and flagging uncertain outcomes. The decision frontier is empty; final complete-design confirmation is still pending.

### 02/10/2026 — Complete-design approval

The User confirmed the complete design and authorized implementation: “Yes it does, you can implement.” Prior pending-confirmation references are historical. The Yousign feature contract is authoritative from this point.

### 02/10/2026 — Local implementation delivered

Implemented authenticated receipt, shared private channel management, deterministic notifications, integration-owned durable delivery/recovery, uncertainty confirmations, private operational alerts and retention. Updated authoritative contracts, glossary, accepted ADR, module extension guide, environment example, README and deployment procedure. See [the dated verification record](../../docs/yousign.md#local-verification-record--02102026) for test results and outstanding live release checks. Changes remain local on `main`, uncommitted and unpushed.
