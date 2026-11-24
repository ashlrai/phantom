# The cloud lane (3.11)

The cloud lane lets Phantom start **Claude Code cloud sessions**
(claude.ai/code) and follow what they deliver. You can start one from chat, from
Command or from the CLI. Phantom can also start them itself, to work through its
own improvement backlog. Sessions run on your Claude account. That includes its
cloud credits, so work continues after the subscription's weekly window is
spent.

The lane never merges anything on its own. Each task is instructed to open a
**draft pull request** on GitHub. Phantom tracks a matching PR if one arrives;
failed launches and missing deliveries remain distinct states. Under a
standing grant, a cloud PR on a granted repo is taken in by the standing merge
pass and lands only through its gates, from the fleet App's own PR (see
[Intake into the standing gates](#intake-into-the-standing-gates-313)).
Everything else is triaged in **Needs you**: each row shows what the merge
gates would say about its diff, and you land, close or update it there (see
[Triage in Needs you](#triage-in-needs-you)).

The contracts live in `src/core/cloud/types.ts`. The user guide in Phantom is
[the Cloud lane section of VERSE.md](VERSE.md#cloud-lane-311).

**A second lane: Devin (3.15).** Devin sessions follow the same pattern: a
task, a branch per task, one PR with a report block, the same Needs-you triage
and the same intake into the standing gates. Cloud Devin PRs need a live stage
that names Devin and judges from two different model families; eligible local
CLI work can follow a signed elite-direct grant. Otherwise the PR is shadow.
See [The Devin lane](#the-devin-lane-315)
below and [DEVIN.md](DEVIN.md).

---

## How a launch works

These mechanics were checked against Claude Code 2.1.280 on 2026-09-24. They
decide the shape of everything else.

- **Only the interactive CLI can create a session.** The command is
  `claude --cloud "<task>"`, and with `-p` it is refused. Phantom therefore runs
  the CLI under a pseudo-terminal: `script -q /dev/null <argv…>` on macOS and
  `script -qec "<quoted argv>" /dev/null` on Linux. On success the CLI prints
  three lines and exits 0:

  ```text
  Created cloud session: <title>
  View: https://claude.ai/code/session_<id>?from=cli&m=0
  Resume with: claude --teleport session_<id>
  ```

  Phantom strips ANSI and OSC sequences from the output and reads the session id,
  link and title from those lines. Anything else is classified as a failure
  (see [Failure codes](#failure-codes)).
- **It runs as the `claude-a` seat.** The launcher is the argv array in that
  seat's native profile (`~/.ashlr/native-profiles/claude-a/command.json`),
  which is signed in with a claude.ai account. Phantom never uses the `claude`
  on your `PATH`, which may be API-key authenticated: cloud sessions refuse API
  keys. The prompt is passed as a single argv element, never through a shell
  on macOS.
- **The session clones the working directory's GitHub `origin` at its current
  branch,** and that branch must already be pushed. So Phantom never launches
  from your own clones. It keeps a separate shallow checkout per repository
  under `~/.ashlr/cloud/checkouts/<owner>__<name>`, fetches the base branch
  into it, checks it out with its upstream set, and launches from there. It
  uses your normal git credentials. Launches in one checkout run one at a time,
  because two `--cloud` runs in the same folder conflict.
- **Phantom cannot read a session back.** Attaching to an existing session is not
  enabled for this account, so every task is told to deliver to GitHub
  instead (the [delivery contract](#the-delivery-contract)), and Phantom tracks
  it with `gh`.
- **A launch times out after 90 seconds.** If no session has appeared by then,
  the process group is killed and the task fails with `timeout`.

The whole flow, in order: validate the request, check the budget gates, save
the task as `queued`, wait for the repository's launch slot, prepare the
checkout, build the prompt, launch, then save `running` with the session link,
or `failed` with a plain reason.

<a id="what-verse-checks-before-launching"></a>

### What Phantom checks before launching

- The repository must look like `owner/name` (letters, digits, `.`, `_`,
  `-`).
- The task text is cut to 20,000 characters. The title is its first line, at
  most 80 characters, unless one is given.
- **Seat status is read from disk only.** The seat is ready when the `claude-a`
  profile's `command.json` exists and parses to an argv array. Otherwise
  Phantom says "The Claude seat isn't set up on this Mac." It does not run the
  CLI to check sign-in, because that would cost a process on every page load.
  A signed-out seat shows up at launch time as an `auth` failure.

---

## The delivery contract

Every prompt Phantom sends is your task text followed by a fixed contract. The
stored task keeps only your text. The contract tells the session to:

1. create and work on the branch `ashlr-cloud/<taskId>`, starting from the
   base branch you chose, and never push to any other branch;
2. never merge anything;
3. run the repository's relevant tests, commit and push;
4. open a **draft** pull request against the base branch titled
   `[ashlr-cloud] <title>`;
5. end the PR body with a fenced `ashlr-cloud-report` JSON block:

   ````text
   ```ashlr-cloud-report
   {
     "status": "done",
     "summary": "One or two sentences on what changed.",
     "testsRun": ["npx vitest run test/example.test.ts"],
     "risks": ["Anything a reviewer should look at first."],
     "filesChanged": 3
   }
   ```
   ````

   `status` is one of `done`, `partial`, `blocked` or `no-change`.
   `filesChanged` is optional. When the repository's `.mcp.json` declares
   Phantom's companion servers, the prompt also names each one and when to
   call it, and the report may carry `"toolsUsed"`: the companion tools the
   session called. `ashlr cloud list` prints it as a `Companion tools:` line.
6. If nothing needs changing, still push an empty commit and open the PR with
   status `no-change`, so Phantom sees that the task finished.

Task ids look like `ct_20260924T2331_k3f9q2`: sortable, and safe to use in a
branch name.

Phantom reads the **last tagged** report block in the PR body and validates it.
A missing, malformed, oversized or unfinished final block leaves the task's
report empty, even if an older block was valid; the PR is still tracked.

The report is written by the cloud session. Command and Needs you label its
summary as unverified; `testsRun` records what the session claims to have run,
not an independent test receipt. The tracker only treats a PR as this task's
delivery when its repository, base branch and head branch match the task.

### Task states

| State | Meaning |
|---|---|
| `queued` | Accepted and waiting for its repository's launch slot. |
| `launching` | The CLI is running under the pseudo-terminal. |
| `running` | The session exists. No PR yet. |
| `pr-open` | A draft or ready PR exists on `ashlr-cloud/<id>`, or the cloud PR was superseded by a fleet App PR that is still open (`supersededBy`). |
| `merged` | The PR was merged by you, or the fleet App PR that superseded it was merged by the standing gates. |
| `closed` | The PR was closed without merging, or you dismissed the task in Phantom. Dismissing never touches GitHub. |
| `failed` | The launch failed. The failure code and a plain reason are recorded. |
| `expired` | No PR appeared within 6 hours. The session link still works. |

**Tracking.** For each task that is not finished, Phantom asks GitHub for a PR
whose head is the task's branch (`gh pr list --head ashlr-cloud/<id>`). A task
moves from `running` to `pr-open`, and from `pr-open` to `merged` or
`closed`. A `running` task with no PR after 6 hours becomes `expired`. If `gh`
fails, tasks stay as they were; tracking never throws into the page or the
scheduler.

---

## The budget, and why it is an estimate

Claude does not expose the credit balance. Neither `/usage` nor the CLI shows
it. So every spend figure in the lane is an **estimate**, and Phantom labels it
as one everywhere it appears:

> Estimated at $3 per session — Claude doesn't expose the credit balance.
> Check it on claude.ai and adjust here.

The real balance is at <https://claude.ai/settings/usage>, and Phantom links to
it next to every figure.

**How the estimate is built.** Estimated spend is your adjustment plus the
per-session estimate of every task that reached `running` or later. A failed
launch costs nothing. Estimated remaining is the total minus that. The
estimate for a task is fixed when it launches, so changing the per-session
figure later does not rewrite history. Use the adjustment to correct the
estimate after checking claude.ai, or to count credits spent before Phantom
started tracking.

| Setting | Default | What it does |
|---|---|---|
| Credits total | $250 | What you say the account has. |
| Spent adjustment | $0 | Added to the estimate. Use it to calibrate against claude.ai. |
| Estimate per session | $3 | The flat figure charged to each launched session. |
| Max concurrent | 4 | Sessions launching or running at once, from any origin. |
| Max sessions per day | 20 | Launches per local calendar day, from any origin. |
| Self-improvement | on | Whether Phantom may launch backlog items without a click. |
| Self-improvement repo | `ashlrai/ashlr-hub` | Where self-improvement tasks go. |
| Self-improvement per day | 4 | Self-improvement launches per local day. |
| Open self-improvement PRs | 3 | Self-improvement waits while this many of its PRs are open for review. |
| Self-improvement reserve | $40 | Self-improvement stops when estimated remaining credits fall below this. |

"Today" is your local calendar day, not UTC. Settings are saved in
`~/.ashlr/cloud/budget.json`. Every update is validated and clamped, and a
missing or corrupt file falls back to the defaults.

**Gates.** Before anything is saved or launched, the budget answers two
questions, each with a plain sentence when the answer is no:

- **Can launch?** Checked for every launch. It holds the concurrency limit, the
  daily session cap and the credit estimate.
- **Can self-improve?** Checked additionally for launches Phantom starts on its
  own. It adds the self-improvement switch, review backpressure ("3
  self-improvement PRs are waiting for review."), the self-improvement daily
  cap ("4 of 4 self-improvement launches used today.") and the reserve.
  Backpressure lifts as you land or close those PRs; the **Improve Phantom**
  button and manual launches are not held by it.

A refused launch is recorded nowhere and costs nothing. It comes back with the
`budget` failure code and the gate's sentence.

---

## Self-improvement

Phantom keeps a backlog of work on itself and can hand items to cloud sessions.

- **Built-in items** live in `src/core/cloud/improvement-backlog.ts`. Each is
  a complete brief for a session working in `ashlrai/phantom`, re-verified
  against master before it is added. The delivery contract is appended to
  each brief.
- **Your items and the Leader's** are added to `~/.ashlr/cloud/backlog.json`.
  The file is validated and holds at most 200 items. The Leader turns
  code-change actions from its memos into items with ids like
  `leader-<memoId>-<n>`. Its class-C actions still go to Needs you.
- **Discovered items** are added by `phm improve discover` and the
  scheduler's refresh: a red default branch, issues someone with triage
  rights labelled `phantom`, evidence-backed proposals, the fleet's own
  outcome learning — recurring breakage, revert, dirty, fixup and low-merge
  patterns the jobs ledger and dispatch log already prove become items
  whose ids embed the stable `improve-<hash>` job id, so refreshes add only new
  patterns — the nightly local retro's proposals, the recurring
  verification, scope, safety, review and execution findings it mines from
  fleet, cloud and Devin job records (`~/.ashlr/learn/retro-proposals.json`,
  otherwise only visible through `phm improve nightly`) — and the fleet
  outcome metrics' advisory policy suggestions, the measured empty-lane
  prompt-template flags and within-tier model routing hints
  `phm fleet metrics suggest|weekly` computes from the same jobs ledger
  (otherwise only visible in that report) — and the local pre-merge
  gate ledger's recurring step failures, the per-step pass/fail tallies
  every gated worker run records to `metrics/local-gate.jsonl` and
  `phm fleet vitals` folds (otherwise only visible in that report) — and
  the pass^k eval's regression alerts, the task, pass^k and dimension
  regressions the nightly golden-set eval journals to
  `~/.ashlr/eval/passk/alerts.jsonl` (otherwise only visible through
  `phm eval passk alerts`). An alert identity becomes an item while the
  newest persisted eval report still shows the regression or the journal
  shows it recurring across eval reports — and the fleet friction fold's
  firing categories, the dispatch→merge drags `phm friction` scores over
  a 7-day window across jobs.jsonl, the dispatch event log, ready.tsv,
  guardian state, lane slots, overrides and its own note ledger
  (otherwise only visible in that report). A friction category becomes an
  item while its own open condition holds — the primary signal or a
  declared open-on signal counted something in the window — and no
  operator note suppresses it; a note marked `fixed` whose signal is back
  emits as regressed, while `in-progress` and `wontfix` notes stay out —
  and the resident daemon's own tick ledger, the per-phase ledgers and
  whole-tick reasons `daemon.json` retains for the last 100 ticks
  (otherwise only visible through `phm daemon status`, which prints just
  the last tick's phases and outcome). A tick phase becomes an item while
  its degraded, timed-out, abandoned, budget-starved or failing off-tick
  outcomes recur inside a 7-day window — one settled off-tick run failure
  observed on many ticks counts once — and a whole-tick reason becomes an
  item while `state-persistence-failed` or `activation-refused` recurs;
  policy reasons like `budget-exhausted` never do. A missing or unreadable
  state file emits nothing —
  and the cross-model review journal's recurring findings, the reject
  reason codes and review failures `fleet/cross-review.jsonl` records for
  each repository's pull requests (otherwise only visible through
  `phm router outcomes`/`phm fleet router-weights` tallies and the audit
  log). A finding becomes an item while its recorded rows span enough
  distinct pull requests inside the recency window — a producer whose
  diffs keep failing independent review for the same reason, or a
  reviewer pipeline that keeps failing before a verdict — and the
  empty-job tag ledger's recurring
  actionable tags, the `job.empty-tag.v1` rows the daemon's empty-tag-sync
  and `phm jobs empty --record` write to `metrics/empty-tags.jsonl`
  (otherwise only visible through the `phm empties`-family reports and the
  router's outcome fold). A finish becomes an item while its recorded tag
  is `blocked` or `unknown` at least three times inside the same 72-hour
  window the sync uses, or while finishes with no tag row at all are the
  window's majority — the signature of a dead or starved empty-tag-sync;
  gate-skipped finishes never count, and the explained `already_done`,
  `no_change_needed` and `pool_cap` tags never become work. A missing jobs
  ledger or an unjoinable tags ledger emits nothing —
  and the signed post-merge observation ledger's recurring adverse
  outcomes, the reverted, regressed and followed-up rows the
  outcome-watcher and post-merge-stability passes record to
  `fleet/post-merge-observations.jsonl` (otherwise only visible through
  `phm fleet eval-report` and the standing merge pass's internal pacing
  read). The same fold `phm fleet eval-report` prints joins them through
  `metrics/jobs.jsonl` into per-lane, per-tier and per-repo durability
  tallies over a 30-day window; a group becomes an item while its
  recorded adverse outcomes reach the recurring bar — lane and tier
  cells emit only for the fleet's own repository since they describe
  this repo's executor machinery, and a repo cell emits only when the
  fold's recorded repository name matches the discovery target. A
  degraded observation read or a missing jobs ledger emits nothing, and
  prompts quote only the measured merged/adverse counts and the
  deterministic/heuristic confidence split — never a durability rate the
  gh-less fold cannot support —
  and the resident ci-rerun journal's recurring fail verdicts and failed
  rerun calls, the probable-flake classifications whose reruns keep
  concluding failure and the `gh run rerun --failed` calls that keep
  erroring, journaled to `ci-reruns/journal.jsonl` under the Phantom state
  directory by the daemon's ci-rerun pass (otherwise only visible through
  `phm ci reruns` and `phm daemon status`'s last-pass status). A test
  becomes an item while its recorded fail verdicts reach the recurring
  bar across at least two distinct heads inside the journal's own
  7-day window — the probable-flake classification is not holding, so
  the grouping or the test itself needs work — and a repository becomes
  an item while its failed rerun calls reach the recurring bar and
  outnumber the window's successful calls, the signature of a rerun loop
  that cannot fire. Verdict rows without a recorded test id never emit,
  and a missing or unreadable journal emits nothing —
  and the lost-launch report's corroborated losses, the launches whose
  `<ID>.launch` first line records the launcher dying or whose launch
  event has no finish/publish row and no open run marker once the grace
  passed, folded from `metrics/jobs.jsonl` by `phm jobs lost`
  (otherwise only visible through that report and supply-doctor's 24 h
  count; outcome learning censors the silent vanishes as unresolved
  attempts that never count). A (lane, class) cell becomes an item while
  its corroborated losses reach the recurring bar inside the 72-hour
  window — jobs the dispatcher still counts as running are excluded, so
  a long job never queues work — and an unreadable ledger or run-marker
  directory emits nothing —
  and the swapout-rate ledger's recurring memory evidence, the per-sample
  `free_pct`/`swap_gb`/`swapouts_per_min` rows the daemon's swapout-sync
  job folds from the bridge's memstat.json into
  `metrics/swapout-rate.jsonl` under the fleet runs directory
  (otherwise only visible through `phm fleet vitals`' swapout_rate
  section and the console's memory-guard card — reports someone had to
  open, even though the ledger exists to tune the lane-autopilot
  MEMORY_GUARD constants the code itself marks unmeasured). A sample
  becomes recorded-pressure evidence when any recorded field meets a
  severe line — free below the guard's low line, any swapout activity,
  or swap past the backstop — and a complete three-field reading becomes
  withheld-raise evidence when `memoryAllowsRaise` refuses it. An axis
  becomes an item while its condition holds on at least half of the
  judged samples in at least six distinct hour buckets spanning two UTC
  days inside the 7-day window; partial rows never count as blocked or
  clear, a missing or unreadable ledger emits nothing, and unknown
  fields stay unknown rather than reading as zero —
  and the fleet-controller ledger's recurring control evidence, the
  per-tick `fleet-controller.ledger.v1` rows the dispatcher's fleet
  controller appends to `metrics/fleet-controller.jsonl` under the fleet
  runs directory (and its single `.1` rotation; otherwise only visible
  through `phm fleet admission --details`, `phm amplify` and
  `phm fleet status` — reports someone had to run and read). A
  fail-closed signature, degraded reading, shed driver, ambiguous lane,
  shed umbrella, unapplied would-shed plan, blind merge objective or
  mostly-unmeasured quality receipt becomes an item while its recorded
  condition holds on at least half of a tick-hour's rows in enough
  distinct hour buckets across two UTC days inside the 7-day window —
  umbrella cells at six hours, per-key cells at four — and a missing or
  unreadable ledger emits nothing. Truncated ledger tails are stated in
  the prompt as a lower bound, never hidden —
  and the trajectory outcome projection's recurring adverse skill
  tallies, the per-(skill, revision) selection counts and deterministic
  post-merge realized verdicts `trajectoryLearning.skillOutcomes`
  publishes for learned skill cards once the skill-observation sample
  gate passes (otherwise only visible through
  `phm skills list --outcomes` and `phm fleet status` — reports someone
  had to run and read, even though the skill library is the
  self-improvement loop's own memory). A (skill, revision) row becomes
  an item while its reverted + regressed + followed-up realized
  outcomes reach the recurring bar inside the 7-day window, only while
  that exact revision is still the corpus's newest card and its status
  is candidate or verified — superseded and withdrawn revisions were
  already handled — and only on a healthy corpus, since a degraded card
  history cannot prove which revision is live; a withheld projection, a
  degraded ledger or another repository emits nothing —
  and the precheck-skip ledger's recurring skip evidence, the
  `queue/precheck-skips.tsv` rows the dispatchd claim loop appends for
  every job its empty-run precheck or dupcheck gate finishes as
  DONE-NOOP without a model call (otherwise only visible through
  `phm fleet precheck-repeats`, `phm fleet parked`'s queue-health
  tallies and `phm fleet queue`'s skip sections — reports someone had
  to run and read). A (code, reason-shape) group becomes an item while
  its recorded skips span enough distinct job ids inside the 7-day
  window — reasons group on a digit-normalized shape since they embed
  job- and PR-specific numbers — and a job id becomes an item while
  its recorded skips reach the same recurring bar, the signature of a
  producer resurrecting finished work. A degraded ledger read or a
  missing file emits nothing —
  and the producer-yield scoreboard's recurring no-land sources, the
  per-source launches, PRs, merges, empties and aborts
  `phm jobs yield --by source` folds from `metrics/jobs.jsonl` and the
  queue's `src=` tags into `jobs.yield-by.v1` — the same fold the leader
  digest's `yield_low` line reads (otherwise only visible through that
  report and the digest). A producer — leader bets, Core planner rows,
  cl-stream docs jobs, guardian fixups or restock filler — becomes an
  item while its launches reach the fleet's own judging count inside the
  7-day window, its merged-per-launch stays under the fleet's own
  poor-yield threshold and at least three recorded finishes ended empty
  or aborted; launches still in flight carry no verdict and never count,
  the `other` catch-all never emits, and a missing or unreadable jobs
  ledger emits nothing —
  and the InferenceGateway shadow journal's recurring divergence, the
  observe-only gateway-vs-legacy comparison rows the daemon appends to
  `fabric/gateway-shadow-<UTC-day>.jsonl` under the Phantom state
  directory when `foundry.fabric.gatewayShadow` is on (otherwise only
  visible through `readGatewayShadow`/`divergenceStats` in
  src/core/fabric/gateway-shadow.ts — code with no caller, so the journal
  had no reader at all). A safety-relevant divergence — the gateway
  would have dispatched an item the legacy path blocked on throttle,
  budget or resource pause — becomes an item while such rows reach three
  inside the 7-day window, the CONTRACT-M334 stage-3 bar being zero; a
  divergence item emits while the window holds at least 50 shadowed
  decisions and the measured divergence rate reaches the stage-2
  tolerance of 2%, naming the largest recorded backend disagreements. A
  missing or unreadable fabric directory emits nothing, and rows emit
  only for the fleet's own repository since the shadow covers this
  install's dispatches —
  and the fleet recheck verdict history's recurring non-clean cells, the
  per-pass `fleet.recheck-record.v1` rows the self-tick recheck-record
  step and `phm fleet recheck-record` append to
  `fleet/recheck-log.jsonl` under the Ashlr home (otherwise only visible
  through `phm fleet recheck-record --last`, the verse recheck history
  parameter and the fleet MCP recheck tool — reports someone had to run
  and read). A cell becomes an item while it is recorded on at least
  three in-window rows inside the 7-day window: an overall UNKNOWN or
  BLOCKED verdict, a runtime/claims/bridge/task section state, or a
  missing reason normalized so count-carrying variants group as one —
  UNKNOWN (the section's evidence never arrived) and BLOCKED (a
  positively identified gap) stay separate cells since they are
  different problems, reasons group across the per-section lists but
  never the flattened overall list, VERIFIED-only history emits
  nothing, and a missing or unreadable log emits nothing —
  and the stuck-job reaper's own audit ledgers, the ghost-close rows the
  stray-stop reaper appends to `queue/stuck-jobs.jsonl` when a run marker
  outlives its dead process and the `by:'stuck-jobs'` kill rows it audits
  to `queue/job-stops.jsonl` when a job past the stuck bar had to be
  SIGTERMed/SIGKILLed (otherwise only visible through `phm jobs stuck`'s
  live marker view and `phm job show`'s per-job window — both ledgers
  were write-only audit with no trend fold, while the lost-launch feed
  excludes open-marker jobs by design). A (kind, lane) cell becomes an
  item while its distinct job count reaches the recurring bar of three
  inside the 72-hour window; lane and repo attribution joins
  `metrics/jobs.jsonl` as enrichment that degrades to 'unknown' rather
  than suppressing the reaper evidence, each class reads only its own
  ledger so one missing file silences only its class, truncated tails
  are stated as lower bounds, and rows emit only for the fleet's own
  repository since the reaper is this install's machinery —
  and the cloud lesson holdout trial's adverse verdicts, the
  randomized served-vs-holdout landing comparison `lessonTrial`
  (src/core/improve/lesson-trial.ts) folds from the cloud task files
  under `~/.ashlr/cloud/tasks` and the revert ledgers — overall and
  per knowledge note — that `phm improve lessons` prints and the
  Verse Lessons view exposes as `knowledge.trial` (otherwise only
  visible through those reports — a 'hurts' verdict never became
  work). A scope becomes an item only while its verdict is `hurts` —
  the 95% interval excluding zero on the negative side, served runs
  landing measurably worse than the identical prompt held out — and a
  per-note row only while its note is still `approved`, since that is
  the state that keeps it eligible for injection; rejected, pending
  and unresolvable notes emit nothing, `helps`, `no-difference` and
  `unknown` emit nothing, a withheld trial (a task-store or ledger
  read failure) or a failed knowledge read emits nothing for the
  per-note rows, and another repository emits nothing —
  and the work market journal's recurring unfed-capacity and
  route-decision evidence, the per-tick `route_decision` and
  `unfed_capacity` rows dispatchd's market_metric appends to
  `metrics/work-market.jsonl` under the fleet runs directory
  (otherwise only visible through `phm fleet unfed`, `phm route
  explain` and the router outcome/weight folds — reports someone had
  to run and read). A lane becomes an item while its recorded unfed
  ticks span enough distinct UTC days inside the 7-day window — free
  target slots while runnable rows waited under other lanes' hints —
  a (lane, reason-code) cell becomes an item while distinct jobs keep
  recording that lane's rejection for the same non-mechanical code
  across days (lower_rank, saturated, held and hysteresis_* never
  emit — the market working as designed), and unrouted decisions and
  unknown_preference overrides become umbrella items at the same
  recurring bar; route decisions collapse to each job's latest
  in-window row, a missing or unreadable journal emits nothing,
  truncated tails are stated as lower bounds, and rows emit only for
  the fleet's own repository since the journal describes this
  install's dispatcher and lanes —
  and the pre-launch dupcheck gate's precision ledger, the
  queue.dupcheck-event.v1 rows `phm queue dupcheck --gate` records for
  every claimed job — skip, warn or launch — plus the outcome rows
  empty-tag-sync and `phm jobs empty --record` append when a
  let-through job finishes EMPTY already_done, folded through the same
  per-job semantics `phm queue dupcheck --stats` and the Ideas list's
  dupcheck-gate signal compute (otherwise only visible through those
  reports — recurring missed duplicates or wrong skips never became
  work). A cell becomes an item only at the Ideas list's recurring
  bars, anchored inside the 7-day window — missed duplicates need
  three let-through jobs ending already_done at a missed share of a
  tenth, false skips need two skipped jobs recorded launching or
  warning later — a missing or unreadable ledger emits nothing,
  malformed lines and unknown actions drop like the stats reader's own
  parse, and another repository emits nothing since the ledger carries
  no repository column —
  and the improve outcome ledger's recurring adverse evidence, the
  digest-chained scorecard `phm improve register`, the scheduler's
  `syncCloudBacklogOutcomes`, `phm improve measure`, `promote` and
  `observe` append to `improve/outcomes.jsonl` under the Ashlr home
  (otherwise only visible through `phm improve outcomes`, the
  north-star vision read and the backlog's own area-leverage ranking —
  reports and joins someone had to run, so the self-improvement
  loop's own measured verdicts never became work). A signal becomes
  an item at the recurring bar of three distinct proposals: registered
  proposals with a recorded PR but no `measured` event past the
  24-hour grace — registration is automated but the later verbs are
  manual and unscheduled, so the scorecard starves — is a
  current-state stall tally; in-window `measured` events that keep
  returning no value become an item at three recorded events across
  two distinct proposals, quoting the recorded reasons; measured
  regressions (declared metric worse at head than merge base) and
  merged-then-reverted observations become items at three distinct
  proposals whose establishing event lands inside the 7-day window,
  the re-land rule clearing a revert a later merge supersedes. A
  missing ledger reads as empty while a broken chain emits nothing,
  proposals whose last observation is a revert never count as
  measurement stalls, and rows emit only for the fleet's own
  repository since the verbs and scheduler sync are this repo's
  machinery —
  and the typed-routing decision journal's recurring unavailability
  and degradation, the per-tick `route.explain.v1` rows dispatchd's
  observe_typed_route appends to `metrics/route.explain.jsonl` after
  each advisory `phm route decide` sample (otherwise only visible
  through `phm route explain`'s typed_decisions digest — a report
  someone had to run and read). An item emits only while the evidence
  spans enough distinct UTC days inside the 7-day window at the
  recurring row and share bars — 'unavailable' samples (the whole
  decide call failing before a decision exists) must reach a tenth of
  all valid records, and a decideRoute failure code
  (backend-unavailable, deadline, schema-invalid) must ride a
  twentieth of observed decisions while also carrying the
  deterministic-fallback marker, so a degraded code a later backend
  recovered never counts; path and policy codes never emit, a missing
  or unreadable journal emits nothing, malformed lines and decisions
  outside the producer's allowlist drop like the digest reader's own
  parse, truncated tails are stated as lower bounds, and another
  repository emits nothing since the journal describes this install's
  dispatcher —
  and the branch gardener's audit journal, the per-repo `result` rows
  the launchd branch gardener (contrib/mac/branch-gardener.py,
  docs/BRANCH-GARDENER.md) appends to
  `metrics/branch-gardener.jsonl` under the fleet runs directory on
  every scheduled pass (otherwise only visible as append-only audit —
  the journal had no reader at all). A repository becomes an item
  while its recorded `result` events inside the 7-day window show
  recurring evidence of three kinds: branches whose `flag` rows — the
  gardener's documented triage list of PR-less branches with unique or
  recent commits and branches whose tip moved after their PR — persist
  across flag observations spanning at least a day, at two or more
  distinct branches; `failed-or-uncertain` delete rows — branches
  inside atomic `git push --delete` batches that errored or timed out,
  so the remote ref may or may not be gone — reach three rows across
  two distinct UTC days; or errored result events reach two distinct
  UTC days, the signature of evidence gathering that keeps failing and
  leaving that repo's branches unclassified. Only `result` events
  fold — plan, delete-intent and deleted rows repeat the same
  classifications — repo matching is exact owner/name since each
  audited remote owns its own branch namespace, a missing or
  unreadable journal emits nothing, and truncated tails are stated in
  the prompt as lower bounds —
  and the reward-signal ledger's recurring per-pool not-held collapse,
  the resolved-job rows the daemon's reward-sync off-tick job folds
  from `metrics/jobs.jsonl` into `metrics/reward-signals.jsonl` under
  the Ashlr home — one scrubbed reward-signal.v1 row per job whose PR
  lifecycle reached an authoritative resolution, `merged:true` for a
  verified merge and `merged:false` for a PR closed unmerged or a merge
  later reverted (otherwise only visible through `phm
  router-calibration`, the eval harness's `readRewardSignals`, the
  dashboard's `latestRewardSignals` and the `phm router outcomes`
  join — reports and joins someone had to run and read, so a dispatch
  pool whose resolved work kept not holding never became work even
  though the ledger exists to score which arm deserves the next
  dispatch). A pool becomes an item while its in-window resolved rows
  reach the recurring bars — enough rows, enough not-held rows, a
  strict majority not held and evidence spanning distinct UTC days
  inside the 7-day window — with rows whose pool field went unrecorded
  grouping as the calibration arm's own 'unknown' cell, in-flight jobs
  absent by design and never counted; a missing or unreadable ledger
  emits nothing, rows failing the writer's closed contract drop like
  the substrate readers' own parse, truncated tails are stated as lower
  bounds, and another repository emits nothing since the ledger is
  this install's dispatch record —
  and the job-control steering ledger's recurring unacknowledged
  requests, the fleet.job.control.v1 rows `phm job <action>`, POST
  /api/verse/fleet/runs/control and the desktop job detail append to
  `queue/job-control.jsonl` under the fleet runs directory — requests
  still standing at 'requested' because the documented dispatcher
  contract's apply-and-acknowledge side has no consumer (otherwise only
  visible through the session-thread display, which renders a standing
  request as "The dispatcher has not applied it yet." — the ledger's
  only readers were display surfaces, so steering verbs that are dead
  letters never became work). The cell becomes an item while
  unacknowledged requests inside the 7-day window reach three, cover
  two distinct job ids and span two distinct UTC days — one job's
  retries or one afternoon of trials never emit — with the synchronous
  'applied'/'refused' paths quoted as context, a missing or unreadable
  ledger emitting nothing, truncated tails stated as lower bounds, and
  rows emitting only for the fleet's own repository since the ledger is
  this install's steering record —
  and the jobs ledger's recurring usage-capture gaps, the
  `usage_missing` provenance labels dispatchd's `job_usage()`
  (contrib/mac/dispatchd.py — `devin_usage()` reading the Devin
  sessions.db, `claude_usage()` reading the claude result JSON usage
  block, and the 'tokens used' log-line fallback) writes on every
  finish row in `metrics/jobs.jsonl` under the fleet runs directory
  when a lane's own usage evidence cannot be flattened — sessions.db
  missing or unreadable, no session for the worktree, incomplete or
  unreported Devin usage, a missing claude result usage block, a
  tokens line absent from the log (otherwise only visible through
  `phm fleet router-weights`'s usage_missing/usage_sources coverage
  tallies and `phm router outcomes`'s per-job fields — reports
  someone had to run and read, so a capture path that kept failing
  starved the router's weight, calibration and cost evidence while
  looking like ordinary absent data). Each job collapses to its
  newest in-tail finish row — a retry whose later finish captured
  usage is evidence the gap closed, not that it persists — and a
  label becomes an item only while its standing finishes reach the
  recurring bars of distinct jobs across distinct UTC days inside
  the 7-day window; lane and repo attribution joins the same tail's
  jobTimelines fold and degrades to 'unknown'/'unattributed' rather
  than suppressing the gap evidence, a missing or unreadable ledger
  emits nothing, malformed lines, non-finish events, node-pool
  producer schemas and unsafe job ids drop like the sibling
  jobs-ledger readers' own parse, truncated tails are stated as
  lower bounds, and rows emit only for the fleet's own repository
  since the capture paths are this install's dispatcher and lanes —
  and the fleet runtime journal's recurring adverse dispatch
  evidence, the fleet.runtime dispatch rows tick-hooks-live's
  afterDispatch appends to fleet/runtime/runs.jsonl under the ASHLR
  home — one row per work-item outcome carrying the route decision
  behind it (backend, lane, seatId, the SeatRouter seatDecision with
  per-seat exclusion details, the park/split RouteHold, the
  skipReason, the harness version) alongside landing rows for merges
  and reverts (otherwise only visible through the Fleet live
  projection behind `phm fleet lane-slots`/`phm lanes`/`phm map`, the
  ops board and scheduling's work-history join — display and
  attribution surfaces, while tick.json keeps only the LAST tick's
  held list, so recurring holds, chronic seat exclusions and
  repeating skip codes never became work). A (seat, reason-kind)
  exclusion becomes an item only for evidence-broken kinds —
  unknown-usage, unreachable, signed-out, other — while
  capacity-truth and policy kinds stay silent; a (hold kind, repo)
  cell emits only for seat-evaluated parks (policy holds carry no
  seatDecision) and splits; a skip cell needs a code-shaped reason
  on a hold-free non-dispatched row; every cell reaches the
  recurring bars of distinct items across distinct UTC days inside
  the 7-day window, a missing or unreadable journal emits nothing,
  landing rows and malformed lines drop like the sibling readers'
  own parse, the current and rotated .1 tails read bounded at the
  writer's RUNS_JOURNAL_MAX_BYTES with truncation stated as lower
  bounds, and rows emit only for the fleet's own repository since
  the journal is this install's dispatch record —
  and the queue generation journal's recurring candidate refusals,
  the queue.generation-event.v1 decisions planAutofill's trace
  (src/core/fleet/queue-autofill.ts) records and the autofill runner
  and supply-floor pass append to metrics/generation.jsonl under the
  fleet runs directory on every applied pass — 'drafted' and
  'rejected' rows per candidate with the refusal reason, otherwise
  only visible through `phm queue yield`'s queue.generator-yield.v1
  report, the metrics panel and queue-autofill's per-pass candidate
  ranking — surfaces that steer one pass at a time or that someone
  had to run and read). A (src, reason) cell becomes an item only
  while its recorded rejections reach the recurring bars of four
  events across two distinct UTC days inside the 7-day window, with
  the src's drafted events tallied as refusal-share context; the
  'unknown' src catch-all never emits, a missing or unreadable
  ledger emits nothing, malformed lines and foreign-schema rows drop
  like the writers' own contract, truncated tails read as lower
  bounds, and another repository emits nothing since the journal
  carries no repository column —
  and the incident-gate decision ledger's recurring failure classes
  and stuck tightenings, the per-class rows `ashlr fleet
  incident-gate --apply` appends to
  `fleet/incident-gates.jsonl` under the Ashlr home (~/.ashlr/fleet)
  after mining `metrics/jobs.jsonl` and `dispatch-events.log` under
  the fleet runs directory for repeated failure signatures —
  lane-error, test-failure and merge-conflict classes that cross the
  >=3-fresh-signals bar (otherwise only visible as append-only audit:
  appendIncidentGateLedger has no reader and the verb has no report
  mode, so the fleet's own incident response never became work). A
  class becomes an item while its watermark-advancing rows — applied
  tightenings, or lane-hold refusals that record manual-hold or an
  unknown lane — span two distinct UTC days inside the 7-day window:
  each refire needed fresh failure signals, so the bounded holds keep
  treating a cause that stays unfixed. A second item emits while the
  class's tightenings that never landed — 'error' rows and
  repo-cooldown refusals, which leave the watermark stuck so the same
  signals re-fire every --apply run — span two distinct UTC days, the
  signature of a broken apply path rather than a transient. lane-error
  rows carry this install's lane scope and emit only for the fleet's
  own repository; test-failure and merge-conflict rows carry the
  qualified owner/repo scope and emit only when it matches the
  discovery target exactly, case-insensitive. Only writer-appended
  rows count — dry-run evaluations leave no trace — rows failing the
  writer's closed contract or whose cls disagrees with its gate drop
  like the sibling readers' own parse, a missing or unreadable ledger
  emits nothing, truncated tails are stated as lower bounds, and
  secret-shaped detail text is scrubbed before it reaches a prompt,
  and the Jev decision ledger's recurring fallback-dominant kinds, the
  DecisionRecords `decide()` appends to `jev/decisions/YYYY-MM-DD.jsonl`
  under the Ashlr home for every wired call site — engine-error
  classification, task-class, the judge/taste/red-team verdicts,
  completion-claim, retro-root-cause, needs-you-priority,
  interrupt-worthiness, lane-choice, resource-choice, trigger-triage,
  action-class and operator-intent (otherwise only visible through
  `phm jev status [--day]` and the Verse Jev card — day-scoped reports
  someone had to run and read, so a kind whose Jev path kept losing
  across a week, or a provider-side fallback reason recurring across
  kinds, never became work). Deliberate-off fallbacks — no-key,
  disabled, killed, kind-disabled, no-input — are filtered before the
  write, so every recorded fallback is a decision Jev was eligible for
  and lost; a kind becomes an item only while its in-window decisions,
  fallback rows across distinct UTC days and fallback share reach the
  recurring bars inside the 7-day window, day files read bounded with
  truncation stated as lower bounds, estimated cost stays unknown
  rather than zero when calls were unpriced, a missing day file means
  no decisions were recorded while an unreadable one emits nothing,
  malformed lines and off-contract rows drop like the writer's own
  contract, and rows emit only for the fleet's own repository since
  every call site is this install's own code and the ledger carries no
  repository column,
  and the scheduled worktree reap's removal-attempt journal, the
  per-attempt rows `removeSafe` in `src/core/fleet/worktrees.ts` appends
  to `queue/worktree-reap.jsonl` under the fleet runs directory every
  time the self-tick's planner-tick stage runs the reap — failed git
  removals, unsafe-path refusals and the unpushed-commits /
  uncommitted-changes holds that strand finished jobs' worktrees
  (otherwise only visible through `phm worktrees --reap --status`'s
  last-run summary and the worktrees report's ReaperHealth verdict —
  reports someone had to run and read, while the journal's recurring
  failures never folded into work). A (kind, lane) cell becomes an item
  while its distinct job count reaches the recurring bar of three
  inside the 7-day window — 'removed' successes and 'state-changed'
  recheck refusals never emit — with lane and repo attribution joining
  `metrics/jobs.jsonl` as enrichment that degrades to 'unknown' rather
  than suppressing the reap evidence, truncated tails stated as lower
  bounds, and rows emitting only for the fleet's own repository since
  the reap is this install's machinery,
  and the gap proposer's own queue-write journal, the {at, id, title,
  repo} rows `phm jobs gaps --propose` — run by the fleet self-tick's
  autofill harvest (autofill-run.ts harvestGaps → readJobGaps) —
  appends to metrics/gap-proposed.jsonl under the fleet runs
  directory for every successful drop-job write, where id is the
  deterministic content key gapJobId = 'GAP' + the first ten hex chars
  of sha256(normalizeTitle(title)), uppercased, and the minted queue
  job id is RQ-PHX-<id>
  (otherwise only visible through the proposer's own 24-hour dedupe
  and `phm doctor supply`'s proposed count — a report someone had to
  run, so a gap whose attempts keep finishing without the work
  holding, and which the narrow dedupe windows let through again on
  later ticks, never became work). A gap id becomes an item only
  while its recorded queue writes reach the recurring bars of three
  proposals across two distinct UTC days inside the 7-day window,
  with each cell joined to the same gap job's launches, finishes,
  publishes and resolved outcomes in metrics/jobs.jsonl so the prompt
  quotes what the earlier attempts actually did; a missing or
  unreadable proposal journal emits nothing, a withheld jobs ledger
  degrades the tallies to unknown rather than suppressing the
  proposal evidence or zero-filling it, malformed lines and
  off-contract rows drop like the writer's own contract, truncated
  tails are stated as lower bounds, and rows emit only for the
  fleet's own repository since the proposer and its dedupe are this
  install's machinery,
  and the merge-bottleneck recut loop's own journals, the {at, pr, id,
  headSha, baseSha?, file} rows `recutLoopTick` in
  `src/core/fleet/recut-loop.ts` appends to `queue/recut-loop.jsonl`
  under the fleet runs directory for every published recut job, plus
  the pre-publication reservations it appends to
  `queue/recut-loop-leases.jsonl` before each publish attempt
  (otherwise only visible through the in-tick dedupe guards — the
  24-hour same-head window, the in-flight scan, the empty-yield streak
  and the caps — and the last-tick outcome kept in module state for the
  health endpoint and the Verse recut-loop model, so a PR the loop
  keeps re-cutting and reservations that never produced their
  published-job row never became work). A PR number becomes an item
  only while its recorded publishes reach the recurring bars of three
  writes across two distinct UTC days inside the 7-day window, each
  cell joined to the minted RQ-PHX-RECUT<pr>L<k> jobs' launches,
  finishes, publishes and resolved outcomes in metrics/jobs.jsonl;
  expired reservations whose (pr, id, headSha) triple never appears as
  a same-tick write become one fleet-level item only while the write
  tail is whole — a truncated write journal could hide the matching
  row — and only once the orphans reach the same recurring bars, a
  withheld jobs ledger degrades the tallies to unknown rather than
  suppressing the journal evidence or zero-filling it, truncated tails
  are stated as lower bounds, and items emit only for the fleet's own
  repository since the loop is hardcoded to this install's
  repository,
  and the judge-trace ledger's recurring adverse ship verdicts, the
  metadata-only JudgeTrace rows `judgeProposal` in
  `src/core/fleet/manager.ts` appends to
  `~/.ashlr/judge-traces/YYYY-MM-DD.jsonl` for every proposal the
  inbox merge path judges before auto-merge, with append-only outcome
  patches materialized by `readJudgeTracesDetailed` — 'rejected' when
  `setStatus` turns the proposal rejected, 'reverted' and
  'followed-up' reserved for the post-merge observation writers,
  'merged' reserved for the proof-bound release writer (otherwise
  only visible through `phm fleet judge-traces` and
  `phm fleet judge-health` — reports someone had to run — plus the
  build-only counterfactual replay nothing schedules, so a judge
  engine whose ship verdicts kept resolving to work that did not
  hold never became work). A judge engine becomes an item only while
  its qualified adverse ship outcomes — rejected before landing, or
  reverted/followed-up after — reach the recurring bars of three
  across two distinct UTC days inside the 7-day window anchored on
  each trace's realized-evidence time; review, noise and harmful
  verdicts tally as validated-caution context only, a qualified
  merged outcome counts as held work rather than adverse, the
  bounded materializing read treats a degraded or incomplete ledger
  as no evidence rather than folding partial rows, unqualified
  outcome labels never guess, and rows emit only for the fleet's own
  repository since every judgeProposal call site is this install's
  merge path,
  and the fleet host disk sample files' recurring freeze-line evidence,
  the {at, free_gb} rows the self-tick appends to
  `queue/host-disk-samples.json` under the fleet runs directory (one
  reading per 5 minutes, 48 hours kept) and the contrib/mac
  disk-growth.py sampler keeps in `queue/disk-growth-history.json`
  (otherwise only visible through `phm host disk`, `phm fleet
  vitals`' disk section, `phm host top`'s disk trend, the hourly
  digest's disk_low blocker and the Ideas disk-trend signal — reports
  and a transient warning someone had to see, so a host whose disk
  kept trending into the lane-freeze line never became work). Each
  judged hour's closing verdict is the same diskBurn/diskLowLine
  computation `phm host disk` runs against the freeze line
  `compact.lanes.raise_freeze_below_gb`; an axis becomes an item only
  while its verdict recurs in at least six distinct judged hour
  buckets spanning two UTC days inside the 7-day window — below the
  freeze line, or falling with under 24 hours of runway — a missing,
  degraded or invalid sample file degrades only its own coverage,
  malformed rows drop like the writer's contract, and rows emit only
  for the fleet's own repository since the samples describe this
  install's host.
  Fleet, nightly, policy, local-gate, pass^k, friction, tick-health,
  cross-review, empty-tag, post-merge, ci-rerun, lost-launch,
  memory-pressure, fleet-controller, skill-outcome, precheck-skip,
  source-yield, gateway-shadow, recheck, stuck-job, lesson-trial,
  work-market, dupcheck, improve-outcome, typed-route, branch-gardener,
  reward, job-control, usage-gap, runtime-journal, generator-yield,
  incident-gate, jev-decisions, worktree-reap, gap-proposal,
  recut-loop, judge-verdicts and disk-pressure items carry priority 3;
  fleet items name the fleet repo label in the prompt, nightly items keep the
  proposal's advisory framing and name the evidence record ids to
  inspect, policy items keep the suggestion's advisory framing and name
  the jobs-ledger evidence references — they emit only for the fleet's
  own repository, since the advice describes this repo's lanes, models
  and tiers — and local-gate items name the gate ledger and keep the
  find-the-gate-or-the-worker-output framing, emitting only for the
  fleet's own repository since the gate is this repo's machinery.
  Pass^k items name the alerts journal and keep the reproduce-with-
  `phm eval passk` framing, emitting only for the fleet's own repository
  since the eval machinery is this repo's. Friction items name the fold's
  sources and keep the find-the-machinery-or-queue-path framing, emitting
  only for the fleet's own repository since the drag is this repo's
  dispatch, queue and lane machinery. Tick-health items name the state
  ledger and keep the inspect-the-phase-deadlines framing, emitting only
  for the fleet's own repository since the daemon is this install's
  machinery. Cross-review items name the review
  journal and keep the find-why-review-keeps-failing framing, emitting
  only when a review row's recorded repository matches the discovery
  target — findings on another repository's pull requests never land on
  this one. Empty-tag items name the tag and jobs ledgers and keep the
  find-the-tag-vocabulary-or-the-sync framing, emitting only for the
  fleet's own repository since the tag machinery is this repo's.
  Post-merge items name the observation and jobs ledgers and the
  eval-report fold, keep the find-why-merges-keep-not-holding framing,
  and emit lane and tier cells only for the fleet's own repository while
  repo cells emit only for the repository the fold recorded. Ci-rerun
  items name the rerun journal and the `phm ci reruns`/`phm ci baseline`
  commands, keep the find-which-side-is-wrong framing for fail verdicts
  and the find-why-the-calls-error framing for call failures, and emit
  only when a journal row's recorded repository matches the discovery
  target. Lost-launch items name the jobs-lost report and the runs-dir
  evidence, keep the find-which-side-owns-the-cause framing — pinned ops
  machinery versus the queue/job lifecycle this repository owns — and
  emit only for the fleet's own repository since the launch machinery is
  this install's. Memory-pressure items name the swapout-rate ledger,
  `phm fleet vitals` and the lane-memory-pressure throttle, keep the
  find-what-is-holding-the-memory framing for recorded pressure and the
  retune-the-unmeasured-guard-constants framing for withheld raises —
  with the same owner-side no-change escape — and emit only for the
  fleet's own repository since the evidence describes this install's
  host and fleet machinery. Disk-pressure items name the two sample
  files, `phm host disk`, the digest's disk_low warning and the
  worktree/reap surfaces, keep the
  find-what-is-consuming-the-disk framing for below-freeze hours and
  the find-the-sustained-burn framing for runway hours — with the same
  owner-side no-change escape — and emit only for the fleet's own
  repository since the samples describe this install's host.
  Fleet-controller items name the controller
  ledger, `phm fleet admission --details` and the pinned
  contrib/mac machinery boundary, keep the find-why-the-controller-keeps-
  doing-this framing per cell — dead readings, mis-tuned or mis-firing
  shed bands, broken hold attribution, a blind merge feed, an
  unmeasured quality cohort — and emit only for the fleet's own
  repository since the ledger describes this install's dispatcher.
  Skill-outcome items name the
  trajectory-learning projection, the skill-use and card ledgers and
  the `phm skills list --outcomes` report, keep the
  association-not-causation framing — shadow selections never steered
  those runs — with the same owner-side no-change escape for a card
  withdrawal, which is a host-signed ledger act, and emit only for the
  fleet's own repository since the learned-skill machinery is this
  repo's. Precheck-skip items name the skip ledger and the
  `phm fleet precheck-repeats`/`phm fleet parked`/`phm fleet queue`
  folds, keep the find-which-producer-keeps-minting-or-resurrecting-
  finished-work framing — pinned contrib/mac precheck machinery
  versus the queue producers and dedup this repository owns — and
  emit only for the fleet's own repository since the ledger records
  this install's dispatch skips and carries no repository column.
  Source-yield items name the yield-by fold, the jobs and
  router-queue ledgers and the `phm jobs yield --by source` /
  `phm jobs producers` reports, keep the association-not-causation
  framing — a bad yield may be misrouting, starvation or host state,
  not a broken producer — with the same owner-side no-change escape,
  and emit only for the fleet's own repository since the producers are
  this install's machinery. Gateway-shadow items name the shadow journal,
  the CONTRACT-M334 exit criteria and the gateway/legacy routing modules,
  keep the find-which-side-is-wrong framing — a missing gateway guard
  versus an over-blocking legacy path — with the same owner-side
  no-change escape when shadow is off or the gateway already flipped,
  and emit only for the fleet's own repository since the shadow covers
  this install's dispatches and carries no repository column. Recheck
  items name the verdict log, the
  `phm fleet recheck-record` verb and the self-tick recheck-record
  step, keep the find-why-the-fleet's-own-verification-keeps-failing
  framing — a degraded evidence path versus a positively identified gap
  this repository owns — and emit only for the fleet's own repository
  since the recheck verifies this install's claimed state. Stuck-job
  items name the two reaper ledgers, `phm jobs stuck` and the pinned
  contrib/mac machinery boundary, keep the find-which-side-owns-the-cause
  framing per class — the launch→reap handoff dropping finish evidence
  versus jobs hanging past the stuck bar — with the same owner-side
  no-change escape, and emit only for the fleet's own repository since
  the reaper is this install's machinery. Lesson-trial
  items name the holdout trial, the `phm improve lessons` report and the
  cloud task store, keep the find-why-served-runs-land-worse framing —
  scope matching or injection assembly in learn/retro/inject.ts, the
  retro suggestion pipeline, or a biased arm assignment or landing fold —
  with the same owner-side no-change escape, since approving, editing or
  rejecting a lesson note is a Verse act only the owner takes, and emit
  only for the fleet's own repository since the trial covers this
  install's cloud runs. Work-market items name the market journal,
  `phm fleet unfed` and the pinned contrib/mac machinery boundary, keep
  the find-why-capacity-keeps-going-unused-or-jobs-keep-failing-
  requirements framing per cell — stale lane advertisements versus
  drifting queue specs and hint vocabulary, mechanical rejection codes
  excluded — with the same owner-side no-change escape, and emit only
  for the fleet's own repository since the journal describes this
  install's dispatcher and carries no repository column. Dupcheck items
  name the dupcheck ledger, `phm queue dupcheck --stats` and the gate
  module src/core/queue/dupcheck.ts, keep the
  find-which-side-owns-the-miss framing per cell — gate recall versus
  producers minting already-done work — with the same owner-side
  no-change escape, and emit only for the fleet's own repository since
  the gate is this repo's machinery and the ledger carries no
  repository column. Improve-outcome items name the outcome ledger,
  the `phm improve outcomes` report and the measure/promote/observe
  verbs, keep the find-which-pipeline-stage-is-failing framing per
  signal — an unscheduled measurement stage, a broken metric-runner
  contract, intake shipping work that fails its own declared metric,
  or championed changes that do not hold — and emit only for the
  fleet's own repository since the verbs and scheduler sync are this
  repo's machinery. Branch-gardener items name the audit journal, the
  gardener script and its docs, keep the per-bucket framing — triage
  the persistently flagged branches, find why the atomic deletes keep
  failing, find which evidence source keeps the audits erroring — with
  the same owner-side no-change escape, and emit only when a journal
  row's recorded repository matches the discovery target, since each
  audited remote owns its own branch namespace. Generator-yield items
  name the generation journal, `phm queue yield` and the
  queue-autofill refusal checks, keep the
  which-side-owns-the-refusals framing per cell — candidate sources
  minting work the fleet already refuses versus refusal checks or
  capability/stop-verdict vocabulary drift — with the same owner-side
  no-change escape, and emit only for the fleet's own repository
  since the journal describes this install's queue intake and carries
  no repository column. Incident-gate items name the decision ledger,
  the `ashlr fleet incident-gate` verb and the mining sources, keep
  the find-why-the-class-keeps-recurring-or-the-tightening-keeps-
  failing framing per bucket — an unfixed lane, credential, quota,
  test or merge cause versus a broken apply path (slots.json or
  runs-dir writability, the repo-hold store, the KILL switch) — with
  the same owner-side no-change escape, and emit lane-error cells only
  for the fleet's own repository while repo-scoped cells match the
  discovery target's owner/repo exactly. Jev items name the decision
  ledger, `phm jev status`, and the decide registry, ledger and call
  sites, keep the which-side-is-losing framing per kind — miscalibrated
  thresholds or drifting question maps and interpret functions versus
  a degraded TypeSafe provider path versus owner-side key, quota or
  budget state — with the same owner-side no-change escape for a kind
  that legitimately falls back by design, and emit only for the fleet's
  own repository since the ledger is this install's decision record and
  carries no repository column. Worktree-reap items name the reap
  journal, `phm worktrees --reap --status` and the pinned contrib/mac
  machinery boundary, keep the find-why-removals-keep-failing-or-
  worktrees-keep-stranding framing per kind — a broken removal path,
  unsafe paths the minting side should never produce, unpushed commits
  the publish path dropped, or dirty worktrees the finish path left —
  with the same owner-side no-change escape, and emit only for the
  fleet's own repository since the reap is this install's machinery.
  Gap-proposal items name the proposal
  journal, `phm jobs gaps`, the `phm jobs yield`/`phm jobs empty`
  folds and the gap extraction and dedupe sources, keep the
  find-why-this-gap-keeps-coming-back-unsatisfied framing per gap id —
  gap extraction minting work master already has versus failed or
  aborted attempts versus launches that never happened versus a dedupe
  leg that cannot see the landing — with the same owner-side
  no-change escape for legitimate re-discovery of a recurring gap, and
  emit only for the fleet's own repository since the proposer and its
  dedupe are this install's machinery. Judge items name the
  judge-trace ledger, `phm fleet judge-traces`,
  `phm fleet judge-health` and the judgeProposal call site in
  src/core/fleet/manager.ts, keep the find-which-side-is-wrong
  framing — a miscalibrated verdict, rubric or engine-resolution
  drift versus rejections that trace to pipeline gates orthogonal to
  judge quality — with the same owner-side no-change escape for a
  retired engine, a rolled-forward window or healthy judge-health
  evidence, and emit only for the fleet's own repository since the
  ledger records this install's merge-path verdicts and carries no
  repository column. They
  launch only for the repository self-improvement is pointed at.
- **Claims.** An item is claimed by its newest task. It becomes available
  again 3 days after that task ends `closed`, `failed` or `expired`, and never
  after it ends `merged` or its session reported `no-change` (the work was
  already done).
- **Order.** The next item is the highest priority (1 first). Within a
  priority, areas whose measured outcomes improved their metric go first
  (higher measured leverage first), unmeasured areas next, and areas with a
  measured zero or negative record last (`phm improve outcomes` shows the
  ledger); then built-in order.

There are two ways to launch backlog items:

- **Improve Phantom** (the button on Command, `ashlr cloud improve`, or
  `POST /api/verse/cloud/improve`) launches up to `count` items now: one by
  default, five at most. It checks only the launch gate, because you asked.
- **The scheduler** runs inside the Phantom server. It starts when the cloud
  module first loads, never under a test runner. Every 10 minutes it refreshes
  task states from GitHub. Two minutes after start, and then every 60 minutes,
  it launches the next backlog item. Before each launch pick it also registers
  every unclosed backlog PR whose item declares a metric into the outcome
  ledger — the same records `phm improve sync-backlog` writes by hand — so
  measured outcomes keep feeding the order above. Scheduled launches need
  self-improvement switched on **and** the self-improvement gate open. So with
  the defaults Phantom starts at most 4 sessions a day on its own, and stops
  when the estimate reaches the $40 reserve. The two jobs never overlap
  themselves, and each distinct error is logged once.

---

## Using it

**In Phantom.**

- **Command** has a Cloud card beside the burn-downs. It shows estimated
  credits remaining as a meter ("$X of $250 · estimate") with a link to
  claude.ai usage, and sessions today. Each task has a state chip, **Open in
  Claude** for the session and a link to its PR. The card also has **New cloud
  task**, **Improve Phantom**, the self-improvement switch with its daily cap,
  and **Edit budget**.
- In **Chat**, the composer's ⋯ sheet has **Run in cloud**. It sends the typed
  prompt as a cloud task for the chat's project. It is available only when the
  project has a GitHub origin and the seat is ready. Otherwise it is disabled,
  and its tooltip says why.
- **Needs you** lists "Cloud task ready for review" for each task with an open
  PR, with its title, PR link, gate verdict and report summary, and the triage
  actions below. It also lists launches that failed in the last 24 hours, with
  the reason.
- **Fleet** shows a "Cloud · N running" chip in its lanes row.
- **Settings ▸ Usage** has a Cloud credits panel with the same budget fields.

**From the CLI.**

```sh
ashlr cloud launch "Fix the flaky retry test" --repo ashlrai/ashlr-hub --base master
ashlr cloud list [--all] [--json]
ashlr cloud refresh                        # ask GitHub for PRs now
ashlr cloud improve [--count N]            # launch backlog items now
ashlr cloud budget --total 250 --spent 12 --per-session 3 --max-per-day 20 \
                   --self-improve on --self-improve-max 4 --self-improve-max-open 3 --reserve 40
ashlr cloud backlog
ashlr cloud stats [--days N] [--json]      # how tasks ended, and the merged rate
```

`launch` defaults `--repo` to the current directory's GitHub origin.

`stats` counts every task by how it ended (merged, closed, failed with its
launch failure code, expired) and what is still in flight. Its merged rate is
merged PRs over finished PRs that carried a change: a PR closed after the
session reported no change was needed is a correct verdict, so it is counted
under closed but left out of the rate.

### Triage in Needs you

Every few minutes Phantom reads each open cloud PR from GitHub and checks the
diff, pinned to its head commit, with the merge gates' own functions:
protected paths (G1), test tampering (G1b), risk and size against your grant's
caps, or the compiled ceilings when no grant covers the repo (G2), and the
session's report against its diff (G4). GitHub supplies conflicts, how far
the branch is behind its base, and its checks. A PR where every check passes
is **Clean**; otherwise it is **Held**, with the first reason on the row.
Verification off the current base, the judge and authority are not part of
the preview. They run only in the standing merge pass.

| Key | Action | What it does |
|---|---|---|
| A | **Land** | Marks the draft ready and squash-merges exactly the commit that was checked. Refused if the diff touches a protected path, conflicts, or the branch moved. |
| R | **Close** | Closes the PR on GitHub with a short comment. The branch is kept. |
| — | **Update branch** | Shown when the branch is behind. GitHub merges the base into it, and checks run again. |
| E | **Dismiss** | Stops tracking the task in Phantom. GitHub is not touched. |

X or Shift-click picks rows, and A / R / E then act on every pick after one
confirmation. **Land all clean** lands every Clean PR the same way. Each
action carries the head commit it was checked on, so a push in between is
refused, not landed. Every action asks for the mutation token.

The same actions are routes: `POST /api/verse/cloud/tasks/<id>/land`,
`/close` and `/update-branch`, each with `{"headSha": "<40 hex>"}` (Close
also takes an optional `reason`, up to 200 characters, recorded as "Closed in
Phantom: <reason>" and included in the GitHub comment), and
`GET /api/verse/cloud/previews` for the verdicts.

### Intake into the standing gates (3.13)

When a standing grant is in force, every standing tick (after the fleet
mirrors are made current, before the merge pass) runs the cloud intake
(`src/core/fleet/cloud-intake.ts`). It looks at tasks that are `pr-open` with a
pinned delivery and, for each, decides:

1. **Eligible?** The repo must be in the grant and have a current fleet
   mirror whose default branch is the task's base branch. Otherwise the task
   is left for Needs you (the reason is reported, not audited every tick).
2. **Same identity?** Read from GitHub now: the pinned PR number and URL, head
   ref exactly `ashlr-cloud/<taskId>` in the same repository, base ref still
   the task's base. A retargeted PR (`base-moved`), a foreign head
   (`head-ref-mismatch`), a changed PR (`pr-identity-changed`) or a fork
   (`cross-repository`) is refused.
3. **The diff, pinned.** The head SHA is read, the diff is downloaded for
   exactly `<merge base>...<head SHA>`, and the head is read again. A push
   during the download means "next tick", never a mixed diff. An empty diff,
   one over the absolute grant ceilings (10 files, 300 lines, 256 KiB), or one
   the proposal store would rewrite (secret-like or long-hex content) is
   refused and remembered for that head.
4. **A pending proposal** is filed in the repo's fleet mirror: origin `agent`,
   kind `pr`, producer `claude:cloud`, the backlog item as its work item. Its
   summary is the session's report, marked UNVERIFIED. For a `blocked` or
   `no-change` report only the status is kept, so a diff under it is the
   "silent change" G4 refuses. The host signs its provenance over the diff
   hash. That vouches for identity only (see
   [AUTHORITY.md](AUTHORITY.md#5-what-is-protected-and-how-the-list-stays-honest)).
5. **The standing pass does the rest**, unchanged: G0 to G6, where G6 needs a
   codex or Grok judge because the producer is Claude; the verified-tree App
   PR; G7 with the App's `ashlr/verify`; the SHA-pinned merge; the post-merge
   watch and auto-revert; and KILL. G1 still sends a diff touching an
   ashlr-Phantom protected path to the owner lane. When the rollout stage does
   not allow merging, the pass's would-merge record is the dry run.

One proposal is filed per task and head SHA (the task's `intake` memo). A new
push supersedes the old pending proposal. A proposal already carried by an
App PR is never touched.

**Superseded.** On the next tick after the pass opens the App PR for exactly
the diff that was filed, the intake comments "Superseded by #N" on the cloud
PR, closes it, and records `supersededBy` on the task. From then on the
tracker follows the App PR: open stays `pr-open`, merged makes the task
`merged` (so its backlog item is done for good), and closed makes it
`closed`. Needs you no longer offers actions on a superseded PR.

KILL stops the intake before it reads anything. It never runs outside a
standing tick and never merges.

**Over HTTP** (the Phantom server). `GET /api/verse/cloud` needs the read session.
POST routes need the mutation token, a JSON content type and a bounded body:

| Route | What it does |
|---|---|
| `GET /api/verse/cloud` | Overview: seat status, budget view, the newest 100 tasks and the backlog. Refreshes nothing, so it is cheap. |
| `POST /api/verse/cloud/launch` | Launch one task (`repo`, `prompt`, optional `baseBranch` and `title`). |
| `POST /api/verse/cloud/budget` | Change any subset of the budget. |
| `POST /api/verse/cloud/refresh` | Refresh task states from GitHub. |
| `POST /api/verse/cloud/improve` | Launch up to `count` backlog items. |
| `POST /api/verse/cloud/tasks/<id>/dismiss` | Mark a task `closed` ("Dismissed in Phantom."). Does not touch GitHub. |

Responses carry no absolute paths and no secrets.

---

## The Devin lane (3.15)

Devin is the second lane with this shape. Its setup, budget and limits are in
[DEVIN.md](DEVIN.md); this is how it compares.

| | Cloud lane | Devin lane |
|---|---|---|
| Runs on | Claude Code cloud sessions, your Claude credits | Devin sessions, your Devin ACUs |
| Started from | Command's Cloud card, Run in cloud, `ashlr cloud launch`, self-improvement | Run in Devin, `ashlr devin launch`, a Devin (cloud) chat |
| Started by Phantom on its own | Yes, self-improvement under a daily cap | Only under a grant that names Devin, with `ashlr devin fleet on`: the fleet launcher (default 1 at a time, 3 a day), the Leader's `devin.launch`, and automations on the `devin` lane |
| Branch and report | `ashlr-cloud/<taskId>`, `ashlr-cloud-report` | `ashlr-devin/<taskId>`, `ashlr-devin-report` |
| Budget | Dollars, estimated per session | ACUs from Devin, with a per-session hard cap; dollars are an estimate |
| Needs you | Clean/Held verdict, Land, Close, Update branch, Land all clean, Evidence | The same |
| Standing gates | G0–G7; the judge must not be Claude-family | G0–G7; two judges from two different families, neither `devin` |
| May merge under a grant | Yes, from the fleet App's PR, when the ladder stage merges | Only when the live stage names `devin` and the two-judge rule holds; otherwise a would-merge is recorded as shadow and the PR waits for you |

**Triage.** A Devin task with an open PR appears in Needs you as "Devin task
ready for review", with its report marked unverified. The actions are the same
head-pinned routes as the cloud lane's, under `/api/verse/devin/tasks/<id>/`
(`land`, `close`, `update-branch`, `dismiss`, and `message` to reply to a
waiting session), `GET /api/verse/devin/tasks/<id>/timeline` for Evidence, and
`GET /api/verse/devin/previews` for the verdicts. Close, on both lanes, takes
an optional one-line reason (up to 200 characters) that the task records as
"Closed in Phantom: <reason>" and the GitHub close comment includes. PRs that a
Devin (CLI) chat opened are listed with Dismiss only
(`POST /api/verse/devin/cli-prs/<chat>/<n>/dismiss`).

**Intake.** `src/core/fleet/cloud-intake.ts` takes a *source*, so cloud and
Devin PRs go through one intake. For Devin the head must be exactly
`ashlr-devin/<taskId>`, the producer is `devin:<mode>`, and it runs only when
the Devin lane is on. Everything else in [Intake into the standing
gates](#intake-into-the-standing-gates-313) applies, except G6 and the
merge: G6 needs ships from judges of two different families, and the standing
pass merges only when the live stage names `devin` and the recorded judges
still satisfy that rule. The legacy merge pass never merges Devin work.

---

## Failure codes

A failed launch records one of these codes and a plain sentence.

| Code | What happened | What to do |
|---|---|---|
| `seat-unavailable` | The `claude-a` launcher is missing or is not a native profile. | Prepare the seat (`ashlr resources profile prepare --provider claude`) and sign it in. |
| `auth` | The CLI said cloud sessions need a claude.ai account ("requires authentication with a Claude.ai account"). | Sign the `claude-a` seat in with its claude.ai login, not an API key. |
| `not-enabled` | Cloud sessions are not enabled for the account. | Enable them on claude.ai; Phantom cannot. |
| `rate-limited` | The provider refused: rate limit, usage limit or out of credits. | Check the balance on claude.ai and correct the budget. |
| `no-remote` | No GitHub origin, not a git repository, or the branch is not pushed. | Push the base branch; check the repo name. |
| `checkout-failed` | Phantom could not prepare its checkout. | Check your git credentials for that repository. |
| `budget` | A budget gate refused before anything launched. | Read the gate's sentence; raise the limit or wait for tomorrow. |
| `timeout` | No session appeared within 90 seconds. | Retry; if it repeats, run `claude --cloud` by hand from the checkout to see why. |
| `unparsed` | The CLI exited without printing a recognisable session. | Same as `timeout`. |
| `unknown` | Anything else. | The recorded sentence carries what the CLI said. |

---

## Where things are stored

Everything lives under `~/.ashlr/cloud/` (the same Ashlr home the rest of the
Phantom uses). Directories are `0700` and files `0600`. Files are written
atomically and opened without following symlinks.

```text
~/.ashlr/cloud/
├── tasks/<id>.json     # one file per task
├── budget.json         # your budget settings
├── backlog.json        # operator and Leader backlog items
└── checkouts/<owner>__<name>/   # the shallow launch checkouts
```

---

## Turning it off

- **Stop Phantom launching on its own.** Switch self-improvement off: the toggle
  on the Cloud card, **Settings ▸ Usage**, or
  `ashlr cloud budget --self-improve off`. Tracking continues; nothing launches
  unless you ask.
- **Stop the scheduler entirely.** Start the Phantom server with
  `ASHLR_CLOUD_AUTO=0` in its environment. Neither the 10-minute refresh nor
  the hourly self-improvement runs. Manual launches and **Refresh** still work.
- **Nothing launches without the seat.** With no `claude-a` native profile the
  lane refuses every launch with `seat-unavailable`.

Existing sessions keep running on claude.ai whatever you do here. Stop them
there, and close their PRs on GitHub.

---

## Limits

- Spend is an estimate. Only claude.ai knows the balance.
- Phantom cannot read a session back, so it knows what a task did only from its
  PR and report block. A session that ignores the contract shows as `running`
  and then `expired`. Its link still works.
- The lane launches only through the `claude-a` seat. Other seats cannot start
  cloud sessions.
- Nothing in the lane merges on its own. A cloud PR lands only when you click
  Land in Needs you, or, under a standing grant, through the standing gates
  from the fleet App PR that superseded it. Cloud diffs over the absolute
  grant ceilings are never taken in; they stay in Needs you.
