# Empty job reasons

`phm jobs empty-why --since 24h --json` returns `jobs.empty-why.v1` (version 1),
also available as `empty_why` in `jobs yield --json` and the Metrics yield view.
It ranks families by recorded wasted tokens, then name; unknown totals sort last
and partial totals include `tokens_unknown_jobs`. Counts use each job's newest
finish in the window, excluding actual precheck skips. Reasons are `no-diff`,
`already-on-main`, `precheck-catchable` (duplicate, already done or no target),
`tool-error` (tool/provider/run failure), and `unknown`. Evidence is inferred
from bounded log and publish tails, never returned as text. `--metrics` selects
the ledger; log/publish files live in its parent runs directory (`<runs>/metrics/jobs.jsonl`).
Unreadable metrics exit 1 with null totals; invalid arguments exit 2.

## Why jobs end empty: `phm jobs empty`

`phm jobs empty --since 24h --family 'RQ-PHX-RECUT*' --json` explains each
empty finish with one fixed reason. Omit `--family` for all families, or pass
a job id to select its family. `--since` accepts positive hours up to 8760.
The Work log's **Why jobs end empty** section reads the same report through
`GET /api/fleet/empty-jobs` (24 hours, all families), also shown on Fleet.

`phm jobs empty --lane zai --json` also carries `final` (schema `jobs.empty-final.v1`): the
final log message of each empty job read as one reason from a fixed list (already-shipped,
no-change-needed, repo-rule, blocked-dependency, tool-missing, usage-out, timeout, unknown),
counts per lane and reason, and the five newest examples per reason. The CLI quotes the matched
sentence (scrubbed, at most 200 characters); the web report leaves it null. A log with no final
message reads as unknown. The lane health badge tooltip names the lane's top reason;
`fleetLaneEmptyNotes` (`src/core/fleet/lane-empty-notes.ts`) supplies it to
`getFleetLaneSnapshot` through the `emptyNotes` option, so the lanes projection itself stays
out of the Tier-1 authority import closure. Plain pattern
rules in `src/core/fleet/empty-final-reason.ts`; no model calls.

This extends the existing empty-job report, using the `phm empties` newest-finish
reader and the slot-yield family normalizer (`jobFamily`). The latter strips cycle numbers
and groups generated recuts by kind: RECUTCOREC541 and RECUTCOREC544 are RECUT*.
No second ledger is created. Counts cover distinct job ids, not individual retries.
Only a newest empty finish is included; a later productive finish removes that id.

