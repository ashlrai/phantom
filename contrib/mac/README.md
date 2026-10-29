# Mac queue lane scripts (repo copies)

`restock.py` and `dispatchd.py` are reviewable repository copies of the
deterministic Mac queue scripts that run under `~/.ashlr-runs` on the dispatch
host. They are pinned artifacts: the live installs are managed on that host,
and changes here land by PR review, not by installing from the worktree. Both
are deterministic (no model or network calls of their own) and neither creates
tokens.

`restock.py` claims eligible `READY` lines from `router-queue.md` into lane
prompts (`ready.tsv`/`claimed.tsv`) for the fleet allowlist repos only, keeping
the READY stock at >=30% `bet=bold` and parking security-pinned surfaces as
`HOLD-SECURITY`. `dispatchd.py` is the per-tick supervisor: it reaps finished
jobs, adapts per-lane slot targets inside `slots.json`, launches queued lines,
and fires the restocker when a lane's queue runs shallow.

Devin routing policy (RQ-DEVINROUTEDEFAULTQ7, DEVIN-LEVERAGE-20261026): a line
that leaves its pool open (`pool=any` or no `pool=` attr) and is `tier=frontier`
or carries a long-horizon marker (`horizon=long`, `long-horizon`) routes to
`pool=devin` by default, matching how queuegen stamps new lines. Explicit
`pool=` values always win. Devin's leverage target is 10 and its ceiling 16:
restock never overbooks past the ceiling, and dispatchd's raise logic stops at
it. When more than 3 of the last 10 devin completions end without a PR (abort
or empty, versus the 5% baseline of 2 in 40), dispatchd steps the devin target
down by 2, never below the floor 6, and at most once per new completion
(`step_seen` in `slots.json`). A held devin lane never adjusts. The devin lane
sits in dispatchd's restock trigger loop beside the codex lanes.

Fixture tests run both scripts against a synthetic `~/.ashlr-runs` under a
temporary HOME and never touch the live queue:

```sh
HOME=$(mktemp -d) python3 -B -m unittest discover -s contrib/mac/tests -v
```

# Job outcome reconciliation

Run `./contrib/mac/metrics-outcomes reconcile --jobs /path/to/jobs.jsonl` before
reading the outcome metrics. This requires Python 3 and an existing authenticated
`gh` installation. It creates no tokens and does not publish or merge PRs.
Account access must be commissioned through Locus by the operator.

The ledger must already exist. Each publication is a JSON object with
`outcome: "PUBLISHED"`, a string `jobId`, and a `prUrl` containing the full base
repository GitHub PR URL. The legacy names `status`, `job` (or `id`), and `pr`
are also accepted. Other routing metadata is preserved. Blank lines are ignored;
malformed JSON refuses reconciliation without repairing or truncating the ledger.

Each unique job and PR is resolved with `gh pr view URL --json
state,mergedAt,closedAt`. Fork heads and squash merges need no special inference:
the PR's state is authoritative. Open PRs produce no outcome. Terminal events
retain the publication's field names, set `ts` to GitHub's merge or close time,
and include `mergedAt` or `closedAt`, `reconciledAt`, and a reconciler `source`.
Thus a historical backfill belongs to the actual merge/close window rather than
the time the repair ran. Existing MERGED or CLOSED job/PR pairs are never appended
again. This command reconciles published jobs only, not every PR in a repository.

A sibling `jobs.jsonl.reconcile.lock` serializes reconciler processes. Each append
is flushed and synced. Other ledger writers should use the same advisory lock
when appending to avoid racing reconciliation. The command rereads the ledger
before each lookup/append, preserves all original bytes and adds a missing final
newline. It never rewrites historical events. Keep the lock file in place.

Failures produce a nonzero exit and a count in the JSON summary; successful PRs
still reconcile. Failed and open PRs are retried next run. Diagnostics omit raw
GitHub output to avoid exposing credential-helper messages. A malformed ledger
or unavailable executable also fails closed. No live GitHub lookup is needed for
the fixture suite:

```sh
HOME=$(mktemp -d) python3 -B -m unittest discover -s contrib/mac/tests -v
```
