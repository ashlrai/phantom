# Fleet pr-hygiene — open-PR triage audit

`ashlr fleet pr-hygiene [--repo <owner/name>] [--stale-days <n>] [--limit <n>] [--json]`
audits every open pull request on one repo and emits a `fleet.pr-hygiene.v1`
triage report for the merge cockpit. It is read-only: the only GitHub calls
are `gh pr list` for open and merged PRs — it never closes, updates or merges
a PR and never reads a PR body.

Each PR is flagged and then triaged into one advisory lane:

| Lane | Meaning | Flag precedence |
| --- | --- | --- |
| `close-candidate` | A merged fleet job's prompt named this PR (`PR #n`) — superseded work a host-side closer may reap | `superseded` |
| `refix` | GitHub reports a merge conflict (`mergeable: CONFLICTING` or `mergeStateStatus: DIRTY`) | `conflicted` |
| `review` | Idle at least `--stale-days` days (`stale`), or shares files with other open PRs (`overlap`) — a conflict waiting to land | `stale`, then `overlap` |
| `ok` | No hygiene signal | — |

Informational flags that never escalate a PR on their own: `behind`
(`mergeStateStatus: BEHIND`) and `draft`.

## Usage

```sh
phm fleet pr-hygiene --json              # audit ashlrai/phantom, machine-readable
phm fleet pr-hygiene --stale-days 14     # human summary, older stale threshold
phm fleet pr-hygiene --repo org/repo     # audit another enrolled repo
```

Defaults: `--repo ashlrai/phantom`, `--stale-days 7`, `--limit 500` (max 5000).
Exit codes: 0 audit produced (findings are data, not a verdict), 1 the open-PR
list could not be read, 2 bad usage.

## Report shape (`fleet.pr-hygiene.v1`)

    { schema: 'fleet.pr-hygiene.v1', v: 1, repo, generatedAt, staleDays, limit,
      complete,                       // false when the open page filled the limit
      reads: { open: 'ok' | 'failed',
               merged: 'ok' | 'failed' | 'skipped',
               prompts: 'ok' | 'unavailable' },
      counts: { open, unreadable, flagged,
                triage: { 'close-candidate', refix, review, ok },
                flags:  { superseded, conflicted, stale, overlap, behind, draft } },
      items: [{ number, title, url, headRef, isDraft, mergeStateStatus,
                createdAt, updatedAt, ageDays, idleDays, flags, triage, reason,
                supersededBy?: { number, title, jobId },
                overlap?: { count, prs } }],
      error?: string }                // fixed token when reads.open is 'failed'

`items` covers every audited PR, flagged lanes first, then oldest-idle first.
`reason` is one machine token: `superseded-by-merged-pr`, `merge-conflict`,
`stale-no-update`, `file-overlap` or `ok`.

## Evidence honesty

- A failed open read still emits the versioned shape (exit 1) with
  `reads.open: 'failed'`, empty `items` and an `error` token — never a
  fake-clean backlog. gh's stderr is not echoed.
- The superseded leg degrades alone: a failed merged-PR read
  (`reads.merged: 'failed'`) or a missing local prompts directory
  (`reads.prompts: 'unavailable'`) skips supersession matching; the other
  flags are still computed. Supersession is never inferred from titles —
  it needs the same prompt evidence `ashlr fleet superseded` uses.
- Timestamps GitHub did not send parseably leave `ageDays`/`idleDays` null;
  a PR with unknown activity is not flagged `stale`.
- Rows gh could not describe are counted in `counts.unreadable`, not dropped.

The report grants no close, merge or dispatch authority; consumers re-verify
before acting.
