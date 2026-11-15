# RQ-REBASE-PH-29 triage

Compared fetched PR head refs with origin/master at eff2ade56843436b7ee355264285d31a1f736e4a. These are incomplete dispositions, not recommendations to close. No PR was established to be superseded.

- REWORKS_PR: 1690 — skipped: unresolved conflicts in CLI documentation and completions; ecosystem changelog additions differ from main.
- REWORKS_PR: 1685 — skipped: unresolved .gitignore and usage fixture conflicts; workbench implementation differs from main.
- REWORKS_PR: 1680 — skipped: deletes tests and code, including three files modified on main; the requested prohibition on deleting tests prevents applying the PR as written.
- REWORKS_PR: 1679 — skipped: unresolved router and documentation conflicts; task-bandit implementation differs from main.
- REWORKS_PR: 1678 — skipped: unresolved onboarding and Connect UI conflicts; key-custody changes differ from main.
- REWORKS_PR: 1674 — skipped: unresolved ESLint configuration conflict; the end-to-end test is absent from main.

GitHub CLI could not read its configuration (operation not permitted), so the requested `gh pr view` and `gh pr diff` calls failed. Public pull head refs were fetched and inspected instead; they do not establish PR state or prove semantic equivalence. No reworks or closures were performed.
