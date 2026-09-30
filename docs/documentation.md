# Documentation module

Status: approved target contract following approval of the ten-ticket breakdown. Tickets 01–06 are implemented locally; later slices below remain future work. Live integration, production deployment and actual spreadsheet import have not been verified or authorized by these implementation tickets. Current Agent safeguards remain in the [product specification](product-spec.md).

## Delivered locally — ticket 01

Documentation is opt-in with `ENABLED_MODULES` containing `documentation`. It adds Projects, Add Project and Help to its private menu with Back/Menu navigation. Disabled Documentation is not constructed, initialized, dispatched or cleaned up; its existing tables and paused jobs remain. It requires no Gmail or AI credentials.

- `documentation` or `documentation help`: show commands and field constraints.
- `documentation projects [page]`: browse eight Projects per page; typed page numbers start at zero and clamp to the last available page. Previous/Next and Project details update the private navigation message.
- `documentation project <identifier, exact name or alias>`: show current fields and clickable saved repository/documentation URLs. Exact identifiers take precedence; names and aliases match case-insensitively without partial or semantic matching. Ambiguous names/aliases open paginated choices, never a guessed Project.
- `documentation history <identifier, exact name or alias>`: show that Project's Change history, one entry per page, with actor, UTC time, source and exact saved fields. Creation shows no prior record. A History control is also available in Project details; ticket 02 adds edit history below.
- `documentation create project {"name":"Alpha","aliases":["A"],"description":"Example","repositories":["https://example.com/repo"],"documentationLinks":["https://example.com/docs"],"notes":"Example"}`: propose one Project using the fixed JSON fields. Only name is required. Omitted optional fields and explicit null remain Unknown; supplied empty lists/text remain empty. Names and aliases are trimmed and limited to 120 characters and one line; names must be nonempty. Up to 20 aliases, 1,500 characters each for description/notes, and 10 URLs per link list (400 characters per URL) are allowed. URLs must be HTTP(S) without credentials or whitespace. The normalized JSON record must fit within 5,000 characters so its full proposal is shown. Unknown fields, editable system metadata, multiple records and invalid input are rejected before proposal creation.

Creation posts a separate **Create Project confirmation** Card with the reserved stable identifier, exact normalized fields and the saved expiry time. Its initiating User can confirm only from the same DM, within 24 hours of saving the proposal. Browsing and menu navigation never approve it or replace it. The configured Slack workspace shares the inventory and initial history; confirmations, ambiguity selectors and delivery metadata remain private to their actor/DM. There is no additional membership check or permitted-user list. Existing signed ingress, workspace checks and other Modules' private data boundaries remain in force.

One PostgreSQL statement locks the saved confirmation and commits the Project, source-attributed initial history and applied confirmation checkpoint atomically. The history identifies the Slack actor and `Slack structured creation` source. Distinct click IDs and restarts report the saved outcome without adding Projects/history. A database failure rolls back all three. Delivery intent is checkpointed before Slack: explicit rejection permits retry; uncertain delivery is not blindly resent. A fresh request can inspect the saved outcome. Proposal retries preserve its identifier, fields and original expiry.

Project/history tables have lifetime retention. Enabled-module cleanup removes private interaction metadata older than 30 days, separately from inventory/history, while preserving delivery markers for pending jobs and confirmations/lookup records whenever that owner's Documentation work is pending. Cleanup cannot extend confirmation validity. All delivered paths make zero AI calls, including with an exhausted shared allowance.

## Delivered locally — ticket 02

Project details offer **Edit** instructions identifying the stable target and allowed fields. `documentation edit project <identifier, exact name or alias> {"description":"Replacement","notes":null}` proposes one Project edit using any nonempty subset of `name`, `aliases`, `description`, `repositories`, `documentationLinks` and `notes`. It uses creation's per-field constraints, with a 5,000-character normalized replacement-object limit. Omitted fields remain unchanged; optional fields accept null to clear to Unknown, while empty lists/text remain empty. A name must remain valid. Unsupported fields, identifiers, actor/time and lifecycle metadata, invalid values and multi-record objects are rejected. A missing exact target is explained; ambiguous names/aliases require inspection and resubmission with a stable identifier, never a guessed mutation.

