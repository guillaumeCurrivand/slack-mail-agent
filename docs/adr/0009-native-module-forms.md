---
status: accepted
---

# Exchange native Slack form triggers before queued work

The User requested complete Development project configuration in the interface. [Slack modal triggers expire after three seconds](https://docs.slack.dev/surfaces/modals/), so enqueueing their exchange behind provider work would make opening a form unreliable. Add an opt-in Module form boundary to signed ingress: only exchange an owner/DM/message-bound prepared draft's trigger immediately; acknowledge submissions after local validation and atomic durable enqueue. Keep channel/ClickUp checks, saved confirmations and shared project mutations in the normal worker path. Shared runtime knows form routing, not Development's fields or persistence.

Prepared values are private snapshots, not renewed access grants. They may be shown while their 24-hour draft is valid, but saving requires fresh access checks and a compare-and-set against the original project. Persist a modal-opening receipt before contacting Slack to avoid replaying uncertain opens, and commit each configuration change together with its terminal confirmation outcome. See the [current feature contract](../development.md#clickable-private-interface) for user behavior and limits.
