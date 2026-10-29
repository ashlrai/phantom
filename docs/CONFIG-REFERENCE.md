# Phantom config reference

Generated from `schema/config.schema.json` by `scripts/generate-config-docs.mjs`;
do not edit by hand. After changing the schema, regenerate:

    node scripts/generate-config-docs.mjs

The drift guard `test/config-docs-drift.test.ts` fails when this file no
longer matches the schema. `~/.ashlr/config.json` is validated against the
schema at load time; the schema declares no defaults, so applied defaults
live in `src/core/config.ts` and are outside this table. `[]` marks array
elements, `*` additionalProperties map values, `/<regex>/` pattern keys and
`<n>` oneOf/anyOf variant positions. "no" marks optional keys and `-`
marks positions a parent object cannot require.

## Top-level keys

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | `integer` (>= 1) | yes | Config schema version for forward migration. |
| `roots` | array of `string` | yes | Absolute roots to scan. |
| `editor` | `string` enum: `'cursor'` \| `'vscode'` | yes | Preferred editor for deep links. |
| `staleDays` | `integer` (>= 0) | yes | Days without modification before an item is considered inactive. |
| `categories` | `object` (map to `string`) | yes | Map of category name -> absolute folder path. |
| `tidyRules` | array of `object` (4 keys; closed) | yes | Ordered tidy rules for loose top-level files. |
| `keepers` | array of `string` | yes | Absolute paths or basenames that must never be moved/tidied. |
| `models` | `object` (3 keys; closed) | yes |  |
| `telemetry` | `object` (4 keys; closed) | yes |  |
| `tools` | `object` (map to `string`) | yes | Map of integration name -> resolved executable path. |
| `phantom` | `object` (2 keys; closed) | no | Optional Phantom secrets integration toggle (M2). |
| `locus` | `object` (2 keys; closed) | no | Optional Locus identity-plane settings for hub pre-mutate / CI session gates. DEFAULT ABSENT = off (monorepo-safe). Env LOCUS_ENFORCE wins over config when set. Set firm=true for production fleets (profile → enforce when enforce is unset); never default firm to true in monorepo. |
| `genome` | `object` (2 keys; closed) | no | Shared-memory / genome settings (M7). |
| `plugins` | `object` (3 keys; closed) | no | M33 plugin-system configuration. Default empty — enabled:[] means no plugins load. |
| `foundry` | `object` (66 keys; open) | no | v4/v5 autonomous-fleet configuration (M45+). Full key reference: docs/FOUNDRY-CONFIG.md. Declared exhaustively from AshlrConfig['foundry'] in src/core/types.ts (M340b). additionalProperties stays true: KNOWN_FOUNDRY_KEYS in src/core/effective-config.ts is the authoritative typo/unknown-key detector at config-load time (an accompanying human-readable warning, not a hard validation failure) and currently recognizes several keys this schema does not yet model 1:1 (e.g. acePlaybook, localization, redTeam, feedbackEnabled, stallIdleMs, strategistModel, managerJudgeModel, managerJudgeEngine, inventPerCycle, blastRadius) plus operator-extension keys consumed by tooling outside this package. This schema is documentation/editor metadata only; it is not loaded or enforced by any code path in src/. |
| `daemon` | `object` (7 keys; open) | no | Daemon loop tuning (M22+): budget caps, tick interval, parallelism, cooldowns. |
| `user` | `object` (open) | no | Fleet owner identity (M109) — attribution on pulse spans and team surfaces. |
| `notify` | `object` (open) | no | Outward notification targets (M18) — opt-in webhook for run/swarm completion summaries. |
| `comms` | `object` (open) | no | Operator comms channels (Telegram polling etc.). |
| `fleet` | `object` (open) | no | Fleet enrollment/supervisor settings. |
| `pulse` | `object` (open) | no | Ashlr Pulse (OTLP export) settings. |
| `reasoning` | `object` (1 key; closed) | no | V3.10 reasoning store (src/core/reasoning/). Stored reasoning is scrubbed, local-only, 0600, and never replayed into prompts. |
| `devin` | `object` (4 keys; closed) | no | 3.15 Devin lane (src/core/devin/). Off unless enabled is exactly true; `ashlr devin connect` turns it on after storing the API key in the macOS Keychain. The key is never read from or written to this file. |

## `roots`

Absolute roots to scan.

| Path | Type | Required | Description |
| --- | --- | --- | --- |
| `roots[]` | `string` | - |  |

## `categories`

Map of category name -> absolute folder path.

| Path | Type | Required | Description |
| --- | --- | --- | --- |
| `categories.*` | `string` | - |  |

## `tidyRules`

Ordered tidy rules for loose top-level files.

| Path | Type | Required | Description |
| --- | --- | --- | --- |
| `tidyRules[]` | `object` (4 keys; closed) | - |  |
| `tidyRules[].match` | `string` | yes |  |
| `tidyRules[].matchType` | `string` enum: `'glob'` \| `'regex'` \| `'ext'` | yes |  |
| `tidyRules[].dest` | `string` | yes |  |
| `tidyRules[].description` | `string` | no |  |

## `keepers`

Absolute paths or basenames that must never be moved/tidied.

| Path | Type | Required | Description |
| --- | --- | --- | --- |
| `keepers[]` | `string` | - |  |

## `models`

| Path | Type | Required | Description |
| --- | --- | --- | --- |
| `models.lmstudio` | `string` | yes |  |
| `models.ollama` | `string` | yes |  |
| `models.providerChain` | array of `string` | yes |  |
| `models.providerChain[]` | `string` | - |  |

## `telemetry`