The separate **Edit Project confirmation** Card shows the target identifier and exact normalized selected replacements. Its saved operation belongs to the initiating User and DM and expires after 24 hours. Proposal delivery retries retain the target, replacements and original expiry, including after a rename. Browsing, instructions and navigation cannot save an edit. All structured edit, confirmation and history paths need no AI or Gmail and remain available with an exhausted AI allowance.

Confirmation locks the saved operation and shared Project in the database, applies only approved fields to the current record, and atomically appends Change history and the terminal effect checkpoint. It never rejects a stale record version. Alice proposing description A, Bob saving B plus notes, and Alice confirming saves A, records B → A, and preserves Bob's notes. Names change in place: identifiers, pending confirmations and history still identify the same Project. Lookup uses current names/aliases with explicit ambiguity handling.

Edit history includes only fields that actually changed, with their commit-time before/after values, Slack actor, UTC time, stable Project identifier and `Slack structured edit` source. `documentation history` and the Module's **History** control browse workspace-shared history; the existing record-specific command/control remains available. Both paginate one entry at a time. Long Project details and history entries offer **More values**/**Previous values** pages to show all literal fields without truncation. Inventory can grow beyond creation's single-object limit through separate valid field edits. Users cannot edit history or restore earlier values through a dedicated control in this slice.

Repeated clicks, restart/retry and delivery errors report the saved applied outcome without reapplying it after a later edit. The result Card distinguishes an applied replacement, an already-satisfied selection (no mutation or new history) and a missing target (no mutation). A database/history error rolls back the edit and effect checkpoint, allowing a retry against current values. Existing uncertain-delivery rules remain: definite rejection permits retry; uncertainty is not blindly resent. Cleanup cannot erase checkpoints needed by pending work or expire lifetime inventory/history.

## Delivered locally — ticket 03

The Module menu adds **Technologies** with **Add Technology**, while Project details add **Components** with **Add Component**. Lists show eight records per page and update the private navigation message. Technology details expose Edit, History and a paginated Components list naming each parent Project. Component details expose Edit, History, the parent Project and each linked Technology. Shared History includes all three delivered record kinds and a Record details control. Names can change without changing identifiers, parent relationships, Technology references or pending confirmations.

- `documentation technologies [page]`: browse the shared catalog; page numbers start at zero and clamp to the last page.
- `documentation technology <identifier or exact name>` and `documentation component <identifier or exact name>`: read details. Identifiers take precedence over case-insensitive exact names. Ambiguous names open paginated choices; partial matching and guessed mutations are unsupported.
- `documentation components <Project identifier, exact name or alias> [page]`: browse a Project's Components. A complete exact Project name takes precedence over interpreting a trailing number as a page. Ambiguous Projects open choices.
- `documentation history technology <identifier or exact name>` and `documentation history component <identifier or exact name>`: read record-specific history, one entry per page. The existing shared/Project history commands remain available.
- `documentation create technology {"name":"React","category":"Frontend","notes":"Example"}` and `documentation edit technology <identifier or exact name> {"category":null,"notes":"Replacement"}`: propose one Technology creation or selected-field edit. Supported fields are name, category and notes. Name is required, trimmed, nonempty, one line and at most 120 characters; category allows 120 characters and notes 1,500. Omitted creation values and null are Unknown; empty optional text stays empty.
- `documentation create component {"name":"Web client","projectId":"<Project identifier>","type":"frontend","technologies":["React","<Technology identifier>"]}` and `documentation edit component <identifier or exact name> {"name":"API","type":"backend","technologies":[]}`: propose one Component creation or selected-field edit. Name follows Technology name constraints. Type is optional text of up to 120 characters; there is no required type vocabulary or invented business data. Creation requires the stable identifier of an existing workspace Project as `projectId`. The parent is fixed; edit fields are name, type and technologies. Technologies accepts at most 20 existing identifiers or exact names; names must resolve unambiguously. Selections are deduplicated and saved as stable identifiers before the confirmation Card is shown. Null means Unknown; an empty list means no Technologies. Missing catalog entries require a separate confirmed Technology creation.

