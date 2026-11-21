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

Every row in the Sessions pane also has a **Thread** button. It opens that
session as a conversation in the same pane: a summary assembled from the
session's records, then what was said to it on the right, what it said and did
on the left, and its recorded steps in the centre. The conversation ends with
an "Output" block: the last 12 lines the session wrote to its log, set like a
terminal, with a caret pulsing after the last line while the session is
running. It changes with each read, so it shows what the session is doing
now without opening the log. A "Routed to" record lists
the jobs serving one of your messages, one row per job with its lane, state
and pull request link. A line under the conversation says whether activity,
output, bus messages, your messages and routing are shown, not recorded or unknown,
and anything left out is listed. The reply box writes to the Leader's inbox,
the same route as the Leader chat, with the session's job id in front
(`@RQ-...`) so the Leader knows which session you mean. Where a reply goes is
the server's answer, the `reply` field of the read, so the pane and
`phm sessions thread` agree. Enter sends and Shift+Enter adds a line. The pane
asks for the dispatch token when none is held, and a refused send keeps your
words and shows the reason. What you sent shows as "You, from here" until the
next read carries the inbox's own record of it. A session that is not running
has no reply box and a line saying why. **Live log** opens the worker log,
where pause and stop live. Escape or **Sessions** returns to the tree. The
conversation is read from `GET /api/verse/fleet/control/session-thread` every
10 seconds; a server without that read says so and shows no conversation.

An open conversation is followed while it grows. A message that arrives while
the end of the conversation is on screen scrolls into view. Once you have
scrolled up to read, the view stays where you are: a **New** rule sits above
the first message you have not reached and the header shows a count, such as
**2 new ↓**. Click the count to go to the first new message, or press End to
go to the newest. Reaching the end clears the count and leaves the rule in
place until the next message arrives. The first time you open a conversation
nothing is marked new. Once you have read one to its end, this browser
remembers that, and the next time you open it (after a reload too) it opens at
the first message that arrived since, under the same **New** rule and count; a
message you never scrolled down to is still new the next time. Only a short
fingerprint of each message is kept, never its text, for the 40 conversations
read most recently. A line whose words changed, such as a worker's latest
line, counts as new. When a
conversation spans more than one day, each day's first message has a heading
(**Today**, **Yesterday**, or the date).

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
many earlier ones there are. What you wrote counts: the leader's lines include
your Leader inbox messages, and a worker's the ones you aimed at it with
`@<job>`. Routing counts too: under each of your messages the leader's lines
list the jobs serving it, and a worker's summary names the message it serves.
`--lane`, `--repo` and `--live` narrow it the same way they narrow
the tree. It shows up to 40 sessions and says how many it left out. `--json`
prints `fleet.session-threads.v1`; when the session list cannot be read it
says so and exits 1 instead of printing an empty list. See
[session threads](FLEET-API.md#session-threads).

The console's Conversations pane puts every session on one screen. Each
session is a card: its id, state and when it last spoke, the summary, and its
newest messages, with what was said to it on the right and what it said on the
left. A running session's card ends with the last 3 lines it wrote to its
log. The pane makes one request for all of them
(`GET /api/verse/fleet/control/session-threads`) and asks again every 10
seconds while it is on screen. The buttons above the cards show only the
sessions in one state. Arrow keys or J and K move between cards, Enter opens
one and Esc comes back to the same card. An opened card shows that session's
whole conversation. Under each of your messages in the leader's conversation
is a short list of the jobs the Leader routed it to, each with its lane, how
far it got and a link to its pull request; a worker's conversation opens with
the message it serves. A line at the bottom names what each source held, so
an empty conversation is not mistaken for a quiet session and unread routing
is not mistaken for a message nobody picked up. The opened conversation ends
in a reply box: a message to a worker that is still running goes to the
Leader's inbox with `@<job id>` in front, a message to the leader goes there
as it is, and a session that cannot be written to says why instead. Each card
says where a reply would go, and R on a card opens it with the cursor in the
reply box. "Live log" opens the worker log, where pause and stop live. A server without the read says so and offers the Sessions pane.
The Leader chat opens this pane on one session: "Conversation" on a routed
job there shows that job's conversation, and Esc returns to every session.

While a conversation is open, a pane at least 720 px wide keeps every session
listed on the left: its id, when it last spoke, its state and the newest line
said. Click a row to read that conversation without going back to the cards.
J and K move to the next and previous conversation from anywhere except a
text field. In the list, Up, Down, Home and End move between rows, Enter opens
one and Esc returns to the cards. A narrower pane shows the conversation
alone, and J and K still work.

A card or row shows "3 new" when the session holds three more messages than
when you last had it open, or than when the pane first showed it. The counts
are kept in this browser, so after a reload or a restart of the app the cards
show what arrived while the console was closed, and opening a marked
conversation shows where the new messages start. A session that has left the
list is forgotten. In a private window the marks last until it is closed. They are counted from each
conversation's message total, and the read keeps only the newest part of a
long conversation, so a session whose total has stopped growing shows no mark.

A bar above the cards finds and narrows. Press `/` and type: only the sessions
holding every word stay, matched against each session's id, lane, model, repo,
state, summary and the newest messages on its card. Find looks only at the
sessions on screen and sends no request. Down or Enter moves to the first
card, Esc clears the words, and the words stay while you open a conversation
and come back. The Lane and Repo menus and "Running only" narrow the read
itself, the same way `--lane`, `--repo` and `--live` narrow
`phm sessions threads`. The read returns at most 40 sessions, so this is how
you reach one it left out; a line under the bar says how many are not on
screen. "Running only" leaves out sessions that have finished. The menus list
the lanes and repos seen since the pane opened. "Every session" removes the
narrowing. If the server answers for a different narrowing than the one you
chose, the line says so instead of labelling the cards wrongly. Marks for new
messages on sessions outside the narrowed list are kept.

The pane opens the way you left it: the words in the find box and the lane,
repo and "Running only" you narrowed to are kept in this browser, across a
reload or a restart of the app, until you clear them. Only that view is kept,
never a session's messages. When a card holds messages that arrived since you
last looked, a button above the cards says how many conversations do; it or N
opens the first one, and N again goes on to the next, starting over from the
top after the last. Beside an open conversation the list is narrowed by the
same find words (the open conversation always keeps its row), J and K walk
only the rows listed, and "Show all" brings the rest back.

To read one session as a conversation instead of a log, run
`phm sessions thread <id>`. The id is `leader`, a job id or a subagent id from
the tree. It prints a short summary (what the session is, its state, commands
seen, files changed, latest step), then the brief it was given, its recorded
steps, what it ran and changed, its notes, the agent bus messages about it,
what you wrote to it, the last 12 lines it wrote to its own log (labelled
"Output", redacted like `phm sessions tail`) and its last message when the
output does not already end with it. For a worker, "what you wrote" is
every message in the Leader inbox that names it as `@<job id>`; for the
leader it is every message you sent, placed between the leader's replies in
time order. The thread also shows where your work went: a worker opens with
the message of yours it serves, and in the leader's thread each message is
followed by a "Routed to" line listing its jobs with lane, state and pull
request. A job counts only when its prompt cites your message's time. A message aimed at a worker goes to the leader, and nothing
records the worker reading it, so its label says "Mason to the Leader, aimed
at" the job. Lines starting `>` were said to the session, `<` is the
session speaking and `-` is a recorded step. The summary is assembled from the
records, not written by a model. A "To write to it" line near the end says
where a message to that session goes, or why none can be sent. `--json` prints `fleet.session-thread.v1`;
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
