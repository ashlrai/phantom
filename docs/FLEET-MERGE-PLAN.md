# Merge-plan scoreboard

Run `phm fleet merge-plan --json`. The command turns one snapshot of the
pull-request list into the merge-throughput scoreboard and drain plan — it
never calls `gh` itself, never rebases, never merges, never closes. When the
open-PR pile keeps growing faster than main absorbs it, this says how fast
PRs are actually landing, why the open ones are stuck, and which open PRs a
newer open rework already replaces.

## Input

The snapshot is resolved in this order:

1. `--input <file>` (`--input -` forces stdin)
2. piped standard input (a non-TTY stdin with no `--input`)
3. the state file `<root>/fleet/open-prs.json`, where `<root>` is
   `ASHLR_RUNS_DIR` or `~/.ashlr-runs` (`--root /absolute/path` overrides)

Accepted shapes: the raw `gh pr list` JSON array, a merge-backlog read
(`{v:1, items:[…]}`), and a `fleet.pr-hygiene.v1` report. For the full
scoreboard capture one page of both states, for example:

```
gh pr list --state all --limit 500 --json number,title,url,headRefName,headSha,\
  isDraft,mergeable,mergeStateStatus,statusCheckRollup,autoMergeRequest,body,\
  createdAt,updatedAt,closedAt,mergedAt,files
```

Envelopes describe open PRs only, so merges/hour, time-to-merge and the
body-evidence sections stay `null`/unknown for them — degraded, never
invented. Rows that do not describe a PR count as `unreadable`; repeated PR
numbers collapse to the first sighting (`duplicates`). A missing, unreadable
or malformed snapshot exits 1 with `input.state` set honestly.
`--repo <owner/name>` labels the report when the snapshot carries no repo.

## What the report says

`fleet.merge-plan.v1` has five sections:

- `counts` — snapshot rows, open, merged/closed rows, drafts, unreadable and
  duplicate sightings.
- `throughput` — `merges_in_window` and `closes_in_window` over `--hours`
  (default 24), per-hour rates, a `ttm_minutes` summary (p50/p90/max over
  `mergedAt - createdAt`) and the oldest merge observed so a 100-row window
  does not look like a 24 h rate. `null` when the snapshot has no merged or
  closed rows.
- `open` — merge-state histogram (`states_evidence` is `unknown` when the
  snapshot carries no merge-state fields, e.g. the REST list shape), an
  `age_hours` summary and a bounded `oldest` list.
- `failure_causes` / `checks_failing` — ranked reasons open PRs are not
  landing: `conflict`, `behind`, `blocked`, `check-failure`,
  `check-pending`, `draft`, `unknown-state`, each with a bounded example
  list; `checks_failing` repeats the ranking per failing check name.
- `actions` — the drain plan:
  - `rebase_candidates`: open, non-draft `BEHIND` PRs (auto-merge flag
    included); `unknown` without merge-state evidence.
  - `batch_plan`: the `phm fleet merge-batch` summary over the same rows —
    batches, independent vs serial, expected rebases.
  - `superseded_open`: count of open-vs-open close proposals (below).
  - `superseded_merged`: the `phm fleet superseded-close` set when merged
    rows and job prompts (`<root>/queue/prompts/RQ-*.md`, or
    `--prompts-dir`) are readable; `no-prompts` is honest when they are not.

## Open-vs-open superseded duplicates

An open PR is a close proposal when a newer open PR claims to replace it.
Detection uses the fleet's own rework grammars, never fuzzy title matching:

- Title job ids: `RQ-FIX-<repo>-<pr>`, `RQ-REBASE-<repo>-<pr>`,
  `RQ-REBASE-BATCH-<repo>-<prs>-<hash>` and `RQ-RECUT-<repo>-<pr>-<head7>`
  name their origin PR.
- Bounded explicit body claims: `Supersedes #N`, `superseded by #N`, and a
  rework verb (recut, rework, rebase, recovery, replacement, handoff, redo,
  resume, take over) within 80 chars of `PR #N`.

Edges union into rework families (a rebase of a rebase is one family). The
highest-numbered member lands; a member that itself wrote `superseded by #N`
can never win. Every proposal carries `supersededBy`, a `kind` (`origin` or
`stale-rework`), the evidence list and a one-line `reason` naming the
replacement — paste-ready for a close comment. Proposals cap at 500 rows;
`truncated` carries the overflow. `duplicates.state` is `no-body-evidence`
when no PR body was captured, so title-grammar-only output is labeled.

## Before/after

`--previous <report.json>` diffs the current report against an earlier
`fleet.merge-plan.v1` and adds `delta`: open, merges/h, closes/h, ttm p50
and superseded-open changes. A foreign or unreadable previous file exits 1.

## Exit codes

0 a report was produced (findings are data, not failures); 1 no usable
snapshot or a failed upstream read — the JSON report still says so under
`input.state`; 2 bad usage.
