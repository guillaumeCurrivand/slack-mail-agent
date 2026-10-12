---
status: accepted
---

# Operate Development in its project channel

On 12/10/2026 the User required Development to operate in Slack channels instead of DMs. Extend the existing channel integration with explicitly opted-in commands and actions. Use module-scoped navigation so channel controls cannot reach private modules or shared budget screens. Recheck User and bot membership at durable dispatch, and restrict every project read/write to the originating channel. The configuration form fixes its channel and persists the originating thread for asynchronous confirmation delivery.

Channel messages are shared, but navigation, drafts and confirmations remain bound to their initiating User, channel and message. A ticket notice offers read-only public launchers so any member can create their own controls; it never authorizes work itself. DMs retain static help and a channel handoff only. This supersedes the DM presentation choices in [native forms](0009-native-module-forms.md) and [repository routing](0010-shared-ticket-repositories.md) for Development alone. The [feature contract](../development.md#clickable-channel-interface) owns behavior and safeguards.
