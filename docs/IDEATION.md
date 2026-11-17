# Standing ideation loop

The daily loop asks a frontier worker: **what is the most ambitious thing this
system could become in 30 days?** It seeks new surfaces, resource classes,
self-improvement loops and cross-repository platforms with measurable milestones.
The existing dispatcher executes the session under normal capacity, admission and
review policy. This command does not invoke a model directly.

## Configure and schedule

Create a local JSON config with absolute paths (no credentials):

```json
{
  "repoRoot": "/path/to/phantom",
  "reposRoot": "/path/to/repos",
  "queue": "/path/to/router-queue.md",
  "state": "/path/to/private/ideation",
  "jobs": "/path/to/metrics/jobs.jsonl",
  "vitals": "/path/to/vitals.json",
  "resources": "/path/to/resources-ledger.json",
  "research": "/path/to/phantom/docs/research",
  "org": "ashlrai"
}
```

The queue must already exist. Keep `state` outside version control. Refresh vitals
with `phm fleet status --json` and resources with `phm resources ledger --json` in
the host's existing observation cadence; these are snapshots, not fresh probes.
Optional `amplify` names a local AMPLIFY-LOOP evidence file. There is no AMPLIFY
implementation in this checkout; the prompt reuses its measure/amplify/remeasure
stance and explicitly reports absent evidence.

```sh
phm fleet ideation tick --config /path/to/ideation.json --json
phm fleet ideation tick --config /path/to/ideation.json --apply --json
phm fleet ideation schedule --config /path/to/ideation.json --json
```

`schedule` renders a launchd job (or systemd user timer) for 03:23 local time.
It neither installs nor activates it. Use the normal host deployment/pin process
to activate the generated unit against a built CLI, and create its log directory.
Session IDs use UTC dates, so repeated or concurrent ticks cannot mint extra sessions.
Scheduling requests `tier=frontier`, `min_tier=frontier`, `max_cost_class=included`.
If no eligible included-capacity frontier worker exists, normal routing holds it.

## Evidence and completion

Each private request contains vitals, resource snapshots, jobs-ledger outcomes,
open issues discovered through paginated read-only `gh api` calls across all
visible org repos, ten research Markdown files, optional AMPLIFY evidence, and
the queue. GitHub reads use existing local authentication without reading tokens.
The collector supports up to 100 repos, bounds each call to 15 seconds/1 MiB and
the collection to roughly 60 seconds. It reports failures as unknown; it counts
all returned open issues and samples three titles per repo. Private titles and PRs
are withheld. File snapshots are bounded; prompt excerpts are capped at 24,000
characters each. No missing, clipped or failed evidence establishes absence.

The frontier worker follows the request's JSON schema, writes its result locally,
then runs the exact `complete --config ... --day ... --file ... --apply --json`
command embedded in its queue entry. `complete` without `--apply` previews IDs and
archive reasons. Stable proposal IDs start with `RQ-IDEA-`; do not date them to
evade deduplication. No session commits, pushes, publishes, sends or changes gates.

Completion reuses [research-digest](RESEARCH-LOOP.md) scoring, scope/ID deduplication
and admission lint. Candidates need research score >= 2; leverage × vision fit
orders them, with stable ID tie-breaking. At most three enter READY. The full
result and archive reasons remain in private state; the strategy is written to
`docs/strategy/IDEATION-YYYY-MM-DD.md`. This local artifact grants no publication
authority. Sensitive operations are archived, and secret-shaped output is refused.
All generated jobs carry `max_cost_class=included` and remain advisory until the
normal queue/review path accepts them. No new spending or credential access exists.

Research and ideation share an exclusive `.research-digest.lock`, re-read and
re-plan inside it, then atomically replace the queue. Other host writers must
coordinate on that lock. Missing/unreadable queues fail closed. A crashed lock is
never stolen; host recovery must establish the writer is gone before removing it.
Prepared requests/results survive queue-write failure; replay the same command
and output. Replays cannot expand the originally selected set. KILL blocks writes.

## Learning from outcomes

Each selected ID is attributed to its originating session before queue append.
The next prompt folds these IDs through the existing eval-report ledger parser:
merged counts once, explicit closed/dead/cancelled outcomes count as died, and
missing observations or failed attempts remain unresolved. Win rate is
`merged / (merged + died)`, null without resolved evidence. Prepared but not yet
queued proposals stay unresolved. Thirty-day eval-report durability aggregates
accompany this metric; merging alone never proves stability or product value.

Hermetic coverage: `npm run test:ci -- test/ideation.test.ts test/research-proposals.test.ts test/fleet-research-digest.test.ts`.
