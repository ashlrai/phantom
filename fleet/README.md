# Fleet machinery as code

`fleet/` is the deploy plane for the machinery that runs under `~/.ashlr-runs`
(dispatchd, restock, the install gate, worktree pruning, and the rest of the
Mac lane). Mason doctrine: the outer loop self-improves — the orchestrator must
move through the same publish/merge pipeline as product code, not through
hand-written install recipes staged per job.

- `manifest.json` (`fleet.machinery.v1`) declares every machinery file: repo
  source path, install root, and class.
- `sync.py` turns the manifest into a safe deploy: sha256 compare, timestamped
  backups, atomic install with readback verify, rollback, and an unmanaged-file
  sweep that audits what ops-side files still live outside the manifest.
- `tests/` runs everything against a synthetic bin dir under a temporary HOME;
  the live directory is never touched.

## Classes

| class | meaning |
|---|---|
| `managed` | `sync.py --apply` installs the repo source into the root, with a `.bak-fleet-<stamp>` backup and sha256 readback. |
| `manual` | Repo source exists; adoption is a separate reviewed ops step. Sync reports sha and `drift`/`synced`/`absent` — never writes. |
| `pinned` | GATES v3 / ops-owned file (`publish.sh`, `launch.sh`, `scrub.pl`, `reap-one.sh`, `precheck.sh`, …). Sync reports sha and drift vs the repo mirror when one exists — never writes. These stay ops-side. |

An optional `sha256` field on a `pinned`/`manual` entry records the expected
live digest; a mismatch reports `pin-mismatch`. `mode` (octal string) overrides
the default `755`. `name` overrides the destination filename.

## Usage

```sh
python3 fleet/sync.py --json                # plan: per-file status + unmanaged sweep (dry run)
python3 fleet/sync.py --diff                # plan with unified diffs (400-line cap per file)
python3 fleet/sync.py --apply               # install managed entries that differ
python3 fleet/sync.py --rollback <name>     # newest <name>.bak-* restored after --apply
python3 fleet/sync.py --bin /tmp/fake-bin   # point at a scratch target (previews/tests)
python3 fleet/sync.py --manifest FILE       # alternate manifest
```

Exit 0 = ok, 1 = a step failed, 2 = usage. `--rollback` is a dry run without
`--apply`; a fresh `.bak-fleet-pre-<stamp>` of the current live file is kept
before the restore so a bad rollback is itself reversible. `src` paths are
repo-relative, resolved against the repo root (nearest `.git` ancestor of the
manifest).

JSON output schema: `fleet.sync.v1` — `files[]` rows carry `file`, `class`,
`status`, `src_sha256`, `dst_sha256` (the live digest before any install), and
`backup`. `unmanaged[]` lists target files not in the manifest — the running
inventory of what still needs migrating.

## Rules

- Agents preview with `--bin` and `--json` only. Only Security/operator runs
  `--apply` against the live `~/.ashlr-runs/bin`, after the changed files are
  reviewed and re-pinned (G1-CODE-PIN / `GS_SHA`), exactly as with
  `contrib/mac/install.sh`.
- `sync.py` never writes `manual` or `pinned` entries. It refuses symlink and
  non-regular destinations, never creates the target directory, and removes
  partial `.tmp` files on failure.
- `contrib/mac/install.sh` remains the pinned dispatcher install path until
  Security adopts `sync.py`; a test keeps install.sh's `FILES` list a subset of
  the manifest's `managed` set so the two can never disagree. `wt-prune.sh` and
  `wt-prune.py` are the first scripts covered by `sync.py` but not install.sh.

See [the migration plan](../docs/MACHINERY-MIGRATION.md) for how the remaining
ops-side machinery moves into this pipeline.

```sh
HOME=$(mktemp -d) python3 -B -m unittest discover -s fleet/tests -v
```

## Find scripts awaiting deployment

Run `phm fleet deploy-plan --since <sha> --json` from the Phantom checkout.
It compares committed `HEAD` fleet scripts changed since that ancestor commit
against `~/.ashlr-runs/bin`. Use `--repo <path>` or `--bin <path>` to inspect
another checkout or a scratch bin. It never copies files or changes pins.
The checkout must contain the merged work you want to inspect; uncommitted
edits are ignored. Deleted scripts are excluded. Manifest sources and direct
`contrib/mac/*.{py,sh,pl}` scripts are covered; unknown scripts use their basename.

The typed `FleetDeployPlan` API in `src/core/fleet/deploy-plan.ts` returns
`schema: fleet.deploy-plan.v1`, resolved `since` and `head` SHAs, `checked`,
`inSync`, and `files` (only mismatches). Each file has `repoPath`, `livePath`,
`repoSha256`, nullable `liveSha256`, `status` (`missing`, `drifted`, `unreadable`),
`shaPinned` (boolean, or null when uninventoried), and `action` (`review` or
`security-review`). Pins are identified from manifest class/digest/re-pin notes
and the Security-pinned installer file list, not by reading host security files.
Unknown pin status also requires Security review. No action is an install grant.
Symlinks and nonregular files are unreadable; absent files have a null live hash.
Exit 0 means the comparison completed (drift is expected), 1 means a live file
could not be read safely, and 2 means invalid arguments or unavailable Git or
manifest evidence. JSON errors contain `schema` and `error`.
