# 05: Run Cards

**What to build:** Preview, Details, and Report are labeled Cards. Counts and email items are lists, not a table. Run id and page sit in a context line or the body, not the kind header. Email subject, from, and id never render as markdown. Review, confirm, undo, and paging buttons still work.

**Blocked by:** 02 Help Card

**Status:** ready-for-agent

- [ ] Preview is a Card titled `Preview` with counts as a short list and the existing Review / Confirm / Cancel buttons
- [ ] Details is a Card titled `Details` with at most five numbered items and the existing include / skip / prev / next / confirm buttons
- [ ] Report is a Card titled `Report` with status counts and the existing Details / Undo buttons when those actions are valid
- [ ] Kind headers are exactly those names; run id and page number are not in the header
- [ ] Scanning (“Checking N inbox messages…”) stays an unlabeled Reply; the Preview Card follows
- [ ] A correction still sends a Preview Card, then an unlabeled “does not change future behavior” line
- [ ] Email subject, from, and id are escaped: `**FREE**` and `[click](http://evil)` stay literal characters
- [ ] Other interpolated run values (ids, status words) are escaped; engine list markers and labels like `From:` remain markup
- [ ] Existing workflow tests (isolation, uncertain include/skip, conflict, undo) still pass
- [ ] No Slack table, App Home, or `section` `mrkdwn`
