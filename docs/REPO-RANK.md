# Repository ranking

Run `phm repos rank --json` to create or read `~/.ashlr/repo-rank.json`.
Run `phm repos rank --recompute --json` to request fresh local evidence. Both
commands honor a rolling 24-hour ceiling. `phm repos rank proposals --json`
reads proposals without creating or refreshing the file.

Schema version 1 stores enrolled names, blend weights, rankings, proposals and
the last 30 rankings. Initial enrollment follows this seed order: phantom,
phantom-secrets, locus, lexicon, ashlr-plugin, ashlr-stack, ashlr-md.
Enrollment changes require manually editing `enrolled`; proposals never enroll.

The seed prior is (8 minus seed rank) / 7. Recency sums 2^(-age/7) for
merged PRs in the preceding 14 days. Leverage counts all observed merged PRs whose title or
body mentions dispatch, restock, automations, needs-you, comms, cos, radar or
friction as a whole word. Recency and leverage are divided by the largest
enrolled value (minimum divisor 1). Default blend weights are 0.5 prior,
0.25 recency and 0.25 leverage. Ties follow enrollment order. Unenrolled
repositories with at least two matching PRs appear as proposals.

Evidence comes from first-parent local default-branch Git logs in configured roots, recognizing
merge PR subjects and squash subjects ending in a PR number. Missing checkouts
supply no evidence. Rebase merges without PR markers cannot be identified.
No GitHub requests occur. The core computeRank function also accepts JSON-shaped
fixtures with repo, mergedAt, title and optional body fields.

Ranking scores become proportional scheduling weights, with the highest ranked
repository receiving at least 40 percent. Restock reads this file only and uses
weighted fair ordering among available candidates, retaining existing eligibility,
security, lane and bold checks. Actual shares depend on eligible work and integer
slot counts. Missing or invalid files preserve the previous ordering exactly.
Restock never enrolls repositories or installs itself into the live pinned bin.

Copy and paste:

```sh
phm repos rank --recompute --json
phm repos rank proposals --json
```
