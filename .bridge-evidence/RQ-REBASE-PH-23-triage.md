# RQ-REBASE-PH-23 triage

Compared with `origin/master` at `2fabe0e20acc6e32577c0eac07306ef629938d21`, fetched during this session. No rework was completed; do not close the unassessed PRs on the strength of this report.

- PR 2895: unresolved. Its provider-card files are absent on main; semantic comparison and rework remain.
- PR 2888: unresolved. Its app-control module is absent on main; semantic comparison and rework remain.
- PR 2884: unresolved. Its app-steer module is absent on main; semantic comparison and rework remain.
- PR 2880: unresolved. Its nodes-view module is absent on main; semantic comparison and rework remain. The PR also contains a stray npm notifier file that should not be ported.
- PR 2850: unresolved. Its node-join module is absent on main; current node router and pool implementations require semantic comparison before porting.
- PR 2843 SUPERSEDED. All seven changed paths match the PR head on main except the test's dummy URL credentials, which main replaces with another dummy value; the tested behavior is the same.

The prescribed `gh pr view` and `gh pr diff` calls failed because the host's GitHub CLI configuration was inaccessible (EPERM); an isolated configuration had no authentication, and direct GitHub API requests returned 403. Public PR pages and Git pull refs were accessible. The Git ref comparisons are useful evidence but do not substitute for a complete semantic review of the five unresolved PRs.
