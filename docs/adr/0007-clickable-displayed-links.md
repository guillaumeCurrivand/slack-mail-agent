# Clickable displayed web links

Status: accepted

The User chose to make every displayed valid HTTP(S) web link clickable, including links in AI-generated and other untrusted text, reversing the link suppression in [ADR 0001](0001-sanitized-markdown-replies.md). Labeled links keep their labels without an adjacent destination, even though a misleading label can conceal another site. The shared Slack renderer keeps mentions inactive, rejects unsafe schemes, and disables link unfurling; Module contracts still decide which source URLs may appear at all.
