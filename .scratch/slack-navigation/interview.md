# Slack navigation redesign interview

Status: design interview complete; user confirmed the final shared understanding. These are historical interview notes; current implementation status is recorded in the product specification and tickets.

## Confirmed direction

- Keep all application navigation and workflows in private DMs with the bot, using clickable messages. The user explicitly replaced the earlier Home-tab choice with "everything in DM".
- Make routine tasks clickable, including management and review; retain conversation for complex requests and existing commands as shortcuts.
- Cover both Mail Sorter and Slack Unanswered using their existing capabilities.
- The main DM menu offers Mail Sorter, Slack Unanswered, Budget and Help. Module menus offer their actions and Back to menu.
- Navigation updates the same menu message. Results and approval requests are separate messages, preserved when navigating.
- The `menu` command opens a fresh menu; workflow results include a Menu button.
- Clearly labeled work actions start immediately, including potentially paid sorting and unanswered searches. Browsing menus does not perform AI work. Mailbox changes still require separate preview approval.
- Mail Sorter offers Sort inbox, Manage rules, Latest report and Gmail connection. Starter rules live under Manage rules; details and undo remain attached to previews and reports.
- Slack Unanswered offers Find unanswered and Choose channels. Both module menus include Back to menu.
- Add rule and Edit buttons post DM instructions. The user describes the rule with an explicit `mail` prefix and separately approves the proposal. Opening a module menu never changes routing of later typed messages.
- Disabled modules are hidden. Enabled Mail Sorter without a connection offers Connect Gmail and explains the sorting prerequisite; Slack Unanswered remains independent. Google authorization still uses Google's external sign-in page.
- Repeated clicks for the same operation while that user's sorting or unanswered search is in progress report the existing request rather than starting another paid run. Navigation and the other module remain usable.
- `help`, `menu` and plain greetings such as `hello` show the main menu. Unrecognized commands provide a Menu button.
- Mail Sorter shows Pending approvals when needed, allowing users to reopen existing rule proposals and sorting previews without starting new work. Existing expiry and invalidation safeguards apply.
- Channel selection uses a paginated DM list with Add/Remove buttons and visible selection status. Each click updates the same message. Inaccessible selected channels remain listed with an explanation and a Remove option.
- Older menu buttons remain usable against current state. If a module is disabled or Gmail disconnected, explain the change and offer the appropriate next step. Approval buttons remain bound to their original proposal or preview.

These choices reflect the interview and the subsequent DM-only correction. The user confirmed the final shared understanding with "Yes it does". They describe intended future behavior, not the current implementation. The authoritative approved contract is now recorded in the [product specification](../../docs/product-spec.md#approved-dm-navigation-redesign).

## Current contracts and constraints

- The [product specification](../../docs/product-spec.md) limits interaction to DMs, consistent with the revised direction.
- [ADR 0002](../../docs/adr/0002-private-assistant-modules.md) requires explicit module routing and no remembered active module for typed messages.
- Current workflow cards already provide some buttons, but the application does not yet support Home views or modal forms.
- Existing ownership, approval, undo, module enablement and shared spending safeguards remain requirements.

## Outcome

- No open interview decisions remain. The approved navigation contract is ready for implementation planning.
- No application code, Slack configuration or production deployment was changed during the interview.