Add/Edit instructions identify the record kind and stable target or Project parent and list supported fields. Unsupported fields, system metadata, parent changes, invalid names and multi-record requests are rejected. Unknown or ambiguous targets/references do not create a pending mutation. Several Components in different Projects can share one catalog Technology without duplicating it. Hosting is delivered by ticket 04 below.

Creation and editing reuse the 24-hour initiating-User/DM-bound confirmation and selected-field overwrite policy described above. Proposal persistence validates targets, references and workspace; apply revalidates supported saved fields, the current target, its Project parent and all resulting Technology identifiers within the workspace. A database statement locks the confirmation and current shared target, protects referenced rows, and commits the mutation, actual before/after history and terminal checkpoint atomically. A parent foreign key additionally protects Component identity. History failure rolls back creation/editing and its effect checkpoint. Missing or invalid references report failure without a mutation or history entry; matching fields report an already-satisfied edit. Replays, restart and delivery errors retain the saved outcome and cannot repeat effects after later edits. Lifetime inventory/history and private cleanup rules remain unchanged.

All delivered reads, instructions, proposals and confirmations use no AI or Gmail and remain available when the shared AI allowance is exhausted. Automated checks use fake messaging and an embedded database; real PostgreSQL concurrency requires `TEST_DATABASE_URL`, and live Slack/deployment remains unverified.

Natural-language interpretation, remembered Project context and import are **later slices**, with no exposed controls yet. The rest of this document specifies their approved target. No real spreadsheet has been imported and the source spreadsheet's authority has not been switched by this implementation.

## Delivered locally — ticket 04

Documentation adds **Hosts/services** and **Add Host/service** to its private menu. Component details offer **Hosting entries** and **Add Hosting entry**. Each list paginates eight records at a time. Host/service details navigate to linked entries; entries navigate to their Component and shared service. Details and shared History retain stable identifiers and actor/source-attributed lifetime history. Renames preserve every relationship.

- `documentation hosts [page]`: browse shared Hosts/services. `documentation host <identifier or exact name>` and `documentation history host <identifier or exact name>` show details/history. Exact identifiers take precedence; case-insensitive exact names with multiple matches open paginated choices. Ambiguous edits/references require a stable identifier.
- `documentation create host {"name":"OVH","role":"Compute","monthlyCost":12.5,"currency":"EUR","notes":"Example"}`: propose one shared service. Only name is required. Name follows existing one-line/120-character constraints; role allows 120 characters and notes 1,500. Monthly cost is a finite nonnegative number up to one trillion; currency is an explicit three-letter code normalized to uppercase. Known cost requires currency. Omitted optional fields remain Unknown. Unknown cost is distinct from zero; cost stays exclusively on this shared record.
- `documentation edit host <identifier or exact name> {"role":null,"monthlyCost":null,"currency":null}`: propose selected replacements. The merged record must retain currency whenever cost is known, validated both before proposing and against commit-time values. An intervening edit that makes the selection invalid produces a saved failed outcome without a mutation/history entry. Other valid edits retain the approved overwrite policy.
- `documentation hosting <Component identifier or exact name> [page]`: browse a Component's entries with production first. Ambiguous Components require inspecting `documentation component <exact name>` and resubmitting with one stable identifier. `documentation hosting-entry <identifier>` and `documentation history hosting-entry <identifier>` inspect an entry/history.
- `documentation create hosting {"componentId":"<Component identifier>","serviceId":"<existing Host/service identifier or exact name>","environment":"production","accountReference":"Team account","urls":["https://example.com/app"],"accessInstructions":"See password manager","notes":"Example"}`: propose one entry with a fixed Component parent and required existing service. Environment is optional, one line, at most 120 characters. Account reference, access instructions and notes allow 1,500 characters each; URLs follow the existing 10-link/400-character HTTP(S) constraints. Only necessary relationships are required; omitted optional values remain Unknown. Creation/selected replacements fit 5,000 normalized JSON characters. Store account references, instructions and password-manager links; never submit passwords or API keys. Secret fields and credential-bearing URLs are unsupported.
- `documentation edit hosting <identifier> {"environment":"staging","serviceId":"<existing Host/service>","notes":null}`: propose selected business fields; the Component parent and system metadata cannot be edited. Optional fields may be cleared to Unknown with null; empty values remain empty. Each missing service requires a separate confirmed creation. Parent/service kind, identity and workspace are validated at proposal and apply boundaries; apply locks referenced rows.

