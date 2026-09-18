# 03: Mailbox connection Cards

**What to build:** Connect, Confirm mailbox, and Disconnect Gmail are labeled Cards. The Connect URL is a real https link the engine minted. Existing Connect / Cancel / Disconnect buttons keep their meaning.

**Blocked by:** 02 Help Card

**Status:** ready-for-human

- [x] Connect is a Card titled `Connect` and the authorization URL is a clickable https link
- [x] Reply sanitizing does not strip that engine-owned Connect URL
- [x] After OAuth, Confirm mailbox is a Card titled `Confirm mailbox` with the existing Connect-this-mailbox / Cancel buttons
- [x] Disconnect Gmail is a Card titled `Disconnect Gmail` with the existing danger button
- [x] One-line acks after those decisions (connected, cancelled, disconnected) stay unlabeled Replies
- [x] Button `action_id`, `value`, and primary/danger styles are unchanged
