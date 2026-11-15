# RQ-REBASE-PH-21 triage

Compared fetched PR head refs against default-branch commit `2fabe0e20acc6e32577c0eac07306ef629938d21`. GitHub CLI could not read its configuration (EPERM); a clean configuration had no authentication, and the unauthenticated GitHub API returned HTTP 403. Consequently PR descriptions, actual base metadata, and hold references could not be verified. Git merge-base diffs alone are insufficient to establish each PR's net intent or complete supersession.

- REWORKS_PR: 2960 — skipped: metadata unavailable; sibling fixup #2954 exists, but complete supersession is unverified.
- REWORKS_PR: 2946 — skipped: metadata unavailable; orders files exist on main, but full net supersession is unverified.
- REWORKS_PR: 2943 — skipped: metadata unavailable; the fetched change includes many overlapping fleet features and at least one missing test.
- REWORKS_PR: 2936 — skipped: metadata unavailable; overlapping fixup changes differ from main, so complete supersession is unverified.
- REWORKS_PR: 2928 — skipped: metadata unavailable; fetched changes include `.github/`, outside this job's edit boundary, and complete supersession is unverified.
- REWORKS_PR: 2923 — skipped: metadata unavailable; the fetched MCP self-tick files are absent on main, but the PR's full intent and hold references are unverified.

Restore read access to GitHub PR metadata and diffs, then re-evaluate all six in order. None is asserted superseded or ready for closure.