Project details show paginated Components and environments, production first, saved hosting URLs, stable detail controls and explicit missing values. Projects without recorded Components/entries show Unknown. Each page contains up to eight entries or Components without hosting; Previous/Next retains the Project. Long literal values use the existing value pagination. A saved link is available to open; the Agent does not read it. Several entries across Components/environments/Projects may reference the same service, without copying its cost.

Add/Edit instructions, browsing, exact lookup, confirmations and history use no AI or Gmail, and never contact or change infrastructure providers. Each save affects one record, requires the initiating User's separate DM-bound confirmation within 24 hours, preserves unrelated fields, and commits actual before/after history with the terminal effect checkpoint atomically. Failed/satisfied operations and replay/restart/delivery recovery reuse the existing safeguards. Existing Projects, Technologies, Components, history and pending controls remain compatible. Natural language and import remain later slices.

## Delivered locally — ticket 05

Documentation adds **Tools** and **Add Tool** to its private menu. Project details offer a paginated **Tools** list; Tool details navigate to every saved Project relationship and offer Edit/History. Lists show eight records per page. Exact names match case-insensitively; identifiers take precedence. Ambiguous lookups offer paginated choices, and ambiguous edits/references require a stable identifier.

- `documentation tools [page]`, `documentation tool <identifier or exact name>` and `documentation history tool <identifier or exact name>` browse Tools, details and lifetime history. Shared History includes Tools and navigates to their details.
- `documentation create tool {"name":"Slack","category":"Communication","usage":"Company chat","referent":"Team contact","companyWide":true,"projects":["Alpha","<Project identifier>"],"notes":"Example"}` proposes one Tool. Only name is required, trimmed, nonempty, one line and at most 120 characters. Category allows 120 characters; usage, referent and notes allow 1,500 each. `companyWide` accepts true, false or null. `projects` accepts up to 20 existing Project identifiers, exact names or aliases, resolved unambiguously and deduplicated to stable identifiers before proposing. Creation and selected replacements fit 5,000 normalized JSON characters.
- `documentation edit tool <identifier or exact name> {"usage":"Replacement","referent":null,"projects":[]}` proposes any nonempty subset of name, category, usage, referent, companyWide, projects and notes. Omitted fields are preserved. Null clears optional fields to Unknown; empty text/lists remain empty. System identifiers, actor/time, lifecycle metadata and history cannot be edited as business fields.

Company-wide and Project usage may coexist. Omitted usage, referent, company-wide status and Project links remain Unknown. Usage is descriptive text: unmatched words never create Projects or relationships. Missing Projects require a separate confirmed Project creation; ambiguous names/aliases require explicit resolution. Referents describe inventory contacts, confer no exclusive edit authority, trigger no notifications and add no membership check. Another User with existing bot/workspace access can read/edit the Tool using their own confirmation.

