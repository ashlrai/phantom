# StackSync EOS fleet capacity plan

Status: inventory and proposal only, 2026-11-14; RQ-STACKSYNC-WIRE-1.
No resources provisioned, inference requested, spending limits changed or runtime enabled.

## Evidence and account status

The owner reports approximately **$1,000/month of partner credits**. This is an
unverified planning assumption, not a measured balance, cash budget or spending
grant. Credit currency, eligible EOS products, expiry, renewal date, overage
behavior and other users' commitments remain unknown. The public Platform plan
starting at $1,000/month is a subscription price, not proof of this partner grant;
EOS is separately advertised from $5/month/app. See [public pricing](https://www.stacksync.com/pricing).

EOS 5.2.1 and its `deploy-with-eos` skill were inspected. This worktree has no
`.agents/skills` copy; the skill was read from the main checkout. The supplied
`~/.ashlr-runs/stacksync-api-key` could not be opened (`PermissionError`), so its
type, mode and account identity were not verified. `eos auth status --json`
reported no usable login; workspace list/current and model discovery failed on
protected local configuration. No authenticated resource request succeeded.

[queue/resources-ledger.json](../../queue/resources-ledger.json) records that
failed observation, with account facts explicitly `null`. `attemptedAt` dates the
attempt; `observedAt` stays null. This is a new advisory snapshot, with **no runtime
consumer**. It neither publishes capacity nor supplies router eligibility. The
existing [resource evidence rules](../RESOURCE-EVIDENCE.md) still apply.

## Product inventory

These are documented capabilities, **not verified account entitlements**.

| Product | Documented capability | Safe inventory after authentication |
| --- | --- | --- |
| PostgreSQL | Isolated database and dedicated role on workspace-shared infrastructure; SQL workspace and resource grants. Not a dedicated server. | `eos database list --json`; retain counts/status only, no database IDs or credentials. |
| Project variables | Per-project deployment variables; supplied values replace matching keys, omitted keys survive updates. Reading values can expose secrets. | `eos app list --json`; inspect variable names only through a private filtered response for an identified deployment. No values in this ledger. |
| Inference keys | Per-key USD limits, recurring day/week/month resets, sharing and revocation; model selected per request. | `eos inference keys list --json`; retain aggregate limits/spent/reserved/remaining, reset times and status, no key prefixes or identifiers. |
| Model catalog | Current model IDs, context limits and customer token prices, subject to workspace policy. | `eos inference models --json`; exact availability and pricing must be observed before selection. |
| Storage | Private buckets with US/EU jurisdiction, byte/object limits and independent read/write/list/delete key scopes. | `eos storage buckets list --json`, `eos storage usage --json`; counts, configured status and quota aggregates only. |
| Request logs | Inference status, tokens, cost, cache state and duration; asynchronous, without prompts/completions. | `eos inference usage --json`; optionally `eos inference logs KEY_ID --json` for an existing authorized key, privately aggregate metadata. |

Sources: [Postgres](https://docs.stacksync.com/enterprise-os/databases),
[CLI reference](https://docs.stacksync.com/enterprise-os/cli-reference),
[inference](https://docs.stacksync.com/enterprise-os/ai-inference),
[storage](https://docs.stacksync.com/enterprise-os/storage) and
[budgets/logs](https://docs.stacksync.com/enterprise-os/ai-inference/budgets-and-logs).

Use the EOS workspace returned by authorized discovery. The separate
[optional StackSync MCP adapter](../../capabilities/stacksync.md) pins workspace
5411 at `mcp.stacksync.com`; that is **not evidence of an EOS workspace ID**.
Listing zero visible resources proves neither product disablement nor global
account emptiness: EOS resource access is grant-scoped.

## Recommended wiring, in order

1. **Semantic triage and fast-tier inference.** Keep liveness/heartbeat checks
   deterministic. Coalesce exceptional health summaries per host and cache
   unchanged inputs. Compare the cheapest suitable live catalog model against
   current local/subscription execution using identical tasks and checker results.
   Public Jev pricing makes it a classification candidate; it is not assumed
   suitable for coding. Luna and GPT-OSS are candidates for bounded fast jobs,
   contingent on catalog presence and capability tests.
2. **Replayable Postgres metrics.** First mirror sanitized completion metrics for
   cross-Mac reports and durable history. Keep the queue, leases, fencing and
   admission local. A database outage must not block completion or dispatch.
   Defer authoritative fleet-state migration until recovery, backup/restore,
   connectivity, region, retention and operational ownership are proven.
3. **Small artifact archive.** Start with scrubbed reports, benchmark receipts
   and compressed metrics. Defer large builds/source archives until the actual
   upload ceiling, retention and transfer charges are established. No private
   source, prompts, mail, credentials or customer data enter an archive pilot.

For inference, extend the existing
[engine registry](../../src/core/run/engine-registry.ts) `openai-compat` seam and
[provider client](../../src/core/run/provider-client.ts), rather than introducing
a second model transport. Proposed base URL:
`https://eos.stacksync.com/api/inference/v1`; requests use `/chat/completions`.
An inference key belongs in Phantom Secrets, resolved into the worker's
`OPENAI_COMPAT_API_KEY` at launch; `OPENAI_COMPAT_BASE_URL` holds that public URL.
Select the exact discovered model in the engine configuration. A future adapter
must preserve cloud consent, local-only policy, call authority, abort/deadlines,
response bounds and secret redaction. This document changes no engine config.

The [EOS connection contract](https://docs.stacksync.com/enterprise-os/ai-inference/connect)
uses an inference key, independently of EOS management authentication. The supplied
account key's credential class is unknown; never assume it is an inference key.
Text, tools, JSON and streaming support need model-specific verification. The
generic engine currently advertises agent/edit, not tool capability. Responses,
embeddings and audio are outside this proposed chat integration.

Keep [typed routing](../ROUTING.md)'s loopback local-fast/local-strong backends
and shared 450 ms service budget. Do not point a local lane at EOS. Remote
semantic summaries run outside the critical heartbeat/admission path. A future
cloud worker must explicitly qualify as cloud capacity; included dollars do not
create a subscription seat, local slot or ready lane.

For Postgres, consume the existing opt-in
[completion sink](../../src/core/queue/stacksync.ts): `PHANTOM_STACKSYNC=on` plus
`PHANTOM_STACKSYNC_FILE` currently appends local JSONL only. A future asynchronous
exporter can checkpoint an append-only spool and upsert by persisted source
generation plus byte offset, avoiding duplicate imports after restart. Retain
only job ID, status, duration and merge URL where sharing is permitted. Add
ingestion timestamps separately; the sink contains no completion timestamp and
cannot reconstruct historical wall time. Use a restricted insert/select login,
TLS verification and a project-specific connection variable supplied from Secrets.
EOS project variable names may be recorded; their values remain private.

For storage, a future uploader uses content-addressed versioned paths and stable
idempotency keys, a write-only key, and separate read/list and retention-delete
credentials. Bucket-level isolation is required: keys lack per-prefix isolation.
The inspected skill documents a default 50 MiB file ceiling, 1 GiB/10,000-object
bucket and 10 GiB workspace; these are defaults, not account observations.
No exporter, database, bucket or key is created by this job.

## Cost model and included-credit comparison

The [official AI rate card](https://docs.stacksync.com/security-and-other-resources/legal/service-consumption-tables/ai-credits-and-other-consumption-based-pricing-table)
lists the following customer USD prices per million tokens. These are public
product labels, **not verified catalog IDs**. Refresh via EOS before a pilot.

| Candidate | Input / output per 1M | 2,000 in + 160 out, per triage | 10,000 in + 2,000 out, per fast job |
| --- | --- | --- | --- |
| Jev | $0.22 / $0.05 | $0.000448 | $0.0023 (arithmetic only; coding unqualified) |
| GPT-6 Luna | $0.50 / $2.50 | $0.0014 | $0.0100 |
| GPT-OSS 120B | $0.75 / $3.00 | $0.00198 | $0.0135 |
| Gemini 3.5 Flash-Lite | $1.50 / $12.50 | $0.0050 | $0.0400 |
| Claude Haiku 4.5 | $5.00 / $25.00 | $0.0140 | $0.1000 |

Formula: `(input_tokens * input_rate + output_tokens * output_rate) / 1,000,000`.
Use uncached prices for planning; include billable reasoning and all attempts.
These estimates exclude unknown fixed fees and any other metered products.
Live EOS monetary values are decimal strings; use decimal arithmetic and do not
apply another markup to customer-facing prices.

For a 30-day month, one Luna triage per host/minute is 43,200 calls, **$60.48**.
Doing that independently for 32 workers costs **$1,935.36**, above the reported
$1,000 allowance. At five-minute cadence across 32 workers it is **$387.07**;
Jev at that same cadence is **$123.86** if its capabilities qualify. Changed-input
summaries should cost less than these continuous scenarios; savings are unmeasured.

The [service consumption terms](https://docs.stacksync.com/security-and-other-resources/legal/service-consumption-tables)
distinguish platform SC from AI credits (100 AIC = $1), list variables/secrets
at $0, and list general managed Postgres `starter-1` at $50/month. That database
offer is not a confirmed price for EOS's shared isolated database. EOS database
and storage/requests/transfer pricing and partner-credit coverage remain unknown.
Provider underlying R2 pricing does not establish the customer's EOS price.
The EOS app $5 starting price also does not establish an all-inclusive fleet bill.

Proposed monthly allocation **only if** $1,000 USD-equivalent usable credits and
product eligibility are verified; these are review envelopes, not limits set:

| Use | Envelope | Capacity interpretation |
| --- | --- | --- |
| Semantic triage | $200 | About 142,857 Luna-sized triages, before retries/other charges. |
| Fast jobs | $400 | About 40,000 Luna-sized or 29,629 GPT-OSS-sized single-call jobs. Multi-call jobs consume multiples. |
| Postgres | $100 | Hold pending EOS quote; general $50 starter is comparison only. |
| Artifact storage | $50 | Hold pending storage, request and transfer rates; no asserted GiB entitlement. |
| Unallocated reserve | $250 | Other users, unreconciled requests and estimation error. |

The ceilings sum to $1,000; the deployable subset is currently **unknown**.
Unused credits are not a reason to create busywork or paid resources. Actual cash
exposure cannot be called $0 until grant eligibility and overage behavior are
confirmed. Existing local/subscription capacity remains the cost comparison
baseline; measure accepted outcomes and latency, not token volume alone.

## Follow-up review and acceptance

First restore authorized EOS access through the host's normal credential path;
do not copy another account's login, alter file permissions or bypass a denial.
Keep the supplied key out of argv, shell tracing, logs and files in this repo.
Use only its documented credential class. Read workspace list/current, then use
`EOS_WORKSPACE_ID` for the verified intended workspace without switching others.
Do not create a guest workspace or start a device login as an inventory fallback.

Collect the safe reads above with CLI auto-update disabled (`EOS_SKIP_UPDATE=1`).
Capture responses in memory and emit an explicit allowlist; do not print raw JSON,
variable values, IDs, log bodies or error bodies. No balance command is documented
in the inspected CLI: `inference usage` is consumption, not credit balance.
Obtain entitlement/balance/expiry from a documented read-only account source or a
reviewed owner reading, with provenance; do not invent a billing endpoint.

Refresh the advisory ledger only with observed facts and their original time.
Unknowns remain null, including `productsEnabled`; record false only for an
explicit provider disablement. A proposed future refresh interval is 15 minutes,
with readings older than 30 minutes unavailable for admission. Keep assumptions
and proposed budgets out of measured balance fields. No scheduler consumes this
file until a separately reviewed adapter defines account binding and freshness.

Submit a follow-up review with the exact workspace binding (privately), current
catalog IDs/rates, promotion terms, total committed usage and proposed resources.
Start with one explicitly approved inference key capped at **$10 total for the
pilot period**, concurrency one, at most 2,000 input/160 output tokens for triage
and 10,000/2,000 for bounded fast calls. No pilot call is authorized here.
Compare at least 100 representative permitted tasks per candidate, schema/checker
pass rate, p50/p95 latency, all-attempt USD cost and local/subscription baselines.

Preserve [reservation semantics](https://docs.stacksync.com/enterprise-os/ai-inference/budgets-and-logs):
pending and unconfirmed usage consumes allowance, even across reset. Full-context
reservations can exceed eventual token charges. Admit only when verified key and
credit headroom cover the reservation, other users' commitments and the reserve.
Aggregate limits across keys and align expiry/reset windows; per-key USD limits
alone do not prove a workspace cash cap. Missing billing evidence stops admission.
On 401/402 stop; bound 429 retries; reconcile ambiguous 502/503 before another
paid attempt. Preserve deterministic fallback and the fleet KILL switch.

Postgres acceptance requires spool replay without duplicates, an outage test that
leaves queue completion working, and a restore exercise. Storage acceptance
requires an allowed small artifact, denied cross-bucket/unauthorized access,
verified checksum, interrupted-upload reconciliation and costed retention.
Any dispatcher changes follow the existing Security review/re-pin process;
no live machinery installation is part of this plan.