| Path | Type | Required | Description |
| --- | --- | --- | --- |
| `telemetry.pulse` | `string` | no |  |
| `telemetry.budgetUsd` | `number` | no | Optional spend cap in USD for the budget window. |
| `telemetry.budgetTokens` | `number` | no | Optional token cap (in + out) for the budget window. |
| `telemetry.budgetWindow` | `string` enum: `'1d'` \| `'7d'` \| `'30d'` | no | Window the budget caps apply to (default '7d' when caps are set). |

## `tools`

Map of integration name -> resolved executable path.

| Path | Type | Required | Description |
| --- | --- | --- | --- |
| `tools.*` | `string` | - |  |

## `phantom`

Optional Phantom secrets integration toggle (M2).

| Path | Type | Required | Description |
| --- | --- | --- | --- |
| `phantom.enabled` | `boolean` | yes |  |
| `phantom.agentReportRollup` | `object` (3 keys; closed) | no | Optional count-only Phantom agent audit rollup for FleetStatus. Values and raw findings remain hidden. |
| `phantom.agentReportRollup.enabled` | `boolean` | no | When true, FleetStatus may include aggregate-only Phantom agent report counts. |
| `phantom.agentReportRollup.timeoutMs` | `integer` (>= 1) | no | Optional timeout for collecting the count-only rollup. |
| `phantom.agentReportRollup.cacheTtlMs` | `integer` (>= 1) | no | Optional cache TTL for the count-only rollup. |

## `locus`

Optional Locus identity-plane settings for hub pre-mutate / CI session gates. DEFAULT ABSENT = off (monorepo-safe). Env LOCUS_ENFORCE wins over config when set. Set firm=true for production fleets (profile → enforce when enforce is unset); never default firm to true in monorepo.

| Path | Type | Required | Description |
| --- | --- | --- | --- |
| `locus.enforce` | `string` enum: `'off'` \| `'warn'` \| `'enforce'` | no | off: no probe; warn: log blockers allow dispatch; enforce: fail closed. Unset and absent config both mean off. Explicit enforce beats firm profile. |
| `locus.firm` | `boolean` | no | Firm profile for production fleets. When true and enforce is unset (and LOCUS_ENFORCE env is unset), resolveLocusEnforceMode returns enforce. Default false/absent — monorepo stays off. Env LOCUS_ENFORCE always wins (including LOCUS_ENFORCE=off). Set via: ashlr config set locus.firm true |

## `genome`

Shared-memory / genome settings (M7).

| Path | Type | Required | Description |
| --- | --- | --- | --- |
| `genome.maxRecall` | `integer` (>= 0) | yes | Max number of recall hits returned/injected (default 5). |
| `genome.injectOnRun` | `boolean` | yes | Whether `ashlr run` injects top-k recall into sub-agent prompts (default true). |

## `plugins`

M33 plugin-system configuration. Default empty — enabled:[] means no plugins load.

| Path | Type | Required | Description |
| --- | --- | --- | --- |
| `plugins.enabled` | array of `string` (/^[a-z][a-z0-9-]{0,39}$/) | no | Plugin names that are permitted to load. |
| `plugins.enabled[]` | `string` (/^[a-z][a-z0-9-]{0,39}$/) | - |  |
| `plugins.settings` | `object` (patterned; closed) | no | Per-plugin key/value settings. |
| `plugins.settings/^[a-z][a-z0-9-]{0,39}$/` | `object` | - |  |
| `plugins.integrity` | `object` (patterned; closed) | no | Per-plugin sha256 integrity pins. |
| `plugins.integrity/^[a-z][a-z0-9-]{0,39}$/` | `string` (/^sha256:[0-9a-f]{64}$/) | - |  |

## `foundry`

v4/v5 autonomous-fleet configuration (M45+). Full key reference: docs/FOUNDRY-CONFIG.md. Declared exhaustively from AshlrConfig['foundry'] in src/core/types.ts (M340b). additionalProperties stays true: KNOWN_FOUNDRY_KEYS in src/core/effective-config.ts is the authoritative typo/unknown-key detector at config-load time (an accompanying human-readable warning, not a hard validation failure) and currently recognizes several keys this schema does not yet model 1:1 (e.g. acePlaybook, localization, redTeam, feedbackEnabled, stallIdleMs, strategistModel, managerJudgeModel, managerJudgeEngine, inventPerCycle, blastRadius) plus operator-extension keys consumed by tooling outside this package. This schema is documentation/editor metadata only; it is not loaded or enforced by any code path in src/.