Every save affects one record and reuses the initiating-User/DM-bound 24-hour confirmation, selected-field overwrite, unrelated-field preservation, actual before/after history, terminal replay outcome and delivery/restart recovery described above. Tool Project references are workspace-validated at proposal and against the merged record at confirmation, with referenced-row locks at commit. Tool and Project renames retain identities and links. All delivered Tool paths use no AI or Gmail, including with an exhausted AI budget. Existing inventory and pending controls remain compatible. Natural language, remembered context and import remain later slices.

## Delivered locally — ticket 06

All six record kinds offer **Archive** while active and **Restore** while archived. These private, message-bound controls propose a separate confirmation Card; navigation never applies the change. Typed equivalents are `documentation archive <project|technology|component|host|hosting|tool> <identifier or exact name>` and `documentation restore <kind> <identifier or exact name>`. Project aliases also work; Hosting entries use stable identifiers (`hosting-entry` is accepted as an alternative kind). Ambiguous targets require inspection and resubmission with one identifier. Every Documentation User may propose and confirm changes through their own controls without extra roles.

`documentation archived [page]` and the Module's **Archived** control browse all archived kinds together, eight records per page with private Previous/Next navigation. Ordinary lists omit archived records; exact lookup, explicit relationships and history retain access. Details and history show current status. Current Project hosting details label archived Components, Hosting entries and Hosts/services; Component and Tool references label archived Technologies and Projects. Archival changes only the selected record: it never deletes fields, identifiers, relationships or history, nor cascades to referencing records. Restore retains all of those values.

Archive/Restore confirmations retain the initiating User/DM and original 24-hour expiry. Confirmation locks the saved operation and shared record and atomically saves the actual `archived: false → true` or `true → false` history plus terminal outcome. Already-satisfied operations save an outcome without adding history. Replaying either operation after a later opposite change reports its saved outcome and cannot repeat the effect. Sources are `Slack structured archive` and `Slack structured restore`. Failed history writes roll back the state and checkpoint together; definite delivery rejection permits retry, while uncertain delivery is not blindly resent.

New edits of archived targets require restoration. An edit proposed before archival remains pending when clicked while archived; after a separately confirmed Restore, it may be retried within its original 24-hour window. Restoration never refreshes that window. Intervening ordinary edits still follow the approved selected-field overwrite policy. Disable/re-enable preserves inventory/history and pending operations while expiry keeps running. These paths need no AI, Gmail or provider calls. Permanent deletion and dedicated restoration of earlier field values remain unavailable.

## Requested outcomes

- Manage the company's existing project, technology, hosting, and tool inventory through the Slack Agent.
- Allow people with access to the bot in its Slack workspace to edit inventory fields, with a history of changes.
- Answer natural-language questions such as "Where is this project hosted?" using inventory facts and links to documentation.

## Approved target decisions

These choices define the approved target. Only the capabilities under Delivered locally are currently available; the remaining behavior is assigned to later tickets.

