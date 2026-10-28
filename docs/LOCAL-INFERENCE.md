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

## The localInference config

Source only for now: this is on `master` after #917 and #920 and is listed under the unreleased 3.29.15 entry in CHANGELOG.md. npm also reports 3.29.15, so check `phm --version` and the changelog before relying on it.

Labels below: **Ran** means run on a fresh source build of `master` (818152c) with a throwaway `HOME`. **Source** means read from `src/core/run/local-inference.ts`, `src/core/run/local-inference-probe.ts` and their tests (`test/local-inference-loopback.test.ts`, `test/local-inference-probe.test.ts`; 24 tests, all passed on the box).

The block lives in `~/.ashlr/config.json` (Source):

```json
"localInference": {
  "provider": "ollama",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "models": { "coder": "qwen3.8:27b" },
  "allowRemote": false,
  "allowAbliterated": false
}
```

- `provider` is `ollama`, `omlx` or `openai-compat`. `baseUrl` defaults to `http://127.0.0.1:11434/v1` (ollama) or `http://127.0.0.1:8000/v1` (omlx) and is required for `openai-compat`. `models` keys are `coder`, `reviewer`, `planner` and `proposalOnly`. Unknown keys are problems (Source).
- Precedence for the `openai-compat` target: `OPENAI_COMPAT_BASE_URL`, then `localInference.baseUrl`, then the registry default. Every source goes through the same gate (Source).
- Keys: `ollama` and `omlx` get no key. For `openai-compat`, a `phm_` placeholder or OAuth-shaped token is dropped; a real configured key is sent (Source). Never configure a real provider key for a local URL.
- Abliterated or uncensored models are refused in `coder`, `reviewer` and `planner`. Only `proposalOnly` may use one, with `allowAbliterated: true` and a `@sha256:` digest pin (Source).

### The loopback gate

Each config below was written to the throwaway `~/.ashlr/config.json` and checked with `phm status --json` and `phm --ashlr-handshake` (Ran):

| baseUrl | allowRemote | Result |
|---|---|---|
| `http://127.0.0.1:<port>/v1`, `http://localhost:<port>/v1`, `http://[::1]:<port>/v1` | absent | accepted |
| `http://0.0.0.0:11434/v1`, `http://127.0.0.2:11434/v1`, `http://localhost.evil.com/v1` | absent | refused: `remote-not-allowed` |
| `http://example.com/v1` | absent | refused: `remote-not-allowed` |
| `http://example.com/v1` | `true` | refused: `remote-requires-https` |
| `https://example.com/v1` | `"true"` (a string) | refused: `allowRemote: must be a boolean` plus `remote-not-allowed` |
| `https://example.com/v1` | `true` | accepted, with a warning |

The refusal prints on stderr, for example:

```text
[ashlr] Warning: ~/.ashlr/config.json has an invalid localInference block (localInference.baseUrl: remote-requires-https). openai-compat refuses to run until it is fixed.
```

and an accepted remote prints:

```text
[ashlr] Warning: ~/.ashlr/config.json localInference uses a non-loopback endpoint (allowRemote: true). Prompts leave this machine.
```

Also refused (Source and tests): non-canonical loopback spellings, userinfo, query strings, fragments, dot segments and backslashes. Refusal reasons are fixed codes and never echo the URL.

### Doctor and status probe

`phm doctor` and `phm status --json` send one `GET <baseUrl>/models` to a loopback server: no key or Authorization header, no body, no redirects, 3 s timeout, bounded body, at most 20 model ids. A remote endpoint is never probed (Source).

`phm status --json` adds a `localInference` object (Ran):

```json
{"status":"reachable","provider":"ollama","loopback":true,"reachable":true,"httpStatus":200,"modelCount":1,"models":["qwen3-0.6b-stub"],"rolesPresent":{"coder":true,"reviewer":false}}
```

`status` values seen when run: `reachable`, `unreachable` (nothing listening), `config-invalid` and `remote-not-probed`. `bad-response` and `not-configured` come from source. The matching `phm doctor` lines (Ran):

```text
  ! Local inference                         ollama: reachable, 1 model(s); missing model for reviewer
  ! Local inference                         ollama: not reachable on loopback
  ! Local inference                         localInference block is invalid; openai-compat refuses to run
  ! Local inference                         openai-compat: remote endpoint (allowRemote), not probed
```

`phm --ashlr-handshake` (Ran) lists `local-inference-probe` among its capabilities and reports a `local-inference-config` check: `ok` for a valid block, `missing` with health `degraded` for an invalid one. It checks the config only; it does not call the server.

What was and was not run: Ollama was not running on the box during this check, so the `reachable` output above came from a small loopback stub server answering `/v1/models` with one model id, not from Ollama. The `unreachable` rows are real runs with nothing listening. The 27B model was not run on the box. The Qwen3-0.6B stand-in mentioned in earlier box notes is a smoke test only and says nothing about speed or quality.

## Hybrid use

- Use local engines for high-volume loops: edit, test and lint iterations, drafts.
- Use frontier models for planning and for every merge to main. Phantom already enforces the merge part: `mid` engines cannot merge to main.
- A dedicated always-on Mac mini or Mac Studio keeps a local server available without tying up a laptop, which may sleep or throttle. This is a deployment option, not a measured recommendation.

## Security

- Bind local servers to loopback (`127.0.0.1`). A server listening on `0.0.0.0` is reachable from your network.
- Local servers can log prompts. Keep `phm_` placeholders in prompts and never reveal secrets into an agent's context.
- Never point a real API key at a local URL. `OPENAI_COMPAT_BASE_URL` now goes through the same loopback gate as `localInference.baseUrl` (see below), and the environment alone can never admit a remote URL.
- Abliterated models (third-party weights with refusals removed) are not recommended for any agent that holds credentials or merge rights.
- `mlx_lm.server` is dev-only by its own docs (above).

## Other harnesses

[RockBot](https://github.com/MarimerLLC/rockbot) is an external, event-driven agent framework that can use OpenAI-compatible endpoints. It is optional and not part of Phantom.
