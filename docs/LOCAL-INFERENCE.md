# Local inference with Phantom

How to run Phantom's existing local engines against a model server on your own machine. This is a setup guide, not a benchmark: no speed or quality numbers are claimed here. For a parallel local fleet on llama-server, see [LOCAL-FLEET.md](./LOCAL-FLEET.md).

## Which engine to use

Both engines below are defined in `src/core/run/engine-registry.ts`, speak the OpenAI protocol, and have tier `mid`. A `mid` engine can work on branches but can never satisfy the frontier requirement for merging to main.

| Engine id | Base URL variable | Default base URL | Key | Typical server |
|---|---|---|---|---|
| `local-coder` | `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | none | Ollama |
| `openai-compat` | `OPENAI_COMPAT_BASE_URL` | `http://localhost:8000/v1` | `OPENAI_COMPAT_API_KEY` | oMLX, or any other OpenAI-compatible server |

- `local-coder` is installed when a probe of `<base>/models` succeeds. It is not in the default `allowedBackends`. Turn it on in `~/.ashlr/config.json`, and optionally pick the model:

  ```json
  "foundry": {
    "allowedBackends": ["builtin", "local-coder", "claude"],
    "models": { "local-coder": "qwen3.8:27b" }
  }
  ```

  The default model is `DEFAULT_LOCAL_MODEL_TAG` in `src/core/run/model-catalog.ts`.
- `openai-compat` counts as installed only when `OPENAI_COMPAT_API_KEY` is set. A local server needs no real key, so set a placeholder such as `local`. Never put a real provider key here when the base URL is local (see Security).

## Ollama

