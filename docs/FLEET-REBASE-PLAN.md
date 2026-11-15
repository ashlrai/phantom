# Rebase-plan: conflict prediction → rebase jobs

Run `phm fleet rebase-plan --json` (or `--emit lines` / `--emit rows`). The
command wires `fleet merge-batch`'s conflict prediction into the rebase
pipeline: given the snapshot's conflicting `bridge:` PRs — the same set
`fleet rebase-status` counts — it clusters them by file overlap and emits
ready.tsv-ready rebase-job specs. It never calls `gh`, never writes a file,
and grants no rebase or merge authority; a scheduler appends the lines to
`router-queue.md` (or materializes the rows itself) and restock does the rest.

## Input

Same snapshot contract as `fleet merge-batch` — `--input <file>` (`-` for
stdin), a piped stdin, or `<root>/fleet/open-prs.json` — as a raw `gh pr list`
array, a merge-backlog read, or a `fleet.pr-hygiene.v1` report. `--repo
<owner/name>` labels the plan when the snapshot carries no repo; an envelope
`repo` wins over the flag. Without a repo name the planner still emits specs
(`repo` absent, ids stamped `unknown`) but queue coverage and the hold list
cannot attribute rows — the human output says so.

The live queue is read from `--queue-dir <abs>` (default `<root>/queue`):

- `router-queue.md` lines and `ready.tsv` rows with a live status (READY,
  CLAIMED, RUNNING, PARKED-*, HOLD-SECURITY) whose `RQ-REBASE*` id or text,
  or `RQ-RECUT-<repo>-<pr>-<head7>` id, names a conflicting PR *cover* it — covered PRs are excluded and the rest
  re-clustered, so a re-run never re-queues in-flight work. `--no-coverage`
  disables the read. A row proven to belong to another repo never covers;
  unattributed rows still count (restock's `repo` → `*` hold-list rule).
- `hold-list.txt` entries (`<repo>#<pr>`, `--hold-file <path>` overrides)
  skip held PRs. Both reads degrade to honest `sources`/`coverage.state`
  values (`ok` / `missing` / `degraded` / `skipped`), never silent guesses.

## The plan

Conflicting PRs that share a file ride in one job — one worker sees the
shared conflict context once and applies it to the whole cluster; disjoint
clusters spread as parallel jobs. Clustering reuses `planMergeBatches` on the
conflicting subset: its connected components are exactly the same-file
clusters, and its per-batch `order` (clean wave then rebase wave, FIFO) is
the least-rebase-churn order a worker should rebase in.

A cluster larger than `--max-prs` (default 8, hard cap 16) splits into
file-connected chunks chained by `after=` — restock parks them `PARKED-DEP`
behind a `DEPENDENCY GATE:` id list in the prompt and unparks in order.

## The job spec

Each `jobs[]` entry carries everything a writer needs:

- `id` — deterministic. Single-PR jobs reuse the queuegen shape
  `RQ-REBASE-<short>-<pr>-<head7>` (a `u<hash>` tag stands in when the
  snapshot has no `headRefOid`); batch jobs embed every member number,
  `RQ-REBASE-BATCH-<short>-<n>-…-<hash>`, so queue coverage sees members
  exactly.
- `line` — the router-queue `- READY <id> (attrs): <text>` line, built with
  queuegen's sanitizers (one physical line, `noWs`/`quoted` fields, 560-char
  cap). Append it to `router-queue.md`; `pool=any` lets restock route, a
  `--pool <lane>` pins the lane.
- `prompt` + `promptFile` — the `queue/prompts/<id>.md` body: the verbatim
  queue task, the member list in rebase order, the cluster's shared files,
  and the rebase-or-supersede brief.
- `prs`, `members`, `sharedFiles`, `after`, `pinned`, `evidence` — the row
  fields. A member touching a pinned surface, or whose file list hit the
  snapshot cap, marks the job `pinned` so the line enters as
  `HOLD-SECURITY` (`[Security pin required]` + `no merge without Security
  pin` in the prompt).
- `--emit rows` prints the ready.tsv row `id repo pool tier promptFile`
  (`renderReadyRow`); the writer must create the prompt file first and pass
  `--pool <lane>` — `pool 'any'` is not a lane restock accepts in a row.

`--pool`, `--tier` (validated against the queue tier vocabulary — `standard`
is rejected, it means `work`), `--priority` (P0–P3) and `--max-prs` shape the
specs. `counts` reports the funnel: open → conflicting →
held/superseded/covered/deferred → jobs (clusters, singles, chunks, chained,
pinned).

## Convergence

Rework churn is what keeps the conflicting count high, so the planner avoids
spending jobs on PRs that are about to stop mattering:

- **Superseded by rework.** An open `bridge: RQ-RECUT-<repo>-<pr>-<head7>` PR
  replaces PR `<pr>`; the origin gets no rebase job (`counts.superseded`), and
  of several rework PRs for one origin only the newest is kept. A conflicting
  rework PR is still rebased itself.
- **Ordering (`--defer-behind-clean`).** A conflicting PR sharing a file with
  a non-draft, non-conflicting PR in a self-landing state (CLEAN, HAS_HOOKS,
  UNSTABLE, BEHIND) is deferred (`counts.deferred`): rebasing it first is wasted
  work, the landing re-conflicts it. Off by default so a clean PR that never
  lands cannot starve its deferrals.

## Limits

Advisory only — the specs are data until a writer appends the lines or
materializes the rows. A stale snapshot plans stale work; a missing
`headRefOid` yields the deterministic `u<hash>` tag, which can never match a
future queuegen-emitted id, so covered-PR detection prefers snapshots that
carry `headRefOid`. A PR with no file data plans alone with
`evidence: 'no-file-data'` — unknown overlap, never proven-disjoint. When the
envelope's own upstream read failed (`input.upstream`) the command exits 1.
Exit codes: 0 plan produced, 1 no usable snapshot or failed upstream read,
2 bad usage.
