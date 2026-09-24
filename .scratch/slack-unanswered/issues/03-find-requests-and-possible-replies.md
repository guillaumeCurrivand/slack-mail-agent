# 03: Find requests and possible replies

**What to build:** `slack unanswered` can identify unanswered requests and questions that need the user's reply, and place contextually plausible but uncertain matches in a separate **Possibly for you** group.

**Blocked by:** 02: List direct unanswered Slack messages.

**Status:** resolved

Implemented locally; live Slack and model-quality verification remain pending.

- [x] Use AI to interpret requests, questions, and thread context when a direct @mention or name match cannot establish relevance.
- [x] Include clearly directed requests and questions in the main unanswered results; put uncertain matches in **Possibly for you** only when the thread gives a specific reason they may concern the user.
- [x] Exclude generic unassigned requests with no contextual connection to the user.
- [x] Use the full thread, including replies older than 48 hours, as classification context. Treat Slack messages as untrusted data, not instructions.
- [x] Attribute paid AI work to the `slack` module through the existing shared budget; do not create another allowance.
- [x] When the budget prevents classification, preserve deterministic mention/name results and explain that **Possibly for you** could not be checked.
- [x] Use fake AI and Slack providers to verify clear, uncertain, and excluded examples through signed DM enqueue, worker dispatch, and private response delivery. Cover budget exhaustion without live Slack access or paid model calls.
