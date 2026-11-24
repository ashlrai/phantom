# Fleet lanes

A lane is one account or model source that runs Phantom jobs. Each row says
what the lane runs on and what it is best at. Lanes marked **not a job lane
yet** only show status or are held; Phantom does not send them jobs.

| Lane | What it runs on | Best at |
| --- | --- | --- |
| `codex-personal` | OpenAI Codex on your personal account (usage read from Codex's own session logs) | Landing and cleanup jobs: LAND, FIXUP, DRAIN, DAILYFIX. Nothing else. |
| `codex-cmp` | OpenAI Codex on the second Codex seat (rate limits read through Codex App Server) | Frontier-tier work, when the router picks it. The name "cmp" is not explained in this repo. |
| `claude` | Claude Code on your Claude subscription | Coding jobs on the Claude subscription you already pay for. |
| `claude-api` | Anthropic API key, paid per use | Pay-per-use Anthropic work. Closed by default: the spend budget is $0 until you raise it. |
| `devin` | Devin, a cloud coding agent by Cognition | GEN, PLAN, SELFOPT and DESK jobs, and well-scoped backlog PRs. |
| `codex-local` | Codex on this Mac, using its local session logs | GEN, PLAN, SELFOPT and DESK work, the same kinds as `devin`. Check `phm lanes fit --lane codex-local` before you send a kind. |
| `zai` | Z.ai GLM Coding Lite: `glm-5.3` for the work tier, `glm-5.3-flash` for the fast tier | Coding at the work and fast tiers, on the GLM Coding Lite plan. |
| `gemini` | Google Gemini CLI | **Not a job lane yet.** Phantom only reads its MCP status with `phm wire status gemini`. |
| `grok` | xAI Grok API key, plus Grok Bot agents on the bus | **Not a job lane yet.** The API key is only checked. Grok Build is not an enrollable pool provider. |
| `cursor` | Cursor's hosted cloud agents (bus participant `cursor-cloud`) | Overflow capacity, planned for when local lanes are full. No job lane runs it now. |
| `agy` | Not described in this repo | **Unknown.** It appears only as a usage meter named `agy`. |

## Check a lane from the command line

Agents and scripts should use the commands, not this page:

```sh
phm lanes health --json
phm lanes fit --lane codex-personal --json
phm lanes yield --json --since 24h
phm lanes held --json
phm lanes pool
phm fleet lane-auth --json
```

`phm fleet lane-auth` reports `ok`, `missing_signin`, `expired` or `unknown`
from sign-in presence and job outcomes over the last 24 hours, without reading
credential values. Blocked lanes include a fix; when at least 25% of their plan
would go unused, they also get a sign-in Asks card. The hourly digest includes
the blocked lane with the most unused plan.

`phm lanes pool` says, per lane, whether queued rows are waiting on a used-up pool
(98% used or more, nothing running): "waiting on a used-up pool until Sat 3:30 PM (10 rows)",
"normal", or "no meter" when there is no pool reading. The gaps hook counts only rows
that can launch now, using the same rule.

`phm lanes health` shows calls, error rate and latency per lane over the last
12 hours. `phm lanes fit` shows which job kinds a lane should take and which
to avoid. `phm lanes yield` shows, per lane and size, merged PRs per launch over the
last 50 jobs, the empty rate and the weight the router uses (1 is neutral; a lane with
fewer than 10 jobs is unknown and stays neutral). A merge recorded as reverted
counts as reverted, never as merged. The lane router sends rows bigger
than small to lanes at 0.5 or better when they have room, and gives a low-yield lane
small, test-only rows. The yield fold reads the fleet's jobs-ledger dialect, so
GitHub-resolved merges recorded by the outcome reconciler (`jobId`/`prUrl`/
`outcome` rows) count the same as dispatcher outcome rows. `phm lanes yield` also gives every lane a verdict over `--since`
(default 24h): "low-yield" when 80% or more of at least 20 finished jobs ended empty,
"unknown" under 10 finished jobs, else "productive". The router skips a low-yield lane
for remaps and free capacity ("skipped zai: 92 of 99 recent jobs ended empty") unless the
job names that lane. `phm lanes held` lists lanes whose own wrapper held launches in the
last 60 minutes (`lanes.held.v1`). A lane with 3 or more held launches and no finished job
is self-held: the router skips it, with the reason "lane <x> holds every launch (N in 60
min)", until a launch there finishes or 60 minutes pass. `phm doctor supply` shows the same
lanes. All four only read.

## Related

- [Lane fit](https://github.com/ashlrai/phantom/blob/master/docs/LANE-FIT.md) and [lane health](https://github.com/ashlrai/phantom/blob/master/docs/LANE-HEALTH.md): the two lane reports.
- [Resource pools](RESOURCE-POOLS.md): how much capacity each account has left.
- [Drive](https://github.com/ashlrai/phantom/blob/master/docs/DRIVE.md): which job kinds each pool may serve.

## Which lane can run a job

`phm lanes caps` lists what each lane's sandbox can do (gh, network, browser, files outside the worktree) as yes, no or unknown. `phm lanes caps --check <prompt-file>` says which lanes can run that job, and `--json` gives the same as `lanes.caps.v1`. A lane declared to lack something the job needs is skipped with a plain reason such as "claude lacks gh". Unknown is never counted as a yes or a no.
