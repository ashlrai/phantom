# oMLX on the small Macs (RQ-OMLX-DISTILL-1)

Make the 8 GB and 16 GB Macs useful as pool nodes by serving one evidence-picked
local model each, advertised to the unified node router as `omlx` / `omlx-work`
caps. Everything here is decided by recorded benchmarks and the memory math —
not by model size marketing. The evidence lives in
[`benchmarks/omlx-model-candidates.json`](../benchmarks/omlx-model-candidates.json)
and is pinned byte-identical to the catalog the planner runs on by
`test/omlx-lane-sizing.test.ts`.

## The pick, and why

| RAM class | Pick | Caps | Why this one (recorded evidence) |
|---|---|---|---|
| 8 GB | `mlx-community/Qwen3-4B-Instruct-2507-4bit` | `omlx` | Only candidate fitting the half-RAM envelope at one slot. BFCL 53.0 gives the best small-model tool-calling evidence; 16k context served. |
| 16 GB | `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit` | `omlx,omlx-work` | oMLX-measured on M4 16 GB: 23.3 TG/s decode, 257.8 PP/s, 5.4 GB peak → clears the `work` tier floor (15/50/32k/4-bit). Batch 4× reaches 76.7 TG/s aggregate, so two slots fit. |

The rejected candidates matter more than the picks:

- **`Qwen2.5-Coder-14B-4bit` — rejected on 16 GB by measurement.** oMLX's own
  community benchmark records 10.6 TG/s decode on M4 16 GB, below the 15 TG/s
  work floor, at a 10.6 GB peak that pushed the host to 89% RAM. It is also
  outside the 50% envelope. Bigger is not better once it grazes swap.
- **`DeepSeek-R1-Distill-Qwen-7B-4bit` — evaluated distill path, rejected on
  evidence.** LiveCodeBench 37.6 (paper) vs the coder's 55.3, no oMLX-measured
  rates, and reasoning traces spend the decode budget a tool loop needs.
- **`Qwen3-8B-4bit` — reaches work tier on speed (16.6 TG/s median, M4 16 GB)
  but has no recorded coding-suite score, so it ranks below the coder pick.**

Ranking is deterministic: best service tier the measured rates reach
(frontier>work>fast>none), then the mean recorded coding-suite score, then
decode speed. A candidate that cannot prove a tier never claims the cap.

## Benchmark harness and refresh

The measured lane is `phm models inventory --json` (see
[MODEL-INVENTORY.md](MODEL-INVENTORY.md)): three cold samples per model,
loopback-only, no external upload. The recorded file's `bench` blocks carry
oMLX community-benchmark numbers; `mergeRate` stays `null` until the fleet
ledger (`phm fleet` model stats) has real merge outcomes for the model, at
which point re-rank and update both files in the same PR — the parity test
keeps them identical.

## Download path (weights never in git)

Weights come from `mlx-community` Hugging Face repos — already MLX 4-bit, no
local conversion needed:

```sh
huggingface-cli download mlx-community/Qwen2.5-Coder-7B-Instruct-4bit   # into ~/.cache/huggingface
# or let oMLX pull it on first request into its own data root (~/.omlx)
```

Both caches are **protected model roots** (`src/core/local-runtime/model-roots.ts`):
`~/.cache/huggingface`, `~/.cache/omlx`, `~/.omlx`, `~/.ollama/models`,
`~/.lmstudio/models`, `~/.ashlr/models`. Disk maintenance never deletes them by
default — `runSteward` refuses any root inside one even with `--apply`, and the
default policy is tested to never include them. Weights stay outside the repo;
nothing in the pick needs a weight file committed.

## Per-node lane config

On each small Mac, opt in and check the plan:

```sh
cat > ~/.ashlr/local-lanes.json <<'EOF'
{"schemaVersion":1,"enabled":true}
EOF
phm node lanes --json
```

Optional keys: `"model": "<catalog id>"` pins a candidate (must exist in the
catalog and fit), `"maxSlots": 1-4` caps concurrency (default 2). A malformed
file is reported by `phm node lanes` as `configError` and advertises nothing.

`phm node lanes` prints the envelope (`50%` of physical RAM, matching the
oMLX memguard posture of `plan-omlx`), the pick, the slots and the suggested
`--caps` string. `phm node join` and `phm node worker` merge those caps into
the node's advertisement automatically — a `--requires omlx-work` job then only
routes to a node whose measured pick reaches that tier, and `phm node status`
shows the caps as lanes.

## Swap backoff

Caps are computed from a live headroom read each join/probe: the same
gate as host admission — the kernel memory-pressure level must report
normal (`host-headroom.ts`). Above normal the node advertises no omlx caps
at all, so a pressured node stops pulling local-model jobs instead of
crawling through them. Memory telemetry that cannot be read holds the
lane closed too.

## Sharded inference: off by default

Not enabled, and there is no measured reason to. The pick deliberately fits
**one whole model per node** — the 16 GB pick peaks at 5.4 GB resident — so
there is nothing to shard within the target RAM classes. The gate to revisit:
a recorded comparison on real nodes showing an across-node sharded run beating
the per-node lane on both decode tokens/second and merge rate; until those
numbers exist in `benchmarks/omlx-model-candidates.json`, per-node stays.

## Wiring summary

- `src/core/local-runtime/omlx/models.ts` — catalog, evidence tiers, `planOmlxLocalLanes`.
- `src/core/drive/nodes/local-model-caps.ts` — `local-lanes.json` + headroom → caps.
- `src/core/drive/nodes/worker.ts` — `probeNodeLanes` merges the caps into join/worker advertisement.
- `phm node lanes [--json]` — the node's current plan and held reasons.
- `src/core/local-runtime/model-roots.ts` + `runSteward` — protected caches.

