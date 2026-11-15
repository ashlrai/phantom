# RQ-REBASE-PH-07 triage

Zero-rework batch: every conflicting bridge PR's net change is already on
master via a later sibling rework. Verified per PR by fetching
`refs/pull/<N>/head`, diffing the single PR commit against its merge-base,
then confirming each touched file's semantic content on `origin/master`
(byte-identical diff or symbol/feature grep plus `git log -S` provenance).

- 3736 — SUPERSEDED: `fleet_email_outbox_batch_await` MCP tool. `src/mcp/fleet-email-outbox-batch-await.ts` and both test files are byte-identical to master; the `fleet-server.ts` registration (tool schema, allowed-names list, arg parse and dispatch) is present. Landed via `04a98b917` bridge(RQ-DRAIN-PH-001) (#3876).
- 3731 — SUPERSEDED: `docs/research/RQ-OSS-DESKTOP-UX-1.md` byte-identical to master and its `docs/research/README.md` index line is present. Landed via `04a98b917` (#3876).
- 3729 — SUPERSEDED: `docs/research/RQ-OSS-A2A-ORCH-1.md` byte-identical to master and its `docs/research/README.md` index line is present. Landed via `04a98b917` (#3876).
- 3719 — SUPERSEDED: the `docs/model-registry.json` entry already sits in the same slot of the pinned-doc list in `test/m454.agent-skills-routing-challenge.test.ts` (comment text differs: master's reads "reviewed shipped model metadata"). Landed via `c86e881ea` bridge: RQ-RELEASE-DESKTOP-UNQUARANTINE-2 (#3722).
- 3718 — SUPERSEDED: `FLEET_APPS` relocation to `src/core/fleet/app-await.ts` with the `fleet-apps-api.ts` re-export and all import updates (mcp-native, apps-recovery-history, fleet-apps-status/changes/watch) is on master; release-fast-smoke `releaseIdentity`/`stockedFeedTag` validation, its tests and the `docs/RELEASING.md` sentence are present. Landed via `07e732995` bridge(RQ-DRAIN-PH-002) (#3873). (.github content verified read-only; not edited.)
- 3716 — SUPERSEDED: `phm fleet staging-inventory --max-duration-ms` budget. `src/cli/fleet-staging-inventory.ts`, `src/core/fleet/staging-inventory.ts` and `test/fleet-staging-inventory-05-sst1.test.ts` are byte-identical to master; `test/fleet-staging-budget-reconcile-05-stf2.test.ts` matches except master drops one now-unused import. Landed via `cfdac294f` bridge(RQ-CIFIX2-PH-02) (#4011).

None of the six are on the hold list; none needed owner judgment. No code
changes were made in this worktree — a clean superseded close beats a
forced merge.
