# muse — second fleet Mac (8 GB)

`Masons-MacBook-Pro-2.local` — Apple Silicon, 8 GB RAM, 8 cores, macOS 26.5.
Tailscale: `masons-macbook-pro` = 100.89.122.8 (the node named `muse` at
100.112.187.12 is a different/stale Tailscale device — do not use it).

## Role in the node pool

- **backup** (durable witness): holds `~/.ashlr/node-pool` state on muse;
  every pool mutation is witnessed here. Config: `phm node pool --role backup
  --node muse --owner ashlr --primary macbook-pro --backup muse`
- Reachable from macbook-pro via `ssh muse` (key auth, `~/.ssh/config` Host
  `muse` → 100.89.122.8, user masonwyatt).
- phm 3.30.31 + node v25.2.1 via homebrew; `~/.zshenv` puts
  /opt/homebrew/bin on PATH for non-interactive ssh (`phm node rpc`).

## Provider/lane state (2026-11-14)

- codex: installed but broken (`codex-darwin-arm64` vendor binary ENOENT)
- claude: not installed; gh: token invalid; ollama: installed, no models
- No lanes advertised yet → `phm node worker` would hold
  `no-local-provider-login`. RQ-MUSE-OMLX-1 installs oMLX + qwen3-4b
  (the catalog's 8 GB pick) to give it `omlx` caps.

## Verified

- `ssh muse` from macbook-pro: key auth OK
- Pool round-trip: `phm node status/enqueue/plan` on macbook-pro route
  through ssh to muse's witness store; `active:primary epoch:1`
- Worker smoke: `phm node worker --runner node-runner-smoke` on macbook-pro
  pulled job `muse-smoke-2` (requires codex, 22 slots) → `completed:true`

## Pending

- muse→macbook-pro ssh (needs Remote Login ON on macbook-pro; muse's key
  `muse-fleet` already in macbook-pro authorized_keys, alias `macbook-pro`
  in muse's ~/.ssh/config) — required before muse can pull jobs.
- RQ-NODE-RUNNER-1: real runner (pack→action map) before persistent workers.
- Old launchd jobs still running: `ai.ashlr.cmo`, `ai.ashlr.muse-runner`
  (legacy ashlar stack — review before retiring).

## 2026-11-14 post-Tahoe notes

- macOS 27.2.1; pool config + keys survived update; `ssh muse` alias intact.
- caffeinate -dimsu installed via `ai.ashlr.caffeinate` launchd (KeepAlive) —
  muse stays awake indefinitely (72h+ requirement).
- **Promotion event**: muse's ~1h update reboot exceeded the 15min primary
  heartbeat timeout; on first contact the backup self-promoted (epoch 8,
  sticky custody) and demoted all primary writes (`held:inactive-runner`).
  Recovery used: wipe `~/.ashlr/node-pool` on BOTH machines (state was only
  smoke jobs) + re-run `phm node pool` on both → fresh epoch 1, primary
  authority restored. Watch heartbeats (`ai.ashlr.node-pool-watch` on
  macbook-pro) prevent recurrence while muse stays up >15min between reboots.
- Still needed for muse to pull jobs: muse→macbook-pro ssh (Remote Login ON
  on macbook-pro; `muse-fleet` key already authorized here, `macbook-pro`
  alias already in muse's ~/.ssh/config) AND lanes (provider login or
  RQ-MUSE-OMLX-1 oMLX install).

## 2026-11-14 worker-live notes

- **Version parity is required.** macbook-pro's `phm` resolved to the ashlar
  signed release 3.30.24 while muse ran npm 3.30.31; pool heartbeats/RPCs
  across the version skew flapped the pool to `active:backup epoch:48
  demoted:true`. Fix: `npm i -g @ashlr/phantom@3.30.31` on macbook-pro
  (`~/.hermes/node/bin/phm`) and `.zshenv` PATH reordered so
  `~/.hermes/node/bin` precedes `~/.local/bin` — SSH non-interactive shells
  now resolve `phm` → 3.30.31 on both machines. The pool-watch plist calls
  the absolute 3.30.31 path.
- **Re-formed pool**: wiped `~/.ashlr/node-pool/*` + `~/.ashlr/nodes/*` on
  both Macs, `phm node pool --role backup` on muse (runs initializePool),
  `--role primary` on macbook-pro → `active:primary epoch:1`.
- **Runner is PATH-independent** (`~/.ashlr-runs/bin/node-runner`): os
  builtins + absolute tool paths only. The earlier `sysctl` call needed
  `/usr/sbin` which the worker's minimal env lacks → `runner-stopped` loop.
- **Packs**: `shell-check`, `omlx-ping`, `codex-file` (reads
  `~/.ashlr-runs/node-tasks/<jobId>.txt` ≤16KB, runs
  `codex exec --sandbox read-only --skip-git-repo-check`, 10min timeout,
  bounded output → resultRef). Task files are operator-placed via scp.
- **Verified**: `muse-verify-2` (shell-check) and `muse-codex-1`
  (codex-file) both completed through the witnessed pool on muse.
- **codex auth expired on muse**: `codex login status` still reports
  "Logged in using ChatGPT" but `codex exec` fails with token-refresh 401.
  Status checks token existence, not validity — lane probes need a live
  call (tracked under RQ-NODE-RUNNER-1). Re-login is a Mason ceremony:
  `codex login` on muse.
- **8GB admission gate works**: worker held `memory-pressure` (slots:0)
  under post-update pressure and resumed when free hit ~48%. Swap was
  ~2.3GB used; nothing egregious in top RSS.
- **Join requires both SSH aliases**: muse needed a `Host muse` → 127.0.0.1
  self-alias plus its own pubkey in authorized_keys, and known_hosts primed
  for both aliases, before `phm node join` passed its approval check.
- **Intermittent callPool errors are expected**: backup-role ops traverse
  muse→mac→muse (two SSH hops); transient failures self-retry and jobs
  still complete. Do not treat a single refusal line as an outage.