- The database becomes authoritative after importing the spreadsheet. See the [authority decision](adr/0004-authoritative-documentation-inventory.md).
- Trust the bot's existing Slack workspace access boundary; do not add a company-membership check or permitted-user list. Existing signed Slack ingress, configured-workspace validation, and actor-bound private interactions still apply.
- Initial answers use inventory facts and links to documentation. Reading or indexing linked documents is outside the initial scope.
- Users can create records, edit values and relationships, and archive obsolete records. Keep initial fields predefined; users cannot add field definitions through Slack.
- The new Module is named Documentation, with the typed prefix `documentation` under the existing routing contract.
- Interactions remain in private DMs. Natural language supports questions and edits; edits show the selected record and before/after values for confirmation, alongside browsing/navigation controls.
- Projects have components, with distinct hosting entries per environment.
- All Documentation users can view append-only history recording actor, time, and before/after values, retained for the inventory's lifetime. Corrections create new entries; users cannot rewrite past history.
- Confirmation applies the approved field changes even if another user changed the record after the preview. Do not reject confirmation because of a stale record version. Preserve unrelated fields, commit each change and its history atomically, and record the actual values replaced at commit time.
- Edit confirmations expire after 24 hours and belong to their initiating actor. If the target is archived, require explicit restoration before editing it. Intervening field edits still do not block a current confirmation.
- Archiving a host does not automatically archive its projects or remove references. Exclude archived records from ordinary browse lists, provide an archived view, and visibly label archived records when current projects reference them. All Documentation users can restore archived records.
- Remember the most recently unambiguously selected project in each user's Documentation conversation for 30 minutes; ask when ambiguous or expired. This does not change explicit module-prefix routing.
- Access fields store instructions, account references, and password-manager links rather than passwords or API keys.
- Tools can be company-wide, linked to specific projects, or both.
- Initial mutations affect one record at a time; questions can span the inventory. Bulk mutations are deferred.
- Dedicated controls to restore earlier field values from history are deferred. Users can make ordinary confirmed corrections, which append new history.
- Prepare an import review before switching authority: map clear cases, preserve original text for uncertain cases, and ask the user to resolve ambiguous mappings before the database becomes authoritative.
- Support natural-language record lookup, relationship questions, combined filters, and counts across the inventory; paginate longer lists.
- Hosting answers show recorded components and environments with production first, record-detail controls and relevant documentation links. State missing information explicitly and ask which project when names are ambiguous.
- Provide clickable Projects, Technologies, Hosts/services, Tools, Archived records, and History lists. Add/Edit controls identify the record and guide the user through a typed request; explicit structured commands allow edits without AI.
- Use the existing PostgreSQL and shared $10 monthly AI ceiling. When AI is unavailable, natural-language interpretation pauses while browsing, exact lookup, history, and structured mutations remain available.
- Spreadsheet exports are deferred. Do not synchronize with the old spreadsheet or periodically import it.
- Initial import is a one-time operator task from a reviewed spreadsheet snapshot; ongoing maintenance happens through Slack.

## Initial record fields

- Projects: name, aliases, description, repositories, documentation links, notes.
- Components: name/type, technologies, linked hosting entries.
- Hosting entries: environment, provider/service, account reference, URLs, access instructions, notes.
- Technologies: name, category, notes.
- Hosts/services: name, role, optional monthly cost and currency, notes.
- Tools: name, category, usage, referent, project links, notes.

Only names and necessary relationship identifiers are required. Missing information stays unknown. A hosting account/service can support multiple projects. Record identifiers, archival status, and history metadata are maintained by the module, rather than editable business fields. These are initial fixed field definitions, not a dynamic-schema feature.

## Relationships and identity

A Project has distinct Components. A Component can use multiple Technologies and have multiple Hosting entries; each Hosting entry names an environment and references a Host/service. Several Projects can use the same Host/service. Tools can link to multiple Projects and can also be marked as company-wide.

Use stable record identifiers for relationships, confirmations, history, and remembered project context. Renaming a record changes its display name rather than duplicating it or breaking references. Project aliases help lookup; ambiguous names or aliases produce a choice instead of a guessed match. Existing referenced records must be identified unambiguously before saving a relationship. If a referenced catalog record does not exist, create it as a separate confirmed individual-record operation.

Costs, when present, belong to their Host/service record with an explicit currency. Unknown cost is not zero; shared service costs are not copied into every linked project. Business values may be cleared when optional. A record must retain a valid name and necessary parent/reference identifiers.

## Natural-language answers

Example requests include `documentation where is Project X hosted?`, `documentation which projects use React and OVH?`, and `documentation how many projects use this technology?` Every typed request, including a follow-up using "this project", retains the module prefix under the [existing routing contract](adr/0002-private-assistant-modules.md).

Interpret questions into supported, validated read operations over current inventory records. The model does not execute arbitrary SQL, create facts, or make mutations while answering. Query results determine matches and counts; answer wording must preserve unknown fields and the coverage of paginated results. Clarify ambiguous projects, references, or requested relationships instead of silently choosing one. A combined-filter question must not silently impose a same-component relationship if its wording does not establish that relationship.

