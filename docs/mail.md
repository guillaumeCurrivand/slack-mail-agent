# Mail Sorter module

Mail Sorter (**Tri des e-mails** in Slack) prepares changes to your own Gmail using your approved rules. You review a Preview before approving labels, archive or Trash actions. It processes individual messages from the latest 100 inbox messages when you request it.

Status: implemented locally and enabled by default. Live Slack/Google/OpenAI integration and model-quality validation remain release checks. The [Mail Sorter contract in the product specification](product-spec.md#mail-sorter-module) owns approved behavior; this guide explains how to use it. [All modules](../README.md#modules-and-project-structure) share the same bot and AI allowance.

## Availability and setup

The deployment must include `mail` in `ENABLED_MODULES`. Mail Sorter needs Google OAuth configuration, the existing encryption key and OpenAI configuration; follow [Google Workspace setup](../README.md#google-workspace-setup) and [OpenAI setup](../README.md#openai-and-the-10-limit). Each person connects their own Google Workspace mailbox. Other Modules can be used independently of that connection.

## Quick start

1. DM `menu`, open **Tri des e-mails → Connexion Gmail**, and choose **Connecter Gmail** (or send `courrier connecter`). Open the single-use, 10-minute link, authorize your Workspace account, then confirm the displayed mailbox in Slack.
2. Open **Gérer les règles** or send `courrier modèles` to review starter rules. Describe project names and exact sender addresses separately. Review and approve each rule Proposal before it becomes active.
3. Send `courrier trier` or choose **Trier la boîte de réception**. This starts the scan and can use the shared AI budget.
4. Review the Preview, including proposed new labels and separate Trash actions. Inspect Details; explicitly include or skip uncertain messages. Confirm the specific Preview to apply its selected changes.
5. Read the Report and its Details. Use its undo control if you want to reverse eligible changes made by the Agent.

## Commands and menu

Send commands in your private DM with the bot. `courrier` is the French alias for `mail`; natural-language follow-ups also need a prefix. Opening this Module's menu does not route later unprefixed messages to it.

| Purpose | French shortcut | English shortcut |
| --- | --- | --- |
| Connect your Gmail | `courrier connecter` | `mail connect` |
| Review starter rules | `courrier modèles` | `mail starters` |
| Read approved rules and their IDs | `courrier règles` | `mail rules` |
| Request a new sorting Preview | `courrier trier` | `mail sort` |
| Open the latest Report | `courrier rapport` | `mail report` |
| Open retained Details | `courrier détails <run-id> [page]` | `mail details <run-id> [page]` |
| Propose disconnecting Gmail | `courrier déconnecter` | `mail disconnect` |
| Show Mail Sorter help | `courrier aide` | `mail help` |

Details page numbers start at zero; omitting the page opens the first page. Details show five messages per page. The menu also offers **Gérer les règles**, **Dernier rapport**, **Connexion Gmail** and **Approbations en attente** when eligible saved work exists. Add/Edit controls give instructions; rule removal and starter rules produce separately approved Proposals. Undo is attached to a retained Report.

Describe a rule after the prefix, for example:

```text
courrier Applique le libellé Projects/Alpha aux messages de alex@example.com et conserve-les dans ma boîte de réception.
courrier Modifie ma règle de lettres d’information pour exclure les annonces de produits.
```

For a correction, identify the retained run and message, for example `courrier Pour le message <message-id> du traitement <run-id>, retire le libellé Urgent et conserve-le dans ma boîte de réception.` Interpretation uses AI. Corrections receive their own Preview; changing future rules requires separate rule approval. See [Rules and conversation](product-spec.md#rules-and-conversation).

## Approvals, privacy and spending

Rules, mailbox authorization, conversations, Previews and action records belong to the Slack User. The Module does not offer shared team rules or access to another User's mail. Connection and disconnect each require explicit Slack confirmation; disconnect removes active credentials and cancels pending Previews while keeping rules. Revoking the Google grant is a separate account action.

Rule Proposals and sorting Previews have a 24-hour validity window. Changed rules or a changed Gmail connection invalidate an old Preview. **Approbations en attente** only reopens eligible saved rule Proposals and Previews; reading them does not extend validity or start another scan. See [Processing and approvals](product-spec.md#processing-and-approvals) for the authoritative safeguards.

Natural-language interpretation and semantic mail classification use the shared AI allowance. Menus, rule inspection, starter templates, retained Details/Reports, approval and undo need no paid generation. Overlapping sorting starts report the existing request. Use `budget` to read shared recorded and reserved usage; see [AI provider and budget](product-spec.md#ai-provider-and-budget).

Approved rules persist until removed. Conversation and action-record cleanup follows the [retention policy](product-spec.md#memory-and-undo), including paused cleanup while the Module is disabled. Slack, provider and backup retention are separate.

## Failure and undo behavior

The app checks labels and Gmail history IDs immediately before a write, then journals the exact label additions/removals before calling Gmail. Trash and archive are represented as individual-message system-label changes. A process interruption or ambiguous network failure marks the action unknown; it is not replayed or automatically undone. Inspect Gmail for these cases.

Undo reverses this Agent's recorded deltas only when the message still matches the state returned by its write. If another client edits or marks a message read, undo can conservatively skip it rather than overwrite that edit. Newly created empty labels are not deleted by undo. Messages permanently deleted by Gmail or a User cannot be recovered.

Gmail does not provide conditional mutation with a history-ID compare-and-swap. An external client can still race between the precheck and mutation. Application serialization prevents this app from racing with itself, but cannot eliminate Gmail's external-client race. See [integration contracts](research/integration-contracts.md).

If a Preview expires or becomes invalid, request a fresh scan. If a saved menu is unavailable, send `menu`. Sorting is on demand; scheduled processing, sending email and permanent deletion are outside the [approved scope](product-spec.md#processing-and-approvals).

## Implementation and verification

Module code lives in `src/modules/mail/`; application composition lives in `src/app/modules.ts`. Fake-provider workflow, rule, OAuth and navigation tests live in `tests/workflow.test.ts`, `tests/rules.test.ts`, `tests/oauth.test.ts` and `tests/navigation.test.ts`. Automated tests establish workflow safeguards, not model accuracy or successful deployment. Use [release checks](../README.md#remaining-release-checks) and [Updating production](deployment.md) for a runtime release.
