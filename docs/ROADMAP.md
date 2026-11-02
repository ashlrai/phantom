# Phantom roadmap

Product direction lives in [VISION.md](VISION.md). This file is milestone
history plus the invariants that still bind the code. Contracts in
[docs/contracts/](./contracts/) state commitments. For an ID-by-ID status
lookup, see [`docs/MILESTONE-INDEX.md`](./MILESTONE-INDEX.md) before citing a
milestone number as evidence of what shipped. [CHANGELOG.md](../CHANGELOG.md)
is what shipped, in release order.

> **Historical/design context — not current runtime activation guidance.**
> Current compiled daemon and conductor trust roots remain empty.
> "Shipped" below means source and test delivery, not live runtime authority.
> `DAEMON_ACTIVATION_TRUST_ROOTS` and `GOAL_CONDUCTOR_ACTIVATION_TRUST_ROOTS`
> in `src/core/daemon/activation-permit.ts` are empty. Owner-invoked
> `ashlr goal "<objective>"` remains a live proposal-only plan-and-advance path.

## Design principles

1. **Choose the provider on purpose.** A model connects through a subscription
   login, a command-line agent, an API key, or a local model. Local listeners
   stay on loopback unless the operator persists an opt-in
   (`gateBindHost` in `src/core/local-runtime/llama/config.ts`,
   `src/core/run/local-inference.ts`).
2. **Autonomy with gates on consequential actions.** Routine work can proceed
   under a signed standing grant. The vision keeps main merges frontier-only,
   excludes local or unparseable endpoints from merge and credential roles,
   and preserves Tier-1 protection. See [VISION.md](VISION.md). The old line that an
   agent-reachable approve path would never exist is withdrawn. The code is
   still stricter than that sentence: `applyProposal` in
   `src/core/inbox/apply.ts` requires an approved proposal and `confirmed:
   true`, and `autoMergeProposal` stays off unless
   `cfg.foundry.autoMerge.enabled` is set (`src/core/inbox/merge.ts`).
   The default `tier` trust basis refuses non-frontier main merges; configured
   `verification` and `evidence` trust bases use separate gates in the same
   module. This documentation grants no new authority. A normal loopback model can
   still run coder, reviewer, and planner (`supportsRoleExecution` in
   `src/core/run/role-invocation.ts`). That gap is listed in
   [VISION.md](VISION.md).
3. **Safety by construction, proven by tests.** Enrollment gating, the kill
   switch, sandboxed execution, an append-only audit, and secret scrubbing
   each need a named adversarial test.
4. **Contracts-first.** A milestone is a contract doc, regression tests, and
   an implementation, in that order.
5. **Add runtime dependencies only when the product needs them.** The
   manifest is the inventory. MCP is the plug-in standard. The old claim of
   zero runtime dependencies except the MCP SDK does not match
   [ARCHITECTURE.md](ARCHITECTURE.md).

## Shipped

- **v1 (M1–M20)** — desktop command center: index/navigate/scaffold, local
  agent runs, MCP gateway, genome memory, observability, onboarding.
- **v2 (M21–M30)** — autonomous engineering organization: enrollment,
  sandboxed swarms, work discovery, the daemon, the approval inbox, portfolio
  RAG, health scoring, goals, reflection, cloud-ready seams.
- **v2.1 (H1–H8)** — harden & prove: crash recovery, concurrency stress,
  safety-invariant regression suites, guided activation, reproducible demo.
- **v2.2 (M31–M33)** — agent-native ecosystem: native MCP tools + CLI-first
  agent contract (`orient`, `docs --agent`), the living web command center
  (inbox approvals, cost estimates), plugins, npm distribution
  (`@ashlr/hub`), public programmatic API.
- **v3-Weapon (M41–M44)** — make local models an engineering weapon: adaptive
  model-sized prompts, the sandboxed engineering tool surface (write/edit/bash
  confined to a worktree, diffs → inbox), the verify→repair loop, and `ashlr
  eval`. See [`docs/SPEC-V3-LOCAL-WEAPON.md`](./SPEC-V3-LOCAL-WEAPON.md).
- **v4-Foundry (M45–M49)** — the autonomous engineering fleet: multi-backend
  sandboxed engines (`runEngineSandboxed`, push severed, diff-only,
  trust-tagged), backend router + rate/quota, the tiered-trust merge-to-`main`
  gate with HMAC-signed provenance (M47.1), the 24/7 supervisor, and the fleet
  control plane. See [`docs/SPEC-V4-FOUNDRY.md`](./SPEC-V4-FOUNDRY.md).
