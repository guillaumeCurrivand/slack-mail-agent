# Central connection overview

Users can open one private Slack screen to find their connected applications and applicable team integrations. Each enabled module publishes a small read-only summary and a destination for its own management screen. The summary reflects local state without decrypting credentials or contacting providers.

Connexion uses the existing owner- and conversation-bound navigation into each module. Credential storage, OAuth, channel access, approval, and revocation remain under the module that owns the connection. This keeps changes to a provider's connection flow local and avoids a second registry of credentials or permissions. See the [Connexion contract](../connexion.md).
