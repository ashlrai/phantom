# Phantom features as plugins

Status: proposal, not implemented. Scope: package existing Phantom features behind a common registry while preserving every public CLI contract. This builds on [the existing plugin system](../PLUGINS.md); it does not replace its trust model. The requested research source `/workspace/phantom-work/research/bbide.md` was unavailable in this worktree environment.

## Boundary and manifest

Keep the CLI bootstrap, argument parsing, configuration, policy, audit, kill switch and plugin loader in the host. A feature owns its implementation and declares its commands and dependencies; the host owns routing and safety decisions. Core features ship with Phantom and are trusted as part of the installed release. Third-party plugins remain default-off, explicitly enabled and integrity-checked; they run in-process with the host's OS privileges, not in a sandbox. Capability declarations constrain host registration, not arbitrary Node access.

Extend the existing `manifest.json` schema in a versioned API revision, retaining `name`, `version`, `apiVersion`, `entry` and `capabilities`. A bundled feature additionally declares `commands` (full command paths, aliases, help and supported options) and `requires` (feature IDs and compatible version ranges). Example proposal:

```json
{"name":"backlog","version":"1.0.0","apiVersion":"^2.0.0","entry":"./index.js","capabilities":["command"],"commands":[{"path":["backlog"],"aliases":[],"help":"Manage the work queue"}],"requires":[]}
```

The host validates names, paths, versions, capability declarations and dependency ranges before importing code. Bundled manifests are generated or checked against the release inventory; they cannot be shadowed by user plugin directories. Existing v1 external manifests and `phm x <name>` continue through the current loader unchanged until a separately specified migration. No automatic installation, network fetch or dependency execution occurs during discovery.

## Discovery and load order

1. Read the bundled inventory and external manifests without executing plugin code. Apply the existing external disable switch, kill switch, enablement, API compatibility and integrity gates before import.
2. Validate the entire bundled command inventory and dependency graph. A duplicate ID, command path or alias, missing/incompatible dependency, or cycle is a deterministic startup error naming the conflict; never choose a winner by filesystem order. An invalid external plugin is skipped and audited under existing behavior; it cannot claim a builtin path.
3. Topologically sort bundled features by dependency, breaking ties by ASCII feature ID. Lazily activate only the selected command's transitive dependencies in that order; cache successful activation per process. Help, version, completion and manifest inspection use metadata and execute no feature code.
4. Register only declared contributions. A bundled dependency or activation failure fails the requested command with a nonzero exit and an actionable error; unrelated commands remain available. External failures retain the existing isolated, audited behavior. No silent fallback to another implementation.

Dependencies express initialization order, not implicit authority. A feature accesses other features through narrow versioned host interfaces; cycles are rejected rather than resolved through globals. The external kill switch must not disable bundled commands needed for recovery.

## CLI parity and rollout

The host dispatches existing `phm` and `ashlr` names to the same feature handlers. Preserve command paths, aliases, argument validation, defaults, stdout/stderr, JSON shapes, exit codes, help, completion, lazy side effects and authorization gates. Unknown commands and conflicting registrations fail deterministically. External commands stay under `x`; a plugin cannot override a builtin. Management commands remain host-owned so recovery works even if a feature fails.

First inventory current dispatch, help, completions and machine-readable commands, including aliases and error cases. Add a registry in shadow mode and compare its routing and metadata against that inventory without changing execution. Migrate one low-risk feature behind a reversible internal switch, then migrate feature by feature; keep the old dispatcher until parity is demonstrated. Rollback restores the prior dispatch path without changing user config or external plugin pins. Publish an API compatibility and deprecation plan before changing external manifests.

Acceptance requires fixture-driven old/new CLI comparisons for successful and invalid invocations, JSON, streams, exit codes, help and completions; dependency ordering, collisions, cycles, missing dependencies and activation failure tests; and tests proving discovery/help do not import code, external gates still apply, and recovery commands work with plugins disabled. Measure cold startup and command latency against the existing CLI before expanding rollout. No feature is removed until its parity and safety tests pass.

Open decisions before implementation: choose the API v2 schema and interface ownership, define bundled artifact integrity and release packaging, identify the first migration candidate, and set measured startup budgets. The unavailable research should be reviewed before approving the design.