## Commission muse (8 GB, RQ-MUSE-OMLX-1)

Run these steps **on muse** through its enrolled SSH alias or a local terminal.
Check `hostname`, `uname -m`, `sw_vers -productVersion` and
`sysctl -n hw.memsize` first: the target is Masons-MacBook-Pro-2, arm64,
8 GiB, with macOS 15 or newer. Keep the existing backup/witness pool roles.
An SSH failure is a blocked install, not evidence of model readiness.

The commands below use an isolated user venv and the stable oMLX 0.7.2 line.
They follow the upstream [installation requirements](https://github.com/jundot/omlx/blob/v0.7.2/pyproject.toml)
and [CLI flags](https://github.com/jundot/omlx/blob/v0.7.2/omlx/cli.py).
Use an existing `uv`; if absent, install it in an existing user Python with
`python3 -m pip install --user uv`. No provider login or token is needed.
Keep at least 20 GB disk free **after** downloading weights and dependencies;
node admission otherwise holds the worker.

```sh
uv venv --python 3.12 "$HOME/.local/share/ashlr/omlx-venv"
uv pip install --python "$HOME/.local/share/ashlr/omlx-venv/bin/python" \
  'omlx @ git+https://github.com/jundot/omlx.git@v0.7.2'
uv pip check --python "$HOME/.local/share/ashlr/omlx-venv/bin/python"
```

Download the public model without using saved Hugging Face credentials;
the directory name becomes its API model id:

```sh
"$HOME/.local/share/ashlr/omlx-venv/bin/python" - <<'PY'
from pathlib import Path
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="mlx-community/Qwen3-4B-Instruct-2507-4bit",
    local_dir=Path.home() / ".omlx/muse/models/qwen3-4b-instruct-2507-4bit",
    token=False,
)
PY
```

Before the first server start, create model settings in the dedicated base path.
The exclusive write refuses to overwrite an existing file; on a repeat install,
verify the existing limits instead. The settings use the upstream
[per-model schema](https://github.com/jundot/omlx/blob/v0.7.2/omlx/model_settings.py).

```sh
umask 077
mkdir -p "$HOME/.omlx/muse"
"$HOME/.local/share/ashlr/omlx-venv/bin/python" - <<'PY'
import json
from pathlib import Path
path = Path.home() / ".omlx/muse/model_settings.json"
with path.open("x") as output:
    json.dump({"version": 1, "models": {"qwen3-4b-instruct-2507-4bit": {
        "max_context_window": 16384, "max_tokens": 1024,
        "ttl_seconds": 60, "is_pinned": False,
    }}}, output)
PY
"$HOME/.local/share/ashlr/omlx-venv/bin/omlx" serve \
  --base-path "$HOME/.omlx/muse" --model-dir "$HOME/.omlx/muse/models" \
  --host 127.0.0.1 --port 8000 --max-concurrent-requests 1 \
  --memory-guard-gb 4 --no-cache --no-hf-cache
```

Keep this foreground server running for acceptance; persistence across logout
requires a separately configured user service. `maxSlots` limits the node plan;
`--max-concurrent-requests 1` separately limits the server. The 4 GiB ceiling
matches the half-RAM envelope, the idle TTL releases unused weights, and
`--no-cache` avoids additional oMLX prefix-cache allocations. Leave memory
pressure checks enabled. A memory guard ceiling is not proof of available headroom.
`--no-hf-cache` limits discovery to the dedicated model directory.

In a second muse terminal, verify the listener and run a real completion:

```sh
lsof -nP -iTCP:8000 -sTCP:LISTEN
curl --fail --silent --show-error --noproxy '*' --max-time 10 http://127.0.0.1:8000/v1/models
curl --fail --silent --show-error --noproxy '*' --max-time 120 \
  http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-4b-instruct-2507-4bit","messages":[{"role":"user","content":"Reply with OK."}],"max_tokens":8,"stream":false}'
```

Require `127.0.0.1:8000` as the only listener address, the exact model id in
`data`, and a nonempty completion. An occupied port must be investigated before
starting another server. Only after those checks, write the node opt-in (back up
any existing local-lanes.json before replacing it):

```sh
umask 077
mkdir -p "$HOME/.ashlr"
cat > "$HOME/.ashlr/local-lanes.json" <<'JSON'
{"schemaVersion":1,"enabled":true,"model":"qwen3-4b-instruct-2507-4bit","maxSlots":1}
JSON
phm node lanes --json
```

Require `configError: null`, `slots: 1`, `caps: ["omlx"]`, and the exact model
and 16384 served context in `plan`. Warning/critical pressure or unavailable
telemetry must produce empty caps; wait for normal pressure instead of disabling
admission. From a trusted source checkout on muse, verify the worker's own probe:

```sh
node --import tsx --input-type=module - <<'JS'
import { probeNodeLanes } from './src/core/drive/nodes/worker.ts';
console.log(JSON.stringify({ lanes: probeNodeLanes() }));
JS
```

`probeNodeLanes` is the same function `phm node worker` uses before joining.
It must include `omlx` at normal pressure even when Codex/Claude are unavailable.
It plans caps without probing the server, so keep the endpoint/completion evidence
alongside its output. Use `phm node worker --runner /absolute/existing-reviewed-runner --json`
only with the host's already reviewed runner; it can claim real queued work.
Do not install a repository dispatcher or create a substitute runner to pass
acceptance. Record the pool's actual advertisement separately when that worker
runs. `test/node-local-lanes.test.ts` covers the exact muse config, missing provider
executables, warning/critical/unknown pressure and recovery without stressing
host memory. `test/multinode-worker.test.ts` covers pressure fencing during work.
