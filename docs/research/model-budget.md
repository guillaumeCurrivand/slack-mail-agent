# OpenAI model and $10 monthly budget

Checked 2026-09-17 against official OpenAI documentation. This is an implementation recommendation, not a measured quality evaluation or a promise of a fixed number of mailbox scans. No real API calls or mailbox data were used in this research.

## Recommended baseline

Use `gpt-4.1-mini-2025-04-14` for both conversational rule proposals and semantic classification. Its published standard text prices are **$0.40 per million input tokens, $0.10 per million cached input tokens, and $1.60 per million output tokens**. It supports the Responses API and Structured Outputs, has a 1,047,576-token context window and 32,768 maximum output tokens, and operates without a reasoning step. A pinned snapshot makes evaluation repeatable. Actual access still depends on the deployment's API account. [GPT-4.1 Mini model](https://developers.openai.com/api/docs/models/gpt-4.1-mini)

GPT-5 Mini is another economical candidate: $0.25 input, $0.025 cached input, and $2 output per million tokens, with 400,000 context and 128,000 maximum output tokens. However, it uses reasoning tokens, and the current model page marks its `gpt-5-mini-2025-08-07` snapshot Deprecated. Prefer the simpler baseline until quality tests justify changing it. [GPT-5 Mini model](https://developers.openai.com/api/docs/models/gpt-5-mini)

Reasoning tokens count toward billed output even when no visible answer is returned. `max_output_tokens` bounds generated tokens, including reasoning; `usage.output_tokens_details.reasoning_tokens` is a breakdown of `output_tokens`, not an extra charge to add twice. [Reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)

## Request contract

Use `POST /v1/responses`, explicit `store: false`, `service_tier: "default"`, `truncation: "disabled"`, and no built-in tools. Set a modest output cap, initially 2,048 tokens for rule conversations and at most 4,096 for small classification batches. The provider's maximum is not an appropriate application default. [Responses reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)

Return a strict schema through `text.format` with `type: "json_schema"`, a schema name, `strict: true`, and a schema that uses required properties and `additionalProperties: false`. Validate the decoded result locally too. Handle refusals, missing output, and incomplete responses explicitly; a malformed or truncated classification must never authorize a mailbox mutation. Schema adherence does not establish classification correctness. [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

For this application, the model proposes rules and classifications; deterministic application code owns identity, permission checks, budgets, rule precedence, previews, approvals, and Gmail actions. Email bodies are untrusted content, including any text that pretends to be a system instruction. Send only the current user's context.

`store: false` is not Zero Data Retention. Default abuse-monitoring retention can include content for up to 30 days, with stated exceptions; OpenAI documents additional eligibility-dependent retention controls. Avoid server-side Conversations and background responses here. Application retention and provider retention are separate. [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)

## Budget accounting design

The following is a proposed local control, not a provider billing guarantee:

1. Build an immutable request containing all instructions, selected conversation history, rules, email text, and the output schema. Restrict text size and batch size before sending anything.
2. Count input through `POST /v1/responses/input_tokens` using the same `model`, `instructions`, `input`, and `text` configuration. The official guide says this includes formatting overhead absent from local text-only tokenization, and the count endpoint accepts the output format. Do not use characters divided by four as a hard bound. If counting fails, do not generate. [Counting tokens](https://developers.openai.com/api/docs/guides/token-counting), [Count endpoint](https://developers.openai.com/api/reference/cli/resources/responses/subresources/input_tokens/methods/count)
3. Reserve `input_count * 0.40 / 1,000,000 + max_output_tokens * 1.60 / 1,000,000`, rounded upward in integer microdollars, with a small safety margin. Reserve at uncached input rates. Use a database transaction/row lock so concurrent users cannot jointly overspend the remaining allowance.
4. Admit generation only when settled cost plus all unresolved reservations plus the new reservation fits the team's $10 monthly allowance and the configured user's allowance. Record the billing month on each reservation. Emit the $8 alert once per month through the application's normal notification path.
5. On a valid response, settle from reported token usage, including unsuccessful or incomplete outputs. A conservative implementation may price all reported input at the uncached rate; a more accurate one discounts only the explicitly reported cached subset. Release the remaining reservation atomically.
6. On timeout, process crash, transport failure, missing usage, or ambiguous result, retain the full reservation until reconciled. A retry is another potentially billable attempt and needs its own reservation. Never free a reservation merely because its worker lease expired.
7. Reject an unrecognized model or unexpected service tier until its rates are explicitly configured. Keep the model, rate version, token counts, reservation, and provider request ID for reconciliation, without storing email bodies in the cost log.

Use a dedicated OpenAI project/key so unrelated clients cannot bypass the application's allowance. Keep a margin below $10 for reconciliation and pricing drift; review published rates before deployment. This controls this application's generation spending under configured rates, not taxes, exchange rates, or requests made with the key elsewhere. The reviewed token-count page does not explicitly establish a separate price for token-count calls; verify that operational detail when provisioning.

If using the OpenAI Python SDK, disable automatic retries with `max_retries=0`: the documented default retries certain errors twice, including timeouts. With direct HTTP, configure zero retries at the transport level and implement any retry explicitly through the reservation path. [Python SDK retries](https://developers.openai.com/api/reference/python#retries)

## What $10 could cover

Illustrative arithmetic at the recommended standard rates, ignoring caching: one 100-message scan with 100,000 total input tokens and 8,000 output tokens costs approximately **$0.0528**. One hundred such scans cost **$5.28**, leaving **$4.72** for conversations and other requests. Doubling input to 200,000 tokens makes each scan **$0.0928**. These are scenarios, not observed average mail sizes; repeated prompts, rule text, schema overhead, retries, and longer messages all count.

Keep routine commands, summaries from stored results, sender matching, approvals, and undo deterministic. Evaluate semantic rules together in bounded batches. Skip oversized or incompletely read messages into Needs your decision rather than silently classifying a truncated body as complete. Test with representative multilingual urgent mail, project ambiguity, receipts, newsletters, and adversarial email instructions before enabling mutations for the team.
