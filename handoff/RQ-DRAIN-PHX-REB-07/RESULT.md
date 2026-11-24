# RQ-DRAIN-PHX-REB-07 outcomes

All six PRs were open with the supplied heads when inspected. No PR was merged,
closed, commented on, pushed, or enqueued. The final task instruction prohibits
commits and publication. GitHub CLI configuration access is denied, and the
connected GitHub tools provide reads only. Therefore actions below are `blocked`,
including confirmed supersessions that could not actually be closed.

The requested host handoff directory rejected creation with EPERM. This is the
worktree fallback. Reconciliation base: `eadecbffd8b6037a5a2470bcaf48d924e3b4aebd`.

| PR | Action | New head SHA (unchanged) | Check status | Replacement URL |
| --- | --- | --- | --- | --- |
| [8043](https://github.com/ashlrai/phantom/pull/8043) | blocked | `9e4c38c5ee3bfc98fd592c76f663b6cade1a971c` | Uncommitted merge preview prepared; 22 backend and 21 web tests passed. Hosted head has only a neutral CodeRabbit check; no Merge Gate observed. Needs #8022 route. | |
| [8042](https://github.com/ashlrai/phantom/pull/8042) | blocked | `a8b526e10d5aa8f584c041f87e806485e9e1281a` | Superseded by merged #8070. Original head Merge Gate and Secret-shape scan passed. No remerge or test changes. Closure unavailable. | https://github.com/ashlrai/phantom/pull/8070 |
| [8030](https://github.com/ashlrai/phantom/pull/8030) | blocked | `671d48e406b7685662ccadc073114554b0e29f46` | Recovery already covered by open #8195 and #8620; no duplicate changes. Original head Merge Gate/Fast gate failed, Secret-shape scan passed. Closure unavailable. | https://github.com/ashlrai/phantom/pull/8195 |
| [8022](https://github.com/ashlrai/phantom/pull/8022) | blocked | `87f5f14f99b4c182096c9f724d278543bc2790ad` | Uncommitted merge preview prepared; 23 backend and 28 web tests passed; backend/web typecheck passed after fixture updates. Original head Merge Gate and Secret-shape scan passed. | |
| [7999](https://github.com/ashlrai/phantom/pull/7999) | blocked | `1e00090fc49739596d727d440f63168803191cff` | Superseded by #8030, with subsequent recovery in #8195. Five implementation/test files match #8030 exactly. Original head Merge Gate/Fast gate failed, Secret-shape scan passed. Closure unavailable. | https://github.com/ashlrai/phantom/pull/8030 |
| [7992](https://github.com/ashlrai/phantom/pull/7992) | blocked | `e02e1374167f54cb5718582b617132bd472d431b` | Uncommitted merge preview prepared; 72 affected cases passed in integration, including 7/7 safety cases, scoped lint and backend/web typecheck passed. Original head Merge Gate/Secret scan (diff) failed; Secret-shape scan passed. | |

Vercel reports failure on all original heads. These hosted observations describe
existing heads, not the uncommitted candidates. Required checks were not renamed
or bypassed. `clean-tree` was not observed among returned head checks.

## Supersession evidence

- #8042: merged #8070 explicitly preserves all nine original paths and adds
  stronger source/freshness tests. Master contains its merge commit
  `40d1e77436eb13345fddc16d55c4df6f8bde7400`; pool-why.ts matches verbatim.
  Its measured-exhaustion policy replaces the original projected-pace stops.
- #8030: open #8195 explicitly preserves all nine source paths and adds a
  regression; open #8620 already reconciles that recovery. Do not duplicate it.
- #7999: empty-job-origin.ts, jobs-empty-why.ts, metrics-series.ts, jobs-yield.ts
  and jobs-empty-why.test.ts match #8030 byte for byte. #8030 retains command
  discovery with newer help context and adds a real-command regression.
- #7992: #8049 is a notes-only blocked handoff, not a replacement. #8075 explicitly
  implements a different brief-window rule; preserve both rules.
- No merge-tree preview equals master's tree. Conflicts alone were not treated
  as supersession. Full ancestry was fetched after shallow merges were refused.

## Prepared comments, not posted

- #8042: Superseded by https://github.com/ashlrai/phantom/pull/8070.
- #8030: Superseded by https://github.com/ashlrai/phantom/pull/8195, already reconciled in https://github.com/ashlrai/phantom/pull/8620.
- #7999: Superseded by https://github.com/ashlrai/phantom/pull/8030.
- #8043/#8022/#7992: Local reconciliation prepared; publication is prohibited by this job's final instruction and GitHub CLI access is unavailable.

## Prepared work

Separate 8043.patch, 8022.patch and 7992.patch artifacts are retained with the
job's temporary logs. Each applies to the recorded master. The root worktree
combines them for integration verification; do not publish that aggregate as a
new PR. Apply each candidate to its existing fork branch after rechecking heads.

The previews merged master into each original head with --no-commit --no-ff,
then reset only the temporary index to master to export uncommitted patches.
No commit or PR branch update was made. Git worktree creation was denied;
isolated temporary repositories borrowed the existing Git object store instead.

#8043 retains master's supply headline and validated merge projection; its
original merge-list test is retained with the current headline expectation.
#8022 adds the existing tick snapshot route and Fleet card; both panels use
current structured source states. #7992 preserves generation tracing, current
yield guards and both self-tick behaviors, regenerates the CLI reference, and
refuses pruning with malformed ledger data or missing claims evidence.

## Integration verification

- Combined affected backend suites: 7 files, 96 passed, 0 failed.
- Combined affected web suites: 5 files, 49 passed, 0 failed.
- Total focused cases: 145 passed, 0 failed. Individual per-PR counts overlap
  these runs and must not be summed with them.
- Required foreground verify-changed run: passed, including 10 authority tests
  on the candidate and 10 on its current-master comparison tree, changed-file
  ESLint, docs, generated registry, quarantine, CSS/conflict parsing, backend
  typecheck and web typecheck. No security/authority baseline was modified.
- Full npm lint: failed with 16 errors and 265 warnings. All nine error-bearing
  paths were compared against origin/master and match it exactly. They are
  .github/scripts/ci-release-suites.mjs, .github/scripts/full-suite-fixforward.mjs,
  .github/tests/ci-history-source.test.mjs,
  .github/tests/release-version-provenance.test.mjs, scripts/bridge-heal.mjs,
  src/core/comms/dot-evidence-reply.ts, src/core/fleet/bets-check.ts,
  src/core/fleet/ingest-drift.ts and test/coding-cli-cohort-recovery-652s.test.ts.
- The jsdom FleetSection tests emit the existing unimplemented canvas warning;
  all 49 web assertions passed.
- Gitleaks initially matched a synthetic job ID containing an API area label in
  the original #7992 fixture. Renamed only that fixture's area to UI; retained
  the same sibling grouping assertions. Gitleaks then passed with no exclusions,
  and the final family suite passed 7/7. Secret-shape passed on the proposed diff.
- Full ancestry recovery, dependency repair and isolated-prefix CLI install
  succeeded. Global installation, GitHub CLI configuration, host handoff and
  shared Git worktree metadata writes failed with EPERM. No credential copying
  or alternate authentication was attempted.
- Initial #8022 fixture type errors were fixed by supplying the current typed
  source, lane, pool, release, host-load and latency fields. No cast or production
  type weakening was used.

Final origin/master advanced to `1665c021aa5254576519191d8e07f907b88d4861`
while checks ran. Its six changed chat paths do not overlap these candidates.
The root worktree was fast-forwarded while retaining all uncommitted repairs.
The separate patches still target the earlier recorded base and apply equally
to the newer base. No PR branch head changed.

Source/test/generated delta: 23 files, 474 insertions, 5 deletions, net +469 LOC.
Reports are excluded from that count. toolsUsed: [] for companion MCP tools.
Connected GitHub reads: get_pr_info, search_prs, get_commit_combined_status, fetch.

Final backend/web typecheck, Verse sync-I/O guard, CLI generator check and docs
check passed on the newer base. Standalone real-I/O inventory guard failed on
79 unchanged paths, none overlapping this diff. The verifier treats inherited
inventory findings as warnings. No membership or authority allowlist was changed.
