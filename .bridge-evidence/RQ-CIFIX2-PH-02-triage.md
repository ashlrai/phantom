# RQ-CIFIX2-PH-02 triage

- 3884 — REWORKED: cifix — Quick typecheck failed on CODEOWNERS drift; new Tier-1 test `test/fleet-merge-delay.test.ts` was missing from the owner-lane block. Rebased onto master and regenerated `.github/CODEOWNERS`.
- 3882 — SKIPPED: skip-conflict (drain owns) — content conflict vs master in `src/web-ui/routes/verse/sections/LiveStatusSection.tsx`.
- 3880 — REWORKED: cifix — Quick typecheck failed on CODEOWNERS drift (`test/mcp-fleet-doctor.test.ts`) plus Tier-1 import-closure growth (new `phantom_fleet_doctor` tool pulls `src/cli/fleet-doctor.ts` + 7 modules into the closure). Rebased onto master; regenerated CODEOWNERS and `test/fixtures/authority/tier1-closure.json`.
- 3875 — REWORKED: cifix — Quick typecheck failed on CODEOWNERS drift; new Tier-1 test `test/fleet-staging-budget-reconcile-05-stf2.test.ts` missing from owner-lane block. Rebased onto master; regenerated CODEOWNERS.
- 3874 — REWORKED: cifix — Quick typecheck failed on CODEOWNERS drift; new Tier-1 test `test/fleet-dep-gate.test.ts` missing from owner-lane block. Rebased onto master; regenerated CODEOWNERS.
- 3822 — REWORKED: cifix — Quick typecheck failed on CODEOWNERS drift; new Tier-1 test `test/recut-loop-attempts.test.ts` missing from owner-lane block (verified on PR head). Rebased onto master; regenerated CODEOWNERS.
