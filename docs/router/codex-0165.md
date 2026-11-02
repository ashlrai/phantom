# Codex 0.165 follow-ups

RQ-RADAR-CODEX-0165 fixed the unknown-model path: a `model_not_found` / `Unknown model` failure now drops the model into `probed_bad`, retries the job without `--model`, and reroutes a codex job to the next account pool when the default is rejected too. The pool is no longer marked dead, because an unknown model is not an auth failure — `auth-failed` classification now defers to model-rejection detection, since Codex 0.165 fails fast and preserves the provider message, which can carry login guidance.

This note records the follow-ups that were deliberately left out of that change.

## Cross-vendor effort changes

Codex 0.165 enables mid-conversation reasoning-effort changes by default for supported models and adds the Vertex provider. The router models effort only indirectly through tiers (`frontier`/`workhorse`/`cheap` map to configured model names); there is no effort axis in `state.json`, the ledger, or `router_invoke_cli` argv.

Design questions for a future change: whether effort belongs on the tier, on the model record, or on the job row; how `phantom route --json` should express an effort preference; whether a rerouted job keeps the original effort or the new pool's default; and how quota accounting should treat effort (higher effort burns allowance faster, so `accountHeadroom` and `budgetScores` may need an effort multiplier). Cross-vendor parity matters: Claude and Grok expose different effort knobs, so the config schema should normalize a small enum rather than pass vendor strings through.

## Memory export/import

Codex 0.165 enables memory v2 by default for fresh profiles and supports importing memories from other agents. Router jobs run `codex exec --ephemeral`, but account-level memory under `CODEX_HOME` is shared state across jobs and across pools (`~/.codex` work, `~/.codex-2` personal).

Open questions: whether jobs should see pool memory at all (a memory written by one job could steer or leak into another job's context, including imported memories containing instructions or secrets); whether `plant_auth`-style pool setup should seed or snapshot memory files; whether keepalive should rotate or scrub memory state like it does not-touch auth files; and how imported external-agent memories interact with the forbidden-flag and protected-path guardrails. Any import path needs an audit story — memory is instruction-shaped input, so it belongs in the same review surface as prompt construction.

## Thread forks

The app-server API in 0.165 supports experimental attached thread forks. Today a reroute or failover restarts the job from the prompt on the new pool; the failed attempt's context is discarded. A fork could carry the conversation to the next pool instead, preserving partial progress and reducing duplicated spend.

Open questions: fork lifecycle versus the router's attempt model (attempts are process-scoped; a forked thread is account-scoped state that would need a lease, heartbeat, and cleanup story); whether forks honor `--ephemeral` expectations; how to bound fork fan-out so failover does not multiply concurrent context; and where fork references would be recorded (ledger `pool`/`account` fields, `meta.json`, or `state.json`). This likely wants a spike on the app-server API surface before any router integration is sized.
