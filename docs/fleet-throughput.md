# Fleet throughput

Three read-first commands that show where launch slots go. All three are on master.
`phm fleet stuck` and `phm fleet yield` change nothing. `phm queue coalesce`
writes only when you pass `--apply --out <directory>`.

## `phm fleet stuck`: which queued jobs can never launch?

It reads the end of the dispatch event log and the ready list, then lists jobs
that keep being refused or keep failing and have not launched since.

```bash
phm fleet stuck --json
```

Flags: `--runs-dir <directory>`, `--events <file>`, `--ready <file>`, `--json`.
Exit 1 means the event log is unavailable; the count is unknown, not zero.
The report only covers the log tail: a stuck job has at least two refusals or
failures since its last launch and its latest event is within one hour of the
newest log event.

Main JSON fields:

- `schema`: always `fleet.stuck.v1`.
- `count`: number of stuck jobs. `null` means unknown (log unreadable), not zero.
- `oldestAgeSeconds`: age of the oldest stuck job, or `null`.
- `jobs`: the stuck jobs, oldest first. Each has:
  - `job`: the job id.
  - `lane`: the lane it was queued for, else the lane that refused it, else `null`.
  - `cause`: `lane_refused_size`, `lane_refused_repo`, `worktree_cleanup_failed` or `unknown`.
  - `events`: refusals or failures logged since its last launch.
  - `firstSeen`, `lastSeen`, `ageSeconds`: when it started and last got stuck, and for how long.
  - `action`: one suggested next step in plain words.
  - `kind`, `reason`: the newest event as logged, useful when `cause` is `unknown`.
- `sources`: `events` and `ready` each report the state of the file that was read.

## `phm fleet yield`: which job families turn launches into merged PRs?

It counts each launch in a time window once and shows how many ended as merged PRs.

```bash
phm fleet yield --since 24h --json
```

Flags: `--since <N>h` or `<N>d` (default `24h`), `--metrics <jobs.jsonl>`, `--json`.
By default it reads `metrics/jobs.jsonl` under the fleet runs directory.

Main JSON fields:

- `schema`: always `fleet.yield.v1`.
- `window_hours`: the window that was counted.
- `known`: `false` when the metrics file could not be read.
- `launches`: total launches in the window. When `known` is `false`, the
  placeholder is 0, not a measured zero; this command still exits 0.
- `families`, `lanes`, `tiers`: lists of rows, grouped by job family (the id
  without its cycle number; leader jobs are `leader`), by lane, and by tier.

Each row has:

- `name`: the family, lane or tier.
- `launches`, `prs`, `merged`: launches, PRs opened, PRs merged.
- `empty`, `aborted`: launches that produced nothing, and launches that were cut short.
- `finished`: runs with a finish record.
- `median_run_s`: median run time in seconds, or `null`.
- `tokens`, `tokens_measured`: tokens summed over finished runs that reported them, and how many did. `tokens` is `null` when none reported.
- `merged_per_launch`: merged PRs divided by launches. This is the yield.
- `tokens_per_merged`: tokens per merged PR, or `null` when unknown.
- `verdict`: the one-line summary the text output prints.

In text output, families with 5 or more launches are listed first, worst yield first.

## `phm queue coalesce`: can small same-repo jobs share one launch?

Each READY queue line costs one launch slot. This merges small lines for the same
repo, pool and tier into batch jobs of up to 8 tasks. It only plans by default.

```bash
phm queue coalesce router-queue.md --json
```

Flags: an optional `<file>` (stdin if omitted), `--json`, and `--apply --out <directory>`
(always used together). Apply saves `router-queue.original.md`, then writes
`router-queue.md` and `prompts/<batch id>.md`. It never replaces existing files,
so use an empty directory. A failed apply can leave a partial plan; choose a
new empty directory to retry.

Never batched: P0, `tier=frontier`, FIXUP ids, `src=leader`, and lines without a `size<=` declaration at or below 200.

Main JSON fields:

- `schema`: always `phantom.queue-coalesce.v1`.
- `batches`: the planned batches. Each has `id`, `repo`, `pool`, `tier`, `priority`,
  `replaces` (ids of the lines it absorbs), `line` (the new queue line) and `prompt`.
- `kept`: lines left unchanged, each with `id` and `reason`
  (`P0`, `frontier`, `fixup`, `leader`, `not small` or `alone`).
- `malformed`: lines that look like READY lines but could not be read, with
  `line`, `text` and `reason`. They are kept as they are.
- `applied`: whether files were written. `out`: the directory, or `null`.
- On failure the output is `{"error": "..."}` and the exit code is 1.
