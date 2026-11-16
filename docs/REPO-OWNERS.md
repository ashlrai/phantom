# Repository owners and orphan sweep

`fleet/repo-owners.json` assigns one idle bus participant role per repository.
It includes the seven fleet repos and additional repositories observed with open
PRs. These are responsibility labels, not evidence that a worker is running.
New repositories in an input capture receive a deterministic owner role.
Register the checked-in roles independently of any work inventory with
`npx --no-install tsx scripts/repo-orphan-sweep.ts --register-only --apply`.
This mode cannot assign PRs or queue jobs and accepts no inferred inventory.

Run from this source checkout with explicit, bounded metadata captures:

```sh
npx --no-install tsx scripts/repo-orphan-sweep.ts --prs prs.json --ready ready.tsv
npx --no-install tsx scripts/repo-orphan-sweep.ts --prs prs.json --ready ready.tsv --apply
```

The default is a read-only JSON report. `--owners file.json` overrides the seed;
`--root /absolute/fleet` overrides `$ASHLR_HOME/fleet`. Missing or invalid inputs
fail closed. No credentials, network requests, model calls or external sends are
used. Capture GitHub's open PR listings through an existing authenticated reader,
including all pages and repositories in scope. Never include PR bodies or secrets.
The PR capture is strict JSON:

```json
{"version":1,"complete":false,"observedAt":0,"prs":[{"repo":"ashlrai/phantom","number":12}],"leases":[]}
```

`observedAt` is epoch milliseconds. `owner` is optional on each PR. `leases`
contains token-free native dispatcher observations, each with `key` (a bus v2
claim key), `owner` and `leaseUntil` (epoch milliseconds). Set `complete: true`
only after capturing the full PR inventory and native lease evidence; a partial
capture can preview candidates but cannot apply. Apply also refuses evidence
older than fifteen minutes or from the future. The current canonical bus claim
table is read directly and rechecked before each assignment.

The ready file uses the dispatcher's job, repo, lane, tier, prompt-path columns.
Comments and parked rows are ignored; malformed active rows refuse the sweep.
Lane names are routing hints. A live PR, queue or repository lease, an explicit
owner, or an existing live bus work post prevents reassignment. Duplicate queue
IDs across repositories and conflicting bus owners fail closed.

Apply holds one exclusive bus coordination lease for the entire sweep. It posts
participant registration as v2 `context` messages to `repo-owners`, persists the
merged registry privately at `repo-owners/registry.json`, and posts advisory
`work.post` assignments without dispatch instructions. It never launches a
worker, changes ready.tsv, merges a PR, installs machinery or acquires a worker's
execution lease. A short reservation fences each assignment against a racing
claim and is released after posting. Existing worker leases remain untouched.
KILL stops writes.

Registration and assignment receipts last one day. Stable daily IDs make retries
idempotent; expired assignments can be proposed again. The report distinguishes
`candidates`, `orphansFound`, `proposed`, `assigned`, `owned`, `leased` and partial
failures. `orphansFound` is null for incomplete captures.
Only successful bus receipts increment `assigned`. Bus capacity or contention
returns a partial report and nonzero exit status; accepted rows survive a retry.
The durable bus remains bounded to its existing capacity. No scheduler or live
dispatcher installation is included; invoke the script from an authorized runner.
