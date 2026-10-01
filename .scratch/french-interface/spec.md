# French interface and horizontal actions — design interview

Status: the User confirmed Q8 and authorized implementation, then commit and push on `main`. The implementation is verified locally; production and live integrations are not verified.

The authoritative approved application behavior remains in [the product specification](../../docs/product-spec.md). This interview records presentation decisions; it does not authorize deployment or changes to saved approvals.

## Decisions confirmed by the User

- Q1: all three Modules and shared user-facing screens use French, including menus, tables, help, errors, confirmations, reports, generated explanations and the application's Gmail connection responses. Code and technical repository documentation can remain English. Google and Slack own their external interfaces.
- Q2: existing user content is already French. Preserve stored inventory values, approved rule content, email/Slack excerpts, names, URLs and other original data; presentation changes do not translate or rewrite them.
- Q3: group action buttons horizontally throughout the application, preserving every action and its order. Keep the record dropdown on a separate row. Slack can wrap controls on narrow clients or when there are many buttons.
- Q4: offer French typed command aliases, such as `aide`, `courrier trier` and `documentation projets`, while preserving existing English commands. Routing remains explicit and deterministic, and both forms enter the same operation admission and workflow.
- Q5: structured JSON command keys remain the existing technical English syntax (`name`, `projectId`, `technologies`, etc.). Explanations and displayed field labels use French. Machine identifiers, stored schema keys and integrations retain their contracts.
- Q6: previously saved English generated explanations/results remain literal and are labeled in French as originating before the language change. New generated explanations use French. Do not rewrite approved rule/proposal values, run AI translation jobs, or repeat a paid classification to change presentation.
- Q7: display dates as `DD/MM/YYYY HH:mm` in `Europe/Paris`, with the time zone identified, and use French decimal/grouping conventions. Preserve real amounts, currencies and original deadlines; persisted timestamps and numeric values remain unchanged.

## Historical implementation facts — before this change

- Repeated logical action IDs forced a separate actions block in `src/core/slack.ts`, including `core:navigate` for navigation buttons.
- Slack requires action IDs unique within each actions block and allows up to 25 elements per actions block. Its client determines responsive wrapping. See [Slack actions](https://docs.slack.dev/reference/block-kit/blocks/actions-block/) and [buttons](https://docs.slack.dev/reference/block-kit/block-elements/button-element/).
- There was no shared localization layer. English presentation strings existed in core, Mail Sorter, Slack Unanswered, Documentation and Gmail connection responses.
- Some rendering and error handling compare English visible strings. Localization must preserve clickable links, error categorization, routing and access checks.
- Slack Unanswered saves rendered result-page text without sufficient structured results to rerender an old page faithfully. AI reason checkpoints and some Mail explanations are also persisted text.
- Slack AI retry checkpoints include the prompt in their hash. French prompts must preserve recovery without repeated paid calls.

## Complete shared understanding for Q8

Use French throughout the application-owned user interface, with visible Module names such as **Tri des e-mails**, **Messages Slack sans réponse** and **Documentation**. Translate headings, menus, buttons, dropdowns, tables, help, clarifications, errors, reports, comparisons, application-written source/status descriptions, budget notices, generated explanations and Gmail connection responses. User content and technical command syntax retain the exceptions agreed above. Repository technical documentation and operator tools remain technical surfaces rather than the team-facing interface; external Google/Slack screens are owned by their providers.

Present action buttons side by side in their existing order; keep the record selector separate. Preserve all controls across continuation groups when required, accepting client-controlled wrapping. Unique presentation action identifiers must resolve strictly to the existing logical actions, and already-posted controls must remain compatible. Preserve read-only dropdown restrictions and existing clickable saved-resource and source links.

Existing posted messages are not bulk edited. New messages and newly rendered navigation use the French presentation; reopening retained English generated text labels that original text in French. Language changes must not refresh confirmations, invalidate saved effects, rewrite history or introduce paid translation work. Old AI attempts/checkpoints must retain their recovery behavior across the prompt change.

Q8 confirmed this contract. The implementation updates the authoritative specification and dependent examples directly on `main`, and exercises public signed routing/dispatch as well as each affected workflow with fake providers. Verification must include `test`, `check` and `build` with a compatible Node runtime; real PostgreSQL tests skipped without `TEST_DATABASE_URL` and live integrations not exercised are reported separately. No production deployment is included in this request.

## Invariants

Keep stable internal identifiers, machine schemas, saved fields, ownership and DM/message binding, separate approvals, original expiries, mutation recovery, operation admission, spending limits and free browsing. Existing controls remain compatible. The redesign does not authorize new AI calls solely to translate retained content, external-message edits, deployment or a real inventory import.

## Local verification — 2026-10-01

On Node v25.8.1 (`package.json` requires >=24), `npm test` passed 255 tests. The 20 real PostgreSQL locking/import tests were skipped because `TEST_DATABASE_URL` was not configured; they are not passes. `npm run check` and `npm run build` passed, the intended diff was reviewed, and 77 local documentation links/anchors were checked without missing targets.

Fake providers exercised signed French/English routing, operation admission, French create/edit/archive/restore, horizontal groups and the 25-control limit, read-only selectors, old buttons and clickable links, Paris dates, precise French amounts/filter summaries, literal saved content, conservative French mutation validation, retained explanations and legacy AI recovery without repeated spending. Slack desktop/mobile rendering, actual model output, Gmail/Google OAuth and production were not exercised live. No environment changes or migrations are required. At verification time this change was local on `main`; the User subsequently authorized commit and push. The existing unrelated `CONTEXT.md` edits are untouched.
