# 02: Help Card

**What to build:** `hi`, `help`, and an empty conversational Reply show as a Card titled Help. Ordinary talk still has no kind header. Slack can encode a Card: kind header, engine markdown body, optional buttons.

**Blocked by:** 01 Markdown Replies with the mention/link muzzle

**Status:** ready-for-human

- [x] `hi` and `help` send a Card whose kind header is exactly `Help`
- [x] An empty or missing model Reply falls back to the same Help Card, not a blank message and not an unlabeled Reply
- [x] The Help body still lists the commands and how approval works; nothing is dropped
- [x] A normal conversational Reply still has no kind header
- [x] Slack encodes a Card as a `header` block (plain text, kind name only) plus markdown body; `section` `mrkdwn` is not used
- [x] Engine tests assert Help is a Card; Slack encoding tests assert header + markdown (+ actions when present) on a Card
