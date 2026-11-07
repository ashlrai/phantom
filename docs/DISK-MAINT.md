# Standing disk maintenance (phm disk-maint)

`phm disk-maint` is the standing disk-maintenance job for a fleet host. It
reclaims rebuildable bytes so free space stays comfortably above the
DISKGUARD reuse line (`DISK_REUSE_ONLY_GB`, 100 GB, reported for context and
never changed). It is a dry run unless you pass `--apply`, and every path it
plans or touches must pass the protect-list below.

Copy-paste:

```sh
phm disk-maint --json            # plan only: bytes reclaimable per class
phm disk-maint --apply           # reclaim, then print bytes freed per class
phm disk-maint --only run-logs,agent-sessions
phm disk-maint --apply --allow venvs --allow hub-claude
phm disk-maint schedule          # print the daily launchd/systemd units
phm disk-maint schedule --install --hour 4   # install the daily job (report-only)
```

## Reclaim classes

Each class is rebuildable-only by construction; the plan's `classes[].bytes`
and the apply report's `freedBytes` attribute every byte to one of:

- `run-logs`: `~/.ashlr-runs` rolling logs and per-job sidecars (`JOB.log`,
  `.launch`, `.out`, `.err`). Live logs over 50 MB are rotated and gzipped;
  sidecars for jobs with a terminal `jobs.jsonl` outcome are compressed at 7
  days and deleted at 45; unclaimed files use the conservative orphan ages
  (30/90 days). `queue/*.log` is read non-recursively the same way.
- `agent-sessions`: `~/.ashlr/native-profiles/*/native-state` session stores
  (Codex rollouts, Claude projects, Grok sessions) under `sessions`, `logs`,
  `history` and friends: compress at 14 days, delete at 60.
- `ashlr-logs`: `~/.ashlr/agent-logs`, `crashes`, `run-streams`,
  `session-history`, `test-watch-sessions` and root-level `*.log*` files.
- `recovery-dirs`: `*-recovery-*` native-profile copies, `*-backup-drill-*`
  and `*-bridge-*` dirs, and root-level `*.bak*` files older than 30 days.
- `staging`: update staging children (`updates/staged`, `consumer-staging`,
  `manual-staging`), `cloud/checkouts` clones and `vwt|mwt|wt-*` crash
  leftovers under `~/.ashlr/tmp` older than 7 days.
- `caches`: `summary-cache/` entries and `genome-index-*.cache` files older
  than 14 days.
- `worktrees-runs`: `~/.ashlr-runs/wt` worktrees whose job is `merged` or
  `empty` in the ledger, using `git worktree remove` (never `--force`).
- `worktrees-jobs`: `~/Projects/ashlrai/wt` worktrees, merged only.
- `job-artifacts`: archived dispatcher results (`JOB.publish.prev-<timestamp>`)
  older than 45 days for jobs whose latest attempt finished and merged. A
  surviving workspace, base, dispatch or reap marker keeps the artifact;
  completion and activity are checked again before deletion. Missing or
  damaged ledger evidence keeps it too. Current publish results are retained.
- `bridge-targets`: `~/.ashlr-runs/repos/<key>/target` build output quiet
  for 30 days.
- `venvs` (gated): side-project `.venv` trees with `pyvenv.cfg` quiet for 14
  days. Off unless `--allow venvs`.
- `hub-claude` (gated): `ashlr-hub/.claude` session caches older than 30
  days. Off unless `--allow hub-claude`.

`--only <class>` (repeatable or comma list) narrows the plan; `--compress-days`
and `--prune-days` override the 7/45-day log policy. Root overrides
(`--home`, `--runs-dir`, `--ashlr-dir`, `--wt-dir`, `--side-projects`,
`--hub-dir`) take absolute paths for tests and relocated homes.

## The protect-list

Refused unconditionally, at plan time and again at apply time; no flag
unprotects them:

- `~/.codex*` (CMP and every real Codex home discovered under HOME)
- Model weights: `~/.cache/huggingface`, `~/.cache/omlx`, `~/.cache/lm-studio`,
  `~/.lmstudio`, `~/.ollama`, any `models`/`checkpoints` directory component,
  and any `.gguf`/`.safetensors`/`.ckpt`/`.onnx`/`.coreml` file
- Docker: `~/.docker` (and `~/Library` is protected wholesale, which covers
  Docker's container volumes too)
- `~/Documents` and the named Desktop client trees (`dhs*`, `rde*`,
  `client*work*`), including `hle-solver/models`
- Git internals (`.git` components, refs, stashes: worktrees leave through
  `git worktree remove`, which itself refuses dirty or unmerged trees)
- Auth and secrets: `.ssh`, `.gnupg`, `.aws`, `.kube`, `.env*`, `netrc`,
  keychains, `secrets`/`credentials`/`tokens` names, `auth.json`,
  `config.toml`, key/cert extensions, plus `~/.phantom`, `~/.ashlr` secret
  stores, and the runs `quarantine`, `bin`, `metrics`, `drafts`, `leader`,
  `selector` directories
- `*.keep` marker files anywhere

Refusals are reported in the plan's `refused` list as evidence. An unreadable
`jobs.jsonl` fails closed: worktrees stay kept and logs fall back to orphan
ages. Symlinks are never followed; a candidate changed since the plan is
refused at apply. Compressed files are hash-verified before the original is
removed. Apply reports `done`, `refused` or `failed` per path and exit 1 on
any failure.

## Schedule

`phm disk-maint schedule` prints the per-user units; `--install` writes them
(exclusive creates, 0600, private log, activation failure reported) for a
daily run at minute 43 of the chosen hour (03:43 by default). The installed
job runs `phm disk-maint --json`; add `--apply` at install time for the
applying variant. It never carries `--allow`: gated classes stay off in the
scheduled job. Uninstall by deleting the printed unit paths and running the
printed activation commands' disable forms (`launchctl bootout` /
`systemctl --user disable --now`).

## JSON shape

`phm disk-maint --json` prints `disk-maint.v1`: `roots`, `freeGb`,
`diskguardReuseOnlyGb`, `jobsSource`, per-class `candidates`/`bytes`, plan
`totals`, and the `refused` evidence list. With `--apply` the same object
gains `results` (per-class per-path status and `freedBytes`), updates `freeGb`
from the runs volume after the sweep, and adds
`totals.freedBytes`/`failures`. Paths are home-relative sanitized.
