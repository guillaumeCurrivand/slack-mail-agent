# HyperDX daily digest

The optional `hyperdx` module posts one French report per configured service in each Slack channel selected in the module. The existing bot queries HyperDX at 06:00 UTC each day and groups warning and error events by exact message and severity. It displays the top 20 by occurrence count, with up to 180 characters per message. An empty successful query produces an all-clear. The reporting window matches the previous digest: yesterday at 00:00 UTC through today at 06:00 UTC. Retries use that same cutoff.

## Activation and cutover

1. In the private server environment file, set `HYPERDX_API_KEY` to the existing HyperDX query credential and `HYPERDX_SERVICES` to a JSON array of exact service names. Keep real names and credentials out of source control. Invite the agent to each intended destination.
2. Append `hyperdx` to the existing `ENABLED_MODULES` after the new code is available. The bot uses its existing scopes for channel info and posting. Startup creates the module’s delivery table and a recurring integration job automatically.
3. From `/opt/slack-mail-agent`, run `docker compose up -d --build --no-deps app`, check `curl --fail http://127.0.0.1:3001/ready`, then send `hyperdx aide` in a DM. Open **Menu → Bilan HyperDX → Choisir les canaux** or send `hyperdx canaux` in a DM. Select **Activer** on each intended channel. Selections are shared across this workspace. Channel members will see excerpts from every configured service.
4. Verify one report per service from the existing agent in the intended channel. Then disable the previous scheduled job. To avoid duplicate posts during validation, use a restricted pilot channel first. To roll back, remove `hyperdx` from `ENABLED_MODULES`, recreate the app, and restore the previous schedule if needed.

## Timing and recovery

On first activation after 06:00 UTC, the module queues today's reports to the channels already selected at scheduling time. A restart resumes queued work. When an outage spans multiple days the scheduler skips older missed days. With no selected channels, no reports are sent. New selections apply at the next scheduled run. Removing a selection cancels pending sends to that channel, including if it is selected again later. Read failures and definite Slack rejections retry until the following cutoff. Each report has its own job, so a failed service does not block other services.

The worker records delivery intent before posting. An interrupted or ambiguous send is left for inspection and never automatically repeated. Operators can compare the target channel with recent delivery records (`sending`, `uncertain`, `sent`) and the worker's `job_failed` events. The delivery table retains job IDs and state for 30 days; it does not store log contents. No AI calls, separate Slack webhook, cron endpoint or external scheduler are required.