- OpenAI-compatible API at `http://localhost:11434/v1/` ([Ollama OpenAI compatibility](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx)). That is the `local-coder` default, so no variable is needed for a default install.
- Since [v0.40.0](https://github.com/ollama/ollama/releases/tag/v0.40.0) (released Sep 24, 2026), Ollama runs models on MLX by default on Apple Silicon, but only for model architectures the MLX runtime supports. Other models keep the previous runtime.

```bash
ollama pull qwen3.8:27b
export OLLAMA_BASE_URL=http://127.0.0.1:11434/v1   # optional; only to override the default
```

## oMLX

[oMLX](https://github.com/jundot/omlx) is an MLX server for Macs with continuous batching and a tiered KV cache: a hot in-memory tier and a cold SSD tier. Its README gives the OpenAI-compatible endpoint as `http://localhost:8000/v1`, which matches the `openai-compat` default.

```bash
export OPENAI_COMPAT_BASE_URL=http://127.0.0.1:8000/v1
export OPENAI_COMPAT_API_KEY=local    # placeholder, not a secret
```

### Memory-safe oMLX 0.7.2+ local tier

Generate a reviewable configuration with `npx tsx scripts/plan-omlx.ts request.json`.
This command prints JSON only. It never installs, upgrades, starts a server or
writes host configuration. Masbot performs the Mac upgrade after merge under
memguard, then applies the reviewed settings with oMLX stopped.

The request contains `version`, `memguard` and `models`. Example structure
(the timestamp must be replaced with a fresh memguard observation):

```json
{
  "version": "0.7.2",
  "memguard": {
    "totalBytes": 107374182400,
    "freeBytes": 75161927680,
    "headroomBytes": 53687091200,
    "capturedAtMs": 0
  },
  "models": [
    { "id": "coder", "engine": "mlx", "budgetBytes": 8589934592 },
    { "id": "reviewer", "engine": "mlx", "budgetBytes": 8589934592, "longContext": true },
    { "id": "planner", "engine": "splash", "budgetBytes": 12884901888 }
  ]
}
```

Capture memguard with oMLX stopped. `headroomBytes` means its additional
allocation allowance; `freeBytes` means currently available system RAM. The
snapshot must be no older than 30 seconds. The ceiling is the smaller of
memguard headroom and free RAM minus 30% of total RAM, rounded down to MiB.
Every model budget must include weights, draft weights, KV, scratch and process
overhead. The sum of all planned simultaneous models must fit the ceiling.
This is a configuration admission check; fake-model tests do not measure real
model memory. Memguard must remain active during operation as other apps change
memory availability. Recompute after a significant change in host pressure.

Merge `settings` into the oMLX data root's `settings.json` and merge
`modelSettings.models` into `model_settings.json` (version 1). Preserve unrelated
settings. The output pins the listener to `127.0.0.1`, keeps the prefill guard
on, and sets a custom process ceiling. Remove conflicting host/environment/CLI
overrides and verify the effective listener and memory ceiling before use.
Only planned models may run within this allowance.

MLX models use Affine8 KV by default and Affine4 when `longContext` is true.
Splash uses an explicit `splash_max_memory_gb` and `int8` KV. Because its cap is
global, multiple Splash models receive the smallest planned Splash allocation,
which can underutilize a larger allocation. A Splash long-context request is
refused: oMLX 0.7.2 supports only int8/bf16 for Splash. Use MLX for 4-bit jobs.
See the pinned upstream [model settings](https://github.com/jundot/omlx/blob/v0.7.2/omlx/model_settings.py),
[global settings](https://github.com/jundot/omlx/blob/v0.7.2/omlx/settings.py) and
[Splash integration](https://github.com/jundot/omlx/blob/v0.7.2/docs/Splash.md).
Revalidate these fields when adopting a newer oMLX version.

### Canary: oMLX 0.7.3rc1 on one loopback lane

A `canary` block in the same request pins exactly one named model lane to a
0.7.3 release candidate on its own loopback port while every other lane keeps
the stable `version` (0.7.2 remains the default). The planner refuses anything
else: stable or other RC lines can never canary.

```json
{
  "canary": {
    "lane": "planner",
    "version": "0.7.3rc1",
    "port": 8001,
    "provenance": { "cut": "core", "pin": "security", "install": "masbot" },
    "incompleteToolCall": "retry-then-reroute",
    "judge": { "cacheStore": false, "logprobs": true },
    "eval": "flint"
  }
}
```

Every field is enforced:

- `lane` must be one of the declared `models` ids, and at least one model must
  remain on the default lane. The canary lane's model moves to
  `canary.modelSettings`; `canary.settings` binds `127.0.0.1` on `port`
  (default `8001`, never `8000`). Masbot installs the RC as a second oMLX
  instance on that port; nothing else runs it.
- `provenance` must be exactly `{"cut":"core","pin":"security","install":"masbot"}`.
  A canary install is only planned through a Core cut, a Security pin and
  Masbot — no other actor, key or value is accepted.
- `memguard.wiredLimitBytes` (the live memguard wired limit) is required for a
  canary and tightens every ceiling when present. The canary lane's ceiling is
  its own allocation (`canary.budgetBytes`); the default lane's ceiling drops
  by the same amount, so the two servers cannot oversubscribe the host.
- `incompleteToolCall` must be `"retry-then-reroute"`: on the RC's
  `incomplete_tool_call` finish reason the lane retries the call once, then
  reroutes off the canary. This is emitted as `policy.on_incomplete_tool_call`.
- `judge` must be `{"cacheStore":false,"logprobs":true}`: the judge evaluating
  the canary runs with the cache store off and derives verdict confidence from
  token logprobs. Emitted as `policy.judge`.
- `eval` must be `"flint"`: installing the canary requires rerunning the Flint
  eval. Emitted as `policy.eval`.

## mlx-lm.server

`mlx_lm.server` serves an OpenAI-like API on `localhost:8080`. Its own docs say it "is not recommended for production as it only implements basic security checks" ([SERVER.md](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md)). Treat it as a dev tool, loopback only. To use it, point `OPENAI_COMPAT_BASE_URL` at `http://127.0.0.1:8080/v1`.

## Models for a 128 GB Apple Silicon Mac

4-bit sizes as listed on the Ollama library tag pages (checked Oct 25, 2026). Sizes are the download size, not total memory in use; leave room for the KV cache and the rest of the system.

| Ollama tag | Size | Notes | Source |
|---|---|---|---|
| `qwen3.8:27b` | 18 GB | dense 27B | [tags](https://ollama.com/library/qwen3.8/tags) |
| `qwen3.6:27b` | 18 to 19 GB | dense 27B; a `qwen3.6:27b-coding` tag is the same size | [tags](https://ollama.com/library/qwen3.6/tags) |
| `qwen3.6:35b` | 23 to 24 GB | same digest as `qwen3.6:35b-a3b` (35B-A3B MoE) | [tags](https://ollama.com/library/qwen3.6/tags) |
| `qwen3-coder:30b` | 19 GB | same digest as `qwen3-coder:30b-a3b-q4_K_M` | [tags](https://ollama.com/library/qwen3-coder/tags) |

## Hybrid use

- Use local engines for high-volume loops: edit, test and lint iterations, drafts.
- Use frontier models for planning and for every merge to main. Phantom already enforces the merge part: `mid` engines cannot merge to main.
- A dedicated always-on Mac mini or Mac Studio keeps a local server available without tying up a laptop, which may sleep or throttle. This is a deployment option, not a measured recommendation.

## Security

- Bind local servers to loopback (`127.0.0.1`). A server listening on `0.0.0.0` is reachable from your network.
- Local servers can log prompts. Keep `phm_` placeholders in prompts and never reveal secrets into an agent's context.
- Never point a real API key at a local URL. The local inference gate validates target URLs and drops keys for Ollama and oMLX.
- Abliterated models (third-party weights with refusals removed) are not recommended for any agent that holds credentials or merge rights.
- `mlx_lm.server` is dev-only by its own docs (above).

## Other harnesses

[RockBot](https://github.com/MarimerLLC/rockbot) is an external, event-driven agent framework that can use OpenAI-compatible endpoints. It is optional and not part of Phantom.