Use record-detail controls or stable record identifiers as the source for inventory claims, and show relevant saved documentation/repository/access links. A saved link is a link to open, not evidence that its destination has been read. The module does not fetch linked documents, repository contents, or web pages in version one. Embeddings and vector retrieval are outside the initial scope.

Remember only the most recently unambiguously selected Project for that person's Documentation interaction, for the agreed 30-minute window. An unresolved choice does not establish a remembered Project. Expired or ambiguous context prompts a question. Context is private to that User and Module, while the referenced inventory is shared and read from current state.

## Slack navigation and structured operations

Documentation appears in the existing main menu when enabled. Its menu provides Projects, Technologies, Hosts/services, Tools, Archived records, History, and help, with normal Back/Menu navigation. Components and Hosting entries are reachable from their Project. Lists paginate and record details show available Add/Edit, Archive, history, and related-record controls. Archived details offer Restore. Navigation does not erase a separate confirmation or result Card.

Add/Edit controls identify the kind of record and existing target, list the allowed fields, and explain the typed request. Structured commands cover list/search by explicit names or identifiers, show details, create one record, update selected fields/relationships on one record, archive, restore an archived record, and read history. Exact command syntax can be chosen during implementation and must appear in help and controls; it must not require AI for those operations. Slack modal forms are not a version-one requirement.

Natural-language edits and structured edits enter the same saved confirmation workflow. Record identifiers and relationship selectors in controls are data validated by the module; namespacing or an AI interpretation alone does not grant approval.

## Mutation confirmation, overwrite, and recovery

Creating, editing, archiving, and restoring affect one record per confirmation. Show the target and proposed values or lifecycle change before saving. The initiating User must confirm their own saved operation within 24 hours of its creation; another person's button click cannot approve it. The pending operation stores the exact requested fields and replacement values. A request for multiple records asks the User to choose a single-record operation rather than executing a batch.

For an ordinary edit, confirmation applies the approved fields to the current record even if their values changed after the preview. It leaves every unrelated field unchanged. For example, Alice proposes host A, Bob subsequently saves host B, and Alice confirms: host A is saved, with B as the actual prior value in Alice's history entry. If Bob also updated notes and Alice did not propose changing notes, Bob's notes remain.

Serialize conflicting commits in the database and write each mutation, append-only history, and effect-deduplication checkpoint atomically. Do not use optimistic record-version rejection to undo the selected overwrite policy. Validation still applies to target existence, supported fields, valid references, workspace, initiating actor, expiry, and lifecycle state. An archived target requires a separately confirmed restoration before editing; expired confirmations require a fresh request. Records are archived rather than permanently deleted through this module.

Repeated clicks, Slack retries, or a process restart must not repeat a previously applied confirmation after an intervening edit. Persist its result and effect identity so retries can report the saved outcome. Delivery errors must not imply the database mutation failed or cause it to run again. Follow the existing transport's uncertain-delivery recovery rules. Report failed or already-satisfied operations accurately.

## Archive and history

Archiving retains the record, relationships, and history. Archiving a Host/service never automatically archives linked Projects; the same preservation rule applies to other referenced records. Ordinary browse lists omit archived records. Archived views and explicit references can show them, visibly labeled, and all Documentation users can request their restoration with confirmation. Referencing an archived record in an answer does not hide its archived status or imply it is active.

All Documentation users can read the shared history, including who performed each change, its time, affected record/fields, and actual before/after values. Users cannot edit history or its actor/time metadata. Import creates source-attributed initial history; ordinary creation, edits, archival, and restoration append their own history. Inventory and its history remain for the inventory's lifetime, including when the module is disabled.

Restoring an archived record is included. A dedicated operation or button to reinstate earlier field values from history is deferred. Users can inspect prior values and submit an ordinary confirmed edit, which follows the same overwrite policy and adds a new entry.

## Spending, availability, and private state

