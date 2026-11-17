# Task Plan: RQ-CI-MASTER-FULL-1

## Goal
Qualify scheduled master full CI before auto-tag and leave one uncommitted change.

## Phases
- [x] Audit live workflow conditions and repository guidance.
- [x] Implement scheduled full evidence and fail-closed auto-tag admission.
- [x] Add behavior and topology regression tests.
- [x] Run required checks and write BRIDGE_NOTES.md with measurements and limitations.

## Decisions
Exact SHA only; no descendants admitted. Keep six-hour schedule, Mac rotation, Merge Gate, protected scans and release-build body. Do not commit, push, publish or change host configuration.

## Errors encountered
- Host denies global npm installation, gh config, and ~/.ashlr-runs destination access.
- Public GitHub API rate limited; baseline and open-PR checks unavailable beyond supplied context.
- Fast-forward refused as unrelated histories; fetched origin/master has identical scoped workflows/tests, so retain the provided checkout.

## Status
Validation and measurement handoff. New guard and release contracts pass; original fast-gate assertion and authority closure drift remain outside scope.
