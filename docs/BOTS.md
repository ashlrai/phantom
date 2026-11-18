# Phantom Bots

Bots describe outcomes, not providers. Metadata grants no execution, repository,
transport or spending authority.

| Devin Bot concept | Provider-neutral Phantom primitive |
| --- | --- |
| Chat | Owner thread: `src/core/comms/`, [owner thread](OWNER-THREAD.md) |
| Child sessions | Agent Bus handoffs: [Agent Bus](AGENT-BUS.md) |
| Automations | Existing automations store; bot triggers are references only |
| Needs-you | `needsYou` attention metadata; not approvals |
| Memory | Pointer to existing skills/memory: [skills](SKILLS.md) |
| Connections, secrets, grants | Agent profiles, scoped Secrets references and standing authority; no credentials in bot records |
| Templates | `src/core/agents/bot-templates.ts` (legacy template records remain separate) |
| Slack | Existing channel policy and bridge: [agent network](AGENT-NETWORK.md) |
| iMessage | Existing owner-thread channel adapter: [channels](CHANNELS.md) |
| Usage limits | Generic router quota, capacity and cost-class admission |
| Access/sharing | Agent profiles and channel allowlists; per-bot sharing UI is a gap |

External bots can join as optional provider-neutral [bot seats](BOT-SEATS.md), with quota evidence, draining handoffs and an advisory Devin Bot adapter.

## Phantom Bots schema and CLI

`phantom-bot.v1` records live at `~/.phantom/bots/<id>/bot.json`, alongside
the existing bot folder convention. Records contain outcome, repos, triggers,
profile reference, memory pointer, channels and needs-you items. `lanePolicy`
contains only queue vocabulary: `needs`, `min_tier`, `max_tier`,
`max_cost_class` and optional `data_class`. Cost defaults to `included`;
only `local` or `included` are accepted, never `metered`. `work_class` is not
routed yet and is rejected. Vendor, engine, pool, lane, fallback pins and
preferred-lane fields are rejected.

```sh
phm bots list --json
phm bots show helper --json
phm bots create --dry-run --id helper --outcome "Review changes" --profile helper --json
phm bots explain helper --json
```

Creation is plan-only: without `--dry-run` it refuses.
Optional create flags `--needs` (comma-separated), `--min-tier`, `--max-tier`
and `--max-cost-class` override the empty-needs, fast-to-frontier, included defaults.
The core store has an
explicit create-only writer, but the CLI never calls it. A plan writes only the
bot record if explicitly stored by a caller; profile/automation provisioning is not implemented.

Explain is read-only and advisory: it never dispatches or calls model backends.
It uses the existing TypeScript router across lanes in the connected routing
snapshot (`models.json`, `queue/slots.json`, `queue/admission.json`,
`queue/route-request.json`, `queue/route-capacity.json`). `ASHLR_RUNS_DIR`
selects the snapshot root. Missing snapshots yield a null lane, never a guess.
The minimum requested tier is used, within the validated tier ceiling.
Explain uses master's `routeCandidateRejections(..., {failover:true})` to
filter candidates, `decideRoute` for the primary and `planFallbackChain` for
up to three alternatives, without fallback pins. Rejected lanes carry the
master router's reason codes. Slot evidence declares capabilities, tiers and
cost class; capacity freshness uses `observedAt` in `queue/route-capacity.json`.
The master router rejects exhausted, stale or unmeasured capacity and expired
resets. A null reset date alone need not reject measured remaining capacity.
Unknown stays unknown, never invented zero. Ranking retains master's reset
pressure preference; `near_reset` is a supported fallback failure kind, not a
new bot-specific near-reset threshold. The fallback plan is advisory and live
failover dispatch remains unwired. Posture evidence is included read-only.

Master's strict failover requires explicit opt-in for `codex-local`/`omlx`.
Bots never pin lanes, so these appear rejected with `local_opt_in_required`
until a provider-neutral local opt-in exists (next step).

## Next step: live triggers

Not implemented. Reuse existing resident-daemon phases with deadlines,
AbortSignal cancellation and status ledgers; see [daemon tick phases](daemon-tick-phases.md).
Do not introduce a parallel scheduler or bypass existing admission and KILL gates.
