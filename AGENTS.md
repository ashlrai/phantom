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

## Mission and ecosystem

Phantom's mission is chasing open-source RSI (recursive self-improvement): an open-source, fully autonomous, code-first software factory run by agents, with the human owner as a passive board member. Agents pick work, open pull requests, merge them and ship releases through the sanctioned workflow; the owner sets direction and is needed only for the items in Article 1. The [strategy for recursive self-improvement and an open fleet](docs/strategy/RECURSIVE-SELF-IMPROVEMENT-AND-OPEN-FLEET-2026-11.md) explains how improvements are tested.

Phantom is the factory floor: console, CLI, MCP gateway, agent bus and fleet. Companions install separately, each with its own authorization boundary: [Phantom Secrets](https://github.com/ashlrai/phantom-secrets) (local vault and credential proxy), [Ashlr Plugin](https://github.com/ashlrai/ashlr-plugin) (compact tool results), [Locus](https://github.com/ashlrai/locus) (account and tenant bindings), [Lexicon](https://github.com/ashlrai/lexicon) (speech-to-text corrections), [Ashlr MD](https://github.com/ashlrai/ashlr-md) (Markdown editing) and [Ashlr Stack](https://github.com/ashlrai/ashlr-stack) (development service setup). See [the Phantom ecosystem](README.md#the-phantom-ecosystem) and [the toolchain guide](docs/AGENT-TOOLCHAIN.md).

This repository is maintained by Phantom (`phm improve` / steward) and other coding agents under the [standing authority](docs/STANDING-AUTHORITY.md).

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

- Cross-provider subagents: `phm subagent spawn --parent session-id --tier fast --task "Review a bounded change" --json` plans a scope-limited child through the provider-neutral router. Dry-run writes nothing; `--apply` stores held records only, never dispatches. No metered fallback. See [subagents](docs/SUBAGENTS.md).

- CI baseline analysis: `phm ci baseline --json` groups fresh Vitest (including the qualification lane's retry-flake verdicts), node:test TAP, TypeScript typecheck, eslint lint plus the realio-lane and verse-sync-io lint guards, check:docs, generated-file, version-sync, npm run build step, perf-budget, dependency-audit, memory-benchmark floor, pack-smoke/artifact gate, first-paint budget gate, ci.yml helper-gate step, npm ci install step, test-runner watchdog verdicts and trust-boundary (secret-shape, secret-scan, version-provenance) failures and plans narrow master fixes. Queueing and post-merge updates are opt-in; see [CI baseline analyzer](docs/CI-BASELINE.md).

- Ecosystem onboarding: `phm onboard --ecosystem --json` previews names/state only.
  Grant a reviewed selection with `phm onboard --ecosystem --grant --plan <planId> --select lexicon,stack --json`.
  `--yes` never grants. Locked vaults offer existing-vault access; imports stay
  in Secrets' trusted terminal. See [ecosystem onboarding](docs/ECOSYSTEM-ONBOARDING.md).
- This repo's `.mcp.json` declares six companion MCP servers: `phantom-secrets`, `locus`, `lexicon`, `stack`, `context7`, `ashlr` (Ashlr.AI Plugin). What each is for, its limits, and how to approve it: [docs/AGENT-TOOLCHAIN.md](docs/AGENT-TOOLCHAIN.md).
- In a Phantom cloud task, list the companion tools you actually called in the report's `toolsUsed` field (an empty list if none); `phm cloud list` shows it as the session's claim.
- Live org: `phm org` prints the leader, its planners (executor, Core orchestrator, main guardian, comms), each lane (running, target, queued, pool usage) and each running job (tier, age, goal) as a `fleet.org.v1` JSON tree; `phm org --text` is the same for people. Unknown stays null, never 0. See [docs/FLEET-API.md](docs/FLEET-API.md#org-tree).
- Team org: `phm org show --json`, `phm org join --member <id> --machine <id> --lane <lane>[=<share>] --json` (each co-founder on their own machine; opt-in per lane, no auth read, nothing sent) and `phm org plan --json` (proposes queue assignments and roles within each member's contributed limits from the router's usage and reset data; the leader reads it each planning pass). Private data is never pooled; spending stays with each member. See [docs/AGENT-NETWORK.md](docs/AGENT-NETWORK.md#team-org).
- Team membership: `phm team invite <gh-user>`, `phm team join <invite>` and `phm team remove <gh-user>` are human-terminal commands for owners/admins and invitees (agent processes are refused); an invite grants membership only and never credentials. Agents needing access changes file them with the `phm_team_access_request` MCP tool (invite-member, link-repo or change-role); a human owner/admin decides with `phm team approve|deny`. See [docs/TEAM.md](docs/TEAM.md#invite-join-and-remove-a-teammate).

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
- Keep diffs reviewable, with one coherent mergeable outcome per PR. Frontier jobs may combine related concerns within their tier scope; move unrelated work to another job.
- Never commit secrets. Use Phantom Secrets placeholders.
- Never force-push to the default branch.

## Working in this repository
- Node `>=22.15.0`. Install a single clone with `npm ci` (also what CI and releases use); several trusted local worktrees on one machine can share one store with `npm run install:worktree` (pnpm 10.28.2, same volume). Build with `npm run build`, run the CLI from source with `npm run dev -- <command>`.
- Backend tests: `npm test` for all backend suites, or `npm run test:ci -- test/<file>.test.ts` for affected suites with the hermetic runner. Run tests with a temporary HOME, for example `HOME=$(mktemp -d) npm run test:ci -- test/agents-md-audit.test.ts`.
- Before a PR: automated workers run `node scripts/verify-changed.mjs` once, in the foreground; do not poll it. Repeat runs on an unchanged tree exit early (`SKIP verify-changed`); pass `--force` to rerun. This replaces worker runs of full `npm run typecheck` and `npm run lint`, runs the `check:docs` link/anchor check itself when the diff touches markdown or deletes files, and runs the quarantine-ledger check when the diff touches test files or `queue/quarantine.tsv`, and syntax-checks changed `.py` files when `python3` is available, changed `.sh` files with `bash -n` when `bash` is available, changed `.pl` files with `perl -c` when `perl` is available, changed `.ps1`/`.psm1`/`.psd1` files with PowerShell's `Language.Parser.ParseFile` (parse only, never executes; covers `scripts/install.ps1`, the shipped Windows installer) when `pwsh` or `powershell` is available, extensionless executable scripts by their shebang interpreter (`python3` compile, `bash -n`, `perl -c`, or `node --check`), and changed `.json`/`.webmanifest`/`.tsbuildinfo` files with `JSON.parse` (the suffix is TypeScript's incremental JSON build record), changed `.jsonl` files line by line with `JSON.parse` (each non-blank line must be one complete JSON value; blank lines carry no record), and changed `.xml`, `.plist`, `.plist.in` and `.svg` files with `python3`'s ElementTree parser when `python3` is available (non-XML plist encodings skip the parser; `.plist.in` launchd templates always parse). Changed `.rs` files are parsed with `rustfmt` and changed `.swift` files with `swiftc -parse` when available. Changed `.yaml`/`.yml` files are parsed with the bundled `yaml` package and changed `.toml` files and `Cargo.lock` manifests (TOML at any depth, e.g. `desktop/src-tauri/Cargo.lock`) with `smol-toml`; each prints `SKIP` when its package is not installed. Changed `.css` files are parsed with `lightningcss`, the CSS parser Vite bundles for the web-ui build, resolved through vite's installed dependency closure; it prints `SKIP` when vite or the parser cannot be resolved. Changed scripts under `src/raycast/` and `examples/universe-site/` (authored trees eslint.config.js ignores and no root tsconfig covers; each owns its toolchain) are parsed with the bundled `typescript` package's `createSourceFile` diagnostics, the parse `tsc` itself applies; it prints `SKIP` when the package is not installed. Changed `.snap` files (vitest snapshot modules that eslint and tsc never read) are compiled with node's script parser in-process, so the step has no preflight and never prints `SKIP`. Changed `.patch` and `.diff` files are parsed with `git apply --stat`, the unified-diff grammar `git apply` consumers enforce, without requiring the patch to apply in this checkout; the step has no preflight and never prints `SKIP`. Changed `.html`/`.htm` files have their embedded payloads parsed: classic and `type="module"` `<script>` bodies with node's `vm` parser under the matching goal, JSON script types (`ld+json`, `importmap`, `speculationrules`, `+json`) with `JSON.parse`, and `<style>` rules with the same `lightningcss` parser as `.css` files, all enumerated by the bundled `jsdom` package; external `src` scripts, inert `type` values, empty bodies and `<noscript>` scripts are skipped, `<template>` content is checked, `test/fixtures/` markup is exempt, and the step prints `SKIP` when `jsdom` is not installed (style payloads warn-skip when `lightningcss` cannot be resolved). Changed `contrib/router` program inputs (a `.ts` file under `contrib/router/`, its only outside import `src/core/authority/protected-paths.ts`, or `package.json`/`package-lock.json`) also run the `tsc --noEmit` file-list type check `contrib/router/SUPERVISOR.md` documents inside a typecheck slot (the router executes under `tsx`, which does not type check, and no `tsconfig` project covers it); it prints `SKIP` when the `typescript` package is not installed. Every changed text file is also scanned for leftover git merge-conflict markers: the column-0 marker lines a botched resolution leaves behind, which the per-type grammars cannot see inside strings, comments and template literals and which parser-less file types never reject; binary files and `test/fixtures/` payloads are exempt and the step has no preflight or `SKIP`. When an earlier check already failed the tree, the typecheck lane prints `SKIP typecheck` instead of compiling a run that cannot pass; the shared type-check slot stays free for a tree that can, and the rerun after the fix typechecks as usual. Humans may still use `npm run lint` and `npm run typecheck`. Also run `npm run check:docs` (when verify-changed skipped it) and the affected tests (`npm run test:ci -- test/<file>.test.ts`, `npm run test:web` for `src/web-ui` and `desktop`). `npm run gate` runs build, static checks and related tests together. Its import graph plus a grep for text-reading tests covers docs, configs and data files; run any reader it still misses explicitly. Local checks do not replace `Merge Gate`, the one required hosted check. On a pull request it runs the secret scans, the generated-files check and the fast gate (type check plus tests selected from the diff); the full backend, Windows and macOS suites run on the scheduled `master` run (see [What CI requires](docs/CONTRIBUTE-WITH-AN-AGENT.md#6-what-ci-requires)).
- When authority drift fails, run `npm run authority:regen` and list each new Tier-1 root in the PR body for CODEOWNERS review.
- Hosted PR checks do not run ESLint or `check:docs`, so do not skip the local lint and documentation checks.
- Outside contributors and their agents: clone `ashlrai/phantom` as `origin` (verify-changed diffs against `origin/master`), push the topic branch to your fork, and open the PR against `master`. `Merge Gate` is the one required check; a PR touching a path in `.github/CODEOWNERS` also waits for the owner's review. Step by step: [Contribute with an agent](docs/CONTRIBUTE-WITH-AN-AGENT.md).
- Shared work market (RQ-SHARED-QUEUE-1): jobs carry `needs`, `min_tier`, `max_tier`, `max_cost_class`, `data_class`, `work_class`, `exclusive`, priority and impact; `pool`/`lane` are `preferred_lane` hints. Dispatch selects a capable, healthy executor with quota and capacity, ranking resource posture (burn, balanced, preserve) ahead of the hint; a claim that leaves its hint records `lane_override` in `metrics/jobs.jsonl`. `phm fleet unfed --json` reports per-resource utilization and lanes left with free slots while rows waited elsewhere. An unknown hint is open; explicit local execution stays local. Inspect `metrics/work-market.jsonl` for `work-market.v1` reason codes and `phm route explain --json` for hysteresis receipts. Source changes require Security review and re-pin before `contrib/mac/install.sh`; never install over the live pinned dispatcher. See [queue market](docs/QUEUE.md).
- Queue tiers: router-queue `tier=` must be `frontier`, `work`, `mid` or `fast`. `queuegen` and `router-lint` refuse any other value (`standard` means `work`), because dispatchd skips unknown tiers silently. See [docs/QUEUE.md](docs/QUEUE.md#tier-values).
- Session scope: frontier plans up to 40 files / 600 changed lines across related concerns; work 15 / 200, mid 8 / 120, fast 2 / 80. One mergeable PR per job; explicit narrower named-file limits win. See [tier-scaled scope](docs/QUEUE.md#tier-scaled-session-scope), [lane tool parity](docs/AGENT-TOOLCHAIN.md#lane-tool-parity-audit-rq-delegate-scope-1), and [org responsibilities](docs/AGENT-NETWORK.md#assign-responsibilities-without-expanding-authority). Restock dry-run JSON reports `scope_budgets`; live script installation still needs Security review and re-pinning.
- Layout: `src/cli/` command dispatchers, `src/core/` logic, `src/web-ui/` console, `test/` backend suites (`<topic>.test.ts`; older ones `m<N>.<topic>.test.ts`), `docs/` guides indexed by `docs/README.md`.
- Mac dispatcher: `contrib/mac/dispatchd.py` is the single source for the live `~/.ashlr-runs/bin/dispatchd.py`. Change it here, never on the host. `contrib/mac/install.sh` diffs and installs it (plus `install-gate.py` and `launch-gate.sh`) with timestamped backups, but only after Security has reviewed and re-pinned the files; agents preview with `contrib/mac/install.sh --dry-run --json` and never run it against the live directory. Copy-paste install, once pinned: `contrib/mac/install.sh --json`. See [contrib/mac/README.md](contrib/mac/README.md#installing-the-dispatcher).
- Fleet machinery: `fleet/manifest.json` (`fleet.machinery.v1`) inventories every `~/.ashlr-runs/bin` file by class. `managed` installs via `python3 fleet/sync.py`, `manual`/`pinned` are report-only (pinned GATES v3 files stay ops-side). Agents preview with `fleet/sync.py --json` or `--bin <scratch>` and never `--apply` live. Migration plan: [docs/MACHINERY-MIGRATION.md](docs/MACHINERY-MIGRATION.md).
- Agent Bus v2: the provider contract (participants, body kinds, claim keys and overlap rules, work feed) is in [docs/AGENT-BUS.md](docs/AGENT-BUS.md#v2); `ashlr agents bus contract --json` prints its schema version and kinds. Claims coordinate and grant no execution authority. Schemas: `src/core/agents/bus-v2-schema.ts`.
- External bot seats: `phm bots seats --json` reads quota evidence and participant metadata; `phm bots handoffs --json` plans every seat's pending handoffs fleet-wide and `phm bots handoffs --apply` drains them all (per-seat `phm bots handoff --seat <id> --apply` releases work for one seat); `phm bots message --from <seat> --to <seat|owner> --text <text>` sends seat-to-seat bus DMs or owner-thread notices. Devin Bot messaging stays advisory; no on-demand spend. See [bot seats](docs/BOT-SEATS.md).
- Learned skills: `phm skills list --json` shows skills written from merged PR outcomes (metadata only, scrubbed, capped; counts real or `"unknown"`). See [docs/SKILLS.md](docs/SKILLS.md).
- Channels: `phm channels add <kind>` writes config only (credentials stay in existing custody, never printed); `phm channels status --json` reports real counts or `"unknown"`. See [docs/CHANNELS.md](docs/CHANNELS.md).
- Owner thread (RQ-COMMS-UNIFIED-1): `phm comms status --json`, `phm comms thread --json` and `phm comms send-owner --text "<reply>" --json` are one ordered thread for desktop, Telegram, email, iMessage and Slack. Replies go only to the configured owner, on the channel they used and on the desktop thread. Thread reads join per-channel delivery receipts; an unrecorded channel stays unknown, never delivered. Adapters stay disabled until configured; credentials are Phantom Secrets handle names. KILL halts them. See [docs/OWNER-THREAD.md](docs/OWNER-THREAD.md).
- Slack bridge: `phm channels slack status --json` reads the `[slack]` section of `~/.ashlr/agent-network.toml`, token `phm_` reference names (never values) and journal counts; `phm channels slack map --json` dry-runs the topic/channel mapping and, with `--snapshot <file>`, the team-only audience gates. Read-only; the socket, token injection and post path are the separately reviewed `-sec` change. See [docs/AGENT-NETWORK.md](docs/AGENT-NETWORK.md#slack-bridge).
- iMessage intake: `phm imessage doctor --json` reports permission and config state (no handles printed); `phm imessage poll --json` is a counts-only dry run and `--apply` receipts allowlisted messages as channel `imessage`. RQ-IMSG-REPLY-1 (#3534) landed: nonduplicate verified-owner acknowledgements are attempted through the outbox to the original owner handle. The ack journal is pre-attempt evidence, not delivery proof; its legacy `recorded-not-sent` label does not establish non-delivery. Never read or print message text or handles. See [docs/IMESSAGE.md](docs/IMESSAGE.md).
- Briefs: the fleet brief-send verb (dry run by default, `--json` for the plan) plans the morning (7:30 ET) or overnight (22:30 ET) brief with a needs-you list of at most 5 items; `--apply` sends to your own channels, one per slot per local day. See [docs/BRIEF-SEND.md](docs/BRIEF-SEND.md).
- Read next: [docs/AGENT-OPERATIONS.md](docs/AGENT-OPERATIONS.md) (setup and operation), [CONSTITUTION.md](CONSTITUTION.md), [CONTRIBUTING.md](CONTRIBUTING.md), [docs/CONTRIBUTE-WITH-AN-AGENT.md](docs/CONTRIBUTE-WITH-AN-AGENT.md) (outside contributors: fork, verify, pull request, auto-merge), [docs/CONSOLE-LAYOUT.md](docs/CONSOLE-LAYOUT.md) (web console width breakpoints).
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

Leader board: every Leader tick records a `fleet.leader-board.v1` state at
`~/.ashlr-runs/coordination/leader-board.json`: lanes, queue depth by tier,
merges in the last hour, the conflicting-PR count trend (RQ-REBASE rows in
ready.tsv are the local proxy for GitHub-conflicting PRs) and open
needs-Mason items. Read that JSON file directly; all inputs are local files,
never gh or a model.

Disk maintenance: `phm disk-maint` is a dry run that reports reclaimable bytes
per class; `--apply` rotates, compresses and deletes rebuildable leftovers and
reaps finished worktrees. `phm disk-maint schedule [--install]` prints or
installs the daily per-user job. The protect-list (`~/.codex*`, model weights,
Docker, client trees, `~/Documents`, git internals, auth, secrets) applies at
plan and apply time; gated classes (`venvs`, `hub-claude`) need `--allow`.
See [DISK-MAINT](docs/DISK-MAINT.md).

Router catalog refresh: `phm router catalog refresh --json` writes a review-only
report and patch; `phm router catalog schedule` prints weekly user units.
See [Router catalog](docs/ROUTER-CATALOG.md) for explicit apply and discovery rules.

pass^k eval: `phm eval passk [--lane <lane:engine>]... [--trials N] [--k K]`
runs the pinned golden set in `benchmarks/passk/` N times per task in clean
worktrees and reports pass@1/pass@k/pass^k per lane/model. `scores` and
`alerts` read the published projection and regression journal;
`schedule [--install]` prints or installs the nightly per-user job.
`--gate` exits 3 on a regression vs the baseline. Outputs are advisory for
lane routing; nothing routes, reserves or merges. See
[EVAL-PASSK](docs/EVAL-PASSK.md).

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
queue wait, checkout, model, worker, publish wait, CI and merge time and
supplies a proposed fix line for each measured phase. It is read-only; fix
lines are proposals, not queued jobs. Records use `job` (or
`job_id`/`jobId`/`id`), `event` (or `type`) and `ts` (or
`timestamp`/`at`). Queue arrival is `enqueue`, `enqueued` or `queued`; other
boundaries are `launch`, `checkout_complete`, `finish`, `ci_start`,
`ci_complete`, `publish`/`published` and `merged`. Terminal PR state
(`outcome`/`state`/`status` `MERGED` or `PUBLISHED`, `mergedAt` preferred for
`MERGED`) outranks the event name, so an eventless reconciler row still
counts and a publish row swapped to `MERGED` is never a second publish.
`phm pulse merge-latency` adds the `open_to_merge` publish→merged total.
IDs must identify individual attempts. Missing, reversed or ambiguous
repeated boundaries are reported as unmeasured, not estimated; phase totals
need not cover the whole wall time. Existing ledgers may not yet contain all
boundaries.

Fleet IQ: `phm fleet eval-report [--days 7] [--prs prs.json] --json` scores
merged PRs post-merge: revert, regression and follow-up rates, CI-failure
correlation, and time-to-merge, rolled up by lane, tier, lane+tier and repo
(`fleet.eval-report.v1`). Evidence comes from `~/.ashlr-runs/metrics/jobs.jsonl`
(newest bounded tail; `sources.jobs.truncated` marks a cut window),
repeatable `--prs` files of `gh pr list --state merged --json url,number,title,
mergedAt,mergeCommit,files,statusCheckRollup,commits,body` output, and the
signed post-merge observation ledger. A merge counts `stable` only when the
72 h window elapsed under a covering evidence channel; uncovered merges are
`unobserved`, and `ranked` sorts groups on the Wilson lower bound. Read-only;
nothing merges, routes or releases credit.

Reward signals: on self-improvement ticks the resident daemon's `reward-sync`
off-tick job folds the jobs-ledger tail into `~/.ashlr/metrics/reward-signals.jsonl`:
one scrubbed row per job whose PR lifecycle resolved (MERGED, or
CLOSED-unmerged; a merge later reverted counts as not held, row-level revert
evidence, or the standing `owner/repo#n` revert set the daemon resolves from
the outcome ledger, cloud tasks and `phm fleet reverts --record` when the
merge's PR claim is unambiguous). The ledger feeds
`phm router-calibration` and the eval harness; first write wins, jobs without
dispatch or resolution evidence stay unwritten, and unknown fields stay null.
See `src/core/metrics/reward-feed.ts`.

Empty-job tags: on the same self-improvement ticks the resident daemon's
`empty-tag-sync` off-tick job folds the jobs-ledger tail's windowed empty
finishes into `<runs>/metrics/empty-tags.jsonl` (`job.empty-tag.v1` rows,
first write wins, log tail the only classifier input) and the matching
dupcheck outcome rows, the same records `phm jobs empty --record` appends
by hand, now on the daemon cadence so the router `empty_tag` join, the
weight proposals' `unknown_empty_tags` tally and dupcheck skip precision
stay fed without anyone running the CLI. Best-effort, bounded per pass,
writes only under the runs dir. See `src/core/fleet/empty-tag-sync.ts`.

Research loop (RQ-SWE5-RESEARCH-LOOP): `phm fleet research-digest --file
<digest.md> --json` scores a digest's `## Proposals` bullets (impact x
confidence - effort), dedups them against the queue and shipped work, and
runs each rendered `- READY` line through the admission lint. Dry-run by
default; `--apply --queue <ready.md>` appends only the reviewed subset, and
`--approve <id,...>` narrows it. See [the research loop](docs/RESEARCH-LOOP.md)
and the [Spawn fleet synthesis](docs/strategy/spawn-fleet-model.md).

Merge queue drift protection: the `Check authority drift (hermetic)` job runs
the CODEOWNERS and Tier-1 import closure checks on every PR and merge queue
candidate, including docs-only changes. A new Tier-1 test needs its generated
CODEOWNERS entry in the same PR (`npm run authority:regen`); changed Tier-1
imports need a reviewed closure snapshot update. The job is advisory for
`Merge Gate`, so drift does not block the merge, but Auto-tag and the release
gate require it green on the exact commit; fix drift in the same PR.

Route hysteresis: ready.tsv pool proposals pass through dispatchd's persisted
60-minute residency, immutable launch pool and two-moves/six-hours cap. Only
explicit auth failure, zero quota or a provider backoff hold (never a manual or
HOLD-list hold) permits early movement. See
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

Fleet autopilot (RQ-SWE3-AUTOPILOT-1): `phm fleet autopilot --once --json` runs
one bounded read-only planning cycle: it reads queue/slots/admission state,
computes lane utilization vs targets, picks the single highest-leverage gap
(uncovered conflicting PRs, a starved lane, stale parked deps, missing
restock) and emits one proposed action: `enqueue` N jobs of a type,
`hold-lane`, or `no-op`. `--repo <owner/name>` repeats to include the
read-only `gh pr list` rebase-coverage read. It never mutates; the proposal
is advisory for the leader loop.
Rebase batch ordering (RQ-SWE3-REBASEORDER-1): queuegen stamps REBASE lines
with `cluster=clu-<PR>` (`src/core/fleet/rebase-order.ts`); dispatchd batches
each file-overlap cluster via `contrib/mac/rebase_order.py` (eligible siblings batch within configured limits,
disjoint PRs spread). See [rebase ordering](docs/REBASE-ORDERING.md).


Durable memory: `phm memory add|list|search|forget --json` stores Mason's
preferences, doctrine and facts as markdown under `~/.phantom/memory/`; see
[memory](docs/MEMORY.md). Secret-shaped text is refused, never store values.

Connector run: `phm connectors run github --scope repo-read --tool codex --lane work --json -- repo list --json name` is denied pending Security review; no process or credential resolution.

Connector profiles: `phm connectors add|list|remove|show|import --json` manages
`~/.phantom/connectors/profile.toml`; see [connector profiles](docs/CONNECTORS.md).
Use vault names only. Import withholds inline credentials; Codex requires a
lane-owned CODEX_HOME under `~/.ashlr-runs`, never `~/.codex`.

Connector launch: `phm connectors exec github --tool claude --lane work -- gh repo list`
starts a cli or mcp-stdio connector whose tool and lane are listed. Credentials
come from `phantom exec` as session tokens in the child env only; argv, files and
logs never hold a value. `phm connectors config --client claude --lane work --json`
prints client MCP entries that launch through exec (no token, secret-shape gated).

## Chief-of-staff intake

See [docs/COS.md](docs/COS.md) for the planned chief-of-staff ask and status commands.
The handler is implemented; top-level CLI and
desktop custom-sink registration require an explicit named-file scope extension.
Intake jobs use `phm queue`; `done --result <text> --json` drafts the reply and
surfaces a needs-you item. Outbound results require explicit approval of the
displayed draft digest. Do not treat a queued job or result draft as send authority.


## Apps control

`phm apps --json` reports Phantom, Claude, Codex, ChatGPT, Cursor, Grok, Devin and
Safari (installed, running, frontmost, memory; unknown with a reason), and
`phm apps open|focus <name> --json` acts on them. Quit refuses every one of
them except Safari, and refuses Chrome. `phm apps suggest --pressure warning --json`
lists the idle apps that would free the most memory and never quits anything.
`phm apps list|open|quit|focus|status [--json]` and
`phm apps request open|quit|focus <app> --json` manage other desktop apps named in
`~/.ashlr/apps-allow.json` (empty by default). Copy and paste these commands;
see [APPS-CONTROL](docs/APPS-CONTROL.md):

```sh
phm apps --json
phm apps focus claude --json
phm apps list --json
phm apps status Notes --json
phm apps quit Notes --json
```

Safari is Phantom's own agent browser: `phm browser --json` lists its tabs and
the latest screenshot, `phm browser open <url> --json`, `phm browser shot <path.png> --json`
and `phm browser close --json` act on it, and `phm browser doctor --json` says whether
remote automation is on. Chrome is always refused.

The Fleet Host Allowed apps card and GET/POST `/api/verse/apps/control` share
the CLI service. Allowlist entries accept `actions` and `mode: "request"` policies;
Phantom lifecycle actions always queue to needs-you without desktop or launcher
calls. Requests and resolved needs-you replies grant no execution or send authority.

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
grant and returns untrusted screen text. `browser` is read-only; act on the
web through the Phantom Browser pane. Nothing prompts for or changes TCC
grants; every action is feed-logged and refuses to run unlogged.

## Desktop operator

`phm desktop list-apps|windows|focus|read|scroll|type|click|screenshot|doctor [--json]`
operates desktop apps on this Mac through the `desktop-operator` helper.
Accessibility is the reader. A window screenshot plus OCR is the fallback.
Reads do not post to the bus. `focus`, `scroll`, `type` and `click` post a
bus intent, then act. The fleet KILL switch and comms pause block those writes.
The roster hook is `desktopSessions()` in `src/core/desktop/desktop-sessions.ts`.
See [DESKTOP-OPERATOR](docs/DESKTOP-OPERATOR.md).

```sh
phm desktop doctor --json
phm desktop list-apps --json
phm desktop read --app Cursor --json
```

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

## Comms agent

`phm comms-agent status|run|drafts --json` runs the Comms role under the
Leader. The router picks the lane; the role names none. Bulk and bot mail is
archived, never deleted; a delivered reply resolves its message into the
archive without resending. A send needs an owner standing approval. See
[COMMS-AGENT](docs/COMMS-AGENT.md):

```sh
phm comms-agent status --json
phm comms-agent run --lanes claude,local --json
phm comms-agent drafts --json
```

## Agent app adapters

`phm agents apps [<id> launch|sessions|show|send|usage] --json` drives Codex,
Claude, Devin, Grok and Cursor through one adapter interface: CLI adapters first,
`<app>-desktop` fallbacks through the desktop operator's gates. See [AGENT-APPS](docs/AGENT-APPS.md).

## Agent sessions

`phm sessions create|show|resume|terminate --json` runs resumable agent
sessions. A session pairs an agent profile id and version with an environment
id and an append-only event log. Each turn is one `phm queue` job, and dispatchd
is unchanged. The statuses are idle, running, rescheduling and terminated. See
[SESSIONS](docs/SESSIONS.md):

```sh
phm sessions create --agent helper --agent-version 1 --environment local --job J1 --json
phm sessions show sesn_0123456789abcdef --json
phm sessions resume sesn_0123456789abcdef --scope "Address review comments" --json
```

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

Desktop update status: `phm app update status [--json]` reads the installed app bundle version and reports a staged candidate only when it is newer, plus host deferral and lease counts. Unknown job identities stay null. See [desktop updates](DESKTOP.md#background-update-discovery-and-local-status).

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

Agent network channels: `phm agents bus channels list --json` reports which adapters are registered. `phm agents bus channels test bus --json` and `test handoff` record a local probe. Other channels stay refused until an adapter exists. See [agent network channels](docs/AGENT-NETWORK-CHANNELS.md).

Repository ranking: `phm repos rank --json` blends seed priority with local merged
PR recency and autonomy leverage, at most daily. `phm repos rank --recompute --json`
honors the same ceiling. `phm repos rank proposals --json` reads suggestions only;
enrollment remains a manual config change. See [repo ranking](docs/REPO-RANK.md).

## Import scheduled routines

Preview a local routines JSON array with `ashlr automations import --from routines.json --dry-run --json`, then import with `ashlr automations import --from routines.json --json`. Imports start disabled and skip existing names. See [Automations](docs/VERSE.md#automations-315) for the format and schedule restrictions.

Tier-1 import diagnosis: `npx tsx scripts/tier1-why.ts <file> [--json]` prints a shortest runtime chain or unreachable. See [Tier-1 why](docs/TIER1-WHY.md). Keep fleet apps outside Tier-1; run `test/tier1-apps-boundary.test.ts`. Snapshot regeneration remains Mason-only.

## Portable agent profiles

See [agent profiles](docs/AGENT-PROFILES.md) for strict TOML metadata, version pins and restrictive send policy. Read profiles with `phm agents list|show|validate|versions --json`. Profiles grant no transport or spending authority; the email outbox runs outside sends through `checkSend`, which can only ever draft or deny.

- [oMLX dispatcher lane](contrib/mac/README.md): memory-capped `omlx` pool, `127.0.0.1` health only, `phm lanes --json`; Security combined RETUNE pin required before installation.

## App drive

`phm drive <devin|claude|codex|phantom> <start|status|send-prompt|read-result> --json`
uses enrolled CLI/API seats through authenticated numeric loopback. See
[App drive](docs/APP-DRIVE.md) for examples and DESK integration limits.
Security 606e84d2 must pin new loopback-client changes before merge.

## Router gateway

One routed model call for any agent. `phm run --model auto` asks the seat
router to pick a granted seat under the budget mode and reserves; a pinned
`<lane>:<model>` passes the same checks. The loopback endpoint runs the same
code. `phm router pick` previews the decision and calls no model. Copy and
paste these commands; see [Router gateway](docs/ROUTER-GATEWAY.md):

```sh
phm router pick --model auto --json
phm run --model auto "Summarize this diff in three bullets." --json
phm router serve --json
```

The endpoint binds 127.0.0.1 only and needs the bearer token in
`~/.ashlr/router/token`; read the file, never print it. Provider auth stays in
each lane CLI. Local models must be on loopback. Nothing is called while the
kill switch is on.

## Typed routing decisions

Provider-neutral [failover chains](docs/ROUTING.md#failover-chains) remain inert with `failover_dispatcher_unwired`; no dispatcher installation is authorized by a plan.

`phm route decide --input request.json --json` validates a closed set from local model, slot and admission snapshots. Local fast, one schema retry, existing Jev escalation and deterministic fallback share a 450 ms service budget. Advisory only; dispatcher observations append `metrics/route.explain.jsonl` without changing launches. See [typed routing](docs/ROUTING.md) for the request schema and a copy-paste offline example.

App restart: `phm app restart --json` currently exits 1 with a held result and performs no restart. See [ownership audit and acceptance work](docs/APP-RESTART.md). Do not infer session survival from an app relaunch.
