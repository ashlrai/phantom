# Routines

`phm routines` groups three complementary surfaces. All state lives under
`~/.ashlr/routines/` in private files; nothing here contacts a provider during
list/status/export/rebalance, and no surface grants dispatch, merge or spending
authority beyond the gates each executor already enforces.

- **Scheduled routines** — YAML definitions on UTC cron schedules, run by
  `tick` (or a generated launchd agent) with cheapest-eligible executor
  failover. See [Scheduled routines](#scheduled-routines).
- **Learned placement** — `run <routine.json>` places one routine on a
  provider (local oMLX by default) from private execution receipts, and
  `explain <id>` shows why. See [Learned placement](#learned-placement).
- **Placement registry** — `export`/`import`/`rebalance` move portable routine
  documents between machines and re-place them on fresh provider evidence.
  See [Portable placement registry](#portable-placement-registry).

The three stores coexist in the same directory without overlapping files:
`routines.yaml`, `runs.jsonl`, `STATUS.md`, `claims/` and `output/` belong to
the scheduler; `ledger.json` belongs to learned placement; `routines.json` and
`providers.json` belong to the registry.

## Scheduled routines

Copy [the YAML example](examples/routines.yaml) to `~/.ashlr/routines/routines.yaml`.
Set capabilities, minimum tier, daily attempt limits and per-attempt USD estimates.
Definitions are trusted executable configuration and must contain no credentials.
Codex uses its existing login and optional absolute `codexHome`. Claude uses its
existing subscription/API auth; models default to haiku/sonnet/opus by routine tier.
oMLX requires an installed `model` at `127.0.0.1:8000/v1/chat/completions`; it cannot
execute tools. Devin delegates to Phantom's authenticated API service and existing
grants/budgets. Its **submitted** outcome means dispatch, not completion; track with
`phm devin list`. Enable paid executors only with owner approval.

```sh
phm routines list
phm routines run ai-tooling-changelog-radar
phm routines status
phm routines migrate dashboard '*/15 * * * * phm dashboard'
phm routines migrate fleet-summary 'Review fleet scorecard and inbox health daily'
node dist/cli/index.js routines launchd --file "$HOME/.ashlr/routines/routines.yaml" > /tmp/phantom-routines-agent.xml
```

Migration imports without executing or enabling executors. Valid five-field cron
prefixes become shell commands; other text becomes daily prompts. Edit imported
tier, schedule and capabilities before activation. Use these patterns for dashboard,
fleet scorecard, release gate, inbox and queue checks; existing gates still apply.
Schedules are UTC cron (lists/ranges/steps, Sunday 0/7, DOM/DOW OR), `@hourly`,
`@daily` or `@weekly`. Cheapest eligible executors run first. Quota/rate-limit/auth
failures cool down for 1 hour/1 minute/5 minutes. Daily limits count attempts, not
live provider balance. Ambiguous failures stop without automatically duplicating work.
`runs.jsonl` records executor, estimate, duration in ms and outcome, without prompts
or diagnostics. Scrubbed results go under `output/`; output paths cannot escape it.
`STATUS.md` regenerates after ticks/runs or `status`. Protect and archive this store.
Inspect generated XML, install as `~/Library/LaunchAgents/ai.ashlr.routines.plist`,
and bootstrap with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/ai.ashlr.routines.plist"`.
One agent ticks every 60 seconds; edit its PATH if CLIs live outside Homebrew/system
paths. Concurrent runs refuse `.lock`; after a crash verify no run is active before
removing it. Durable minute claims prevent replay, including crashes; recover with
`run <id>`. Missed minutes (including long runs) are not caught up. No service is
installed by the CLI. Tests force quota exhaustion with fake CLI executors.

`run <id>` names a routine from `routines.yaml`; `run <file.json>` (any existing
file path or `.json` suffix) instead takes the learned-placement path below.

## Learned placement

`phantom routines run <routine.json>` executes one routine using the existing
sandboxed engine. A scheduler can invoke the same command for watchdog, manager,
health, queue triage and status work. `phantom routines explain <id>` shows every
retained execution receipt, including all candidate scores, exclusions, learned
quality, latency, reserved cost and the selected provider/model.

The objective is successful autonomous progress toward the current `goal` per
unit cost and latency: `expected value / (cost + latency penalty)`. The penalty
is $0.01 per second, with a $0.001 floor. Local oMLX is the default whenever it
meets the declared needs. Frontier execution requires unmet quality/latency needs
or at least three local observations with a failure rate of 50% or higher.
Quality uses two prior observations plus observed successes; latency and cost
use measured receipts. Update the goal as the intended end state evolves.

Example routine (replace model IDs with installed, commissioned models):

```json
{
  "id": "watchdog",
  "goal": "Inspect stalled engineering jobs and report bounded recovery proposals.",
  "sourceRepo": "/absolute/path/to/repo",
  "budgetUsd": 0,
  "quotaSince": "2026-10-29T00:00:00Z",
  "outcome": "operational",
  "resources": [
    { "provider": "local", "model": "installed-local-model", "costUsd": 0, "latencyMs": 30000, "quality": 0.9, "freeQuota": 0 },
    { "provider": "codex", "model": "configured-frontier-model", "costUsd": 1, "latencyMs": 60000, "quality": 0.98, "freeQuota": 0 }
  ]
}
```

Optional `minQuality`, `maxLatencyMs` and `value` declare placement needs.
Providers are `local`, `codex`, `claude`, `devin` and `grok` (Grok Bot).
Grok resources additionally require `grokbot: { "budgetFile": "/absolute/snapshot.json",
"secretsProject": "/absolute/secrets/project", "dayCap": 10, "weekCap": 50 }`.
Bot submission uses its existing quota admission and Phantom Secrets child proxy;
missing commissioning refuses execution. Replies are polled for at most two minutes. Local uses only
`http://127.0.0.1:8000/v1`, without a key or environment URL override. Engine
admission, sandbox, proposal and merge controls remain in force. This command
does not enable engines or authorize merges.

`budgetUsd` bounds reserved estimated spend for this routine since `quotaSince`.
`freeQuota` declares the available free calls for a provider in that window;
all routine receipts for that provider consume it. Estimates are conservative:
measured costs can increase the reservation. Provider billing controls still
apply; placement estimates are not billing hard caps. Set a real quota window
and conservative costs; the policy does not probe provider accounts.

Private receipts live in `~/.ashlr/routines/ledger.json`; goals and outputs are
not stored there. Reservations are serialized before execution; duplicate
in-flight routines are refused. A crashed run retains its reservation and blocks
that routine until its receipt is reconciled by the host. History is bounded by
4 MiB and refuses further writes when full. For `outcome: "merge"`, only
host-authenticated realized inbox merges earn positive quality credit; engine
completion alone does not. Operational routines measure successful completion.

## Portable placement registry

`phantom routines import routines.json` merges a portable document, preserving
IDs and ledger state. Conflicting IDs refuse the entire import. Re-importing the
same document is safe. `phantom routines export` exports it;
`phantom routines rebalance` re-places every saved routine and prints the document.

```json
{"schema":"phantom-routines.v1","routines":[{"id":"morning-summary","schedule":"FREQ=DAILY;BYHOUR=8;BYMINUTE=0","prompt":"Summarize engineering progress.","capabilities":["report"],"last_ledger_state":null}]}
```

The local registry lives in `<ashlr home>/routines/routines.json`. A credential-free
collector supplies `providers.json` in the same directory: an object keyed by
provider/account ID (`codex`, `claude`, `devin`, `grokbot`, `local`, or another
stable ID). Every entry follows the same probe contract, for example:

```json
{"grokbot":{"health":"ready","quota_state":"available","reset_at":"2026-11-01T00:00:00.000Z","observed_at":"2026-11-01T00:00:01.000Z","expires_at":"2026-11-01T00:05:01.000Z","cost":0,"capabilities":["report"]}}
```

`cost` is the collector's comparable estimated cost per firing. The adapter
interface also accepts live probe functions. Evidence expires within five minutes;
failed probes, unknown/low/exhausted quota, unhealthy providers, and missing
capabilities are ineligible. Eligible providers sort by cost then stable ID.
The Grok Bot reset is November 1, 2026 UTC; reset alone never manufactures quota.
A fresh post-reset available probe makes it eligible again. Exhaustion moves work
away on the next rebalance. The existing Verse automation timer rebalances every
minute while running. Run the explicit command when that timer is disabled.

This registry records placement, not provider-side schedule creation or task
execution. Existing automation dispatch and the Grok Bot transport retain their
own authority, spending, reservation, and deduplication checks. Imported ledger
state is historical metadata and grants no permission. No remote provider is
contacted by import/export/rebalance. Collectors must publish fresh evidence;
this command does not discover accounts or credentials. Keep prompts public and
credential-free; documents are limited to 16 KiB and 50 routines.
