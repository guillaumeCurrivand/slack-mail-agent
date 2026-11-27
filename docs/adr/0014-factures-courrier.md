# Reuse the user's Courrier connection in Factures

Factures can read a Gmail label selected by the owner of an existing Courrier connection. Reusing the authorization avoids a second Google consent flow for a mailbox the user already connected. Courrier owns decryption, token refresh and provider access. The Factures interface can list labels and read messages through a read-only adapter and receives no credentials. A token refresh during a Factures read does not write back a snapshot of Courrier state.

Factures stores the chosen Gmail label ID and the Courrier connection ID under the Slack owner. Replacing or removing the connection invalidates the selection. A renamed label retains its identity and a deleted label requires a new choice. Changing or removing the source is bound to its private Slack control and preserves the most recent decision on replay.

Personal label reports belong to the owner and stay in a private DM. The dedicated workspace mailbox remains the only source of scheduled summaries and Drive uploads. See the [Factures contract](../factures.md#utiliser-ma-boîte-courrier).
