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
DONE-NOOP, CANCELLED). The fold reads the fleet jobs-ledger dialect the
sibling outcome readers share — job ids `job|job_id|jobId|id`, lanes
`lane|pool|arm`, events `event|type|kind` (`published` folds to `publish`),
terminal phases `phase|state|outcome|status|result|conclusion`, and
`merged`/`closed`/`revert`/`reverted` event names when no phase field
resolves. A merged, non-reverted job that needed a retry, a
recut, or recovered a failure class seen on three earlier failed jobs seeds
one bounded draft card.

These cards are `candidate`/`imported` shadow records: they persist to the
same card ledger, are deduplicated by content hash across ticks, and stay out
of verified selection until a human or a verified pathway promotes them.
Unresolved outcomes, degraded corpora and unreadable ledgers produce no
cards — unknown stays unknown.

## See what was learned

```bash
phm skills list --json
phm skills list --status verified --limit 10
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

## Exit codes

`0` listed (including an empty list), `2` bad usage (unknown flag, bad
`--status`, `--limit` outside 1-200). With `--json`, usage errors are JSON too.
