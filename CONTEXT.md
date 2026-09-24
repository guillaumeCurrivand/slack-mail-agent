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

**Tasks**:
A future Module that identifies requests addressed to a person in selected Slack channels they can access, with or without an @mention, and presents their task list privately.

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
