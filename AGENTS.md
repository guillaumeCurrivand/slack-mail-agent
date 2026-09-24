# Working in this repository

## Read the relevant source

- Changing behavior or reviewing requirements: read [the product specification](docs/product-spec.md). It is the source of truth for approved behavior and safeguards.
- Adding a module or changing routing, jobs, persistence, or spending: read [Adding a module](docs/adding-a-module.md). It defines the extension contract and ownership conventions.
- Naming domain concepts: use [CONTEXT.md](CONTEXT.md), which is a glossary, not an implementation plan.
- Changing an architectural decision: read the relevant [ADR](docs/adr/). Record the reason for a consequential trade-off there; keep current behavior in the specification.
- Implementing or changing Slack Unanswered: read [its approved feature contract](docs/slack-unanswered.md). Channel selection is implemented; message search and live Slack access setup are still pending.
- Running, configuring, or upgrading the application: use [README.md](README.md). Completed plans in `docs/archive/` provide historical context and do not override current documentation.
- Preparing a production update: use [Updating production](docs/deployment.md). Production uses Docker Compose; preserve the existing environment and database volume.

## Change discipline

Keep shared runtime code independent of mail workflows. Compose modules in the application layer; keep each module's domain behavior and data access within that module. Follow the module guide for new persistence and external integrations.

Preserve the product specification's user ownership, explicit approval, mutation recovery, and spending safeguards. Exercise changes through the public routing/dispatch path as well as the affected workflow when those seams change. Use fake external providers for automated tests.

Update the authoritative document when its contract changes, then update examples and links that depend on it. Prefer links over repeating the same requirement in another document. Label future ideas and historical verification results explicitly.

## Verification and delivery

Check that the active Node version satisfies `package.json` before running its scripts; some Windows shells select an older Node installation. Run the relevant tests and the project's `test`, `check`, and `build` scripts for runtime changes. Real PostgreSQL locking tests need `TEST_DATABASE_URL`; report skipped tests separately from passes. For documentation-only edits, verify local links and consistency with the implementation.

Review the complete intended diff, including newly added files. Report whether work is local, committed, or pushed, and include the commit identifier after committing. State any checks skipped or live integrations not exercised.

Every ready-to-deploy handoff must include the target branch/commit, copy-paste server commands to fetch the change and rebuild/restart the app, required environment or migration changes (or explicitly none), and post-deploy checks. Update and link the deployment guide when the procedure changes. Use the confirmed server setup; label unknown paths as placeholders. For documentation-only changes, say that pulling the commit is sufficient and no app restart is required. Distinguish locally verified release candidates from a successful production deployment; only report deployment success after observing it.

## Agent skills

### Issue tracker

Issues and specs live as local Markdown under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo: use root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
