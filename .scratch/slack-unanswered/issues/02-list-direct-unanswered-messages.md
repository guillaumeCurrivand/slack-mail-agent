# 02: List direct unanswered Slack messages

**What to build:** A user can run `slack unanswered` to privately see recent messages from their selected channels that directly mention them by Slack @mention, display name, full profile name, or first name, as long as they have not replied in the message's thread.

**Blocked by:** 01: Choose channels for Slack Unanswered.

**Status:** ready-for-agent

- [ ] Search runs only when requested and considers candidate messages posted within the preceding rolling 48 hours from selected channels the user and bot can access.
- [ ] Include messages that @mention the user or contain their Slack display name, full profile name, or first name, whether or not the message is itself a request.
- [ ] If first-name matches could refer to multiple users, show the result for each matching user who is eligible to search that channel.
- [ ] Use the full thread, including older replies, to check whether the user posted any later message. Exclude a result after the user replies, regardless of reply wording.
- [ ] Exclude messages authored by the user from their own list.
- [ ] Skip a selected channel that is currently inaccessible, explain the skipped source privately, and retain the user's selection.
- [ ] Send results only in the user's private conversation with the assistant. Group results by channel, newest first, and show an excerpt, author, time, and source-message link; paginate long lists.
- [ ] Derive results from current Slack state without creating message/task records or separate done/dismiss controls.
- [ ] Exercise the signed Slack DM through durable enqueue, worker dispatch, module handling, and private response using fake Slack history. Cover per-user isolation, time-window boundaries, thread replies, matching names, grouping, and pagination.
