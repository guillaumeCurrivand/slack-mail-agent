# 02: Mail rule management and saved work

Status: ready-for-agent

**What to build:** A User can manage Mail Sorter rules, open their Latest report and return to Pending approvals through DM buttons. Reading saved work does not start new AI work or renew an approval's validity.

**Blocked by:** [01: DM navigation and Gmail connection](01-dm-navigation-and-gmail-connection.md).

**Specification:** [Clickable navigation in private Slack DMs](../spec.md). User stories 22–30 and the saved-work portions of 10–12, 14–15, 39 and 43; acceptance coverage 4–6 and relevant security/delivery portions of 11–14.

## Acceptance criteria

- [ ] Mail Sorter exposes Manage rules and Latest report, and shows Pending approvals when eligible rule Proposals or sorting Previews exist. Empty states explain what to do next and retain navigation.
- [ ] Manage rules lists the User's saved rules and offers starter rules, Add rule, Edit and removal. Long lists are bounded or paginated without losing actions or exposing another User's rules.
- [ ] Add/Edit posts clear DM instructions to supply a `mail`-prefixed description, identifying the intended rule when editing. Navigating never creates a remembered active Module. Existing conversational interpretation remains responsible for proposing changes.
- [ ] Starter rules, edits and removal reuse existing Proposals and explicit approval. Examples and ownership/version safeguards remain intact; navigation never directly saves or deletes a rule.
- [ ] Latest report reopens the existing latest Report, with available Details and undo controls, without starting another scan. Missing Reports receive useful guidance.
- [ ] Pending approvals lists eligible saved rule Proposals and sorting Previews with enough context to choose the correct one. Reopening preserves original identity, owner, versions, expiry and invalidation; it does not rerun classification or grant fresh validity.
- [ ] Reopened workflow Cards are posted separately from navigation and retain their original approval/cancellation behavior. Menu buttons open separate navigation, preserving the source Card. Browsing updates only the intended navigation message.
- [ ] Old, cancelled, invalidated, already-approved and cross-user items cannot execute repeated or unauthorized effects. Give a safe current-state explanation when an item is no longer actionable.
- [ ] Details and targeted undo continue to use the existing workflow and recovery checks, including later mailbox changes and partial or uncertain outcomes. No alternate mutation path is introduced.
- [ ] Browsing rules, saved Reports and Pending approvals performs no AI calls and does not mutate saved domain state. A later explicit conversational rule request may use AI under the existing allowance.
- [ ] Module-owned data access, sanitization, retention and disabled-module behavior are preserved. Any schema change is idempotent and retains current saved work.

## Verification and delivery

- [ ] Test signed DM button requests through queue/dispatch and the actual Mail Sorter workflow with fake Gmail, AI and Slack. Seed existing approved rules, Proposals, Previews and Reports; this slice must not depend on ticket 04's new launch buttons.
- [ ] Verify new navigation/approval controls across empty and paginated lists, two Users, old controls, duplicate deliveries, restart recovery, rule-version changes, disconnect invalidation and already-resolved items.
- [ ] Assert saved-state review makes zero paid AI calls, separate Cards survive navigation, and reopened approvals reference the original item. Preserve existing fake-mailbox approval, cancellation and undo regression tests.
- [ ] Update authoritative documentation and examples for delivered behavior. Check Node compatibility; run relevant tests and project `test`, `check` and `build`. Report skipped PostgreSQL checks and unexercised live integrations separately.
- [ ] Review the complete diff and state whether changes are local, committed or pushed. Deployment is outside this ticket; any ready-to-deploy handoff must satisfy the repository deployment requirements.

## Comments

Approved as ticket 2 of the four-ticket breakdown. This can proceed independently of channel management and launch-button work once ticket 01 is complete. Existing typed commands already create the saved items this ticket browses.
