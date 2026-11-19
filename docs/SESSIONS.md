# Agent sessions

An agent session is a piece of work that runs over several turns and can be
picked up again later. Its design follows
[Claude Managed Agents sessions](https://platform.claude.com/docs/en/managed-agents/sessions).
A Phantom session has four parts:

- an agent profile reference: a profile id and a version number
- an environment id, such as `local`
- an append-only event log
- a status: `idle`, `running`, `rescheduling` or `terminated`

Each turn is one job in the `phm queue` store. The session never claims,
dispatches or finishes a job. Workers and dispatchd handle jobs exactly as they
do today. The session watches its jobs' queue statuses and records each change
in its log.

## Running fleet sessions

`phm sessions` with no verb shows every agent session in the fleet as one
tree: the leader, then workers, then their subagents, running first. Each row
has its model, repo, state, when it last spoke, its last message, PR and the
computer it runs on. A session with no output for 10 minutes is marked quiet,
and finished sessions stay for an hour. Narrow it with `--lane <lane>`,
`--repo <repo>` or `--live` (running only), and add `--json` for the
`fleet.live-sessions.v1` document. The desktop Sessions pane shows the same tree.

The leader's row shows what the leader last told you and when. It reads
`idle` while its last planning pass is under two hours old; with an older
pass, or none on record, its state stays unknown and a note below the tree
says which record is missing. Its model is not recorded anywhere yet. In the
Sessions pane, selecting the leader's row opens the Leader chat.
See [live sessions](FLEET-API.md#live-sessions).

To see what one session is doing right now, run `phm sessions tail <id>`
with the job id from the tree. It prints the session's lane, model, start and
PR, then its last 200 log lines (`--lines N`, 1 to 200); `--follow` streams
new lines until it finishes. Every line is redacted first. With `--json` each
line is one object `{ts, source, text}`; the first also carries `detail`
(lane, model, repo, tokens, PR; `null` when unknown) and
`controls: {available, reason}`, which says whether `phm job pause|stop|move`
can reach it. An unknown id is a plain error with exit code 2. Choosing a node
on the desktop Compute map opens a side panel with the same log and controls.

To see what every session is saying on one screen, run `phm sessions threads`.
It prints a count by state, then a few lines per session, leader first: the
summary and its newest three messages, each on one line, with a note of how
many earlier ones there are. `--lane`, `--repo` and `--live` narrow it the
same way they narrow the tree. It shows up to 40 sessions and says how many it
left out. `--json` prints `fleet.session-threads.v1`; when the session list
cannot be read it says so and exits 1 instead of printing an empty list. See
[session threads](FLEET-API.md#session-threads).

To read one session as a conversation instead of a log, run
`phm sessions thread <id>`. The id is `leader`, a job id or a subagent id from
the tree. It prints a short summary (what the session is, its state, commands
seen, files changed, latest step), then the brief it was given, its recorded
steps, what it ran and changed, its notes, the agent bus messages about it,
what you wrote to it and its last message. For a worker, "what you wrote" is
every message in the Leader inbox that names it as `@<job id>`; for the
leader it is every message you sent, placed between the leader's replies in
time order. A message aimed at a worker goes to the leader, and nothing
records the worker reading it, so its label says "Mason to the Leader, aimed
at" the job. Lines starting `>` were said to the session, `<` is the
session speaking and `-` is a recorded step. The summary is assembled from the
records, not written by a model. `--json` prints `fleet.session-thread.v1`;
an unknown id exits 2. See [session thread](FLEET-API.md#session-thread).

For old heartbeats or quiet jobs, run `phm sessions reconcile --json` (omit
`--json` for plain text). The typed `reconcileSessions` API returns
`fleet.session-reconciliation.v1`: local runs classified as `live`, `finished`
or `unknown`, each with a reason, process observation and recorded times.
It uses the same bounded session reader and attempt-scoped `metrics/jobs.jsonl`
as the fleet view. A worker proves liveness; completion or exit records prove
the attempt ended, not that it shipped. Conflicting evidence stays unknown.
Old output or dispatcher heartbeats never prove a process died. Waiting jobs
are excluded; counts cover returned runs only. Check `sources`, `malformed`
and `truncated` for missing or partial evidence. This command changes no
processes, queue records or resumable agent sessions.

## Commands

```sh
# 1. Add the first job to the queue as usual.
phm queue add J1 --priority P1 --pool claude --tier work --repo phantom \
  --scope "Write the session doc" --acceptance "Doc exists" --json

# 2. Wrap that job in a session. It becomes turn 1.
phm sessions create --agent helper --agent-version 1 --environment local --job J1 --json

# 3. Check on it. Use the sesn_ id from step 2.
phm sessions show sesn_0123456789abcdef --json
phm sessions list --json

# 4. Once the turn has ended, queue the next one.
phm sessions resume sesn_0123456789abcdef --scope "Address review comments" --json

# 5. End the session when the work is finished.
phm sessions terminate sesn_0123456789abcdef --reason "shipped" --json
```

Every verb accepts `--json`. `phm sessions list` also lists MCP gateway
sessions as before. In JSON, gateway sessions stay under `sessions`, agent
sessions are under `agentSessions`, and logs that could not be read are under
`agentSessionErrors`.

## Statuses

| Status | Meaning | What resume does |
| --- | --- | --- |
| `running` | The latest turn's job is still in the queue, for example READY, CLAIMED or HOLD. | Refuses. Wait for the job to end. |
| `idle` | The latest turn ended with DONE, PR-OPEN, RETIRED or DROPPED. | Needs `--scope`. Adds job `<sesn_id>.t<n>` and copies priority, pool, tier, repo and acceptance from the previous turn. `--acceptance` replaces the copied acceptance. |
| `rescheduling` | The latest turn is BLOCKED. | With no `--scope`, retries the blocked job through `phm queue replay`. With `--scope`, starts a new turn. |
| `terminated` | The owner ended the session. | Refuses. The log stays readable. |

If someone retries a blocked turn with `phm queue replay --failed`, the next
`show` or `list` adds the retry job as the next turn. Terminating a session
leaves its queue jobs unchanged. To stop a job that is in progress, use
`phm queue block`.

## The event log

The log is stored at `~/.ashlr/agent-sessions/<sesn_id>.jsonl`, or under
`$ASHLR_HOME` when that is set. Files have mode 0600 and the directory has
mode 0700. Each line is one event with an increasing `seq` and a `ts`
timestamp:

| Event | Fields |
| --- | --- |
| `session.created` | `agent {id, version}`, `environmentId`, `queueDir` |
| `turn.queued` | `turn`, `jobId`, `source` (create, resume, retry or replay), `queueStatus` |
| `turn.observed` | `turn`, `jobId`, `queueStatus`, written when the job's queue status changes |
| `session.terminated` | `reason`, optional, scrubbed of secrets, at most 200 characters |

Lines are only ever added, never rewritten. `show`, `list`, `resume` and
`terminate` read the queue first and append any status changes they find, so
the log records the job's history as Phantom sees it. Events hold ids and
statuses only. Job scope text stays in the queue.

The status is always computed from the log. A line that does not parse, for
example a write cut off by a crash, is skipped and counted in
`skippedLines`. Symlinked logs and logs over 4 MiB are refused. If the queue
cannot be read, the session keeps its last known status and reports the
problem in `queueError`. A job that has been removed from the queue also
keeps its last known status.

## Limits

- The session records the agent profile id and version as references only.
  It does not load the profile or check that it exists. Profiles grant no
  authority, and neither do sessions.
- The environment id is a label. Phantom does not provision environments.
- A queue job can belong to only one session that is not terminated.
- A session can have at most 500 turns.
- Every operation on a session takes that session's lock. If another process
  holds the lock for more than 5 seconds, the operation fails with `busy`.
  Phantom never takes over a lock that another process holds.
