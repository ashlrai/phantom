# Merge-queue batching: exact ruleset values (Mason-only)

Plain words: CI is not the bottleneck. A PR gate takes about 51 s (p90 63 s) and a merge group about 49 s (p90 65.1 s), yet over 24 h the fleet merged 10.92 PRs/h while opening 12.17 PRs/h, because each merge group carries about 1 PR. Letting the queue build and merge up to 5 PRs per group (waiting at most 2 minutes to fill one) multiplies throughput several-fold without touching which checks are required. GitHub bisects a failing group itself by ejecting the failing entry. Nothing here weakens, renames or skips a required check. These are ruleset changes, so only Mason applies them; this session could not write ~/.ashlr-runs (Operation not permitted), so the file is staged in the worktree and must be copied to ~/.ashlr-runs/bus/mason-only/.

Source measurement: ~/.ashlr-runs/metrics/gate-time-20261116.json (1:36 AM ET Nov 16): PR gate p50 51 s / p90 63 s; merge group p50 49 s / p90 65.1 s; 24 h 10.92 merged/h vs 12.17 opened/h. Only phantom's volume is verified; per-repo values for the other six are scaled to their open-PR baselines (01:27 ET: phantom 351, phantom-secrets 66, locus 14, lexicon 12, ashlr-plugin 12, ashlr-stack 13, ashlr-md 13) and are RECOMMENDATIONS, not measurements.

Where: each repo, Settings > Rules > Rulesets > the ruleset on the default branch with the "Require merge queue" rule (REST: `rules[type=merge_queue].parameters`).

| Repo (ashlrai/) | max_entries_to_merge (max group size) | min_entries_to_merge (min group size) | min_entries_to_merge_wait_minutes (wait to fill) | max_entries_to_build | grouping_strategy | check_response_timeout_minutes | merge_method |
|---|---|---|---|---|---|---|---|
| phantom | 5 | 1 | 2 | 5 | ALLGREEN | 10 | keep current |
| phantom-secrets | 4 | 1 | 2 | 4 | ALLGREEN | 10 | keep current |
| locus | 3 | 1 | 1 | 3 | ALLGREEN | 10 | keep current |
| lexicon | 3 | 1 | 1 | 3 | ALLGREEN | 10 | keep current |
| ashlr-plugin | 3 | 1 | 1 | 3 | ALLGREEN | 10 | keep current |
| ashlr-stack | 3 | 1 | 1 | 3 | ALLGREEN | 10 | keep current |
| ashlr-md | 3 | 1 | 1 | 3 | ALLGREEN | 10 | keep current |

Field notes:
- min_entries_to_merge stays 1 so a lone PR never waits more than the wait time.
- ALLGREEN: a group merges only when every required check is green on the whole group (HEADGREEN would merge on the head's result alone; not recommended with fast checks).
- max_entries_to_build equals the group size so one group builds while the next fills.
- Do not change required status check names, add bypass actors, or remove the secret-shape and clean-tree gates.
- Roll back by restoring the previous values (record them before editing; this session could not read the live ruleset).
