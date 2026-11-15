# Machinery-as-code migration plan

Status: plan + first slice landed (RQ-SWE5-MACHINERY-AS-CODE). This document
records how the ~92 scripts that live under `~/.ashlr-runs` outside the PR
pipeline move into this repository and install through `fleet/sync.py`, so the
fleet's own orchestration improves through the same review/merge machinery it
uses on product code.

## Why

Today a change to an ops-side script is a hand-written recipe: stage a copy
under `staging/<job>/`, write a NOTES.md with `cp -p` backup lines and expected
sha256 values, and let the operator install it by hand. Every recipe is
one-off, rollback is manual, and there is no single inventory of which live
files are repo-managed, mirrored, or ops-only. `fleet/manifest.json` is that
inventory; `fleet/sync.py` is the recipe.

## Current state

| Family | Where the source lives | Install path |
|---|---|---|
| Dispatcher lane (`dispatchd.py`, `restock.py`, `concurrency.py`, `batcher.py`, `local_job.py`, `launch_precheck.py`, `process_snapshot.py`, `install-gate.py`, `launch-gate.sh`) | `contrib/mac/` | `contrib/mac/install.sh` — diff + timestamped backup; manifest class `managed` |
| Worktree pruner (`wt-prune.sh`, `wt-prune.py`) | `contrib/mac/` | **This change:** `fleet/sync.py` — class `managed` (was a manual copy step) |
| Staged drain (`staged_drain.py`, `staged-drain.sh`) | `contrib/mac/` | manual copy; class `manual` pending adoption |
| Host session patches (`host_session_*.py`, `host_pressure_admission.py`, `host-integration/`) | `contrib/mac/` | surgical patch adoption; class `manual` |
| GATES v3 pins (`publish.sh`, `scrub.pl`, `launch.sh`, `reap-one.sh`, `precheck.sh`, `integrated-merge.py`, `release-autorun.sh`, `mason-inbox-append`) | repo mirrors for `publish.sh`, `integrated-merge.py`, `release-autorun.sh`, `mason-inbox-append`; ops-only for the rest | **stay ops-side** — class `pinned`; sync reports sha/drift, never writes |
| Router (`contrib/router/ashlr-router`, `lib/`, plists, `omlx-mac.sh`) | `contrib/router/` | own `install.sh` with plist templating to `~/ashlr-router` |
| Staged candidates | `staging/<job>/` | per-job NOTES.md recipes; replaced by manifest entries |
| Ops-only scripts (~70 more: `*-pace.py`, `autopilot.py`, `claude-api.py`, `claude-broker.py`, `daemon-launch.sh`, `git-safe-env.sh`, `orch-pass.sh`, `release-sign.sh`, `router.py`, `router_queue.py`, `restock.sh`, `metrics-outcomes.sh`, `sb-autopin.py`, `use-it-all.py`, `fix-claude-lane.sh`, `sandbox-pins.tsv`, `metrics-outcomes`, …) | `~/.ashlr-runs/bin` only | the migration backlog; `sync.py` reports them as `unmanaged` |

## Per-file migration recipe

1. Snapshot the live file and record its sha256.
2. Land the repo copy in the same PR as its manifest entry — fixture tests for
   changed behavior, sources under `contrib/<lane>/` (lane-specific) or a new
   `fleet/` subdirectory (fleet-wide), never a free-floating file.
3. New entries land as class `manual` first (report-only) unless the file's
   documented install path already matches sync semantics.
4. `python3 fleet/sync.py --bin ~/.ashlr-runs/bin --json` shows `drift` or
   `absent`; Security reviews the diff, re-pins where a pin exists, and flips
   the class to `managed` in the manifest (or keeps `pinned` for GATES files).
5. Operator runs `fleet/sync.py --apply`; per-file `installed` rows carry the
   backup path for rollback (`--rollback <name>`).
6. The file is now machinery-as-code: future changes are ordinary PRs whose
   deploy step is a single reviewed command, not a bespoke recipe.

## Phases

- **P0 (this PR).** `fleet/` dir, manifest, `sync.py` (plan/apply/rollback,
  sha verify, unmanaged sweep), wt-prune pair migrated, docs.
- **P1.** Promote the `manual` entries that already have repo sources
  (`staged_drain.py`, `staged-drain.sh`, `host_session_*`) to `managed` after
  Security adopts `sync.py` for the dispatcher lane; classify
  `mason-inbox-append` under the leader-wrappers pin decision.
- **P2.** Inventory sweep: `sync.py --bin ~/.ashlr-runs/bin --json |
  jq .unmanaged` gives the authoritative backlog list. Migrate in family
  batches — pace/autopilot scripts, claude-api/broker, daemon-launch +
  wrappers, git-safe-env, router.py/router_queue/restock.sh/metrics-outcomes.sh
  shells, sb-autopin, use-it-all, release-sign. Each batch is one PR: repo
  copies + manifest rows + fixture tests.
- **P3.** Converge `contrib/mac/install.sh` onto `sync.py` (or retire it) once
  Security re-reviews; the managed-set test already guarantees the two agree.
- **P4.** Router family: add a `router-home` root (`~/ashlr-router`) and plist
  templating support to sync.py, replacing `contrib/router/install.sh`.
- **P5.** Retire the `staging/<job>/` shadow-copy workflow: candidates become
  manifest entries in their own PR; `staging/` stays only for the pinned files
  that must remain ops-side.

## Boundaries

- Pinned GATES v3 files never become `managed` and never leave ops custody;
  the manifest's `pinned` class exists to *watch* them (sha, drift,
  `pin-mismatch`), not to install them.
- `sync.py` changes nothing under `.github/`, nothing about launchd, and no
  sandbox profile. It runs no services and creates no credentials.
- Agents never run `--apply` against the live directory — same rule as
  `install.sh`. Preview is `--bin <scratch>` or `--dry-run`.
- Rollback restores the newest `.bak-fleet-*`; install.sh-era
  `.bak-macdispatch-*` backups are also picked up by the glob, so rollback
  works across the install.sh → sync.py transition.

## Acceptance

- `fleet/tests` hermetic; `test_install.py` keeps passing (install.sh
  unchanged this PR).
- `sync.py` dry-run against the live bin dir is the ongoing audit: zero
  unexplained `unmanaged` entries is the migration's done condition.

### Compare the live scripts

From a Phantom checkout, run `phm fleet bin-diff` for a plain-language count,
 or add `--json` for the `fleet.bin-diff.v1` report. Use `--repo <checkout>`
when outside the checkout and `--bin <directory>` to inspect another bin.
The command reads the fleet manifest and hashes each source-backed runs-bin
entry and its live copy; it never installs or changes files. Manifest-pinned
entries and names in the bin's optional `SHA256SUMS` file are reported as
pinned even when missing or drifted; both hashes remain available in JSON.
Use `--pins <file>` for a different SHA256SUMS-format pin file. A missing pin
file is treated as empty; unreadable or malformed files fail the command.
Ops-only manifest entries without a source are excluded. Pins held elsewhere,
including embedded pins in host wrappers, are not discovered automatically;
Security must check those before installation.
