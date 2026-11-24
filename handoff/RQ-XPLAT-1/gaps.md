# Ranked platform gaps

Audit base: `06ff9648d4`. Scope: installers, daemon services, onboarding,
machine observations, desktop packaging and evidence workflows. This is a
ranked source audit, not a claim that every CLI command has native OS coverage.

| Rank | Gap and source | Outcome in this change |
| --- | --- | --- |
| P0 | Resident execution depends on signed macOS custody in `src/core/daemon/service-install-authority.ts` and `desktop/src-tauri/src/fleet_ops.rs`. | Preserve the authority boundary. Portable service registration does not establish portable autonomous execution. Separate Security and signer work remains necessary. |
| P0 | `scripts/install-release.sh` and `scripts/install.ps1` could prefer latest native assets over an explicit version, or verify different local bytes from those installed. | Enforce the selected version and verify the staged payload before installation. Bind native URLs to the official repository and release tag. |
| P0 | Native release executables need console assets and worker files from `scripts/build-sea.mjs`. Open PR #8595 owns `.github/workflows/release-cli-assets.yml`. | Do not duplicate asset publishing. npm remains the complete package route; asset-owner acceptance must include console and worker execution. |
| P1 | `src/core/daemon/service.ts` resolves a URL pathname directly and interpolates paths into XML, systemd and batch files. | Reuse the existing launchd/systemd/Task Scheduler manager; fix URL decoding and native-format escaping. Preserve install transactions, fences and registration evidence. |
| P1 | `src/core/onboard.ts` assumes a Unix symlink; doctor guidance assumes a shell export. | Recognize installed launchers and give Windows npm/PATH guidance without requiring symlink privilege. Surface native service state in doctor. |
| P1 | `src/core/resources/telemetry.ts` has no Windows collector, Linux lacks PSI/compression/thermal and macOS observations are duplicated across modules. | Add a bounded platform sensor interface with typed pressure semantics and explicit unknowns. Pacing policy remains a separate consumer. |
| P1 | `.github/workflows/install-smoke.yml` has two hosted jobs, push and PR duplication, broad daemon filters and full builds. | Prepare a separate review patch retaining the existing Windows check name, one job, narrow paths and focused tests. Linux evidence moves to the supplied box script. No dispatch in this session. |
| P1 | `desktop/src-tauri/build.rs`, bundle policy and desktop configurations quarantine Linux and restrict Windows promotion. | Document the port work and acceptance gates in `desktop-assessment.md`. No signing, notarization or platform policy changes. |
| P2 | `src/core/run/tool-path.ts` includes `/opt/homebrew` and Unix executable-bit assumptions; shell helpers and `which` callers are not all portable. | Remaining audit item: migrate callers to platform-aware executable discovery, then qualify npm `.cmd` launchers with shell metacharacters. Avoid an unrelated global resolver rewrite here. |
| P2 | `src/core/drive/nodes/node-measure.ts`, `src/core/fleet/host-memory.ts`, `host-top.ts` and `local-capacity.ts` use `vm_stat`, `sysctl`, BSD `ps` or Apple process tools. | New sensor contract supplies a migration target. Process attribution and fleet pacing still need OS-specific acceptance; do not claim parity from fixture tests. |
| P2 | `src/core/run/host-headroom.ts` uses a macOS kernel pressure admission policy. | Preserve it. Linux PSI, Windows commit pressure and macOS severity are distinct quantities; changing admission thresholds belongs to the pacing controller. |
| P2 | Desktop notification, voice and native metadata modules use `osascript`, Homebrew paths and `sysctl`; Universe execution uses `sandbox-exec`. | Capability-specific UI and native platform adapters remain follow-up work, covered by the desktop assessment. No keychain, TCC or app database inspection. |
| P2 | The source-only `install.sh` uses `npm install --silent` instead of the repository's locked `npm ci` convention. | Release installers are hardened here. Source bootstrap determinism remains a separate setup follow-up, coordinated with the existing developer-setup work. |

Linux evidence: Docker executable found, but its daemon socket was unavailable.
The measured host load1 at discovery was 28.9873046875. No container was started.
Use `linux-e2e.sh` on a Linux box or an already-idle container host. Windows
evidence remains pending the separate Security-reviewed workflow candidate.

The requested external handoff location could not be written (EPERM). These
worktree handoffs are transfer-ready and should be excluded from product PRs
unless intentionally retained as public, sanitized engineering records.
