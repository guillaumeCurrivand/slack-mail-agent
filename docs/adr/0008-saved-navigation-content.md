# Saved content for in-place Slack paging

Status: accepted

Slack controls can show only a compact group of actions, and long Replies must remain one updating message without another AI call. Core therefore saves the full prepared display message in the existing owner- and DM-bound navigation row, then derives each visible button or text page from that content. The action group is sized by displayed label width and continued with navigation buttons; a Menu control stays available on each action page. Signed actions must match the saved message timestamp. A restart does not discard reachable pages or repeat paid work.

This adds a `content` JSONB column to `core_navigation_menus` at startup. It stores display text, table cells and control values for up to 30 days, including content that may have originated with an external provider. Existing navigation cleanup removes it with its row. Only the current visible page is sent to Slack. Definite delivery rejection restores the preceding saved content so a retry can proceed; an uncertain delivery is not resent blindly. Module data and approval lifetimes stay under their existing contracts.

On 05/11/2026, saved-content paging also became the fallback for tables that exceed one message’s row or character budget. Slice complete rows together with their already-bound actions; do not rerun the Module or renew its approvals to browse the next display page. Modules still own complete-value splitting when one row alone is too large.

On 27/11/2026, shared navigation began offering compact and full-width views of the same saved page. Slack data tables control their own column widths. The full-width view uses rich-text rows and standard action blocks so long cells wrap and signed row controls remain available. View switching uses the existing owner, conversation and message binding, without provider queries or new storage. Navigation also splits individual oversized rows into continuations and reserves enough Slack blocks for the full-width actions on each page. Modules that own provider pagination still supply each authorized result page.
