# 01: Markdown Replies with the mention/link muzzle

**What to build:** Talk and unlabeled Agent messages post as Replies. They use a Slack markdown block, have no kind header, and cannot mention people or plant links. The model may write standard markdown in a Reply. Notifications get a plain fallback.

**Blocked by:** None (can start immediately)

**Status:** ready-for-human

- [x] A conversational Reply is posted as a Slack `markdown` block with no kind header
- [x] Unlabeled Agent messages (budget, scanning, one-line acks, errors, spend alert, engine refusals, correction follow-up, starters mapping follow-up) are Replies, not Cards
- [x] Allowed Reply markup renders: bold, italic, lists, headings, code, quotes, strikethrough
- [x] Slack mentions (`<@id>`, `<!channel>`, `<!here>`, `<!everyone>`, `<#channel>`), images, markdown links, autolinks, and raw `<http…>` / `<mailto…>` sequences are stripped from Reply text
- [x] Fallback `text` is a plain reading of the same content; `parse: none` and unfurl flags stay off
- [x] Converse instructions allow standard markdown in `reply`, forbid mentions and links, and still forbid claiming actions or laying out a run
- [x] Conversation history still stores the Reply string the model returned
- [x] Existing workflow approval behavior still passes against the widened Messenger contract
- [x] An ADR records that `plain_text` posting is replaced by sanitized markdown, not by `section` `mrkdwn`
