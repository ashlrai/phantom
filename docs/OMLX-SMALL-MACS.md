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