To see which recurring families waste launches, run `phm fleet yield`: it prints
merged per launch for each family, most wasted tokens first, and a ready job stop
file row for each `stop` family.
To see which kinds of jobs are worth launching at all, run `phm jobs yield --json`.
It gives each job kind a keep, watch or stop verdict and names the five to stop
first; see [job yield](contracts/CONTRACT-FLEET-OUTCOME-METRICS.md#job-yield-jobsyieldv1).
For only the job kinds to stop, run `phm jobs yield --stop-list` (one per line).
To stop them, run `phm jobs yield --stop-file`: it writes them to the job stop file the fleet reads before any model call.
Before a recut cycle, `phm recut plan --json` says per area whether to write a job; `phm recut prompt` puts the standard task line first.

`jobs.empty.v1` adds `diagnosis`: `jobs` (id, lane, family, reason), `families`
and `lanes` (name, total, topReason, suggestion). Existing top-level `jobs`,
`counts`, `topCauses` and sampled `reasons` remain compatibility fields for
older readers and retry policy; use `diagnosis` for the complete new explanation.
Jobs sort by id; groups sort by count descending then name. Tied reasons follow
the fixed reason list in `empty-why-classify.ts`. Suggestions never change queues.

Each top-level `jobs` entry also carries a typed `outcome`: `already-implemented`,
`duplicate`, `failed`, `empty`, or `unknown`. This separates reported completed work
and duplicate requests from failures and runs that produced no change. Nonzero exits
and provider errors override claimed completion; missing evidence stays unknown.
Notes take priority over the last 60 log lines. Outcomes are classifications, not
remote verification. Existing cause classes remain compatible with older readers.
Use `phm jobs retry-empty --dry-run --json` to preview eligible scope or test-timeout
retries, then `--apply` to enqueue. Repeated records, existing source markers (even
on renamed retries), and durable receipts suppress duplicate recuts automatically.

Rules below apply in order across the last 60 lines of the worker log and
publish record (each read is capped at 64 KiB, symlinks refused). No raw evidence
is returned. A bare `RESULT EMPTY`, missing evidence or an unmatched message
is unknown; it does not prove a no-op. These are text-based diagnoses, not proof
that master contains a change. Prompt text outside the tail is ignored.

| Reason | Evidence (first matching rule wins) |
| --- | --- |
| sandbox or permission denial | EPERM, EACCES, permission denied, operation not permitted, sandbox denied/blocked |
| provider quota or rate limit | usage/quota/rate limit, quota exhausted, insufficient_quota, HTTP/status 429 |
| test or typecheck failed and was reverted | test/typecheck/tsc/tsgo failure followed within 120 characters by reverted, rolled back or discarded changes |
| timed out | timed out, timeout after/exceeded, deadline exceeded |
| tool error | command not found, spawn ENOENT, tool/MCP/eslint/API error, failed, crashed or unavailable |
| already-on-master | already on/in master/main, landed on or merged into it; EMPTY_REASON: duplicate-landed |
| no-op change | no changes needed, nothing to change, no-op change; EMPTY_REASON: no-change-needed |
| scope too vague | scope/goal/task/prompt too vague, unclear or underspecified; EMPTY_REASON: prompt-unclear |
| unknown | no matching evidence |

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

`families` ranks all job families by `empty_rate` (empty finishes divided by all finishes), then `wasted_tokens` descending, then name for ties. It uses the same window: 24 hours by default, adjustable with `--since`. Each row has `name`, `finishes`, `empties`, `empty_rate`, `wasted_tokens`, `tokens_unknown_jobs` and `recommendation`. Family membership uses all finishes, including productive jobs. Wasted tokens sum only empty jobs' recorded tokens; missing measurements remain null (sorted last), partial sums carry an unknown-job count, and a family with no empties has zero waste. An unreadable or empty window has `families: []`.

The recommendation is `suppress` only above 60% empty with at least five finishes, `observe` below five finishes, and `keep` otherwise. These are suggestions; the report changes no queue rules. `--text` shows the top three families with empties and the same recommendations in plain words. Use `phm empties --json` for the complete typed report.

## Fleet finish report

Run `phm fleet empties` for JSON, or `phm fleet empties --human` for a short table and the top five families by empty launches. `--hours 24` (or `--since 24h`) selects a trailing window (default 24 hours, maximum 2160); `--jobs <jobs.jsonl>` selects a metrics file. `--runs-dir <directory>` sets the default ledger and result-notes root (default `~/.ashlr-runs`).

### Why runs ended empty: the `why` block

`phm fleet empties --hours 24` (JSON) adds `why` (schema `fleet.empties.why.v1`); `--human` adds plain lines after the table. The same report is served read-only at `GET /api/fleet/empties?hours=24`. It covers every job whose newest finish in the window was empty, precheck skips included, and gives each one `{job, lane, tier, family, reason, evidence, tokens_total}`. Rollups count jobs and tokens `by_reason`, `by_lane` and `by_family`; `costliest` lists the 10 empty runs with the most recorded tokens. Tokens that were never recorded stay `null` (unknown), never zero, and such runs are not ranked as costly.

Reasons are checked in this order across the job's metric rows, the last 40 lines of `<job>.log`, `<job>.publish` and `<job>.launch`; the first match wins:

| Reason | Evidence |
| --- | --- |
| `plan_limit` | a `pool_error` on a finish row, or usage, plan, rate or quota limit wording (or HTTP 429) |
| `held` | the launch note starts with `HELD` |
| `precheck_skip` | a `precheck_skip` or `skipped_empty` metrics row, with its code |
| `publish_abort` | the publish result's last `RESULT` line is `ABORT` or `DENIED`, naming the gate or step |
| `already_done` | the final lines say the change is already on main or merged, or there is nothing to do |
| `blocked` | the final lines name a missing tool or file, a permission or sandbox denial, or no network |
| `no_output` | no log, an empty log, or a finish that exited mid-run (timeout or interrupt exit code) |
| `unknown` | none of the above; evidence is the log's last line so new rules can be added |

`evidence` is one short line (at most 160 characters) with secret-shaped text and home paths scrubbed. Reasons come from text, not proof: check master before trusting `already_done`.

`fleet.empties.v2` includes every EMPTY finish, family/lane counts, `byCause`, and `topFamilies`. A family is the job ID without trailing digits. `--json` remains accepted. MCP `fleet_empties` returns the same report with optional `hours`, no paths. Its existing 64 KiB limit applies; use fewer hours or the CLI for large windows.

| Cause | Required evidence |
| --- | --- |
| `already-done-on-main` | An exact cause value or a full line such as `Already merged into main.` (also master) |
| `needed-gh-or-network` | An exact cause value or a full line such as `gh not logged in`, `gh: command not found`, or `Network unavailable.` |
| `refused-by-precheck` | An exact cause value or a full line such as `Precheck refused the job.` |
| `too-fast-to-have-worked` | A nonnegative measured duration under 60 seconds, with no conflicting or more specific cause |
| `scope-unclear` | An exact cause value or a full line such as `Scope was unclear.` |
| `unknown` | Missing, conflicting, or unsupported evidence; generic `no candidate` is insufficient |

Evidence comes from metrics `cause`/`reason` or an explicit `notes_path`/`notesPath` on the finish or its launch. Lines may start with `Cause:`, `Empty cause:`, or `Reason:`. Only complete lines within the first 2,999 characters of a regular file up to 12,000 bytes are considered. Paths resolve inside the runs directory; missing, oversized, symlinked or escaping paths are counted in `notesMissing`. Notes and paths are never emitted; logs and prompts are not read. Fleet vitals keeps its legacy log diagnostic.

Finishes are selected by timestamp; launches before the window can supply duration and lane. Repeated launches stay separate; exact duplicates are ignored. Outcome-only EMPTY records are used when no finish exists. A successful publish URL in the same attempt conflicts with EMPTY cause evidence and yields `unknown`. `wall_s` supplies duration, otherwise a unique launch/finish pair. The under-60 label describes timing, not a proven root cause.

`emptyRate` is EMPTY finishes divided by finishes with explicit empty/nonempty evidence (or a single finish with a recorded publish URL), also exposed as `measured`; no measurements means null. `launches` counts launches inside the window separately. `finished` includes unmeasured finishes. Malformed rows are counted and skipped, so counts cover observed valid evidence. Unreadable or oversized metrics (64 MiB maximum) return `known:false`, null totals and CLI exit 1; an empty readable window returns zero totals and exit 0. JSON keys and ranking ties have stable order. Invalid arguments exit 2.

## Model usage caps (`pool_cap`)

A worker log that says a model or plan limit was reached (for example "You've reached your Fable limit") is
`pool_cap` in `phm jobs empty --by-family` and `pool-cap` in `phm jobs empty-why`, apart from an ordinary empty and
from `auth_failed`. A named model is marked in `<runs>/metrics/model-caps.json` as
`{model, capped_at, source:"worker-log", lane, reset_at}` (`src/core/fleet/model-caps.ts`) and ends at the reset time
or the first later success on that model. `pickModel` falls a capped model to the next one in its lane (claude
frontier: fable, opus, sonnet). `phm pools` and `GET /api/app/pools` list the capped models as `cappedModels`.
Not wired yet: the dispatcher calling `recordCapFromLog` and `pickModel` at launch and finish (the dispatcher lives
outside this repo), and a lane-wide hold for limits that name no model; those stay unknown.
