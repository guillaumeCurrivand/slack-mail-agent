# OpenAI fit for the Slack Gmail agent

Research date: 2026-09-17. These are interview research notes, not an approved implementation plan.

## Verified capabilities

OpenAI Structured Outputs supports responses constrained to a supplied JSON schema, including schemas defined through supported SDK helpers. Refusals, incomplete responses, and unsupported schemas still require explicit handling. Schema validity does not establish that an email classification is correct. [Official Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs)

API inputs and outputs are not used for model training by default unless the customer opts in. Default abuse-monitoring logs can retain customer content for up to 30 days, with exceptions stated in the documentation. The Responses API ordinarily stores application state when storage is enabled; using `store: false` does not by itself mean zero retention. Some caching and feature behavior has additional retention rules. [Official data controls guide](https://developers.openai.com/api/docs/guides/your-data)

## Proposed use in this application

Use the API for Slack conversation, translating user requests into proposed rules, and semantic email classification. Implement exact sender matching in application code. Classifications should identify matched rule IDs and short explanations, not grant the model direct control of Gmail.

Application code should enforce user/workspace ownership, allowed actions, explicit confirmation of a specific preview, rule precedence, and undo. Email bodies are input to classify, not instructions authorizing tool calls or changing rules. Gmail credentials should remain in the application, outside model prompts.

Keep application conversation state per user, and consider `store: false` for provider calls. The agreed application policy of retaining conversation and action records for 30 days is distinct from provider, Slack, and backup retention.

These architecture statements are design recommendations, not claims that the provider supplies mailbox isolation or approval enforcement automatically.

## Still open

- Exact model and costs: choose after testing representative anonymized examples, especially urgent newsletters and overlapping project senders.
- Budget: the user approved usage limits and spending alerts, but has not provided a monthly amount.
- TypeSafe: see the separate evaluation before selecting a second classification provider.
- Starting-rule exceptions and final shared-understanding confirmation are still pending. No app has been implemented or deployed.
