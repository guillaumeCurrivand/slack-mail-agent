# Hosting the internal Slack Gmail agent

Verified 2026-09-17 against first-party documentation. No accounts or resources created. Scope: 10 Slack users, one Google Workspace account each, manually requested 100-message batches, previews and confirmations, private persistent rules and undo records.

## Recommendation

Use **Render in Frankfurt**, with a paid web service and paid managed Postgres. Render supplies a public HTTPS endpoint and managed certificates, suitable for Slack events and Google OAuth callbacks. Frankfurt is an available app/database region; select it for both services and connect through the private network. This choice alone does not establish end-to-end EU residency for Slack, Google, model processing, logs, or control-plane data. [Web services](https://render.com/docs/web-services), [regions](https://render.com/docs/regions).

For this light initial workload, my architectural recommendation is one persistent application running both HTTP handling and a bounded background job loop. Store pending jobs, approvals, checkpoints, and per-message results in Postgres, so restarts resume work. Do not keep the only copy of an in-flight batch in process memory. This is an engineering inference, not a hosted queue guarantee. Render web services are long-running processes, and a dedicated worker can be added if concurrency grows. [Long-running web processes](https://render.com/tutorials/web-service-vs-static-site/web-services), [background workers](https://render.com/docs/background-workers).

## Render costs and limits

- Recommended starting setup if one person maintains infrastructure: Hobby **$0/month** workspace; web compute `0.5c-512mb` **$7/month**; Postgres `0.1c-256mb` **$6/month**; provisioned DB storage **$0.30/GB/month**. With a chosen 5 GB database, baseline is **$14.50/month**, excluding taxes, excess metered usage, and OpenAI. A separate small worker adds $7, totaling $21.50. These are starting sizes, not a tested capacity commitment. [Pricing](https://render.com/pricing).
- Hobby's one platform collaborator limit is separate from the application's 10 Slack users. Paid compute is independent of workspace subscription, so Pro is not required for this app solely because it has 10 users. Pro adds **$25/month** for multiple infrastructure maintainers and additional features; with the same resources it totals **$39.50/month**. Render's small-business guide explicitly illustrates always-on web plus paid Postgres on Hobby. Marketing describes Hobby as personal/solo-builder oriented; the reviewed docs did not state a commercial-use prohibition. [Workspace plans](https://render.com/docs/platform-features-by-plan), [small-business cost example](https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses).
- Initial DB storage can be 1 GB, making the absolute corresponding floors $38.30 on Pro or $13.30 on Hobby. Five GB is a sizing choice, not a minimum. Storage can grow but cannot shrink. [Database configuration](https://render.com/docs/postgresql-creating-connecting).
- Paid Postgres includes continuous backups: Pro has a seven-day point-in-time recovery window, Hobby three days; logical exports are retained seven days. This is distinct from storing 30 days of application undo records. Longer disaster-recovery retention needs exported backups. [Backups](https://render.com/docs/postgresql-backups).
- These small tiers are not a high-availability architecture. Free compute is unsuitable here: idle web services sleep and free databases expire after 30 days. [Free-tier limits](https://render.com/docs/free).

## Railway alternative

Railway Pro is **$20/month minimum**, credited against resource usage rather than added to it. Resources cost $10/GB-month RAM, $20/vCPU-month CPU, $0.15/GB-month volume storage, and $0.05/GB network egress. Thus $20 is a billing floor, not a verified app-plus-database quote; actual consumption must be measured. Hobby is $5 minimum for a single developer. [Pricing](https://docs.railway.com/pricing), [plans](https://docs.railway.com/pricing/plans).

Amsterdam is available. However, Railway explicitly describes its Postgres template as **unmanaged**, leaving configuration and maintenance with the application operator. Scheduled volume backups are available, with daily backups retained six days, weekly 27 days, and monthly 89 days. [Regions](https://docs.railway.com/deployments/regions), [Postgres responsibilities](https://docs.railway.com/databases/postgresql), [volume backups](https://docs.railway.com/volumes/backups).

Render is my preference because managed Postgres reduces operational work for this small internal product. Neither platform automatically supplies application-level user isolation, Gmail action undo, or protection against repeated job execution; those remain implementation requirements.