| Path | Type | Required | Description |
| --- | --- | --- | --- |
| `foundry.runOutputPersistence` | `object` (1 key; closed) | no | Privacy-sensitive durable raw run-output capture. Default disabled; only enabled:true persists files. Live CLI streaming is unaffected. |
| `foundry.runOutputPersistence.enabled` | `boolean` | no | Exact opt-in. Absent or false means no run-output file is created. |
| `foundry.executionIdentityV1` | `object` (3 keys; closed) | no | Default-off, shadow-only execution-account policy. Contains opaque references only; runtime paths and Phantom references live in the internal 0600 private store. |
| `foundry.executionIdentityV1.enabled` | `boolean` | no | Master switch. Default false. |
| `foundry.executionIdentityV1.shadowOnly` | const `true` | no | V1 has no live-dispatch mode and accepts only true. |
| `foundry.executionIdentityV1.identities` | array of `object` (4 keys; closed) | no |  |
| `foundry.executionIdentityV1.identities[]` | `object` (4 keys; closed) | - |  |
| `foundry.executionIdentityV1.identities[].ref` | `string` (/^eid_[0-9a-f]{32}$/) | yes |  |
| `foundry.executionIdentityV1.identities[].engine` | enum: `'builtin'` \| `'local-coder'` \| `'ashlrcode'` \| `'aw'` \| `'claude'` \| `'codex'` \| `'hermes'` \| `'kimi'` \| `'nim'` \| `'opencode'` \| `'meta-muse'` \| `'grok'` | yes |  |
| `foundry.executionIdentityV1.identities[].privateRuntimeLocatorRef` | `string` (/^erl_[0-9a-f]{32}$/) | yes |  |
| `foundry.executionIdentityV1.identities[].plan` | one of 5: | yes |  |
| `foundry.executionIdentityV1.identities[].plan<1>` | `object` (3 keys; closed) | - |  |
| `foundry.executionIdentityV1.identities[].plan<1>.kind` | const `'subscription'` | yes |  |
| `foundry.executionIdentityV1.identities[].plan<1>.class` | enum: `'codex-max'` \| `'codex-custom'` | yes |  |
| `foundry.executionIdentityV1.identities[].plan<1>.maxConcurrent` | `integer` (>= 1; <= 9007199254740991) | yes |  |
| `foundry.executionIdentityV1.identities[].plan<2>` | `object` (3 keys; closed) | - |  |
| `foundry.executionIdentityV1.identities[].plan<2>.kind` | const `'agent-credit'` | yes |  |
| `foundry.executionIdentityV1.identities[].plan<2>.class` | const `'claude-agent-sdk-credit'` | yes |  |
| `foundry.executionIdentityV1.identities[].plan<2>.maxConcurrent` | `integer` (>= 1; <= 9007199254740991) | yes |  |
| `foundry.executionIdentityV1.identities[].plan<3>` | `object` (3 keys; closed) | - |  |
| `foundry.executionIdentityV1.identities[].plan<3>.kind` | const `'interactive-reserved'` | yes |  |
| `foundry.executionIdentityV1.identities[].plan<3>.class` | const `'claude-max'` | yes |  |
| `foundry.executionIdentityV1.identities[].plan<3>.maxConcurrent` | const `0` | yes |  |
| `foundry.executionIdentityV1.identities[].plan<4>` | `object` (3 keys; closed) | - |  |
| `foundry.executionIdentityV1.identities[].plan<4>.kind` | const `'local'` | yes |  |
| `foundry.executionIdentityV1.identities[].plan<4>.class` | const `'local-runtime'` | yes |  |
| `foundry.executionIdentityV1.identities[].plan<4>.maxConcurrent` | `integer` (>= 1; <= 9007199254740991) | yes |  |
| `foundry.executionIdentityV1.identities[].plan<5>` | `object` (3 keys; closed) | - |  |
| `foundry.executionIdentityV1.identities[].plan<5>.kind` | const `'metered'` | yes |  |
| `foundry.executionIdentityV1.identities[].plan<5>.class` | const `'api-metered'` | yes |  |
| `foundry.executionIdentityV1.identities[].plan<5>.maxConcurrent` | `integer` (>= 1; <= 9007199254740991) | yes |  |
| `foundry.allowedBackends` | array of `string` | no | Backends the fleet may use. Absent means ['builtin'] only. |
| `foundry.allowedBackends[]` | `string` | - |  |
| `foundry.autonomyControlLoop` | `boolean` | no | M308: executable autonomy control loop gating daemon dispatch. Default true when foundry is present. |
| `foundry.repairHandoffV2Write` | `boolean` | no | Reader-first migration gate for objective-scoped repair handoff schema v2. Default false. |
| `foundry.repairHandoffV2Activation` | `object` (2 keys; closed) | no | CLI-issued identity for the current v2 writer activation epoch. |
| `foundry.repairHandoffV2Activation.id` | `string` | yes | Fresh UUID minted when the writer transitions disabled to enabled. |
| `foundry.repairHandoffV2Activation.activatedAt` | `string` | yes | Canonical ISO timestamp recorded with the activation identity. |
| `foundry.models` | `object` (map to `string`) | no | Per-backend preferred model id, keyed by EngineId. |
| `foundry.models.*` | `string` | - |  |
| `foundry.claude5` | `object` (2 keys; closed) | no | M320: Claude 5 generation rollout (Sonnet 5 workhorse + Fable 5 judge/strategist). Absent means enabled. |
| `foundry.claude5.enabled` | `boolean` | no | Master switch. Default true. |
| `foundry.claude5.fable` | `boolean` | no | Use Fable 5 as default judge/strategist with fallback to opus-4-8. Default true. |
| `foundry.modelGranularRouting` | `object` (2 keys; closed) | no | M323: model-granular cost-aware learned routing. DEFAULT OFF. |
| `foundry.modelGranularRouting.enabled` | `boolean` | no | Master switch. Default false. |
| `foundry.modelGranularRouting.minShipRate` | `number` (>= 0; <= 1) | no | Minimum learned ship-rate for the cost-aware pick. Default 0.6. |
| `foundry.bestOfN` | `number` | no | M170/M333: best-of-N candidate generation count. Default 1 (single dispatch). |
| `foundry.bestOfNCandidates` | array of `object` (2 keys; closed) | no | M333: per-candidate engine/model specs for multi-model best-of-N. |
| `foundry.bestOfNCandidates[]` | `object` (2 keys; closed) | - |  |
| `foundry.bestOfNCandidates[].engine` | `string` | yes |  |
| `foundry.bestOfNCandidates[].model` | `string` `null` | no |  |
| `foundry.bestOfNMinItemScore` | `number` | no | M333: fan out only for work items whose score >= this threshold. |
| `foundry.outcomeWatcher` | `boolean` | no | M332: observation-only revert/follow-up watcher. DEFAULT ON; false disables. |
| `foundry.verifyToGreen` | `object` (4 keys; closed) | no | M331: verify-to-green bounded engine repair loop before filing a proposal. DEFAULT OFF. |
| `foundry.verifyToGreen.enabled` | `boolean` | no | Master switch. Default false. |
| `foundry.verifyToGreen.maxIterations` | `integer` (>= 1; <= 5) | no | Max repair iterations. Default 3. |
| `foundry.verifyToGreen.perRunTimeoutMs` | `integer` (>= 1) | no | Per repair-run timeout in ms. Default 180000. |
| `foundry.verifyToGreen.failureTailBytes` | `integer` (>= 1) | no | Verification-failure tail bytes fed back to the engine. Default 8192. |
| `foundry.sandboxExternal` | `boolean` | no | Run external engines inside a sandbox with diff capture. Default true when foundry is set. |
| `foundry.timeoutMs` | `integer` (>= 1) | no | Hard wall-clock per external run (ms). Default 20 minutes. |
| `foundry.completenessGate` | `boolean` | no | M275: completeness + self-verify gate before filing a proposal. DEFAULT true. |
| `foundry.mergeAuthority` | array of `object` (2 keys; closed) | no | Allowlist for the merge-authority gate: a proposal may auto-apply to main only if its {engine,model} matches an entry here. |
| `foundry.mergeAuthority[]` | `object` (2 keys; closed) | - |  |
| `foundry.mergeAuthority[].engine` | `string` | yes |  |
| `foundry.mergeAuthority[].model` | `string` | yes |  |
| `foundry.limits` | `object` (map to `object` (2 keys; closed)) | no | M46: per-backend rate limits for subscription backends, keyed by EngineId. Absent means unlimited. |
| `foundry.limits.*` | `object` (2 keys; closed) | - |  |
| `foundry.limits.*.window` | `string` | yes | Rolling window label, e.g. '1m'\|'5m'\|'1h'\|'1d'. |
| `foundry.limits.*.max` | `integer` | yes | Max dispatches per rolling window. |
| `foundry.engines` | `object` (open) | no | M50 (v5): declarative engine roster (EngineSpec per key). Overrides/extends BUILTIN_ENGINE_REGISTRY. Absent means exactly the builtin roster. See EngineSpec in src/core/types.ts. |
| `foundry.nim` | `object` (6 keys; closed) | no | M195: NVIDIA NIM backend config (OpenAI-compatible cloud inference). Entirely opt-in. |
| `foundry.nim.baseUrl` | `string` | no | Default 'https://integrate.api.nvidia.com/v1'. |
| `foundry.nim.model` | `string` | no | Default 'moonshotai/kimi-k2.6'. |
| `foundry.nim.apiKeyEnv` | `string` | no | Env var NAME holding the bearer API key. Default 'NVIDIA_NIM_API_KEY'. |
| `foundry.nim.tier` | `string` enum: `'local'` \| `'mid'` \| `'frontier'` | no | Trust tier for routing. Default 'frontier'. |
| `foundry.nim.maxConcurrent` | `integer` (>= 0) | no |  |
| `foundry.nim.costPerMTokenOut` | `number` (>= 0) | no |  |
| `foundry.kimi` | `object` (3 keys; closed) | no | Kimi/Moonshot resource hints (engine normally defined via foundry.engines.kimi). |
| `foundry.kimi.maxConcurrent` | `integer` (>= 0) | no |  |
| `foundry.kimi.costPerMTokenOut` | `number` (>= 0) | no |  |
| `foundry.kimi.tier` | `string` enum: `'local'` \| `'mid'` \| `'frontier'` | no | M270: promotes the kimi engine spec's tier (engine-registry.ts applyKimiConfig). |
| `foundry.fleetMcp` | `boolean` | no | M248: guarantee fleet sandboxed engines inherit ashlr-plugin MCP tools. DEFAULT true. |
| `foundry.minItemValue` | `number` | no | M124: backlog value filter floor. Default 2. |
| `foundry.scanTodos` | `boolean` | no | M136: TODO/FIXME marker scanner toggle. DEFAULT false. |
| `foundry.scanDeps` | `boolean` | no | M160: dependency-bump/npm-audit scanner toggle. DEFAULT false. |
| `foundry.scanDependencyBumps` | `boolean` | no | M271: mechanical npm-outdated package bump scanner toggle. DEFAULT false. Requires scanDeps=true. |
| `foundry.scanLint` | `boolean` | no | M160: lint-error scanner toggle. DEFAULT false. |
| `foundry.scanHygiene` | `boolean` | no | M160: repo-hygiene (README/LICENSE/CONTRIBUTING) scanner toggle. DEFAULT false. |
| `foundry.goalPlanning` | `boolean` | no | M222: goal to milestones auto-planning. DEFAULT true. |
| `foundry.leaderPreferences` | `object` (3 keys; closed) | no | Operator daily Leader run preferences. Absent full limit is 3; total is 8 with check-ins or 3 without. Explicit null removes a business ceiling, not spend/seat/authority checks. |
| `foundry.leaderPreferences.maxFullRunsPerDay` | `integer` `null` (>= 1; <= 9007199254740991) | no |  |
| `foundry.leaderPreferences.maxTotalRunsPerDay` | `integer` `null` (>= 1; <= 9007199254740991) | no |  |
| `foundry.leaderPreferences.maxGrokLanes` | `integer` `null` (>= 1; <= 9007199254740991) | no |  |
| `foundry.goalPreferences` | `object` (4 keys; closed) | no | Operator goal preferences. Absent fields retain defaults 4/3/3/3; explicit null removes a preference limit. Signed authority and finite memo transport still apply. |
| `foundry.goalPreferences.maxOpenGoals` | `integer` `null` (>= 1; <= 9007199254740991) | no |  |
| `foundry.goalPreferences.maxNewGoalsPerDay` | `integer` `null` (>= 1; <= 9007199254740991) | no |  |
| `foundry.goalPreferences.maxGoalProposalsPerMemo` | `integer` `null` (>= 1; <= 9007199254740991) | no |  |
| `foundry.goalPreferences.maxGoalsPerConductorCycle` | `integer` `null` (>= 1; <= 9007199254740991) | no |  |
| `foundry.goalFocusMode` | `boolean` | no | Defer new planning-goal expansion / generative invention while active goals have pending milestones. DEFAULT true. |
| `foundry.goalFocusActiveThreshold` | `number` | no | Active actionable-goal threshold for goalFocusMode. Default 4. |
| `foundry.browserVerify` | `boolean` | no | M167: headless browser verification of web-app renders after a diff. DEFAULT false (opt-in). |
| `foundry.visualGrounding` | `object` (10 keys; closed) | no | Pluggable visual grounding layer for screenshot/document perception. DEFAULT false. |
| `foundry.visualGrounding.enabled` | `boolean` | no |  |
| `foundry.visualGrounding.provider` | `string` enum: `'locateanything-http'` \| `'generic-openai-vision'` | no |  |
| `foundry.visualGrounding.endpoint` | `string` | no |  |
| `foundry.visualGrounding.model` | `string` | no |  |
| `foundry.visualGrounding.query` | `string` | no |  |
| `foundry.visualGrounding.apiKeyEnv` | `string` | no |  |
| `foundry.visualGrounding.timeoutMs` | `integer` (>= 1) | no |  |
| `foundry.visualGrounding.maxImageBytes` | `integer` (>= 1) | no |  |
| `foundry.visualGrounding.licenseAccepted` | `boolean` | no |  |
| `foundry.visualGrounding.allowRemoteEndpoint` | `boolean` | no |  |
| `foundry.usePhantom` | `boolean` | no | M168: opt-in phantom-secret injection for fleet verification/integration tasks. DEFAULT false. |
| `foundry.diffSafety` | `boolean` | no | M158: destructive-diff pre-judge guard. DEFAULT true. |
| `foundry.tasteCritic` | `boolean` | no | M183: frontier TASTE critic for best-of-N selection. DEFAULT false. |
| `foundry.routingPolicy` | `string` enum: `'balanced'` \| `'cost'` \| `'quality'` | no | M128: intelligent model-granular routing policy. Absent means 'balanced'. |
| `foundry.learnedRouting` | `boolean` | no | M240: bias engine/model selection using causally identifiable, authenticated outcomes. DEFAULT false; exact opt-in only. |
| `foundry.modelRacing` | `object` (3 keys; closed) | no | M166: model-racing + distillation dataset. DEFAULT DISABLED. |
| `foundry.modelRacing.enabled` | `boolean` | yes |  |
| `foundry.modelRacing.localEngine` | `string` | no | Defaults to 'local-coder'. |
| `foundry.modelRacing.frontierEngine` | `string` | no | Defaults to 'claude'. |
| `foundry.intelligence` | `object` (4 keys; closed) | no | M53: fleet-intelligence tuning (learned routing / budget recovery / anomaly holds). Absent means off. |
| `foundry.intelligence.anomalyK` | `number` | no | Default 4. |
| `foundry.intelligence.minFrontierSuccessRate` | `number` (>= 0; <= 1) | no | Default 0.5. |
| `foundry.intelligence.minProposalYieldRate` | `number` (>= 0; <= 1) | no | Default 0.2. |
| `foundry.intelligence.dispatchYieldWindowHours` | `number` | no | Default 24. |
| `foundry.pulseEmit` | `boolean` | no | M214: emit GenAI-OTel spans to Pulse OTLP ingest. DEFAULT false. |
| `foundry.skillLibrary` | `boolean` | no | M243: skill-library write-back for realized merge proposals. DEFAULT true. |
| `foundry.judgePerPass` | `integer` (>= 0) | no | M259: max frontier-judge calls per runAutoMergePass tick. Default 8. |
| `foundry.autoArchiveAfterRejects` | `integer` (>= 0) | no | M259: auto-archive proposals after K consecutive non-ship verdicts. Default 3. |
| `foundry.proposalTtlDays` | `number` (>= 0) | no | M259: TTL for pending proposals in days. Default 7. Set 0 to disable. |
| `foundry.simpleConductor` | `boolean` | no | M280: use the flat-task dispatch loop instead of the goal-conductor. DEFAULT false. |
| `foundry.resourceAwareDispatch` | `boolean` | no | M300: check resource snapshot before dispatch and reroute to a fallback engine when exhausted. DEFAULT true. |
| `foundry.dispatchRetries` | `integer` (>= 0) | no | M297: bounded retry count for transient external-agent aborts. Default 2. |
| `foundry.killSwitch` | `boolean` | no | Test/operator kill flag for sandboxed dispatch, more restrictive than the global ~/.ashlr/KILL switch only. |
| `foundry.engineFallbackOrder` | array of `string` | no | M300: fallback engine preference order when the primary engine is exhausted. Default ['codex','kimi','nim','local-coder']. |
| `foundry.engineFallbackOrder[]` | `string` | - |  |
| `foundry.autoMerge` | `object` (13 keys; closed) | no | M47: tiered-trust auto-merge to main. DEFAULT DISABLED. |
| `foundry.autoMerge.enabled` | `boolean` | yes |  |
| `foundry.autoMerge.trustBasis` | `string` enum: `'tier'` \| `'verification'` \| `'evidence'` | no | M153: authority model for Gate 4. Default 'tier'. |
| `foundry.autoMerge.maxRisk` | `string` enum: `'low'` \| `'medium'` \| `'high'` | no | Default 'low'. |
| `foundry.autoMerge.managerGate` | `boolean` | no | Optional pass-level manager quality gate. Default false. |
| `foundry.autoMerge.allowSelfMerge` | `boolean` | no | Default false. |
| `foundry.autoMerge.maxAutomergeFiles` | `integer` (>= 1; <= 9007199254740991) | no | Default 4. Positive safe integer; standing-grant execution is capped by the explicitly signed policy. Configuration only tightens that policy. |
| `foundry.autoMerge.maxAutomergeLines` | `integer` (>= 1; <= 9007199254740991) | no | Default 150. Positive safe integer; standing-grant execution is capped by the explicitly signed policy. Configuration only tightens that policy. |
| `foundry.autoMerge.pushToRemote` | `boolean` | no | Stage/push a reviewed branch and open a protected PR handoff; never merges the hosted PR. Default false. |
| `foundry.autoMerge.protectedRemote` | `object` (2 keys; closed) | no |  |
| `foundry.autoMerge.protectedRemote.branchProtection` | `boolean` | yes |  |
| `foundry.autoMerge.protectedRemote.requiredChecks` | array of `any` | yes |  |
| `foundry.autoMerge.protectedRemote.requiredChecks[]` | `any` | - |  |
| `foundry.autoMerge.protectedRemotes` | array of `object` (7 keys; closed) | no | Optional exact repository-bound protected-pr-handoff-v1 expectations. Presence selects registry mode without a global fallback. Does not grant direct merge or bypass authority. |
| `foundry.autoMerge.protectedRemotes[]` | `object` (7 keys; closed) | - |  |
| `foundry.autoMerge.protectedRemotes[].nameWithOwner` | `string` (length 0..512) | yes |  |
| `foundry.autoMerge.protectedRemotes[].repositoryId` | `string` (length 0..256) | yes | Opaque authenticated GitHub GraphQL repository node ID, not the numeric REST ID. |
| `foundry.autoMerge.protectedRemotes[].defaultBranch` | `string` (length 0..256) | yes |  |
| `foundry.autoMerge.protectedRemotes[].operation` | const `'protected-pr-handoff-v1'` | yes |  |
| `foundry.autoMerge.protectedRemotes[].branchProtection` | `boolean` | yes |  |
| `foundry.autoMerge.protectedRemotes[].requiredChecks` | array of `object` (2 keys; closed) | yes |  |
| `foundry.autoMerge.protectedRemotes[].requiredChecks[]` | `object` (2 keys; closed) | - |  |
| `foundry.autoMerge.protectedRemotes[].requiredChecks[].context` | `string` (length 1..256) | yes |  |
| `foundry.autoMerge.protectedRemotes[].requiredChecks[].appId` | any of 2: | yes |  |
| `foundry.autoMerge.protectedRemotes[].requiredChecks[].appId<1>` | `string` (/^[1-9][0-9]{0,19}$/) | - |  |
| `foundry.autoMerge.protectedRemotes[].requiredChecks[].appId<2>` | `integer` (>= 1; <= 9007199254740991) | - |  |
| `foundry.autoMerge.protectedRemotes[].observedRulesetBypassActors` | array of `object` (6 keys; closed) | yes |  |
| `foundry.autoMerge.protectedRemotes[].observedRulesetBypassActors[]` | `object` (6 keys; closed) | - |  |
| `foundry.autoMerge.protectedRemotes[].observedRulesetBypassActors[].rulesetId` | `string` (/^[1-9][0-9]{0,19}$/) | yes |  |
| `foundry.autoMerge.protectedRemotes[].observedRulesetBypassActors[].sourceType` | enum: `'Repository'` \| `'Organization'` \| `'Enterprise'` | yes |  |
| `foundry.autoMerge.protectedRemotes[].observedRulesetBypassActors[].source` | `string` (length 1..512) | yes |  |
| `foundry.autoMerge.protectedRemotes[].observedRulesetBypassActors[].actorType` | const `'RepositoryRole'` | yes |  |
| `foundry.autoMerge.protectedRemotes[].observedRulesetBypassActors[].actorId` | `string` (/^[1-9][0-9]{0,19}$/) | yes |  |
| `foundry.autoMerge.protectedRemotes[].observedRulesetBypassActors[].bypassMode` | enum: `'always'` \| `'pull_request'` | yes |  |
| `foundry.autoMerge.midToBranch` | `boolean` | no | M56 (v5): permit mid-tier proposals to auto-apply to a branch/PR, never main. Default false. |
| `foundry.autoMerge.allowWithoutVerification` | `boolean` | no | Permit auto-merge when no verification commands are detected. Default false (fail-closed). |
| `foundry.autoMerge.verifyBeforeJudgePerPass` | `integer` (>= 0) | no | Max verification-before-judge runs per auto-merge pass. Default judgePerPass. |
| `foundry.generative` | `boolean` | no | M181: generative engine ('rip mode') — invent bold net-new features. DEFAULT false (opt-in). |
| `foundry.confinement` | `object` (map to `object` (4 keys; closed)) | no | M52: per-engine OS-level confinement profiles, keyed by EngineId or '*' for a fleet-wide default. Absent means v4 env-only containment. |
| `foundry.confinement.*` | `object` (4 keys; closed) | - |  |
| `foundry.confinement.*.mode` | `string` enum: `'off'` \| `'os'` | no | Default 'off'. |
| `foundry.confinement.*.readAllowed` | array of `string` | no |  |
| `foundry.confinement.*.readAllowed[]` | `string` | - |  |
| `foundry.confinement.*.networkEgress` | `boolean` | no | Default false. |
| `foundry.confinement.*.onUnsupported` | `string` enum: `'fallback'` \| `'fail'` | no | Default 'fallback'. |
| `foundry.fabric` | `object` (8 keys; closed) | no | M247/SPEC-INFERENCE-FABRIC: InferenceGateway config. DEFAULT ABSENT means byte-identical to pre-M247. |
| `foundry.fabric.gateway` | `boolean` | no | Enable the InferenceGateway. Default false. |
| `foundry.fabric.gatewayShadow` | `boolean` | no | M334: observe-only shadow mode beside legacy routing. Default false. |
| `foundry.fabric.cacheShadow` | `boolean` | no | M249: RunCache shadow measurement mode. Default false. |
| `foundry.fabric.cache` | `boolean` | no | M250: live cache short-circuit (not yet implemented). Default false. |
| `foundry.fabric.resourceAware` | `boolean` | no | M250: resource-aware backend demoting. Requires gateway=true. Default false. |
| `foundry.fabric.concurrentDispatch` | `boolean` | no | M255: dispatch across all backends with headroom in parallel. Requires gateway=true. Default false. |
| `foundry.fabric.maxSlotsPerBackend` | `integer` (>= 0) | no | M255: max concurrent slots per backend. Default 3. |
| `foundry.fabric.workhorseDispatch` | `boolean` | no | M256: spread local-mid bulk items across workhorse backends. Requires concurrentDispatch=true. Default false. |
| `foundry.productionVelocity` | one of 2: | no | Production velocity profile. DEFAULT OFF. Boolean shorthand or an explicit resource-control profile object. |
| `foundry.productionVelocity<1>` | `boolean` | - |  |
| `foundry.productionVelocity<2>` | `object` (8 keys; closed) | - |  |
| `foundry.productionVelocity<2>.enabled` | `boolean` | no |  |
| `foundry.productionVelocity<2>.profile` | `string` enum: `'off'` \| `'resource-control'` | no |  |
| `foundry.productionVelocity<2>.fillQueueToSlots` | `boolean` | no |  |
| `foundry.productionVelocity<2>.stalePendingTtlHours` | `number` | no |  |
| `foundry.productionVelocity<2>.maxSlotsPerBackend` | `integer` (>= 0) | no |  |
| `foundry.productionVelocity<2>.localMaxConcurrent` | `integer` (>= 0) | no |  |
| `foundry.productionVelocity<2>.nimMaxConcurrent` | `integer` (>= 0) | no |  |
| `foundry.productionVelocity<2>.kimiMaxConcurrent` | `integer` (>= 0) | no |  |
| `foundry.claudeResource` | `object` (7 keys; closed) | no | M250 Resource Control Plane: Claude subscription-window resource caps. |
| `foundry.claudeResource.fiveHourMessageCap` | `number` | no |  |
| `foundry.claudeResource.fiveHourTokenCap` | `number` | no |  |
| `foundry.claudeResource.weeklyTokenBudget` | `number` | no |  |
| `foundry.claudeResource.weeklyCostBudgetUsd` | `number` | no |  |
| `foundry.claudeResource.weeklyMessageCap` | `number` | no |  |
| `foundry.claudeResource.window` | `string` | no | Default '7d'. |
| `foundry.claudeResource.protectPct` | `number` | no | Default 85. |
| `foundry.resourceOverrides` | `object` (map to `object` (8 keys; closed)) | no | Operator resource overrides for known external capacity events (e.g. vendor weekly lockout), keyed by engine/backend id. Expired overrides are ignored automatically. |
| `foundry.resourceOverrides.*` | `object` (8 keys; closed) | - |  |
| `foundry.resourceOverrides.*.availability` | `string` enum: `'open'` \| `'near'` \| `'throttled'` \| `'exhausted'` \| `'unreachable'` \| `'unknown'` | no |  |
| `foundry.resourceOverrides.*.until` | `string` `number` | no |  |
| `foundry.resourceOverrides.*.resetsAt` | `number` | no |  |
| `foundry.resourceOverrides.*.reason` | `string` | no |  |
| `foundry.resourceOverrides.*.usedPct` | `number` | no |  |
| `foundry.resourceOverrides.*.cap` | `number` | no |  |
| `foundry.resourceOverrides.*.capUnit` | `string` `null` enum: `'messages'` \| `'tokens'` \| `'requests'` \| `'concurrent'` \| `null` | no |  |
| `foundry.resourceOverrides.*.capWindow` | `string` | no |  |
| `foundry.local` | `object` (2 keys; closed) | no | M250 Resource Control Plane: local/Ollama concurrency config. |
| `foundry.local.maxConcurrent` | `integer` (>= 0) | no | Default 1. |
| `foundry.local.baseUrl` | `string` | no | Default 'http://localhost:11434'. |
| `foundry.edvVerify` | `boolean` | no | M151: opt-in EDV (independent/external) verification signal folded into backlog item scoring. DEFAULT false. |
| `foundry.ashlrcodeExecutor` | `boolean` | no | M185: gate for the `ashlrcode` (ac) autonomous executor path. DEFAULT false. |
| `foundry.specContract` | `boolean` | no | Spec-contract acceptance-criteria checking gate. DEFAULT false (disabled). |
| `foundry.repoMap` | `boolean` | no | Inject a lightweight repo map into sandboxed-engine prompts. DEFAULT false. |
| `foundry.proposalRepair` | `boolean` | no | Repair-treatment maintenance pass toggle. DEFAULT true (opt-out via false). NOT YET present in KNOWN_FOUNDRY_KEYS (src/core/effective-config.ts) as of this pass. |

