# Working in this repository

## Read the relevant source

- Changing behavior or reviewing requirements: read [the product specification](docs/product-spec.md). It is the source of truth for approved behavior and safeguards.
- Adding a module or changing routing, jobs, persistence, or spending: read [Adding a module](docs/adding-a-module.md). It defines the extension contract and ownership conventions.
- Naming domain concepts: use [CONTEXT.md](CONTEXT.md), which is a glossary, not an implementation plan.
- Changing an architectural decision: read the relevant [ADR](docs/adr/). Record the reason for a consequential trade-off there; keep current behavior in the specification.
- Planning Tasks: read [the future Tasks brief](docs/future/tasks-module.md). Its open questions are unresolved, not requirements to implement.
- Running, configuring, or upgrading the application: use [README.md](README.md). Completed plans in `docs/archive/` provide historical context and do not override current documentation.

## Change discipline

Keep shared runtime code independent of mail workflows. Compose modules in the application layer; keep each module's domain behavior and data access within that module. Follow the module guide for new persistence and external integrations.

Preserve the product specification's user ownership, explicit approval, mutation recovery, and spending safeguards. Exercise changes through the public routing/dispatch path as well as the affected workflow when those seams change. Use fake external providers for automated tests.

Update the authoritative document when its contract changes, then update examples and links that depend on it. Prefer links over repeating the same requirement in another document. Label future ideas and historical verification results explicitly.

## Verification and delivery

Check that the active Node version satisfies `package.json` before running its scripts; some Windows shells select an older Node installation. Run the relevant tests and the project's `test`, `check`, and `build` scripts for runtime changes. Real PostgreSQL locking tests need `TEST_DATABASE_URL`; report skipped tests separately from passes. For documentation-only edits, verify local links and consistency with the implementation.

Review the complete intended diff, including newly added files. Report whether work is local, committed, or pushed, and include the commit identifier after committing. State any checks skipped or live integrations not exercised.
