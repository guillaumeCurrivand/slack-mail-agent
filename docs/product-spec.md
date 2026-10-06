# Private Slack assistant — current product specification

Status: approved by the user after the design interview. An initial local implementation and automated tests are available; live integration and model-quality validation remain release requirements. Deployment and purchasing services are not authorized by this document.

## Reading this specification

This document owns shared routing, navigation, presentation, access and spending safeguards, plus the Mail Sorter contract. Start with the [module overview](../README.md#modules-and-project-structure) for setup and usage. Module-specific guides/contracts are [Mail Sorter](mail.md), [Slack Unanswered](slack-unanswered.md), [Documentation](documentation.md), [ClickUp](clickup.md), [Yousign](yousign.md) and [Development](development.md). Their implementation status does not establish successful production deployment.

## Approved module extension

The user subsequently approved preparing this assistant for multiple built-in modules in one bot, with private interactions per user. Mail Sorter and Slack Unanswered are implemented locally. Mail Sorter's Gmail behavior below remains applicable; new DM requests now require the `mail` prefix, including natural language (`mail sort`, `mail change my newsletter rule`). There is no remembered active module or AI-based routing. Shared `help` and `budget` commands require no module prefix.

Modules are maintained in this repository and deployed together, with independent enablement, connection requirements, and module-owned data. OpenAI work shares the existing $10 monthly AI ceiling, with usage tracked by module. Development's explicitly approved local Cursor billing is separate; see its contract below. Disabled modules do not execute work; saved state and pending jobs remain for re-enablement. Existing queued mail work and previously posted mail buttons retain their approval and ownership safeguards.

Slack Unanswered is implemented locally but disabled by default; live Slack access and model-quality validation remain release work. Its approved full behavior is specified in [the Slack Unanswered feature contract](slack-unanswered.md). See [the architecture decision](adr/0002-private-assistant-modules.md) for rationale and [module guide](adding-a-module.md) for implementation conventions.

## Approved DM navigation redesign

The user approved a clickable interface for both existing modules, entirely within private DMs. The full target contract follows below. All four slices are implemented locally; live integration and deployment remain unverified.

**Implemented locally (ticket 01):** `menu`, `help`, `hello` and `hi` open a private main menu. Enabled Modules, Budget and Help are clickable. Module menus and Back navigation update the clicked message; Mail Sorter exposes Gmail connection status, Connect Gmail and separately confirmed disconnect using the existing authorization flow. Mail workflow messages and routing guidance offer Menu buttons that open a separate menu. No menu browsing invokes AI or changes typed-message routing. Menu updates use owner/DM/message-bound records retained for 30 days; expired or unavailable menus instruct the User to send `menu`. Definite delivery rejection is retryable; uncertain navigation delivery is not blindly repeated.

**Implemented locally (ticket 02):** Mail Sorter offers Manage rules, Latest report and Pending approvals when eligible items exist. Rule and pending-item lists paginate in place; long rule summaries are explicitly abbreviated. Add/Edit instructions identify the rule and require a `mail`-prefixed description. Starter rules and removal create separately approved Proposals. Reopening a saved Proposal, Preview or Report posts a separate Card with original identifiers and existing approval, Details and undo behavior. Pending approvals excludes expired rule Proposals, missing rule targets, and Previews with changed rules/connections or an expired 24-hour window. Reading saved items does not invoke AI, refresh validity, write conversation history or prune persisted domain records; delivery bookkeeping prevents blind resends after uncertain delivery.

**Implemented locally (ticket 03):** Slack Unanswered offers Choose channels. Its per-User, per-workspace list shows eligible shared channels, retained inaccessible selections and explicit Add/Remove controls. Pagination and changes update the clicked list; `slack channels` remains a shortcut. Clicks recheck ownership and access, and browsing makes no AI calls. The selection does not require Gmail.

**Implemented locally (ticket 04):** Sort inbox and Find unanswered start the existing workflows from owner-bound menu controls. Typed starts and menu clicks share durable, atomic admission by User, Module and operation; natural-language mail requests capture active work at receipt and claim the operation after intent resolution. Overlapping requests keep the original request identity even when their status Card is delivered later. Slack result pages use the original saved result without reclassifying or paying again, and recheck selected-channel access before showing cached excerpts. Worker locks now serialize work within each User and Module, allowing navigation and the other Module to proceed during a provider call with at least two worker lanes. Terminal completion releases admission. See [the locking decision](adr/0003-operation-admission-and-module-locks.md). Live Slack verification and deployment have not been observed; real PostgreSQL concurrency tests were skipped without `TEST_DATABASE_URL`.

- The main menu shows every enabled Module, Budget and Help at once, hiding disabled modules. Its buttons may wrap across lines but do not use action paging. `menu`, `help` and plain greetings such as `hello` show the main menu. Unrecognized commands and workflow results provide a Menu button.
- Navigation updates the menu message being used. Module menus include Back to menu. Results and approval requests remain separate messages so navigation does not erase them. The `menu` command posts a fresh menu.
- Mail Sorter offers Sort inbox, Manage rules, Latest report and Gmail connection, plus Pending approvals when needed. Starter rules live under Manage rules. Details and undo remain attached to previews and reports. Pending approvals reopens existing rule proposals and sorting previews without starting new work, preserving existing expiry and invalidation safeguards.
- Add rule and Edit buttons post instructions in the DM. The user supplies a description with the explicit `mail` prefix, then separately approves the proposal. Existing commands remain shortcuts; opening a module menu never changes the routing of later typed messages.
- Slack Unanswered offers Find unanswered and Choose channels. Channel selection is a paginated DM list with Add/Remove buttons and visible selection status; each click updates that message. Inaccessible selected channels remain listed with an explanation and a Remove option.
- Enabled Mail Sorter without a connected account offers Connect Gmail and explains that sorting requires a connection. Google authorization still opens Google's external sign-in page. Slack Unanswered remains independent of Gmail.
- Clearly labeled Sort inbox and Find unanswered buttons start work immediately, including potentially paid AI work under the existing spending safeguards. Browsing menus performs no AI work. Applying mailbox changes still requires approval of the specific preview.
- Repeated clicks for the same operation while that user's sorting or unanswered search is in progress report the existing request instead of starting another paid run. Navigation and the other module remain usable.
- Older menu buttons operate against current state. If a module is now disabled or Gmail disconnected, explain the change and offer an appropriate next step. Approval buttons remain bound to their original proposal or preview and its owner.

### Interactive message presentation

The User approved the [French-interface contract](../.scratch/french-interface/spec.md): all application-owned screens, help, errors, tables, confirmations, reports, generated explanations and Gmail connection responses use French. Original content and approved values are preserved. French command aliases coexist with English commands; structured JSON keys, stable machine identifiers, operator tools and technical documentation remain unchanged. Dates display as `DD/MM/YYYY HH:mm` in `Europe/Paris`, and numbers use French formatting without changing currencies or deadlines. Retained English generated text is labeled in French; it is not translated through paid work or used to renew approval. Previously posted messages are not bulk edited. This behavior is implemented locally; live integrations and production deployment remain unverified.

ClickUp task deadlines use the date-only Paris presentation defined in [its feature contract](clickup.md#approved-behavior); retrieval timestamps keep the shared date/time format.

Action buttons appear side by side in their existing order. Render at most five buttons in each Slack actions block, placing additional buttons in another visible row so Slack does not hide them behind **+N autres**. Fit as many actions as practical in each action page using their displayed label widths. Except on the main menu, when the set would grow into several rows, use **◀ Actions** and **Actions ▶** navigation buttons to reach the remaining actions in the same message; keep **Menu** available on every action page. Apply this to workflow Cards as well as module menus, without a dropdown or overflow control. Slack still controls responsive wrapping, so exact one-line layout depends on the client width. Presentation-specific action IDs distinguish buttons within a group and resolve to the same authenticated logical actions; old controls remain compatible. Navigation controls carry a blue label cue, while primary work/approval actions retain Slack's green primary style and destructive actions retain its red danger style. Slack does not offer a custom navigation button color.

Menus, channel selection, approval Cards, previews, reports, and Slack Unanswered results use Slack-native grouped panels with a clear kind header and actions kept with their content. Each screen gives one primary button visual emphasis only when it has an unambiguous main action; equally important choices and navigation remain neutral, while destructive actions use Slack's danger style. Presentation must not alter what a button does or weaken the existing approval and ownership checks.

Grouped panels fill the available message space using Slack's container `width: "full"`, including continuation panels. Slack determines the available space for each client and window size.

Documentation's [presentation contract](documentation.md#presentation-redesign) uses native top-level data tables with grouped kind/context and actions around them, plus visible per-row record-opening buttons. On clients without action-cell support, the row shows a typed-lookup fallback. Its record fields and comparisons show human-readable relationship names and clickable saved resource links.

Tables use up to 100 visible data rows per page, reduced when Slack's 20,000-character table budget or readability requires it, and continue onto further pages for larger results. Action-heavy lists may use fewer entries so all controls stay visible. Unanswered entries retain clearly labeled **Ouvrir le message** links (older retained text may say **Open message**) rather than gaining a button for every entry. Short conversational Replies remain simple messages. A long Reply is kept in one large message and, only when it exceeds the display limit, its saved numbered pages replace that message in place without a new AI call. Core retains the full display content of paged messages for up to 30 days in the existing navigation store; only the original User, DM and message timestamp can page it. Startup adds this content column automatically. See [the paging decision](adr/0008-saved-navigation-content.md). Slack controls message backgrounds and rendered height; no custom message height or background is available.

Every displayed valid HTTP(S) web address, including a bare URL, a `www.` address, and a labeled Markdown link in generated or untrusted text, is clickable throughout Agent messages and tables. A labeled link keeps its label without displaying the destination beside it; labels can therefore conceal a different destination. Do not activate Slack mentions, fetch destinations, or unfurl link previews. This revises the earlier [Reply link decision](adr/0001-sanitized-markdown-replies.md); see [the revised link decision](adr/0007-clickable-displayed-links.md). This rule makes displayed links clickable; it does not add URLs that a Module's contract excludes from its output.

Existing ownership, approval, recovery, undo, module enablement and shared spending safeguards continue to apply. This redesign adds navigation to existing capabilities; it does not authorize deployment or add new mail or Slack processing behavior.

## Slack Unanswered module

The `slack` module provides `slack channels` to manage each user's selected public and private channels shared with the bot. It starts with no selections, preserves them when access is temporarily lost, and allows only that user to remove them. It does not need Gmail. The module is disabled by default; when enabled, `slack unanswered` searches on demand for direct @mentions, profile-name matches, and contextually directed requests posted in the rolling 48 hours before the command. It excludes earlier requests after the user replies later in their thread, detects new requests directed back to the user in that conversation, groups linked results by channel, places uncertain but specifically connected messages under **Possibly for you**, and privately reports inaccessible selected channels. Contextual matching uses the shared AI budget; when unavailable, direct matches remain with an incomplete-results notice. The approved full behavior is in the [feature contract](slack-unanswered.md).

## Documentation module

The User approved Documentation's target contract and ten-ticket breakdown. [Documentation](documentation.md) is authoritative for that Module, including delivered behavior and deferred scope. Tickets 01–10 are implemented locally and opt-in with `ENABLED_MODULES` containing `documentation`: Users can browse shared Projects, Technologies, Project Components, Hosts/services, Hosting entries and Tools, look up exact identifiers/names (and Project aliases), navigate their stable relationships, inspect shared and record-specific history, and propose structured creation or selected-field edits in private DMs. Mutations require the initiating User's separately saved, DM-bound confirmation within 24 hours. Archive/Restore controls and a paginated Archived view preserve identifiers, relationships and history, label archived references, and require separate actor/DM-bound confirmation. Archived targets cannot be edited until explicitly restored; restoration preserves the original edit expiry. Edits overwrite approved fields despite intervening edits, preserve unrelated fields, and atomically save actual before/after history and an effect checkpoint under shared-record database locks. Component/Hosting entry parents and existing Technology/Host references are validated within the workspace at proposal and apply boundaries; missing Technologies require separate confirmed creation. Replays and delivery uncertainty cannot repeat saved effects. Structured operations need no AI or Gmail. Project-question interpretation uses the shared AI budget; current-record answer rendering and result controls are free.

Documentation extends ownership to workspace-shared inventory and lifetime history while retaining private actor-owned confirmations, navigation and interaction metadata. It uses existing signed ingress and workspace validation without another membership check or permitted-user list. Existing Mail Sorter and Slack Unanswered isolation remains unchanged. Disabled Documentation retains inventory and pending state and pauses module cleanup. Project questions and private context are delivered in ticket 07; inventory filters/counts are delivered in ticket 08; natural-language mutations are delivered in ticket 09; the offline reviewed importer is delivered in ticket 10. Implementing the importer does not authorize real source review/import or switch spreadsheet authority. See [the ownership decision](adr/0004-authoritative-documentation-inventory.md); live Slack verification, deployment and actual import remain unverified.

<a id="clickup-module-approved-target"></a>

## ClickUp module

The User approved [ClickUp's feature contract](clickup.md) on 01/10/2026 after the design interview. The `clickup` Module is implemented locally and opt-in: it connects each User's personal ClickUp account through OAuth and privately lists their directly assigned tasks in the configured Mayasquad Workspace. It is read-only and requires neither Gmail nor AI. The contract owns assignment/archive rules, the linked table, date-only due-date presentation, account confirmation, result expiry and access/recovery safeguards. Live connection, provider completeness and deployment remain unverified.

On 02/10/2026 the User reported the existing task command working well and approved [personal status filters](clickup.md#personal-status-filters), now implemented locally. Each User saves Workspace-wide status-name choices through a private picker, with explicit completed-status inclusion, retained preferences, original-filter result snapshots and catalogue/editor recovery safeguards. The User subsequently requested automatic saving on Add/Remove: changes and reset persist immediately, including safe name exceptions during partial discovery, and closing preserves them. Personal List-specific discovery is deferred. Automated checks use fake providers; live catalogue completeness, Slack behavior and production deployment remain unverified.

## Yousign module

The User approved [Yousign's complete contract](yousign.md) on 02/10/2026 and authorized implementation. One company webhook drives identical French notifications in a workspace-shared destination list managed by everyone through private menus. This explicitly extends the DM-only contract for automatic notifications in selected public/private/externally shared channels; configuration, status, confirmations and operational alerts remain private. Adding authorizes future posts immediately, removal cancels waiting posts and empty selections skip events without backfill. Integration-owned durable work preserves deduplication, partial recovery and uncertainty safeguards without impersonating a Slack User or invoking AI. See [the ownership ADR](adr/0005-shared-yousign-notifications.md). The Module is implemented and tested locally; live release work remains unverified.

## Development module

The User's 04/10/2026 authorization to use existing local `.env` files and the EOA backend/tunnel setup are recorded in the [Development environment contract](development.md#local-worker-setup) and [EOA runbook](development-eoa.md). Configuration values stay local; this does not change other Modules' access boundaries or authorize publishing secrets.

The User subsequently requested automatic local environment startup. Trusted worker configuration now starts dependency services in order before the frontend and Cursor: EOA uses `orient-action-api` → `npm run develop`, then `ngrok http 8087`, then the per-run frontend. Readiness, explicit reuse of already-running services, tunnel identity checks and cleanup ownership are defined in the [Development contract](development.md#local-worker-setup). This does not add a server-side command execution API or authorize deployment.

The User approved the [Development contract](development.md) on 03/10/2026 and authorized implementation. The new `development` Module connects a Slack channel, ClickUp Folder, repository and Cursor skill, with everyone in the channel able to interact. Signed project-channel ticket links trigger investigation and threaded clarification, saved to ClickUp. A human's `Ready for AI` status authorizes a frozen ticket snapshot; a local worker investigates, implements and verifies it, with no execution deadline and at most two attempts total. It pushes one commit per ticket to the locally configured maintenance branch (`maintenance` by default, `maintenance/ai` approved for EOA on 04/10/2026), then sets **`to build`** and reports the result. PR/MR creation, merge into the configured base branch (`preprod` for EOA; `test` by default), deployment and final closure remain human actions. Cursor billing is explicitly separate from the existing OpenAI allowance. See [the ownership/execution decision](adr/0006-local-development-worker.md). This extends channel access only for Development and leaves other Modules' private boundaries unchanged. Live provider and deployment verification remain required.

## Audience and access

- One Slack workspace, serving the user's team of 10.
- User interactions are private except Development's explicitly connected project channels. Yousign's approved automatic notifications post to selected channels under [its own contract](yousign.md); other Modules retain their existing private boundaries.
- Each Mail Sorter user connects at most one personal-to-them Google Workspace Gmail account; connecting Gmail is not required to use the assistant's shared commands or other independent modules.
- Each user has separate Gmail authorization, rules, project mappings, conversation history, previews, and action records.
- No shared team rules in version one. Team administrators may manage availability and connection health through the product but cannot browse other users' mail, rules, or conversations through it.
- Application-level isolation is required; this is not a promise that infrastructure operators or external platform administrators have no technical access.

Documentation's explicitly approved workspace-shared inventory/history is described in [its own contract](documentation.md#spending-availability-and-private-state). That shared access does not grant access to another User's private Mail Sorter, Slack Unanswered or ClickUp state.

## Mail Sorter module

The next three sections define Mail Sorter's rules, sorting workflow and starter templates. Usage and provider-specific recovery are in the [Mail Sorter guide](mail.md). Shared retention and budget policies follow afterward, with Module-specific exceptions in each contract.

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
- **OpenAI budget: $10 per calendar month across all 10 users combined. Hosting and the explicitly approved local Development Cursor billing are separate.**
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
- Keep Gmail tokens out of AI prompts. Treat retrieved email and Slack text as data to classify, never as instructions authorizing actions or rule changes.
- Persist pending work and execution checkpoints so restarts do not lose runs. Handle duplicate events and confirmations without repeating mailbox changes.
- Bind approval to the saved preview and rule version. Recheck affected message state before changes, reporting messages that changed or became unavailable.
- Store enough before/after state for targeted undo and partial-failure reporting.
- Distinguish classification confidence from authorization; a model score never replaces user confirmation.

## Before implementation and release

The interview's final shared-understanding confirmation has been received. Release still needs model evaluation, live integration verification, and a concrete hosting configuration when the user selects infrastructure. Slack channel permissions and application setup, Google application setup, and credentials have not been created or requested, and no real mailbox or channel history has been accessed.

Evaluate urgency, newsletters versus transactional mail, project ambiguity, Slack Unanswered matching, and adversarial message text on representative consented or synthetic messages. Unit tests establish workflow safeguards; they do not establish model accuracy.

Supporting research: [TypeSafe](research/typesafe-evaluation.md), [OpenAI](research/openai-fit.md), and [previous hosting comparison](research/hosting-options.md). The prior hosting comparison is background research, not a current provider decision.
