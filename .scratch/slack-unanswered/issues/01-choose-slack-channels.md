# 01: Choose channels for Slack Unanswered

**What to build:** Each user can choose the public and private Slack channels they want Slack Unanswered to search, using `slack channels`. Channel choices are private to that user and the bot only offers channels both can access.

**Blocked by:** None (can start immediately).

**Status:** resolved

Implemented locally; live Slack verification remains pending.

- [x] `slack channels` privately lists public and private channels the user belongs to and the bot can access; group DMs are excluded.
- [x] Channel selection starts empty. The user can select and remove channels, and selections persist separately for each workspace user.
- [x] The channel list and selections do not expose another user's saved choices.
- [x] A temporary loss of channel or bot access does not silently remove the user's saved selection; only the user can remove it.
- [x] The channel-selection workflow works without Gmail credentials or Mail Sorter state.
- [x] Exercise the signed Slack DM through durable enqueue, worker dispatch, and private response using fake Slack channel data.
