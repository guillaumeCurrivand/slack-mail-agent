# Slack Unanswered module spec

Status: approved feature spec; channel selection, direct mention/name search, and contextual matching are implemented locally but disabled by default. Live Slack access and model-quality validation remain release work. It uses the existing assistant and works without connecting Gmail. The [product specification](product-spec.md) owns assistant-wide behavior and safeguards; this document owns the Slack Unanswered feature contract. Extension conventions are in [Adding a module](adding-a-module.md).

## Problem Statement

People can miss Slack messages that mention them, ask them a question, or request their help. They need a private, current view of messages that still appear to need a reply, without searching every channel manually or treating every channel message as theirs to handle.

## Solution

Add a `slack` module with a `slack unanswered` command. Users choose the public and private channels to search with `slack channels`; the bot must also have access, and group DMs are excluded. The command searches on demand for messages posted during the preceding rolling 48 hours and returns matching messages privately, grouped by channel.

Separate clear matches from **Possibly for you** messages whose thread context gives a specific reason they may concern the user without establishing that they are the intended recipient. The list reflects current Slack thread state: a user's later message in a thread removes earlier requests from future lists. A subsequent question or request directed back to the user is a new unanswered message. The feature does not create or manage separate task records.

## User Stories

1. As a Slack user, I want to select the public and private channels I belong to and the bot can access, so that the search uses sources I chose.
2. As a Slack user, I want channel selection to start empty, so that the module reads no channel history before I opt in.
3. As a Slack user, I want to see channels available to both me and the bot when I run `slack channels`, so that I can choose valid sources.
4. As a Slack user, I want to remove previously selected channels, so that I can stop including them in future searches.
5. As a Slack user, I want a selected channel that becomes inaccessible to be skipped with an explanation, while remaining selected, so that restored access can work without reconfiguration.
6. As a Slack user, I want to run `slack unanswered` whenever I choose, so that the module does not read channels on a schedule.
7. As a Slack user, I want the search to include messages posted in the rolling 48 hours before the command, so that the list remains recent regardless of the time of day.
8. As a Slack user, I want messages that @mention me and have no later reply from me in the thread, so that direct pings needing a response are easy to find.
9. As a Slack user, I want messages containing my Slack display name, full profile name, or first name and no later thread reply from me, so that people who address me without an @mention can still reach my list.
10. As a Slack user, I want a first-name match to appear for every user who shares that name, so that the module does not guess which person was intended.
11. As a Slack user, I want a clearly directed question or request to appear while I have not replied in its thread, so that I can find messages that need my response even without an explicit name match.
12. As a Slack user, I want a vague request to appear under **Possibly for you** only when its thread gives a specific reason it may concern me, so that useful but uncertain matches do not look confirmed.
13. As a Slack user, I want generic requests with no contextual link to me to stay out of my list, so that channel-wide questions are not attributed to me without evidence.
14. As a Slack user, I want any later message I post in a matching message's thread to remove it from future lists, regardless of the reply's wording, so that I do not need a separate completion control.
15. As a Slack user, I want older replies in a thread to inform matching and response checks, so that the module can interpret recent messages using their existing context.
16. As a Slack user, I want messages I authored to stay out of my own list, so that the module shows messages from others that may need my reply.
17. As a Slack user, I want results grouped by channel and sorted newest first within each channel, so that I can review each source in a predictable order.
18. As a Slack user, I want each result to show a short excerpt, author, time, and a link to the source message, so that I can understand it and open its context.
19. As a Slack user, I want long channel lists to be paginated, so that the results remain readable in Slack.
20. As a Slack user, I want results sent only to my private conversation with the assistant, so that channel excerpts are not reposted to other people.
21. As a Slack user, I want clear mention and name matches to remain available when the shared AI budget cannot fund uncertain matching, so that deterministic results are still useful.
22. As a Slack user, I want the assistant to explain when the shared budget prevents it from checking **Possibly for you**, so that an incomplete uncertain-results section is not mistaken for a negative search.
23. As a Slack user, I want Slack Unanswered to work without connecting Gmail, so that using this module does not require another module's account.
24. As a Slack user, I want a new question or request for information or action after my reply to appear as a new result linked to that follow-up message, even without another mention, so that a continuing exchange is not lost.
25. As a Slack user, I want separate follow-up requests to appear separately until I post again in their thread, so that each new request remains visible under the existing response rule.
26. As a Slack user, I want acknowledgements after my reply, including a simple thanks that mentions me, to stay out of the list, so that courtesy replies are not mistaken for new work.
27. As a Slack user, I want a follow-up from another participant to appear when the thread clearly directs it to me, with uncertain recipients under **Possibly for you**, so that the feature follows the conversation rather than only its original author.
28. As a Slack user, I want a follow-up answered by someone else to disappear when that answer clearly resolves it, or appear under **Possibly for you** when resolution is uncertain, so that the list reflects whether my reply is still needed.

