# Bridge split

All changes are intentionally uncommitted. No PR, push, tag, merge or release
was performed. Publish only through the sanctioned fork bridge after review.

1. **Windows evidence workflow, separate PR:** apply `install-smoke.patch` to
   `.github/workflows/install-smoke.yml`. Label `needs-security-review`, leave
   auto-merge off and coordinate filters with CI Efficiency. This removes the
   old hosted Linux and duplicate push run before installer changes select it.
2. **Service and onboarding portability:** `src/core/daemon/service.ts`,
   `src/cli/daemon.ts`, `src/core/onboard.ts`, `src/core/doctor.ts`,
   `src/doctor/executable.ts` and their existing focused regression suites.
   This touches a CODEOWNED service boundary: `needs-security-review`, no
   auto-merge. Existing grant and lifecycle checks are preserved.
3. **OS observations:** new `src/core/resources/os-sensors.ts`, additive
   `src/core/resources/telemetry.ts`, their tests, machine-telemetry docs and
   `test/fixtures/authority/tier1-closure.json`. Label `needs-security-review`,
   no auto-merge. Regeneration added no Tier-1 roots; it added only
   `src/core/resources/os-sensors.ts` to the existing import closure.
4. **Verified installers:** both release installers, their source/execution
   tests and the explicit OS suite selection in `vitest.config.ts`.
   Native bundle publication remains owned by PR #8595. The verifier
   hook invokes a caller-selected executable after integrity verification and
   does not implement signing. Include platform install documentation after
   the service and sensor dependencies are present.

`handoff/` and `BRIDGE_NOTES.md` are review/transfer artifacts. Exclude them
from product PRs unless deliberately retained as sanitized public records.
The replacement installer prompt and Security bus note could not be delivered
to the external fleet directories; transfer them through the authorized bridge.
