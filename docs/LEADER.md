# Talking to the Leader (3.14+)

The [CEO network endpoint](LEADER-NETWORK.md) bridges verified owner channels,
the durable inbox/outbox, configured model tiers, and away-mode digests. The
desktop's **Leader** pane is the shared point of contact.

Roles describe responsibilities: coordination, implementation, review and release.
They do not bind an agent to a model or provider. Use the shared tool catalog,
durable context and work claims to coordinate agents; the Leader need not relay
every tool call or merge. Each action still uses its current account, repository
scope and standing authority. The Mac's **Scheduled planning passes** and
**Leader planning loop** switches control supplementary historical schedules;
they do not select the model used by the Leader.

## Role slots and the leadership lease

Leader, planner and reviewer are capability slots. `resolveRole`
(`src/core/routing/role-slots.ts`) maps a slot to its requirements (task shape,
context floor, declared capabilities), runs the shared seat router over every
admitted lane, and returns ranked candidates, so any engine or local model can
hold any slot. Per-role preferences are hints: they reorder lanes the router
already admitted and never admit an ineligible one. `failoverRole` re-resolves
with an exhausted lane set aside.

`src/core/routing/role-lease.ts` holds the pure heartbeat lease. A live lease
blocks rivals; once heartbeats lapse past the TTL any eligible agent may claim
it. The epoch is a fencing token, so a late former holder fails its next
heartbeat. Callers persist the lease and supply the clock.

## Release-backed articles (successor candidate)

The opt-in `release-articles` maintenance lane follows Phantom's latest stable
GitHub release. It uses fresh official GitHub and npm reads to bind the exact
numeric repository and current name, release tag, commit and source tree,
all 15 CI platform jobs and their required steps, dependency Audit, public
asset metadata, and npm version/integrity. It does not download or execute
release assets. Registry integrity and GitHub asset digests are metadata
observations, not independent byte verification or build-adoption authority.

```sh
ashlr release-articles status --json
ashlr release-articles enable ashlrai/phantom
ashlr release-articles sync --json
ashlr release-articles disable
```

Enablement permits this maintenance lane, not a new grant. A current autonomous
standing grant with exact `ashlrai/ashlr-landing` merge scope, an enrolled
checkout and Stop off is required before it queues an article in the existing
fleet task store. The resident standing tick calls the same maintenance path;
dry runs and disabled/missing configuration do not probe providers or create
state. Disable stops future maintenance; already queued work remains under the
normal fleet task and Stop controls. No new daemon, cron, credentials, paid
artwork, newsletter or social messaging is installed.

A proposed import contains only public identity/version data. This historical
3.24.3 example retains its original legacy repository identity:

```json
{"v":1,"repository":"ashlrai/ashlr-hub","version":"3.24.3"}
```

Use `ashlr release-articles import proposed.json`, then
`ashlr release-articles sync 3.24.3 --json` to observe that explicit version.
Private operational indexes, saved PASS flags and extra keys are refused.
Fresh configuration in the canonical source defaults to `ashlrai/phantom`;
saved configurations and imported historical records keep their recorded
repository. After a repository rename, explicitly select its current exact
name when updating an existing configuration; redirects do not transfer a
grant or activate the renamed label.

The public article draft contains only validated public facts and citations.
The content task reuses the company's authored-story, cover, RSS and SEO
pipeline. Its canonical URL is `https://ashlr.ai/news/phantom-release-3-24-3`
for version 3.24.3. It adds a small public evidence marker beneath
`/research/phantom-releases/3.24.3/evidence.json` and cites it in the article.
The marker binds `{v,releaseKey,factsDigest,canonical}`; it contains no private
receipts, paths, account balances, prompts or tokens. Conceptual art must be
labeled, and numerical benchmark claims need separate public measurements.

| State | Meaning |
|---|---|
| `pending-public-verification` | Fresh official facts are missing or incomplete; no publication claim. |
| `blocked-repository-authority` | Facts can be read, but the exact company repository is not currently authorized/enrolled. |
| `queued` | A real normal fleet task exists; repository checks, PR controls and deployment still apply. |
| `awaiting-production` | Coding work finished or an enqueue outcome is ambiguous; live publication is not confirmed. |
| `published` | The canonical public page and matching public evidence marker were freshly observed. |

A separate phm.dev teaser is queued only after the canonical company article
is observed live and `ashlrai/phantom-secrets` has its own exact standing merge
scope and enrollment. Its production observation is independent. Task
completion never becomes a deployment receipt. A private locked manifest
retains durable per-release/digest task identities even after finished tasks
are pruned. Corrections reuse the canonical article URL, wait for an active
producer and preserve its original publication date. An ambiguous crash is
held for inspection rather than silently duplicating work.

