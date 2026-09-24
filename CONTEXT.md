# Private Slack assistant

The Agent offers capabilities through one Slack bot, with private interactions for each person. Mail Sorter is its first Module.

## Language

**Agent**:
The Slack assistant a person interacts with privately across its Modules.
_Avoid_: Mail Sorter (when referring to the whole assistant)

**Module**:
A named capability of the Agent with its own commands and behavior.

**Module prefix**:
The name at the beginning of a User message that explicitly selects the Module handling the request, such as `mail` in `mail sort`.

**Mail Sorter**:
The Module that sorts a person's connected Gmail using their approved rules.

**Slack Unanswered**:
A Module that privately lists unanswered messages from a person's selected Slack channels.

**Unanswered message**:
A channel message containing a mention, request, or question for which the listed person has not yet replied in the same thread.

**Possibly for you**:
A group of unanswered messages whose thread context suggests they may concern the recipient, though it does not establish that clearly.

**User message**:
A Slack DM the person typed.
_Avoid_: user bubble, human message

**Agent message**:
A Slack DM posted by the Agent.
_Avoid_: bot message, chatbot reply, bot answer

**Reply**:
A conversational Agent message with no kind header. It may use sanitized markdown.
_Avoid_: chatbot response, bot answer

**Card**:
A workflow Agent message with a kind header. The person is meant to recognize it as constructed, not as chat they typed.
_Avoid_: Block Kit message, rich message, bot card

**Kind header**:
The title on a Card that names what it is.
_Avoid_: title, subject, heading (those collide with email subject and markdown headings)

**Preview**:
The Agent's proposed mailbox actions for one run, before anything is applied.

**Details**:
A paged list of email items in a run.

**Report**:
The outcome counts for a run after apply or undo.

**Proposal**:
A pending rule change, rule deletion, or mailbox connection that still needs the person's approval.
_Avoid_: draft (implementation word)

**Connect**:
The Agent message that gives the person a single-use mailbox authorization link.
