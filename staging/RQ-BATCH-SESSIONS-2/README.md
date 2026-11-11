# RQ-BATCH-SESSIONS-2 Security pin package

Part of CONCURRENCY-MAX-1. This package is staged and has not been installed.
`stage.sh` copies it to `~/.ashlr-runs/staged/RQ-BATCH-SESSIONS-2/`. It never
writes `~/.ashlr-runs/bin`, never runs `install.sh` and never touches a
LaunchAgent. Security reviews the staged files, pins the sha256 values in
`SHA256SUMS` and installs through the normal pin path. The release scripts
(`release-autorun.sh`, `release-sign.sh`, standing authority) are not part of
this change.

## Relation to RQ-BATCH-SESSIONS-1

RQ-BATCH-SESSIONS-1 built this package but never merged; this package supersedes it. Stage and pin only this
one. On top of -1 it closes five ways a bundle member could be lost, duplicated or left leased:

| Case | -1 behavior | Now |
|---|---|---|
| Bundle spawn fails (EAGAIN, ENOMEM) | Members dropped from `ready.tsv`, leases held forever, the `RQ-BATCH-*` id queued as a solo job | Members go back to `ready.tsv` alone in the same tick, leases released, attempts refunded; the bundle id never queues |
| A member was refused by the wrapper but a stale `.base` from an older solo attempt exists | A done or skipped report handed it to publish, which found no worktree: neither published nor requeued | Publishable only when the wrapper prepared it for this bundle (`.bundle-wt`, no `.prep-failed`, worktree dir, `.base`); otherwise deferred and requeued |
| A failed member's worktree cannot be retired | Lease kept, line not requeued: stuck until an operator noticed | Line requeued alone, lease released; the solo retry reuses the kept worktree, so nothing in it is lost |
| `ready.lock` busy at the end-of-tick write | Requeued lines (held launches, released members) lost | Carried to `queue/requeue-pending.tsv` and picked up next tick |
| Reap interrupted by the maintenance deadline | Next pass requeued already-handled members a second time | Each member is recorded in the manifest (`handled`) as it finishes; a resumed pass skips it |

Lease re-keying (when a member drops out and the bundle id changes) is now an atomic rename, with no window
where the lease is free.

## What changes on the host

| File | Change |
|---|---|
| `dispatchd.py` | Per-line bundles: O_EXCL lease per line, bundle launched through `batch-launch.sh`, done lines handed to their own per-job reap and PR, failed lines release only their lease. Devin routing. Load gate: load1 over 2 x ncpu or pressure level 2 or higher stops claims, and `LOADGATE_OFF` is ignored. Detached children polled every phase so they do not linger as zombies. Late requeues from the reap phase are appended under `ready.lock`. |
| `batcher.py` | Bundle size 2 to 10 (default 8), minimum 2 lines, tiers may mix, subscription lanes only. Dead single-PR prompt removed. |
| `batch_sessions.py` (new) | Config, model mix, Devin routing, leases, per-line prompt, `northstar` metrics CLI. |
| `batch-launch.sh` (new) | The wrapper. It creates a linked worktree and `.base` for each leased line, then execs the unchanged `launch.sh`. |
| `batch-sessions.json` (new) | Config. With it installed, Devin routing is on. |
| `process_snapshot.py` | Waits for a child it killed on timeout. |
| `zombie_report.py`, `wt_closed_prune.py` (new) | Operator tools. Read-only by default. |
| `install.sh` | Also installs the three new batch files (`.json` at mode 644). |

`launch.sh` is unchanged. The wrapper reuses its existing worktree-reuse branch,
`[ -e $WT/.git ]`, for the bundle's own worktree only.

## Adoption checks (Security, before the pin)

1. **Sandbox write scope.** The bundle session writes into sibling worktrees,
   `~/Projects/ashlrai/wt/<line>`. Confirm that `claude-cli.sb`, `codex-*.sb` and
   `agent.sb` allow writes under `~/Projects/ashlrai/wt/` and are not limited to
   the session's own `$WT`. This checkout does not contain those profiles. If a
   profile is limited to `$WT`, the lines are reported deferred and requeued
   solo. Nothing is lost, but nothing is gained either.
2. **models.json.** Merge `models.fragment.json` into `~/.ashlr-runs/models.json`.
   The values are Sonnet as the Claude default, Opus for `claude.frontier`,
   `gpt-6.1-terra` for Codex and `swe-2-flash` for Devin. Confirm `swe-2-flash`
   is listed as free by `devin models list` on the host (the admission code in
   `src/core/devin/cli-admission.ts` only binds models whose pricing is free).
3. **Fable.** It is never assigned by the bundler. Its share stays under the
   broker's `fable-share` control (docs/FABLE-ORCHESTRATOR.md).
4. **Devin eligible repos.** `batch-sessions.json` ships with
   `"eligible_repos": ["phantom"]` and `sm_max_lines: 100`. Add each repo where
   Devin has a working workspace.
5. **Load gate.** On the day this was written, the host showed load1 352 on 18
   cores (`sysctl vm.loadavg`). With this pin installed, dispatchd claims
   nothing until load1 falls to 36 or below. That is the intended back-off.

## After install: Mac hygiene (operator, by hand)

```sh
python3 ~/.ashlr-runs/bin/zombie_report.py               # names the parent that does not wait
python3 ~/.ashlr-runs/bin/wt_closed_prune.py              # dry run: removable count and hold reasons
python3 ~/.ashlr-runs/bin/wt_closed_prune.py --apply      # up to 200 per run, git worktree remove, no --force
```

Worktrees already share git objects, because each one is a linked worktree of
`~/Projects/ashlrai/<repo>`. They also share install caches: `launch.sh` and
the wrapper clone `node_modules` with `cp -c` (APFS copy-on-write).

## Metrics: before and after

```sh
python3 ~/.ashlr-runs/bin/batch_sessions.py northstar --cutover <install-epoch> --window-h 24 --record
```

This appends a `before` row and an `after` row to
`~/.ashlr-runs/metrics/northstar.jsonl`. Each row has tasks finished per
session, iterations (finished sessions) per hour and merged PRs per iteration.
It also writes `~/.ashlr-runs/bus/batch-sessions-first-numbers.md`. Run it once
at least 24 h after the cutover, so the `after` window is full.

## Rollback

Touch `~/.ashlr-runs/queue/BATCH_OFF`, or remove `bin/batch-launch.sh`, and
every line runs solo again. To restore the previous gate, restore the
`dispatchd.py.bak-macdispatch-*` backup that `install.sh` wrote.
