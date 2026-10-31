# Routine placement

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
