# Empty job reasons

## Start here: `phm empties`

Run `phm empties` to see why jobs finished with no change and what to stop queuing. It prints JSON (schema `empties.v1`); add `--text` for at most 20 plain lines. `--since 24h` sets the window (hours or days, such as `7d`; default 24 hours). The command is read-only.

It reads the job metrics file (`metrics/jobs.jsonl` under the runs directory, `ASHLR_RUNS_DIR` or `~/.ashlr-runs`; `--metrics <file>` and `--runs-dir <directory>` override) and, for each empty job, its result notes (`<job>/BRIDGE_NOTES.md` under `ASHLR_WT_DIR`, or `--notes-dir <directory>`), the final 40 lines of its worker log and the dispatcher's timeout marker. Each job counts once, by its newest row in the window.

| Reason | Evidence, first match wins |
| --- | --- |
| `precheck_skip` | a `precheck_skip` or `skipped_empty` metrics row (the job never launched), or a precheck marker in the log |
| `already_on_master` | an `EMPTY_REASON: duplicate-landed` or `no-change-needed` line, or notes or log saying the work is already on master, merged, done or covered |
| `no_eligible_target` | `EMPTY_REASON: prompt-unclear`, `NO CANDIDATE`, or "no eligible target", "no conflicting PRs left", "nothing to do" |
| `no_diff` | "no diff", "no changes made", "nothing to commit" or "working tree clean", without a more specific cause |
| `blocked_tool` | `EMPTY_REASON: blocked`, a sandbox denial, or no GitHub sign-in |
| `tool_missing` | `command not found`, `spawn <tool> ENOENT`, or a tool that "is not installed" |
| `timeout` | the timeout marker, exit code 124, 137 or 143, or `timed out` |
| `model_error` | a `pool_error` on the finish row, or a usage limit, rate limit, overload or API error in the log |
| `unknown` | none of the above, including a job with no notes and no log |

A worker's own `EMPTY_REASON` line outranks everything except a precheck skip, and a tool denial outranks a "nothing to do" verdict, since a worker that cannot run `gh` often concludes there is nothing to do.

`reasons` lists every reason, most frequent first, with `count`, `share_of_finishes` (of all finishes in the window, 0 to 1), `tokens` (summed over jobs that recorded `tokens_total`), `tokens_unknown_jobs`, the top three `lanes` and `prefixes` (job families: ids without their `RQ-`, `PHX-`, `FIXUP-` or `CI-` routing prefix, grouped by shared name, so `RQ-PHX-RECUTCOREFLEETC518` and `RQ-RECUTWEBUIC502` are both `RECUT`), two `examples` and one `next_step` sentence such as "Stop queuing RECUT jobs: the work is already on master." The top level holds `finishes`, `empties`, `empty_share`, `tokens`, `malformed_lines` and `notes_missing`.

Missing data is never shown as zero: `tokens` is null when no job recorded any, and every count is null with `metrics: "unreadable"` (exit 1) when the metrics file cannot be read. Output holds job ids, lane names, counts and fixed sentences only, never note or log text.

`top_families` names the three most frequent empty-job families across all reasons in the window (24 hours by default), as `[{name, count}]`. Counts sort highest first; ties sort by name. Unknown reasons still count. Published jobs, older finishes and future rows do not count. Fewer than three families returns only those seen; an empty window returns `[]`, and unreadable metrics returns `null`.

## Detail by lane: `phm fleet empties`

Run `phm fleet empties --since 24h --json` to see why jobs ended empty. Omit `--json` for plain lines; `--since` accepts a positive number of hours such as `24h` and defaults to 24 hours. `--runs-dir <directory>` reads another runs dir (default `~/.ashlr-runs`). The command is read-only and does not change filler or dispatch rules.

## Typed causes

For each job whose `finish` or `outcome` row in `metrics/jobs.jsonl` says `empty: true` (or is marked `EMPTY_DONE`), the command reads the final 40 lines of the worker log `<job>.log` beside `<job>.publish` and tags one cause, first match wins:

| Cause | Matched in the final log lines |
| --- | --- |
| `precheck_skip` | `precheck code=…`, `precheck exit`, `precheck skip` |
| `sandbox_denied` | `operation not permitted`, `gh not logged in`, `not logged into any GitHub hosts`, a sandbox deny |
| `tool_missing` | `command not found`, `spawn <tool> ENOENT`, `is not installed` |
| `model_error` | usage or rate limit, `overloaded`, `API Error`, HTTP 429/5xx status, context exceeded |
| `no_candidate` | `NO CANDIDATE`, `already on master` |
| `timeout` | the dispatcher's `queue/run/<job>.timeout` marker (checked first), or `timed out` |
| `unknown` | anything else, including a missing, archived-only or symlinked log |

Only the tail is read because the head of a log echoes the prompt. A sandbox denial outranks a worker's "no candidate" verdict, since a worker that cannot run `gh` often concludes there is nothing to do.

The JSON `causes` object holds `total` (null when the ledger is unreadable), `logs_missing`, `by_cause`, `groups` (lane, cause and job-id prefix with `count`, two `examples` and `median_wall_seconds` from the ledger `wall_s`) and `top`, one plain line per lane and cause, for example `claude: 4 jobs ended empty because gh or a file was blocked in the sandbox`. `phm fleet vitals` shows the three most frequent causes in the last 24 hours.

## Recorded reasons

The report also groups the ledger's own `lane`, `repo` and `reason` fields on outcome rows with `empty: true` and rows marked `EMPTY_DONE`, ranks the five most frequent reasons and suggests a filler rule for each. Missing or blank fields are `unknown`; it does not deduplicate multiple outcome rows for one attempt. An unreadable or oversized ledger returns `known: false` and `total: null`; a readable ledger with no matching rows returns zero. Suggested rules are prompts for review, not automatic changes.
