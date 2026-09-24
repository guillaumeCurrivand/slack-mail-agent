# Independently available modules in one private Slack assistant

The assistant will offer built-in modules maintained in this repository and deployed together, starting with Mail Sorter. Modules share one bot and reply privately to each user, but own their user data and connection requirements and can be disabled independently; using another module must not require connecting Gmail. This supports the planned Slack Unanswered module without making the whole assistant depend on the mail workflow or requiring a runtime plugin system.

Every module request uses an explicit module prefix, including natural-language requests. Routing does not remember an active module or infer one from message content, so switching between capabilities cannot silently change the destination of a later request. This supersedes the earlier proposal to preserve bare mail commands such as `sort`; unprefixed requests should receive routing guidance instead of entering the mail workflow.

All modules share the existing $10 monthly AI ceiling, with spending attributed to its originating module. Separate module allowances are deferred; a module must not gain a fresh allowance by using a different workflow.

The user confirmed the shared understanding and authorized implementation. Slack Unanswered is an approved module contract, not part of this restructuring's implementation scope. Current behavior lives in [the product specification](../product-spec.md) and the [Slack Unanswered feature contract](../slack-unanswered.md); module extension conventions live in [the module guide](../adding-a-module.md). The [completed implementation plan](../archive/modularization-plan.md) is retained as history.
