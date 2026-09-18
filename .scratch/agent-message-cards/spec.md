Status: ready-for-agent
Category: enhancement

# Agent messages that can be told apart from User messages

## Problem Statement

In the Slack DM, User messages and Agent messages are both unstyled grey text. The person cannot tell at a glance which side spoke. Conversational Replies are a wall of prose, and workflow output (Preview, Details, Report, proposals, Help) looks like more chat they might have typed. The Connect authorization URL is also not a clickable link.

## Solution

Every Agent message is visibly constructed. A Reply uses sanitized markdown and no kind header. A Card uses a kind header, a short summary, lists, and the existing buttons. The model may write markdown only in a Reply. The engine formats every Card. Mentions, images, and links are stripped from model text. Email subject, from, and id are never parsed as markdown. The Connect URL the engine minted is a real https link.

## User Stories

1. As a Slack user, I want Agent messages to look unlike User messages, so that I can tell who spoke without studying avatars.
2. As a Slack user, I want conversational Replies to use bold, lists, headings, code, and quotes, so that I can scan an answer instead of a grey blob.
3. As a Slack user, I do not want a kind header on a Reply, so that a short back-and-forth does not shout a title on every turn.
4. As a Slack user, I want Help to be a Card titled Help, so that `hi` is not followed by another anonymous paragraph.
5. As a Slack user, I want an empty or missing conversational Reply to fall back to the Help Card, so that I still see commands rather than silence.
6. As a Slack user, I want Connect to be a Card titled Connect, so that the authorization step is obviously from the Agent.
7. As a Slack user, I want the Connect URL to be a clickable https link, so that I can open it without copying plaintext.
8. As a Slack user, I want mailbox confirmation to be a Card titled Confirm mailbox, so that Approve/Cancel sits on a labeled decision, not a chat line.
9. As a Slack user, I want my rules list to be a Card titled Your rules, so that a multi-rule dump is not mistaken for something I typed.
10. As a Slack user, I want an empty rules list to still be a Your rules Card, so that “no approved rules” is clearly Agent output.
11. As a Slack user, I want a rule add or replace Proposal to be a Card titled Rule proposal, so that I can see I am being asked to approve, not chatted at.
12. As a Slack user, I want a rule deletion Proposal to be a Card titled Remove rule, so that a destructive ask is distinct from an add/replace Proposal.
13. As a Slack user, I want Disconnect Gmail to be a Card titled Disconnect Gmail, so that the danger button is on a labeled confirm, not a chat line.
14. As a Slack user, I want a Preview to be a Card titled Preview, so that proposed mailbox actions look like a constructed summary.
15. As a Slack user, I want Preview counts (reviewed, labels, archive, trash, needs decision, new labels) as a short list, so that I can scan the proposal without parsing a paragraph.
16. As a Slack user, I want Preview to keep Review / Confirm / Cancel buttons, so that approval still happens on buttons, not in chat.
17. As a Slack user, I want Details to be a Card titled Details, so that a page of email items is obviously Agent output.
18. As a Slack user, I want Details to stay a readable numbered list of at most five items, so that I can move through a run without a table.
19. As a Slack user, I want the run id and page number in a small context line or the body, not in the kind header, so that the header stays the kind name.
20. As a Slack user, I want each Details item to show subject, from, message id, plan, reasons, and status, so that I can decide include/skip without losing information.
21. As a Slack user, I want a newsletter subject like `**FREE**` or `[click](http://evil)` to show as literal characters in Details, so that mail cannot style or link the Card.
22. As a Slack user, I want Include / Leave unchanged / Previous / Next / Confirm buttons on Details to keep working, so that paging and decisions do not change.
23. As a Slack user, I want a Report to be a Card titled Report, so that apply/undo outcome counts look like a constructed summary.
24. As a Slack user, I want Report to keep Details and Undo buttons when those actions are valid, so that follow-up does not move into chat.
25. As a Slack user, I want budget usage to stay an unlabeled Agent message, so that a one-line total is not dressed up as a Card.
26. As a Slack user, I want “Checking N inbox messages…” to stay unlabeled, so that a progress line is not titled; the Preview Card follows.
27. As a Slack user, I want one-line acks such as Proposal cancelled, Connected, Gmail disconnected, and Run status to stay unlabeled, so that short confirmations are not Cards.
28. As a Slack user, I want errors such as “This request could not finish…” to stay unlabeled, so that a failure is not a titled Card.
29. As a Slack user, I want the short correction note after a Preview to stay unlabeled, so that “this does not change future behavior” is a follow-up line, not a second Card title.
30. As a Slack user, I want the starters project-mapping follow-up after a Rule proposal Card to stay unlabeled, so that only the Proposal is the Card.
31. As a Slack user, I want the model’s Reply to be allowed standard markdown (bold, italic, lists, headings, code, quotes), so that talk is readable.
32. As a Slack user, I do not want a Reply to mention me, `@channel`, or `@here`, even if the model emits Slack mention syntax, so that talk cannot ping people.
33. As a Slack user, I do not want a Reply to render images or markdown/autolinks the model invented, so that talk cannot plant a destination.
34. As a Slack user, I want engine-owned https Connect links to remain clickable after sanitizing, so that the muzzle does not break authorization.
35. As a Slack user, I want interpolated Card values (email subject/from/id, rule names, conditions, amounts, run ids) escaped, so that only engine-authored markup renders.
36. As a Slack user, I want the Agent to keep responding in my language in a Reply, so that formatting does not English-only the conversation.
37. As a Slack user, I want Slack notifications and screen readers to get a plain fallback of the Agent message, so that I still understand it outside the Block Kit body.
38. As a Slack user, I want existing approval buttons (primary / danger) unchanged in meaning, so that I do not relearn how to confirm or refuse.
39. As a Slack user, I do not want another user to see or act on my Cards, so that formatting does not weaken owner isolation.
40. As a Slack user, I want Help, Your rules, Preview, Details, and Report to remain accurate after formatting, so that prettier output does not drop counts, ids, or commands.
41. As a Slack user, I do not want App Home, canvases, or a data table, so that this stays a DM Card/Reply change.
42. As a Slack user, I do not want every Reply stamped Mail Sorter in a kind header, so that Slack’s existing app name/avatar stays the identity for talk.
43. As a Slack user, I want the team AI allowance alert to stay an unlabeled Agent message, so that an operational ping is not a titled Card.
44. As a Slack user, I want “unsupported action” and similar engine refusals to stay unlabeled Replies, so that a stray button press is not a Card.
45. As a developer of the Agent, I want the model instructed that it may use standard markdown in `reply` and must not emit mentions or links, so that Replies are written for the markdown block, not Slack mrkdwn.
46. As a developer of the Agent, I want the model never to layout a Preview, Details, or Report, so that run output cannot drift from engine Cards.
47. As a developer of the Agent, I want conversation history to store the Reply markdown source, so that later turns still see what was said.
48. As a developer of the Agent, I want `parse: none` and disabled unfurling kept on post, so that leftover angle-brackets or URLs in fallback text do not become mentions or unfurls.

