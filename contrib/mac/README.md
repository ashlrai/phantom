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

## Router-queue restock

`contrib/mac/restock.py` is the deterministic restocker that `dispatchd`/`selfrun.sh`
invoke on the Mac (installed as `~/.ashlr-runs/bin/restock.py` through `swap.sh`,
sha-pinned by `selfrun.sh`). It reads `~/.ashlr-runs/queue/router-queue.md`,
picks eligible `READY` lines into per-lane prompts, marks them `CLAIMED`, and
never calls a model or the network. It runs as
`restock.py [--dry-run] [--per-lane N]` and creates or selects no lines for
repos outside the `GS_REPOS` fleet allowlist or for PRs on the queue's hold list
(`HOLD`/`HOLD-SECURITY` lines).

Two queue policies live here (RQ-QUEUEGEN-BOLD-30, SPEC-AMEND Security #5):

- **Bold floor:** before each restock the `bet=bold` share of `READY` lines is
  counted; while it is under 30%, bold lines pick first. The summary line prints
  `bold ready=B/N(f) picked=b/n(f) prefer=bold`.
- **Security pin:** a `READY` line touching `.github`, `publish.sh`, `dispatchd`,
  `git-safe`, `scrub` or `reap` is parked as `HOLD-SECURITY` carrying
  `[Security pin required]`; bold preference never promotes it back to `READY`.
  Negated mentions ("never touch .github") stay eligible.

Install of a new rev is gated on the `G1-CODE-PIN`: update `PIN_RESTOCK_PY` in
`selfrun.sh` and the `want` lines in `swap.sh` to the new file's sha256 before
`swap.sh` can place it in `~/.ashlr-runs/bin/`. The `restock.sh` wrapper in that
directory is unchanged; it only execs this file.

Run the fixture tests (HOME-isolated, no live queue access):

```sh
HOME=$(mktemp -d) python3 -B -m unittest discover -s contrib/mac/tests -v
```
