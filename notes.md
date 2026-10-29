# RQ-BACKLOG-GEN findings

- Existing CLI: src/cli/backlog.ts, already dispatched by src/cli/index.ts.
- Existing scoring leaf: src/core/portfolio/scoring.ts.
- Portfolio scanners and backlog are in the Tier-1 closure; do not add imports
  from those into new planning code or change their behavior.
- No router-queue.md, RQ supervisor, seven-repo allowlist or VISION.md schema
  exists in this checkout. NORTH-STAR.md is narrative, not actionable tasks.
- New command is offline and read-only. Source snapshots must be collected by
  the bridge through its existing enrolled discovery; it owns freshness,
  credentials, recurring invocation, queue writes and concurrency.
- Merge review, exact-head checks, credential custody, merge limits, PAUSE and
  kill switches remain separate supervisor requirements; this planner grants
  no execution or merge authority.
- Avoid protected test-name stems (especially router) and protected imports.
- Companion tools used: none.

# RQ-CLASSIFYLANEQ7 investigation

No implementation changes: the implicated workflow and source-binding script
are under `.github/`, which the task explicitly prohibits editing. The exact
job error could not be retrieved, so the log-level root cause remains unconfirmed.

Public GitHub API evidence for run 40711323303, job 122897080119:
checkout succeeded; Bind candidate source failed; classification and Mac
rotation were skipped. The classifier itself therefore did not fail.
The logs endpoint returned HTTP 403 (admin rights required); annotations only
report exit code 1. Local gh cannot read its configuration (operation not
permitted); a temporary configuration has no authenticated session.

Likely shared cause: ci.yml checks out the PR head and passes it as candidate
to ci-source-binding.mjs, while eventSha comes from GITHUB_SHA. For a PR this
is the synthetic merge revision. bindSource requires the two trees to match,
so independent base changes cause rejection before classification. Current
public API trees for PR #1378 differ:

- Head eb5060e7f3e23208140ee3d78bdda1b9645415eb:
  43dc26cfaa3cc8b1a9d6e2da69d8dd17ff27b607.
- Current merge 318e85ba9f5ba5cbc747c2a4113e2873782539c4:
  5ed38438611bd799f6276766bfb4362785daf09c.

The current merge is not proof of the historical run's GITHUB_SHA. Other
failures in the binding step cannot be excluded without its log.

An authorized follow-up must reconcile candidate/event binding consistently
across qualification and attestation, preserve exact-source verification, add
PR fixtures with independent base changes for both docs and code, and verify
a hosted run after publication. Do not simply remove the tree check: existing
qualification fixtures intentionally require differing trees to be rejected.
Merge Gate and Secret-shape scan were not changed. No rerun was requested:
unchanged historical source would not test a fix, and no change was published.