## `daemon`

Daemon loop tuning (M22+): budget caps, tick interval, parallelism, cooldowns.

| Path | Type | Required | Description |
| --- | --- | --- | --- |
| `daemon.dailyBudgetUsd` | `number` (>= 0; <= 9007199254740991) | no | Explicit daily USD preference. Default 1; 0 stops the loop. Fractional amounts are supported. Does not expand signed spend authority. |
| `daemon.perItemMaxTokens` | `integer` (>= 1; <= 9007199254740991) | no | Token allowance for proven zero-dollar producers. Default 50000; model and runtime context limits still apply. Metered producers retain the USD-derived allowance. |
| `daemon.perTickItems` | `integer` `null` (>= 1; <= 9007199254740991) | no | Requested backlog items per tick. Null removes the operator ceiling; absent defaults to 3; queue, durable journal, account, and resource admission still apply. |
| `daemon.parallel` | `integer` `null` (>= 1; <= 9007199254740991) | no | Requested batch concurrency. Null removes the operator ceiling; absent defaults to 2; available work and actual resource admission still apply. |
| `daemon.maxConcurrent` | `integer` `null` (>= 1; <= 9007199254740991) | no | Requested continuous concurrency. Explicit null removes the operator ceiling and overrides total; absent defaults to concurrency.total or 8; actual admission still applies. |
| `daemon.concurrency` | `object` (3 keys; closed) | no | Requested per-tier concurrency. Null removes an operator ceiling; absent defaults local 2, cloud 6, total 8; does not expand signed scope or provider capacity. |
| `daemon.concurrency.local` | `integer` `null` (>= 1; <= 9007199254740991) | no |  |
| `daemon.concurrency.cloud` | `integer` `null` (>= 1; <= 9007199254740991) | no |  |
| `daemon.concurrency.total` | `integer` `null` (>= 1; <= 9007199254740991) | no |  |
| `daemon.agentOsObserver` | `object` (3 keys; closed) | no | Default-off observation-only Agent OS compiler. This block grants no execution or effect authority. |
| `daemon.agentOsObserver.enabled` | `boolean` | no | Exact opt-in. Absent or false schedules no observer child. |
| `daemon.agentOsObserver.deadlineMs` | `integer` (>= 100; <= 30000) | no |  |
| `daemon.agentOsObserver.trustPolicy` | `object` (4 keys; closed) | no |  |
| `daemon.agentOsObserver.trustPolicy.schemaVersion` | const `1` | yes |  |
| `daemon.agentOsObserver.trustPolicy.protocol` | const `'ashlr-agent-os-source-trust-v1'` | yes |  |
| `daemon.agentOsObserver.trustPolicy.generation` | `integer` (>= 0) | yes |  |
| `daemon.agentOsObserver.trustPolicy.keys` | array of `object` (8 keys; closed) | yes |  |
| `daemon.agentOsObserver.trustPolicy.keys[]` | `object` (8 keys; closed) | - |  |
| `daemon.agentOsObserver.trustPolicy.keys[].keyId` | `string` (/^[a-f0-9]{64}$/) | yes |  |
| `daemon.agentOsObserver.trustPolicy.keys[].principalDigest` | `string` (/^(sha256:)?[a-f0-9]{64}$/) | yes |  |
| `daemon.agentOsObserver.trustPolicy.keys[].role` | enum: `'source-observer'` \| `'evidence-index-observer'` \| `'outcome-observer'` | yes |  |
| `daemon.agentOsObserver.trustPolicy.keys[].signatureAlgorithm` | const `'ed25519'` | yes |  |
| `daemon.agentOsObserver.trustPolicy.keys[].publicKeySpki` | `string` (length 1..1024) | yes |  |
| `daemon.agentOsObserver.trustPolicy.keys[].notBefore` | `string` | yes |  |
| `daemon.agentOsObserver.trustPolicy.keys[].notAfter` | `string` | yes |  |
| `daemon.agentOsObserver.trustPolicy.keys[].revokedAt` | `string` `null` | yes |  |

