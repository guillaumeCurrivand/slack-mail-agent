# Sanitized markdown Replies, not mrkdwn sections

Status: superseded by [ADR 0007](0007-clickable-displayed-links.md) for link handling. Mention sanitization and the choice of Slack markdown for Replies still apply.

Agent messages used `plain_text` sections so model and email content could not mention people or invent links. Conversational Replies moved to Slack `markdown` blocks so standard markdown could render. At this decision point, sanitization blocked both mentions and links rather than using `section` `mrkdwn`; [ADR 0007](0007-clickable-displayed-links.md) later changed link handling while retaining mention sanitization.
