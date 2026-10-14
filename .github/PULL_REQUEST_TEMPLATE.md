<!-- Thanks for contributing to ashlr-hub! -->

## What & why

<!-- What does this change and why? Link any issue: Closes #123 -->

## How it was verified

<!-- List commands actually run, exact source, results/report references, and affected coverage.
Use the existing fast gate for local feedback; do not repeat unrelated full suites.
Include failures, skips, untested paths and source-binding unknowns honestly.
Local feedback does not replace exact-source hosted CI or full release qualification. -->

## Reviewer handoff

<!-- Optional local context generator, using the existing project dependency:
node --import tsx scripts/reviewer-handoff.ts --base <intended-base> --head HEAD
Add --evidence <report.json> for existing test reports, or --json for structured context.
The generator executes no checks and does not approve, merge, publish or inspect other repos.
Keep private client details and sensitive evidence out of public PR text. -->

- Agent/peer review: reviewer, reviewed source, findings and unresolved questions (if performed).
- Human review: actual reviewer and findings (if performed); an agent review is not a human review.
- Existing CODEOWNERS and standing authority apply. This handoff adds no required human approval or approval count to routine qualified automated changes.

## Safety checklist (for anything touching the autonomous path)

- [ ] No new outward capability (push / PR / deploy / apply) outside the Approval Inbox
- [ ] Autonomous work stays sandboxed (never the real working tree)
- [ ] Enrollment / kill-switch / budget guards unchanged or strengthened (never weakened)
- [ ] No code-to-cloud by default; secrets never logged
- [ ] If a guard's behavior changed, the change is intentional and the regression test was updated deliberately
- [ ] **Behavior changes are flag-gated** — new behavior is off by default; `--flag-off` parity verified (see CONTRIBUTING.md invariants)

## Dependency / zero-dep invariant

- [ ] No new runtime dependencies added to `dependencies` in `package.json` (the zero-runtime-dep core invariant; see CONTRIBUTING.md)

## Notes

<!-- Anything reviewers should know: trade-offs, follow-ups, deliberately-deferred items -->