## `reasoning`

V3.10 reasoning store (src/core/reasoning/). Stored reasoning is scrubbed, local-only, 0600, and never replayed into prompts.

| Path | Type | Required | Description |
| --- | --- | --- | --- |
| `reasoning.codexDesktop` | `boolean` | no | Also ingest interactive Codex Desktop rollouts, not just non-interactive `codex exec` ones. Default false (personal sessions need explicit opt-in); ASHLR_REASONING_CODEX_DESKTOP=1 also enables it. |

## `devin`

3.15 Devin lane (src/core/devin/). Off unless enabled is exactly true; `ashlr devin connect` turns it on after storing the API key in the macOS Keychain. The key is never read from or written to this file.

| Path | Type | Required | Description |
| --- | --- | --- | --- |
| `devin.enabled` | `boolean` | no | Turn the Devin lane on. Default false. |
| `devin.fleet` | `boolean` | no | Let the fleet launch Devin on well-scoped backlog work without a click. Still needs a standing grant whose stage names the devin engine (producer-only seat) and the repo, the budget mode, and the Devin budget's reserve and fleet caps. Devin PRs merge only when two judges from different families (never Devin) ship them. Default false. |
| `devin.mode` | `string` enum: `'normal'` \| `'fast'` \| `'lite'` \| `'ultra'` | no | SessionCreateRequest.devin_mode, pinned so the producer is a known agent mode (fusion is not accepted). Default normal. |
| `devin.fleetModel` | `string` (/^[a-z0-9][a-z0-9._-]{0,63}$/) | no | The model the fleet's local Devin CLI engine (devin-cli) runs. Default swe-2-high. Only the free SWE-2 models (swe-2-high, swe-2-medium, swe-2-max) run under autonomy; a billed model holds the lane because its spend cannot be read back. |
