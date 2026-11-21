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
has no reply box and a line saying why. **Live log** opens the worker log. Escape or **Sessions** returns to the tree. The
conversation is read from `GET /api/verse/fleet/control/session-thread` every
10 seconds; a server without that read says so and shows no conversation.

A reply to a session waits on the Leader, so the conversation says when the
Leader is not reading. While the Leader's own passes fail, the notice from
the Leader pane shows just above the reply box: how many passes failed, when
one last succeeded, the failing pass's first line as the cause, and for a
worker that a message to it goes through the Leader and is kept in the
Leader's inbox until a pass succeeds. A session with no reply box shows no
notice. On the Conversations wall the notice is on screen once: above the
reply box of the Leader's conversation when that is beside the cards,
otherwise above the reply box of the conversation you opened, otherwise above
the cards. In the Leader pane a session opened beside the chat leaves the
notice to the chat. Every copy shares one kept reading of
`GET /api/verse/leader/health`, described in [the Leader guide](LEADER.md),
and refreshes it once a minute while it is on screen; a healthy Leader, an
unknown reading and a server without that read show nothing.

Every session with a job says what the job was asked to do, as one line
quoted from its brief. The dispatcher puts a view of the fleet in front of
each prompt (`## CONTEXT` to `## END CONTEXT`: the roster, live claims, open
pull requests), so the line is the first one written after it. A brief that
opens with a heading has a title, shown as **Task**, with the job's own id
dropped from its end. A job the router queued opens with the router's own
line ("Job … Task from the Ashlr router queue, verbatim:") and then its queue
row; the words of that row are shown as **Task** too. Any other brief gives
its first line, shown as **Brief opens**, because an opening sentence is not
a title. Nothing is reworded or summarised, and a line over 160 characters is
cut. The line is under the
first row of the session's Conversations card, on its row beside an open
conversation, and at the top of the conversation's Summary; the find box
above the cards looks in it. `phm sessions threads` and `phm sessions thread`
print it under the session's own line, and both reads carry it as `task`.
When no line can be read (no brief on record, or one cut off inside the fleet
view) a card and the Summary say "Task unknown" rather than quote the roster;
the leader, a helper and a server that sends no `task` show no line. On a
card, a brief among the newest messages also starts after the fleet view,
labelled "Brief, after its fleet view"; the opened conversation keeps the
brief whole.

For a session with a job, the summary opens with what the job has done, as a
row of named readings: the latest recorded step and how long ago it was, the
lines added and removed with the number of files changed, the commands seen
in its log, and how many of its helpers are running or failed. They are the
readings on the session's Conversations card, taken from the `work` key of
the same read, so a card and the conversation it opens agree. A reading the
read could not measure says "unknown" rather than 0. The sentences that
state those values, and the one giving the pull request (its link is in the
header), are left out of the summary below the row; every other sentence
stays. A session with no job, or a server that sends no `work`, shows the
summary as sentences only. In the list beside an open conversation, each
session with a job has one more line: its lines added and removed, then the
name of its latest step and how long ago, and any failed helpers.

A session reads "done" once its job has published, which is not yet the end
of the work. When the job ledger records what became of the pull request,
the row of readings ends with **Pull request**: "Merged in 3m" (the time
from the pull request opening to its merge), "Merged" when no time was
recorded, "Closed, not merged", or "Still open 12m ago" (how long ago the
fleet last checked). Its row in the list beside the conversation says the
same in one word. The reading comes from the `outcome` rows the fleet writes
to `metrics/jobs.jsonl` for the job's newest launch; a recorded merge stands
even if a later row still says open. Until a row records an outcome there is
no reading: a published pull request is not shown as open on a guess.
`phm sessions thread <id>` and `phm sessions threads` say it as a summary
sentence ("Its pull request merged 3m after it opened."), and the outcome
step in the conversation now names the recorded state.

A conversation opens at the newest entries of each record: 50 bus messages,
10 of your messages, the Leader's last 5 replies, 12 log lines. When the
records hold more, a row under the conversation says so and offers **Show
earlier** (or press E anywhere in the conversation but a text field). The
entries on screen stay while the deeper read is made, then the row says how
many earlier entries joined them, with **Go to the first** and **Show fewer**
beside it. The conversation stays whole while you follow it, and goes back to
the newest entries after a reload. It is the read `phm sessions thread <id>
--all` makes: more of the same records, never another source, and still
bounded (400 bus messages, the newest 200 inbox entries, 120 log lines), with
anything beyond that listed as left out. A server that names no depth shows
the list of what was left out and no button.

