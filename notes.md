# Adapter neutrality findings

- `src/core/caps/schema.ts` and `registry.ts` already model OS-1 surfaces, models and hosting edges. Pair resolution checks lanes, but not the surface engine against the model catalog engine.
- `caps/generate.ts` emits companion config, not execution plans. Desktop surfaces without an engine must not inherit CLI execution from their config format.
- `run/engines.ts:buildEngineCommand` still selects Grok seat handling and special-cases llama-server inline. Move these details behind the engine adapter boundary without changing argv or seat policy.
- `contrib/mac/dispatchd.py` contains provider-specific admission, retry, model and launch policies. Live dispatcher and launcher are pinned and must not be installed by this job.
- The supplied roster and PR list contain no duplicate adapter-neutral task. Host queue inspection is denied, so fresh overlap/lease evidence is unavailable.
- `phm claim acquire` returned `unavailable`; no successful lease is asserted.
- Transport adapters stay in the existing engine-registry.ts to avoid expanding the Tier-1 runtime closure. The closure check passes. The new regression test needs a generated CODEOWNERS entry.
- No pinned dispatcher source changes are needed for this source/API increment. Remaining dispatcher migration is documented for the existing Security package; no candidate is installed or claimed verified against the live pin.
