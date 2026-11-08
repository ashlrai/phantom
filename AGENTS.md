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
- Check provider capacity before launching work: `phm resource --cards --json` (usage numbers only, shown as unknown when unread). Guide: [docs/PROVIDER-CARDS.md](docs/PROVIDER-CARDS.md).

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
- Agent Bus v2: the provider contract (participants, body kinds, claim keys and overlap rules, work feed) is in [docs/AGENT-BUS.md](docs/AGENT-BUS.md#v2); `ashlr agents bus contract --json` prints its schema version and kinds. Claims coordinate and grant no execution authority. Schemas: `src/core/agents/bus-v2-schema.ts`.
- Learned skills: `phm skills list --json` shows skills written from merged PR outcomes (metadata only, scrubbed, capped; counts real or `"unknown"`). See [docs/SKILLS.md](docs/SKILLS.md).
- Channels: `phm channels add <kind>` writes config only (credentials stay in existing custody, never printed); `phm channels status --json` reports real counts or `"unknown"`. See [docs/CHANNELS.md](docs/CHANNELS.md).
- Slack bridge: `phm channels slack status --json` reads the `[slack]` section of `~/.ashlr/agent-network.toml`, token `phm_` reference names (never values) and journal counts; `phm channels slack map --json` dry-runs the topic/channel mapping and, with `--snapshot <file>`, the team-only audience gates. Read-only; the socket, token injection and post path are the separately reviewed `-sec` change. See [docs/AGENT-NETWORK.md](docs/AGENT-NETWORK.md#slack-bridge).
- iMessage intake: `phm imessage doctor --json` reports permission and config state (no handles printed); `phm imessage poll --json` is a counts-only dry run and `--apply` receipts allowlisted messages as channel `imessage`. Acks are recorded, never sent, until RQ-IMSG-REPLY-1 lands. Never read or print message text or handles. See [docs/IMESSAGE.md](docs/IMESSAGE.md).
- Briefs: the fleet brief-send verb (dry run by default, `--json` for the plan) plans the morning (7:30 ET) or overnight (22:30 ET) brief with a needs-you list of at most 5 items; `--apply` sends to your own channels, one per slot per local day. See [docs/BRIEF-SEND.md](docs/BRIEF-SEND.md).
- Tenancy: `phm whoami --json` shows your person, teams, orgs and scopes; `phm org list --json` lists your orgs. Nodes, jobs, leases, forum threads and context packs are owner-scoped, and identity comes only from this machine's local auth ([docs/TENANCY.md](docs/TENANCY.md)).
- Read next: [docs/AGENT-OPERATIONS.md](docs/AGENT-OPERATIONS.md) (setup and operation), [CONSTITUTION.md](CONSTITUTION.md), [CONTRIBUTING.md](CONTRIBUTING.md), [docs/CONSOLE-LAYOUT.md](docs/CONSOLE-LAYOUT.md) (web console width breakpoints).
- Resident daemon ticks are phased and bounded: every awaited stage has a deadline, an AbortSignal and a status record; `phm daemon status --json | jq .tick.phases` shows the last tick's ledger. See [docs/daemon-tick-phases.md](docs/daemon-tick-phases.md).

## Coding and verification conventions

- Use TypeScript with ESM imports. Keep CLI dispatch in `src/cli/` thin and implementation logic in `src/core/`; follow nearby modules and [CONTRIBUTING.md](CONTRIBUTING.md).
- Keep backend tests in `test/` and web component tests beside their components. Add regression coverage for changed behavior; never weaken a test or security control to pass a check.
- Do not read or print real credentials, environment dumps, or secret values. Use Phantom Secrets references and Locus for scoped account access; see [the toolchain guide](docs/AGENT-TOOLCHAIN.md).
- Report the exact commands run, failures and remaining limitations. Keep documentation commands aligned with [package.json](package.json); the [AGENTS.md audit](docs/AGENTS-MD-AUDIT.md) records public-source gaps across the seven repos.

Node router: `phm node join|beat|enqueue|plan|pull|renew|complete|status|leave --json` joins this computer to the router. A job's owner scope decides which nodes see it; a lease and fencing token keep it from running twice; auth stays local and jobs carry secret names only. See [Add a computer in 60 seconds](docs/add-a-computer.md) and the [node router](docs/NODE-ROUTER.md).

Job cost: `phm job cost <id> --json` and loopback `GET /api/fleet/job/cost?id=<id>` read the runs metrics ledgers and report per-model-call tokens in/out, model and cost — real numbers or 'unknown', never fabricated. See [job cost](docs/JOB-COST.md).

Lane health: `phm lanes health --json` prints calls, error rate, p50 latency and
deployed commit per lane over 12 h, and flags runs stuck past their phase
timeout; unmeasured figures are `null`. See [lane health](docs/LANE-HEALTH.md).

Standing lane freshness: `phm fleet lane-slots --json` reads the Fleet screen's
API projection. Mirror prep publishes observations every minute; each repo has
a three-minute prep deadline. See [lane freshness](docs/FLEET-LANE-FRESHNESS.md).

Disk maintenance: `phm disk-maint` is a dry run that reports reclaimable bytes
per class; `--apply` rotates, compresses and deletes rebuildable leftovers and
reaps finished worktrees. `phm disk-maint schedule [--install]` prints or
installs the daily per-user job. The protect-list (`~/.codex*`, model weights,
Docker, client trees, `~/Documents`, git internals, auth, secrets) applies at
plan and apply time; gated classes (`venvs`, `hub-claude`) need `--allow`.
See [DISK-MAINT](docs/DISK-MAINT.md).

Report pages: `phm pages publish <file.md|file.json> --json` renders a report
into the loopback console at `/pages/<slug>`; `phm pages list --json` lists
published pages. Store is `~/.ashlr/pages`; nothing leaves the machine. See
[report pages](docs/PAGES.md).

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

Connector run: `phm connectors run github --scope repo-read --tool codex --lane work --json -- repo list --json name` is denied pending Security review; no process or credential resolution.

Connector profiles: `phm connectors add|list|remove|show|import --json` manages
`~/.phantom/connectors/profile.toml`; see [connector profiles](docs/CONNECTORS.md).
Use vault names only. Import withholds inline credentials; Codex requires a
lane-owned CODEX_HOME under `~/.ashlr-runs`, never `~/.codex`.

## Chief-of-staff intake

See [docs/COS.md](docs/COS.md) for the chief-of-staff ask and status commands:
`phm fleet cos ask "<text>" --channel <channel> --json` queues an intake job and
`phm fleet cos status <id> --json` reads it back. Top-level `cos` dispatch and
desktop custom-sink wiring still require an explicit named-file scope extension.
Intake jobs use `phm queue`; `done --result <text> --json` drafts the reply and
surfaces a needs-you item. Outbound results require explicit approval of the
displayed draft digest. Do not treat a queued job or result draft as send authority.


## Apps control

`phm apps list|open|quit|focus|status [--json]` manages desktop apps named in
`~/.ashlr/apps-allow.json` (empty by default). Copy and paste these commands;
see [APPS-CONTROL](docs/APPS-CONTROL.md):

```sh
phm apps list --json
phm apps status Notes --json
phm apps quit Notes --json
```

Allowlisted apps only, through the desktop adapter, every action logged to the
feed. A quit with unsaved work goes to needs-you (exit 3). No keystrokes, no
reading app contents, no TCC changes.

## Desktop control

`phm desktopctl capabilities|status|run <resource> [--json]` drives the Claude,
Codex and Devin desktop apps as interchangeable resources through the
`computer_*` tools, off until `~/.ashlr/desktopctl.json` holds
`{"enabled": true}`. Copy and paste these commands; see
[DESKTOPCTL](docs/DESKTOPCTL.md):

```sh
phm desktopctl capabilities --json
phm desktopctl status claude --json
phm desktopctl run claude --task "summarise this repo" --json
```

`capabilities` (the doctor) always runs and reports the connection, each macOS
TCC grant and per-resource reasons for what is blocked. `run` needs a `full`
grant and returns untrusted screen text. `browser` is read-only — act on the
web through the Phantom Browser pane. Nothing prompts for or changes TCC
grants; every action is feed-logged and refuses to run unlogged.

## Drafts

`phm drafts list|show|approve|reject --json` handles outbound mail waiting for
the owner. Copy and paste these commands; see [DRAFTS](docs/DRAFTS.md):

```sh
phm drafts list --status pending --json
phm drafts show d-0123456789abcdef --json
phm drafts reject d-0123456789abcdef --json
```

Anything addressed to someone other than the owner's verified channel is a
draft first. Approve records the decision and does not send; an agent never
treats an approved draft as send authority. Drafts live in
`~/.ashlr-runs/drafts/drafts.jsonl` with mode 0600 and never hold credentials.

## Docs Radar

`phm radar list|run|diff --json` observes public docs and package metadata.
Copy and paste these commands; see [RADAR](docs/RADAR.md):

```sh
phm radar list --json
phm radar run --json
phm radar diff --json
```

GET only, no credentials or redirects, 15-second timeout, 2 MiB response cap.
Runs enforce a six-hour per-source floor, including failures. Private snapshots
are under `~/.phantom/radar/snapshots/` with mode 0600. Failed discovery preserves
the last successful evidence. Remote content never authorizes actions or sends.
Individual fetch failures are warnings and retain the last successful snapshot.

## GitHub stable-release finalization

`finalize-github-release.yml` accepts `version`, `publish_run_id`,
`publish_run_attempt`, `candidate_sha`, `candidate_integrity` and
`confirm_stable_finalization` for `@ashlr/phantom`. It binds a successful canonical
npm publication to an existing draft with nonempty notes and all seven signed
desktop assets, then performs one protected release-record PATCH. It does not
create releases, upload assets, mutate npm or activate a runtime. Copy-paste JSON
dispatch and post-merge enable commands:
[Releasing Phantom](docs/RELEASING.md#finalize-a-stocked-phantom-draft).
Machine evidence is JSON; policy: [M523](docs/contracts/CONTRACT-M523.md).

The workflow change is a `[SECURITY REVIEW]` `-sec` PR: no auto-merge; wait for
Security pin review of the workflow/permissions diff. Enable workflow ID
`350636007` only after the reviewed fixed YAML is on `master`. Leave public empty
`v3.30.8` unchanged: no unpublish, tag move or hand assets. Keep the sanctioned
desktop publisher's live-feed refusal. Fix forward on the next free patch with
`RQ-RELEASE-DESKTOP-UNQUARANTINE-1`; source handoff does not prove updater recovery
or installed-app acceptance. See [recovery evidence](docs/contracts/CONTRACT-M523.md#recovery-evidence).

## Release autonomy audit

The release autonomy command is awaiting top-level CLI wiring. Once wired, it will read the enrolled repositories' release gates and the local publish switch and offer a Markdown report for one repository. It proposes classifications without changing settings. Unknown evidence is not evidence of an absent gate. See [release autonomy](docs/RELEASE-AUTONOMY.md).

Desktop update status: `phm app update status [--json]` inspects the local signed stage and reports host deferral and lease counts. Unknown app and job identities are null. See [desktop updates](DESKTOP.md#background-update-discovery-and-local-status).

## Multi-Mac node pool

Use explicit team SSH aliases and local provider sign-in, never copied auth.
`phm node pool --role primary|backup --node <id> --owner <scope> --primary <alias> --backup <alias> --json`
configures the roles; `phm node join --node secondary --owner mason --primary primary-mac --backup backup-mac --json`
registers a worker. `phm node watch [--once] --json` maintains primary heartbeat or
checks backup promotion. `phm node worker --runner /absolute/host-owned-runner --json`
runs one claimed job. `phm node list --json` and `phm node status --json` expose
lanes, load and heartbeat. `phm node rpc --json` is the fixed SSH stdin endpoint.
The backup witnesses every admission; after 15 minutes without heartbeat it takes
over and fences the returning primary. Publication remains primary-only. No
production dispatchd cutover or runner installation is performed. See
[Agent network](docs/AGENT-NETWORK.md) and [Nodes](docs/NODES.md).

Agent network channels: `phm agents bus channels list --json` and `phm agents bus channels test email --json` are offline dry runs. See [agent network channels](docs/AGENT-NETWORK-CHANNELS.md) for the default-deny policy and adapter contract.

Repository ranking: `phm repos rank --json` blends seed priority with local merged
PR recency and autonomy leverage, at most daily. `phm repos rank --recompute --json`
honors the same ceiling. `phm repos rank proposals --json` reads suggestions only;
enrollment remains a manual config change. See [repo ranking](docs/REPO-RANK.md).

## Import scheduled routines

Preview a local routines JSON array with `ashlr automations import --from routines.json --dry-run --json`, then import with `ashlr automations import --from routines.json --json`. Imports start disabled and skip existing names. See [Automations](docs/VERSE.md#automations-315) for the format and schedule restrictions.
Fleet HTTP contract: [docs/api/fleet-openapi.json](docs/api/fleet-openapi.json) is the machine-readable contract for the `phm verse` hub API: every route the remote phone gateway admits plus hub-only fleet routes, including version, runs glance, CI runs, drop-jobs and agent-bus. Read-only routes return JSON; see [docs/FLEET-API.md](docs/FLEET-API.md) and [llms.txt](docs/llms.txt) for copy-paste examples.
## Article 2: app source of truth

Use `phm app state --json` for the same `fleet.mission.v1` reading displayed
in Fleet Mission. See [the app state guide](docs/APP-STATE.md). Extend the
existing Mission API and Verse stream; agent communication uses `phm forum`
and `phantom_forum`. Unknown usage, queue positions and costs stay unknown.
<!-- docs-sync:commands:start -->
## CLI commands

| Command | Description |
| --- | --- |
| `agents` | List or test channel types offline without sending. |
| `app` | Inspect local desktop update status without downloading or installing. Read-only: reports current stage, available version, deferred reason, running job counts. Exit 0 success, 2 bad usage. |
| `apps` | Manage desktop apps named in ~/.ashlr/apps-allow.json (empty by default). Logged to the feed; quit with unsaved work goes to needs-you. |
| `ask` | Local RAG across the indexed portfolio; cites repo/file:line. --allow-cloud opt-in. `ask status` prints the ask.status.v1 stream from the metrics jobs ledger. |
| `audit` | Tail the append-only audit trail; --team lists workspace actions (read-only). |
| `authority` | Standing authority: grant state, autonomy switch, Stop, rollout stage, ledger chain and custody (read-only). |
| `automations` | Automations: labelled issues, a red default branch, RRULE schedules, a local webhook or Telegram /task become tasks for the fleet, cloud, Devin or review - with queue, per-day, concurrency and spend limits. |
| `autopilot` | Drive one of Phantom's own PRs to green: fix red CI and review feedback with an agent, merge a conflicting or behind base, re-run infra failures once, re-verify; stops and says why when a failure is not the PR's. Plan only unless --apply; never force-pushes or merges the PR. |
| `backlog` | Scored work queue across enrolled repos (issues, TODOs, tests, deps, docs, security, plugins, goals, hygiene, invention). |
| `benchmark` | Explicit local-agent benchmark trials, or offline matched-receipt comparison; real checkers and private traces. |
| `best-of-n` | Generate N candidate diffs (multi-model), critic-select, file the winner as a proposal (M142/M333). |
| `budget` | Per-pool remaining budget: show the ledger, or record a manual reading or parsed CLI/log output. Manual readings override automatic ones until their reset; raw output is never stored. |
| `bus` | Shared task board: local threads plus task claim, handoff, renew and release tied to fenced fleet queue claims. Cooperative labels only; no execution authority. |
| `capacity` | Refresh local subscription usage metadata once with this node’s local authentication. |
| `channels` | Bring a channel up (config only, credentials stay in custody), read the per-channel rollup, or inspect the Slack bridge mapping offline. |
| `checkpoint` | Save a handoff with a Git worktree inventory. See docs/AGENT-CHECKPOINT.md. |
| `ci-metrics` | Per-repo daily turn-time (red to green) metrics; writes ~/.ashlr/ci-metrics.json. |
| `cloud` | Start a Claude Code cloud session that delivers a draft PR (spends Claude credits; never merges). Repo defaults to this folder's GitHub origin. |
| `comms` | Operator comms channel (Telegram/iMessage): digests, approve-by-text. |
| `companions` | Read-only Secrets/Locus/Lexicon executable identity and version inventory; no runtime readiness or activation. |
| `completions` | Print a shell completion script to stdout. |
| `conductor-permit` | Dormant signed one-shot goal-conductor permit operator; fail-closed while source trust roots are empty. |
| `config` | Read/write a config value. `list` prints a summary; no args prints the path. |
| `connectors` | Manage credential-free connector profiles and import safe client metadata; vault references only. |
| `daemon` | Currently refuses before effects because compiled daemon trust roots are empty; use owner-invoked run/swarm or the dry-run form. |
| `daily-fix` | Daily CI re-run helper: validate dispatch inputs against the allowlist, preview the job/test filter, emit the gh workflow command, or aggregate fixup-queue lines. |
| `dash` | Alias of `tui` - interactive terminal dashboard. |
| `dashboard` | Open the persistent fleet dashboard service (ai.ashlr.serve); --status/--stop inspect or unload it (no install/repair - resident mutation is withheld). |
| `demo` | Watch the FULL autonomous chain run on a DISPOSABLE tmp repo (isolated tmp ~/.ashlr; proposal-only; auto-cleans). NEVER touches your portfolio or applies anything. |
| `desktop` | Inspect original signed app/CLI artifacts; explicitly install only on an empty macOS arm64 installation after Stop/drain. Does not resume authority. |
| `desktop-update` | Verify signed paired updates; apply after native exit, Stop/drain and unchanged active grant. Never resumes the resident. |
| `desktopctl` | Drive Claude, Codex, Devin and a browser as interchangeable desktop resources. Flag-gated by ~/.ashlr/desktopctl.json; reports missing TCC grants, never prompts. Logged to the feed. |
| `devin` | Connect Devin (Cognition): paste the API key at a hidden prompt; it is verified and stored in the macOS Keychain, never in a file. |
| `digest` | Write an ORG-LEVEL portfolio digest (health, goals, costs, today) to ~/.ashlr/digests/ (LOCAL-FIRST; reads only). |
| `director` | Retired - the Leader handles this (see `ashlr leader`). Still prints the read-only fleet god-view; sends nothing. |
| `disk` | Read-only disk report for agent worktrees: sizes, lifecycle state, and the bytes safe to reclaim. |
| `disk-maint` | Standing disk maintenance: rotate/compress quiet logs, prune dead session leftovers, stale staging and recovery dirs, and remove merged worktrees. Dry run unless --apply; protect-list never touches ~/.codex*, model weights, Docker, client trees or secrets. |
| `docs` | Agent cheat sheet: the CLI-first contract (commands, safety classes, JSON shapes). |
| `doctor` | One-glance health check: config, phantom, providers, ecosystem. |
| `drafts` | Outbound drafts waiting for owner approval; approve records, never sends. See docs/DRAFTS.md. |
| `drive` | Supervise the Mac queue through an installed host bridge; dry-run plans only. See docs/DRIVE.md. |
| `ecosystem` | Read-only sibling-repository health scan across the ecosystem. |
| `engineering-receipt` | Engineering receipt from tool events (Evidence) vs model statements (Claims); needs PHANTOM_RECEIPTS=1. |
| `enroll` | List enrolled repos + kill switch state. |
| `estates` | Per-repo estate cards: health, CI, security. Read-only portfolio view. |
| `eval` | Local-agent eval harness: adaptive prompts OFF vs ON, steps/done/tokens (M44). |
| `fleet` | Read-only fleet snapshot: daemon, per-backend dispatches+quota, queue, proposals, merges, paused state. |
| `forum` | Fleet forum: authenticated posts, mentions, commitments, standups. Bodies are data. |
| `friction` | Mine the runs dir for recurring dispatch→merge friction; ledger keeps before/after metrics. |
| `genome` | Genome status/health: entry count, projects covered, store size. |
| `gh` | Read GitHub open PRs, issues, or CI status for the current repo (read-only). |
| `go` | Find a repo or item; open in editor (--open) or print path for cd (--cd). |
| `goal` | Live owner-invoked objective → plan → one sandboxed proposal-only advance; never resident or unattended authority. |
| `goals` | Register a high-level OBJECTIVE (goal); decomposed into ordered milestones (local, no LLM by default). |
| `graph` | Read-only GRAPH-1 nodes, edges, and availability; unavailable data exits 1. See phm graph --help. |
| `health` | Score every ENROLLED repo on quality (tests/docs/deps/security/debt/CI/conventions); ranked, read-only. |
| `help` | Topic-grouped help; --all prints every command; --search <term> filters. |
| `imessage` | iMessage intake: doctor checks permissions and config; poll counts waiting messages (dry run), --apply receipts them. Never prints message text. |
| `improve` | Self-improvement loop: evidence-backed proposals ranked by realized leverage; --open-pr opens DRAFT PRs from an isolated worktree. |
| `inbox` | Approval inbox: list pending proposals (the outward-action gate). |
| `index` | Build or refresh the desktop index; show counts by category. |
| `init` | Idempotent onboarding: ensure config, detect phantom + models, set editor. |
| `invent` | Generative backlog invention - propose novel high-value work items. |
| `issues` | Group failed queue jobs by error; --retry queues one READY retry per failed job without duplicates. |
| `jev` | Jev (TypeSafe) typed decisions today: on/keyed, decisions by kind, avg confidence, fallback rate, est. cost, latency. Reads the local ledger only. |
| `knowledge` | Index enrolled repos locally (read-only, secret-scrubbed) for portfolio RAG. |
| `lanes` | Per-lane calls, error rate, p50 latency and deployed commit over 12 h; flags runs stuck past their phase timeout. |
| `leader` | The Leader (Visionary): show the latest memo and actions, run it now, apply due class-B actions (tick), veto an action or a whole memo (--memo). |
| `learn` | Append a note to shared genome memory (local-first, append-only). |
| `local-runtime` | Supervise the loopback llama-server serving runtime (parallel local fleet engine); manual and attended. |
| `loop` | Dormant non-dry conductor loop: compiled conductor trust roots are empty; use loop --dry-run. |
| `ls` | List all indexed items, optionally filtered by category. |
| `manager` | Frontier judge scorecard over pending proposals (shadow mode by default; never merges). |
| `mcp` | Run the MCP aggregation gateway on stdio (point any agent here; includes the native ashlr_* tools; list them with tools/list). |
| `memory` | Persistent agent memory: add, list, search, and forget entries (preference\|doctrine\|fact). Refuses secret-shaped text. See docs/MEMORY.md. |
| `metrics` | Estimate idle slot-minutes and flag long-running jobs from local snapshots. |
| `mirror` | The fleet's own mirror clones under ~/.ashlr/fleet/mirrors (your checkouts are never touched); reconcile plans enrollment from the grant (--apply). |
| `models` | List local models (Ollama/LM Studio); marks the active one. |
| `new` | Scaffold a project from a template (next-app, node-cli, mcp-server, minimal). |
| `node` | Join this computer to the node router: caps, owner-scoped jobs, fenced per-job leases. |
| `notify` | Send a test ping to the configured webhook(s); no-op if none are set. |
| `onboard` | Guided first safe activation: preflight → enroll ONE repo → optional Locus firm soft-offer → dry-run PLAN → point at `ashlr inbox`. TTY-aware; --yes/non-TTY prints steps (firm only with --locus-firm or ASHLR_LOCUS_FIRM=1). NEVER auto-applies. |
| `open` | Open the best match in your editor; no query opens an interactive picker. |
| `openai-agents` | Read bounded managed OpenAI Agents API metadata. API access is separate from subscriptions; no execution qualification or mutations. |
| `orient` | Session-start context: genome hits, health, backlog, pending proposals, attention (read-only). |
| `pages` | Publish a report into the loopback dashboard at /pages/<slug> (stored under ~/.ashlr/pages; nothing public). |
| `playbook` | Versioned task templates every lane runs under (`!fix-bug` in any task text): list them, show one with per-version outcomes, write a new version in $EDITOR, or run one in the cloud / Devin lane (`--repo o/n --lane cloud\|devin`). |
| `plugins` | Scaffold + manage plugins (~/.ashlr/plugins/) - default-off, integrity-pinned, audited (see docs/PLUGINS.md). |
| `pool` | Read-only load gate: loadavg, ncpu, running cap, install-lock holder and admit true/false with the reason. |
| `pr` | Read-only GitHub snapshot of open PRs per repo: counts, rework edges, hold markers, five-minute cache. Cannot merge or close. |
| `preflight` | Read-only first-activation readiness check: ready=true\|false + blockers/warnings (model/enrollment/kill/daemon/writeable/sandbox/git/phantom/locus); mutates nothing. |
| `pulse` | Local observability dashboard: tokens, cost, sessions, commits. |
| `pulse-export` | Fleet→pulse OTLP backfill/manual export. |
| `pulse-test` | Fleet→pulse connectivity + auth probe (read-only). |
| `queue` | Local per-station lambda, mu, rho, W and bottleneck; queue --help describes event input. |
| `radar` | Public docs observation: list sources, run independent fetches, and diff local snapshots. HTTPS GET only, no credentials. See docs/RADAR.md. |
| `recall` | Search shared genome memory; return top relevant entries with scores. |
| `receipt` | Read and verify signed run receipts (same as fleet receipt); timeline lists custody spawns in the run window, value-free (read-only). |
| `recovery` | Inspect bounded metadata-only prepared/committed tool-effect evidence. |
| `reflect` | Score your OWN past runs/swarms locally; report effectiveness/cost deltas (read-only). |
| `release-articles` | Configure release-backed article task handoffs; sync verifies public GitHub/npm evidence and never publishes directly. |
| `repos` | Repository scheduling rank from seed priority, local merged-PR recency and autonomy leverage (daily ceiling); proposals are read-only. |
| `resource` | Refresh the shared resource.v1 view in fleet.json from recorded inputs. |
| `resources` | Per-backend resource control plane: availability/used%/cap/resets-in (read-only god-view). |
| `roadmap` | Goal Loop: run a roadmap of milestone files, one FRESH agent process per milestone; resumable from state.json (LOCAL-FIRST; --allow-cloud for API engines). |
| `route` | Read dispatcher pools and route-moves-per-hour. |
| `router` | Rank supplied router decisions by pool budget reset; advisory, no writes. |
| `router-calibration` | Compare recorded router predictions with outcomes and usage. |
| `run` | Decompose goal into tasks; execute via local model (Ollama/LM Studio). |
| `runs` | List past runs (newest first). |
| `runtime` | Install exact offline candidate bytes into a private store; not production qualification or service activation. |
| `sandbox` | List active git-worktree sandboxes (M21 safety foundation). |
| `seams` | Cloud-ready seam diagnostic: every v2 store, active=local, cloud=gated (read-only). |
| `select` | Rank candidates by value x leverage / (time + usage), fund the top 5 as READY lines, record picks with predicted value. |
| `self-swap` | Plan a versioned install swap; apply builds, probes, flips current and drains the old supervised process. |
| `serve` | Start local web dashboard + JSON API on 127.0.0.1 (default port 7777). |
| `sessions` | See running MCP gateway sessions and block one; every gateway call is logged (caller, tool, verdict) with arguments redacted, kept 14 days. |
| `setup` | Temporarily unavailable: refuses before config or wizard effects; use owner-invoked run/swarm or daemon dry-run while compiled runtime roots are empty. |
| `ship` | Pre-ship gate (lint/test/build) + optional confirm-gated deploy. |
| `signals` | Read real repository adoption signals. |
| `skills` | List skills learned from merged PRs (newest revision each; counts are real or "unknown"). |
| `spec` | Author a versioned end-state spec artifact (local-first model). |
| `stack` | Ecosystem `stack` tool surface: read-only status/list/recommend, confirm-gated add/apply (real provisioning). |
| `status` | Attention board: dirty, off-sync, and stale repos; ecosystem summary. |
| `steward` | Measure Codex/Claude/Phantom log roots against retention + quota; dry run unless --apply (deletes oldest eligible files only). |
| `swarm` | Decompose goal into a contracts-first DAG; run a fleet of agents. |
| `swarms` | List past swarm runs (newest first). |
| `sweep` | Write a local weekly deletion review report from a Phantom checkout. |
| `team` | Local-first team bus: presence, repo/branch/path claims, handoffs and human approval of consequential agent actions. |
| `telemetry` | M19: endpoint+PAT configured (bool), sink mode, local JSONL count, governance. |
| `tidy` | Show (or apply) tidy moves for loose Desktop files. |
| `top` | Read-only per-pool capacity and reset pressure snapshot. |
| `tui` | Interactive terminal dashboard (alias: dash). --once renders one frame and exits. |
| `universe` | Local experiment evolution: run competing code variants, measure them, and reuse winning artifacts. |
| `update` | Self-update; mutation requires service registration proven absent and not running. --check remains read-only. |
| `upgrade` | Same as update. |
| `usage` | Frontier usage table: per-engine calls/tokens/cost + window state. |
| `vercel` | Read recent Vercel deployments or latest build logs (read-only). |
| `verify` | Run trusted worktree checks; JSON verdict and ten-line handoff. |
| `verify-pr` | Verify an explicitly reviewed maintainer PR through the host-owned App check; no merge or deploy. |
| `verify-safety` | Read-only self-check of the hard safety invariants (enrollment/kill-switch/daemon/scrub/cloud-gate); mutates nothing. |
| `verse` | Open the Phantom console at /verse/ for connected coding resources. Runs use account readiness and authority; prints read + mutation tokens. |
| `version` | Print the installed ashlr version (aliases: --version, -v). |
| `vision` | Mission OS: inspect strategy, preview a bounded DAG, record observation-only shadow evidence, or explicitly adopt planning state. |
| `website` | Inspect or pause automatic phm.dev publication; Auto resumes within its existing signed website scope. |
| `wiki` | Private architecture wiki per repo (local models; cited, verified file:line). Only stale pages rebuild. |
| `wire` | Wire ashlr MCP gateway into editor config(s); defaults to detected editors. |
| `worker` | Temporarily unavailable and fail-closed before config, enrollment, queue, wizard, or service mutation. |
| `worktrees` | Report worktree age, size, last log time and job state. |
| `x` | Run an enabled plugin's command. |
<!-- docs-sync:commands:end -->

## Portable agent profiles

See [agent profiles](docs/AGENT-PROFILES.md) for strict TOML metadata, version
pins, doctrine paths and restrictive send policy. Command contract:
`phm agents list --json`, `phm agents show helper --json`,
`phm agents validate helper --json`, `phm agents versions helper --json`.
The email outbox is unchanged; binding sendEmailOutbox to this policy is a
separately reviewed change. Profiles never grant transport or spending authority.

Tier-1 import diagnosis: `npx tsx scripts/tier1-why.ts <file> [--json]` prints a shortest runtime chain or unreachable. See [Tier-1 why](docs/TIER1-WHY.md). Keep fleet apps outside Tier-1; run `test/tier1-apps-boundary.test.ts`. Snapshot regeneration remains Mason-only.

## Article 2: Agent-native app control

Use `phm app steer pause|resume --json` and `phm app prefs '<update-json>' --json` for existing app controls. The same actions use `app.control.v1` over the existing loopback console and `phm_app_control` in the existing stdio MCP bridge. See [app control](docs/APP-CONTROL.md). Unknown usage stays unknown. RQ-AGENTNATIVE-phantom-DESKTOPPREFS is done for Verse preferences; RQ-MACCU-1 owns computer automation.
