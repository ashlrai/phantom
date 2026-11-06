# Provider usage probes — resets and spare usage the fleet can read itself

Checked 2026-10-31, the day the fleet was ordered to detect provider resets and spare usage
itself. For each provider: the documented or observable used-percent and reset-time signal,
where Phantom reads it, how fresh it is, and how it fails. Claims cite a public page or a
repo file; the unconfirmed is marked unverified. No credential or auth file was opened.

## Claude Code subscription

- Signal: rolling `five_hour` and weekly `seven_day` windows with `used_percentage` 0–100
  and `resets_at` Unix epoch seconds; per-model weekly scopes (Sonnet/Opus/Fable) may also
  appear. Wire shape: [status-line JSON](https://code.claude.com/docs/en/statusline)
  `rate_limits.*`; the limits: [Claude support](https://support.claude.com/en/articles/11647753).
- Read from: `claude -p /usage` (non-inference local command, version-pinned builds only)
  parsed by [claude-account-usage.ts](../../src/core/resources/claude-account-usage.ts);
  the fleet reads `~/.ashlr/routing/capacity.json` via
  [subscription-usage.ts](../../src/core/fleet/subscription-usage.ts).
- Freshness: seats carry `observedAt`; older than `HEADROOM_READING_MAX_AGE_MS` (15 min,
  [headroom.ts](../../src/core/routing/headroom.ts)) is stale = unknown. The `usage_report`
  frame is the fresh reply; legacy text may be header-seeded (`quotaFresh: false`).
- Fails: signed-out or unpinned CLI → no reading; missing or stale snapshot →
  `subscriptionAllows` fails closed. A rate-limited `/usage` endpoint yields last-known
  bars ~60 min ([costs doc](https://code.claude.com/docs/en/costs)); the upstream endpoint
  behind the bars is unverified — do not probe it.

## Anthropic API

- Signal: per-response headers `anthropic-ratelimit-{requests,tokens,input-tokens,
  output-tokens}-{limit,remaining,reset}`; reset is RFC 3339, `retry-after` rides on 429s
  ([rate limits](https://platform.claude.com/docs/en/api/rate-limits)). Org usage/cost
  history: `/v1/organizations/usage_report/messages` and `cost_report` under an Admin key
  or `org:admin` scope ([usage-cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)).
- Read from: Phantom does not call these today. Its only Anthropic-API fact is the grant
  ledger — recorded billing observations (`remainingUsdMicros`/`totalUsdMicros`,
  `capturedAt`, `expiry`) in [claude-api-grant.ts](../../src/core/resources/claude-api-grant.ts)
  — plus a display-only `claude-api` seat with `windows: []` in
  [budget-store.ts](../../src/core/routing/budget-store.ts). No public API returns a
  prepaid balance — a live balance read is unverified.
- Freshness: headers are exact at response time; reports are hourly/daily delayed
  buckets; the ledger is as old as its last verified observation.
- Fails: a tier spend-cap 429 carries no `retry-after` and does not self-reset; headers
  are absent on non-2xx; grant rows are `automaticAdmission: 'held'` — evidence, never
  spend authority.

## Codex CLI

- Signal: a `rate_limits` snapshot per account — `primary`/`secondary` windows
  `{used_percent, window_minutes, resets_at}` (5h and weekly), `credits`, `plan_type`,
  `rate_limit_reached_type`, filled from `x-codex-*` response headers
  ([rate_limits.rs](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs)).
- Read from (local, auth never opened): `~/.codex*/sessions/YYYY/MM/DD/rollout-*.jsonl`
  `event_msg`/`token_count` rows — [codex-session-usage.ts](../../src/core/fleet/codex-session-usage.ts)
  covers both homes, [codex-source.ts](../../src/core/observability/codex-source.ts) the
  default. Live: `codex app-server --stdio` JSON-RPC `account/rateLimits/read` →
  `rateLimits`/`rateLimitsByLimitId` ([schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/GetAccountRateLimitsResponse.ts)),
  probed by [readers/codex-usage.ts](../../src/core/fabric/readers/codex-usage.ts).
- Freshness: session rows are per-turn while runs are active; older than
  `CODEX_USAGE_STALE_MS` (24 h) is stale. The app-server read is live but needs ChatGPT
  auth inside an 8 s deadline.
- Fails: no session files → `unavailable`, never 0%; the app-server call requires chatgpt
  auth; malformed windows → null. Weekly `resets_at` can re-anchor to "now + 7d" rather
  than a fixed expiry ([issue #36313](https://github.com/openai/codex/issues/36313),
  community-observed) — treat a reset instant as a provider claim.

## Devin

- Signal: org ACU consumption, not a native percent — `GET /v3/organizations/{org}/consumption/daily` returns `total_acus` and
  `consumption_by_date[].{date,acus,acus_by_product.devin}`; needs `ViewOrgConsumption`;
  day boundary is midnight PST = 08:00 UTC
  ([consumption-daily](https://docs.devin.ai/api-reference/v3/consumption/organizations-consumption-daily));
  cycle edges: `enterprise/consumption/cycles` ([cycles](https://docs.devin.ai/api-reference/v3/consumption/consumption-cycles)).
- Read from: [devin-usage-worker.ts](../../src/core/fabric/readers/devin-usage-worker.ts)
  in `phantom exec` custody; it also reads `enterprise/consumption/acu-limits/devin` —
  used in-repo but absent from the published docs index (unverified). It emits `{acuUsed,
  acuLimit, pctUsed, resetAt: cycle.before}` as `devin-api-v3-org-cycle`, cached by
  [devin-usage.ts](../../src/core/fabric/readers/devin-usage.ts) and
  [consumption.ts](../../src/core/devin/consumption.ts).
- Freshness: 5-min TTL, 30 s on failure; consumption is daily-grained, so intra-day
  movement is approximate. `resetAt` is the enterprise cycle end.
- Fails: 401/403/429 → `unauthorized`/`forbidden`/`rate-limited` (honours `retry-after`);
  missing key or org → `missing-*`; schema drift → `malformed-body` = unknown, never zero.

## Local oMLX

- Signal: no subscription quota exists — spare usage is resident memory and model
  occupancy, and nothing resets. `GET /admin/api/models` lists `loaded`/`is_loading`/
  `virtual`, `estimated_size`, `model_context_length`, `quantization`, `model_type`;
  `/v1/tokenize` and `/v1/completions` return `usage`. oMLX is internal with no public doc
  — the wire shape is observable only through this repo (unverified externally).
- Read from: [model-inventory.ts](../../src/core/resources/model-inventory.ts)
  (loopback-verified fetch to 127.0.0.1:8000); the OpenAI-compatible default base URL is
  in [local-inference.ts](../../src/core/run/local-inference.ts); ceilings are planned
  offline by [omlx/config.ts](../../src/core/local-runtime/omlx/config.ts). The
  `local-omlx` `capacity` bucket is declared capacity-only in
  [pool-budget.ts](../../src/core/fleet/pool-budget.ts).
- Freshness: live HTTP during measurement; an inventory older than `RESOURCE_MAX_AGE_MS`
  (35 min, [resource-view.ts](../../src/core/fabric/resource-view.ts)) is unknown.
- Fails: refused or timed-out loopback → `unavailableEngines`; a busy engine (models
  resident) refuses measurement rather than evicting work.

## Smallest fleet changes

The three smallest `src/core/fleet` changes that would use these signals:

1. `subscription-usage.ts`: answer `subscriptionUsage('claude')` from the
   `readCapacitySnapshot()` seats already imported for `_budgetVerdict` — a ~20-line map
   of `SeatCapacity.windows` to `{usedPercent, windowLabel, resetsAt}` so displays stop
   reporting Claude as permanently unknown. No new I/O or trust boundary.
2. `codex-session-usage.ts`: export a reader adapter mapping the collected
   `CodexAccountResource` windows into `UsageReading`-shaped rows for `codex-personal`,
   `terra`, and a session-file fallback for `codex-cmp`. `fleet.readings` belongs to
   [usage-signal-writer.ts](../../src/core/fabric/usage-signal-writer.ts), so the adapter
   feeds its `readers` seam (`() => Promise<unknown>`), not the file — no subprocess, and
   covers the seat the app-server probe misses.
3. `pool-budget.ts` / `pool-budget-store.ts`: one producer turning the newest
   model-inventory or machine reading into `addBudgetReadings({pool:'local-omlx',
   bucket:'capacity', remaining})` — `parseBudgetOutput` already accepts `capacity
   remaining: <n>` lines, so the local pool stops reporting permanently unknown with no
   parser work.