Use the shared module-attributed AI budget and existing reservations, ceiling, alerts, and per-user controls; the Documentation module does not create another allowance. Natural-language interpretation and any paid answer generation use that budget. Browsing, record/history reads, structured commands, confirmation, archive, and restoration do not need paid calls. If an API key, service, or budget is unavailable, explain that natural-language interpretation is unavailable and show the non-AI paths. Do not pretend an uninterpreted question was answered.

Inventory records and history are workspace-scoped and owned by Documentation. User context, pending confirmations, menu targets, and delivery bookkeeping remain actor-scoped. Do not expose another User's private conversation, saved confirmation controls, Mail Sorter data, or Slack Unanswered settings. Shared edit access does not alter private ownership in other Modules. Retrieved inventory text and links are data, not instructions authorizing operations or spending.

Pending confirmations expire after 24 hours; selected-project context expires after 30 minutes. Any retained conversational/delivery metadata follows the existing enabled-module 30-day cleanup convention, separately from lifetime inventory/history. Disabling Documentation pauses its work and module cleanup and preserves its inventory, history, and pending state under existing module lifecycle rules. Re-enabling does not extend confirmation validity.

## Import and transition

Use an operator workflow to inspect a spreadsheet snapshot and produce a mapping review before applying it. Preserve displayed names and links from hyperlink formulas, separate combined values where their meaning is clear, identify environments/components from supported source evidence, and reconcile referenced names against the catalog. Do not evaluate arbitrary workbook formulas or follow hyperlinks as commands.

The review lists resolved mappings, remaining ambiguous references, potentially distinct provider/services with the same name, and original text needed to make those decisions. The User resolves uncertain mappings before the database becomes authoritative; do not silently merge same-named records, discard unknown usage, or infer company-wide tool usage merely because a project-name match failed. Operator input and the reviewed snapshot determine the approved import batch.

Import is deduplicated and checkpointed so retrying the same reviewed batch cannot create duplicate records or initial history. Record provenance and the applied outcome, and verify imported records/relationships against the approved mapping. On failed or incomplete import, report its actual state and retain recovery information. Transition occurs only after the reviewed import is successfully applied and verified. Subsequent changes use Slack; editing the old spreadsheet does not update the inventory. A real production import is separate from local implementation and synthetic testing.

## Implementation and verification requirements

Implement this as the `documentation` built-in Module using the existing PostgreSQL, routing, messenger/navigation, job loop, and shared AI budget. Keep its tables, data access, interpretation, import logic, and retention inside the Module. No Gmail connection, new database service, or vector extension is required.

Update the module guide to distinguish workspace inventory ownership from per-user control/context ownership. Existing `team:user:module` worker locks do not serialize two Users editing the same inventory record; module-owned transactional coordination must protect shared-record commits without rejecting approved intervening edits. Explain this scope extension in the ADR and maintain isolation for the existing Modules.

Automated verification must exercise the public registry/routing/dispatch path with fake external providers, as well as the Documentation workflow. Cover: workspace/actor binding, prefixes, disabled availability, non-AI navigation/structured edits, constrained interpretation, missing/ambiguous references, question results and pagination, 30-minute context expiry, 24-hour confirmation expiry, one-record mutation limits, chosen overwrite behavior and unrelated-field preservation, archived-target handling, history atomicity, replay/restart recovery, shared budget exhaustion, and reviewed import/retry behavior.

Verify real PostgreSQL concurrent commits when `TEST_DATABASE_URL` is available; otherwise report those tests as skipped. Follow the repository's Node-version check and `test`, `check`, and `build` requirements for implementation. Live Slack/model-quality evaluation, production deployment, and actual data import are distinct verification steps and must not be reported as completed based on synthetic tests.

## Deferred scope

Dynamic fields, bulk mutations, history-value restoration controls, spreadsheet exports, recurring imports, Sheets synchronization, document-content ingestion, embeddings/vector retrieval, public-channel interactions, and a separate website are outside version one.
