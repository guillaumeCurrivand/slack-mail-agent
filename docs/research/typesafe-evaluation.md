# TypeSafe AI evaluation for the Slack Gmail sorter

Researched 2026-09-17. Public documentation only; no account was created, API tested, or email data sent. This is a design recommendation, not a committed provider decision.

## Recommendation

Use OpenAI for the initial conversational agent, with a replaceable classification interface. Evaluate TypeSafe's Jev later as a specialist for semantic email classifications. It is a plausible complement or substitute for that classification step, but cannot replace the agent's text-generating conversations and rule explanations: its documented interface returns predefined typed decisions and probabilities without text generation. This recommendation is an inference from the product's capabilities, not a measured comparison on this team's mail. [TypeSafe introduction](https://docs.typesafe.ai/introduction)

## What it is and how it fits

TypeSafe supplies its own hosted model service, Jev. It is neither simply an OpenAI gateway nor an SDK for making chat output type-safe. Its API accepts application state and named questions. The three question types are a yes/no probability (`Noul`), a selection from declared options (`Choice`), and a rubric-based rating (`Score`). There is a hosted HTTP endpoint and SDK support; examples use `jev-latest`. [API reference](https://docs.typesafe.ai/api), [quick start](https://docs.typesafe.ai/introduction/quickstart)

The documentation's own quick start tests urgency, closely matching the requested `Urgent` label. Proposed use in this app: one semantic question for urgency, another for newsletter status, and optional questions for content-based project matching. Deterministic sender-to-project mappings should stay ordinary application logic. Multiple independent matches can produce multiple labels. This is a proposed design, not an existing TypeSafe Gmail integration. [Quick start](https://docs.typesafe.ai/introduction/quickstart)

Freeform chat, generating new rule text, negotiating exceptions, and explaining decisions still require a text-generating model or predetermined templates. TypeSafe recommends decomposing complex judgments into atomic questions and combining results in code. The app would remain responsible for identity isolation, Gmail authorization, rule persistence, preview, confirmation, conflicting actions, and undo. [Introduction](https://docs.typesafe.ai/introduction)

## Price and availability

The launch post advertises **$0.042 per million input tokens**, with free output tokens, and describes access as early access with a waitlist. At that published rate, a purely illustrative workload of 10 users × 100 messages × 22 runs/month × 1,500 billed input tokens/message totals 33 million input tokens, or **$1.386/month for Jev classification alone**. Actual input includes instructions and state; retries, multiple passes, conversation-model cost, and infrastructure are excluded. This is an assumption-based calculation, not a bill estimate or quotation. Confirm account availability and commercial terms before relying on it. [Launch announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

The public documentation reviewed describes a TypeSafe-hosted API with a TypeSafe API key. I found no documented self-hosted model deployment or customer-supplied OpenAI-key mode. Do not infer those options from an open-source client SDK. [Master customer agreement, sections 1–2](https://typesafe.ai/legal/mca), [API reference](https://docs.typesafe.ai/api)

## Reliability limits

Typed output validity does not establish that a newsletter or urgency judgment is correct. Choice and Score confidence is derived from the output distribution; Noul returns a probability without a separate confidence field. TypeSafe says thresholds must be tested against the specific domain. Retain the user's requirement that every run needs confirmation; uncertain classifications enter a separate decision group. No confidence score grants permission to act. [Confidence documentation](https://docs.typesafe.ai/confidence)

The vendor's launch post qualifies the large speed/cost headline as toward the upper end of real-world gains. Its reported workflow evaluations use other models' combined judgments as a reference and acknowledge potential selection bias. These results are not evidence of accuracy on this team's email. [Launch announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

## Data handling relevant to company mail

The privacy policy says input is not used to train or fine-tune models, services are hosted in the United States, and retention lasts as reasonably necessary for service/business purposes. It does **not** establish a fixed short retention period or zero data retention. The company's policy therefore does not automatically implement this app's proposed 30-day history policy. [Privacy policy](https://typesafe.ai/legal/privacy-policy)

The customer agreement additionally says customer data is not used for model-weight training without prior consent. It permits telemetry processing and describes telemetry broadly, including logs, summary statistics, and classifications. A DPA exists and limits personal-data processing to documented instructions, but the reviewed public terms do not establish EU-only hosting or a specific request-content deletion SLA. Check those points before sending real Workspace email. [Master customer agreement, sections 4.1–4.3](https://typesafe.ai/legal/mca), [Data processing addendum](https://typesafe.ai/legal/data-processing)

## Evaluation before adoption

Use consented or synthetic representative messages with human labels: urgency, newsletters versus receipts/transactional notifications, sender ambiguity, multiple labels, and conflicting keep/archive/trash rules. Compare false-positive trash decisions, abstention rate, latency, and actual cost against the chosen OpenAI baseline. Test isolation and approval controls independently of model quality. Do not choose arbitrary confidence thresholds as though they were proven accuracy levels.

Open questions: access and account rate limits; contractual retention/deletion terms; acceptable US processing; classification accuracy on the team's languages and email; and whether the small expected classification savings justify a second provider for 10 users.
