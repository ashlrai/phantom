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

## Commands

```sh
# 1. Add the first job to the queue as usual.
phm queue add J1 --priority P1 --pool claude --tier T2 --repo phantom \
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