## Implementation Decisions

- Widen the existing Messenger contract. Engine already depends on `send(actor, text, buttons?)`. Change it so Engine sends a structured Agent message: a Reply or a Card, plus optional buttons. Do not add a second outbound path.
- A Reply has no kind header. Its body is the model (or unlabeled engine) string, run through the Reply sanitizer, posted as a Slack `markdown` block.
- A Card has a kind header (Slack `header` block, plain text, kind name only), then engine-authored markdown/lists for the summary and items, optional context line for run id / page, then the existing actions block.
- Kind headers, exactly: Help, Connect, Confirm mailbox, Your rules, Rule proposal, Remove rule, Disconnect Gmail, Preview, Details, Report.
- Unlabeled (Reply-shaped, engine prose, no kind header, no model markdown required): budget, scanning, one-line acks, errors, the correction follow-up, the starters mapping follow-up, operational spend alert, engine refusals.
- Starters still sends a Rule proposal Card and then the unlabeled mapping prompt.
- Correction still sends a Preview Card and then the unlabeled “does not change future behavior” line.
- Slack `section` `mrkdwn` is not used. Legacy attachments, tables, App Home, canvases, streaming, and `chat:write.customize` are not used.
- Reply sanitizer allowlist: bold, italic, lists, headings, code, quotes, strikethrough. Strip Slack mentions (`<@id>`, `<!channel>`, `<!here>`, `<!everyone>`, `<#channel>`), images, markdown links, autolinks, and raw `<http...>` / `<mailto...>` sequences. Do not allow model https links.
- Connect is the only clickable link: the engine inserts its minted https URL into the Connect Card after sanitizing other text.
- Card interpolation: values that did not originate as engine markup (email subject/from/id, rule name/condition/senders/labels, dollar amounts, run ids, status words from storage) are escaped so markdown in those strings does not render. Engine template punctuation (list markers, labels like `From:`) is markup.
- Keep posting `chat.postMessage` to the DM channel with fallback `text` (escaped, truncated as today), `unfurl_links: false`, `unfurl_media: false`, `parse: 'none'`. Fallback `text` is a plain reading of the same content for notifications and accessibility, not a second formatted body.
- Buttons keep the same `action_id` / `value` / `primary` / `danger` contract. Layout must not exceed Slack’s 50-block message limit; a Card is a handful of blocks, not one block per email field.
- Update the converse instructions so the model may use standard markdown in `reply` (not Slack mrkdwn), must not mention people or include links, and still must not claim actions or layout runs.
- No schema or store changes. History continues to store the Reply string the model returned.
- Record the safety trade-off in an ADR when implementing: Cards and Replies replace all-`plain_text` posting, but the mention/link muzzle stays via sanitizing and escaping rather than via `mrkdwn` sections.

