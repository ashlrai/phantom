# Cycle collector fixture

`synthetic-merged-prs.json` is hand-authored GitHub-shaped test data, not a recorded GitHub response. It covers both queue repositories and a repository without a queue; the remaining repository arrays are intentionally empty so the default seven-repository CLI can replay it.

Each PR opens at 00:00 UTC, its final-head Actions suite starts at 00:01, the owner posts LGTM at 00:03, the required run ends at 00:05, queue entry is at 00:06, and merge is at 00:10 on 2026-10-26. Expected seconds: rework 60, ci_pr 240, review 180; queue repositories add green_to_enqueue 60 and merge_group 240; locus adds green_to_merged 300. These numbers are calculated from the timestamps by hand.

This fixture does not establish parity with the unavailable `cycle/baseline.py` or constitute recorded-gh acceptance evidence.
