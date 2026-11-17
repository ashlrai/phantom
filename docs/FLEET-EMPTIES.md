# Empty job reasons

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