A worker that is running, quiet or of unknown state has a row under the
header to steer its job without leaving the conversation: **Pause** (or
**Resume** while a pause stands), **Stop**, which asks first, and **Move…**,
which reads the lanes when you open it and lists a held or full lane without
letting you choose it. Each makes the same request as `phm job <action>`,
asks for the mutation token when none is held, and says the receipt in the
row: done, requested and waiting for the dispatcher, or refused with the
reason. The conversation is then read again, and every request recorded for
the job shows in it as a line with what became of it. A pause or any request
the dispatcher has not applied yet is also named beside the buttons. A
finished session, the leader and a helper have no such row.

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
the tree. It shows up to 40 sessions, running ones before ended ones, and
says how many it left out and of which kind ("12 more sessions not shown (12
ended)"). `--json`
prints `fleet.session-threads.v1`; when the session list cannot be read it
says so and exits 1 instead of printing an empty list. See
[session threads](FLEET-API.md#session-threads).

The console's Conversations pane puts every session on one screen. Each
session is a card: its id, state and when it last spoke, the summary, and its
newest messages, with what was said to it on the right and what it said on the
left. A running session's card ends with the last 3 lines it wrote to its
log. Under a card's first lines is what its job has done: the newest recorded
step with how long ago it was, the size of the diff (lines added and removed,
and in how many files), the commands seen in its log, and how many of its
helpers are running or failed. A part that could not be read says "unknown"
rather than 0, and a session with no job shows none of it. These are the
values the summary states in words, so the card leaves those sentences out
and keeps the rest. A session that opened a pull request has a link to it at
the foot of its card, and beside its figures what the job ledger records
became of it: "PR merged in 3m", "PR closed, not merged" or "PR still open
12m ago". A pull request with no recorded outcome shows none of these. The pane makes one request for all of them
(`GET /api/verse/fleet/control/session-threads`) and asks again every 10
seconds while it is on screen. The buttons above the cards show only the
sessions in one state. The Order control in the bar, or O, changes where the
cards stand without adding or dropping one: Fleet order is the list's own
(the leader, then each worker with its helpers), Latest first leads with the
session that spoke most recently and puts one with no known time last, and By
lane or By repo puts the sessions under one heading per lane or repo that
counts them by state, with a helper under its worker's heading. The leader
stays first in every order. The choice is kept in the browser, and the list
beside an open conversation follows it. Arrow keys or J and K move between cards, Enter opens
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

A pane at least 1000 px wide keeps the Leader's conversation on the right of
the cards, so you can read every session and write to the Leader on one
screen. It is the same conversation the leader's card opens: the Leader's
replies, your messages, where each one was routed, and a reply box that
writes to the Leader's inbox. It reads
`GET /api/verse/fleet/control/session-thread?id=leader` every 10 seconds
while the pane is on screen, and it still does when the cards are narrowed to
a lane or repo, which lists no leader. It never takes the keyboard when it
appears. Press L anywhere outside a text field to put the cursor in its reply
box; Esc there returns to the cards and leaves the conversation where it is.
The leader's card shows no "new" mark while its conversation is beside the
cards. Hide puts the conversation away, which is kept in this browser across
a reload; "Leader conversation" above the cards, or L, brings it back. From
1360 px the Leader stays on the right of an open conversation as well, as a
third column. In a pane between the two widths an open conversation covers
it, and words already typed to the Leader are still in the box when you come
back. In a pane too narrow for it, L opens the leader's own conversation with
the cursor in the reply box.

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
screen. The read gives up ended sessions before running ones, and a line
under the wall's headline says which kind is off screen: "Every running
session is here. 12 ended sessions are not" in plain text, or a marked line
when a running session, or one whose state is unknown, did not fit. "Running only" leaves out sessions that have finished. The menus list
the lanes and repos seen since the pane opened. "Every session" removes the
narrowing. If the server answers for a different narrowing than the one you
chose, the line says so instead of labelling the cards wrongly. Marks for new
messages on sessions outside the narrowed list are kept.

The same words are also looked for in every session's whole conversation.
Once you stop typing, a list under the bar names each session that holds
them, with the lines that do and the words marked: who said the line, when,
and the words around the find. It reaches what the cards cannot: something
said long before a session's newest messages, the end of a job's log, and
sessions past the 40 on screen (a search reads up to 120). It keeps the lane,
repo and "Running only" you narrowed to. A session listed with no line holds
the words in its id, lane, repo or summary. Click a result, or press Down
from the find box and Enter, to open that conversation; arrow keys move
between results and go on to the cards after the last one. A word needs two
letters. If the search cannot be read the list says why and the cards are
still filtered. From a terminal, `phm sessions find <words>` prints the same
results; add `--json` for the document described under
[session find](FLEET-API.md#session-find).

The pane opens the way you left it: the words in the find box and the lane,
repo and "Running only" you narrowed to are kept in this browser, across a
reload or a restart of the app, until you clear them. Only that view is kept,
never a session's messages. When a card holds messages that arrived since you
last looked, a button above the cards says how many conversations do; it or N
opens the first one, and N again goes on to the next, starting over from the
top after the last. Beside an open conversation the list is narrowed by the
same find words (the open conversation always keeps its row), J and K walk
only the rows listed, and "Show all" brings the rest back.

"What Mason asked" sits above the cards when a session on screen serves one of
your messages. It is one row of buttons, newest message first: the time you
wrote it and where from, its first words, a dot per session coloured by state,
and a line such as "2 of 4 routed jobs on screen". Choose one and only the
sessions working on that message stay, with the whole message on a line under
the row and the state buttons counting just those sessions. Choose it again,
press Esc or use "Every session" to bring the rest back. Left and Right move
along the row. A helper is listed with the worker it helps. The last button,
"No message cited", holds the sessions tied to none: a job serves a message
only when its prompt cites it, so this is standing work or work the Leader
started itself, not work nobody asked for. A job that serves several of your
messages is listed under the newest. The row counts only the sessions on
screen, after the find box and the lane, repo and running narrowing. Nothing
extra is requested: each session's entry in the read carries the message it
serves (`serves`).

A card says what was asked of its session's job. "Paused" or "Pause
requested" sits beside the state while a pause stands, the card's border is
dashed and its running dot holds still; "Stop requested" or "Move to codex
requested" shows while the dispatcher has not applied the request yet. The
same words are on the session's row beside an open conversation. A finished
resume, stop or move leaves no mark, and neither does a session whose job has
ended; the conversation keeps each request as a line. When any session on
screen carries a mark, a "Paused or asked" button joins the state buttons and
keeps only those sessions. With the keyboard on a card, P pauses its job, or
resumes it while a pause stands. It is the same call as `phm job pause` and
`phm job resume`, so it needs the mutation token (the unlock dialog opens when
none is held) and the same refusals apply. The receipt is said in a line above
the cards, which leaves once the card itself shows the request; a refusal
stays until you dismiss it. S stops the job after asking, the same as
`phm job stop`. M opens a list of the other lanes from the fleet read, each
with what it is running; a held lane and a lane with no free slot are listed
with the reason and cannot be chosen. Up and Down move through the lanes,
Enter moves the job (`phm job move`), Esc leaves it where it is. If the fleet
read does not answer, the list says the lanes are unknown. P, S and M do
nothing for the Leader, a helper or a finished session except say so. The
conversation keeps its own Pause, Stop and Move buttons.

The card says a request from the moment the server records it, on the
receipt's word, and P goes by what the card says. The marks otherwise come
with the wall's own read (`control` on each entry), which is up to about 15
seconds behind the request. A read made 45 seconds or more after the receipt
that still does not show the request is believed instead. If the control record
cannot be read, no card is marked and a line under the cards says controls are
unknown.

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
session speaking and `-` is a recorded step, which includes each pause,
resume, stop or move asked of its job with what became of it. The summary is assembled from the
records, not written by a model. A "To write to it" line near the end says
where a message to that session goes, or why none can be sent. `--json` prints `fleet.session-thread.v1`;
an unknown id exits 2. See [session thread](FLEET-API.md#session-thread).

The thread shows the newest few of each record. When earlier ones exist it
ends with a note naming the command that shows them:
`phm sessions thread <id> --all`. That prints up to 400 bus messages, every
message of yours in the newest 200 inbox entries, 40 Leader replies, 60
commands and changed files, 40 control requests and the last 120 lines of the
log. In the JSON, `depth` is `recent` or `full`, and `deeper` is true when
a `recent` read left out something `--all` would show.

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
