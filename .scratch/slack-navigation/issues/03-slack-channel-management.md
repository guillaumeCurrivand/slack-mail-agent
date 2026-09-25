# 03: Slack channel management

Status: ready-for-agent

**What to build:** A User can open Choose channels from the Slack Unanswered DM menu and manage selected sources using a paginated list that updates in place, including clear handling of inaccessible selections.

**Blocked by:** [01: DM navigation and Gmail connection](01-dm-navigation-and-gmail-connection.md).

**Specification:** [Clickable navigation in private Slack DMs](../spec.md). User stories 31–35, 37 and the channel-management portions of 7–15, 39 and 43; acceptance coverage 7 and relevant navigation/security/delivery portions of 11–14.

## Acceptance criteria

- [ ] The Slack Unanswered menu exposes Choose channels and Back to menu, independently of Gmail authorization or mail configuration. Find unanswered's work button is completed in ticket 04.
- [ ] Choose channels shows eligible shared public/private channels with visible selection status and explicit Add/Remove buttons. Pagination and mutations update the same list message rather than appending navigation messages.
- [ ] Listings and additions enforce access shared by the authenticated User and bot. Recheck owner and channel access when handling a click; do not trust an old list or another User's button.
- [ ] Selected channels that become inaccessible remain visible with a safe explanation and Remove control. Temporary loss of access never silently deletes a selection or exposes inaccessible channel content.
- [ ] Removing the final selection leaves a useful empty state. No available channels, unavailable access and changed page contents produce usable navigation rather than broken controls. Bound list sizes and adjust pagination after changes.
- [ ] Selections persist per User and workspace across restarts. Another User's list or controls cannot disclose or change those selections. Existing typed `slack channels` behavior remains supported.
- [ ] Repeated action deliveries do not repeat effects or leak data. Old list controls use current state; disabled-module controls receive shared availability guidance without executing the Module.
- [ ] Channel browsing and selection make zero AI calls and do not start an unanswered search. Module-owned data access and existing channel selection semantics are retained.
- [ ] Signed update-target authorization, message sanitization, fallback text and safe Slack delivery recovery from ticket 01 apply to list updates. Retention, cleanup and any idempotent migration preserve disabled-module state.

## Verification and delivery

- [ ] Extend the existing signed DM/channel-selection harness through server, durable queue and worker using fake Slack providers, asserting both sends and in-place updates.
- [ ] Cover multiple pages, Add/Remove status, last-item removal, inaccessible selected channels, access changes between rendering and clicking, empty lists, two Users, duplicate deliveries, restarts and disabled Modules.
- [ ] Assert navigation preserves unrelated results, needs no Gmail credentials and makes no AI calls. Exercise definite delivery rejection and uncertain outcomes without blindly duplicating mutations or messages.
- [ ] Update authoritative channel/navigation documentation for this behavior. Check Node compatibility; run relevant tests and project `test`, `check` and `build`. Report skipped real PostgreSQL checks and unexercised live integrations separately.
- [ ] Review the complete diff and report local/committed/pushed state. Deployment is outside this ticket; any ready-to-deploy handoff must follow the repository deployment requirements.

## Comments

Approved as ticket 3 of the four-ticket breakdown. This can proceed independently of ticket 02 after ticket 01. It supplies the actionable selection/prerequisite flow needed by ticket 04.
