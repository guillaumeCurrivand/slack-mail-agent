# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root. This is the glossary for the single domain context.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If either file or directory does not exist, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill creates these lazily when terms or decisions are resolved.

## Use the glossary's vocabulary

Use terms as defined in `CONTEXT.md` in issue titles, proposals, hypotheses, and test names. If a concept is missing, note the gap for `/domain-modeling`. If a proposed change contradicts an ADR, surface the conflict rather than silently overriding it.
