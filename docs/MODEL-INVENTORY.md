# Local model inventory

`phm models inventory --json` measures installed Ollama and oMLX models on a
Mac and writes `~/.ashlr/fleet.json` at `resources.models`. It is disabled by
default. Create `~/.ashlr/model-inventory.json` explicitly:

```json
{
  "enabled": true,
  "ollama": "http://127.0.0.1:11434",
  "omlx": "http://127.0.0.1:8000"
}
```

Only HTTP origins with literal `127.0.0.1` or `[::1]` are accepted. DNS names,
wildcard addresses, credentials, URL paths and redirects are refused. On Mac,
`lsof` must confirm all listeners on each configured port bind to numeric
loopback addresses before each request. Authenticated engines are unavailable;
the command never obtains or sends credentials. Endpoint response bodies and
inference output are not logged or persisted.

Run with idle engines. The command refuses to evict any existing loaded model.
It holds an atomic directory lock for the entire CLI run and processes models
and samples sequentially. An abandoned `model-inventory.lock` is never stolen;
inspect the engines and process before manually removing it.

Admission uses the conservative legacy Mac memguard thresholds: at least 35%
free memory, normal kernel memory pressure, over 10 GB disk headroom, and enough
free memory for 120% of the model's reported size while retaining 25% of total
RAM. Missing telemetry refuses admission. Admission is rechecked before every
sample and tokenizer calibration. This is a local admission check, not a lease
from the bridge scheduler; other clients must keep the engines idle.

Every measured model has three cold samples with a fixed synthetic ` hello`
repetition prompt, calibrated to exactly 512 engine-reported prompt tokens.
Calibration plus measurement is bounded to six attempts. Generation is capped
at 64 tokens, with temperature zero. Each attempt unloads through its engine API
in a `finally` block, and uses at most 20 idle-confirmation polls, with 500 ms pauses between them, before the
next attempt. Unconfirmed unload stops the entire inventory. Cache hits and
missing measurements cannot produce a measured row or tiers. oMLX uses the
inference/tokenizer APIs rather than its benchmark service, which can upload
benchmark results externally.

Ollama reports prompt and decode counts divided by nanosecond durations;
oMLX reports its own prefill and generation rates. Resident memory is the
loaded model's Ollama `/api/ps` size or oMLX admin `actual_size`, never the
on-disk download size. Each reported metric is the median of three samples.
Native context length and quantization come from engine metadata. Unknown
metadata stays null, and cannot satisfy the affected tier threshold. Embedding
and other unsupported models remain in the inventory without invented rates.

## Fleet schema

`resources.models` is a versioned envelope. Existing fleet keys and sibling
resource fields are preserved. A same-directory temporary file and rename
replace the fleet file only after the complete inventory succeeds.

| Field | Type | Meaning |
| --- | --- | --- |
| schemaVersion | 1 | Schema version |
| measuredAt | string | ISO timestamp for the pass |
| promptTokens | 512 | Verified prompt length per measured sample |
| repetitions | 3 | Successful samples required per measured model |
| unavailableEngines | string[] | Engines unavailable or refused before discovery |
| models | ModelInventoryRow[] | All discovered supported model identifiers |

Each row contains `id`, `engine` (`ollama` or `omlx`), `contextLength`,
`quantization`, `residentBytes`, `prefillTokensPerSecond`,
`decodeTokensPerSecond`, `servableTiers` and `status`. Numeric metrics and
quantization are nullable. Status is `measured`, `unsupported`, `unavailable`
or `refused`. Non-measured rows have no tiers. These are capability thresholds,
not model quality certifications:

| Tier | Minimum decode tokens/s | Minimum prefill tokens/s | Minimum context | Minimum quantization bits |
| --- | ---: | ---: | ---: | ---: |
| fast | 40 | 100 | 8192 | 4 |
| work | 15 | 50 | 32768 | 4 |
| frontier | 8 | 25 | 65536 | 8 |

Tiers are independent; a model can satisfy multiple rows. Unknown quantization
fails closed. JSON is emitted even for a partial inventory. Exit status is 1
when any engine is unavailable, any model is not measured, or a safety check
fails; otherwise it is 0. An unsuccessful pass can preserve the previous fleet
snapshot, so consumers must check its timestamp rather than assume freshness.

Engine contracts: [Ollama API](https://docs.ollama.com/api) and
[oMLX server](https://github.com/jundot/omlx/blob/main/omlx/server.py),
[oMLX admin routes](https://github.com/jundot/omlx/blob/main/omlx/admin/routes.py).