Phantom's website release metadata is maintained independently of company
articles. When the existing website publisher is commissioned and set to Auto,
and `ashlrai/phantom-secrets` has current enrolled merge authority, the host
checks the latest public workbench release at most once per minute. It queues
a normal source task to update `apps/web/src/lib/workbench-release.json`, which
drives the website version, npm command, release links and structured data.
The company article watcher can remain disabled. Website Pause/Off and Stop
hold this maintenance; normal PR checks, protected merge and the host publisher
still apply. Unknown enqueue outcomes retain their reservation after queue
retention, and failed tasks need review instead of automatic duplicate work.

`phm release-articles metadata --json` freshly checks public GitHub release,
source/tree, CI, Audit, npm version/integrity and asset metadata. These are
presentation facts, not independent original-archive byte comparison, installer
authority or installed acceptance. Unavailable fresh facts leave prior website
metadata unchanged. A queued or completed task does not prove live deployment;
the publisher separately checks the resulting production routes.

Rollback uses a normal reviewed source correction/removal and deployment;
withdrawing a database story alone cannot remove an authored source article.
This section documents successor source, not activation in the installed
3.24.3 release. Actual publication and company scope activation remain separate
operational steps after source qualification.

The Leader is the fleet's planning agent. It reads deterministic digests of what
the fleet did (history, the ledger, seat headroom, model outcomes, reasoning
insights, lessons, its own hit-rate) and writes **memos**: the bottleneck, one
move with an expected result and a date, goals, standards and questions for
you. Since 3.14 it is also something you talk to.

There is **one Leader and one conversation**. Phantom's Mind surface (⌘4),
Telegram and the `ashlr leader` CLI all read and write the same thread. The
legacy "Elon mode" dialogue and the Director are retired into it; free text from
Telegram reaches the real Leader.

