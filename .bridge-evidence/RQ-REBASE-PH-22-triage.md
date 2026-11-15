# RQ-REBASE-PH-22 triage

No reworks were made. GitHub CLI could not read its configuration (EPERM); an isolated configuration was unauthenticated, and the public API returned HTTP 403. The required PR views and diffs could not be retrieved. Git PR head refs were fetched and compared to origin/master at 2fabe0e20acc6e32577c0eac07306ef629938d21. These are preliminary observations, not closure recommendations.

- REWORKS_PR: 2915 — skipped: PR metadata unavailable; main's self-tick-check uses the same command name for a different service-manager check, requiring semantic resolution. Some schedule changes are already identical.
- REWORKS_PR: 2912 — skipped: PR metadata unavailable; main lacks the branch's changelog implementation and tests, while many other files are identical or have diverged.
- REWORKS_PR: 2910 — skipped: PR metadata unavailable; main lacks the branch's context-pack implementation and tests.
- REWORKS_PR: 2906 — skipped: PR metadata unavailable; some web typecheck changes are identical on main, while other files diverged. Full supersession is unverified.
- REWORKS_PR: 2901 — skipped: PR metadata unavailable; main lacks the branch's tenancy implementation and tests.
- REWORKS_PR: 2900 — skipped: PR metadata unavailable; main lacks the branch's job-cost implementation and tests.

Restore GitHub CLI access, repeat the requested PR views and diffs in order, and resolve each residual change against current main. Do not close any PR on this evidence alone.
