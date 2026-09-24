# Future Tasks module

Status: agreed direction; not implemented. This brief preserves the next design conversation's starting point, not an approved feature specification. See [the current product specification](../product-spec.md) for what ships today and [the module guide](../adding-a-module.md) for extension mechanics.

## Agreed direction

Tasks will live in the same assistant and return a private task list to each user. It will look for requests addressed to that person in selected Slack channels they can access, including requests expressed through an @mention or through the message's wording. It must be usable without connecting Gmail. Module-prefixed requests such as `tasks list` will select it explicitly.

## Decisions still needed

- **Sources and access:** who selects channels, which channel types qualify, how the assistant obtains access, and what happens when the user's access changes. Private replies do not imply permission to read every conversation.
- **Task recognition:** how to distinguish a request from an FYI or a mention; how to infer the intended person without an @mention; whether ambiguous candidates require confirmation. For example, “Could someone review this?” does not identify an assignee.
- **Collection:** whether discovery runs on demand or in the background, the lookback period, thread handling, and how to handle edited or deleted messages and duplicate requests.
- **Task lifecycle:** what marks an item accepted, completed, dismissed, or reopened; whether due dates, reassignment, or reminders are in scope. Listing tasks does not by itself settle these behaviors.
- **Evidence and privacy:** which excerpts or source links appear in the list, what data is retained and for how long, and what is removed when access is lost or the module is disabled.
- **Quality and cost:** examples that demonstrate acceptable detection, how the module behaves when the shared allowance is exhausted, and whether a separate module usage limit is needed.

## Next step

Resolve these questions through the design interview, then write an approved feature specification and scoped implementation work. Enabling channel access, changing Slack permissions, and building Tasks belong to that future work.
