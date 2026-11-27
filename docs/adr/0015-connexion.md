# Central connection overview

Users can open one private Slack screen to find their connected applications and applicable team integrations. Each enabled module publishes a small read-only summary and a destination for its own management screen. The summary reflects local state without decrypting credentials or contacting providers.

Connexion uses the existing owner- and conversation-bound navigation into each module. Credential storage, OAuth, channel access, approval, and revocation remain under the module that owns the connection. This keeps changes to a provider's connection flow local and avoids a second registry of credentials or permissions. See the [Connexion contract](../connexion.md).

The optional side-panel pilot posts a separate Slack Work Object for a saved Connexion table. The public card contains an opaque reference and generic text. A signed Slack open event must match the original user, DM and message before the app issues a five-minute panel session. The session uses a URL fragment and authenticated requests from Slack's sandboxed iframe. The browser submits a row index. The server resolves it against the saved card and queues the existing read-only navigation for a fresh Slack screen. This keeps approval controls on their established message-bound path and avoids adding independent web mutation endpoints or storage.