## Testing Decisions

A good test asserts what the person (or Slack) would observe: which Agent message was sent (Reply vs Card, kind header, buttons), whether a mention/link/image survived, whether an email subject rendered as markup, whether the Connect URL is a link. Tests do not assert Block Kit JSON field order, helper function names, or chunk sizes except where Slack’s documented limits would change user-visible behavior.

**Seam (one, existing, widened):** Messenger. Engine is already tested by recording `send` on a fake Messenger. Keep that as the highest seam: after `Engine.handle`, inspect the structured Agent messages (kind header or Reply, body text, buttons). Do not post to Slack in Engine tests.

**Encoding seam, same contract:** the Slack Messenger implementation is tested with a fake `fetch`. Given a Reply or Card, assert the `chat.postMessage` body: `markdown` vs `header` blocks, sanitizing, escaped email fields, clickable Connect URL, fallback `text`, `parse: 'none'`, unfurl flags, actions block. There are no Slack HTTP tests today; this is the first, still against Messenger, not a new outbound port.

Prior art: workflow tests build a fake Messenger that records `{ actor, text, buttons }` and assert mailbox/approval behavior. Update that fake to the widened contract and keep those workflow assertions (isolation, uncertain include/skip, conflict, undo). Add focused Engine examples for Help / Preview / Details / Report / Connect / Rule proposal / unlabeled budget. Add Slack encoding tests next to the existing security tests’ style (fake boundary, assert payload), not by spinning the HTTP server.

Do not require live Slack or Block Kit Builder. Do not snapshot entire payloads unless a single field assertion is insufficient.

## Out of Scope

- App Home, modals, canvases, streaming, video, charts.
- Slack `table` / data table blocks; Details stay a paged list.
- `section` `mrkdwn`, legacy colored attachments, per-message username/icon (`chat:write.customize`).
- Kind headers on budget, scanning, acks, errors, alerts, or every Reply.
- Model-authored layout of Preview, Details, Report, or other Cards.
- Allowing the model to emit links or mentions in a Reply.
- Changing Gmail behavior, rules, approvals, budgets, or button action ids.
- Changing the Slack app display name or avatar.
- Rewriting conversation history format or retention.

## Further Notes

Domain terms live in `CONTEXT.md`: User message, Agent message, Reply, Card, kind header, Preview, Details, Report, Proposal, Connect.

This spec is the grilled design. Implementation should not reopen App Home, tables, or full `mrkdwn` unless a new decision is recorded.

The current Slack adapter posts `plain_text` sections specifically so model and email content cannot mention people or invent links. Replacing that with a `markdown` block is correct only if the sanitizer and Card escaping are tested; posting model text as `mrkdwn` is a regression.
