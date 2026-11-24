# RQ-XPLAT-1 result

Local implementation and focused verification complete; all changes remain
uncommitted. Native Linux/Windows acceptance and external fleet delivery are
pending. Nothing was committed, pushed, released, installed live or dispatched.

Delivered in this worktree:

- Ranked platform audit: `gaps.md`.
- Existing service-manager portability fixes, Windows onboarding/doctor and
  native registration evidence in daemon doctor.
- Integrity-checked POSIX and PowerShell installers, deterministic version
  selection, complete npm package default and pluggable verifier hook.
- All-platform replacement prompt: `RQ-PHM-INSTALL-1.md` (live prompt was
  inaccessible, so this does not claim the queue was updated).
- OS sensors and early pacing contract: `handoff/PCEB-19/os-sensor-interface.md`.
  Machine telemetry exposes the new snapshot without changing admission policy.
- Desktop port assessment: `desktop-assessment.md`.
- Linux box script: `linux-e2e.sh`; Windows workflow: `install-smoke.patch`,
  unapplied and intended for a separate `needs-security-review` PR.
- Security/CI Efficiency note: `XPLAT-CI-1.md`; bridge split: `PR-SERIES.md`.
- Native macOS read-only evidence: `macos-sensors.json`; thermal is unknown.

Verification: 370 applicable tests passed, zero final failures; the five native
Windows installer cases remain unrun. Full backend/web typecheck and
changed-file lint passed using isolated, lockfile-matched tools. The checkout's
original typecheck/lint entrypoints initially failed on missing tool files.
The single verify-changed run returned 1 on newly conditioned installer skips;
the split native suites resolved that, and the final quarantine check passed
with zero violations. Documentation, syntax, authority and lane checks passed.
Commands, initial failures and limitations are detailed in `BRIDGE_NOTES.md`.

Linux: Docker executable exists, daemon unavailable. No container was started.
Windows: no hosted job dispatched, no runtime success claimed. The workflow
candidate has one optional Windows job, narrow paths, no matrix or push trigger,
existing pinned actions, read-only permissions and an unchanged check name.
PR #8595 continues to own native release assets. No signing or notarization edits.

External delivery failed with EPERM at the requested fleet directories. Transfer
these sanitized files through the bridge; do not claim PCEB-19, Security or CI
Efficiency acknowledged them. No new Tier-1 roots were added; the generated
closure gained only `src/core/resources/os-sensors.ts`. Authority/workflow PRs
must retain `needs-security-review` and no auto-merge.

toolsUsed: GitHub list_pr_changed_filenames, GitHub search_issues, web.run,
exec_command, apply_patch. Companion MCP tools used: none.

Final size: 38 files, +1908/-120 lines, net +1788; product code/tests/docs/config: 26 files, +1285/-120, net +1165; handoff and review artifacts included only in the first count.