## Implementation Decisions

- Implement the capability as the built-in module with the stable prefix `slack`. `slack unanswered` performs the search; `slack channels` manages a user's selected sources.
- Keep channel selection per Slack user and workspace. Start with no selected channels. Enforce that each selected channel is accessible to both that user and the bot when listing and searching it.
- Search read-only. Include candidate messages whose own timestamps are within the rolling 48-hour window. Fetch the complete relevant thread, including older replies, to assess matches and whether the user responded.
- Treat Slack message text and thread replies as untrusted content. They may inform classification but cannot authorize actions or alter module settings.
- Classify clear @mentions and profile-name matches as **Unanswered for you** when the user has not posted later in the thread. A first-name match may produce a result for multiple users with that name. Outside a follow-up exchange, retain the existing direct-match behavior.
- Treat each question or request posted after the user's reply as a potential new unanswered message, including one from the original asker or another participant. Link each result to its own message. Any subsequent message from the user clears earlier requests in the thread regardless of wording. Exclude simple acknowledgements after the user's reply, even if they mention the user.
- Use AI through the existing shared budget for requests, questions, follow-up resolution, and thread context that cannot be resolved deterministically. Keep uncertain but contextually relevant candidates in **Possibly for you**. Exclude generic requests without a specific contextual connection and follow-ups clearly resolved by another participant. Narrowly filter obvious follow-up acknowledgements without AI.
- Attribute paid AI calls to `slack`. If budget or the provider is unavailable, retain direct mention/name results, filter obvious acknowledgements, and disclose that contextual matching and follow-up resolution were not fully checked.
- Build the response privately using the existing Slack messenger, grouping results by channel, newest first, and paginating when needed. Include an excerpt, author, time, and source-message link.
- Persist per-user channel selections. Derive unanswered state from Slack at each search; do not persist a second task/message record or add done, dismiss, reopen, due-date, or reminder state. Keep AI execution checkpoints keyed to the queued event so a retry never blindly repeats a paid call; these hold classification IDs, decisions, and short reasons rather than full Slack messages. Remove them after 30 days once their jobs are no longer active.
- If a selected channel becomes unavailable, skip it for that search, explain the issue privately, and preserve the selection.
- Do not require Gmail credentials or instantiate mail services for this module. Use only the Slack permissions needed to list eligible channels and read selected channel/thread history.

## Testing Decisions

Good tests exercise observable behavior and safeguards through the highest useful public boundary. For this feature, exercise a signed Slack DM command through enqueue, worker dispatch, module handling, and private response delivery. Use fake Slack history and AI providers; do not access live channels or make paid AI calls in automated tests.

Cover channel selection and removal, per-user isolation, user-and-bot access filtering, unavailable-channel behavior, the rolling 48-hour boundary, older thread context, later user replies, repeated follow-up requests, acknowledgements with mentions, new asks from other participants, answers from other participants, message authorship, name collisions, both result groups, generic-request exclusion, pagination and links, private delivery, and shared-budget exhaustion with a clear incomplete-results notice. Also verify the `slack` prefix routes to the module and disabled-module requests do not execute it.

Prior art includes `tests/modules.test.ts` for routing, durable dispatch, module isolation, and shared budget behavior; `tests/workflow.test.ts` for fake external providers and budget failure behavior; and `tests/slack.test.ts` for Slack message formatting and sanitization. Prefer extending these seams over adding lower-level-only tests.

## Out of Scope

- Group DMs, one-to-one DMs, channels the user has not selected, and channels the bot cannot access.
- Scheduled or background discovery.
- Persistent task tracking, accepting, completing, dismissing, reopening, reassignment, due dates, or reminders.
- Sending a response or changing any Slack message.
- Generic unassigned requests with no thread context connecting them to the user.
- Connecting Gmail or changing Mail Sorter behavior.
- Live workspace setup, granting Slack permissions, or deployment in this spec.

## Further Notes

The app currently handles private DMs only. Slack Unanswered is implemented locally. Search scans selected channel history on demand, including older thread roots that have recent replies; large or long-lived channels can make this slow and encounter Slack rate limits. Contextual matching sends relevant thread text to the configured OpenAI model through the shared budget. Without `OPENAI_API_KEY` or available budget, direct results remain available and the response explains that contextual results were not fully checked. The required history/profile permissions, live Slack-provider behavior, and model quality remain to be verified after installation. Channel selection and access checks must preserve the product's user-ownership boundary. Slack platform retention and AI-provider retention remain separate from this application's retained state.