What the Leader may *do* is bounded by your standing grant, never by the
conversation. Directives steer its judgement; they never widen the grant. See
[STANDING-AUTHORITY.md](STANDING-AUTHORITY.md) and
[Autonomy with custody](VERSE.md#autonomy-with-custody-310).

## One co-founder

Mason talks to one leader. The leader talks to every other agent on the bus.
`phm leader status`, `ask`, `org` and `assign` are that office. Each decision
reads `phm world` and the shared-visibility brief (`phm context`). Assignments
are claimed with `phm claim` and carry an RQ key, owner, due date, status and
outcome. The org chart is `config/leader-org.json`; a private `org.json` in
the leader directory replaces it. Work is addressed to a role's lane so the
existing router can admit it. The office does not call a model and does not
spend.

A request is routed only when its words are ordinary work and a role keyword,
or an explicit owner, picks the lane. The hard-limit regex only labels a match.
It does not decide escalation. A paraphrase, or any wording that is not clearly
ordinary work, escalates to the owner. Stored and posted text goes through
`scrubSecrets`. With no standing grant the work is recorded as a proposal and
is not put on the bus. KILL is checked at entry and again immediately before
the office file is written and before each bus post.

Channel adapters do not live here. After they authenticate the owner they call
`acceptOwnerMessage` and drain `readLeaderOutbox`. A raw channel payload is not
a caller. The desktop Leader pane
shows the conversation, the open assignments and the org.

When the Leader has asked you something and the conversation holds no answer
yet, the Leader pane (⌘⌥L) pins it above the reply box as **The Leader is
asking**, with how long it has waited. The question that has waited longest
leads; ‹ and › step through the rest and a half-written answer stays with its
question. A question with choices shows them: press 1 to 9 to choose and ⌘↵ to
submit. Any other question takes a written answer, sent with Enter. Answers go
to the Leader's question route, the one Needs you uses, and need the dispatch
token; a read-only session can read the question but not answer it. The tray
reads the newest 50 messages of the conversation, so an older question is
answered from Needs you (⌘J). With nothing open the tray is not shown. The
tray stays in place under **Needs you only**, and while a question is open
that view says the Leader is asking instead of "Nothing needs you right now."

```sh
phm leader status --json
phm leader ask "fix the flaky test" --json
phm leader org --json
phm leader assign --rq RQ-EXAMPLE-1 --owner engineering --summary "fix the flaky test" --due 2026-11-10 --json
```

---

## The conversation

- **One thread**, stored at `~/.ashlr/vision/leader/thread.jsonl` (append-only,
  0600, one scrubbed message per line). Above 1 MiB it is archived to
  `thread.1.jsonl`, keeping the newest 1,000 lines. Secrets, home paths and
  emails are scrubbed from your text and from the Leader's.
- **Earlier messages:** the desktop Leader pane opens on the newest 50 thread
  messages. When there are more, a row at the top of the conversation says how
  many are shown and offers **Load earlier messages**, 50 at a time, from
  `GET /api/verse/leader/thread?limit=50&before=<oldest id>`. With the
  conversation focused and scrolled to its top, Up, Page Up or Home loads the
  next page. Your reading position is kept, Find searches the loaded pages, and
  **Show newest only** returns to the newest 50. The row marks the start of the
  conversation held on this computer; messages archived to `thread.1.jsonl`
  are not loaded. Inbox posts, owner-channel lines and bus replies keep their
  own windows and do not reach further back.
- **Channels:** Phantom, Telegram, CLI and System, shown as a badge on every
  message.
- **When you are read:** the line under the reply box in the Leader pane (⌘⌥L)
  says when the last leader pass ran, when the next is due (passes run every 15
  minutes) and how many of your inbox messages no pass has read yet. A thin bar
  above it fills across the interval. It turns amber when a pass is late and
  red, with a button into the Journal, once a pass is more than 30 minutes
  overdue. When the fleet read holds no pass time the line says unknown and
  shows no count.
- **Ask now:** in the desktop Leader pane, **Send** writes to the inbox, which
  the Leader reads at its next pass. **Ask now** beside it (⌘⇧↩, or
  Ctrl+Shift+Enter) posts the same words to this thread instead, where the
  Leader answers in the same request. Your message shows at once, with the
  Leader's typing dots under it and the seconds waited. The reply box stays
  free meanwhile and Send still works; one question is out at a time. When the
  answer arrives, both messages take their place in the conversation. A
  message the server refuses stays on screen with the server's reason and
  **Try again**, **Edit** (puts it back in the box) and **Discard**. If the
  Leader records the message without answering, a line under the box says so.
  Ask now needs the same mutation token as Send, keeps the thread's
  4,000 character limit, and is off on a server without the Leader
  conversation. A draft that is a `/` command runs as that command. The
  routing trail under a message (jobs, lanes, PRs) is traced from the inbox,
  so work for the fleet still goes through Send.
- **Replies** use the same provider-neutral account/model routing as planning.
  Prepared Claude Code, Codex, Grok, included native Devin models and local
  resources can participate when their current capacity and signed Leader role
  permit it. A reply sees the last 30 messages. Missing capacity or a failed
  invocation produces a clear unavailable response.
- **Kept draft:** the desktop Leader pane keeps what you have typed and not
  sent. It is stored in this browser on this computer as you type, put back
  when the pane opens again after a reload or a restart ("Draft restored,
  last edited 2h ago", with Discard draft), and forgotten once you send or
  discard it. A refused send keeps it. With two windows open, sending or
  discarding in one clears the same text in the other. If the browser cannot
  store it, the pane says the draft lasts only while it stays open. Near the
  box's 6,000 character limit a counter shows the room left.
- **Screenshots:** in the desktop Leader pane, paste an image into the reply
  box, drop one on it, or press Attach screenshot (PNG, JPEG or WebP, up to
  8 MiB). The image is stored on this machine and its `[screenshot: <path>]`
  line joins your draft, shown as a chip under the box with Remove. Send
  delivers the line with your text and the thread shows the image. Attaching
  needs the same mutation token as sending. A kept draft or a recalled
  message that carries a screenshot shows its picture on the chip again,
  read back from this machine; without a token the chip names the file.
- **Limits:** your message up to 4,000 characters; replies time out after 120
  seconds and cancel the owned native invocation. Conversation calls have no
  hidden daily ceiling. Attempts for replies, extractions and brief narratives
  are counted separately from memo/check-in runs. Explicit `foundry.leaderPreferences` limits still
  govern memo/check-in cadence; they do not create a second conversation cap.
- A reply goes to Telegram only when you wrote from Telegram. Memos, questions
  and updates are sent to Telegram as well as shown in the thread.
- **Since you last looked:** when you come back to the Leader pane after two
  minutes or more away, a card above the conversation counts what arrived in
  between: Leader messages, how many of them need you, questions the Leader
  asked that are still unanswered, bus replies, merged PRs and lanes that were
  held or resumed. It shows the newest thing the Leader said. **Jump to first
  new** scrolls to the first new line; **Caught up** or Esc closes the card.
  The merged PR count covers the last hour only and says so after a longer
  absence; it reads unknown when the fleet read has not answered. The first
  visit shows no card. The last-looked time is kept in this browser profile
  only.
- **App actions:** the desktop Leader pane shows what Phantom did to this
  Mac's apps where it happened in the conversation. Each open, focus, quit
  and restart from the app action log (`phm apps log --json`) is a line with
  its outcome ("Opened Xcode", "Refused to quit Slack"), the time it was
  logged and the log's own detail. Actions with nothing said between them
  form one **Mac apps** group; a group of more than four lists its newest
  three until you choose **Show N earlier**, and says how many need a look
  (refused, failed, waiting on you or with no result). **Mac host** opens the
  pane that lists and opens apps; the conversation itself acts on nothing.
  Only actions logged since the oldest message shown are placed, so loading
  earlier messages brings earlier actions with them. **Find** searches them,
  and **Needs you only** leaves them out. The **App actions** button in the
  toolbar hides or shows them; the choice is kept in this browser profile,
  and while they are hidden the log is not read. The log is read every 30
  seconds while the pane is on screen. If it does not answer the toolbar says
  **App actions unknown** and no line is drawn; a phone, which the log route
  does not serve, shows none.
- **Leader health:** when the Leader's own passes fail, the desktop Leader
  pane says so just above the reply box, where you are about to write. One
  failed pass is a warning. From two in a row, the count at which
  `phm fleet leader-health` exits 1, the notice turns red and says the Leader
  is not reading you: what you send is kept in its inbox until a pass
  succeeds. It gives the number of failed passes, how long ago a pass last
  succeeded (or that the dispatch log holds none), and the first line the
  failing pass wrote as the cause, or "unknown" when it left no output. When
  the cause names its own fix, as an expired Claude sign-in does, a button
  copies that command. **Open the journal** opens the Leader journal and
  **Check again** reads now. After a notice has been on screen, the first
  read that counts no failure says the Leader is passing again until you
  dismiss it. A healthy Leader, a log with no pass in it and a read that did
  not answer show no notice; the line under the reply box still says when the
  last pass ran. The pane reads `GET /api/verse/leader/health` (read session
  required; the same `fleet.leader-health.v1` document as
  `phm fleet leader-health --json`) once a minute while it is on screen, and
  the server shares one reading for 15 seconds. The same notice shows above a
  session's reply box and on the Conversations wall, because those messages
  go through the same inbox; see
  [Sessions](https://github.com/ashlrai/phantom/blob/master/docs/SESSIONS.md).

---

## Directives

A directive is standing guidance that rides in every memo run until you
retire it. It is the one trusted block in the Leader's prompt.

**From any channel**, start the first line of a message with a prefix:

| Prefix | Stored as |
|---|---|
| `focus: <text>` | focus, "Focus on …" |
| `stop: <text>` | stop, "Stop …" |
| `priority: <text>` | priority |
| `directive: <text>` | guidance |

A message without a prefix that reads like standing guidance ("from now on…",
"never…", "double down on…") is checked by a separate model call that sees only
your message; a question is never treated as a directive. You see "Standing
directive recorded: …" when one is captured.

**Manage them:**

```sh
ashlr leader directives                      # active directives
ashlr leader directives --all                # including retired
ashlr leader directives add "ship binshield's retry fix first" --kind priority
ashlr leader directives retire <directiveId>
```

In Phantom, the Directives strip at the top of Mind shows each as a chip: ×
retires it, **+ Add directive** adds one, with a live counter against the
300-character limit. ⌘K "Add Leader directive…" opens the same box. On
Telegram, `/directives` lists them.

Limits: 20 active at once (retire one to add another), 300 characters each,
duplicates are ignored. Stored in `~/.ashlr/vision/leader/operator-directives.json`.

---

## Memos, answers and approvals

**Action classes.** Every action in a memo carries a class:

- **A** applies at once and can be vetoed at any time.
- **B** applies after a veto window (the grant's `leader.vetoMinutes`, 30
  minutes to 24 hours). A spend-raising action whose window would close
  between 00:00 and 07:00 waits until 07:00 unless the budget mode is all-in.
- **C** is outside the grant. It is never applied; it goes to Needs you with
  the Leader's argument.

With no grant, the switch at Propose, or the ladder at shadow, a memo is a
**dry run**: it is recorded and nothing applies.

**Approve early.** Approving a class-B action inside its window claims it the
same way the window closing would and runs the same checks (the ledger row and
today's grant). If they pass, it applies now and stays vetoable; if not, it is
refused and stays scheduled. Approving a class-C ask records your approval; it
does not apply it. To allow it, widen the grant yourself (`ashlr authority`).

**Veto** runs the action's recorded inverse. Veto on a memo vetoes all of its
actions.

**Answer.** Questions in memos can be answered. Answers (for 30 days) and
approvals (for 14) feed the next memo run.

When the Leader supplies a structured question, it offers one choice, several
choices, or a short answer. Multiple choice includes **Select all** and
**Clear**; selecting options does not send them until you submit. The same
question and saved answer appear on desktop, phone and Telegram. You can use
the separate conversation composer while leaving a question draft in place.

Structured answers are recorded once. If another device answers first, the
form shows that saved answer rather than overwriting it. A lost connection or
an uncertain submission keeps your draft while the app checks the saved
answer. Buttons expire after 24 hours; you can still reply in plain text.
Questions without structured choices keep their existing answer box.

---

<a id="in-verse-mind-4"></a>

## In Phantom: Mind (⌘4)

Mind opens on the conversation: "One thread · Phantom, Telegram, CLI".

- The Directives strip, then the thread: messages with channel badges, memo
  cards with the class chip, the veto countdown and **Approve** / **Veto** (a
  dry-run memo says so and has no buttons), questions with choices or an answer box.
- The composer at the bottom. Sending asks for the mutation token once; your
  draft is kept. "Leader is thinking…" shows while a reply is pending, and a
  failed send offers Retry and Discard.
- Below the conversation: each move's 7-day outcome, the hit-rate and
  standards, reasoning insights and the action log with Veto.
- ⌘K "Message the Leader…" focuses the composer from anywhere. On Command, the
  foot of the Leader card shows the latest message and a **Message the
  Leader… ⌘4** button. A Leader question in Needs you (⌘J) has **Answer**,
  which jumps to it in Mind.

The conversation works with autonomy off; memos are then dry runs.

---

## On Telegram

**Setup.** Create a bot with @BotFather, then:

```sh
ashlr comms setup-telegram     # prints the steps and finds your chat id
```

Configuration: `comms.enabled: true`, `comms.channel: "telegram"`,
`comms.telegram.botToken` (or `TELEGRAM_BOT_TOKEN` in the environment) and
`comms.telegram.chatId`. Messages from any other chat are dropped. The poller
runs as the launchd job `ai.ashlr.comms-poll` every 3 minutes (see the
[Comms channel](https://github.com/ashlrai/phantom/blob/master/docs/HUB-REFERENCE.md#comms-channel) in the Phantom reference for the config
example).

**Talking.** Send plain text and it joins the thread; the Leader's reply comes
back as a Telegram reply to your message. Reply to a Leader question to answer
it. Directive prefixes work here too. Replies to delivered memos and check-ins are
recorded and acknowledged without a model. They do not approve work implicitly.
Reply `approve`, `veto`, or `details` to a mapped memo to use its existing button
flow, or use the buttons themselves.

Structured questions use buttons for choices, selection and submission.
Short answers use a reply prompt. Ordinary messages can be sent while a
question is open; they do not clear its selections. Old buttons and repeated
submissions cannot replace an already saved structured answer. Plain-text
replies remain available for refining an answer.

| Command | What it does |
|---|---|
| `/leader` | The latest memo, with buttons |
| `/leader <text>` | Message the Leader |
| `/queue` | Local queue snapshot, without a daemon or model |
| `/usage` | Local usage bars, without a provider probe |
| `/approvals` | Pending Leader actions; approval still uses the existing gates |
| `/status`, `/brief` | The instant brief: shipped, running, blockers, next ([Founder mode](#founder-mode-315)) |
| `/task <owner/repo> <text>` | Hand work to an enabled Telegram automation ([Automations](VERSE.md#automations-315)) |
| `/directives` | Your standing directives: id, kind and text |
| `/settings` | The Leader's settings and the standards it set |
| `/help`, `/start` | Help |

`pause`, `resume`, `snapshot` and `revert:<id>:<repo>` are also understood as
keywords.

`ashlr comms health --json` reports a recent poll heartbeat (seven-minute
freshness window), last poll, last successful poll, last update id, token presence
as a boolean, and the last Leader tick outcome. A heartbeat is evidence of a
recent cycle, not a launchd process inspection. Run `comms cycle` through the
existing Phantom Secrets `phantom exec --` binding; a missing token fails before
starting a Leader tick. Never paste a token into logs or command arguments.

The poller calls `deleteWebhook` with `drop_pending_updates: false` before its
first API poll in a process. API failures log numeric codes only, including 409
conflicts. Inbound batches are stored privately before advancing the offset;
failed acknowledgements retry on the next cycle. Local poll cycles are serialized.
`resolved` includes recorded memo/check-in replies, local commands, and routed
Leader buttons, as well as numbered answers. It does not mean an action was approved.

Queue snapshots are read from `~/.ashlr/queue.v1.json` (or `queue.v1`), then
`router/queue.json` or `ashlr-fleet-queue.json`. Rows use `items`, `queue`, or
`tasks` arrays with `id`, `status`/`state`, and `title`. Usage reads
`resource.v1.json` (or `resource.v1`), then `fleet.json`, with `pools`,
`resources`, or `accounts` arrays containing `name`/`id`, `used`, and `limit`.
Missing snapshots and unknown readings are reported explicitly. These are
recorded values, not live quota probes.

**Buttons.** Memos arrive with **[Approve] [Veto] [Details]**. Approve is
shown only when an action is waiting on you: it applies a scheduled class-B
action early (after the same checks as its window closing), or records your
approval of a class-C ask. Veto is shown only while an action is live. An old
button answers "That button has expired."

**Digests are change-driven.** A digest speaks only when something changed:
merges, fleet PRs opened, reverts, seats exhausted or reset, cloud tasks
finished. When nothing changed it stays silent, apart from at most one line
after a day idle. Informational messages never queue behind an unanswered
question. Everything is HTML-escaped and long messages are split safely.
While the Leader line is on (the default with Telegram), this 6-hourly digest
stays silent, because the morning and evening briefs carry what shipped.

---

## Founder mode (3.15)

**The voice.** The memo prompt, the conversation and the Telegram line share
one founder-operator voice: first principles, ownership and urgency, bias to
action, "the best part is no part", bets sized with numbers, blunt and brief,
and every reply ends with the next move. It is the Leader, an AI; any line in
which it claims to be a real person or a human is rewritten before it is
sent. On Telegram a reply is cut to 6 lines, ending `… (say "more" for the
rest)`; "more" sends the rest (up to 30 lines), and asking for detail gets
the longer reply at once.

**The Leader line on Telegram.** On by default whenever Telegram is
configured; `comms.leaderLine: false` turns the scheduled briefs and pings
off (the conversation still works). It runs from `ashlr comms cycle`, the
poller's job.

- **Briefs.** A morning brief and an evening recap at `comms.briefTimes`
  (default `["08:00", "19:00"]`) in `comms.timeZone` (default
  `America/New_York`): what shipped with PR links, what is running, blockers,
  the next moves and one question. A slot missed by more than 3 hours is
  skipped.
- **Instant brief.** "status", "update", "what's up", `/status` or `/brief`
  gets the same brief at once, built from recorded state (the ledger, the
  cloud and Devin stores, the Leader's state and questions). A model writes
  only its one-line narrative, and the brief goes without it after 8 seconds.
- **Pings.** A result ping for work you asked for ("PR is up …"). Event pings
  only for a revert (when Jev, if set up, thinks it is worth the
  interruption), a failed revert (urgent) and the Leader being down (at most
  once a day).
- **Limits.** Quiet hours `comms.quietHours` (default `{ "start": 23, "end": 7
  }`, local hours) hold everything but urgent pings. At most
  `comms.maxPingsPerDay` (default 6) ordinary pings a day, 20 minutes apart,
  and at most 4 urgent ones.
- **Questions.** One at a time; the next waits until you answer, or for 24
  hours. Structured questions show their supplied choices or a short-answer
  prompt. Legacy yes/no questions retain **Yes**, **No** and **Your call**.

**What you say, and what it does.** Each message is read as one of status,
detail ("more"), approve, veto, answer, directive, task or chat. Rules decide,
and Jev may classify first when it is set up; approve and veto always need an
action id (`la-…`) or a reply to a message that carries actions, and are
never taken from a model's guess. "Go build X" or "fix Y in owner/repo"
becomes work at once, in `comms.leaderRepo` (fresh default `ashlrai/phantom`; saved overrides remain unchanged)
when you name no repo: small work goes to the fleet; larger work to a cloud
session, then Devin, when the budget allows and the mode is not reserve; and
back to the fleet if a paid lane refuses, which the reply says. Your request
counts as your approval, through the same path as an Approve tap.

**Actions it may take**, each classed by the same policy as every other
action, with the same dry-run rule, veto windows and ledger:

| Action | Class |
|---|---|
| `directive.self`: a standing note to itself, fed back to it as untrusted data, never mixed with your directives | A |
| `backlog.add`: queue work in the cloud backlog (spends nothing) | A (C outside the grant) |
| `cloud.launch`: a Claude cloud session | B, spend-raising (C outside the grant or in reserve mode) |
| `devin.launch`: a Devin session through the fleet entry point (needs `devin.fleet` and a grant that names Devin) | B, spend-raising (C outside the grant or in reserve mode) |
| `playbook.upsert`: a new playbook version; a veto writes the prior text back as a new version | B |
| `automation.upsert`: create or update an automation; a veto restores or deletes it | B |

Every paid lane still applies its own budget gate at launch.

**Self-improvement.** Once a day, from 09:00 local time, the Leader ranks
Phantom improvements from recurring retro causes, its own failures,
Needs-you friction, usage and the open gates in
`docs/VERSE-COMPETITIVE-ACCEPTANCE.md`, and routes each pick to the cheapest
capable lane: no fixed daily launch ceiling, a 7-day cooldown per idea, no
paid lanes in reserve, nothing enacted in a dry run. The line posts the report
with Approve and Veto. `foundry.leader.selfImprove: false` turns it off.

**Jev's advice on memos.** After a memo's actions are classed and applied, Jev
(when set up) is asked about up to 8 class-A and class-B actions. When it
thinks one deserves a stricter class, the memo says so ("— Jev suggests class
B (advisory; the class above stands)") and records it in `actionAdvice`. The
advice never lowers or changes a class, never approves anything, and no gate
reads it.

---

## From the CLI

`phm leader thread --legacy` preserves the earlier chat format: your
`leader/MASON-INBOX.md` entries and the
leader's replies (`leader/MASON-OUTBOX.md` and the latest “Reply for Mason”
block in each `leader/PLAN-LOG.md` entry), oldest first. It prints JSON by
default (`id`, `ts`, `direction`, `channel`, `text`, `state`); add `--text` for
plain lines and `--limit n` for the newest n (default 50). Each of your
messages is `sent`, `received` (the planner acknowledged it), `answered` (a
reply links to it) or `open-over-2h` (no linked reply after 2 hours). A reply
links when its MASON-OUTBOX heading carries `[leader-network:reply-<id>]` or
its text says `re: <id>`. Unreadable inbox blocks are skipped and counted in
`skipped.malformedInbox`; an unreadable time is `null`, shown as unknown.
`phm leader say "<text>"` sends through the verified local-owner inbox writer
(the same path as `phm leader inbox --text`) and prints the new message id.
The desktop inbox box and the phone box show the same chat above their Send.
The default `phm leader thread` shows the whole conversation as plain lines.
Add `--json` for the `leader.thread.v1` shape or `--text` for explicit plain
lines. Optionally filter with `--since <hours|date>` and `--before <hours|date>`
or keep the newest n with `--limit <n>`. `since` keeps entries at or after its
cutoff and `before` keeps entries strictly before its own, so the pair reads
one `[since, before)` window — the same bound pair every other comms read
applies; an entry with no readable date cannot be placed inside or outside
the window, so neither bound ever drops it. The same view is available at GET
`/api/verse/leader/thread/merged?since=…&before=…&limit=…`. Each entry has `at`, `from` (`mason`,
`leader`, `teammate` or `unknown`), `channel`, `text`, `source` and `refs` (PR
numbers named in the text). Without `--since`/`--before`, no time filter is applied.
A reply in both the outbox and the PLAN-LOG shows once, and an entry with no readable date
keeps `at: null` ("time unknown") and sorts last.
These journals are read only. `--follow` still streams the in-process Leader
conversation. For dated PLAN-LOG replies alone, newest first, use
`phm leader replies --json --limit 20`. Readers check the last 256 KiB of each
journal; older entries may be omitted.

```sh
ashlr leader say "focus: the flaky retry test in binshield"
ashlr leader thread [--since 24] [--before 2] [--limit 20] [--json]
ashlr leader thread --legacy [--limit 20] [--text]
ashlr leader answer <questionId> "yes, but only on ashlrcode"
ashlr leader approve <actionId>
ashlr leader veto <actionId> [--note "why"]      # or: veto --memo <memoId>
ashlr leader directives [add|retire|list]
ashlr leader show [--json]      # latest memo, hit-rate, health, pending veto windows
ashlr leader run [--force]      # run now and wait for the memo
ashlr leader tick [--wait]      # apply due class-B actions, grade moves, run if due
```

Exit codes: 0 ok, 1 error or refused, 2 bad usage.

---

## Reliability

**Seats.** A run follows the router's ranked eligible accounts. Every fitting,
currently available model option shares its account's allowance. There is no
provider fallback order or Claude-only deep-run rule. Native Claude Code,
Codex and Grok use their exact prepared account profile; native Devin requires
fresh host-observed included pricing and principal evidence. Cloud ACU sessions
remain their own lane. Codex needs a current subscription-only billing boundary;
native account metadata must match the selected allowance before contact, and
reconnecting its profile invalidates that binding.
unknown funding never authorizes purchased credits or overages. Without a
standing grant only local planning is available. Local calls stream so a slow
model can keep producing without waiting for a complete response body.

**Retries and preferences.** A failed full run retries at 15 minutes, 45 minutes
and 2 hours. Full-run, total-run and Grok-lane preferences default to **No
preference limit**. Explicit positive ceilings remain respected. The interval,
quiet hours, single-flight and retry schedule still apply. See the
[goal and Leader preference table](AGENT-HARNESS-EVOLUTION.md#operator-goal-and-leader-preferences).

**Check-ins.** Every `foundry.leader.checkinHours` (default 2; 0 turns them
off) during `foundry.leader.workingHours` (default 08–22), the Leader looks
again only when evidence changed materially. A directive, answer or approval
counts. Check-ins are advisory and are never retried. Reserve mode uses local
models for check-ins.

**Invocation traces.** Native completions record role, account, exact model,
reported token totals when available and elapsed wall time. Reported output
tokens divided by total wall time measures invocation throughput; it does not
claim the model's generation speed. A missing token reading stays unknown.

**One run at a time.** A cross-process lock and a stale-decision re-check stop
the daemon and the comms poller from running the same slot twice.

**Health.** `ashlr leader show` and `GET /api/verse/leader` report
`healthy` (the first seat wrote the memo), `degraded` (a fallback did, a retry
is pending, or the last memo is over 36 hours old), `down` (no seat, or the
retries are spent) or `unknown` (never run), with the seats tried and when the
next run is due. Phantom does not show the health state yet.


Model availability comes from each connected account's native catalog. Current
native defaults are Opus 5.5, Fable 5.1 and GPT-6.2 Sol; routing can select the
other eligible variants on that same account. A published API model does not
prove native CLI access. Hidden models are excluded from new automatic choices;
older exact model tags remain readable and do not authorize newer versions.
[OpenAI model details](https://developers.openai.com/api/docs/models/gpt-6.2-sol)
and [Claude model details](https://platform.claude.com/docs/en/models/overview)
provide public API price estimates. Those prices do not replace subscription
allowance, native context allocation or verified funding observations.

### Leader facts snapshot

Run `ashlr fleet leader-facts --json` to refresh `~/.ashlr-runs/leader/facts.json` before a leader pass. The `leader.facts.v1` snapshot joins leader-tagged router queue lines to jobs with a dated ledger event in the last 48 hours, then reads PR state, 24-hour merge counts, and latest release tags from GitHub. Repositories are those represented by the selected jobs. `null` means unknown; source status reports missing or damaged local evidence. Jobs with no dated ledger evidence have unknown age and are retained. Recent Q8 PRs can also be discovered from GitHub when queue history is absent. The file is replaced atomically; this command does not merge or publish anything.

The resident daemon refreshes this snapshot at startup and every 15 minutes. GitHub search also discovers recent Q8 PRs independently of local history; `sources.github` is `partial` when search or a PR lookup fails or the search reaches its page limit. The schedule requires the resident daemon to be running.

The compact brief (`leader.compact-brief.v1`) reads cached GitHub release evidence,
then local git tags for each missing repository. Its `release` counts include this
fallback; `releaseRepos` gives the tag, tag date, commits since the tag, state,
source and unknown reason. Local git is due over 20 commits or over seven days;
otherwise it is ok. On `phm leader brief --json` or `phm fleet release-backlog
--json`, shallow clones or missing local tags fall back to public remote version
tags (highest stable version), their dates and GitHub compare counts. Each remote
read has a five-second budget; readings are cached for ten minutes.
Background compact reads use that cache without network calls. An unreachable
remote stays unknown with a plain reason; an unreadable count stays null.
Missing clones or default-branch refs stay unknown. Tags are not publication proof.
The same evidence appears in `phm fleet release-backlog --json` under `repos[].git`.

Default clone paths are `~/Projects/ashlrai/wt/guardian-<repo>`, then
`~/.ashlr-runs/phm-live` for Phantom, then `~/Projects/ashlrai/<repo>`.
Set `PHANTOM_RELEASE_CLONES` to a JSON object such as
`{"phantom":"/path/to/phantom","locus":"/path/to/locus"}` to replace that list;
unlisted repositories stay unknown with reason `no local clone`. Local reads use
`origin/HEAD` (or `origin/master`, then `origin/main` if unset) and have a
five-second budget per clone. Remote reads use `git ls-remote` against the public
AshlrAI URL, without fetching or changing clones. Local refs reflect their last fleet refresh.
