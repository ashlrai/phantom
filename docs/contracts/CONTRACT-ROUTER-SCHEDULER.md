# Router scheduler contract

Pure planning surface for the coding-pool drain tick. Assignments do not spawn
work, open pull requests, or grant merge authority. `postIssues` is fixed
`false`.

## Types

- `SchedulerPoolId`: `codex-primary`, `codex-secondary`, `claude`, `devin`, `grok-build`, `local`, `grok-ultra-weekly`, `metered`.
- `UltraConsumer`: `orchestrator` | `cloud-agent`.
- `SchedulerJob`: `{ id, jobType, role?, minTier?, quotaByPool?, requireAssignment? }`.
- `RouterDecision.grantsMergeAuthority`: the literal `false`.
- `Assignment.grantsMergeAuthority`: the literal `false`.

## Functions

- `loadSchedulerConfig({ path?, overrides? }) -> SchedulerConfig`. Missing file falls back to the embedded defaults. `postIssues` stays false.
- `projectUltra(config, events, nowMs) -> UltraProjection`. Estimate. `quotaReadableFromApi` is false.
- `schedule(input) -> Promise<ScheduleResult>`. Deterministic given `jobs`, `nowMs`, config, events, host, bandit, candidate, seed, and the solver. `valueOverride` replaces the learned value for one job and pool.
- `runDrainTick(input) -> Promise<DrainTickResult>`. `spawned` and `merged` are false.
- `updateBandit(state, outcome) -> BanditState`.
- `promoteIfBetter({ incumbent, candidate, rows, config, minRows? }) -> Promotion`. Promotes only when doubly robust replay is strictly better.
- `computeRegret({ outcomes, bandit, config, epsilon? }) -> RegretItem[]`.
- `writeRegretBacklog(file, backlog) -> void`. Writes `postIssues: false`.
- `createTelemetry({ enabled? }) -> SchedulerTelemetry`. Disabled emit is a no-op.
