# Private Slack assistant — current product specification

Status: approved by the user after the design interview. An initial local implementation and automated tests are available; live integration and model-quality validation remain release requirements. Deployment and purchasing services are not authorized by this document.

## Reading this specification

This document owns shared routing, navigation, presentation, access and spending safeguards, plus the Mail Sorter contract. Start with the [module overview](../README.md#modules-and-project-structure) for setup and usage. Module-specific guides/contracts are [Mail Sorter](mail.md), [Documentation](documentation.md), [ClickUp](clickup.md), [Yousign](yousign.md) and [Development](development.md). Their implementation status does not establish successful production deployment.

## Approved module extension

The user subsequently approved preparing this assistant for multiple built-in modules in one bot, with private interactions per user. The five current Modules are Mail Sorter, Documentation, ClickUp, Yousign and Development. Mail Sorter's Gmail behavior below remains applicable; new DM requests now require the `mail` prefix, including natural language (`mail sort`, `mail change my newsletter rule`). There is no remembered active module or AI-based routing. Shared `help` and `budget` commands require no module prefix.

Modules are maintained in this repository and deployed together, with independent enablement, connection requirements, and module-owned data. OpenAI work shares the existing $10 monthly AI ceiling, with usage tracked by module. Development's explicitly approved local Cursor billing is separate; see its contract below. Disabled modules do not execute work; saved state and pending jobs remain for re-enablement. Existing queued mail work and previously posted mail buttons retain their approval and ownership safeguards.

Slack Unanswered was removed at the User’s request on 05/11/2026. Its `slack` enablement ID is ignored for upgrade compatibility, and its commands, menus, handlers and providers are unavailable. Existing database tables, queued jobs and spending records are retained; this removal does not authorize data deletion. See [retirement notes](slack-unanswered.md).

## Approved DM navigation redesign

The assistant uses clickable private DM screens. Typed work starts and menu clicks share durable, atomic admission by User, Module and operation. Overlapping starts retain the original request identity. Worker locks serialize each User/Module while independent navigation can proceed on another lane; terminal completion releases admission. See [the locking decision](adr/0003-operation-admission-and-module-locks.md).

- The main menu lists every enabled Module, Budget and Help, hiding disabled modules. Its current choices appear in visible button rows under the shared 20-button limit, with Help in its own final row. `menu` and plain greetings such as `hello` show the main menu. `aide`/`help` and the Help button open the detailed French guide described below. Unrecognized commands and workflow results provide a Menu button.
- Button-driven navigation, workflow replies, results and approval screens update the clicked message under the [in-place interaction contract](#in-place-button-interactions). Module menus include Back to menu. The `menu` command posts a fresh menu.
- Mail Sorter offers Sort inbox, Manage rules, Latest report and Gmail connection, plus Pending approvals when needed. Starter rules live under Manage rules. Details and undo remain attached to previews and reports. Pending approvals reopens existing rule proposals and sorting previews without starting new work, preserving existing expiry and invalidation safeguards.
- Add rule and Edit prepare guided forms, then display a separately approved proposal in the clicked DM Card. Existing prefixed commands remain shortcuts; opening a module menu never changes the routing of later typed messages.
- Enabled Mail Sorter without a connected account offers Connect Gmail and explains that sorting requires a connection. Google authorization still opens Google's external sign-in page.
- Clearly labeled Sort inbox buttons start work immediately, including potentially paid AI work under the existing spending safeguards. Browsing menus performs no AI work. Applying mailbox changes still requires approval of the specific preview.
- Repeated clicks for the same operation while that user's sorting is in progress report the existing request instead of starting another paid run. Navigation and the other module remain usable.
- Older menu buttons operate against current state. If a module is now disabled or Gmail disconnected, explain the change and offer an appropriate next step. Approval buttons remain bound to their original proposal or preview and its owner.

### Approved workflow simplifications — 15/10/2026

The User approved guided create/edit forms for Documentation and Mail rules, contextual next-step controls across all five current Modules, and in-place replies. Forms prepare owner/DM/message-bound drafts; submission validates and durably queues a proposal, never an approval or external mutation. Saved proposals retain their existing separate confirmation and expiry. Form browsing and structured submission use no AI. Relationship selectors offer saved workspace-scoped choices, with current references revalidated by the existing proposal/apply workflows. Inventory editing submits only changed fields, preserving unrelated concurrent changes; Mail rejects a form if its original rule changed before proposal creation. See the module contracts for their controls.

Mail emphasizes connecting Gmail, preparing rules, then sorting; Details offers Back to preview. ClickUp results identify the snapshot's filter, and closing its autosaved status selector offers View my tasks. Yousign separates deliveries needing human action from ordinary history, with contextual review/retry controls and unchanged uncertain-resend confirmation. Development links tickets to their runs and runs back to their ticket's repository controls and eligible next action. These changes do not start paid work through passive navigation, bypass confirmations, or change saved-result access checks.

### Approved workflow shortcuts — 22/10/2026

ClickUp’s **Voir mes tâches** retrieves with the currently saved filter without requiring **Fermer** first. It uses existing owner-bound operation admission and access checks; selection and passive navigation never start work. See [ClickUp](clickup.md#reading-results-and-recovering).

Mail's existing preparation screen offers **Règle par expéditeur** and **Règle par contenu**, opening separate forms with a fixed type. Only the sender form shows exact-address fields. Edits offer the current type first and allow explicitly choosing the other type. Both retain examples, validation, stale-rule checks, saved proposal expiry and separate approval. Already-prepared forms remain usable within their original validity window. This changes presentation, not matching semantics or mailbox authorization.

### List-first screens and direct forms — 05/11/2026

The User requested consistent lists, fewer clicks, stable button positions and the same interaction context across Modules. Repeated records use tables where practical; explanatory prose remains for help, errors and approval safeguards. Mail rules and pending approvals show up to six entries per page with row actions. Rules open complete details with Modify/Remove controls; pending approvals reopen from their own row. Development projects use a table with an owner-bound Open action per row. Documentation create/edit controls prepare their form directly, omitting the intermediate instruction screen. Modal opening still uses a fresh Slack trigger, and submitted changes still need separate approval. Existing in-place navigation, conversation/thread binding, typed-command behavior and external OAuth exceptions remain as defined below.

ClickUp rechecks every displayed task’s access in batches of at most four concurrent reads, retains snapshot order and hides failed checks. No access cache, mutation concurrency or paid-call retry is introduced. Synthetic latency checks do not establish production latency.

### Form performance and fewer acknowledgement screens — 05/11/2026

Development discovers ClickUp Folders with at most four concurrent reads, preserving complete discovery and deterministic order. A provider instance reuses a successful catalogue for 60 seconds and shares concurrent discovery; explicit refresh and correction force discovery. Failed discovery invalidates the cache and never serves partial or stale fallback results. This cache contains selector choices only: submission remains owner-bound and saving rechecks current Slack/Folder access and unchanged project values.

Cancelling a Development configuration, repository selection or confirmation returns to the relevant project, ticket or run screen in place. An unchanged repository confirmation returns to the ticket. Mail proposal/preview cancellation returns to rules, connection or the module menu; ClickUp cancellation returns to its connection menu. Successful mutations, uncertain outcomes, validation failures and required separate approvals remain explicit. Development lists and repository selection use contextual table actions without duplicate buttons below the list. Repository selection shows five rows per page and retains the current page after a toggle. Documentation form preparation reads independent relationship catalogues concurrently without caching inventory.

### Detailed help

Development uses clickable navigation in both channels and private DMs for projects, paginated treatment history, run details, configuration forms and separately confirmed configuration/pause/resume/retry actions. Native Slack forms support creating and editing every project setting without commands or JSON, with the originating channel fixed in channel forms or selectable in DM forms, a searchable multiple-selection ClickUp Folder selector, repository URLs entered one per line and an activation checkbox. One project connects one Slack channel, 1–100 Folders, 1–20 repositories and a shared maintenance skill. Every Folder offers all of the project’s repositories; a ticket can explicitly target one or several of them. Folder choices are loaded from the Development integration before modal opening and retained in the owner-bound draft; search invokes no providers, submission validates the saved selection, and saving rechecks Folder access. Its [clickable interface contract](development.md#clickable-channel-interface) owns eligibility, access, confirmation and recovery behavior. Ready for AI remains the human authorization to implement; reading menus/help never starts paid work.

The User requested complete explanations of every Module and capability. Shared `aide`/`help` opens a guide describing shared commands, explicit prefixes, private versus shared data, approvals, AI costs and recovery, followed by an overview and a help button for each enabled Module. Disabled Modules remain hidden. `<prefix> aide`, `<prefix> help` and a bare Module prefix open that Module's guide directly. English commands remain compatible.

Each built-in Module supplies French help covering its purpose, every available user capability, commands/menu paths, practical examples, prerequisites, data scope, approval requirements, costs and meaningful limits. Documentation additionally offers topic pages with its structured schemas and field constraints. Module menus offer a read-only Help link. Reading help, following topics and returning to the guide or Module menu perform no AI calls, provider requests or domain mutations. Help uses the existing owner/DM/message-bound navigation, delivery recovery, content paging and retention safeguards. Operator-only setup/import is identified as such, without presenting it as a Slack command or an available user workflow.

### Interactive message presentation

#### In-place button interactions

On 13/10/2026 the User requested consistent in-place behavior throughout the application. For a recorded, unexpired Card belonging to the User and conversation, button-driven screens replace that Card: Menu, workflow instructions, work results, saved-record openings, confirmations, confirmation outcomes and pagination. Development form validation also returns to its originating Card. Explicit confirmation is still a distinct action on the saved Proposal/Preview; replacing its display never approves, cancels, renews or deletes the underlying record. Saved pending work, reports and histories remain accessible through their existing module controls and commands. Core retains the latest full display content of module replies for up to 30 days under the navigation retention policy. This supersedes the historical separate-Card behavior above.

Typed commands start fresh messages. Autonomous notifications, worker reports and budget alerts remain separate deliveries. Public channel launchers create personal controls without replacing the shared notice. A legacy Card with no retained ownership record, an expired record or a mismatched owner/message binding cannot be overwritten; a fresh screen or recovery guidance is used instead. Send `menu` (or `development menu` in a project channel) to start a current screen. External authorization links and native Slack forms keep their existing behavior. Definite update rejection is retryable; uncertain delivery is not blindly repeated. See [the delivery decision](adr/0013-in-place-button-replies.md).

The User approved the [French-interface contract](../.scratch/french-interface/spec.md): all application-owned screens, help, errors, tables, confirmations, reports, generated explanations and Gmail connection responses use French. Original content and approved values are preserved. French command aliases coexist with English commands; structured JSON keys, stable machine identifiers, operator tools and technical documentation remain unchanged. Dates display as `DD/MM/YYYY HH:mm` in `Europe/Paris`, and numbers use French formatting without changing currencies or deadlines. Retained English generated text is labeled in French; it is not translated through paid work or used to renew approval. Previously posted messages are not bulk edited. This behavior is implemented locally; live integrations and production deployment remain unverified.

ClickUp task deadlines use the date-only Paris presentation defined in [its feature contract](clickup.md#approved-behavior); retrieval timestamps keep the shared date/time format.

Across every Module, buttons use three ordered groups: screen actions first, structural navigation (paging, Back, Menu and Close) on a separate second row, and Help on a separate third row with a compact `?` prefix. Preserve screen-action order. Structural navigation always appears in this order: Previous, Next, Back, Menu, Close; action/content paging follows the corresponding Previous/Next position. Omit controls that are unavailable. Help stays in the final group. Omit empty groups; a group with more than five buttons continues on additional rows before the next group. Selectors precede these button groups, and contextual table-row actions remain beside their records. Help-topic choices remain page actions; returning from a help topic remains navigation. Render at most five buttons in each Slack actions block, placing additional buttons in another visible row so Slack does not hide them behind **+N autres**. Show all buttons directly when a screen has at most 20. For larger sets, or a Module-owned picker that explicitly opts into action paging, use **◀ Actions** and **Actions ▶** to reach the remaining actions in the same message; keep **Menu** available on every action page. ClickUp's [status picker](clickup.md#preferences-and-selection) uses visible table row toggles and ordinary catalogue-page navigation instead. This applies to Replies, workflow Cards, menus and table screens without a dropdown or native overflow control. Slack still controls responsive wrapping, so exact one-line layout depends on the client width. Presentation-specific action IDs distinguish buttons within a group and resolve to the same authenticated logical actions; old controls remain compatible. Only structural controls for paging, Back, Menu and Close carry the compass symbol. Page-specific choices such as module names, Budget and record-opening **Ouvrir** buttons have no compass; Help uses its question mark. Primary work/approval actions retain Slack's green primary style and destructive actions retain its red danger style. Slack does not offer a custom navigation button color.

Menus, channel selection, approval Cards, previews and reports use Slack-native grouped panels with a clear kind header and actions kept with their content. Each screen gives one primary button visual emphasis only when it has an unambiguous main action; equally important choices and navigation remain neutral, while destructive actions use Slack's danger style. Presentation must not alter what a button does or weaken the existing approval and ownership checks.

Grouped panels fill the available message space using Slack's container `width: "full"`, including continuation panels. Every table occupies a single `wide` layout item with default fill alignment, with a native-table fallback for older clients. Slack determines the available space and interactive-table column sizing; its data-table API does not expose wrapping controls. Application text is preserved instead of adding ellipses; long Documentation values and ClickUp lists use smaller or additional pages within Slack limits. Shared saved navigation also pages oversized tables between complete rows, retaining each row’s authenticated action. ClickUp task results retain Module-owned pagination with fresh access checks on every result page.

Documentation's [presentation contract](documentation.md#presentation-redesign) uses native data tables in full-row layouts with grouped kind/context and actions around them, plus visible per-row record-opening buttons. On clients without action-cell support, the row shows a typed-lookup fallback. Its record fields and comparisons show human-readable relationship names and clickable saved resource links.

Tables use up to 100 visible data rows per page, reduced when Slack's 20,000-character table budget or readability requires it, and continue onto further pages for larger results. Action-heavy lists may use fewer entries so all controls stay visible. Short conversational Replies remain simple messages. A long Reply is kept in one large message and, only when it exceeds the display limit, its saved numbered pages replace that message in place without a new AI call. Core retains the full display content of paged messages for up to 30 days in the existing navigation store; only the original User, DM and message timestamp can page it. Startup adds this content column automatically. See [the paging decision](adr/0008-saved-navigation-content.md). Slack controls message backgrounds and rendered height; no custom message height or background is available.

Every displayed valid HTTP(S) web address, including a bare URL, a `www.` address, and a labeled Markdown link in generated or untrusted text, is clickable throughout Agent messages and tables. A labeled link keeps its label without displaying the destination beside it; labels can therefore conceal a different destination. Do not activate Slack mentions, fetch destinations, or unfurl link previews. This revises the earlier [Reply link decision](adr/0001-sanitized-markdown-replies.md); see [the revised link decision](adr/0007-clickable-displayed-links.md). This rule makes displayed links clickable; it does not add URLs that a Module's contract excludes from its output.

Existing ownership, approval, recovery, undo, module enablement and shared spending safeguards continue to apply. This redesign adds navigation to existing capabilities; it does not authorize deployment or add new mail or Slack processing behavior.

## Documentation module

The User approved Documentation's target contract and ten-ticket breakdown. [Documentation](documentation.md) is authoritative for that Module, including delivered behavior and deferred scope. Tickets 01–10 are implemented locally and opt-in with `ENABLED_MODULES` containing `documentation`: Users can browse shared Projects, Technologies, Project Components, Hosts/services, Hosting entries and Tools, look up exact identifiers/names (and Project aliases), navigate their stable relationships, inspect shared and record-specific history, and propose structured creation or selected-field edits in private DMs. Mutations require the initiating User's separately saved, DM-bound confirmation within 24 hours. Archive/Restore controls and a paginated Archived view preserve identifiers, relationships and history, label archived references, and require separate actor/DM-bound confirmation. Archived targets cannot be edited until explicitly restored; restoration preserves the original edit expiry. Edits overwrite approved fields despite intervening edits, preserve unrelated fields, and atomically save actual before/after history and an effect checkpoint under shared-record database locks. Component/Hosting entry parents and existing Technology/Host references are validated within the workspace at proposal and apply boundaries; missing Technologies require separate confirmed creation. Replays and delivery uncertainty cannot repeat saved effects. Structured operations need no AI or Gmail. Project-question interpretation uses the shared AI budget; current-record answer rendering and result controls are free.

Documentation extends ownership to workspace-shared inventory and lifetime history while retaining private actor-owned confirmations, navigation and interaction metadata. It uses existing signed ingress and workspace validation without another membership check or permitted-user list. Existing Mail Sorter and ClickUp isolation remains unchanged. Disabled Documentation retains inventory and pending state and pauses module cleanup. Project questions and private context are delivered in ticket 07; inventory filters/counts are delivered in ticket 08; natural-language mutations are delivered in ticket 09; the offline reviewed importer is delivered in ticket 10. Implementing the importer does not authorize real source review/import or switch spreadsheet authority. See [the ownership decision](adr/0004-authoritative-documentation-inventory.md); live Slack verification, deployment and actual import remain unverified.

<a id="clickup-module-approved-target"></a>

## ClickUp module

The User approved [ClickUp's feature contract](clickup.md) on 01/10/2026 after the design interview. The `clickup` Module is implemented locally and opt-in: it connects each User's personal ClickUp account through OAuth and privately lists their directly assigned tasks in the configured Mayasquad Workspace. It is read-only and requires neither Gmail nor AI. The contract owns assignment/archive rules, the linked table, date-only due-date presentation, account confirmation, result expiry and access/recovery safeguards. Live connection, provider completeness and deployment remain unverified.

On 02/10/2026 the User reported the existing task command working well and approved [personal status filters](clickup.md#personal-status-filters), now implemented locally. Each User saves Workspace-wide status-name choices through a private picker, with explicit completed-status inclusion, retained preferences, original-filter result snapshots and catalogue/editor recovery safeguards. The User subsequently requested automatic saving on Add/Remove: changes and reset persist immediately, including safe name exceptions during partial discovery, and closing preserves them. Personal List-specific discovery is deferred. Automated checks use fake providers; live catalogue completeness, Slack behavior and production deployment remain unverified.

## Yousign module

The User approved [Yousign's complete contract](yousign.md) on 02/10/2026 and authorized implementation. One company webhook drives identical French notifications in a workspace-shared destination list managed by everyone through private menus. This explicitly extends the DM-only contract for automatic notifications in selected public/private/externally shared channels; configuration, status, confirmations and operational alerts remain private. Adding authorizes future posts immediately, removal cancels waiting posts and empty selections skip events without backfill. Integration-owned durable work preserves deduplication, partial recovery and uncertainty safeguards without impersonating a Slack User or invoking AI. See [the ownership ADR](adr/0005-shared-yousign-notifications.md). The Module is implemented and tested locally; live release work remains unverified.

## Development module

On 19/10/2026 the User requested automatic detection of the repository or repositories needed for a ticket. Projects can opt into `repositoryMode: "automatic"` through the separately confirmed native configuration form or the existing configure command. The local worker inspects each candidate without implementing or publishing; all candidates must return conclusive decisions before selection. Uncertainty, failure or stale requirements/configuration holds the ticket for manual selection. Existing assignments are retained. Ready for AI remains the human authorization for code changes, and detection adds separately billed Cursor work. The [automatic selection contract](development.md#automatic-repository-selection) owns limits, recovery and compatibility.

On 13/10/2026 the User approved guided state actions from the ticket/repository and treatment tables: revise eligible repository selections, cancel unclaimed queued work, and retry eligible runs. Each mutation needs a separate owner-bound confirmation, preserves historical results and publication safeguards, and rechecks eligibility against worker claims and concurrent edits. The [guided state contract](development.md#guided-state-actions) owns the transitions and limits; this does not enable arbitrary execution-state or ClickUp-status editing.

On 12/10/2026 the User required frontend/backend maintenance to retain the same Slack channel, ClickUp Folder and List, and approved selecting both repositories for one ticket. Development now requires a separately confirmed repository choice for shared-folder tickets, supports one or several project repositories, and holds unassigned Ready for AI tickets. Each selected repository has its own run, checks and commit; the shared ticket reaches `to build` only after all selected corrections have pushed successfully. This is the default manual workflow; the opt-in automatic extension above permits repository inference. Automatic rollback/merge remains excluded. The [shared-ticket contract](development.md#shared-tickets-across-repositories) owns selection, atomic admission, retries and historical-work recovery.

The User's 04/10/2026 authorization to use existing local `.env` files and the EOA backend/tunnel setup are recorded in the [Development environment contract](development.md#local-worker-setup) and [EOA runbook](development-eoa.md). Configuration values stay local; this does not change other Modules' access boundaries or authorize publishing secrets.

The User subsequently requested automatic local environment startup. Trusted worker configuration now starts dependency services in order before the frontend and Cursor: EOA uses `orient-action-api` → `npm run develop`, then `ngrok http 8087`, then the per-run frontend. Readiness, explicit reuse of already-running services, tunnel identity checks and cleanup ownership are defined in the [Development contract](development.md#local-worker-setup). This does not add a server-side command execution API or authorize deployment.

The User approved the [Development contract](development.md) on 03/10/2026 and authorized implementation. The new `development` Module connects a Slack channel, ClickUp Folder, repository and Cursor skill, with everyone in the channel able to interact. Signed project-channel ticket links trigger investigation and threaded clarification, saved to ClickUp. A human's `Ready for AI` status authorizes a frozen ticket snapshot; a local worker investigates, implements and verifies it, with no execution deadline and at most two attempts total. It pushes one commit per ticket and selected repository to the locally configured destination branch (`maintenance` by default; any name using the branch grammar, including EOA's `stage/maintenance-ia`, approved on 11/10/2026), then sets **`to build`** and reports the result. A status change does not start another build while a pushed commit's delivery is uncertain. On 12/10/2026 the User approved an explicit retry of that run: the new build uses the current ticket and the worker's current branch, and the earlier commit stays on its original branch. PR/MR creation, merge into the configured base branch (`preprod` for EOA; `test` by default), deployment and final closure remain human actions. Cursor billing is explicitly separate from the existing OpenAI allowance. See [the ownership/execution decision](adr/0006-local-development-worker.md). This extends channel access only for Development and leaves other Modules' private boundaries unchanged. Live provider and deployment verification remain required.

## Audience and access

On 12/10/2026 the User clarified that Development operations must be available in both Slack project channels and private DMs. `development menu` opens setup, project status, repository selection and workflow controls on either surface, including before the first project exists; the private main menu also opens Development. Replies and modal confirmations return to the originating DM or channel thread. Channel screens are shared with channel members; DM screens stay private. Navigation and confirmations remain initiator/conversation/message-bound. Public ticket buttons only open a member’s own controls. Channel configuration fixes the originating channel and cannot reveal another channel’s projects. DM configuration offers a channel selector and shows only projects accessible to both the User and bot, with checks on current and proposed channels before saving. Membership is rechecked for each project operation. Private actions still affect shared project state; ticket links, clarifications and worker reports remain in project channels. Channel ingress accepts only Development’s opted-in namespace, leaving other Modules and personal budget messages private. See the [channel interface](development.md#clickable-channel-interface) and [decision](adr/0011-development-channel-interface.md).

- One Slack workspace, serving the user's team of 10.
- User interactions are private except Development's explicitly connected project channels. Yousign's approved automatic notifications post to selected channels under [its own contract](yousign.md); other Modules retain their existing private boundaries.
- Each Mail Sorter user connects at most one personal-to-them Google Workspace Gmail account; connecting Gmail is not required to use the assistant's shared commands or other independent modules.
- Each user has separate Gmail authorization, rules, project mappings, conversation history, previews, and action records.
- No shared team rules in version one. Team administrators may manage availability and connection health through the product but cannot browse other users' mail, rules, or conversations through it.
- Application-level isolation is required; this is not a promise that infrastructure operators or external platform administrators have no technical access.

Documentation's explicitly approved workspace-shared inventory/history is described in [its own contract](documentation.md#spending-availability-and-private-state). That shared access does not grant access to another User's private Mail Sorter or ClickUp state.

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

Evaluate urgency, newsletters versus transactional mail, project ambiguity, and adversarial message text on representative consented or synthetic messages. Unit tests establish workflow safeguards; they do not establish model accuracy.

Supporting research: [TypeSafe](research/typesafe-evaluation.md), [OpenAI](research/openai-fit.md), and [previous hosting comparison](research/hosting-options.md). The prior hosting comparison is background research, not a current provider decision.
