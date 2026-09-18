# Sanitized markdown Replies, not mrkdwn sections

Agent messages used `plain_text` sections so model and email content could not mention people or invent links. Conversational Replies now post as Slack `markdown` blocks so standard markdown can render. Mentions and links stay blocked by sanitizing, not by using `section` `mrkdwn`, which would reintroduce Slack mention syntax and a different markup dialect than the model is instructed to write.
