# AGENTS.md: agent constitution

## Use Phantom before you edit

Install, then read the command list. Follow [docs/AGENT-MCP-CLI.md](docs/AGENT-MCP-CLI.md) verbatim for the MCP gateway on Claude, Cursor, and Codex. Do not treat a successful command as permission to merge or spend.

```sh
npm install -g @ashlr/phantom
phm docs --agent --json
phm mcp list --json
phm wire status --json
```

Indexes: [docs/llms.txt](docs/llms.txt) and [docs/llms-full.txt](docs/llms-full.txt).

This repository is part of the AshlrAI ecosystem. It is maintained by Phantom (`phm improve` / steward) and other coding agents, under the same standing authority that applies to `ashlrai/phantom` (see phantom `docs/STANDING-AUTHORITY.md`).

## Article 1: Full autonomy, always forward

Synced from the Ashlr Fleet Constitution v3.0 (Nov 1, 2026). This overrides any older text in this file.

**Full autonomy, always forward (Mason t1287u, Nov 1 2026 11:47 PM ET).** Every agent may merge PRs to main and push to production (releases through each repo's sanctioned workflow, any agent may dispatch them). Take the human out of the loop; let nothing slow us down; do the highest-leverage, most ambitious work. No approval, manual-merge, wait-for-per-PR-CI or ask-Mason steps. Mason is needed only for passwords, 2FA, device approvals and payments. The only kept limits are Security GATES v3, the hold list below, and making private things public. Any new gate must be justified against this article or it is rejected.

### Hard floor (the only fixed rules)
- Security GATES v3: pins only on the secret gate (scrub.pl, secret-shape gate, publish.sh), sandbox profiles and leader wrappers/prompts/plists, secret-leaking workflow diffs, and the MACCU TCC helper plus loopback auth. No force-push to default branches, no ruleset or admin bypass, no ~/.codex auth changes, no billing changes, no secret values in logs.
- Merge-queue required checks stay where a repo has them; full CI daily; main-guardian fixes main forward.
- Fork-only pushes through publish.sh. Local models loopback-only.
- Mason only for passwords, 2FA, device approvals and payments (no new spending without him). Nothing private made public.
- Hold list (Mason's own holds): phantom #197 #878 #743 #725 #738 #744 #693 #1228; phantom-secrets #140 #197 #375 #168 #418 #136; ashlr-plugin #152 #157.

## Tools for agents working here
- This repo's `.mcp.json` declares five companion MCP servers: `phantom-secrets`, `locus`, `lexicon`, `stack`, `ashlr` (Ashlr.AI Plugin). What each is for, its limits, and how to approve it: [docs/AGENT-TOOLCHAIN.md](docs/AGENT-TOOLCHAIN.md).
- In a Phantom cloud task, list the companion tools you actually called in the report's `toolsUsed` field (an empty list if none); `phm cloud list` shows it as the session's claim.
- Team membership: `phm team invite <gh-user>`, `phm team join <invite>` and `phm team remove <gh-user>` are human-terminal commands for owners/admins and invitees (agent processes are refused); an invite grants membership only and never credentials. See [docs/TEAM.md](docs/TEAM.md#invite-join-and-remove-a-teammate).

## Agents may
- Create branches, commit, and open pull requests.
- Turn on GitHub auto-merge (`gh pr merge --auto`; `phm improve propose` opens draft PRs only and refuses `--auto-merge`). Merge to main and ship to production on your own, with no human approval or manual merge; fix main forward. Never use an admin override.
- Fix CI, tests, docs, and dependencies, and iterate on review feedback.

## Kept limits (Article 1)
- Rotating, creating, or exposing secrets and tokens; no secret values in logs or chat.
- Force-pushing to the default branch, ruleset or admin bypass, or deleting repositories.
- Spending money, billing, or paid-plan changes (needs Mason).
- Outside messages: emails, posts, issues, or comments directed at people outside AshlrAI.
- Releases and publishes run through each repo's sanctioned release workflow, which any agent may dispatch.

## Ground rules
- Keep diffs small and reviewable, with one concern per PR.
- Never commit secrets. Use Phantom Secrets placeholders.
- Never force-push to the default branch.

## Working in this repository
- Node `>=22.15.0`. Install trusted local worktrees with `npm run install:worktree` (pnpm 10.28.2, shared same-volume store; CI/releases keep `npm ci`), build with `npm run build`, run the CLI from source with `npm run dev -- <command>`.
- Backend tests: `npm test` for all backend suites, or `npm run test:ci -- test/<file>.test.ts` for affected suites with the hermetic runner. Run tests with a temporary HOME, for example `HOME=$(mktemp -d) npm run test:ci -- test/agents-md-audit.test.ts`.
- Before a PR: automated workers run `node scripts/verify-changed.mjs` once, in the foreground; do not poll it. Repeat runs on an unchanged tree exit early (`SKIP verify-changed`); pass `--force` to rerun. This replaces worker runs of full `npm run typecheck` and `npm run lint`. Humans may still use `npm run lint` and `npm run typecheck`. Also run `npm run check:docs` and the affected tests (`npm run test:ci -- test/<file>.test.ts`, `npm run test:web` for `src/web-ui`). `npm run gate` runs build, static checks and related tests together. Its import graph cannot select tests that read changed files as text; run those test files explicitly. Merge Gate stays the full check; local checks do not replace required hosted CI.
- Queue tiers: router-queue `tier=` must be `frontier`, `work`, `mid` or `fast`. `queuegen` and `router-lint` refuse any other value (`standard` means `work`), because dispatchd skips unknown tiers silently. See [docs/QUEUE.md](docs/QUEUE.md#tier-values).
- Layout: `src/cli/` command dispatchers, `src/core/` logic, `src/web-ui/` console, `test/` backend suites (`m<N>.<topic>.test.ts`), `docs/` guides indexed by `docs/README.md`.
- Mac dispatcher: `contrib/mac/dispatchd.py` is the single source for the live `~/.ashlr-runs/bin/dispatchd.py`. Change it here, never on the host. `contrib/mac/install.sh` diffs and installs it (plus `install-gate.py` and `launch-gate.sh`) with timestamped backups, but only after Security has reviewed and re-pinned the files; agents preview with `contrib/mac/install.sh --dry-run --json` and never run it against the live directory. Copy-paste install, once pinned: `contrib/mac/install.sh --json`. See [contrib/mac/README.md](contrib/mac/README.md#installing-the-dispatcher).
- Learned skills: `phm skills list --json` shows skills written from merged PR outcomes (metadata only, scrubbed, capped; counts real or `"unknown"`). See [docs/SKILLS.md](docs/SKILLS.md).
- Channels: `phm channels add <kind>` writes config only (credentials stay in existing custody, never printed); `phm channels status --json` reports real counts or `"unknown"`. See [docs/CHANNELS.md](docs/CHANNELS.md).
- Briefs: the fleet brief-send verb (dry run by default, `--json` for the plan) plans the morning (7:30 ET) or overnight (22:30 ET) brief with a needs-you list of at most 5 items; `--apply` sends to your own channels, one per slot per local day. See [docs/BRIEF-SEND.md](docs/BRIEF-SEND.md).
- Read next: [docs/AGENT-OPERATIONS.md](docs/AGENT-OPERATIONS.md) (setup and operation), [CONSTITUTION.md](CONSTITUTION.md), [CONTRIBUTING.md](CONTRIBUTING.md), [docs/CONSOLE-LAYOUT.md](docs/CONSOLE-LAYOUT.md) (web console width breakpoints).
- Resident daemon ticks are phased and bounded: every awaited stage has a deadline, an AbortSignal and a status record; `phm daemon status --json | jq .tick.phases` shows the last tick's ledger. See [docs/daemon-tick-phases.md](docs/daemon-tick-phases.md).

## Coding and verification conventions

- Use TypeScript with ESM imports. Keep CLI dispatch in `src/cli/` thin and implementation logic in `src/core/`; follow nearby modules and [CONTRIBUTING.md](CONTRIBUTING.md).
- Keep backend tests in `test/` and web component tests beside their components. Add regression coverage for changed behavior; never weaken a test or security control to pass a check.
- Do not read or print real credentials, environment dumps, or secret values. Use Phantom Secrets references and Locus for scoped account access; see [the toolchain guide](docs/AGENT-TOOLCHAIN.md).
- Report the exact commands run, failures and remaining limitations. Keep documentation commands aligned with [package.json](package.json); the [AGENTS.md audit](docs/AGENTS-MD-AUDIT.md) records public-source gaps across the seven repos.

Node router: `phm node join|beat|enqueue|plan|pull|renew|complete|status|leave --json` joins this computer to the router. A job's owner scope decides which nodes see it; a lease and fencing token keep it from running twice; auth stays local and jobs carry secret names only. See [Add a computer in 60 seconds](docs/add-a-computer.md) and the [node router](docs/NODE-ROUTER.md).

Lane health: `phm lanes health --json` prints calls, error rate, p50 latency and
deployed commit per lane over 12 h, and flags runs stuck past their phase
timeout; unmeasured figures are `null`. See [lane health](docs/LANE-HEALTH.md).

Standing lane freshness: `phm fleet lane-slots --json` reads the Fleet screen's
API projection. Mirror prep publishes observations every minute; each repo has
a three-minute prep deadline. See [lane freshness](docs/FLEET-LANE-FRESHNESS.md).

## Publish subscription capacity

Copy-paste: `phm capacity publish --json`. Run on each node with its own local auth;
usage metadata only, never credentials. Resident daemons publish at startup and
on a timer outside ticks. Follow failure recovery instructions; see
[capacity publication](docs/RESOURCE-EVIDENCE.md#publish-subscription-capacity).

Read the dispatcher starvation signals and admission decision (read-only):

```sh
phm pool admission --json
```

Job latency: `phm fleet job-latency --jobs jobs.jsonl --json` ranks measured
queue wait, checkout, model, CI and merge time and supplies a proposed fix line
for each measured phase. It is read-only; fix lines are proposals, not queued
jobs. Records use `job` (or `job_id`/`jobId`), `event` and `ts` (or
`timestamp`/`at`). Boundaries are `queued`, `launch`, `checkout_complete`,
`finish`, `ci_start`, `ci_complete`, and `merged` (also an `outcome` with
`MERGED`). IDs must identify individual attempts. Missing, reversed or
ambiguous repeated boundaries are reported as unmeasured, not estimated;
phase totals need not cover the whole wall time. Existing ledgers may not yet
contain all boundaries.

Merge queue drift protection: the Quick typecheck job runs the CODEOWNERS and
Tier-1 import closure checks on every PR and merge queue candidate, including
docs-only changes. A new Tier-1 test needs its generated CODEOWNERS entry in the
same PR; changed Tier-1 imports need a reviewed closure snapshot update. Drift
fails the existing Merge Gate even when the full authority shards do not run.

Route hysteresis: ready.tsv pool proposals pass through dispatchd's persisted
60-minute residency, immutable launch pool and two-moves/six-hours cap. Only
explicit auth failure or zero quota permits early movement. See
[route hysteresis](docs/ROUTE-HYSTERESIS.md) for replay, `phm route explain --json`
and the Security pin handoff. Never install a candidate over the live pinned file.

Parked dependency gates (RQ-QUEUE-AUTOUNPARK-1): `contrib/mac/restock.py` parks
`after=` lines as `PARKED-DEP.<lane>` with a `DEPENDENCY GATE:` id list, then
auto-unparks when `metrics/jobs.jsonl` shows every id `MERGED` (log
`UNPARK <job> deps=<ids>`; prompt text including `no merge without Security pin`
is preserved). Copy-paste:

```sh
phm fleet parked --json
```

`unmetDeps` lists parked rows whose gate ids are still unmet. Restock.py changes
need a Security re-pin before live `bin/` install; do not install yourself.

Durable memory: `phm memory add|list|search|forget --json` stores Mason's
preferences, doctrine and facts as markdown under `~/.phantom/memory/`; see
[memory](docs/MEMORY.md). Secret-shaped text is refused, never store values.

Connector profiles: `phm connectors add|list|remove|show|import --json` manages
`~/.phantom/connectors/profile.toml`; see [connector profiles](docs/CONNECTORS.md).
Use vault names only. Import withholds inline credentials; Codex requires a
lane-owned CODEX_HOME under `~/.ashlr-runs`, never `~/.codex`.