- **v5-Open-Fleet (M50–M55)** — polyglot, self-improving, conducted: a
  declarative engine registry + a real OpenAI-compatible API client (Hermes,
  OpenCode, NVIDIA NIMs, Kimi K2.7, … added config-only); a third trust tier
  (`mid`); OS-level confinement (macOS `sandbox-exec`/Linux seccomp read-jail +
  egress gate) closing v4's read-residual; learned routing + budget-breach
  recovery + cost-anomaly holds; the fleet pointed at its OWN source behind a
  never-weaken guard + self-eval harness; and the `ashlr goal` / `ashlr loop`
  (+ `/goal`, `/loop`) conductor. See
  [`docs/SPEC-V5-OPEN-FLEET.md`](./SPEC-V5-OPEN-FLEET.md).
- **v5.1 Claude 5 Model Intelligence (M320–M324)** — the Claude 5 generation
  wired into the fleet: Sonnet 5 (`claude-sonnet-5`) as the frontier routing
  workhorse and Fable 5 (`claude-fable-5`, Mythos-class) as the default
  judge/strategist with automatic Opus 4.8 fallback (`cfg.foundry.claude5`);
  spelling-variant-safe merge authority (`canonicalModelTag`); judge-cost
  telemetry + per-model ROI (`computeModelRoi`: ship-rate, latency,
  cost-per-merged-proposal); and cost-aware model-granular learned routing
  (`cfg.foundry.modelGranularRouting`, default off) with producer-attributed
  ship-rates — the fleet routes to the cheapest model that ships. Every
  milestone flag-gated with byte-identical-off parity suites.
- **v6-Verification-First (M331–M336)** — generation → verification: the
  `run-tests` keystone (activates tests-green best-of-N selection) + the
  verify-to-green repair loop (`cfg.foundry.verifyToGreen`, same confined
  worktree, re-signed provenance); the outcome watcher linking real-world
  reverts/follow-up fixes back onto judge traces and into learned routing;
  multi-model best-of-N races (`bestOfNCandidates`) with full-cost
  accounting and loser archival; the staged dormant-flag activation program
  (gateway shadow mode + [`CONTRACT-M334`](./contracts/CONTRACT-M334.md));
  the dashboard **Models** tab (`/api/models`: ship rate, cost-per-merge,
  reverts, best-of-N win rates); and the `ashlr eval swe-bench --gate`
  regression gate (exit 3 on a newly-broken task or resolve-rate drop —
  wire into CI/cron).

<a id="historical-near-term-list-stale--kept-for-reference-only"></a>

## Removed near-term list

A stale v2.3 backlog used to live here (first public release at `v2.2.0`,
plugin seeding, an estimator learning loop, web command-center depth, and an
agent-contract v2). It named package 3.2.0. `package.json` is now 3.29.15.
Those five items are deleted. Direction is [VISION.md](VISION.md). Milestone
status is [`docs/MILESTONE-INDEX.md`](./MILESTONE-INDEX.md).

## v3 — Team Command Center (gate opened 2026-06-12, NOT YET BUILT)

The team / multi-machine backbone is specced: see
[`docs/SPEC-V3-TEAM.md`](./SPEC-V3-TEAM.md) — one team memory, one approval
inbox (approve anywhere, owning machine applies), coordinated daemons, and
team visibility, riding the existing api.ashlr.ai backend under `/hub/v1/*`.
Milestones M34–M40, contracts-first, registered as an ashlr goal 2026-06-12.

**As of this pass, none of M34–M40 has shipped.** No `test/m34.*` through
`test/m40.*` exist; `hub/v1` and `ASHLR_API_URL` are absent from `src/`. What
exists today is the M30 local-only seam layer, deliberately gated to throw
(`src/core/seams/identity.ts:45`, `src/core/seams/daemon-coordinator.ts:79`).
"Gate opened" means a goal was registered and the spec was written. It does
not mean the milestones were delivered. See `docs/MILESTONE-INDEX.md` and
the status banner at the top of `docs/SPEC-V3-TEAM.md`. A hosted team
backbone is not the product in [VISION.md](VISION.md).

<a id="gated-future-explicitly-not-scheduled"></a>

## Not the current product

- **A public hosted service.** SPEC-V3-TEAM is unbuilt, and `ASHLR_API_URL`
  is absent from `src/`. [VISION.md](VISION.md) is a local open-source
  assistant, not a hosted multi-tenant product.
- **In-process plugin fetch.** Plugins in [PLUGINS.md](PLUGINS.md) remain
  files you place locally and enable explicitly. A registry-style install
  for MCP servers is a gap in [VISION.md](VISION.md), not a ban.
- **OS-level plugin sandboxing.** Out of scope for the in-process plugin
  loader. The trust model there is gating, least privilege, tamper evidence,
  and audit ([PLUGINS.md](PLUGINS.md)).

## How to influence this

Open a GitHub issue with the problem. Product direction is
[VISION.md](VISION.md). Anything that touches a safety invariant starts as a
contract draft in docs/contracts/.
