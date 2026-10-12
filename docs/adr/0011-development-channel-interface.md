---
status: accepted
---

# Operate Development in project channels and private conversations

The initial 12/10/2026 request moved Development into Slack channels; the User subsequently clarified that both channels and DMs must be supported. Extend the existing channel integration with explicitly opted-in commands and actions. Use module-scoped navigation so channel controls cannot reach private modules or shared budget screens. Recheck User and bot membership at durable dispatch, and restrict channel invocations to projects in the originating channel. Private invocations may access multiple projects after checking membership in each project channel. Channel forms fix their destination; DM forms offer a channel selector and recheck access to current and proposed destinations. Persist the originating conversation/thread separately from the selected project destination so confirmations never move into another conversation.

Channel messages are shared, but navigation, drafts and confirmations remain bound to their initiating User, channel and message. A ticket notice offers read-only public launchers so any member can create their own controls; it never authorizes work itself. DMs expose the same project, configuration, repository-selection and retry workflows through private menus. Private actions still modify shared project state, and ticket ingestion, clarification and worker reports retain their project-channel destinations. This extends the presentation choices in [native forms](0009-native-module-forms.md) and [repository routing](0010-shared-ticket-repositories.md) for Development alone. The [feature contract](../development.md#clickable-channel-interface) owns behavior and safeguards.
