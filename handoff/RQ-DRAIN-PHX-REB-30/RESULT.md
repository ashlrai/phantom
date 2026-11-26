# RQ-DRAIN-PHX-REB-30 result

Verified 2026-11-26 03:32 UTC (2026-11-25 22:32 ET).

All six requested PRs were already CLOSED and unmerged when inspected in the requested order. Every observed head matches the supplied SHA prefix. Step 1 therefore requires skipping all six. No PR or branch was changed.

The requested action vocabulary has no skipped value. In this table, `blocked` means SKIPPED_ALREADY_CLOSED, not a failing check or an unfinished repair. No new head was created. Prior comments describe stale closures and do not name replacements; this job does not claim supersession or merged implementation.

| PR | Action | New head SHA | Observed head SHA (unchanged) | Check status | Replacement URL |
| --- | --- | --- | --- | --- | --- |
| [#5981](https://github.com/ashlrai/phantom/pull/5981) | blocked | none | `9e734392edb21857ac913184414b2ac4230a360b` | NOT RUN: already closed; step 1 skip | Not established |
| [#5967](https://github.com/ashlrai/phantom/pull/5967) | blocked | none | `a4792cb9ebedfd9941ed005b52387e69c053cd06` | NOT RUN: already closed; step 1 skip | Not established |
| [#5941](https://github.com/ashlrai/phantom/pull/5941) | blocked | none | `264f165ebaee4adbfbc4f5ad3ce8fff6ea68a5b9` | NOT RUN: already closed; step 1 skip | Not established |
| [#5931](https://github.com/ashlrai/phantom/pull/5931) | blocked | none | `9de368288e61aeb28fea3b258f58b8d9e5f433a4` | NOT RUN: already closed; step 1 skip | Not established |
| [#5906](https://github.com/ashlrai/phantom/pull/5906) | blocked | none | `ccf9a16db2ab42abe6032b5e6012a2cbaec0c3bf` | NOT RUN: already closed; step 1 skip | Not established |
| [#5905](https://github.com/ashlrai/phantom/pull/5905) | blocked | none | `8a433acf61bcb6f1b6ec9f9e781c67e310ac8694` | NOT RUN: already closed; step 1 skip | Not established |

## Closure evidence

| PR | Closed at (UTC) | Existing closure evidence |
| --- | --- | --- |
| #5981 | 2026-11-24T22:36:06Z | [Stale closure comment](https://github.com/ashlrai/phantom/pull/5981#issuecomment-7146425362) |
| #5967 | 2026-11-24T22:36:03Z | [Stale closure comment](https://github.com/ashlrai/phantom/pull/5967#issuecomment-7146424425) |
| #5941 | 2026-11-24T22:36:00Z | [Stale closure comment](https://github.com/ashlrai/phantom/pull/5941#issuecomment-7146423590) |
| #5931 | 2026-11-24T22:35:58Z | [Stale closure comment](https://github.com/ashlrai/phantom/pull/5931#issuecomment-7146422660) |
| #5906 | 2026-11-24T22:35:55Z | [Stale closure comment](https://github.com/ashlrai/phantom/pull/5906#issuecomment-7146421736) |
| #5905 | 2026-11-24T22:35:52Z | [Stale closure comment](https://github.com/ashlrai/phantom/pull/5905#issuecomment-7146420749) |

## Verification and limits

- Live GitHub metadata checks: 6 successful reads, 6 exact-prefix matches, 6 closed/unmerged.
- Live GitHub comment reads: 6 successful reads, 6 existing stale-closure comments.
- Report validation under nice with temporary HOME: 16 checks passed, 0 failed; `git diff --check`: PASS.
- No merge-tree supersession conclusion, local repair, commit, push, publish, auto-merge change, queue operation, closure or new PR comment.
- Local typecheck, lint and affected tests: not run, because every PR was excluded by step 1 and no executable source changed. Hosted check status is not assessed, not green.
- Entire resume succeeded; no checkpoint was found. No commit means no new checkpoint.
- Required check names, authority controls and pinned host machinery were unchanged.
- Only the fallback handoff and uncommitted BRIDGE_NOTES.md were written. Do not publish a new bridge PR for this report-only job.

## Artifact delivery limitation

The requested runs handoff directory could not be created: both the file writer and `mkdir -p` failed, the latter with `Operation not permitted` for the runs directory. No permission or security setting was changed. This complete report is saved instead at `handoff/RQ-DRAIN-PHX-REB-30/RESULT.md` in the worktree; the existing root RESULT.md is unchanged. Delivery to the requested directory remains blocked by filesystem access.

Documentation LOC: BRIDGE_NOTES.md +44/-0; fallback RESULT.md +44/-0; total +88/-0, net +88. Source LOC: +0/-0, net 0.
