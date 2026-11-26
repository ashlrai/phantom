# Learned skills

When a PR merges and its verification stays green through the post-merge
observation window, Phantom writes one reusable skill card from the outcome
(`learnFromApplied` in `src/core/fleet/skill-library.ts`). Cards are
metadata-only: task kind, command kinds and a short summary. They never hold
diffs, prompts, process output or secret values, and every text field is
scrubbed and capped at 240 characters. One proposal yields at most one card,
and later revisions of the same skill replace earlier ones in the list.

## Shadow recovery candidates

On the same self-improvement cadence as the reward-signal sync, the resident
daemon's `skill-nudge` off-tick job folds the tail of the fleet jobs ledger
(`<runs>/metrics/jobs.jsonl`) into candidate skill cards
(`syncSkillNudgesFromJobsLedger` in `src/core/fleet/skill-nudge.ts`). The fold
uses only recorded evidence: launch and batch-claim attempts, bounded
launch-failure receipts, finish-row failure classifications, recut-admission
decisions, revert evidence, and terminal outcome phases (MERGED, CLOSED,
DONE-NOOP, CANCELLED). Batch members contribute their own job evidence.
Batch session wrappers and node-pool attempt telemetry are excluded from
recovery evidence. The fold reads the fleet jobs-ledger dialect the
sibling outcome readers share — job ids `job|job_id|jobId|id`, lanes
`lane|pool|arm`, events `event|type|kind` (`published` folds to `publish`),
terminal phases `phase|state|outcome|status|result|conclusion`, and
`merged`/`closed`/`revert`/`reverted` event names when no phase field
resolves. Other event names leave the standing terminal verdict and its
evidence intact unless the row carries a recognized terminal phase.
Reverted covers the ledger's own revert spellings plus the
standing revert set the daemon supplies (`revertedPrKeys` — outcome-ledger,
cloud-task and `phm fleet reverts --record` detections): a merged job whose
standing verdict row identifies a PR claimed by exactly that job and whose
lowercase `owner/repo#n` key stands in the set counts as reverted, the same
unambiguous-claim rule the outcome learners apply. Repository case and a
trailing slash do not distinguish claims on the same PR, so a merge git history
proved did not hold never seeds a "recovery" draft. A merged,
non-reverted job that needed a retry, a
recut, or recovered a failure class seen on three earlier failed jobs seeds
one bounded draft card.
For recurrence, Phantom orders jobs by their latest terminal outcome row in
the retained ledger. Later bookkeeping rows do not change that order.
For each resolved job, the learner uses the lane, retries, recuts and
failure class recorded through that terminal row in ledger order.
Subsequent execution evidence becomes eligible when a newer terminal row
resolves the job.
A recut requires a `ready` recut admission followed by a dispatch attempt
for the same job before its terminal outcome. Repeated readiness checks
count once per dispatch. A later defer or skip clears pending readiness.
The learner uses the first identifier-safe classification on a row, skipping
case-insensitive `unknown` values. A row with no usable classification leaves
the last observed class intact. Without any observed class, a merge can seed
a generic draft through a recorded retry or recut.
Recovery drafts require an observed lane. A terminal row can supply that
lane even when it has no event name. The learner takes the first usable
`lane`, `pool` or `arm` value on an eligible row, skipping case-insensitive
`unknown` values. Queue-arrival rows (`enqueue`, `enqueued`, `queued`)
leave the last observed lane intact. Jobs without an observed lane supply
neither recurrence evidence nor recovery drafts.

These cards are `candidate`/`imported` shadow records: they persist to the
same card ledger, are deduplicated by content hash across ticks, and stay out
of verified selection until a human or a verified pathway promotes them.
Unresolved outcomes, degraded corpora and unreadable ledgers produce no
cards — unknown stays unknown.

## See what was learned

```bash
phm skills list --json
phm skills list --status verified --limit 10
phm skills list --outcomes --json
```

One obvious path: `list` is read-only and needs no setup. It prints the newest
revision of each skill, newest first.

To see every skill fleet agents have (Claude Code and Codex user skills plus
these learned cards), run `phm skills list --all --json`. The desktop Skills
pane shows the same list. A source that cannot be read says `unknown`.

```json
{
  "schemaVersion": 1,
  "matched": 1,
  "returned": 1,
  "total": 1,
  "corpus": "healthy",
  "invalidRows": 0,
  "skills": [
    {
      "skillId": "skill.proposal.p-123",
      "revision": 1,
      "name": "Verified bug-fix workflow",
      "summary": "Evidence-bound bug-fix workflow verified with test, typecheck commands at low risk.",
      "status": "verified",
      "source": "verified-proposal",
      "updatedAt": "2026-11-02T08:00:00.000Z",
      "taskKinds": ["bug-fix"],
      "commandKinds": ["test", "typecheck"],
      "verificationPassed": true,
      "evidenceCount": 6,
      "proposalId": "p-123",
      "attestationPresent": true
    }
  ]
}
```

Fields Phantom could not measure read `"unknown"`, never a guess. `matched` is
the count after `--status`, `returned` is after `--limit` (default 50, max
200), `total` is every distinct skill. `attestationPresent` only says a
signature field exists; selection for future runs still verifies it.

An empty corpus is normal on a fresh install: the plain-text output says
"No skills yet", and `--json` returns `"total": 0`.

## Did a skill help?

Shadow skill selections are observe-only, but their outcomes are recorded:
`phm fleet status --json` exposes `trajectoryLearning.skillOutcomes`, which
attributes each trajectory's resolved terminal outcome (and deterministic
post-merge realized outcome) back to the skill revisions selected on it.
Per-skill rows count distinct trajectories per skill revision with sparse
outcome tallies — for example how many selections ended `merged`, `rejected`
or `failed`, and how many merged selections were later `reverted` or
`regressed`. Lifecycle stages of one use collapse into a single selection,
and unjoined or conflicting skill rows never enter the tally.

`phm skills list --outcomes` joins the same projection onto the learned-skill
list: each entry gains an `outcomes` object when its exact revision was
observed on joined trajectories, and the report carries `outcomeState`
(`"observed"` or `"withheld"`) so a missing tally is never mistaken for a
zero. Plain-text output prints the tallies under each skill.

The projection is sample-gated exactly like `skillObservation`: per-skill
counts publish only after at least `MIN_SKILL_OBSERVED_TRAJECTORIES` (3)
production trajectories carry skill-use coverage, and the whole section is
withheld when the skill-use ledger is degraded. Below the gate the field is
absent — unknown stays unknown, never a zero.

Recurring adverse tallies do not stay report-only:
`phm improve discover` reads the same projection and queues a priority-3
backlog item for the fleet repository when one live card revision records
at least three reverted + regressed + followed-up realized outcomes inside
the 7-day window. The trajectory join and skill-use diagnostics allow up to
eight daily ledger partitions for that window, including both UTC date
boundaries. Existing record and byte limits still apply. Only the corpus's newest revision in a `candidate` or
`verified` status qualifies — superseded and withdrawn cards were already
handled — and the items keep the association-not-causation framing since
shadow selections never steered those runs. Withdrawing or rewriting a card
itself remains an owner-only act on the host-signed ledger.

## Exit codes

`0` listed (including an empty list), `2` bad usage (unknown flag, bad
`--status`, `--limit` outside 1-200). With `--json`, usage errors are JSON too.
