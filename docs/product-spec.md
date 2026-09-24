# Private Slack assistant — current product specification

Status: approved by the user after the design interview. An initial local implementation and automated tests are available; live integration and model-quality validation remain release requirements. Deployment and purchasing services are not authorized by this document.

## Approved module extension

The user subsequently approved preparing this assistant for multiple built-in modules in one bot, with private interactions per user. Mail Sorter is the only implemented module. Its Gmail behavior below remains applicable; new DM requests now require the `mail` prefix, including natural language (`mail sort`, `mail change my newsletter rule`). There is no remembered active module or AI-based routing. Shared `help` and `budget` commands require no module prefix.

Modules are maintained in this repository and deployed together, with independent enablement, connection requirements, and user data. All modules share the existing $10 monthly AI ceiling, with usage tracked by module. Disabled modules do not execute work; saved state and pending jobs remain for re-enablement. Existing queued mail work and previously posted mail buttons retain their approval and ownership safeguards.

Tasks remains future work. Its agreed direction and unresolved decisions live in [the future Tasks brief](future/tasks-module.md); it is not part of the current implementation scope. See [the architecture decision](adr/0002-private-assistant-modules.md) for rationale and [module guide](adding-a-module.md) for implementation conventions.

## Audience and access

- One Slack workspace, serving the user's team of 10.
- Interaction exclusively in private messages with the bot.
- Each Mail Sorter user connects at most one personal-to-them Google Workspace Gmail account; connecting Gmail is not required to use the assistant's shared commands or future independent modules.
- Each user has separate Gmail authorization, rules, project mappings, conversation history, previews, and action records.
- No shared team rules in version one. Team administrators may manage availability and connection health through the product but cannot browse other users' mail, rules, or conversations through it.
- Application-level isolation is required; this is not a promise that infrastructure operators or external platform administrators have no technical access.

## Rules and conversation

- Users define rules conversationally, including objective conditions and semantic judgments.
- The agent restates a proposed rule precisely and shows examples before the user approves saving it.
- Corrections apply to the relevant message; proposed changes to future behavior require separate rule approval.
- Project sender mappings are user-defined. If a sender belongs to multiple projects, apply an approved subject/content disambiguation rule or ask the user.
- Reuse existing Gmail labels where possible. Include proposed new labels in the run preview before creating them.

## Processing and approvals

1. A user explicitly requests sorting. There is no scheduled or automatic processing in version one.
2. Select the latest 100 individual inbox messages, or all available if fewer exist.
3. Read sender, subject, and email body. Do not inspect attachments or open linked pages.
4. Evaluate that user's approved rules and present a preview of proposed label, archive, and Trash actions. Show proposed Trash actions separately.
5. Put uncertain classifications in a separate Needs your decision group. Do not apply them as though they were confirmed matches.
6. Require confirmation before applying the preview. Approval must belong to the same user and identify the specific run being approved.
7. Apply changes to individual messages, not whole conversations.
8. Report counts and provide details explaining which rules affected each message. Offer undo for the agent's changes.

Multiple labels may apply to one message. Explicit keep-in-inbox rules override archiving. Unresolved contradictions leave the message unchanged and are explained to the user. The starter newsletter rule also excludes urgent and project-related messages from Trash.

Archive is available for user-defined rules, although none of the initial templates archives by default. Permanent deletion and sending email are outside the agreed version-one actions.

## Suggested starting rules

Templates are offered during onboarding; each user approves their own copy before use.

1. **Urgent:** when a message requires time-sensitive attention, apply `Urgent` and leave it in the inbox.
2. **Projects:** when the sender matches an approved project mapping, apply `Projects/<project name>` and leave it in the inbox. Ambiguous mappings require a decision.
3. **Newsletters:** move recurring promotional newsletters and digests to Trash after run confirmation. Exclude receipts, invoices, security alerts, and messages matching an urgent or project rule.

## Memory and undo

- Retain approved rules and mappings until the user removes them.
- For enabled modules, prune application conversation history and action records older than 30 days. Disabling a module pauses its cleanup and preserves its state for re-enablement, so records can remain beyond 30 days while disabled. Cleanup resumes when the module is enabled again.
- Fetch email content when needed rather than retaining a permanent mailbox copy. Conversation history may itself contain excerpts discussed by the user; it follows the conversation retention policy.
- Undo concerns only changes performed by this agent. It must avoid overwriting unrelated later mailbox changes and report changes that cannot be restored.
- Gmail's Trash lifecycle limits recovery: messages are normally permanently deleted after 30 days in Trash, and may be deleted sooner by the user. [Google documentation](https://support.google.com/mail/answer/7401?hl=en)
- Slack, AI-provider, and backup retention are separate from the application's active-record retention policy.

## AI provider and budget

- OpenAI for version one. Exact model remains an implementation choice to validate against classification quality and cost.
- Keep the classification component replaceable so TypeSafe Jev can be evaluated later. No TypeSafe integration is required for version one.
- **AI budget: $10 per calendar month across all 10 users combined. Hosting is separate.**
- Alert at $8 and prevent new paid AI work from exhausting the remaining allowance; retain access to functions that do not require paid AI calls.
- Track both conversational and classification usage, including retries. Reserve an estimated upper bound before dispatching requests so concurrent users cannot each spend the same remaining allowance.
- Per-user usage controls should be configurable. No specific per-user dollar allocation or daily run quota was agreed.
- This is a spending constraint, not a promise that $10 funds unlimited runs or a particular monthly message volume. Model pricing, token use, and realistic examples must be measured before estimating capacity.

## Hosting requirements

The user will choose the provider. No Render or other host commitment remains.

- Public HTTPS application endpoint for Slack events and Google authorization callbacks.
- Application runtime with background processing; initially the same persistent service can handle HTTP and a bounded job loop.
- PostgreSQL for durable per-user state, queued jobs, previews, action records, and encrypted Gmail credentials.
- Secure secret configuration, encryption-key management, persistent storage, and backups.
- Outbound connectivity to Slack, Google, and OpenAI.
- Initial single-server sizing proposal: 1 vCPU, 2 GB RAM, and 10 GB persistent disk if the application and database share the server. This is an unbenchmarked starting estimate, not a minimum-capacity guarantee. No GPU is required.

## Implementation requirements derived from the agreed behavior

These are engineering consequences, not additional user-facing capabilities:

- Enforce user and workspace ownership in application/database access, not only in prompts.
- Keep Gmail tokens out of AI prompts. Treat email text as data to classify, never as instructions authorizing actions or rule changes.
- Persist pending work and execution checkpoints so restarts do not lose runs. Handle duplicate events and confirmations without repeating mailbox changes.
- Bind approval to the saved preview and rule version. Recheck affected message state before changes, reporting messages that changed or became unavailable.
- Store enough before/after state for targeted undo and partial-failure reporting.
- Distinguish classification confidence from authorization; a model score never replaces user confirmation.

## Before implementation and release

The interview's final shared-understanding confirmation has been received. Release still needs model evaluation, live integration verification, and a concrete hosting configuration when the user selects infrastructure. Slack/Google application setup and credentials have not been created or requested, and no real mailbox has been accessed.

Supporting research: [TypeSafe](research/typesafe-evaluation.md), [OpenAI](research/openai-fit.md), and [previous hosting comparison](research/hosting-options.md). The prior hosting comparison is background research, not a current provider decision.
