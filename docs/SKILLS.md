# Learned skills

When a PR merges and its verification stays green through the post-merge
observation window, Phantom writes one reusable skill card from the outcome
(`learnFromApplied` in `src/core/fleet/skill-library.ts`). Cards are
metadata-only: task kind, command kinds and a short summary. They never hold
diffs, prompts, process output or secret values, and every text field is
scrubbed and capped at 240 characters. One proposal yields at most one card,
and later revisions of the same skill replace earlier ones in the list.

## See what was learned

```bash
phm skills list --json
phm skills list --status verified --limit 10
```

One obvious path: `list` is read-only and needs no setup. It prints the newest
revision of each skill, newest first.

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
