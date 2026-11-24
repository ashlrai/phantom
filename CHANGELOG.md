# Changelog

<!-- fresh:begin version-table -->
| Version source | Version |
| --- | --- |
| Source package | 3.30.73 |
| Latest dated changelog release (2026-11-24) | 3.30.73 |
<!-- fresh:end -->

All notable changes to Phantom are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions map to milestone series: **2.1.0** = v2.1 "Harden & Prove" (H1–H8),
**2.0.0** = v2 "Autonomous Engineering Organization" (M21–M30), **1.0.0** = v1
hub (M1–M20). Entries below detail each milestone; dates are merge dates into `master`.

---

## [Unreleased]

### Since v3.30.40

Merged after v3.30.40 (#7245 to #7384). Bridge and recovery bookkeeping is left out.

**Desktop**

- Show a health badge for each lane in the fleet map and lane views (#7309).
- Show a "what is loading this computer" card in the fleet host pane (#7260).
- Show every computer as one pool, with free memory, load and free slots (#7353).
- Show job outcomes per lane instead of raw exit codes (#7284).
- Show a spend-down chart for each resource pool (#7306).
- Add an org map that groups lanes and machines in the fleet view (#7332).
- Show app open, focus, quit and restart history in the fleet host pane.
- Show fleet throughput in the Home pulse strip (#7371).

**Mobile**

- Add a phone layout for the Org view (#7355).
- Let the phone Asks card answer several asks in one go (#7327).

**CLI**

- Add `phm release notes --markdown` to print plain-words release notes for readers (#7348).
- Add `phm publish resume` to finish a half-done publish and `phm publish orphans` to find stuck branches (#7335).
- Add `phm bets check` to see whether new work already exists before you queue it (#7250, #7285).
- Add `phm bets propose` so a lane can suggest its own next work (#7325).
- Add `phm plan dup` to catch a bet that has already shipped, and `phm plan check` for leader plans (#7349).
- Add `phm asks` to list what only you can do and answer each with one word (#7293).
- Add `phm host load` to show which jobs, models and apps are loading the machine (#7260).
- Add `phm leader seat` to show where the leader runs now and where it moves next (#7369).
- Add `phm queue autofill` to top up a short lane queue from proposed bets (#7384).
- Add `phm jobs empty` to explain why jobs ended with no change (#7351).
- Add `phm channels reply-state` to read one work item's state before replying (#7370).
- Send an hourly leader reply into the outbox from the log (#7307).
- Make `phm pools` show burn from real readings and a plain verdict (#7283).

**Fleet**

- Add a lane health verdict to `phm fleet` and the live map data (#7309).
- Add `phm fleet starved` to show which lanes are starved of work and why (#7280).
- Add `phm fleet outcomes` and `phm router outcomes` to read job results per lane (#7284).
- Count throughput per lane in `phm fleet pulse` (#7371).
- Add a live merge-queue latency read and a merge recovery verb (#7265).
- Add offline coding-CLI tools: spend ledger append and score, cooldown evidence, adapter contract, regret report.
- Add offline posterior sampling, comparison and update for coding-CLI routing (#7336, #7292, #7319).

**Docs**

- Document empty jobs in `docs/FLEET-EMPTIES.md` and reply states in `docs/WORK-ORDERS.md`.
- Update the CLI reference and agent operations guide for every new verb above.

### Since #7384

Merged after #7384 (#7385 to #7604). Bridge, recovery and release bookkeeping is left out.

**CLI**

- Add `phm jobs gaps` to turn gaps listed by no-change jobs into new work; `--propose` queues the new ones (#7506). The gap finder also reads jobs that opened a PR (#7581).
- Add `phm jobs cost` for tokens per merged PR by lane or model, with unknown where no usage was printed (#7469).
- Add `phm jobs empty --by-family` and act on it with `--apply` or `--undo <family>` (#7408, #7422).
- Add `phm queue supply` and the `supply_low` signal (#7464), and run queue autofill inside the self-tick (#7406). Autofill takes Ideas first (#7426).
- Add `phm host disk` to show how fast free disk is falling and when the lanes freeze (#7444).
- Add `phm nodes plan` to show how many more jobs each computer could take and which queued job fits which (#7388).
- Add `phm leader brief` to read the last bets' results, lanes, pools and open gaps in one read (#7541).
- Add `phm release cadence` to show how stale each repo's latest release is (#7410).
- Add `phm doctor supply` to check whether self-supply is landing jobs (#7570), and `phm doctor worktree` to check that a checkout can typecheck and lint (#7557).
- Add `phm team join` and the owner-side `phm team add` to bring co-founders on (#7513).
- Add bounded fetch retries to `phm publish` (#7449), and recut conflicting agent PRs so they return to auto-merge (#7451).
- Make the digest open with the blocker (#7450) and add sleep gaps, a keep-awake hint and a digest line (#7436).

**Desktop and mobile**

- Replay the fleet on the map, with past frames using the pool and lane numbers of that time (#7531, #7548).
- Show agent message lines on the map (#7389) and a Slack bridge line in the desktop (#7455).
- Add pulse alerts (#7387), one thread with Mason (#7390), release cards (#7511) and a Leader card (#7562).
- Add a Supply card on the desktop Command view and the phone Home view (#7582).
- Give asks an expiry on the phone (#7507) and add a Claude API gift credit ask (#7543).
- Show where the loop waits in the loop stages card (#7529) and read releases there (#7546).

**Fleet**

- Add merge leverage classes (#7510) and a lane yield weight (#7479).
- Add capability-aware lane routing (#7590).
- Show spend-down queue hours and sign-in blockers (#7508).
- Heal a bridge worktree's dependencies on its own (#7537).

**Fixes**

- Confirm group absence before recording SIGKILL completion in dispatchd (#7434).
- Make the leader cloud test hermetic against the host memory-fit gate (#7523).
- Require live account evidence for Devin previews and use unique shim temp paths (#7532).
- Regenerate the CLI reference, quickstart version pins and the site LLM digest so they match master.

### Added

- Add `phm devin autoland` with capped dry-run/apply passes, principal filtering, bundle deduplication, retry backoff, superseding PRs, pause/resume and a single-flight resident timer. Successful landings terminate and archive their Devin sessions.
- Add `phm devin land` to land a Devin session's attached bundle and `pr.md` through the pinned fork-only `publish.sh`: verifies the bundle, rebases the session's own commits onto the latest base, writes the job records, arms auto-merge unless `publish.sh` withheld it, and records the landing. Dry run by default; `--apply` acts. See `docs/DEVIN.md`.
- Add one owner thread that joins desktop, Telegram, email, iMessage and Slack, with replies returning only to the channel the owner used ([#4233](https://github.com/ashlrai/phantom/pull/4233)). See `docs/OWNER-THREAD.md`.
- Add `phm fleet owner-pull` to pull configured remote owner channels into the thread ([#4295](https://github.com/ashlrai/phantom/pull/4295)) and `phm fleet owner-history` to page archived messages after rotation ([#4302](https://github.com/ashlrai/phantom/pull/4302), [#4316](https://github.com/ashlrai/phantom/pull/4316)).
- Show the owner thread and a channel strip inline in the desktop Leader pane ([#4287](https://github.com/ashlrai/phantom/pull/4287), [#4296](https://github.com/ashlrai/phantom/pull/4296)), and open the desktop on a Leader-first home surface ([#4328](https://github.com/ashlrai/phantom/pull/4328)).
- Add the leader office, one co-founder that routes work ([#4232](https://github.com/ashlrai/phantom/pull/4232)).
- Add the Comms agent role with an enforced send policy ([#4230](https://github.com/ashlrai/phantom/pull/4230)). See `docs/COMMS-AGENT.md`.
- Add `phm growth` and Robinhood-style Growth charts built from real ledgers, with Engineering Ops growth exports read into the charts ([#4243](https://github.com/ashlrai/phantom/pull/4243), [#4248](https://github.com/ashlrai/phantom/pull/4248)).
- Add a phone watch view on the existing loopback gateway ([#4234](https://github.com/ashlrai/phantom/pull/4234)).
- Show live world-model lanes in the desktop resource bar ([#4231](https://github.com/ashlrai/phantom/pull/4231)).
- Add Goals, Ideas and Library panes to the desktop dock ([#4315](https://github.com/ashlrai/phantom/pull/4315), [#4313](https://github.com/ashlrai/phantom/pull/4313), [#4310](https://github.com/ashlrai/phantom/pull/4310)).
- Add resumable agent sessions with an append-only event log to `phm sessions` ([#4289](https://github.com/ashlrai/phantom/pull/4289)). See `docs/SESSIONS.md`.
- Add `phm fleet done-plan` (read-only preview) and `phm fleet done-evaluate` (runs the checks, needs `--trust-worktree`) for a job's frozen done-contract, with `schema/done-contract.v1.schema.json` ([#4308](https://github.com/ashlrai/phantom/pull/4308), [#4317](https://github.com/ashlrai/phantom/pull/4317), [#4329](https://github.com/ashlrai/phantom/pull/4329)).
- Add `npm run perf:desktop` to measure desktop startup and render cost ([#4294](https://github.com/ashlrai/phantom/pull/4294)).
- Add `phm fleet recheck` (one read-only verdict over runtime, claims, bridge and task, with `--json` and a paste-ready `--reply`) and `phm fleet recheck-record` to log and page recheck results ([#5482](https://github.com/ashlrai/phantom/pull/5482)).
- Add `phm fleet work-board`, `work-state` and `work-trace` to read the state of work requests from durable stores, and `phm fleet work-result` to post one verified or blocked result as a bus reply. A result receipt is evidence, not authority ([#5519](https://github.com/ashlrai/phantom/pull/5519)).
- Add `phm fleet channel-health`, `runtime-identity` and `slack-trace` to show Slack and iMessage bridge health, which host and build is answering, and each Slack request from journal receipt to reply outcome ([#5539](https://github.com/ashlrai/phantom/pull/5539), [#5440](https://github.com/ashlrai/phantom/pull/5440), [#5548](https://github.com/ashlrai/phantom/pull/5548)). See `docs/FLEET-VERBS.md`.
- Add `phm fleet bridge-check` and the read-only `fleet_bridge_check` MCP tool: one READY or BLOCKED verdict on whether a cloud agent can reach the live runtime, claims ledger and peer ledger, with `missing[]` naming what did not read. A READY is reachability, not authority ([#6025](https://github.com/ashlrai/phantom/pull/6025), [#6017](https://github.com/ashlrai/phantom/pull/6017)). The desktop fleet host pane shows the same verdict in a bridge check card ([#6040](https://github.com/ashlrai/phantom/pull/6040)). See `docs/CLOUD-AGENT-ROUTES.md`.
- Add `phm fleet peer-ledger` and the `fleet_peer_ledger` MCP tool for peer bus rate-limit, capacity and hop budget, with an exact `--from-agent` and `--target` pair lookup, a desktop Peer ledger card, and a peers line in `phm fleet recheck` and the status digest ([#5960](https://github.com/ashlrai/phantom/pull/5960), [#5982](https://github.com/ashlrai/phantom/pull/5982), [#5996](https://github.com/ashlrai/phantom/pull/5996), [#5963](https://github.com/ashlrai/phantom/pull/5963), [#5968](https://github.com/ashlrai/phantom/pull/5968)).
- Add `phm fleet returns-check` to re-read each VERIFIED PR receipt from GitHub and label it merged-at-head, merged-other-head, open, closed-unmerged or unknown ([#5966](https://github.com/ashlrai/phantom/pull/5966)).
- Add `phm fleet ideation-status` to report what the daily ideation loop did on recent UTC days, and the standing ideation loop itself ([#5989](https://github.com/ashlrai/phantom/pull/5989), [#5805](https://github.com/ashlrai/phantom/pull/5805)). See `docs/IDEATION.md`.
- Add the read-only `fleet_session_handoff` MCP tool for a job's latest handoff checkpoint ([#5988](https://github.com/ashlrai/phantom/pull/5988)), and a node runs line in the status digest ([#5991](https://github.com/ashlrai/phantom/pull/5991)).
- Add `phm node run-once`, the `phm-node-worker/v1` runner for the multi-Mac compute pool ([#5806](https://github.com/ashlrai/phantom/pull/5806)). See `docs/NODES.md`.
- Add `phm fleet roster` to list, show, assign and annotate specialists ([#5820](https://github.com/ashlrai/phantom/pull/5820)). See `docs/contracts/CONTRACT-SPECIALIST-ROSTER.md`.
- Add the unified agent bus: one `agt_` identity per handle across providers, direct messages, member-only channels, handoffs and wake hints on the single local bus, with `phm agents bus id|dm|channel|handoff|inbox|wakes|adapters` ([#6232](https://github.com/ashlrai/phantom/pull/6232)). Identities are routing names and grant no authority. See `docs/AGENT-BUS.md`.
- Add bounded peer dispatch: `phm agentnet peers post` sends a directed work proposal and `phm agentnet peers dispatch` consumes at most eight per pass, previewing unless `--apply` is given ([#6144](https://github.com/ashlrai/phantom/pull/6144)). It claims work for existing queue workers and does not launch an executor.
- Add `phm node capacity`, where each node measures its own memory, CPU and swap headroom and reports how many more sessions of each agent harness it can start, and `phm node route` to place jobs by (node, provider, model) ([#6235](https://github.com/ashlrai/phantom/pull/6235)). See `docs/NODE-ROUTER.md`.
- Add `phm fleet claim-bind` to record which Slack thread a claim came from, so `phm fleet claim-notices` posts its ASSIGNED, RELEASED, BLOCKED and VERIFIED notices back into that thread and drops them when no binding exists ([#6163](https://github.com/ashlrai/phantom/pull/6163)).
- Add `phm fleet work-feed`, a read-only bus v2 work feed with `--status` and `--json` ([#6156](https://github.com/ashlrai/phantom/pull/6156)).
- Check for signed desktop releases at startup and every 15 minutes, download them in the background when Automatic updates is on, and install them on a normal Quit once authority is Stop and no execution lease is held. `phm app update status --json` reports `current` for verifying a publication ([#6224](https://github.com/ashlrai/phantom/pull/6224)). See `DESKTOP.md`.
- Add `phm fleet pulse` (is the fleet doing well right now, [#6904](https://github.com/ashlrai/phantom/pull/6904)), `phm fleet yield` (merged PRs per launch slot by job family, lane and tier, [#6530](https://github.com/ashlrai/phantom/pull/6530)) and `phm jobs yield` (keep, watch or stop per job kind, with `--stop-list` and `--stop-file`, [#6905](https://github.com/ashlrai/phantom/pull/6905)). See `docs/FLEET-EMPTIES.md`.
- Add read-only fleet diagnostics: `phm fleet stuck` for queued jobs that can never launch ([#6529](https://github.com/ashlrai/phantom/pull/6529)), `phm fleet unfed` ([#6533](https://github.com/ashlrai/phantom/pull/6533)), `phm fleet republish --dry-run` to preview recovery of work whose publication aborted after a fork push ([#6510](https://github.com/ashlrai/phantom/pull/6510)), `phm empties` for why jobs finished with no change ([#6661](https://github.com/ashlrai/phantom/pull/6661)), `phm pools` for what would go unused at reset ([#6675](https://github.com/ashlrai/phantom/pull/6675)), `phm spend` for whether each pool is spent before it resets ([#6513](https://github.com/ashlrai/phantom/pull/6513)) and `phm throughput` for hourly launches, publishes and merges ([#6683](https://github.com/ashlrai/phantom/pull/6683)). See `docs/QUEUE.md` and `docs/CLI-REFERENCE.md`.
- Add queue upkeep verbs: `phm queue wait` (oldest queued PR and why it waits, required checks stay enforced, [#6926](https://github.com/ashlrai/phantom/pull/6926)), `phm queue supersede` (list, or `--apply` to archive, queued jobs that a newer cycle replaces, [#6745](https://github.com/ashlrai/phantom/pull/6745)), `phm queue coalesce` to merge small READY lines for one repo into batch jobs ([#6532](https://github.com/ashlrai/phantom/pull/6532)), and `phm queue` with `top`, `lane` and `drop` to list jobs in launch order and steer one ([#6797](https://github.com/ashlrai/phantom/pull/6797)).
- Add `phm recut check|plan|prompt` to decide whether a recut or red-fix job should launch and what its prompt must start with ([#6927](https://github.com/ashlrai/phantom/pull/6927)), and `phm ci baseline` to analyze open PRs read-only ([#6685](https://github.com/ashlrai/phantom/pull/6685)). See `docs/CI-BASELINE.md`.
- Add `phm pr resolve-conflicts`, a dry-run-by-default append-union resolver for conflicting open PRs ([#6710](https://github.com/ashlrai/phantom/pull/6710)). See `docs/PR-CONFLICT-RESOLVER.md`.
- Add owner-facing summaries: `phm home` (is the fleet healthy and moving, [#6717](https://github.com/ashlrai/phantom/pull/6717)), `phm map` and `phm map edges` (the whole fleet on one map, [#6715](https://github.com/ashlrai/phantom/pull/6715)), `phm asks` (what only the owner can do, with one-word answers, [#6730](https://github.com/ashlrai/phantom/pull/6730)), `phm shipped` (what shipped in plain words, `--md` writes `docs/SHIPPED.md`, [#6852](https://github.com/ashlrai/phantom/pull/6852)) and `phm autonomy` ([#6690](https://github.com/ashlrai/phantom/pull/6690)).
- Add `phm host load` and `phm host top` to show what is using this Mac, read-only ([#6891](https://github.com/ashlrai/phantom/pull/6891)), `phm nodes` to show your computers as one pool ([#6701](https://github.com/ashlrai/phantom/pull/6701)), `phm usage history --lane <id>` for seven days of measured allowance ([#6569](https://github.com/ashlrai/phantom/pull/6569)) and `phm mobile check` to test every desktop view at 390 px ([#6884](https://github.com/ashlrai/phantom/pull/6884)).
- Add `phm tools` and `phm tools parity` to show which lane has which tool and the top gaps ([#6664](https://github.com/ashlrai/phantom/pull/6664)), and `phm router catalog refresh`, a dry-run model catalog refresh that writes a report and patch under `~/.ashlr/router/catalog/` ([#6696](https://github.com/ashlrai/phantom/pull/6696)). See `docs/ROUTER-CATALOG.md`.
- Add `phm agents apps` to operate other agent apps through one provider-neutral adapter interface ([#6688](https://github.com/ashlrai/phantom/pull/6688)), a read-only agent group chat projection over Agent Bus v2 ([#6567](https://github.com/ashlrai/phantom/pull/6567)), `phm subagent spawn` for cross-provider child plans ([#6774](https://github.com/ashlrai/phantom/pull/6774)), and `phm bots` for provider-neutral bot metadata and external bot seats ([#6781](https://github.com/ashlrai/phantom/pull/6781), [#6792](https://github.com/ashlrai/phantom/pull/6792)). Metadata grants no authority. See `docs/AGENT-APPS.md`, `docs/AGENT-CHAT.md`, `docs/SUBAGENTS.md`, `docs/BOTS.md` and `docs/BOT-SEATS.md`.
- Add `phm pages publish|list` for report pages served only from the loopback dashboard ([#6662](https://github.com/ashlrai/phantom/pull/6662)), and `phm metrics impact`, the single `phantom-impact/v1` reward read from local evidence. See `docs/PAGES.md` and `docs/IMPACT-METRICS.md`.

### Fixes

- Make leader office writes, scrubbing and escalation fail closed ([#4240](https://github.com/ashlrai/phantom/pull/4240)).
- Keep Comms owner files under the account home ([#4269](https://github.com/ashlrai/phantom/pull/4269)) and count the three Comms MCP tools in the output budget ([#4252](https://github.com/ashlrai/phantom/pull/4252)).
- Regenerate the fleet subcommand registry so `fleet done-plan` and `fleet done-evaluate` dispatch.
- Run the dependency audit on every master push so release signing is not blocked, and bump `hono` and `@hono/node-server` to clear it ([#5535](https://github.com/ashlrai/phantom/pull/5535), [#5532](https://github.com/ashlrai/phantom/pull/5532)).
- Include `docs/CLI-AGENT-READINESS.md` in the published package files and raise the Node heap for hosted desktop builds ([#5552](https://github.com/ashlrai/phantom/pull/5552), [#5543](https://github.com/ashlrai/phantom/pull/5543)).
- Offer `spend` as a completion verb for `phm usage`, matching the documented `phm usage spend --json`, so `test/doc-facts.test.ts` passes again.
- Offer `request` as a completion verb for `phm apps`, matching `phm apps request open|quit|focus <app>`.
- Fix release auto-tag to admit a green full CI run on an ancestor commit and a manual full dispatch, to treat a missing current-version tag ref as not yet tagged, and to send the enqueue GraphQL variable it names ([#6304](https://github.com/ashlrai/phantom/pull/6304), [#6300](https://github.com/ashlrai/phantom/pull/6300), [#6299](https://github.com/ashlrai/phantom/pull/6299)).

### Removed

- Remove the disabled observation-only npm admission workflow and the m522 admission test that only read it.

## [3.30.73] - 2026-11-24


### Features

* **authority:** drop cleared seat and size caps without paid overage ([#8599](https://github.com/ashlrai/phantom/issues/8599)) ([7106d3a](https://github.com/ashlrai/phantom/commit/7106d3a2aa3da2e81ea7a8f10c747a1d0f28e1a1))
* install Phantom per user on Windows and Linux ([#8594](https://github.com/ashlrai/phantom/issues/8594)) ([e15c34a](https://github.com/ashlrai/phantom/commit/e15c34acfca55510a0b57a2561a50b233573b318))


### Fixes

* **approvals:** take the decision actor from the authenticated principal ([#8600](https://github.com/ashlrai/phantom/issues/8600)) ([62ce2d1](https://github.com/ashlrai/phantom/commit/62ce2d15b196ec0a7798a253b75814322ac53980))
* **ci:** escape workflow-command characters in failure annotations ([#8592](https://github.com/ashlrai/phantom/issues/8592)) ([440cd74](https://github.com/ashlrai/phantom/commit/440cd7410d143e6904a7a49d2e337fb1600968aa))
* **ci:** narrow the fast-gate fallback to a versioned smoke set ([#8575](https://github.com/ashlrai/phantom/issues/8575)) ([df1ea77](https://github.com/ashlrai/phantom/commit/df1ea77e1cbc38408e97d3d7c268e7cc9fb14a07))
* **ci:** stop the fast gate at the first failure and surface check errors ([#8591](https://github.com/ashlrai/phantom/issues/8591)) ([04fdd32](https://github.com/ashlrai/phantom/commit/04fdd321ffcb6390f52e39b9a5e7b06ffe580b2d))
* **docs:** drop CLI verbs the docs gate does not offer ([#8578](https://github.com/ashlrai/phantom/issues/8578)) ([c346c20](https://github.com/ashlrai/phantom/commit/c346c2055322f27f8baebf88e300e72ad19e9b1c))
* **fleet:** restore lanes error contract, tick-cost loader boundary, CLI reference drift ([#8570](https://github.com/ashlrai/phantom/issues/8570)) ([3086ea4](https://github.com/ashlrai/phantom/commit/3086ea41034d87b954fb64230aea32f3ec5f0930))
* **test:** align self-tick last-record snapshot with the writer ([#8603](https://github.com/ashlrai/phantom/issues/8603)) ([73f0fed](https://github.com/ashlrai/phantom/commit/73f0fed96f4dc09ff53a97e3d9281f21ecfe12d5))
* **test:** keep m132 and m166 green after local memory fit ([#8601](https://github.com/ashlrai/phantom/issues/8601)) ([a5a8909](https://github.com/ashlrai/phantom/commit/a5a890938a34669e82d58f85bfad7ac6e2c0d138))


### Changes

* **FIXUP-CI-phantom-ci-717936:** FIXUP-CI-phantom-ci-717936 ([#7494](https://github.com/ashlrai/phantom/issues/7494)) ([12baedb](https://github.com/ashlrai/phantom/commit/12baedb8ac71d1da86d5046803a24213788370b4))
* **RQ-CL-DESK-1795234555:** ([#7787](https://github.com/ashlrai/phantom/issues/7787)) ([9d74564](https://github.com/ashlrai/phantom/commit/9d74564eecb27bcd36695a27b5fb077fb8145649))
* **RQ-CL-DESK-1795241257:** ([#7830](https://github.com/ashlrai/phantom/issues/7830)) ([1a21314](https://github.com/ashlrai/phantom/commit/1a213149abffbba904af8c9a5c9d27ed0ec9884b))
* **RQ-CL-DESK2-1795073849:** ([#7227](https://github.com/ashlrai/phantom/issues/7227)) ([cacf380](https://github.com/ashlrai/phantom/commit/cacf3803d6e25f4252de6a13ac337d126e77cc60))
* **RQ-CL-DESK2-1795240700:** ([#7828](https://github.com/ashlrai/phantom/issues/7828)) ([376c74a](https://github.com/ashlrai/phantom/commit/376c74a44e9dc6d33ed8c39057ef6bc03cac4521))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795374319-N17:** ([#8366](https://github.com/ashlrai/phantom/issues/8366)) ([1b5582c](https://github.com/ashlrai/phantom/commit/1b5582c418d74102c099d2f4d5406323e4b3463a))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795375170-N17:** ([#8371](https://github.com/ashlrai/phantom/issues/8371)) ([de2a4ea](https://github.com/ashlrai/phantom/commit/de2a4ea03f6f132e328af83f6120216b60b2c8d2))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795376432-N17:** ([#8375](https://github.com/ashlrai/phantom/issues/8375)) ([026cd4c](https://github.com/ashlrai/phantom/commit/026cd4cd0b320ad0ff399faa8a6b0cc3e6956e33))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795379311-N17:** ([#8385](https://github.com/ashlrai/phantom/issues/8385)) ([67118c7](https://github.com/ashlrai/phantom/commit/67118c7614ff455ddc4c81562aebbf7ff7d0702f))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795381379-N17:** ([#8390](https://github.com/ashlrai/phantom/issues/8390)) ([63cfc01](https://github.com/ashlrai/phantom/commit/63cfc018d00e77175cadd41dcff33a2b841414f0))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795383173-N17:** ([#8394](https://github.com/ashlrai/phantom/issues/8394)) ([4215cfa](https://github.com/ashlrai/phantom/commit/4215cfabcf4ae9234473c0bce7c78f7846851ce5))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795384476-N17:** ([#8395](https://github.com/ashlrai/phantom/issues/8395)) ([c5589fc](https://github.com/ashlrai/phantom/commit/c5589fc4e95fae6646b21572e0d3b365c40e1c4b))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795386065-N17:** ([#8397](https://github.com/ashlrai/phantom/issues/8397)) ([b7d4e98](https://github.com/ashlrai/phantom/commit/b7d4e981194ad48b612afa3343dcf6988cabee9b))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795386990-N17:** ([#8399](https://github.com/ashlrai/phantom/issues/8399)) ([a19d640](https://github.com/ashlrai/phantom/commit/a19d6404253533e34a940ab5b0bb600069658a0f))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795388041-N17:** ([#8402](https://github.com/ashlrai/phantom/issues/8402)) ([42a7f4f](https://github.com/ashlrai/phantom/commit/42a7f4fe577964a27ee3b45d9d2b54c09ab27696))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795389062-N17:** ([#8404](https://github.com/ashlrai/phantom/issues/8404)) ([7a27e1f](https://github.com/ashlrai/phantom/commit/7a27e1f4f98711c9d43a04afa90bc5ccda91cbbe))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795390198-N17:** ([#8405](https://github.com/ashlrai/phantom/issues/8405)) ([aabf7db](https://github.com/ashlrai/phantom/commit/aabf7dbeb753c131d7917d9c1914414ce0cf8b5c))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795390777-N17:** ([#8408](https://github.com/ashlrai/phantom/issues/8408)) ([3ae8565](https://github.com/ashlrai/phantom/commit/3ae8565c1850e962dce9c070e6f33c0690fcf127))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795393702-N17:** ([#8418](https://github.com/ashlrai/phantom/issues/8418)) ([bc95a7d](https://github.com/ashlrai/phantom/commit/bc95a7d5ec952332c30a9c04735e9083caea3770))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795394328-N17:** ([#8422](https://github.com/ashlrai/phantom/issues/8422)) ([2ba5e5e](https://github.com/ashlrai/phantom/commit/2ba5e5eeddfeac39ec8daca6428bafe96f5e26a2))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795396329-N17:** ([#8427](https://github.com/ashlrai/phantom/issues/8427)) ([2f0e913](https://github.com/ashlrai/phantom/commit/2f0e913d2554b39bfdc4f36c8f2d458054a4a50d))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795397820-N17:** ([#8432](https://github.com/ashlrai/phantom/issues/8432)) ([03c17e6](https://github.com/ashlrai/phantom/commit/03c17e65430103b47d3d50e0a28811d56538d53f))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795398830-N17:** ([#8433](https://github.com/ashlrai/phantom/issues/8433)) ([5db9d46](https://github.com/ashlrai/phantom/commit/5db9d46dfb8e1203f51eab2e9732bc24a3d55db5))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795400446-N17:** ([#8435](https://github.com/ashlrai/phantom/issues/8435)) ([b0c3a3b](https://github.com/ashlrai/phantom/commit/b0c3a3b4e9059dc4fcba99fd9bd5a7af83f588f3))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795402004-N17:** ([#8438](https://github.com/ashlrai/phantom/issues/8438)) ([ef6a98d](https://github.com/ashlrai/phantom/commit/ef6a98dce21b35309a63dc0f0e6da36da4005e91))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795402667-N17:** ([#8439](https://github.com/ashlrai/phantom/issues/8439)) ([1807458](https://github.com/ashlrai/phantom/commit/1807458a918ee7bb71f1938190c9ce685e23f983))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795403172-N17:** ([#8441](https://github.com/ashlrai/phantom/issues/8441)) ([2bff8ec](https://github.com/ashlrai/phantom/commit/2bff8ec47640c2cd436e888f07e15d390c71e482))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795404373-N17:** ([#8443](https://github.com/ashlrai/phantom/issues/8443)) ([6408d42](https://github.com/ashlrai/phantom/commit/6408d4221d09e08a84c3c4a91d955b304811bc5f))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795404930-N17:** ([#8445](https://github.com/ashlrai/phantom/issues/8445)) ([c62564b](https://github.com/ashlrai/phantom/commit/c62564b78c0c4e0ec29ea3d73350621f2511e539))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795406572-N17:** ([#8449](https://github.com/ashlrai/phantom/issues/8449)) ([e0b3a67](https://github.com/ashlrai/phantom/commit/e0b3a678f5dd855f174e80da388a097de0311bad))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795407960-N17:** ([#8451](https://github.com/ashlrai/phantom/issues/8451)) ([82120a3](https://github.com/ashlrai/phantom/commit/82120a34c0d822b899372ed3114356fbb5974d80))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795410324-N17:** ([#8457](https://github.com/ashlrai/phantom/issues/8457)) ([2d5a351](https://github.com/ashlrai/phantom/commit/2d5a3514fc07e0c2551a1f155c4e99b4b26e9840))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795411943-N17:** ([#8459](https://github.com/ashlrai/phantom/issues/8459)) ([6dfd62e](https://github.com/ashlrai/phantom/commit/6dfd62e7b2b9b926075d28ac1e0a17f85ee7b8c9))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795412600-N17:** ([#8461](https://github.com/ashlrai/phantom/issues/8461)) ([508def4](https://github.com/ashlrai/phantom/commit/508def4cd83ead24fbf96656104f01cf429b5673))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795415600-N17:** ([#8468](https://github.com/ashlrai/phantom/issues/8468)) ([0b3df85](https://github.com/ashlrai/phantom/commit/0b3df8524c6f986bc4d9decc89d2fc6c1a9e296b))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795417665-N17:** ([#8472](https://github.com/ashlrai/phantom/issues/8472)) ([662cca8](https://github.com/ashlrai/phantom/commit/662cca8a721653e7799ab99894015adfffb1a805))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795419056-N17:** ([#8473](https://github.com/ashlrai/phantom/issues/8473)) ([682c484](https://github.com/ashlrai/phantom/commit/682c4843f5e09b36d08224d2d6c60b5709a174e0))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795421274-N17:** ([#8479](https://github.com/ashlrai/phantom/issues/8479)) ([89c4158](https://github.com/ashlrai/phantom/commit/89c415854a9206b5bc837a7d2ac86f0cf73784db))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795422978-N17:** ([#8483](https://github.com/ashlrai/phantom/issues/8483)) ([47cc90c](https://github.com/ashlrai/phantom/commit/47cc90c2d840c5ba18382c12e4e704700277c03d))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795425405-N17:** ([#8485](https://github.com/ashlrai/phantom/issues/8485)) ([8123dea](https://github.com/ashlrai/phantom/commit/8123dea1f4e695f18f2dd3a11ac16c1e9a828c85))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795428235-N17:** ([#8492](https://github.com/ashlrai/phantom/issues/8492)) ([1abcb16](https://github.com/ashlrai/phantom/commit/1abcb16392ed2f7f9042d3704db71eff051b283d))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795429983-N17:** ([#8496](https://github.com/ashlrai/phantom/issues/8496)) ([c11f63e](https://github.com/ashlrai/phantom/commit/c11f63ea6de9a2045eec4e65a2a866f4c1432822))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795432376-N17:** ([#8499](https://github.com/ashlrai/phantom/issues/8499)) ([06132f6](https://github.com/ashlrai/phantom/commit/06132f6bd6eb5d1b6ff8d4323d6a629924b3f31b))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795433970-N17:** ([#8501](https://github.com/ashlrai/phantom/issues/8501)) ([7dfd352](https://github.com/ashlrai/phantom/commit/7dfd35259aa7584a55c6d0ba96901de1876f80c9))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795436776-N17:** ([#8503](https://github.com/ashlrai/phantom/issues/8503)) ([c8d7303](https://github.com/ashlrai/phantom/commit/c8d7303f620197f0a2d1236b82a5c90f12f7fe96))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795441818-N17:** ([#8506](https://github.com/ashlrai/phantom/issues/8506)) ([6bc6745](https://github.com/ashlrai/phantom/commit/6bc6745da8a00b3b6d14cc2869a70427b0155e89))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795447590-N17:** ([#8509](https://github.com/ashlrai/phantom/issues/8509)) ([cb2383d](https://github.com/ashlrai/phantom/commit/cb2383d937554f72c53a3f12097008da43d73ea7))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795451304-N17:** ([#8511](https://github.com/ashlrai/phantom/issues/8511)) ([1ae91f3](https://github.com/ashlrai/phantom/commit/1ae91f375d66f4917b7cefd1a3855b6173572c74))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795455787-N17:** ([#8514](https://github.com/ashlrai/phantom/issues/8514)) ([589f7f1](https://github.com/ashlrai/phantom/commit/589f7f181c788fa8239b67a74c05dc921083dd1a))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795457380-N17:** ([#8515](https://github.com/ashlrai/phantom/issues/8515)) ([ba0a86a](https://github.com/ashlrai/phantom/commit/ba0a86a2f9583583917b212eb729b0b413a02fc3))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795458764-N17:** ([#8517](https://github.com/ashlrai/phantom/issues/8517)) ([7766ed9](https://github.com/ashlrai/phantom/commit/7766ed995dd5f2e117399644094071793f8296d5))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795460319-N17:** ([#8519](https://github.com/ashlrai/phantom/issues/8519)) ([9224e2e](https://github.com/ashlrai/phantom/commit/9224e2e470fe3e1a020c5a68ff5fe81924c28fef))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795461856-N17:** ([#8521](https://github.com/ashlrai/phantom/issues/8521)) ([dfd5c34](https://github.com/ashlrai/phantom/commit/dfd5c34853614be23fc9375bc7967a17b23012eb))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795463571-N17:** ([#8522](https://github.com/ashlrai/phantom/issues/8522)) ([b8cbf36](https://github.com/ashlrai/phantom/commit/b8cbf3694648d25d4a4cd9d04dfa834e3e25693f))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795464803-N17:** ([#8524](https://github.com/ashlrai/phantom/issues/8524)) ([875fa44](https://github.com/ashlrai/phantom/commit/875fa4418e81e7283fc37c77ca46982be2156efe))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795467267-N17:** ([#8526](https://github.com/ashlrai/phantom/issues/8526)) ([75101d9](https://github.com/ashlrai/phantom/commit/75101d910972f326b47ee69477c8ec87e601de1a))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795470300-N17:** ([#8528](https://github.com/ashlrai/phantom/issues/8528)) ([e97be69](https://github.com/ashlrai/phantom/commit/e97be69e88cf5c4ddd79baef2936f808a5acab6c))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795471824-N17:** ([#8529](https://github.com/ashlrai/phantom/issues/8529)) ([4b8b069](https://github.com/ashlrai/phantom/commit/4b8b069fcce6f0f3cf08901070f569f0cf001311))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795473392-N17:** ([#8531](https://github.com/ashlrai/phantom/issues/8531)) ([7d4ff0a](https://github.com/ashlrai/phantom/commit/7d4ff0a341e08ee473d312923666d8fa70da1dfa))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795476119-N17:** ([#8535](https://github.com/ashlrai/phantom/issues/8535)) ([81340bf](https://github.com/ashlrai/phantom/commit/81340bf96d1326055b9638dc4f888c5cd4223999))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795477425-N17:** ([#8536](https://github.com/ashlrai/phantom/issues/8536)) ([3a188d7](https://github.com/ashlrai/phantom/commit/3a188d7eb051a2170325e1a7a3d71548a24c9406))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795478230-N17:** ([#8539](https://github.com/ashlrai/phantom/issues/8539)) ([156dcde](https://github.com/ashlrai/phantom/commit/156dcdead51cd0b880cc3d9e95daa2c0445e275c))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795479403-N17:** ([#8541](https://github.com/ashlrai/phantom/issues/8541)) ([5b8c5f0](https://github.com/ashlrai/phantom/commit/5b8c5f0432b7d880ee339aec6b790675f810d522))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795481243-N17:** ([#8543](https://github.com/ashlrai/phantom/issues/8543)) ([e45eb39](https://github.com/ashlrai/phantom/commit/e45eb397a1ea78eba55df688f6a92e61e01733b4))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795482024-N17:** ([#8545](https://github.com/ashlrai/phantom/issues/8545)) ([ef96155](https://github.com/ashlrai/phantom/commit/ef961555643bb1c0463f6e0e804eea32bce842f2))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795484255-N17:** ([#8548](https://github.com/ashlrai/phantom/issues/8548)) ([6236650](https://github.com/ashlrai/phantom/commit/6236650c62fb2794c5fd3ba4e03f652845ce2725))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795485834-N17:** ([#8550](https://github.com/ashlrai/phantom/issues/8550)) ([003d071](https://github.com/ashlrai/phantom/commit/003d071ea8040a53ce7fb3d57d4958a4a0ae52e4))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795487065-N17:** ([#8551](https://github.com/ashlrai/phantom/issues/8551)) ([a446850](https://github.com/ashlrai/phantom/commit/a4468506737b688cd0ff24755bf29e266941bb6f))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795488071-N17:** ([#8553](https://github.com/ashlrai/phantom/issues/8553)) ([9eb5d39](https://github.com/ashlrai/phantom/commit/9eb5d392d21e441328eb1b33aaf85beb36aa207a))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795489553-N17:** ([#8554](https://github.com/ashlrai/phantom/issues/8554)) ([95aa56b](https://github.com/ashlrai/phantom/commit/95aa56bd2839e705cc2b0a80dcc2b3c06c980b67))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795491363-N17:** ([#8556](https://github.com/ashlrai/phantom/issues/8556)) ([5a05152](https://github.com/ashlrai/phantom/commit/5a05152d45102844288703194e158352cfe10c69))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795492658-N17:** ([#8558](https://github.com/ashlrai/phantom/issues/8558)) ([997f8f4](https://github.com/ashlrai/phantom/commit/997f8f4fe5a0064216745429f45914105555ed8d))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795493501-N17:** ([#8559](https://github.com/ashlrai/phantom/issues/8559)) ([9e092a7](https://github.com/ashlrai/phantom/commit/9e092a7a844299b1a533a98b5d835f5d8ec08f93))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795494420-N17:** ([#8561](https://github.com/ashlrai/phantom/issues/8561)) ([16126b5](https://github.com/ashlrai/phantom/commit/16126b5fe7980b5e7066ddcc9e473585dcd0d9ff))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795496092-N17:** ([#8562](https://github.com/ashlrai/phantom/issues/8562)) ([903e7e6](https://github.com/ashlrai/phantom/commit/903e7e6365d1660c4e4f9fa72fc4e50d9b5bd1af))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795497052-N17:** ([#8563](https://github.com/ashlrai/phantom/issues/8563)) ([74c01c0](https://github.com/ashlrai/phantom/commit/74c01c04a9f8f9ffa81dffbf7dfbfcec340d9dc2))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795497706-N17:** ([#8566](https://github.com/ashlrai/phantom/issues/8566)) ([7f47b6f](https://github.com/ashlrai/phantom/commit/7f47b6f5d092dfc518060b3363e274a5b17b6314))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795499720-N17:** ([#8568](https://github.com/ashlrai/phantom/issues/8568)) ([a060f2a](https://github.com/ashlrai/phantom/commit/a060f2a5f8de687da4596b8ed4495d91cc6a16f7))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795501041-N17:** ([#8572](https://github.com/ashlrai/phantom/issues/8572)) ([97b0154](https://github.com/ashlrai/phantom/commit/97b01540c17da0e6ec8dfe5ca3f47b5664d37654))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795503721-N17:** ([#8576](https://github.com/ashlrai/phantom/issues/8576)) ([be9c865](https://github.com/ashlrai/phantom/commit/be9c865f44c491b2328a011c14b56acf593a8efa))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795506764-N17:** ([#8606](https://github.com/ashlrai/phantom/issues/8606)) ([11a917d](https://github.com/ashlrai/phantom/commit/11a917d5c872c86a2acd15f742a1f24efc2b4723))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795510827-N17:** ([#8616](https://github.com/ashlrai/phantom/issues/8616)) ([5eeac86](https://github.com/ashlrai/phantom/commit/5eeac8694a8ca9cd247f1505000cd24897e3a89d))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795374122-N17:** ([#8368](https://github.com/ashlrai/phantom/issues/8368)) ([49fb785](https://github.com/ashlrai/phantom/commit/49fb78543b9384d7e71a6495a2ec6c813cb4a0bf))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795375580-N17:** ([#8374](https://github.com/ashlrai/phantom/issues/8374)) ([f1c3c02](https://github.com/ashlrai/phantom/commit/f1c3c02d8abb66461d4d2c34db37041a2082ff9d))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795376922-N17:** ([#8381](https://github.com/ashlrai/phantom/issues/8381)) ([0fa8a54](https://github.com/ashlrai/phantom/commit/0fa8a543241802da8a20780171b102bfd645a893))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795378657-N17:** ([#8386](https://github.com/ashlrai/phantom/issues/8386)) ([4e4bf0b](https://github.com/ashlrai/phantom/commit/4e4bf0b14d92ebd2ca2fc9c81b676201e6d24519))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795381080-N17:** ([#8389](https://github.com/ashlrai/phantom/issues/8389)) ([5f4e16a](https://github.com/ashlrai/phantom/commit/5f4e16a575370a815afd7d53f3baf19a67c8f06a))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795382073-N17:** ([#8393](https://github.com/ashlrai/phantom/issues/8393)) ([1baf664](https://github.com/ashlrai/phantom/commit/1baf664a861f4dbf2ba61f62c4361d9b9d77f6e6))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795387255-N17:** ([#8400](https://github.com/ashlrai/phantom/issues/8400)) ([3834119](https://github.com/ashlrai/phantom/commit/38341199f65bfcf03435aa42bfe04e5e11efc84d))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795388069-N17:** ([#8401](https://github.com/ashlrai/phantom/issues/8401)) ([247ee1c](https://github.com/ashlrai/phantom/commit/247ee1cac6cdd77f135926c053cc83d56073bdc9))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795388850-N17:** ([#8403](https://github.com/ashlrai/phantom/issues/8403)) ([12ffdd3](https://github.com/ashlrai/phantom/commit/12ffdd3d98c56b603f22b613c01267e4394c3648))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795389992-N17:** ([#8406](https://github.com/ashlrai/phantom/issues/8406)) ([8246141](https://github.com/ashlrai/phantom/commit/8246141d981c3bb06aee9b61a9e51f0f0897f672))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795391069-N17:** ([#8407](https://github.com/ashlrai/phantom/issues/8407)) ([b43a84c](https://github.com/ashlrai/phantom/commit/b43a84cb24173b5232bb5582b0164b3948eeae1f))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795392484-N17:** ([#8412](https://github.com/ashlrai/phantom/issues/8412)) ([b65e91b](https://github.com/ashlrai/phantom/commit/b65e91ba043f4772b68e3fc7a635e30eb8636f51))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795393760-N17:** ([#8417](https://github.com/ashlrai/phantom/issues/8417)) ([27cdc4d](https://github.com/ashlrai/phantom/commit/27cdc4d6fae3feb3fc498a7e53fd1307906fd073))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795394262-N17:** ([#8423](https://github.com/ashlrai/phantom/issues/8423)) ([5140070](https://github.com/ashlrai/phantom/commit/5140070c998437a32130647148e8c7dba4ac5357))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795395660-N17:** ([#8425](https://github.com/ashlrai/phantom/issues/8425)) ([abdd51e](https://github.com/ashlrai/phantom/commit/abdd51e9d383b464aa5fb5e58c15c19aa4505c64))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795396775-N17:** ([#8429](https://github.com/ashlrai/phantom/issues/8429)) ([0ba0fb5](https://github.com/ashlrai/phantom/commit/0ba0fb5dac60f461407720d2af0ea2904b452807))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795397519-N17:** ([#8431](https://github.com/ashlrai/phantom/issues/8431)) ([2bfadad](https://github.com/ashlrai/phantom/commit/2bfadad5beb3cb215a6d3ed66580a58ac643cf68))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795400485-N17:** ([#8436](https://github.com/ashlrai/phantom/issues/8436)) ([3ca5e3d](https://github.com/ashlrai/phantom/commit/3ca5e3d474d9c7efcf6739ed75ecb82ce95978b4))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795401505-N17:** ([#8440](https://github.com/ashlrai/phantom/issues/8440)) ([6f4c89f](https://github.com/ashlrai/phantom/commit/6f4c89f8db4e9d1bdfe0de9033d616fc01b2facb))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795404278-N17:** ([#8442](https://github.com/ashlrai/phantom/issues/8442)) ([4b17c10](https://github.com/ashlrai/phantom/commit/4b17c1004ca54b37b8158ac70e2f2e38285ae7bb))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795405740-N17:** ([#8447](https://github.com/ashlrai/phantom/issues/8447)) ([2ff77c8](https://github.com/ashlrai/phantom/commit/2ff77c84cadb0c18362b919681b093a905227653))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795409017-N17:** ([#8453](https://github.com/ashlrai/phantom/issues/8453)) ([783bdbd](https://github.com/ashlrai/phantom/commit/783bdbdf92b0ba4946a5f2051a4b10a3dae29260))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795410102-N17:** ([#8455](https://github.com/ashlrai/phantom/issues/8455)) ([be1b114](https://github.com/ashlrai/phantom/commit/be1b1145692a607721a19711a416153d611570af))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795412151-N17:** ([#8460](https://github.com/ashlrai/phantom/issues/8460)) ([88b8e70](https://github.com/ashlrai/phantom/commit/88b8e701533e37290dd017b0845fbff48ba13ce9))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795413148-N17:** ([#8463](https://github.com/ashlrai/phantom/issues/8463)) ([d3238c5](https://github.com/ashlrai/phantom/commit/d3238c5ed4db6e8b605719b67b791b4c92128b75))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795414342-N17:** ([#8466](https://github.com/ashlrai/phantom/issues/8466)) ([922deb5](https://github.com/ashlrai/phantom/commit/922deb58f16521928b21b9ad5c98e6ebcd111b72))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795416936-N17:** ([#8470](https://github.com/ashlrai/phantom/issues/8470)) ([b68a506](https://github.com/ashlrai/phantom/commit/b68a50645357e1ab7679e9e450ad589c650a86aa))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795419222-N17:** ([#8474](https://github.com/ashlrai/phantom/issues/8474)) ([858df05](https://github.com/ashlrai/phantom/commit/858df056c1ffa493a82bca1b9795e646c8201043))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795421198-N17:** ([#8480](https://github.com/ashlrai/phantom/issues/8480)) ([3938bf1](https://github.com/ashlrai/phantom/commit/3938bf1415481259631b0b905ad60e920d0fc849))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795424861-N17:** ([#8487](https://github.com/ashlrai/phantom/issues/8487)) ([a50de72](https://github.com/ashlrai/phantom/commit/a50de72a0e13181fdd3bc85f84df0dfa69b32aea))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795429179-N17:** ([#8494](https://github.com/ashlrai/phantom/issues/8494)) ([e0e9fc9](https://github.com/ashlrai/phantom/commit/e0e9fc9c2e34fd8833c0bbd34fa79adbf30770b9))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795431120-N17:** ([#8497](https://github.com/ashlrai/phantom/issues/8497)) ([3305f61](https://github.com/ashlrai/phantom/commit/3305f6197c073d89a587f2491ce1eb5c2e4f528f))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795433014-N17:** ([#8500](https://github.com/ashlrai/phantom/issues/8500)) ([31b9b37](https://github.com/ashlrai/phantom/commit/31b9b372fc504e57282b8f71c4c1c60e02420ee0))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795434844-N17:** ([#8502](https://github.com/ashlrai/phantom/issues/8502)) ([bb83633](https://github.com/ashlrai/phantom/commit/bb83633c01ef3d4b9746055d2460a5128d0797df))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795439181-N17:** ([#8504](https://github.com/ashlrai/phantom/issues/8504)) ([f52b28d](https://github.com/ashlrai/phantom/commit/f52b28d9422b8e02173d19b80b63f38092b8ea25))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795440569-N17:** ([#8505](https://github.com/ashlrai/phantom/issues/8505)) ([b457de4](https://github.com/ashlrai/phantom/commit/b457de4d146163b6a3c8df62eb9709fb8e393d19))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795442360-N17:** ([#8507](https://github.com/ashlrai/phantom/issues/8507)) ([a500c31](https://github.com/ashlrai/phantom/commit/a500c31ba075e83c399f0ca5d80bd3afb9ffc752))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795445928-N17:** ([#8508](https://github.com/ashlrai/phantom/issues/8508)) ([7208ea6](https://github.com/ashlrai/phantom/commit/7208ea637e29c961f7381846dd428684ad23df85))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795451163-N17:** ([#8510](https://github.com/ashlrai/phantom/issues/8510)) ([910c120](https://github.com/ashlrai/phantom/commit/910c120b80e3171e5130c6d440bed6cc16bd7308))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795452505-N17:** ([#8512](https://github.com/ashlrai/phantom/issues/8512)) ([c527efc](https://github.com/ashlrai/phantom/commit/c527efcc9b484419acdadd6a8394f9d5b703536e))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795455137-N17:** ([#8513](https://github.com/ashlrai/phantom/issues/8513)) ([a9d195a](https://github.com/ashlrai/phantom/commit/a9d195a24659494677518e07a911d0bccf568a27))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795457172-N17:** ([#8516](https://github.com/ashlrai/phantom/issues/8516)) ([3a7b9ae](https://github.com/ashlrai/phantom/commit/3a7b9ae97b8715e509327114f3d0839893d458ab))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795459041-N17:** ([#8518](https://github.com/ashlrai/phantom/issues/8518)) ([3ce9303](https://github.com/ashlrai/phantom/commit/3ce9303206c2a46abbe2764e43b0a6f1477a4a2a))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795461262-N17:** ([#8520](https://github.com/ashlrai/phantom/issues/8520)) ([ecd98f2](https://github.com/ashlrai/phantom/commit/ecd98f22fc7bdd4aa57eaebb1b644379812649b5))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795462577-N17:** ([#8523](https://github.com/ashlrai/phantom/issues/8523)) ([29cfc65](https://github.com/ashlrai/phantom/commit/29cfc65243bcd2dc6c302f098b4a4d7f92f7c7c4))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795466380-N17:** ([#8525](https://github.com/ashlrai/phantom/issues/8525)) ([1cd06c9](https://github.com/ashlrai/phantom/commit/1cd06c9786410fc85bbb3e58fe0de718dda8090a))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795468005-N17:** ([#8527](https://github.com/ashlrai/phantom/issues/8527)) ([6cbfe5b](https://github.com/ashlrai/phantom/commit/6cbfe5b8b8c9138aa0f3b16f42895da00c3f5e29))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795471650-N17:** ([#8530](https://github.com/ashlrai/phantom/issues/8530)) ([4e6eab0](https://github.com/ashlrai/phantom/commit/4e6eab03eb3287df73f9b493439b8e7adaa96680))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795473606-N17:** ([#8532](https://github.com/ashlrai/phantom/issues/8532)) ([4bc25c7](https://github.com/ashlrai/phantom/commit/4bc25c7e6883bc868e9323be7d543354376e8078))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795475020-N17:** ([#8534](https://github.com/ashlrai/phantom/issues/8534)) ([657f4d7](https://github.com/ashlrai/phantom/commit/657f4d7bcac46cf4723f3cbafdea09a8e1195861))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795476534-N17:** ([#8537](https://github.com/ashlrai/phantom/issues/8537)) ([e929508](https://github.com/ashlrai/phantom/commit/e929508463ba1fc0dbad290ae24f318716f2b6e7))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795479266-N17:** ([#8540](https://github.com/ashlrai/phantom/issues/8540)) ([d3cdcee](https://github.com/ashlrai/phantom/commit/d3cdceeafc84c4ea7788cf6a8faeceed62c690b7))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795480102-N17:** ([#8542](https://github.com/ashlrai/phantom/issues/8542)) ([9a35592](https://github.com/ashlrai/phantom/commit/9a35592a91c13ac9a73bbd53c4c76ddf9c5c7a34))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795482253-N17:** ([#8546](https://github.com/ashlrai/phantom/issues/8546)) ([39a5a6e](https://github.com/ashlrai/phantom/commit/39a5a6e93ad1a26dc991cf14004581cf45eb2d96))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795483708-N17:** ([#8547](https://github.com/ashlrai/phantom/issues/8547)) ([ad175ea](https://github.com/ashlrai/phantom/commit/ad175ea4a979daec9dd5457decdca22cc5c2711b))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795485059-N17:** ([#8549](https://github.com/ashlrai/phantom/issues/8549)) ([fda38d8](https://github.com/ashlrai/phantom/commit/fda38d8bf2e9647ffcdb5b16c32b57dd5c940166))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795486903-N17:** ([#8552](https://github.com/ashlrai/phantom/issues/8552)) ([d54159a](https://github.com/ashlrai/phantom/commit/d54159ab0e8e1cde4554dbf7398263d497f9de05))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795490377-N17:** ([#8555](https://github.com/ashlrai/phantom/issues/8555)) ([bc57a83](https://github.com/ashlrai/phantom/commit/bc57a83892130b45537d30e08833a9b37589de73))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795492013-N17:** ([#8557](https://github.com/ashlrai/phantom/issues/8557)) ([79e5e22](https://github.com/ashlrai/phantom/commit/79e5e2272dc7b146fa50200a01a233c2094abb45))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795493213-N17:** ([#8560](https://github.com/ashlrai/phantom/issues/8560)) ([f328cc3](https://github.com/ashlrai/phantom/commit/f328cc3460985ed9ad54b2338cda078cc74146c5))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795498017-N17:** ([#8565](https://github.com/ashlrai/phantom/issues/8565)) ([3c0a2a8](https://github.com/ashlrai/phantom/commit/3c0a2a8e6a56294c70616a4242c52b7898951f75))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795499138-N17:** ([#8567](https://github.com/ashlrai/phantom/issues/8567)) ([404571c](https://github.com/ashlrai/phantom/commit/404571c4f2e5e17c0f05fa5f007a13c3b313af81))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795500509-N17:** ([#8569](https://github.com/ashlrai/phantom/issues/8569)) ([90ba99d](https://github.com/ashlrai/phantom/commit/90ba99db4a0a9352eaaefec69543e6a57ffd1321))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795504897-N17:** ([#8605](https://github.com/ashlrai/phantom/issues/8605)) ([0719599](https://github.com/ashlrai/phantom/commit/0719599d119cdfbf20b8bb8967c0805fb332b7ef))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795510482-N17:** ([#8617](https://github.com/ashlrai/phantom/issues/8617)) ([70ce2fc](https://github.com/ashlrai/phantom/commit/70ce2fc6102dce0ae84083f7d2fabe68954ed2e1))
* **RQ-DRAIN-PHX-REB-01:** RQ-DRAIN-PHX-REB-01 ([#8609](https://github.com/ashlrai/phantom/issues/8609)) ([e2e08ab](https://github.com/ashlrai/phantom/commit/e2e08ab176258428b661a3823a8ba48407d1d5ef))
* **RQ-EDGE390N21QQ8:** RQ-EDGE390N21QQ8: EdgeMessagesPanel red test at 390 px ([#7536](https://github.com/ashlrai/phantom/issues/7536)) ([91ffd7f](https://github.com/ashlrai/phantom/commit/91ffd7fa591b1488ff466ed98df48961a966b2ce))
* **RQ-EMPTYWIREN25ZQ8:** RQ-EMPTYWIREN25ZQ8 ([#8365](https://github.com/ashlrai/phantom/issues/8365)) ([6de5507](https://github.com/ashlrai/phantom/commit/6de55079728645f36a414e13238fdfbb7d6fc0f5))
* **RQ-GUARDIANHEALTHQ9Q8:** RQ-GUARDIANHEALTHQ9Q8 ([#8464](https://github.com/ashlrai/phantom/issues/8464)) ([dc1bf89](https://github.com/ashlrai/phantom/commit/dc1bf894e7f9f6467787062896e8b6a82cd13cd2))
* **RQ-IMSG-BUS-ADAPT-1:** iMessage bus bridge notes ([#8608](https://github.com/ashlrai/phantom/issues/8608)) ([d7d5fc0](https://github.com/ashlrai/phantom/commit/d7d5fc01b352511117517a00a33f0fdfbd1d1a50))
* **RQ-LANEDOCSN22CQ8:** RQ-LANEDOCSN22CQ8: CLI Documentation Update ([#8396](https://github.com/ashlrai/phantom/issues/8396)) ([6e16e84](https://github.com/ashlrai/phantom/commit/6e16e84eeebe80afcad1d82dc50493b2b27ec528))
* **RQ-MAPMSGSN27BQ8:** RQ-MAPMSGSN27BQ8 ([#8369](https://github.com/ashlrai/phantom/issues/8369)) ([343590e](https://github.com/ashlrai/phantom/commit/343590e67b54c417e16b37f1ac093a8181bb2546))
* **RQ-PCEB10-AUTO-UPDATER-1:** feat(update): self-driving release updates with a resident-s ([#8596](https://github.com/ashlrai/phantom/issues/8596)) ([9f3067d](https://github.com/ashlrai/phantom/commit/9f3067ded8e83aecbb9526dde28f97575fd7e6a1))
* **RQ-PCEB10-RELEASE-GHOSTCHECK:** fix(release): treat a ghost failed check run as failed, not ([#8607](https://github.com/ashlrai/phantom/issues/8607)) ([5532f46](https://github.com/ashlrai/phantom/commit/5532f46ac98bbac2f3792c73835984abafb10108))
* **RQ-PHX-ADAPTERDOCFINISH846S:** RQ-PHX-ADAPTERDOCFINISH846S ([#8495](https://github.com/ashlrai/phantom/issues/8495)) ([d6cc880](https://github.com/ashlrai/phantom/commit/d6cc880140ac24d8956c0a38e4340a08dbf320e7))
* **RQ-PHX-ADAPTERROUTEFINISH845S:** Recovery of [#6225](https://github.com/ashlrai/phantom/issues/6225) route receipt ([#8493](https://github.com/ashlrai/phantom/issues/8493)) ([164cc38](https://github.com/ashlrai/phantom/commit/164cc3848d55097ac42ccde84a8b5bca927006ee))
* **RQ-PHX-ADAPTERSCHEMAORIGINAL844S:** Bridge handoff: partial recovery of [#6225](https://github.com/ashlrai/phantom/issues/6225) ([#8490](https://github.com/ashlrai/phantom/issues/8490)) ([c436b88](https://github.com/ashlrai/phantom/commit/c436b8869ab8a02874767dd9f5b07c590f208f92))
* **RQ-PHX-BRIEFMERGEPRESERVE815S:** Merge projection preservation — RQ-PHX-BRIEFMERGEPRESERVE815 ([#8421](https://github.com/ashlrai/phantom/issues/8421)) ([4684556](https://github.com/ashlrai/phantom/commit/4684556ee3ae37aecc686d1c64bd9c5e87f771cd))
* **RQ-PHX-BUSOPENORIGINAL800SR2:** RQ-PHX-BUSOPENORIGINAL800SR2 ([#8379](https://github.com/ashlrai/phantom/issues/8379)) ([7090cdc](https://github.com/ashlrai/phantom/commit/7090cdcdcbdca7b6b49174d437661a051b65459b))
* **RQ-PHX-CONNECTPROOFFINISH814S:** Connection inventory proof recovery ([#8419](https://github.com/ashlrai/phantom/issues/8419)) ([8eb119e](https://github.com/ashlrai/phantom/commit/8eb119ec3932f00cccc40c59a99cac333bcefbd3))
* **RQ-PHX-CONSOLELAND795:** RQ-PHX-CONSOLELAND795 ([#8372](https://github.com/ashlrai/phantom/issues/8372)) ([2bbcf34](https://github.com/ashlrai/phantom/commit/2bbcf344caad7cb71ec13c11d1af41bb6e750986))
* **RQ-PHX-CONTRIBUTIONROOTFINISH813S:** Contribution root navigation recovery ([#8420](https://github.com/ashlrai/phantom/issues/8420)) ([b126708](https://github.com/ashlrai/phantom/commit/b1267086a4da56b2c427e93bea1278720ee90bfb))
* **RQ-PHX-CONTRIBUTORINDEXFINISH805S:** Contributor index recovery ([#8392](https://github.com/ashlrai/phantom/issues/8392)) ([ee3ccc1](https://github.com/ashlrai/phantom/commit/ee3ccc1182c5667812304a0c79368ecfb63cad99))
* **RQ-PHX-EMPTYTAGORIGINAL806S:** Empty-tag original preservation receipt (806s) ([#8391](https://github.com/ashlrai/phantom/issues/8391)) ([771339a](https://github.com/ashlrai/phantom/commit/771339a391d05943c3c5b62d116d281c056a493e))
* **RQ-PHX-FLEETCORELAND793:** Fleet core preservation: RQ-PHX-FLEETCORELAND793 ([#8377](https://github.com/ashlrai/phantom/issues/8377)) ([8a1d356](https://github.com/ashlrai/phantom/commit/8a1d3565e85771aaac4bd082de4c5e3c70fa8933))
* **RQ-PHX-FLEETCORELAND795:** RQ-PHX-FLEETCORELAND795 ([#8383](https://github.com/ashlrai/phantom/issues/8383)) ([4c0a149](https://github.com/ashlrai/phantom/commit/4c0a1490759ad7c79a7645f7fae2bbb06091de47))
* **RQ-PHX-FLEETCORELAND797:** RQ-PHX-FLEETCORELAND797 ([#8384](https://github.com/ashlrai/phantom/issues/8384)) ([b6b3d48](https://github.com/ashlrai/phantom/commit/b6b3d48292d16c468e1ccd98e339960ee7a6f98c))
* **RQ-PHX-FLEETCORELAND798:** RQ-PHX-FLEETCORELAND798 ([#8382](https://github.com/ashlrai/phantom/issues/8382)) ([e5d6867](https://github.com/ashlrai/phantom/commit/e5d6867da8137ae121ac3419549232cd0bfd29bf))
* **RQ-PHX-FLEETCORELAND800B:** RQ-PHX-FLEETCORELAND800B ([#8388](https://github.com/ashlrai/phantom/issues/8388)) ([074bc2d](https://github.com/ashlrai/phantom/commit/074bc2d5d062b9c0cd23fe2639f74fb06e7d664c))
* **RQ-PHX-GHOSTDISCOVERYFINISH829S:** Ghost discovery recovery ([#8456](https://github.com/ashlrai/phantom/issues/8456)) ([614c174](https://github.com/ashlrai/phantom/commit/614c17482d88298dbe2849be59f92c092bacee62))
* **RQ-PHX-GHOSTORIGINAL828S:** PR [#8020](https://github.com/ashlrai/phantom/issues/8020) recovery (partial) ([#8452](https://github.com/ashlrai/phantom/issues/8452)) ([d998c54](https://github.com/ashlrai/phantom/commit/d998c541844f293f280db2f9556093b1310573c0))
* **RQ-PHX-GLOSSARYORIGINAL811S:** Glossary recovery (partial [#8122](https://github.com/ashlrai/phantom/issues/8122)) ([#8413](https://github.com/ashlrai/phantom/issues/8413)) ([d51059a](https://github.com/ashlrai/phantom/commit/d51059acedcdeeb12a7c0f03694f5de52d432fda))
* **RQ-PHX-IDLEROUNDTRIPFINISH855S:** Idle evidence round-trip bridge ([#8612](https://github.com/ashlrai/phantom/issues/8612)) ([06ff964](https://github.com/ashlrai/phantom/commit/06ff9648d460187786792ecb71388d4e0d00251b))
* **RQ-PHX-INGRESSDOCOWNERQUALIFY525S:** Owner-share documentation handoff ([#6638](https://github.com/ashlrai/phantom/issues/6638)) ([555c1b7](https://github.com/ashlrai/phantom/commit/555c1b7b387c3cb12e1c0f8179e4a21df2f7d669))
* **RQ-PHX-INSTALLPREVIEWORIGINAL826S:** Fleet install preview recovery ([#8448](https://github.com/ashlrai/phantom/issues/8448)) ([6a724ef](https://github.com/ashlrai/phantom/commit/6a724ef63442068181bd95875885e82ce466159d))
* **RQ-PHX-LANEADAPTPROOF843S:** Lane adaptation evidence bridge ([#8489](https://github.com/ashlrai/phantom/issues/8489)) ([d042a04](https://github.com/ashlrai/phantom/commit/d042a04a6702e2678a0745b5c88e400bf791a2f5))
* **RQ-PHX-MAPMINUTESORIGINAL836S:** Map minutes recovery ([#8475](https://github.com/ashlrai/phantom/issues/8475)) ([aeca21b](https://github.com/ashlrai/phantom/commit/aeca21bb2dc200f01c860cd1c2fbd8da5cc4d50a))
* **RQ-PHX-PACKAGEHISTORYORIGINAL831S:** Package history preservation: [#7958](https://github.com/ashlrai/phantom/issues/7958) ([#8462](https://github.com/ashlrai/phantom/issues/8462)) ([48bb429](https://github.com/ashlrai/phantom/commit/48bb4295f0d56bc4231451ee38212a861b0ff36c))
* **RQ-PHX-POOLBRIEFORIGINAL825S:** PR [#8042](https://github.com/ashlrai/phantom/issues/8042) preservation bridge ([#8446](https://github.com/ashlrai/phantom/issues/8446)) ([1c3bc7a](https://github.com/ashlrai/phantom/commit/1c3bc7a441ada11a11c613734593113d8a72c994))
* **RQ-PHX-REAPERORIGINALPROOF817S:** Reaper health preservation, PR [#8129](https://github.com/ashlrai/phantom/issues/8129) ([#8424](https://github.com/ashlrai/phantom/issues/8424)) ([42335e6](https://github.com/ashlrai/phantom/commit/42335e6771026262080ed2a0bd519a991ed2b5ac))
* **RQ-PHX-RECUTPREFLIGHTRECOVER809S:** Recut preflight recovery ([#8414](https://github.com/ashlrai/phantom/issues/8414)) ([f14c75e](https://github.com/ashlrai/phantom/commit/f14c75e137946162f524382060309a85ea7e4603))
* **RQ-PHX-RELEASEBACKLOGORIGINAL819S:** Original release-backlog reconciliation ([#8430](https://github.com/ashlrai/phantom/issues/8430)) ([3daca32](https://github.com/ashlrai/phantom/commit/3daca3242dc5648b52cd594c97560fd1092f6e61))
* **RQ-PHX-RETURNQUALIFYFINISH608S:** RQ-PHX-RETURNQUALIFYFINISH608S ([#7034](https://github.com/ashlrai/phantom/issues/7034)) ([5714108](https://github.com/ashlrai/phantom/commit/57141082518a1e132ba896ae5dae75fc2a5816d4))
* **RQ-PHX-SLACKPRRECONCILE800:** RQ-PHX-SLACKPRRECONCILE800 ([#8373](https://github.com/ashlrai/phantom/issues/8373)) ([e000687](https://github.com/ashlrai/phantom/commit/e00068789bb05ac192226a4359d5553083351e89))
* **RQ-PHX-STALEPROCESSORIGINAL830S:** RQ-PHX-STALEPROCESSORIGINAL830S ([#8458](https://github.com/ashlrai/phantom/issues/8458)) ([b11aba7](https://github.com/ashlrai/phantom/commit/b11aba78a3a11ab7da93c7fe10097d37eb652212))
* **RQ-PHX-TICKSLOWBRIEFORIGINAL839S:** Bridge notes ([#8481](https://github.com/ashlrai/phantom/issues/8481)) ([542f332](https://github.com/ashlrai/phantom/commit/542f33222baee7f3fcc9fb7feacb9d6c965603c7))
* **RQ-PHX-TOOLCHAINOPTIONALFINISH818S:** PR 8090 optional companion preservation ([#8428](https://github.com/ashlrai/phantom/issues/8428)) ([6d14357](https://github.com/ashlrai/phantom/commit/6d1435736588b62558daa52cca888692e51d53e9))
* **RQ-PHX-TYPEENTRYRECOVER808S:** Type entry point recovery 808s ([#8411](https://github.com/ashlrai/phantom/issues/8411)) ([fdde2c5](https://github.com/ashlrai/phantom/commit/fdde2c520f8a837b1b564f6758205c212d8b246d))
* **RQ-PHX-WBHELPORIGINAL847S:** Workbench read-help original reconciliation ([#8498](https://github.com/ashlrai/phantom/issues/8498)) ([6ccb960](https://github.com/ashlrai/phantom/commit/6ccb960247e122631114fbaddd714a30cae78aa8))
* **RQ-STATECOMPLETENESSQ8:** RQ-STATECOMPLETENESSQ8 ([#8471](https://github.com/ashlrai/phantom/issues/8471)) ([49df553](https://github.com/ashlrai/phantom/commit/49df553878d22cbf75f6ec048e976849ab71560c))
* **RQ-STATEFRESHNESSQ8:** RQ-STATEFRESHNESSQ8 ([#8454](https://github.com/ashlrai/phantom/issues/8454)) ([d8bf8b4](https://github.com/ashlrai/phantom/commit/d8bf8b4d6c0d58832f6dca638a6df7593f4aaabd))
* **RQ-STATEVISIBILITYQ8:** RQ-STATEVISIBILITYQ8 ([#8484](https://github.com/ashlrai/phantom/issues/8484)) ([c13bb74](https://github.com/ashlrai/phantom/commit/c13bb7479a4368bb4f927d3627aa8b928f008ce0))


### Documentation

* **readme:** live growth badges + Join the mission section ([#8573](https://github.com/ashlrai/phantom/issues/8573)) ([1c441d8](https://github.com/ashlrai/phantom/commit/1c441d8407252213b2baccd5be599ae4c98fc52b))


### Tests

* **fleet:** pin tick-cost fleet-entry refusal ([#8571](https://github.com/ashlrai/phantom/issues/8571)) ([3a660c3](https://github.com/ashlrai/phantom/commit/3a660c3cb33be737fdd6e92803f8d771aada3bb1))


### CI

* per-OS gates and install-smoke path filters ([#8590](https://github.com/ashlrai/phantom/issues/8590)) ([ea6a988](https://github.com/ashlrai/phantom/commit/ea6a98878fccde315351686d7402d93fb8b3bdea))
* reuse the fast-gate import graph and ignore read-only cache saves ([#8574](https://github.com/ashlrai/phantom/issues/8574)) ([242987c](https://github.com/ashlrai/phantom/commit/242987c7b0dee5fda839d60c02653c1eac1a3360))

## [3.30.72] - 2026-11-22


### Changes

* **RQ-CL-DOCS-1795367711:** ([#8338](https://github.com/ashlrai/phantom/issues/8338)) ([c9d1e9c](https://github.com/ashlrai/phantom/commit/c9d1e9c17eea9ef521d74c673d3c69a73679533a))
* **RQ-PHX-ADAPTDIGESTORIGINAL796S:** Bridge notes: lane adaptation digest ([#8341](https://github.com/ashlrai/phantom/issues/8341)) ([ec54f5c](https://github.com/ashlrai/phantom/commit/ec54f5cbde5f2ee7b816b56dd302780f3ffe7b24))
* **RQ-PHX-SLACKORIGINALPROOF792S:** PR [#7504](https://github.com/ashlrai/phantom/issues/7504) preservation receipt ([#8339](https://github.com/ashlrai/phantom/issues/8339)) ([10bc82c](https://github.com/ashlrai/phantom/commit/10bc82c6294716aa6b0d2c7e4697ed8c8c1fc0da))
* **RQ-YIELDCARDN25HQ8:** RQ-YIELDCARDN25HQ8 ([#8340](https://github.com/ashlrai/phantom/issues/8340)) ([6aa5479](https://github.com/ashlrai/phantom/commit/6aa5479eb884d9cbf98182513011e1fdae24c963))

## [3.30.71] - 2026-11-22


### Changes

* **RQ-CL-DOCS-1795364719:** ([#8327](https://github.com/ashlrai/phantom/issues/8327)) ([1400ec0](https://github.com/ashlrai/phantom/commit/1400ec06cb1b2844f6ec933822131bbf2948e951))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795362217-N17:** ([#8321](https://github.com/ashlrai/phantom/issues/8321)) ([e7c250b](https://github.com/ashlrai/phantom/commit/e7c250b5f82a3d5f219a651c96679e858687c76b))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795364344-N17:** ([#8331](https://github.com/ashlrai/phantom/issues/8331)) ([30a9501](https://github.com/ashlrai/phantom/commit/30a9501670aa0914749db9fe65efebfc278edcbb))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795361627-N17:** ([#8318](https://github.com/ashlrai/phantom/issues/8318)) ([f974910](https://github.com/ashlrai/phantom/commit/f97491004081667853fc72acd0fbe6b1fda79cde))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795362954-N17:** ([#8324](https://github.com/ashlrai/phantom/issues/8324)) ([4d86182](https://github.com/ashlrai/phantom/commit/4d86182042ee8e52ea811f9db278330fd1ae6d94))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795364763-N17:** ([#8329](https://github.com/ashlrai/phantom/issues/8329)) ([c39c88c](https://github.com/ashlrai/phantom/commit/c39c88c3275e5678aa0e3b8a22915fcb0f585008))
* **RQ-MOBILEADMITN24UQ8:** RQ-MOBILEADMITN24UQ8 ([#8323](https://github.com/ashlrai/phantom/issues/8323)) ([f9ad0bb](https://github.com/ashlrai/phantom/commit/f9ad0bbeb2f3951020aaef04034c6617620c2613))
* **RQ-OPENPRSNAPQ8:** RQ-OPENPRSNAPQ8 ([#8320](https://github.com/ashlrai/phantom/issues/8320)) ([6d11ee0](https://github.com/ashlrai/phantom/commit/6d11ee087ff0f853c4aad337b8febb316900094e))
* **RQ-PHX-CONSOLELAND793:** RQ-PHX-CONSOLELAND793 ([#8330](https://github.com/ashlrai/phantom/issues/8330)) ([6eacea4](https://github.com/ashlrai/phantom/commit/6eacea49644790697e92ca03c3b36f83a986e7be))
* **RQ-PHX-FLEETCORELAND791B:** RQ-PHX-FLEETCORELAND791B ([#8325](https://github.com/ashlrai/phantom/issues/8325)) ([c2eb8ec](https://github.com/ashlrai/phantom/commit/c2eb8ecf112dc6c3f04827489904870d1b02e332))
* **RQ-PHX-FLEETCORELAND791:** RQ-PHX-FLEETCORELAND791 — no eligible source ([#8326](https://github.com/ashlrai/phantom/issues/8326)) ([ce1a413](https://github.com/ashlrai/phantom/commit/ce1a4134e1bd0305d6fa1bc94192667a8cfab9f6))

## [3.30.70] - 2026-11-22


### Changes

* **FIXUP-CI-phantom-dependency-audit-409866:** FIXUP-CI-phantom-dependency-audit-409866 ([#8305](https://github.com/ashlrai/phantom/issues/8305)) ([9386682](https://github.com/ashlrai/phantom/commit/938668222402726bf765536764e24bafc7a11e6c))
* **RQ-ADMITPANELN24SQ8:** RQ-ADMITPANELN24SQ8 ([#8308](https://github.com/ashlrai/phantom/issues/8308)) ([3e12053](https://github.com/ashlrai/phantom/commit/3e1205312ff293e94fba79f63d9995c4dea89b05))
* **RQ-CL-DOCS-1795358301:** ([#8304](https://github.com/ashlrai/phantom/issues/8304)) ([8177294](https://github.com/ashlrai/phantom/commit/81772944d1cef58584207fc3a8d8450f9e1ed322))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795359832-N17:** ([#8307](https://github.com/ashlrai/phantom/issues/8307)) ([3e82149](https://github.com/ashlrai/phantom/commit/3e82149cfaad8462ca835932f45c556a97e284a2))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795358229-N17:** ([#8303](https://github.com/ashlrai/phantom/issues/8303)) ([231be0f](https://github.com/ashlrai/phantom/commit/231be0f548f7ff6228067e4148a85ece319f3ff3))
* **RQ-IOLOADBLAMEN24SQ8:** RQ-IOLOADBLAMEN24SQ8 ([#8306](https://github.com/ashlrai/phantom/issues/8306)) ([0ce0f0a](https://github.com/ashlrai/phantom/commit/0ce0f0a185075b34b450a5d2a06ad332e8b82938))

## [3.30.69] - 2026-11-22


### Changes

* **RQ-CL-DOCS-1795351288:** ([#8267](https://github.com/ashlrai/phantom/issues/8267)) ([7f0ef74](https://github.com/ashlrai/phantom/commit/7f0ef74047c262ab56ae7d397163d6c6e08fa7a4))
* **RQ-CL-DOCS-1795354221:** ([#8281](https://github.com/ashlrai/phantom/issues/8281)) ([dc498ba](https://github.com/ashlrai/phantom/commit/dc498ba7154a7a5a07d37ade591992381b4ef269))
* **RQ-CL-DOCS-1795356166:** ([#8295](https://github.com/ashlrai/phantom/issues/8295)) ([123b0e7](https://github.com/ashlrai/phantom/commit/123b0e7e7a73e898ab395d6e69014d21ff3d06f7))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795350712-N17:** ([#8269](https://github.com/ashlrai/phantom/issues/8269)) ([00704d3](https://github.com/ashlrai/phantom/commit/00704d3b2a13e8421bcdfe00bc9936df3df83b37))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795352447-N17:** ([#8283](https://github.com/ashlrai/phantom/issues/8283)) ([b9432b2](https://github.com/ashlrai/phantom/commit/b9432b287c3ec92b7b8ac9a00467e50d33550531))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795354522-N17:** ([#8289](https://github.com/ashlrai/phantom/issues/8289)) ([0663b82](https://github.com/ashlrai/phantom/commit/0663b8245a900b1356dc453226c9b780098c9f22))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795355527-N17:** ([#8294](https://github.com/ashlrai/phantom/issues/8294)) ([144a614](https://github.com/ashlrai/phantom/commit/144a6149d5693ec6180afc6fc6fc4695f202c625))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795357633-N17:** ([#8300](https://github.com/ashlrai/phantom/issues/8300)) ([7c1cbba](https://github.com/ashlrai/phantom/commit/7c1cbbad628be4bcce2323fdcdbb866e5e2aa14c))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795349272-N17:** ([#8266](https://github.com/ashlrai/phantom/issues/8266)) ([d96fd43](https://github.com/ashlrai/phantom/commit/d96fd43a10b7fcf7f62549a7bf81535794b0a0cb))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795351390-N17:** ([#8277](https://github.com/ashlrai/phantom/issues/8277)) ([fec2022](https://github.com/ashlrai/phantom/commit/fec2022084b7b367d9ff50fa77797a56e7c234eb))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795353946-N17:** ([#8287](https://github.com/ashlrai/phantom/issues/8287)) ([83fecc2](https://github.com/ashlrai/phantom/commit/83fecc296c7268d8faad4a68eb0bc858fb7c4bb0))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795355175-N17:** ([#8297](https://github.com/ashlrai/phantom/issues/8297)) ([d1f0b2c](https://github.com/ashlrai/phantom/commit/d1f0b2c9a4d0a393dcd177c1daa8d6766b56c03c))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795356654-N17:** ([#8298](https://github.com/ashlrai/phantom/issues/8298)) ([5bad260](https://github.com/ashlrai/phantom/commit/5bad260e78e99f2c0b8319fe61876494f754c05b))
* **RQ-EMPTYCOSTN24KQ8:** Bridge notes ([#8279](https://github.com/ashlrai/phantom/issues/8279)) ([e354ec8](https://github.com/ashlrai/phantom/commit/e354ec83862a56b7017963d4a86acb54905c81c2))
* **RQ-HOSTORPHANSQ8:** RQ-HOSTORPHANSQ8 ([#8270](https://github.com/ashlrai/phantom/issues/8270)) ([72237a6](https://github.com/ashlrai/phantom/commit/72237a60ac674aa9827eb425870759c0ce8bbdfe))
* **RQ-PHX-CONSOLELAND782:** RQ-PHX-CONSOLELAND782 ([#8268](https://github.com/ashlrai/phantom/issues/8268)) ([656e17b](https://github.com/ashlrai/phantom/commit/656e17bc96421c4ac1de3fb91eaeff281d579651))
* **RQ-PHX-CONSOLELAND783:** RQ-PHX-CONSOLELAND783 ([#8285](https://github.com/ashlrai/phantom/issues/8285)) ([88ae884](https://github.com/ashlrai/phantom/commit/88ae884ca3f16dd973c74e6e4c3de6315390ee98))
* **RQ-PHX-CONSOLELAND785:** RQ-PHX-CONSOLELAND785 ([#8278](https://github.com/ashlrai/phantom/issues/8278)) ([e8c1690](https://github.com/ashlrai/phantom/commit/e8c1690323b980c7cb54b51fc17d3c8493323f54))
* **RQ-PHX-CONSOLELAND786:** RQ-PHX-CONSOLELAND786 ([#8288](https://github.com/ashlrai/phantom/issues/8288)) ([b29c57c](https://github.com/ashlrai/phantom/commit/b29c57c3b3aa2f63d567d5fa004152e6edc8070d))
* **RQ-PHX-DIGESTASOFPRESERVE784S:** Change digest as-of preservation ([#8275](https://github.com/ashlrai/phantom/issues/8275)) ([6083369](https://github.com/ashlrai/phantom/commit/6083369eaa94026b781fbd92aea4eb20f60340fa))
* **RQ-PHX-DOCSLAND782:** RQ-PHX-DOCSLAND782 ([#8271](https://github.com/ashlrai/phantom/issues/8271)) ([14d0604](https://github.com/ashlrai/phantom/commit/14d0604f856d652a7f26a195cf1f63cac7d7fe4b))
* **RQ-PHX-DOCSLAND783:** RQ-PHX-DOCSLAND783 ([#8280](https://github.com/ashlrai/phantom/issues/8280)) ([fd2d47f](https://github.com/ashlrai/phantom/commit/fd2d47f17144c8c7f577c65529f48f0151d68c15))
* **RQ-PHX-DOCSLAND784:** RQ-PHX-DOCSLAND784 ([#8282](https://github.com/ashlrai/phantom/issues/8282)) ([79138bd](https://github.com/ashlrai/phantom/commit/79138bd1a82023e240856ad3e717d70496da9286))
* **RQ-PHX-DOCSLAND785:** RQ-PHX-DOCSLAND785 ([#8284](https://github.com/ashlrai/phantom/issues/8284)) ([1a593c2](https://github.com/ashlrai/phantom/commit/1a593c2a95a0215bc8d735e57eb7a5a8dc8c5f2e))
* **RQ-PHX-DOCSLAND786:** RQ-PHX-DOCSLAND786 ([#8286](https://github.com/ashlrai/phantom/issues/8286)) ([4469cf3](https://github.com/ashlrai/phantom/commit/4469cf3d924e0071204308d43205974afaaad0bd))
* **RQ-PHX-DOCSLAND789:** RQ-PHX-DOCSLAND789 ([#8299](https://github.com/ashlrai/phantom/issues/8299)) ([0fe74f7](https://github.com/ashlrai/phantom/commit/0fe74f7176767a36333bee14b02d7de974fc30a5))
* **RQ-PHX-FLEETCORELAND784:** RQ-PHX-FLEETCORELAND784 ([#8291](https://github.com/ashlrai/phantom/issues/8291)) ([fc24140](https://github.com/ashlrai/phantom/commit/fc2414076010a7bb748e2e3ddf1a82a1d0763c51))
* **RQ-PHX-FLEETCORELAND785:** RQ-PHX-FLEETCORELAND785 ([#8290](https://github.com/ashlrai/phantom/issues/8290)) ([77fd7e2](https://github.com/ashlrai/phantom/commit/77fd7e27352ea2dfb248e2c5fe6234d9aa102eda))
* **RQ-PHX-FLEETCORELAND786:** RQ-PHX-FLEETCORELAND786 ([#8293](https://github.com/ashlrai/phantom/issues/8293)) ([1856dba](https://github.com/ashlrai/phantom/commit/1856dbaa94c7154614212541392ad32e80484608))
* **RQ-PHX-KEPTPATCHRECOVER783S:** RQ-PHX-KEPTPATCHRECOVER783S bridge ([#8276](https://github.com/ashlrai/phantom/issues/8276)) ([58189bb](https://github.com/ashlrai/phantom/commit/58189bbe688164f2dd643b686adb0d5b92ab2101))
* **RQ-PHX-MODELCAPROUTERECOVER782S:** Runtime model-cap routing recovery ([#8274](https://github.com/ashlrai/phantom/issues/8274)) ([b0e328a](https://github.com/ashlrai/phantom/commit/b0e328abd59298a80c912dece6f990486db424c9))
* **RQ-PHX-NODEDISPATCHPRESERVE787S:** RQ-PHX-NODEDISPATCHPRESERVE787S ([#8296](https://github.com/ashlrai/phantom/issues/8296)) ([fb7761e](https://github.com/ashlrai/phantom/commit/fb7761e93831765c86512b320d2b49120e82158e))

## [3.30.68] - 2026-11-22


### Changes

* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795346064-N17:** ([#8252](https://github.com/ashlrai/phantom/issues/8252)) ([3701cd2](https://github.com/ashlrai/phantom/commit/3701cd2df43c60257e75c1e61733479048fc1cd1))
* **RQ-PHX-DOCSLAND780:** RQ-PHX-DOCSLAND780 ([#8251](https://github.com/ashlrai/phantom/issues/8251)) ([b208bac](https://github.com/ashlrai/phantom/commit/b208bac1cbd79eb8c74b4b5da0c3902c69916cfe))

## [3.30.67] - 2026-11-22


### Changes

* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795344379-N17:** ([#8236](https://github.com/ashlrai/phantom/issues/8236)) ([c0252c6](https://github.com/ashlrai/phantom/commit/c0252c671e4fe7e43b4054e815a3407e7a3ad122))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795345519-N17:** ([#8242](https://github.com/ashlrai/phantom/issues/8242)) ([c7240a7](https://github.com/ashlrai/phantom/commit/c7240a7c1a0118c827ce2329467e21c0ea47bfb5))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795343732-N17:** ([#8230](https://github.com/ashlrai/phantom/issues/8230)) ([86ba8b9](https://github.com/ashlrai/phantom/commit/86ba8b9ce9caf9e3e055fe452c1a1cfa7ff83de1))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795344796-N17:** ([#8241](https://github.com/ashlrai/phantom/issues/8241)) ([81a4fd5](https://github.com/ashlrai/phantom/commit/81a4fd5ebfab4ea358eec3f0e5ec11f097f1babc))
* **RQ-MERGELATENCYN25Q8:** RQ-MERGELATENCYN25Q8 ([#8240](https://github.com/ashlrai/phantom/issues/8240)) ([6eb59ba](https://github.com/ashlrai/phantom/commit/6eb59ba41290b326d8729bfb00c107eddea299bb))
* **RQ-PHX-CONSOLELAND777:** RQ-PHX-CONSOLELAND777 ([#8239](https://github.com/ashlrai/phantom/issues/8239)) ([144ce92](https://github.com/ashlrai/phantom/commit/144ce92c96b4f651a8c43a0566e974ac84b8554b))
* **RQ-PHX-DOCSLAND776:** RQ-PHX-DOCSLAND776 ([#8231](https://github.com/ashlrai/phantom/issues/8231)) ([2c60d40](https://github.com/ashlrai/phantom/commit/2c60d408b477615f7975ec4b5bf8e06276c8cb68))
* **RQ-PHX-FLEETCORELAND776:** RQ-PHX-FLEETCORELAND776 ([#8235](https://github.com/ashlrai/phantom/issues/8235)) ([1a7fe31](https://github.com/ashlrai/phantom/commit/1a7fe31696de3e27e3905d4a86968eca15ae3208))
* **RQ-PHX-LEADERLAND776:** RQ-PHX-LEADERLAND776 ([#8237](https://github.com/ashlrai/phantom/issues/8237)) ([d934fb6](https://github.com/ashlrai/phantom/commit/d934fb67c38b2d1f220fc203ef9ab20bc74bdedc))
* **RQ-PHX-LIVESNAPSHOTBRIEFRECOVER776S:** Live snapshot brief recovery ([#8232](https://github.com/ashlrai/phantom/issues/8232)) ([36b72ac](https://github.com/ashlrai/phantom/commit/36b72ac4775a690bcb9c86fe1b99b65e5aa3ebfb))
* **RQ-PHX-SLACKITEMEVIDENCERECOVER776S:** Slack item evidence recovery ([#8233](https://github.com/ashlrai/phantom/issues/8233)) ([7d86fd8](https://github.com/ashlrai/phantom/commit/7d86fd814ca80533283cd902819626b6d26fcaf2))

## [3.30.66] - 2026-11-22


### Changes

* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795343255-N17:** ([#8224](https://github.com/ashlrai/phantom/issues/8224)) ([a8d95a9](https://github.com/ashlrai/phantom/commit/a8d95a989737c3130f8b0b030120b78d255b25e8))

## [3.30.65] - 2026-11-22


### Changes

* **RQ-CL-DOCS-1795336123:** ([#8192](https://github.com/ashlrai/phantom/issues/8192)) ([b08a9ec](https://github.com/ashlrai/phantom/commit/b08a9ec3bf6abb8dfc271f3d4c9f8b6f4525cd30))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795334161-N17:** ([#8187](https://github.com/ashlrai/phantom/issues/8187)) ([15fbe3e](https://github.com/ashlrai/phantom/commit/15fbe3ece8e052de260af45886f2f215d427facd))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795336127-N17:** ([#8194](https://github.com/ashlrai/phantom/issues/8194)) ([d416957](https://github.com/ashlrai/phantom/commit/d4169570d00705c6308d6733e6f0f93036bc941f))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795336823-N17:** ([#8199](https://github.com/ashlrai/phantom/issues/8199)) ([5f31d40](https://github.com/ashlrai/phantom/commit/5f31d402656334e73e5a9eae4e930042887826a2))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795337676-N17:** ([#8205](https://github.com/ashlrai/phantom/issues/8205)) ([fd1c0a7](https://github.com/ashlrai/phantom/commit/fd1c0a722ef5607c158bf9ffe708cdfbf6df84b1))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795338446-N17:** ([#8208](https://github.com/ashlrai/phantom/issues/8208)) ([ae56273](https://github.com/ashlrai/phantom/commit/ae56273f33050580a4542d1b3ad749d4e662390a))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795334920-N17:** ([#8185](https://github.com/ashlrai/phantom/issues/8185)) ([ceda1c2](https://github.com/ashlrai/phantom/commit/ceda1c28bc60d8c28fe803043e1aae490ac76bf5))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795336001-N17:** ([#8198](https://github.com/ashlrai/phantom/issues/8198)) ([1088382](https://github.com/ashlrai/phantom/commit/108838202b587a407f1c6838ed6b3aee9f09a5e6))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795337305-N17:** ([#8202](https://github.com/ashlrai/phantom/issues/8202)) ([0e994bd](https://github.com/ashlrai/phantom/commit/0e994bd8a7b8a566ee8701562c95fdcdfa1e0f1f))
* **RQ-DOCSCODEXPHXN24AQ8:** RQ-DOCSCODEXPHXN24AQ8 ([#8188](https://github.com/ashlrai/phantom/issues/8188)) ([2ac53f6](https://github.com/ashlrai/phantom/commit/2ac53f6880d6c7cdc860fe348dc70461a8a4a2d2))
* **RQ-GUARDHEALTH24Q8:** RQ-GUARDHEALTH24Q8 ([#8201](https://github.com/ashlrai/phantom/issues/8201)) ([96fe5aa](https://github.com/ashlrai/phantom/commit/96fe5aae543e0aa38fd783e9d73ba548f605b153))
* **RQ-PHX-CONNECTOWNERRECOVER772S:** RQ-PHX-CONNECTOWNERRECOVER772S ([#8200](https://github.com/ashlrai/phantom/issues/8200)) ([6b2a12f](https://github.com/ashlrai/phantom/commit/6b2a12f6e38b98d9c62e9560030e05c0faa2f650))
* **RQ-PHX-DOCSBACKLOG767:** RQ-PHX-DOCSBACKLOG767 ([#8182](https://github.com/ashlrai/phantom/issues/8182)) ([d1fa9a7](https://github.com/ashlrai/phantom/commit/d1fa9a7c37d8a91f8d2fbef93b2837486e9350fb))
* **RQ-PHX-DOCSLAND768:** RQ-PHX-DOCSLAND768 ([#8191](https://github.com/ashlrai/phantom/issues/8191)) ([f1ae051](https://github.com/ashlrai/phantom/commit/f1ae051f85fe9ca1af244c67d78df6cfa9623c62))
* **RQ-PHX-DOCSLAND770:** RQ-PHX-DOCSLAND770 ([#8197](https://github.com/ashlrai/phantom/issues/8197)) ([09a8f13](https://github.com/ashlrai/phantom/commit/09a8f135530650e8406326216f4191185a8cd92b))
* **RQ-PHX-DOCSLAND774:** RQ-PHX-DOCSLAND774 ([#8211](https://github.com/ashlrai/phantom/issues/8211)) ([b49d06c](https://github.com/ashlrai/phantom/commit/b49d06cd0e3872ad4c7671c1e4335d93328cb973))
* **RQ-PHX-FLEETCORELAND770:** RQ-PHX-FLEETCORELAND770 ([#8212](https://github.com/ashlrai/phantom/issues/8212)) ([6eabac5](https://github.com/ashlrai/phantom/commit/6eabac551691ea1094db3c5c642a50bdb8fd1c38))
* **RQ-PHX-FLEETVERBBACKLOG767:** RQ-PHX-FLEETVERBBACKLOG767 ([#8184](https://github.com/ashlrai/phantom/issues/8184)) ([c3099a1](https://github.com/ashlrai/phantom/commit/c3099a10c8bf6e921168bcbb27a44232e929aa57))
* **RQ-PHX-INGESTDOCTORPRESERVE769S:** RQ-PHX-INGESTDOCTORPRESERVE769S ([#8193](https://github.com/ashlrai/phantom/issues/8193)) ([0f84be6](https://github.com/ashlrai/phantom/commit/0f84be694b40bf5cda85094b48a32411d8ccdb90))
* **RQ-PHX-LEADERBACKLOG767:** RQ-PHX-LEADERBACKLOG767 ([#8183](https://github.com/ashlrai/phantom/issues/8183)) ([8ec4386](https://github.com/ashlrai/phantom/commit/8ec4386e1300b3cb361c06be133da332f8036601))
* **RQ-PHX-RELAUNCHOWNERRECOVER771S:** RQ-PHX-RELAUNCHOWNERRECOVER771S ([#8204](https://github.com/ashlrai/phantom/issues/8204)) ([720c4ab](https://github.com/ashlrai/phantom/commit/720c4ab844372dec37968ab86f97723772a56a0f))
* **RQ-PHX-SCRIPTSLAND769:** RQ-PHX-SCRIPTSLAND769 ([#8209](https://github.com/ashlrai/phantom/issues/8209)) ([9c99028](https://github.com/ashlrai/phantom/commit/9c9902800b1364f15fdb215777f9d407e789c45f))
* **RQ-PHX-SCRIPTSLAND771:** RQ-PHX-SCRIPTSLAND771 ([#8206](https://github.com/ashlrai/phantom/issues/8206)) ([cbc240a](https://github.com/ashlrai/phantom/commit/cbc240a19b0d1fa3d8958cb5870f8d553839d585))
* **RQ-PHX-SCRIPTSLAND772:** RQ-PHX-SCRIPTSLAND772 — no unique candidate ([#8207](https://github.com/ashlrai/phantom/issues/8207)) ([944fdc0](https://github.com/ashlrai/phantom/commit/944fdc063912445c21e81e7ae80589f3652c3d03))
* **RQ-PHX-WEBSERVERBACKLOG767:** RQ-PHX-WEBSERVERBACKLOG767 ([#8186](https://github.com/ashlrai/phantom/issues/8186)) ([fc7ecf0](https://github.com/ashlrai/phantom/commit/fc7ecf087ca0ba750056c771d98bb851559a40a0))

## [3.30.64] - 2026-11-22


### Changes

* **RQ-CL-DOCS-1795326010:** ([#8133](https://github.com/ashlrai/phantom/issues/8133)) ([4ec1fef](https://github.com/ashlrai/phantom/commit/4ec1fef3d22ec9ec21791dda31d56c164aa75c6d))
* **RQ-CL-DOCS-1795327854:** ([#8143](https://github.com/ashlrai/phantom/issues/8143)) ([158c333](https://github.com/ashlrai/phantom/commit/158c33311df3c22a9fdf763767c1a900f1f7de33))
* **RQ-CL-DOCS-1795330129:** ([#8152](https://github.com/ashlrai/phantom/issues/8152)) ([fa0a301](https://github.com/ashlrai/phantom/commit/fa0a301a3c8248e77cf2437c492cb1d52a58f5a3))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795324773-N17:** ([#8130](https://github.com/ashlrai/phantom/issues/8130)) ([b56b4fa](https://github.com/ashlrai/phantom/commit/b56b4fa8e8aa954be57d4783b29ca1afad066816))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795325725-N17:** ([#8138](https://github.com/ashlrai/phantom/issues/8138)) ([3d4c804](https://github.com/ashlrai/phantom/commit/3d4c804d0badd86776be064711e3c1e19617c0fb))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795327114-N17:** ([#8141](https://github.com/ashlrai/phantom/issues/8141)) ([103c1d1](https://github.com/ashlrai/phantom/commit/103c1d1b533a250c4ed4ca03713b21b0c27aecbe))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795327859-N17:** ([#8144](https://github.com/ashlrai/phantom/issues/8144)) ([2e7a84d](https://github.com/ashlrai/phantom/commit/2e7a84d8cbe323d1188e904589ee72d8bd8541b2))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795329196-N17:** ([#8151](https://github.com/ashlrai/phantom/issues/8151)) ([fb4d485](https://github.com/ashlrai/phantom/commit/fb4d4853796c0e2cb41df984cf90a551300dee54))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795330299-N17:** ([#8154](https://github.com/ashlrai/phantom/issues/8154)) ([84838d4](https://github.com/ashlrai/phantom/commit/84838d4f4b1a28a24a97987d73ab8da7d86f0206))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795331137-N17:** ([#8162](https://github.com/ashlrai/phantom/issues/8162)) ([17a71e3](https://github.com/ashlrai/phantom/commit/17a71e399bef26226ef173538004d3e48f12eb47))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795332855-N17:** ([#8172](https://github.com/ashlrai/phantom/issues/8172)) ([198dd70](https://github.com/ashlrai/phantom/commit/198dd703cc80d1d6c2e89fe55cc5c85b8829e7d9))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795326351-N17:** ([#8142](https://github.com/ashlrai/phantom/issues/8142)) ([8d0ff2b](https://github.com/ashlrai/phantom/commit/8d0ff2bb4cad7f61f91d7ac76ba2f216aecdda97))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795329184-N17:** ([#8149](https://github.com/ashlrai/phantom/issues/8149)) ([c2e0a88](https://github.com/ashlrai/phantom/commit/c2e0a88b1e1beeeefa3247baf1ba8a8aca4aa649))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795330272-N17:** ([#8161](https://github.com/ashlrai/phantom/issues/8161)) ([7907c04](https://github.com/ashlrai/phantom/commit/7907c04585a1d9ce1ac2c1c42d048faf66c3d831))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795331923-N17:** ([#8168](https://github.com/ashlrai/phantom/issues/8168)) ([a5715a5](https://github.com/ashlrai/phantom/commit/a5715a5e50af84bda7abfe40799fe43c643cbdff))
* **RQ-PHX-ADAPTEVIDENCEOWNER763S:** Lane adaptation evidence preservation handoff ([#8139](https://github.com/ashlrai/phantom/issues/8139)) ([88b2fda](https://github.com/ashlrai/phantom/commit/88b2fda95fdb650963f6656c1ef16324623dc2ee))
* **RQ-PHX-COMMSBACKLOG762:** RQ-PHX-COMMSBACKLOG762 ([#8127](https://github.com/ashlrai/phantom/issues/8127)) ([e8d90f9](https://github.com/ashlrai/phantom/commit/e8d90f9c4b80ef3109a7e9f44d28c6db93a5a675))
* **RQ-PHX-COMMSBACKLOG763:** RQ-PHX-COMMSBACKLOG763 ([#8155](https://github.com/ashlrai/phantom/issues/8155)) ([47ff19f](https://github.com/ashlrai/phantom/commit/47ff19f2363d56663b3c258c7951ce1479bc135e))
* **RQ-PHX-COMMSBACKLOG765:** RQ-PHX-COMMSBACKLOG765 ([#8158](https://github.com/ashlrai/phantom/issues/8158)) ([6608dd3](https://github.com/ashlrai/phantom/commit/6608dd37adf40210fe36f5a885ac4df9dc9f34fc))
* **RQ-PHX-CONSOLEBACKLOG762:** RQ-PHX-CONSOLEBACKLOG762 ([#8128](https://github.com/ashlrai/phantom/issues/8128)) ([a3a51a5](https://github.com/ashlrai/phantom/commit/a3a51a51d33230f633226f62393a6263f020b946))
* **RQ-PHX-DOCSBACKLOG763:** RQ-PHX-DOCSBACKLOG763 ([#8135](https://github.com/ashlrai/phantom/issues/8135)) ([029ae27](https://github.com/ashlrai/phantom/commit/029ae27fd550404395f02c73afab9fe81953ecb5))
* **RQ-PHX-DOCSBACKLOG764:** RQ-PHX-DOCSBACKLOG764 ([#8136](https://github.com/ashlrai/phantom/issues/8136)) ([1f401ad](https://github.com/ashlrai/phantom/commit/1f401ad0da7d82de2a14b3fca4d619c846b88185))
* **RQ-PHX-DOCSBACKLOG765:** RQ-PHX-DOCSBACKLOG765 ([#8137](https://github.com/ashlrai/phantom/issues/8137)) ([51eb53a](https://github.com/ashlrai/phantom/commit/51eb53a5c113ab61aae30bf3f58b8539d1807403))
* **RQ-PHX-DOCSBACKLOG766:** RQ-PHX-DOCSBACKLOG766 ([#8145](https://github.com/ashlrai/phantom/issues/8145)) ([887c241](https://github.com/ashlrai/phantom/commit/887c241b17696e274dddb2993dda5f00a3db3047))
* **RQ-PHX-FLEETCOREBACKLOG763:** RQ-PHX-FLEETCOREBACKLOG763 ([#8160](https://github.com/ashlrai/phantom/issues/8160)) ([e622131](https://github.com/ashlrai/phantom/commit/e62213151777a128328e375e211c2da69331ff4a))
* **RQ-PHX-FLEETCOREBACKLOG764:** RQ-PHX-FLEETCOREBACKLOG764 ([#8163](https://github.com/ashlrai/phantom/issues/8163)) ([d4407c3](https://github.com/ashlrai/phantom/commit/d4407c3e9e01a0962c4078a17cd8942566e9e81d))
* **RQ-PHX-FLEETCOREBACKLOG765:** RQ-PHX-FLEETCOREBACKLOG765 ([#8165](https://github.com/ashlrai/phantom/issues/8165)) ([36631f8](https://github.com/ashlrai/phantom/commit/36631f831bbd7d816097e4244a352f2497071019))
* **RQ-PHX-FLEETVERBBACKLOG763:** RQ-PHX-FLEETVERBBACKLOG763 ([#8159](https://github.com/ashlrai/phantom/issues/8159)) ([6485327](https://github.com/ashlrai/phantom/commit/64853279ae9d253414bac8900515424ad37b7dfd))
* **RQ-PHX-FLEETVERBBACKLOG764:** RQ-PHX-FLEETVERBBACKLOG764 ([#8164](https://github.com/ashlrai/phantom/issues/8164)) ([880e2f0](https://github.com/ashlrai/phantom/commit/880e2f0ec9d4e568e8a29f0354f91be80a6468af))
* **RQ-PHX-FLEETVERBBACKLOG765:** RQ-PHX-FLEETVERBBACKLOG765 ([#8166](https://github.com/ashlrai/phantom/issues/8166)) ([106df64](https://github.com/ashlrai/phantom/commit/106df647f1e32d5a4b7b4f5027c7d47bcba4e66c))
* **RQ-PHX-LEADERBACKLOG764:** RQ-PHX-LEADERBACKLOG764 ([#8167](https://github.com/ashlrai/phantom/issues/8167)) ([a33d675](https://github.com/ashlrai/phantom/commit/a33d6754f6801b67080da16b3f8a357168962462))
* **RQ-PHX-MODELCAPPRESERVE766S:** Model-cap evidence recovery (RQ-PHX-MODELCAPPRESERVE766S) ([#8146](https://github.com/ashlrai/phantom/issues/8146)) ([6a7fe61](https://github.com/ashlrai/phantom/commit/6a7fe61da1f5ce62c930226c07495aa13d67e6be))
* **RQ-PHX-SCRIPTSBACKLOG762:** RQ-PHX-SCRIPTSBACKLOG762 ([#8170](https://github.com/ashlrai/phantom/issues/8170)) ([19ee7a3](https://github.com/ashlrai/phantom/commit/19ee7a3331029f7befbd56faff738267f1ddbfd5))
* **RQ-PHX-SCRIPTSBACKLOG763:** RQ-PHX-SCRIPTSBACKLOG763 ([#8171](https://github.com/ashlrai/phantom/issues/8171)) ([80a0c2a](https://github.com/ashlrai/phantom/commit/80a0c2ac8cfb4179bf9f30a402d9925ea5458404))
* **RQ-PHX-SCRIPTSBACKLOG764:** RQ-PHX-SCRIPTSBACKLOG764 ([#8173](https://github.com/ashlrai/phantom/issues/8173)) ([82e28fc](https://github.com/ashlrai/phantom/commit/82e28fc2bd34caa1a4ec3736b9dfb1fc563865dc))

## [3.30.63] - 2026-11-22


### Changes

* **FIXUP-CI-phantom-ci-196042:** FIXUP-CI-phantom-ci-196042 ([#8091](https://github.com/ashlrai/phantom/issues/8091)) ([a70acf6](https://github.com/ashlrai/phantom/commit/a70acf625f64def5575db2811546bdc0cad1a700))
* **RQ-CL-DOCS-1795319769:** ([#8098](https://github.com/ashlrai/phantom/issues/8098)) ([63c3392](https://github.com/ashlrai/phantom/commit/63c3392e5b627ebb3822782ac7de3c57397d1b17))
* **RQ-CL-DOCS-1795321867:** ([#8110](https://github.com/ashlrai/phantom/issues/8110)) ([0144348](https://github.com/ashlrai/phantom/commit/0144348736633cad17e7454e1e1f4122c52ecc8b))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795313112-N17:** ([#8081](https://github.com/ashlrai/phantom/issues/8081)) ([eb979fa](https://github.com/ashlrai/phantom/commit/eb979fa929907d55ba7c00b986bf58c880239061))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795314523-N17:** ([#8087](https://github.com/ashlrai/phantom/issues/8087)) ([9451424](https://github.com/ashlrai/phantom/commit/945142455a9096dd53fb8285daf915931f9ddfbb))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795315922-N17:** ([#8089](https://github.com/ashlrai/phantom/issues/8089)) ([2c84e81](https://github.com/ashlrai/phantom/commit/2c84e81de40e9b92194b2ccef4641ab4e860b168))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795317352-N17:** ([#8093](https://github.com/ashlrai/phantom/issues/8093)) ([adab81c](https://github.com/ashlrai/phantom/commit/adab81c94b9df188f7c0c5f29e09580148123631))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795318018-N17:** ([#8096](https://github.com/ashlrai/phantom/issues/8096)) ([8720bd1](https://github.com/ashlrai/phantom/commit/8720bd177a8a9199d1046e91b7cb5d5673f8f11f))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795318658-N17R2:** Recovery: RQ-DEVINCLOUD-RQ-DVL-BUS-1795318658-N17R2 ([#8101](https://github.com/ashlrai/phantom/issues/8101)) ([c3c2c60](https://github.com/ashlrai/phantom/commit/c3c2c60119355975a6db6f75546bbc31acb19f3d))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795319391-N17:** ([#8100](https://github.com/ashlrai/phantom/issues/8100)) ([a253563](https://github.com/ashlrai/phantom/commit/a2535630719d5d0e71fac79f484544836ddea1e0))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795320590-N17:** ([#8103](https://github.com/ashlrai/phantom/issues/8103)) ([3a0d524](https://github.com/ashlrai/phantom/commit/3a0d524454f4e48c68c66a032889f9559a2ead6c))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795321108-N17:** ([#8108](https://github.com/ashlrai/phantom/issues/8108)) ([88ffd72](https://github.com/ashlrai/phantom/commit/88ffd72ec93ecd77d1027ed51ed646035c0f6272))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795321949-N17:** ([#8117](https://github.com/ashlrai/phantom/issues/8117)) ([df5a772](https://github.com/ashlrai/phantom/commit/df5a772a9c91504fcd0ee6e23cd3c3dbfb55ba58))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795322986-N17:** ([#8118](https://github.com/ashlrai/phantom/issues/8118)) ([a3b77c7](https://github.com/ashlrai/phantom/commit/a3b77c7c4de06220b1dfe7818bdc87f767504330))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795313591-N17:** ([#8082](https://github.com/ashlrai/phantom/issues/8082)) ([923d84a](https://github.com/ashlrai/phantom/commit/923d84a95dcd8d37abed0928e42a7ba7fa31dc93))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795316163-N17:** ([#8088](https://github.com/ashlrai/phantom/issues/8088)) ([c81ebd0](https://github.com/ashlrai/phantom/commit/c81ebd02f3be2b7fccb023dd4ed92f0ea79bfea7))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795317032-N17:** ([#8097](https://github.com/ashlrai/phantom/issues/8097)) ([385681f](https://github.com/ashlrai/phantom/commit/385681f0090cbeb93f25696c70be24f9eefb1430))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795319891-N17:** ([#8102](https://github.com/ashlrai/phantom/issues/8102)) ([3782e3b](https://github.com/ashlrai/phantom/commit/3782e3bac2af58d2c2874eb6462fbdf9d5e4aac9))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795320946-N17:** ([#8109](https://github.com/ashlrai/phantom/issues/8109)) ([c315ad5](https://github.com/ashlrai/phantom/commit/c315ad5aa958f86607a7db50154795e35c4ad6f2))
* **RQ-HOSTOTHERN23UQ8:** RQ-HOSTOTHERN23UQ8 ([#8121](https://github.com/ashlrai/phantom/issues/8121)) ([3ec92c6](https://github.com/ashlrai/phantom/commit/3ec92c639455321644a619e94967c662fdd74dc7))
* **RQ-MAPLIVEJOBSN23OQ8:** RQ-MAPLIVEJOBSN23OQ8 ([#8078](https://github.com/ashlrai/phantom/issues/8078)) ([1832884](https://github.com/ashlrai/phantom/commit/1832884281945ffb18c718ee50899c0118e54a6f))
* **RQ-MERGELATENCYN24Q8:** RQ-MERGELATENCYN24Q8 ([#8114](https://github.com/ashlrai/phantom/issues/8114)) ([7eabf6d](https://github.com/ashlrai/phantom/commit/7eabf6d811faf673331c4ad2e20fbb59a62ab6c2))
* **RQ-ORPHANLOADN23QQ8:** RQ-ORPHANLOADN23QQ8: confirmed PID-1 processes in finished-j ([#8092](https://github.com/ashlrai/phantom/issues/8092)) ([35fc5cd](https://github.com/ashlrai/phantom/commit/35fc5cde979856f9aca4d8019e72e9d7f52f4052))
* **RQ-PHX-DOCSBACKLOG762:** RQ-PHX-DOCSBACKLOG762 ([#8116](https://github.com/ashlrai/phantom/issues/8116)) ([927feec](https://github.com/ashlrai/phantom/commit/927feec768118fe869beb39e2facaf0d6fc17f4b))
* **RQ-PHX-FLEETCORELAND760:** RQ-PHX-FLEETCORELAND760 ([#8123](https://github.com/ashlrai/phantom/issues/8123)) ([0d1ceb0](https://github.com/ashlrai/phantom/commit/0d1ceb03432b883b4a71f956037875cddb73ef82))
* **RQ-PHX-LANDEDBRANCHEVIDENCE761S:** RQ-PHX-LANDEDBRANCHEVIDENCE761S handoff ([#8113](https://github.com/ashlrai/phantom/issues/8113)) ([5d79148](https://github.com/ashlrai/phantom/commit/5d7914842befd85b10f63970e3cd6683480e3799))
* **RQ-PHX-LANDEDIDPRESERVE762S:** Requested landed evidence preservation ([#8115](https://github.com/ashlrai/phantom/issues/8115)) ([91da744](https://github.com/ashlrai/phantom/commit/91da744620fef893baaa65ab6e36ca61cf2a38d9))
* **RQ-PHX-LIVEPROCESSOWNER759S:** RQ-PHX-LIVEPROCESSOWNER759S ([#8107](https://github.com/ashlrai/phantom/issues/8107)) ([6f0cf48](https://github.com/ashlrai/phantom/commit/6f0cf48845de2fd262a482e3121959420265538d))
* **RQ-PHX-MERGEAGEOWNERFINISH754S:** RQ-PHX-MERGEAGEOWNERFINISH754S ([#8085](https://github.com/ashlrai/phantom/issues/8085)) ([99547b4](https://github.com/ashlrai/phantom/commit/99547b4f812d744179023e8e50c22704d6a047a7))
* **RQ-PHX-RELEASEBACKLOGOWNER752SR2:** Release backlog owner recovery — RQ-PHX-RELEASEBACKLOGOWNER7 ([#8086](https://github.com/ashlrai/phantom/issues/8086)) ([b54261f](https://github.com/ashlrai/phantom/commit/b54261fdb6e8001f23aa980a355de25c277c206b))
* **RQ-PHX-TICKCOSTOWNERFINISH758S:** Tick-cost partial preservation handoff ([#8111](https://github.com/ashlrai/phantom/issues/8111)) ([d5cf54e](https://github.com/ashlrai/phantom/commit/d5cf54e6a5353a8201949ac1de68c18007a71eec))
* **RQ-PHX-WEBSERVERBACKLOG762:** RQ-PHX-WEBSERVERBACKLOG762 ([#8119](https://github.com/ashlrai/phantom/issues/8119)) ([a8f416f](https://github.com/ashlrai/phantom/commit/a8f416f7d147e907992ae5c064365b0c0c0f1874))
* **RQ-PHX-WEBSERVERLAND760:** RQ-PHX-WEBSERVERLAND760 — no duplicate recovery ([#8106](https://github.com/ashlrai/phantom/issues/8106)) ([e636a7f](https://github.com/ashlrai/phantom/commit/e636a7f1bfc6e876aacab1c0f443b1c964364b89))
* **RQ-SPENDTESTN22EQ8R2:** RQ-SPENDTESTN22EQ8R2 ([#8104](https://github.com/ashlrai/phantom/issues/8104)) ([4dce652](https://github.com/ashlrai/phantom/commit/4dce65227aaebc83ab4d6161df7570d64bd1318c))
* **RQ-TICKPROFILE23RQ8:** RQ-TICKPROFILE23RQ8 ([#8105](https://github.com/ashlrai/phantom/issues/8105)) ([2438257](https://github.com/ashlrai/phantom/commit/2438257ce28d2dbbc7957ea7f9a86033464d7742))

## [3.30.62] - 2026-11-22


### Changes

* **RQ-BRIEFLANESN23HQ8:** RQ-BRIEFLANESN23HQ8 ([#8041](https://github.com/ashlrai/phantom/issues/8041)) ([a6d5f1e](https://github.com/ashlrai/phantom/commit/a6d5f1e033c33ff4927841a650873a08fa1bb8fa))
* **RQ-CL-DOCS-1795307547:** ([#8052](https://github.com/ashlrai/phantom/issues/8052)) ([ae60a6d](https://github.com/ashlrai/phantom/commit/ae60a6d3dc7ad3e7c904d56c72bb998c3b09d172))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795306355-N17:** ([#8044](https://github.com/ashlrai/phantom/issues/8044)) ([43abdfa](https://github.com/ashlrai/phantom/commit/43abdfa34107aadfb15a2414f320c9da8771ef42))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795306957-N17:** ([#8050](https://github.com/ashlrai/phantom/issues/8050)) ([ad2f50c](https://github.com/ashlrai/phantom/commit/ad2f50c037f643f31c10297c48674a0e84a69915))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795307679-N17:** ([#8056](https://github.com/ashlrai/phantom/issues/8056)) ([ae31eec](https://github.com/ashlrai/phantom/commit/ae31eec1ba19069f8c6c7b0e9048a3997a305987))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795308548-N17:** ([#8058](https://github.com/ashlrai/phantom/issues/8058)) ([3cd403b](https://github.com/ashlrai/phantom/commit/3cd403b3bc60a641655214a3faefd2bab771592b))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795309459-N17:** ([#8065](https://github.com/ashlrai/phantom/issues/8065)) ([7452e30](https://github.com/ashlrai/phantom/commit/7452e3071a8ca7e2a1b71d40aa66eb2ad2ce4b43))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795310641-N17:** ([#8068](https://github.com/ashlrai/phantom/issues/8068)) ([c0bb713](https://github.com/ashlrai/phantom/commit/c0bb7130fca6135b22da2b230c68e62bd96024e9))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795311628-N17:** ([#8069](https://github.com/ashlrai/phantom/issues/8069)) ([50dfaff](https://github.com/ashlrai/phantom/commit/50dfaff97f878509de7b5e25f3e573a6d920107c))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795306222-N17:** ([#8053](https://github.com/ashlrai/phantom/issues/8053)) ([2446f62](https://github.com/ashlrai/phantom/commit/2446f62e2e5f84382ca28500afa08550433d134c))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795308932-N17:** ([#8064](https://github.com/ashlrai/phantom/issues/8064)) ([b9ee4b8](https://github.com/ashlrai/phantom/commit/b9ee4b8b7f013cdf21904f8a27f0a4bfc3ff47e4))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795311743-N17:** ([#8071](https://github.com/ashlrai/phantom/issues/8071)) ([5ebe187](https://github.com/ashlrai/phantom/commit/5ebe1871944410cb9d6f2df01e050b3dc5c7334d))
* **RQ-DISPATCHHEALTHQ8:** RQ-DISPATCHHEALTHQ8 ([#8046](https://github.com/ashlrai/phantom/issues/8046)) ([1512842](https://github.com/ashlrai/phantom/commit/151284236b4b6cb98773d2cbac0358341a90ab81))
* **RQ-JOBLOADN23JQ8:** RQ-JOBLOADN23JQ8 ([#8059](https://github.com/ashlrai/phantom/issues/8059)) ([0c8174d](https://github.com/ashlrai/phantom/commit/0c8174d3d1b6df9824a628643402ae0b53015d8c))
* **RQ-MERGEDFEEDQ8:** RQ-MERGEDFEEDQ8 ([#8057](https://github.com/ashlrai/phantom/issues/8057)) ([22cdacb](https://github.com/ashlrai/phantom/commit/22cdacb0f5582d1e1208fa66372283273aee3caa))
* **RQ-MERGELATGITN23JQ8:** RQ-MERGELATGITN23JQ8 ([#8062](https://github.com/ashlrai/phantom/issues/8062)) ([7ff029d](https://github.com/ashlrai/phantom/commit/7ff029d0437ee9732e638f05972e7fbd86e021ed))
* **RQ-PHX-FAMILYSTOPFINISH748S:** PR 7992 handoff — blocked before implementation ([#8049](https://github.com/ashlrai/phantom/issues/8049)) ([cfd52f3](https://github.com/ashlrai/phantom/commit/cfd52f384faeccc5a89c522b1ee4e4b7c9979777))
* **RQ-PHX-GAPCAPACITYFINISH749S:** RQ-PHX-GAPCAPACITYFINISH749S — continuation of PR [#8009](https://github.com/ashlrai/phantom/issues/8009) ([#8051](https://github.com/ashlrai/phantom/issues/8051)) ([865d8be](https://github.com/ashlrai/phantom/commit/865d8be17f715520d5a59303359acbc77d45ac5f))
* **RQ-PHX-POOLKNOWNOWNER751S:** RQ-PHX-POOLKNOWNOWNER751S — PR [#8042](https://github.com/ashlrai/phantom/issues/8042) owner continuation ([#8070](https://github.com/ashlrai/phantom/issues/8070)) ([40d1e77](https://github.com/ashlrai/phantom/commit/40d1e77436eb13345fddc16d55c4df6f8bde7400))
* **RQ-PHX-POOLREADFINISH747SR2:** RQ-PHX-POOLREADFINISH747SR2 ([#8047](https://github.com/ashlrai/phantom/issues/8047)) ([80b8dad](https://github.com/ashlrai/phantom/commit/80b8dad093605045f9ef104204e490967beaf4bf))
* **RQ-PHX-REAPOWNERFINISH750S:** RQ-PHX-REAPOWNERFINISH750S — blocked preservation audit ([#8067](https://github.com/ashlrai/phantom/issues/8067)) ([f0f9590](https://github.com/ashlrai/phantom/commit/f0f9590268627cf6ecf4ada1c4329f2bea27b95e))
* **RQ-SETTLEADVICEQ8:** RQ-SETTLEADVICEQ8 ([#8054](https://github.com/ashlrai/phantom/issues/8054)) ([117f965](https://github.com/ashlrai/phantom/commit/117f9652cd74d385270a52b9fdfc9fd2407484f2))
* **RQ-STARTYIELDN23JQ8:** RQ-STARTYIELDN23JQ8 ([#8060](https://github.com/ashlrai/phantom/issues/8060)) ([c47d562](https://github.com/ashlrai/phantom/commit/c47d562d2994926c9ed79447e0a7987e732a93b1))

## [3.30.61] - 2026-11-21


### Changes

* **FIXUP-CI-phantom-unrelated-pr-recover-100922:** FIXUP-CI-phantom-unrelated-pr-recover-100922 ([#8016](https://github.com/ashlrai/phantom/issues/8016)) ([69d1093](https://github.com/ashlrai/phantom/commit/69d10930f852c531da8bf55ad2a7b62a0634db55))
* **RQ-ARMSWEEPN23DQ8:** RQ-ARMSWEEPN23DQ8 ([#7984](https://github.com/ashlrai/phantom/issues/7984)) ([858d1e1](https://github.com/ashlrai/phantom/commit/858d1e1ce26fce54ac2c4e8fcb8a0bba80df5f7c))
* **RQ-AVOIDFIXN22VQ8R2:** RQ-AVOIDFIXN22VQ8R2: recovery of RQ-AVOIDFIXN22VQ8 ([#7917](https://github.com/ashlrai/phantom/issues/7917)) ([e42bae5](https://github.com/ashlrai/phantom/commit/e42bae5f6dac24a9a5047f9b58b6c807e7c3be2e))
* **RQ-CL-DOCS-1795266396:** ([#7923](https://github.com/ashlrai/phantom/issues/7923)) ([6fe925c](https://github.com/ashlrai/phantom/commit/6fe925c7ca5f556290032f021e81bed5d0e9868c))
* **RQ-CL-DOCS-1795268345:** ([#7929](https://github.com/ashlrai/phantom/issues/7929)) ([feb4ed8](https://github.com/ashlrai/phantom/commit/feb4ed8320beaefab62e9527ed1f4011e36961e2))
* **RQ-CL-DOCS-1795270632:** ([#7934](https://github.com/ashlrai/phantom/issues/7934)) ([424d798](https://github.com/ashlrai/phantom/commit/424d798cf50cbbbf2eeef488b8bf98aacdcd9f0e))
* **RQ-CL-DOCS-1795277936:** ([#7953](https://github.com/ashlrai/phantom/issues/7953)) ([c3674b4](https://github.com/ashlrai/phantom/commit/c3674b43ad18363fbf58c5f57a74691a01452c27))
* **RQ-CL-DOCS-1795282704:** ([#7962](https://github.com/ashlrai/phantom/issues/7962)) ([fad2ead](https://github.com/ashlrai/phantom/commit/fad2ead7c32e8f7a44011aa132591883b65bd625))
* **RQ-CL-DOCS-1795285215:** ([#7967](https://github.com/ashlrai/phantom/issues/7967)) ([6602ab5](https://github.com/ashlrai/phantom/commit/6602ab577190f9420d872e24831deb0e5c14aef7))
* **RQ-CL-DOCS-1795287471:** ([#7972](https://github.com/ashlrai/phantom/issues/7972)) ([22a8f4f](https://github.com/ashlrai/phantom/commit/22a8f4f20d092a54baea78abb7a62537ac262184))
* **RQ-CL-DOCS-1795289693:** ([#7975](https://github.com/ashlrai/phantom/issues/7975)) ([602f8b4](https://github.com/ashlrai/phantom/commit/602f8b4770756d3db8aff74e8a8d72b99285d0d8))
* **RQ-CL-DOCS-1795291957:** ([#7980](https://github.com/ashlrai/phantom/issues/7980)) ([016b3dc](https://github.com/ashlrai/phantom/commit/016b3dc6aa1f51c837849cdd804fae561da409ce))
* **RQ-CL-DOCS-1795295398:** ([#7993](https://github.com/ashlrai/phantom/issues/7993)) ([c7ea30f](https://github.com/ashlrai/phantom/commit/c7ea30f380ff580fb9462e9f485216d4cc9fa363))
* **RQ-CL-DOCS-1795297837:** ([#8002](https://github.com/ashlrai/phantom/issues/8002)) ([8a3edc4](https://github.com/ashlrai/phantom/commit/8a3edc4d1035747031e016ed674604a3ad530d53))
* **RQ-CL-DOCS-1795300115:** ([#8013](https://github.com/ashlrai/phantom/issues/8013)) ([0326a9e](https://github.com/ashlrai/phantom/commit/0326a9e0386fda14000a3a9bd508974e9c4bf50b))
* **RQ-CL-DOCS-1795302853:** ([#8024](https://github.com/ashlrai/phantom/issues/8024)) ([e05a45c](https://github.com/ashlrai/phantom/commit/e05a45c2669c07aba5df7c2827b0b5cc4617af4b))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795262062-N17:** ([#7914](https://github.com/ashlrai/phantom/issues/7914)) ([fd8a607](https://github.com/ashlrai/phantom/commit/fd8a60744c82103b168a35f1482ad63bccffcd5e))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795263486-N17:** ([#7919](https://github.com/ashlrai/phantom/issues/7919)) ([27179a1](https://github.com/ashlrai/phantom/commit/27179a1022b867f2a6496e54573d0091d578ff51))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795267307-N17:** ([#7927](https://github.com/ashlrai/phantom/issues/7927)) ([9aea6ac](https://github.com/ashlrai/phantom/commit/9aea6acd818ae8aa6c72ec7bbec4a762d549bcbd))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795268372-N17:** ([#7931](https://github.com/ashlrai/phantom/issues/7931)) ([9770df8](https://github.com/ashlrai/phantom/commit/9770df8228e8aeaa439a8c50f0b8e923d9fbaec8))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795269825-N17:** ([#7935](https://github.com/ashlrai/phantom/issues/7935)) ([c834b3e](https://github.com/ashlrai/phantom/commit/c834b3e149905e2f417ed6c88ee851c354145eec))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795271026-N17:** ([#7937](https://github.com/ashlrai/phantom/issues/7937)) ([215bde9](https://github.com/ashlrai/phantom/commit/215bde928266fd9b853d7081c8a863cd59176bf9))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795273546-N17:** ([#7945](https://github.com/ashlrai/phantom/issues/7945)) ([f9f6646](https://github.com/ashlrai/phantom/commit/f9f66462d90a040d7f6284ffbf32b8de33bd0f63))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795276181-N17:** ([#7951](https://github.com/ashlrai/phantom/issues/7951)) ([f6cc633](https://github.com/ashlrai/phantom/commit/f6cc6339868090556583d8fb0c155a7be3973fd5))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795277615-N17:** ([#7956](https://github.com/ashlrai/phantom/issues/7956)) ([04eecff](https://github.com/ashlrai/phantom/commit/04eecffa84b279ec37d25991031f056995063330))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795279141-N17:** ([#7959](https://github.com/ashlrai/phantom/issues/7959)) ([9cd31c4](https://github.com/ashlrai/phantom/commit/9cd31c4b3725223042dbf6cba2e33e3a454f248b))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795280944-N17:** ([#7961](https://github.com/ashlrai/phantom/issues/7961)) ([859dc94](https://github.com/ashlrai/phantom/commit/859dc942eea6c546899a520afb19a5b6bd665757))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795282336-N17:** ([#7964](https://github.com/ashlrai/phantom/issues/7964)) ([00c58f7](https://github.com/ashlrai/phantom/commit/00c58f740974691cf7eba6ffc4a18f7cef01b14b))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795283279-N17:** ([#7965](https://github.com/ashlrai/phantom/issues/7965)) ([a89af25](https://github.com/ashlrai/phantom/commit/a89af250d2b67e9e59b273f951dd050002905096))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795284449-N17:** ([#7968](https://github.com/ashlrai/phantom/issues/7968)) ([27df74a](https://github.com/ashlrai/phantom/commit/27df74ad6b893010c9fc473c79e8cd55207c8114))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795286115-N17:** ([#7970](https://github.com/ashlrai/phantom/issues/7970)) ([dcb8005](https://github.com/ashlrai/phantom/commit/dcb8005b7cd36d167a27346eb518a34cb72562f1))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795286989-N17:** ([#7973](https://github.com/ashlrai/phantom/issues/7973)) ([134b0f2](https://github.com/ashlrai/phantom/commit/134b0f2b6b4feb159088f05849d95b6d0c9f37ba))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795288896-N17:** ([#7977](https://github.com/ashlrai/phantom/issues/7977)) ([69a046a](https://github.com/ashlrai/phantom/commit/69a046adf8afc64cc2d77f621e8ba6a0ed0bd8e9))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795290171-N17:** ([#7978](https://github.com/ashlrai/phantom/issues/7978)) ([09ce49e](https://github.com/ashlrai/phantom/commit/09ce49e0d7c4b20851d2d6b6148ba891cbffb45a))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795291089-N17:** ([#7981](https://github.com/ashlrai/phantom/issues/7981)) ([4491af1](https://github.com/ashlrai/phantom/commit/4491af10feaf55e5ba8f3b6c521a35e4ee43adce))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795292331-N17:** ([#7983](https://github.com/ashlrai/phantom/issues/7983)) ([db85a0e](https://github.com/ashlrai/phantom/commit/db85a0e3799b9f78ce9f27415acf90d612fef871))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795293672-N17:** ([#7989](https://github.com/ashlrai/phantom/issues/7989)) ([defccd7](https://github.com/ashlrai/phantom/commit/defccd7e15a4c4596c343cbdf81f06fb761506b9))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795295297-N17:** ([#7996](https://github.com/ashlrai/phantom/issues/7996)) ([f237aea](https://github.com/ashlrai/phantom/commit/f237aea30631776c99742c7f008ab094398da645))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795296312-N17:** ([#8000](https://github.com/ashlrai/phantom/issues/8000)) ([9c3fdac](https://github.com/ashlrai/phantom/commit/9c3fdac36b46b1b4d95d9c9244fdddd3fee3651c))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795297333-N17:** ([#8003](https://github.com/ashlrai/phantom/issues/8003)) ([ef4737f](https://github.com/ashlrai/phantom/commit/ef4737ff4032e113f6e3ef42047ee70070188c97))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795298551-N17:** ([#8012](https://github.com/ashlrai/phantom/issues/8012)) ([c0b40f9](https://github.com/ashlrai/phantom/commit/c0b40f98be1c89a59f001e18c68ff5806e386e34))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795300759-N17:** ([#8018](https://github.com/ashlrai/phantom/issues/8018)) ([0b5d018](https://github.com/ashlrai/phantom/commit/0b5d018c594433be9d7234fae0f4e64612c11325))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795301808-N17:** ([#8021](https://github.com/ashlrai/phantom/issues/8021)) ([be4da12](https://github.com/ashlrai/phantom/commit/be4da121bf3535e24964329ef636fd90de1c4c57))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795302439-N17:** ([#8031](https://github.com/ashlrai/phantom/issues/8031)) ([a79bf78](https://github.com/ashlrai/phantom/commit/a79bf78041b3fe877afcd597f27efb8953f51398))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795262163-N17:** ([#7912](https://github.com/ashlrai/phantom/issues/7912)) ([7a5a736](https://github.com/ashlrai/phantom/commit/7a5a736b0e913e3ad9e1599316b483990c2a0aa3))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795263107-N17:** ([#7915](https://github.com/ashlrai/phantom/issues/7915)) ([463ce79](https://github.com/ashlrai/phantom/commit/463ce79f9928365b694f79c5e1d6fb33a56c5d09))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795264241-N17:** ([#7918](https://github.com/ashlrai/phantom/issues/7918)) ([8e8deda](https://github.com/ashlrai/phantom/commit/8e8deda0df38eb3be61f4ff75feb6ec01028b681))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795265057-N17:** ([#7922](https://github.com/ashlrai/phantom/issues/7922)) ([74afaec](https://github.com/ashlrai/phantom/commit/74afaec57152919e21988c7f012e7095a2f3f310))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795266202-N17:** ([#7924](https://github.com/ashlrai/phantom/issues/7924)) ([7022206](https://github.com/ashlrai/phantom/commit/70222067d81e2a0482932204d9dcad70ca390723))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795266943-N17:** ([#7925](https://github.com/ashlrai/phantom/issues/7925)) ([1e6dc66](https://github.com/ashlrai/phantom/commit/1e6dc665ef9d7d40e8a6f3384ef0f32195508620))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795268116-N17:** ([#7930](https://github.com/ashlrai/phantom/issues/7930)) ([d14e385](https://github.com/ashlrai/phantom/commit/d14e3852fa0bd61e211cf03b0814ceac04a6b1dc))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795269608-N17:** ([#7933](https://github.com/ashlrai/phantom/issues/7933)) ([44d0f70](https://github.com/ashlrai/phantom/commit/44d0f708088c995a3a399848fdbda4c1da144b91))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795270858-N17:** ([#7936](https://github.com/ashlrai/phantom/issues/7936)) ([1119367](https://github.com/ashlrai/phantom/commit/111936716f85fd8a4ff8e25aa7db3d6caebb83b4))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795271902-N17:** ([#7938](https://github.com/ashlrai/phantom/issues/7938)) ([f96c72e](https://github.com/ashlrai/phantom/commit/f96c72e3d9d38a5a592a0da1c37cb232c41ba98e))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795272993-N17:** ([#7944](https://github.com/ashlrai/phantom/issues/7944)) ([8894833](https://github.com/ashlrai/phantom/commit/8894833b6b63e4020c2e61ae6814568ed0a6f103))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795275956-N17:** ([#7950](https://github.com/ashlrai/phantom/issues/7950)) ([d71d77d](https://github.com/ashlrai/phantom/commit/d71d77d3b8fce1546a7bfe34f0076c665fec3953))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795277003-N17:** ([#7957](https://github.com/ashlrai/phantom/issues/7957)) ([dddf732](https://github.com/ashlrai/phantom/commit/dddf732376323c70851bb887f90188977b6c9080))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795279992-N17:** ([#7960](https://github.com/ashlrai/phantom/issues/7960)) ([a029467](https://github.com/ashlrai/phantom/commit/a02946792c54f42f269fdec833aee08c6a0cedd5))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795281657-N17:** ([#7963](https://github.com/ashlrai/phantom/issues/7963)) ([5b399f3](https://github.com/ashlrai/phantom/commit/5b399f3b33ae34acd699b421804da74f132e35e5))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795283168-N17:** ([#7966](https://github.com/ashlrai/phantom/issues/7966)) ([e12c2de](https://github.com/ashlrai/phantom/commit/e12c2de348d3cb664ca6addf4a15cd88407a95a4))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795284880-N17:** ([#7969](https://github.com/ashlrai/phantom/issues/7969)) ([36a7bee](https://github.com/ashlrai/phantom/commit/36a7bee8d781af01781d6b83ab11e7012f042c7f))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795286569-N17:** ([#7971](https://github.com/ashlrai/phantom/issues/7971)) ([0260b6f](https://github.com/ashlrai/phantom/commit/0260b6f3c6b984d75e1ac8accfeca80ea3968d6c))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795288639-N17:** ([#7976](https://github.com/ashlrai/phantom/issues/7976)) ([e40b17a](https://github.com/ashlrai/phantom/commit/e40b17ace48b3c8d5724916c75fa6778d4a6a26b))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795290039-N17:** ([#7979](https://github.com/ashlrai/phantom/issues/7979)) ([6c7b80a](https://github.com/ashlrai/phantom/commit/6c7b80aab36a3bef5b3291fa5062bd29a05abb7f))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795291403-N17:** ([#7982](https://github.com/ashlrai/phantom/issues/7982)) ([09c4264](https://github.com/ashlrai/phantom/commit/09c4264c3174503144f13f41a0f675ca4894b920))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795294467-N17:** ([#7991](https://github.com/ashlrai/phantom/issues/7991)) ([eb9d78e](https://github.com/ashlrai/phantom/commit/eb9d78ee22e5ed22fdfa2c65fe53000d26b17bf6))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795296240-N17:** ([#7998](https://github.com/ashlrai/phantom/issues/7998)) ([213ecb3](https://github.com/ashlrai/phantom/commit/213ecb3547962f6afd4ddd643cb889be5dd65c65))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795297938-N17:** ([#8008](https://github.com/ashlrai/phantom/issues/8008)) ([5ac4529](https://github.com/ashlrai/phantom/commit/5ac4529590ca47141cd76a68ccd48fadec31893c))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795300510-N17:** ([#8014](https://github.com/ashlrai/phantom/issues/8014)) ([ec31e4c](https://github.com/ashlrai/phantom/commit/ec31e4c68419f46b109e831eb2c376d1ec831705))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795301264-N17:** ([#8023](https://github.com/ashlrai/phantom/issues/8023)) ([4b8be7f](https://github.com/ashlrai/phantom/commit/4b8be7fc60c26af0d7e7e092a0c9f1eb767470aa))
* **RQ-GAPFILTERN23FQ8:** RQ-GAPFILTERN23FQ8 ([#8006](https://github.com/ashlrai/phantom/issues/8006)) ([c151a96](https://github.com/ashlrai/phantom/commit/c151a96625c07d64f4a94b76b71f4b0c559c80c6))
* **RQ-GAPLANESN22YQ8:** RQ-GAPLANESN22YQ8: gaps hook counts launchable rows, not pro ([#7939](https://github.com/ashlrai/phantom/issues/7939)) ([a7354cc](https://github.com/ashlrai/phantom/commit/a7354cc0fa33f0cf903ae5169fc9a8786c8e35bc))
* **RQ-HOSTLOADN23GQ8:** RQ-HOSTLOADN23GQ8 ([#8019](https://github.com/ashlrai/phantom/issues/8019)) ([053148e](https://github.com/ashlrai/phantom/commit/053148ef78a7815304b5a9893129fdda81b71425))
* **RQ-IMSGONN22XQ8R2:** RQ-IMSGONN22XQ8R2: recovery of RQ-IMSGONN22XQ8 ([#7932](https://github.com/ashlrai/phantom/issues/7932)) ([42de28b](https://github.com/ashlrai/phantom/commit/42de28b5deb72e44c3a2cb1897ddc2d6112f4e8b))
* **RQ-LEADERBRIEFN23FQ8:** RQ-LEADERBRIEFN23FQ8: compact leader first read; changes int ([#8007](https://github.com/ashlrai/phantom/issues/8007)) ([14eb9de](https://github.com/ashlrai/phantom/commit/14eb9de0545ed2da13dc2e2a0307949261c9cd50))
* **RQ-LIVEJOBSCAPN23FQ8:** Live jobs snapshots now contain marker-backed running jobs w ([#8004](https://github.com/ashlrai/phantom/issues/8004)) ([c3e40c0](https://github.com/ashlrai/phantom/commit/c3e40c01edb165c63987b9b41cebaa003ea6c3db))
* **RQ-LIVEJOBSN23EQ8:** RQ-LIVEJOBSN23EQ8: origin/master (same HEAD) already had job ([#7994](https://github.com/ashlrai/phantom/issues/7994)) ([04173ae](https://github.com/ashlrai/phantom/commit/04173ae8c012e3e936f78e88ca22f97c5ad6e805))
* **RQ-LOCALSTUCKN22WQ8:** RQ-LOCALSTUCKN22WQ8: stuck and ghost running jobs ([#7921](https://github.com/ashlrai/phantom/issues/7921)) ([789d9f4](https://github.com/ashlrai/phantom/commit/789d9f433d0e8565e2630a7282eb4217a9a178e2))
* **RQ-OWNERLIVEN22WQ8:** RQ-OWNERLIVEN22WQ8: owner-live status and hourly leader repl ([#7920](https://github.com/ashlrai/phantom/issues/7920)) ([4eb4d57](https://github.com/ashlrai/phantom/commit/4eb4d57be1ad1eb167ffc3dd928941620701d783))
* **RQ-PAIRIMSGN22YQ8:** RQ-PAIRIMSGN22YQ8: phm owner pair imessage ([#7941](https://github.com/ashlrai/phantom/issues/7941)) ([6b7fcbd](https://github.com/ashlrai/phantom/commit/6b7fcbda5981bbad4bb6284cecb7003ba8e56ad3))
* **RQ-PAIRMULTIN22ZQ8:** RQ-PAIRMULTIN22ZQ8: pair with several own iMessage handles ([#7949](https://github.com/ashlrai/phantom/issues/7949)) ([447bbd5](https://github.com/ashlrai/phantom/commit/447bbd54b6e0ef94e43c0f0f7804b8fae4bc3fca))
* **RQ-PHX-BUILDFETCHFINISH743S:** RQ-PHX-BUILDFETCHFINISH743S handoff ([#8025](https://github.com/ashlrai/phantom/issues/8025)) ([79fa709](https://github.com/ashlrai/phantom/commit/79fa709561939b3fab165ecda0f32b51a1ab742a))
* **RQ-PHX-BUILDLIMITFINISH745S:** RQ-PHX-BUILDLIMITFINISH745S ([#8032](https://github.com/ashlrai/phantom/issues/8032)) ([1433a60](https://github.com/ashlrai/phantom/commit/1433a60349b394306d1653689907eee0ccc2b403))
* **RQ-PHX-GAP00548E5D71:** RQ-PHX-GAP00548E5D71 ([#7986](https://github.com/ashlrai/phantom/issues/7986)) ([1162eb9](https://github.com/ashlrai/phantom/commit/1162eb9ecee4bb4ec00057614943fcac90967926))
* **RQ-PHX-GAP190A66AE87:** RQ-PHX-GAP190A66AE87 ([#7995](https://github.com/ashlrai/phantom/issues/7995)) ([271fbcb](https://github.com/ashlrai/phantom/commit/271fbcb559294dc5f412bee9ff1e052b4113606b))
* **RQ-PHX-GAP202713DCE2:** RQ-PHX-GAP202713DCE2: autofill filters gh-dependent jobs by ([#7943](https://github.com/ashlrai/phantom/issues/7943)) ([8180b6a](https://github.com/ashlrai/phantom/commit/8180b6a94be0c72b81edeeb0c3af5342105dd04c))
* **RQ-PHX-GAP2D418F03B5:** RQ-PHX-GAP2D418F03B5: lane-console starved read ([#7948](https://github.com/ashlrai/phantom/issues/7948)) ([9ccbf68](https://github.com/ashlrai/phantom/commit/9ccbf68dfda2362ac8a7b96f725d59d44eb80174))
* **RQ-PHX-GAP56DB6A3BBE:** RQ-PHX-GAP56DB6A3BBE ([#8001](https://github.com/ashlrai/phantom/issues/8001)) ([1292209](https://github.com/ashlrai/phantom/commit/12922092d3e1b594879f054c01e13a12152446a9))
* **RQ-PHX-GAP5727BAB5A6:** RQ-PHX-GAP5727BAB5A6: no budget reading ([#7947](https://github.com/ashlrai/phantom/issues/7947)) ([3408edd](https://github.com/ashlrai/phantom/commit/3408edd7da14e78c70c0f0df58370804fdf0170f))
* **RQ-PHX-GAPA314D158BD:** RQ-PHX-GAPA314D158BD: no git checkout ([#7952](https://github.com/ashlrai/phantom/issues/7952)) ([4bdbcff](https://github.com/ashlrai/phantom/commit/4bdbcff39faa694737d8fa9ae342055f14a85259))
* **RQ-PHX-GAPAF06DBF33D:** RQ-PHX-GAPAF06DBF33D ([#8010](https://github.com/ashlrai/phantom/issues/8010)) ([a402e5f](https://github.com/ashlrai/phantom/commit/a402e5f1f280fd9f95a8a4281b721d955b33f233))
* **RQ-PHX-GAPB05C03F048:** RQ-PHX-GAPB05C03F048 ([#8011](https://github.com/ashlrai/phantom/issues/8011)) ([cefb3ab](https://github.com/ashlrai/phantom/commit/cefb3aba5be934ed0cb4f741733c597735e52deb))
* **RQ-PHX-GAPC96CB14720:** RQ-PHX-GAPC96CB14720 ([#8015](https://github.com/ashlrai/phantom/issues/8015)) ([4a5cacd](https://github.com/ashlrai/phantom/commit/4a5cacd2e5a1531620a0833e8015ad0af1137f55))
* **RQ-PHX-GAPE43DD757F5:** RQ-PHX-GAPE43DD757F5 — Other callers ([#8017](https://github.com/ashlrai/phantom/issues/8017)) ([3025673](https://github.com/ashlrai/phantom/commit/3025673e11d9d6fe35f309f8d0a986c6708d5498))
* **RQ-PHX-GAPEDCBB57414:** RQ-PHX-GAPEDCBB57414 ([#8026](https://github.com/ashlrai/phantom/issues/8026)) ([60e07af](https://github.com/ashlrai/phantom/commit/60e07affef2c0d88f42984147724d9913b7c3dd7))
* **RQ-PHX-LANDVERSEDIRTY706:** RQ-PHX-LANDVERSEDIRTY706 ([#7988](https://github.com/ashlrai/phantom/issues/7988)) ([9528ee9](https://github.com/ashlrai/phantom/commit/9528ee93bb89ca9f42dc3d99bdd89afd4ee1d596))
* **RQ-PHX-RECORDEDRUNTIMEPOOL680SR2:** RQ-PHX-RECORDEDRUNTIMEPOOL680SR2 — recovery of RQ-PHX-RECORD ([#7911](https://github.com/ashlrai/phantom/issues/7911)) ([5a237c0](https://github.com/ashlrai/phantom/commit/5a237c067c167fada12c972143fa38f2f52d8b7c))
* **RQ-PHX-REDTESTFIXC738B:** RQ-PHX-REDTESTFIXC738B ([#7997](https://github.com/ashlrai/phantom/issues/7997)) ([9be8ffe](https://github.com/ashlrai/phantom/commit/9be8ffe273cbf20ecfce553dc5d956303aeed3ab))
* **RQ-PHX-TELEMETRYRECORDERRECOVER672SR2:** RQ-PHX-TELEMETRYRECORDERRECOVER672SR2 ([#7910](https://github.com/ashlrai/phantom/issues/7910)) ([6289eeb](https://github.com/ashlrai/phantom/commit/6289eeb6a72a5bde67d73b369633f12e5726f11c))
* **RQ-POOLPACEN23DQ8:** RQ-POOLPACEN23DQ8: extended existing phm fleet pace (BURNPAC ([#7985](https://github.com/ashlrai/phantom/issues/7985)) ([4c39195](https://github.com/ashlrai/phantom/commit/4c39195986b96b144e1bfaef83658b75d255df9b))
* **RQ-RECAPTUREQ8:** RQ-RECAPTUREQ8 ([#8028](https://github.com/ashlrai/phantom/issues/8028)) ([be41d7d](https://github.com/ashlrai/phantom/commit/be41d7d89eeeefe1c2c481aa505bad53d529bd4d))
* **RQ-REDFIXGATEN23FQ8:** RQ-REDFIXGATEN23FQ8 — partial ([#8005](https://github.com/ashlrai/phantom/issues/8005)) ([6f39309](https://github.com/ashlrai/phantom/commit/6f3930994694711168d1bbcf4c81b40b858b5ad4))
* **RQ-REPLYROUTEN23DQ8:** RQ-REPLYROUTEN23DQ8: master already had owner pair (includin ([#7987](https://github.com/ashlrai/phantom/issues/7987)) ([17212d5](https://github.com/ashlrai/phantom/commit/17212d54d736b50ddfae4076637a41d97a31cbe4))
* **RQ-SUPPLYTRACEQ8:** RQ-SUPPLYTRACEQ8 ([#8029](https://github.com/ashlrai/phantom/issues/8029)) ([5364917](https://github.com/ashlrai/phantom/commit/5364917a9dfee570345df0abf3abef68bb164701))
* **RQ-VERIFYNOBASEN23EQ8:** RQ-VERIFYNOBASEN23EQ8 ([#7990](https://github.com/ashlrai/phantom/issues/7990)) ([42c4aef](https://github.com/ashlrai/phantom/commit/42c4aefa4eccc52298469b9fd81a9aa22404aa99))

## [3.30.60] - 2026-11-21


### Changes

* **RQ-CL-DESK-1795223810:** ([#7709](https://github.com/ashlrai/phantom/issues/7709)) ([bf15439](https://github.com/ashlrai/phantom/commit/bf154395fa98bc783f7b0b4d46bdafb9443cf9f6))
* **RQ-CL-DESK-1795239751:** ([#7819](https://github.com/ashlrai/phantom/issues/7819)) ([dbf2ecd](https://github.com/ashlrai/phantom/commit/dbf2ecd2dde4048326fb82920fac4abce0b8aff0))
* **RQ-CL-DESK2-1795233950:** ([#7789](https://github.com/ashlrai/phantom/issues/7789)) ([dc1ebeb](https://github.com/ashlrai/phantom/commit/dc1ebebec3685a8a5c5f4d1d6547c0446d7de99c))
* **RQ-CL-DESK2-1795239141:** ([#7816](https://github.com/ashlrai/phantom/issues/7816)) ([d601092](https://github.com/ashlrai/phantom/commit/d601092de47e71f53bf539ad34ad70405ff8c50c))
* **RQ-CL-DESK2-1795239718:** ([#7820](https://github.com/ashlrai/phantom/issues/7820)) ([3370aba](https://github.com/ashlrai/phantom/commit/3370aba6b1011e1ef4a4d3ce1be60b0b2a3cfb87))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795239571-N17:** ([#7818](https://github.com/ashlrai/phantom/issues/7818)) ([8df37e0](https://github.com/ashlrai/phantom/commit/8df37e072b2eab36440a626facc43ed4a022d0f1))

## [3.30.59] - 2026-11-21


### Changes

* **RQ-CL-DESK2-1795236703:** ([#7803](https://github.com/ashlrai/phantom/issues/7803)) ([8fbef20](https://github.com/ashlrai/phantom/commit/8fbef2039cbb1f4f003ea3cf6aee4a482bd7ae73))
* **RQ-CL-DESK2-1795237311:** ([#7810](https://github.com/ashlrai/phantom/issues/7810)) ([1a7f374](https://github.com/ashlrai/phantom/commit/1a7f3740eef5e50e3a11fde3ab09e999ea63bb50))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795236440-N17:** ([#7805](https://github.com/ashlrai/phantom/issues/7805)) ([67a18bd](https://github.com/ashlrai/phantom/commit/67a18bd9b0fd944bb962f6bbd78e3554cbef7b9e))
* **RQ-SLATEPLANN22KQ8:** RQ-SLATEPLANN22KQ8: the planner says plainly when no fallbac ([#7804](https://github.com/ashlrai/phantom/issues/7804)) ([aaf79df](https://github.com/ashlrai/phantom/commit/aaf79df7550b508c5e33838a712de1113bd10ac4))
* **RQ-WTSTATEN22KQ8:** RQ-WTSTATEN22KQ8: worktree reap classifies "state-unknown" w ([#7808](https://github.com/ashlrai/phantom/issues/7808)) ([be7b9d4](https://github.com/ashlrai/phantom/commit/be7b9d4a5e70210292d4b4e17587626f972f6582))

## [3.30.58] - 2026-11-21


### Changes

* **RQ-AUTOFILLIDLEN22IQ8:** RQ-AUTOFILLIDLEN22IQ8: autofill feeds an idle lane that has ([#7776](https://github.com/ashlrai/phantom/issues/7776)) ([bfc5cf6](https://github.com/ashlrai/phantom/commit/bfc5cf6aafc044c3bf4901eece12472e2354ef37))
* **RQ-BUILDSTEPN22IQ8:** RQ-BUILDSTEPN22IQ8: build no longer fails when this Node has ([#7785](https://github.com/ashlrai/phantom/issues/7785)) ([7cf8d6a](https://github.com/ashlrai/phantom/commit/7cf8d6a4253db7cbe86b92ac87f1cad43fa54b77))
* **RQ-CL-DESK-1795231928:** ([#7767](https://github.com/ashlrai/phantom/issues/7767)) ([5a9ed43](https://github.com/ashlrai/phantom/commit/5a9ed43f0a1f56e9e93da1cb4abd6334f09fd8da))
* RQ-CL-DESK-1795232417 ([#7772](https://github.com/ashlrai/phantom/issues/7772)) ([764b3aa](https://github.com/ashlrai/phantom/commit/764b3aabcdd1ffcc4669b890b1e3bfe0d3d72027))
* **RQ-CL-DESK2-1795232980:** ([#7774](https://github.com/ashlrai/phantom/issues/7774)) ([e4bd211](https://github.com/ashlrai/phantom/commit/e4bd2112e3a7bdbcef7d9fe2165e3180c9f08da9))
* **RQ-CL-DOCS-1795233967:** ([#7782](https://github.com/ashlrai/phantom/issues/7782)) ([aec67bd](https://github.com/ashlrai/phantom/commit/aec67bd61d3ce4af4a71b320f252805cfbf5f4d6))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795232928-N17:** ([#7773](https://github.com/ashlrai/phantom/issues/7773)) ([12e72a9](https://github.com/ashlrai/phantom/commit/12e72a9c9e54928f3b06f2f28a264a388a37fd91))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795233279-N17:** ([#7781](https://github.com/ashlrai/phantom/issues/7781)) ([b4e04a5](https://github.com/ashlrai/phantom/commit/b4e04a5d70b6b0d4e78b3fae52bcf333c2530de4))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795234268-N17:** ([#7790](https://github.com/ashlrai/phantom/issues/7790)) ([a8eb697](https://github.com/ashlrai/phantom/commit/a8eb6973c5c586fb6b56ca776f907e88de2b609a))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795231850-N17:** ([#7768](https://github.com/ashlrai/phantom/issues/7768)) ([5fd3a6b](https://github.com/ashlrai/phantom/commit/5fd3a6bdcea918dabd7878d5225275091b6363fb))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795232970-N17:** ([#7775](https://github.com/ashlrai/phantom/issues/7775)) ([caeeee7](https://github.com/ashlrai/phantom/commit/caeeee75af685009f31b1027cb8105ff262d3b0c))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795233541-N17:** ([#7780](https://github.com/ashlrai/phantom/issues/7780)) ([0276646](https://github.com/ashlrai/phantom/commit/0276646215d40a9eaa824195a110485a0a60d76a))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795234065-N17:** ([#7788](https://github.com/ashlrai/phantom/issues/7788)) ([6fe2b38](https://github.com/ashlrai/phantom/commit/6fe2b38f32c63c30f8a81ea87da1789fc13c9371))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795235083-N17:** ([#7795](https://github.com/ashlrai/phantom/issues/7795)) ([322d813](https://github.com/ashlrai/phantom/commit/322d8134953dd7be806a31c6e1787d5a9f321c8e))
* **RQ-DUPCHECKN22IQ8:** RQ-DUPCHECKN22IQ8: `phm jobs dupcheck` ([#7794](https://github.com/ashlrai/phantom/issues/7794)) ([57bb345](https://github.com/ashlrai/phantom/commit/57bb345261b6f5e6881fda74d3841550a8b961b4))
* **RQ-GAPHOOKN22IQ8:** RQ-GAPHOOKN22IQ8: self-tick gap hook ([#7779](https://github.com/ashlrai/phantom/issues/7779)) ([116a2b9](https://github.com/ashlrai/phantom/commit/116a2b908a6de348489efe91fc9805f56190851b))
* RQ-LOCALFITN22GQ8 ([#7760](https://github.com/ashlrai/phantom/issues/7760)) ([2feb8b6](https://github.com/ashlrai/phantom/commit/2feb8b68a1e707feb2b329f540fe49e87d843828))
* **RQ-MAPMSGSN22EQ8:** RQ-MAPMSGSN22EQ8: agent messages as live edges on the fleet ([#7770](https://github.com/ashlrai/phantom/issues/7770)) ([72a76ee](https://github.com/ashlrai/phantom/commit/72a76eea11bc3af604fc8098dd1e71b4cb09788f))
* **RQ-PHX-DOTEVIDENCEDESK709:** RQ-PHX-DOTEVIDENCEDESK709 ([#7793](https://github.com/ashlrai/phantom/issues/7793)) ([300466e](https://github.com/ashlrai/phantom/commit/300466e8b923c56475a4ff4a6e1f98da0b85fdd7))
* **RQ-PLANNERLANEN22IQ8:** RQ-PLANNERLANEN22IQ8: planner moves to a lane that still has ([#7777](https://github.com/ashlrai/phantom/issues/7777)) ([be38ff9](https://github.com/ashlrai/phantom/commit/be38ff97265fdbd25a63e88fe2f18ec8f8dfef1b))
* **RQ-SUPPLYCARDN22IQ8:** RQ-SUPPLYCARDN22IQ8: lane supply glance ([#7786](https://github.com/ashlrai/phantom/issues/7786)) ([b19f548](https://github.com/ashlrai/phantom/commit/b19f548c0a675652753368308257ed55db520b9c))

## [3.30.57] - 2026-11-21


### Changes

* **FIXUP-CI-phantom-release-prep-705205:** FIXUP-CI-phantom-release-prep-705205 ([#7745](https://github.com/ashlrai/phantom/issues/7745)) ([826edc2](https://github.com/ashlrai/phantom/commit/826edc2b0cf78afd08874d98e154ba231531f1f2))
* **RQ-CEILNULLN22GQ8:** RQ-CEILNULLN22GQ8: slots.json `"ceiling": null` means no fix ([#7754](https://github.com/ashlrai/phantom/issues/7754)) ([2349c1b](https://github.com/ashlrai/phantom/commit/2349c1b7f6c7d138e38fb530c776b1d813bdbb14))
* RQ-CL-DESK-1795227991 ([#7746](https://github.com/ashlrai/phantom/issues/7746)) ([1fc3983](https://github.com/ashlrai/phantom/commit/1fc3983e4f14b6cdb470d685e4d63a767cd9aba5))
* **RQ-CL-DESK-1795229389:** ([#7753](https://github.com/ashlrai/phantom/issues/7753)) ([68ed6cc](https://github.com/ashlrai/phantom/commit/68ed6cc351a48ace3b15cbe43ff5d9e4b5ad6423))
* **RQ-CL-DESK2-1795228303:** ([#7743](https://github.com/ashlrai/phantom/issues/7743)) ([018fd41](https://github.com/ashlrai/phantom/commit/018fd413566edd57e28e5f0e71df2d79bcf4f088))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795229679-N17:** ([#7750](https://github.com/ashlrai/phantom/issues/7750)) ([4ad9e31](https://github.com/ashlrai/phantom/commit/4ad9e31e37b9d81a164bf0d81b5640d2c428fa51))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795228374-N17:** ([#7744](https://github.com/ashlrai/phantom/issues/7744)) ([fbf9c9f](https://github.com/ashlrai/phantom/commit/fbf9c9ff1db1d2048b6e3ac07c26903414ec4d61))
* **RQ-DOCSSYNCDATEN22EQ8:** RQ-DOCSSYNCDATEN22EQ8 ([#7748](https://github.com/ashlrai/phantom/issues/7748)) ([06f422d](https://github.com/ashlrai/phantom/commit/06f422d1891de9e5907968ba28591cf10c4accad))
* **RQ-MEMSPLITN22GQ8:** RQ-MEMSPLITN22GQ8: memory pressure throttles local lanes, no ([#7751](https://github.com/ashlrai/phantom/issues/7751)) ([a5ffc1d](https://github.com/ashlrai/phantom/commit/a5ffc1def6f59dfafab0b7d0dfeebdea7ee945bc))

## [3.30.56] - 2026-11-21


### Changes

* **RQ-CL-DESK-1795226742:** ([#7731](https://github.com/ashlrai/phantom/issues/7731)) ([9d3a4d0](https://github.com/ashlrai/phantom/commit/9d3a4d018de6c80e0978c5acc12a856f51d15f00))
* **RQ-CL-DESK2-1795220151:** ([#7683](https://github.com/ashlrai/phantom/issues/7683)) ([4c2a91f](https://github.com/ashlrai/phantom/commit/4c2a91f808fa61ff20519a761caac1d890470e86))
* RQ-CL-DESK2-1795222606 ([#7705](https://github.com/ashlrai/phantom/issues/7705)) ([680bc7f](https://github.com/ashlrai/phantom/commit/680bc7f4bd1b33dbe1ee130bbc24a3b65148400b))
* **RQ-CL-DESK2-1795226114:** ([#7727](https://github.com/ashlrai/phantom/issues/7727)) ([a807d61](https://github.com/ashlrai/phantom/commit/a807d61cdfb0ce1f2ec3220c547bb05e691b8d7e))
* **RQ-CL-DESK2-1795226782:** ([#7732](https://github.com/ashlrai/phantom/issues/7732)) ([2fe86b9](https://github.com/ashlrai/phantom/commit/2fe86b9da710d2f003d6c638e6efc54eb618e028))
* **RQ-CL-DOCS-1795226916:** ([#7730](https://github.com/ashlrai/phantom/issues/7730)) ([f407c46](https://github.com/ashlrai/phantom/commit/f407c4696b3e462cd7e62d581325aa72d7581ba6))
* **RQ-GAPCOUNTN22EQ8:** BRIDGE_NOTES: RQ-GAPCOUNTN22EQ8 ([#7728](https://github.com/ashlrai/phantom/issues/7728)) ([dfc7d67](https://github.com/ashlrai/phantom/commit/dfc7d6757953181f04715d3278d4fd203f8b88bc))
* **RQ-GAPLANDN22EQ8:** BRIDGE_NOTES: RQ-GAPLANDN22EQ8 ([#7733](https://github.com/ashlrai/phantom/issues/7733)) ([ec88503](https://github.com/ashlrai/phantom/commit/ec885033bbf8e1bc4b538e07f706d7d2388c435e))

## [3.30.55] - 2026-11-21


### Changes

* **RQ-CL-DESK-1795224423:** ([#7714](https://github.com/ashlrai/phantom/issues/7714)) ([e7212e8](https://github.com/ashlrai/phantom/commit/e7212e8131626946826fc192aa570d2d15d8deda))
* **RQ-CL-DESK-1795224906:** ([#7718](https://github.com/ashlrai/phantom/issues/7718)) ([897b5c8](https://github.com/ashlrai/phantom/commit/897b5c864c6b16c4552a8d658bfbec62b741d61c))
* **RQ-CL-DESK2-1795224532:** ([#7715](https://github.com/ashlrai/phantom/issues/7715)) ([2d65cd6](https://github.com/ashlrai/phantom/commit/2d65cd6de4413be0a61b12333cede5d930bf6866))
* **RQ-CL-DOCS-1795225026:** ([#7717](https://github.com/ashlrai/phantom/issues/7717)) ([5733ec7](https://github.com/ashlrai/phantom/commit/5733ec73c3c4451292d82b7a141c001815d0bae1))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795224726-N17:** ([#7719](https://github.com/ashlrai/phantom/issues/7719)) ([64db07b](https://github.com/ashlrai/phantom/commit/64db07b8e6823d358c27d357093958441672adfa))
* **RQ-RECEIPTSN22CQ8:** RQ-RECEIPTSN22CQ8: honest state word on chat replies ([#7713](https://github.com/ashlrai/phantom/issues/7713)) ([82a676b](https://github.com/ashlrai/phantom/commit/82a676ba7b61568035845aaa5bf50d0c2fce7a2c))
* **RQ-TAILNODESN22CQ8:** RQ-TAILNODESN22CQ8: Tailscale computers show up as "not join ([#7716](https://github.com/ashlrai/phantom/issues/7716)) ([bcd3bf3](https://github.com/ashlrai/phantom/commit/bcd3bf3abed237288c703728b00db4c8c838a763))

## [3.30.54] - 2026-11-21


### Changes

* **RQ-ASKSQUIETN22CQ8:** RQ-ASKSQUIETN22CQ8: Mason only gets asks software cannot ans ([#7708](https://github.com/ashlrai/phantom/issues/7708)) ([7f43596](https://github.com/ashlrai/phantom/commit/7f435968a20d18ffc205b73ad8e7939505a60835))
* **RQ-BUILDLIVEN22CQ8:** RQ-BUILDLIVEN22CQ8: can the fleet tell whether merged featur ([#7700](https://github.com/ashlrai/phantom/issues/7700)) ([7366466](https://github.com/ashlrai/phantom/commit/7366466a17706d0e8ffc11b2d1f6e125055683d9))
* **RQ-CL-DESK-1795221581:** ([#7695](https://github.com/ashlrai/phantom/issues/7695)) ([0960890](https://github.com/ashlrai/phantom/commit/09608900f3541f17b6a95ef8f3afb32b3bca55e8))
* **RQ-CL-DESK-1795222208:** ([#7698](https://github.com/ashlrai/phantom/issues/7698)) ([6a9556d](https://github.com/ashlrai/phantom/commit/6a9556da14b8167a0d9714523e0ec44437e3a396))
* **RQ-CL-DESK2-1795221865:** ([#7697](https://github.com/ashlrai/phantom/issues/7697)) ([85908bf](https://github.com/ashlrai/phantom/commit/85908bf150abb86f3e335f9ac17f74c242f99c91))
* **RQ-CL-DOCS-1795222884:** ([#7701](https://github.com/ashlrai/phantom/issues/7701)) ([ad4b947](https://github.com/ashlrai/phantom/commit/ad4b94780f0442d177e912afa6e4cc8b9ac126e3))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795221822-N17:** ([#7696](https://github.com/ashlrai/phantom/issues/7696)) ([5429917](https://github.com/ashlrai/phantom/commit/5429917e86960f311a9f60cfadfbce4afd8ab3b5))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795222403-N17:** ([#7704](https://github.com/ashlrai/phantom/issues/7704)) ([52ea791](https://github.com/ashlrai/phantom/commit/52ea7916bb4fdcf286644520057a33008884d96f))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795222058-N17:** ([#7707](https://github.com/ashlrai/phantom/issues/7707)) ([a5f661b](https://github.com/ashlrai/phantom/commit/a5f661b41cc0f1c53f48e73e591fa3ace33d782f))
* RQ-EMPTYWHYR2N22CQ8 ([#7702](https://github.com/ashlrai/phantom/issues/7702)) ([638bb31](https://github.com/ashlrai/phantom/commit/638bb31b8e66a96084f18707fa13525897d54502))
* RQ-LIMITMSGN21EQ8 ([#7443](https://github.com/ashlrai/phantom/issues/7443)) ([bd57391](https://github.com/ashlrai/phantom/commit/bd573915ea06469d58128e729c7cec4e7fe0bfe6))
* RQ-UPKEEP-DOCS-phantom-20261120 ([#7688](https://github.com/ashlrai/phantom/issues/7688)) ([d0948ad](https://github.com/ashlrai/phantom/commit/d0948ada5413e55ba18833a41a3b7eba62530b53))

## [3.30.53] - 2026-11-21


### Changes

* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795218132-N17:** ([#7676](https://github.com/ashlrai/phantom/issues/7676)) ([13a8b84](https://github.com/ashlrai/phantom/commit/13a8b84ae5a72e7aa9deda3c80a0dc03bf0a2ce1))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795219934-N17:** ([#7679](https://github.com/ashlrai/phantom/issues/7679)) ([d2f5353](https://github.com/ashlrai/phantom/commit/d2f535393615aa4c989ee4e565e96b3a0c1c8bcb))
* **RQ-REFILLCARDN22AQ8:** RQ-REFILLCARDN22AQ8: Pools card: refilled pools and whether ([#7680](https://github.com/ashlrai/phantom/issues/7680)) ([7cdb614](https://github.com/ashlrai/phantom/commit/7cdb6145e2b80c7a2de99ea49234ae17635f1eb3))
* **RQ-RESETWAKEN22AQ8:** RQ-RESETWAKEN22AQ8: a pool past its reset counts as refilled ([#7677](https://github.com/ashlrai/phantom/issues/7677)) ([88824d5](https://github.com/ashlrai/phantom/commit/88824d52cf3da95763594d31563767e68f2eb19b))

## [3.30.52] - 2026-11-20


### Changes

* **RQ-CL-DESK-1795217070:** ([#7660](https://github.com/ashlrai/phantom/issues/7660)) ([d4a2892](https://github.com/ashlrai/phantom/commit/d4a28927b7ce4e4a1d8a1640b2f637e3a530cd48))
* **RQ-CL-DESK-1795217635:** ([#7666](https://github.com/ashlrai/phantom/issues/7666)) ([0375aba](https://github.com/ashlrai/phantom/commit/0375aba78e8b3f8bd6c5f3d7fd7770bf791c22b6))
* **RQ-CL-DESK2-1795217306:** ([#7661](https://github.com/ashlrai/phantom/issues/7661)) ([5b6ef92](https://github.com/ashlrai/phantom/commit/5b6ef922de192b0c92dd267b38ee33853c823801))
* **RQ-CL-DESK2-1795217649:** ([#7662](https://github.com/ashlrai/phantom/issues/7662)) ([26693d8](https://github.com/ashlrai/phantom/commit/26693d8d25d4d66cc0ab385b48cf06596aa01bf2))
* **RQ-CL-DESK2-1795217959:** ([#7667](https://github.com/ashlrai/phantom/issues/7667)) ([fd16d5b](https://github.com/ashlrai/phantom/commit/fd16d5bea20f85be61a5a55efca553154ac51663))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795216952-N17:** ([#7663](https://github.com/ashlrai/phantom/issues/7663)) ([51f3d96](https://github.com/ashlrai/phantom/commit/51f3d96778adb55c0f1861e684ccb3ced8d7e027))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795218076-N17:** ([#7669](https://github.com/ashlrai/phantom/issues/7669)) ([271c44a](https://github.com/ashlrai/phantom/commit/271c44a9fbcad2e339cf1023eb77fe99aea22664))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795217527-N17:** ([#7664](https://github.com/ashlrai/phantom/issues/7664)) ([a121a86](https://github.com/ashlrai/phantom/commit/a121a86c671247f132cb47a3cdb86e8e8603bf43))

## [3.30.51] - 2026-11-20


### Changes

* **RQ-CL-DESK-1795215616:** ([#7651](https://github.com/ashlrai/phantom/issues/7651)) ([f96499c](https://github.com/ashlrai/phantom/commit/f96499c11fd5cfb12f6864656690c0406bcc1ed5))
* **RQ-CL-DESK2-1795215642:** ([#7653](https://github.com/ashlrai/phantom/issues/7653)) ([b0c45f0](https://github.com/ashlrai/phantom/commit/b0c45f0a66e2a3ed5546fa5f83b49e08203a0c62))
* **RQ-CL-DESK2-1795216377:** ([#7654](https://github.com/ashlrai/phantom/issues/7654)) ([489a074](https://github.com/ashlrai/phantom/commit/489a074248ffd35346db22b8a37f0eff465676ba))

## [3.30.50] - 2026-11-20


### Changes

* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795212336-N17:** ([#7646](https://github.com/ashlrai/phantom/issues/7646)) ([221fb14](https://github.com/ashlrai/phantom/commit/221fb14e1538e86071cb8e1e3118fe7a9f3418fd))

## [3.30.49] - 2026-11-20


### Changes

* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795209415-N17:** ([#7640](https://github.com/ashlrai/phantom/issues/7640)) ([a19ff50](https://github.com/ashlrai/phantom/commit/a19ff5058e7086fd80d013e4cca8849c61987564))

## [3.30.48] - 2026-11-20


### Changes

* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795204037-N17:** ([#7632](https://github.com/ashlrai/phantom/issues/7632)) ([2ec3863](https://github.com/ashlrai/phantom/commit/2ec3863cd2495abc2cc18108304a28b4c242f172))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795205447-N17:** ([#7635](https://github.com/ashlrai/phantom/issues/7635)) ([b57143b](https://github.com/ashlrai/phantom/commit/b57143b6f2020a3a9ed7d3d3541c2b9aeb4e95b8))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795206050-N17:** ([#7634](https://github.com/ashlrai/phantom/issues/7634)) ([ddd5e5b](https://github.com/ashlrai/phantom/commit/ddd5e5bee27056e492da464c57eac5da45361e8c))

## [3.30.47] - 2026-11-20


### Fixes

* **contrib/mac:** require live account evidence for devin previews; unique shim temp paths ([#7532](https://github.com/ashlrai/phantom/issues/7532)) ([87a1c74](https://github.com/ashlrai/phantom/commit/87a1c743af547281dcbd0c03b438ab9620061fbc))
* **tests:** unblock master Fast gate round 2 — leader failover fit mock + CODEOWNERS regen ([#7554](https://github.com/ashlrai/phantom/issues/7554)) ([47b341f](https://github.com/ashlrai/phantom/commit/47b341fb005a5466977b1d622e6b8b9b97592314))


### Changes

* **RQ-APPSFOCUSN21QQ8:** BRIDGE_NOTES: RQ-APPSFOCUSN21QQ8 ([#7550](https://github.com/ashlrai/phantom/issues/7550)) ([793472b](https://github.com/ashlrai/phantom/commit/793472b875a2fc59a9258e4bb461ae9fa25a7fc6))
* **RQ-BRIEFFIXN21SQ8:** RQ-BRIEFFIXN21SQ8 ([#7563](https://github.com/ashlrai/phantom/issues/7563)) ([b454f5e](https://github.com/ashlrai/phantom/commit/b454f5e596bdfb7ba16300c725b94aaadf5c616c))
* **RQ-BRIEFTITLEN21UQ8:** RQ-BRIEFTITLEN21UQ8 ([#7571](https://github.com/ashlrai/phantom/issues/7571)) ([9324b24](https://github.com/ashlrai/phantom/commit/9324b24f7f342e787eb9d91b3b264c2f13e4be32))
* **RQ-CL-DOCS-1795167720:** ([#7578](https://github.com/ashlrai/phantom/issues/7578)) ([c3cebc9](https://github.com/ashlrai/phantom/commit/c3cebc9e9d99fe57502756fb18c9f7af75c7e791))
* **RQ-CREDITASKN21QQ8:** RQ-CREDITASKN21QQ8: Claude API gift credit ask ([#7543](https://github.com/ashlrai/phantom/issues/7543)) ([921d162](https://github.com/ashlrai/phantom/commit/921d1625086f50ca494539203811668134ed65f7))
* **RQ-CREDITDOCSN21UQ8:** BRIDGE_NOTES: RQ-CREDITDOCSN21UQ8 ([#7569](https://github.com/ashlrai/phantom/issues/7569)) ([49dd9ac](https://github.com/ashlrai/phantom/commit/49dd9ac647c9ad4480c201251139cd3302900907))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795157877-N17:** ([#7547](https://github.com/ashlrai/phantom/issues/7547)) ([c9fa4d2](https://github.com/ashlrai/phantom/commit/c9fa4d264de4905bc7a11d427383e3f20b06052a))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795159606-N17:** ([#7552](https://github.com/ashlrai/phantom/issues/7552)) ([519ea54](https://github.com/ashlrai/phantom/commit/519ea54d80b44d02d272487a83fd3ed5f868d829))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795160524-N17:** ([#7556](https://github.com/ashlrai/phantom/issues/7556)) ([d413611](https://github.com/ashlrai/phantom/commit/d413611c6bff850c859700811492309372db1f57))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795161557-N17:** ([#7561](https://github.com/ashlrai/phantom/issues/7561)) ([4128399](https://github.com/ashlrai/phantom/commit/41283990d91ba4bfb45de6b1c106d6def63c7509))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795162698-N17:** ([#7565](https://github.com/ashlrai/phantom/issues/7565)) ([42b2dcd](https://github.com/ashlrai/phantom/commit/42b2dcdc3e32b02215994af0a8661d23e196922c))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795163598-N17:** ([#7568](https://github.com/ashlrai/phantom/issues/7568)) ([6f05761](https://github.com/ashlrai/phantom/commit/6f057615da981e9ae82a21aa077095fc12ca9e3c))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795165532-N17:** ([#7575](https://github.com/ashlrai/phantom/issues/7575)) ([c2ca9f6](https://github.com/ashlrai/phantom/commit/c2ca9f60f2104682a938c54fccf30430ae15a4f5))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795166493-N17:** ([#7577](https://github.com/ashlrai/phantom/issues/7577)) ([045ddb5](https://github.com/ashlrai/phantom/commit/045ddb5ffc7aedbd2f27c58994b47594f93c806f))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795167105-N17:** ([#7579](https://github.com/ashlrai/phantom/issues/7579)) ([4dda627](https://github.com/ashlrai/phantom/commit/4dda627a0b925be80a87e3407a9a18383f6354c0))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795169654-N17:** ([#7584](https://github.com/ashlrai/phantom/issues/7584)) ([23660f4](https://github.com/ashlrai/phantom/commit/23660f4abfacddf0a88bfb1298a817f8d29a32cc))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795170480-N17:** ([#7587](https://github.com/ashlrai/phantom/issues/7587)) ([f402676](https://github.com/ashlrai/phantom/commit/f4026762f86206b89e4fe97742e4c74ed881a60e))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795171678-N17:** ([#7589](https://github.com/ashlrai/phantom/issues/7589)) ([b5447a1](https://github.com/ashlrai/phantom/commit/b5447a11f6cd2f28b40f995f58491001bf234b3f))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795172464-N17:** ([#7592](https://github.com/ashlrai/phantom/issues/7592)) ([254081f](https://github.com/ashlrai/phantom/commit/254081f79b42d2c6742692c89cb9808ff50e12b1))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795173535-N17:** ([#7595](https://github.com/ashlrai/phantom/issues/7595)) ([2d3078d](https://github.com/ashlrai/phantom/commit/2d3078dd653b5eb1a10d375fc481a39cf403b449))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795174758-N17:** ([#7597](https://github.com/ashlrai/phantom/issues/7597)) ([2525648](https://github.com/ashlrai/phantom/commit/2525648a864cba0783e5453775a9b9ed0a845dd9))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795177526-N17:** ([#7600](https://github.com/ashlrai/phantom/issues/7600)) ([118ee04](https://github.com/ashlrai/phantom/commit/118ee04c318b7e7c3207a8f88f161e8537b1b3b8))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795178569-N17:** ([#7602](https://github.com/ashlrai/phantom/issues/7602)) ([a46d233](https://github.com/ashlrai/phantom/commit/a46d233878f36251a0ed8848643a813a7547cdd8))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795179919-N17:** ([#7603](https://github.com/ashlrai/phantom/issues/7603)) ([9dfef2d](https://github.com/ashlrai/phantom/commit/9dfef2d77df8bea0465b90c6f037e839ffbaef08))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795180736-N17:** ([#7605](https://github.com/ashlrai/phantom/issues/7605)) ([4ac5113](https://github.com/ashlrai/phantom/commit/4ac51131246c3cd6b5c32bf84bba16c2bb7ea368))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795181998-N17:** ([#7606](https://github.com/ashlrai/phantom/issues/7606)) ([57781bc](https://github.com/ashlrai/phantom/commit/57781bcb4d76932c6288177d9f3a47ce72ccc6c9))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795182619-N17:** ([#7608](https://github.com/ashlrai/phantom/issues/7608)) ([9af204d](https://github.com/ashlrai/phantom/commit/9af204dfbcfa394fcb1663f723c72fb2b3432ef9))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795184089-N17:** ([#7610](https://github.com/ashlrai/phantom/issues/7610)) ([0467d14](https://github.com/ashlrai/phantom/commit/0467d14bc539f6f321474a88dfecd6e8ca4096e8))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795187325-N17:** ([#7612](https://github.com/ashlrai/phantom/issues/7612)) ([33dd2d7](https://github.com/ashlrai/phantom/commit/33dd2d73ece99375c92a303d135812a6b861934b))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795188691-N17:** ([#7613](https://github.com/ashlrai/phantom/issues/7613)) ([e7a541c](https://github.com/ashlrai/phantom/commit/e7a541cd9c9d0326f3aca8e000faf52a931d4a20))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795190258-N17:** ([#7614](https://github.com/ashlrai/phantom/issues/7614)) ([dfa7e4c](https://github.com/ashlrai/phantom/commit/dfa7e4c6da0109a28c7cc72bbed66615fa71b8ee))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795191368-N17:** ([#7616](https://github.com/ashlrai/phantom/issues/7616)) ([b2bcb7b](https://github.com/ashlrai/phantom/commit/b2bcb7bb787e1f8c36595040edf7f950fe59317f))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795193699-N17:** ([#7619](https://github.com/ashlrai/phantom/issues/7619)) ([b191b0e](https://github.com/ashlrai/phantom/commit/b191b0e730d45812978f863841a95101d12fc471))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795194724-N17:** ([#7620](https://github.com/ashlrai/phantom/issues/7620)) ([c7176ec](https://github.com/ashlrai/phantom/commit/c7176ec5f1e0fad97a5eb14750c722e68e805c49))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795195350-N17:** ([#7622](https://github.com/ashlrai/phantom/issues/7622)) ([403c188](https://github.com/ashlrai/phantom/commit/403c188440ee66d8131f88bc93ca78839fce57d3))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795158272-N17:** ([#7544](https://github.com/ashlrai/phantom/issues/7544)) ([44ace36](https://github.com/ashlrai/phantom/commit/44ace36beb2dea22d71e156c875cf8561a3f2fec))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795159502-N17:** ([#7553](https://github.com/ashlrai/phantom/issues/7553)) ([c291165](https://github.com/ashlrai/phantom/commit/c291165f43d2009a7e853d5aae60952327d6cc5a))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795161241-N17:** ([#7560](https://github.com/ashlrai/phantom/issues/7560)) ([61983d4](https://github.com/ashlrai/phantom/commit/61983d40775d7a8853ae40548b7de180ff2f88f7))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795162322-N17:** ([#7564](https://github.com/ashlrai/phantom/issues/7564)) ([b2d0188](https://github.com/ashlrai/phantom/commit/b2d0188ec286bc5021117f0edf692c36e008a128))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795163566-N17:** ([#7567](https://github.com/ashlrai/phantom/issues/7567)) ([0ae65af](https://github.com/ashlrai/phantom/commit/0ae65afbe68e92ed14f8e9a1d59edfb45156f9e1))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795164658-N17:** ([#7574](https://github.com/ashlrai/phantom/issues/7574)) ([8257d78](https://github.com/ashlrai/phantom/commit/8257d782d0b50a01e39bdda24bb56fb045d5eee2))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795165861-N17:** ([#7576](https://github.com/ashlrai/phantom/issues/7576)) ([f28debd](https://github.com/ashlrai/phantom/commit/f28debd454d7301b1dd8efb59d502639790920be))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795166993-N17:** ([#7580](https://github.com/ashlrai/phantom/issues/7580)) ([b8a3e6b](https://github.com/ashlrai/phantom/commit/b8a3e6bf698d1555876320e2e6484dd63c57421d))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795168663-N17:** ([#7585](https://github.com/ashlrai/phantom/issues/7585)) ([61bde77](https://github.com/ashlrai/phantom/commit/61bde772bfdce0758fe665f98c1291ec3ac89bc4))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795170519-N17:** ([#7586](https://github.com/ashlrai/phantom/issues/7586)) ([710a138](https://github.com/ashlrai/phantom/commit/710a138414ab2e0d70bcaf23fbb238e4ba819eb5))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795172736-N17:** ([#7594](https://github.com/ashlrai/phantom/issues/7594)) ([2fdc5b0](https://github.com/ashlrai/phantom/commit/2fdc5b00e3a319bbccf2fbd388d6f70bca70f5c3))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795175348-N17:** ([#7598](https://github.com/ashlrai/phantom/issues/7598)) ([dec1956](https://github.com/ashlrai/phantom/commit/dec19566dad3cf8b2ede0d7450683ae209ea5b02))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795176560-N17:** ([#7599](https://github.com/ashlrai/phantom/issues/7599)) ([d0d302c](https://github.com/ashlrai/phantom/commit/d0d302c86a446d3bc8c450869c2e96d009b53825))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795178524-N17:** ([#7601](https://github.com/ashlrai/phantom/issues/7601)) ([683b933](https://github.com/ashlrai/phantom/commit/683b933c45cc8ef26c4926873d5681a3719b20c3))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795179892-N17:** ([#7604](https://github.com/ashlrai/phantom/issues/7604)) ([c1a89a7](https://github.com/ashlrai/phantom/commit/c1a89a7c4a5f64fc8e9365d268bd19063d43846e))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795181287-N17:** ([#7607](https://github.com/ashlrai/phantom/issues/7607)) ([283c3b6](https://github.com/ashlrai/phantom/commit/283c3b6adb8577eb52ff19d6a683fa2c45576312))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795183736-N17:** ([#7609](https://github.com/ashlrai/phantom/issues/7609)) ([b47e3d0](https://github.com/ashlrai/phantom/commit/b47e3d0c62466836a01062f0d9a65fc5459e6392))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795186887-N17:** ([#7611](https://github.com/ashlrai/phantom/issues/7611)) ([8975c3e](https://github.com/ashlrai/phantom/commit/8975c3ebf13fde2c3ad2be90b9ab752d18fe376f))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795190289-N17:** ([#7615](https://github.com/ashlrai/phantom/issues/7615)) ([7c379dc](https://github.com/ashlrai/phantom/commit/7c379dc439463bda92302092199ba20d67aba1cc))
* RQ-DEVINCLOUD-RQ-DVL-RSI-1795192394-N17 ([#7617](https://github.com/ashlrai/phantom/issues/7617)) ([069bdb8](https://github.com/ashlrai/phantom/commit/069bdb88013c63a9d69ffc8e053552ee4ecac5e8))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795193868-N17:** ([#7618](https://github.com/ashlrai/phantom/issues/7618)) ([9783e1d](https://github.com/ashlrai/phantom/commit/9783e1dd36707c3a736184ff136c30dea50bae9c))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795194623-N17:** ([#7621](https://github.com/ashlrai/phantom/issues/7621)) ([2f4991c](https://github.com/ashlrai/phantom/commit/2f4991c6fb40abb013778ca6fd3ba406845a3630))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795195826-N17:** ([#7623](https://github.com/ashlrai/phantom/issues/7623)) ([2e2aa59](https://github.com/ashlrai/phantom/commit/2e2aa59d449defe566cd77221d916d913c27de87))
* **RQ-GAPCONTRACTN21SQ8:** RQ-GAPCONTRACTN21SQ8 ([#7558](https://github.com/ashlrai/phantom/issues/7558)) ([3d9a590](https://github.com/ashlrai/phantom/commit/3d9a59036343ca4bab60135902dcfa3cce04832d))
* **RQ-GAPHARVESTN21WQ8:** RQ-GAPHARVESTN21WQ8: gap finder reads jobs that opened a PR ([#7581](https://github.com/ashlrai/phantom/issues/7581)) ([87859fd](https://github.com/ashlrai/phantom/commit/87859fdbc22fde105f1f183a54dc91f404d3df03))
* **RQ-GAPREPON21QQ8:** BRIDGE_NOTES — RQ-GAPREPON21QQ8 ([#7540](https://github.com/ashlrai/phantom/issues/7540)) ([f77eb9f](https://github.com/ashlrai/phantom/commit/f77eb9fd5fef6665b54b79564fa5ef169a48d741))
* **RQ-GIFTOPENN21SQ8:** RQ-GIFTOPENN21SQ8 ([#7559](https://github.com/ashlrai/phantom/issues/7559)) ([bf95159](https://github.com/ashlrai/phantom/commit/bf95159f2193640837006088fdc58a2decb631b4))
* **RQ-HELDCHURNN21YQ8:** BRIDGE_NOTES: RQ-HELDCHURNN21YQ8 ([#7596](https://github.com/ashlrai/phantom/issues/7596)) ([c10992c](https://github.com/ashlrai/phantom/commit/c10992c5ef3b3702afc555742325ef52ba774550))
* **RQ-LANECAPSN21YQ8:** RQ-LANECAPSN21YQ8: capability-aware lane routing ([#7590](https://github.com/ashlrai/phantom/issues/7590)) ([c709a37](https://github.com/ashlrai/phantom/commit/c709a37dd5fae0cd02e90af3b40d2e4465469745))
* **RQ-LEADERBRIEFN21QQ8:** RQ-LEADERBRIEFN21QQ8: `phm leader brief` ([#7541](https://github.com/ashlrai/phantom/issues/7541)) ([a7f17dd](https://github.com/ashlrai/phantom/commit/a7f17ddd9d98e294b5470595198b978194572c0b))
* **RQ-LEADERPANELN21SQ8:** RQ-LEADERPANELN21SQ8 — Leader card ([#7562](https://github.com/ashlrai/phantom/issues/7562)) ([51e307f](https://github.com/ashlrai/phantom/commit/51e307fe77b01cca672c7992ef3ce666e967c0db))
* **RQ-LOOPDOCSN21QQ8:** BRIDGE_NOTES.md ([#7545](https://github.com/ashlrai/phantom/issues/7545)) ([490b050](https://github.com/ashlrai/phantom/commit/490b050eefb66846473a44700634bc440d38d2ba))
* **RQ-LOOPRELN21QQ8:** RQ-LOOPRELN21QQ8: loop stages card reads releases ([#7546](https://github.com/ashlrai/phantom/issues/7546)) ([fa7b5c1](https://github.com/ashlrai/phantom/commit/fa7b5c18fa0d3beccc1d04a1d456723cd994512d))
* **RQ-REPLAYPOOLSN21QQ8:** RQ-REPLAYPOOLSN21QQ8: past frames use past pool and lane num ([#7548](https://github.com/ashlrai/phantom/issues/7548)) ([0ddfaae](https://github.com/ashlrai/phantom/commit/0ddfaae4d071e0d61e7c687edd222879a3016fe0))
* **RQ-SUPPLYCARDN21WQ8:** RQ-SUPPLYCARDN21WQ8: Supply card (desktop Command + phone Ho ([#7582](https://github.com/ashlrai/phantom/issues/7582)) ([0b305c9](https://github.com/ashlrai/phantom/commit/0b305c9e6f9c947d8212670f31b16da886f8b922))
* **RQ-SUPPLYDOCTORN21UQ8:** RQ-SUPPLYDOCTORN21UQ8: self-supply doctor ([#7570](https://github.com/ashlrai/phantom/issues/7570)) ([07c5a57](https://github.com/ashlrai/phantom/commit/07c5a57a24297b051a4036c1f2c9bc28ec184cdb))
* **RQ-WTDEPSN21QQ8:** RQ-WTDEPSN21QQ8: bridge worktree self-heal ([#7537](https://github.com/ashlrai/phantom/issues/7537)) ([9c15dbc](https://github.com/ashlrai/phantom/commit/9c15dbcf611b1d17641c23decbb26141b1f84116))
* **RQ-WTDOCTORN21SQ8:** RQ-WTDOCTORN21SQ8: phm doctor worktree reads the source chec ([#7557](https://github.com/ashlrai/phantom/issues/7557)) ([2d5f241](https://github.com/ashlrai/phantom/commit/2d5f24163b1a3b56dab2ca38f284050029d51209))

## [3.30.46] - 2026-11-20


### Fixes

* **dispatchd:** confirm group absence before SIGKILL completion ([#7434](https://github.com/ashlrai/phantom/issues/7434)) ([f4621f5](https://github.com/ashlrai/phantom/commit/f4621f5539b9c0037f1bac330103cf3e5f5180c8))
* **test:** make leader-cloud-311 hermetic against the host memory-fit gate ([#7523](https://github.com/ashlrai/phantom/issues/7523)) ([9f6faec](https://github.com/ashlrai/phantom/commit/9f6faec7f521206805e001a31f4a45ca8b97e54a))
* **tests:** unblock master Fast gate — router memory-fit mock + CODEOWNERS regen ([#7533](https://github.com/ashlrai/phantom/issues/7533)) ([4bc3645](https://github.com/ashlrai/phantom/commit/4bc364591709080babea843673662e9151ac98fc))


### Changes

* **RQ-ASKSSEEDN21OQ8:** BRIDGE_NOTES: RQ-ASKSSEEDN21OQ8 ([#7524](https://github.com/ashlrai/phantom/issues/7524)) ([49a6a54](https://github.com/ashlrai/phantom/commit/49a6a54924eb81bfb359b63257564ec2480ef22f))
* **RQ-CLIDRIFTFIXN21OQ8:** BRIDGE_NOTES: RQ-CLIDRIFTFIXN21OQ8 ([#7520](https://github.com/ashlrai/phantom/issues/7520)) ([5b90cfa](https://github.com/ashlrai/phantom/commit/5b90cfad11f3ff746d062aec424a4d26e387c5ca))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795149739-N17:** ([#7522](https://github.com/ashlrai/phantom/issues/7522)) ([fcf8947](https://github.com/ashlrai/phantom/commit/fcf894735f6ea0b089131ab273773a034b2608ae))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795155966-N17:** ([#7530](https://github.com/ashlrai/phantom/issues/7530)) ([680bc71](https://github.com/ashlrai/phantom/commit/680bc71eaaa3bcb4e66d37eb7707aaf284ed74f0))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795149619-N17:** ([#7527](https://github.com/ashlrai/phantom/issues/7527)) ([47726c8](https://github.com/ashlrai/phantom/commit/47726c8832e1c313ebab06f0e76c410733228e43))
* **RQ-GAPTICKN21OQ8:** RQ-GAPTICKN21OQ8: close the self-supply loop ([#7521](https://github.com/ashlrai/phantom/issues/7521)) ([f4200ee](https://github.com/ashlrai/phantom/commit/f4200ee3eb52ec52df7c0f618d888b28ba6c3873))
* **RQ-LEVERAGEN21MQ8:** RQ-LEVERAGEN21MQ8: merge leverage classes ([#7510](https://github.com/ashlrai/phantom/issues/7510)) ([324b037](https://github.com/ashlrai/phantom/commit/324b037e0d46676e255a532a1932dd388af30225))
* **RQ-LOOPSTAGESN21OQ8:** RQ-LOOPSTAGESN21OQ8: where the loop waits ([#7529](https://github.com/ashlrai/phantom/issues/7529)) ([ff47567](https://github.com/ashlrai/phantom/commit/ff47567ccec944927a664ea4bda2635dd58f828f))
* **RQ-MAPREPLAYN21OQ8:** RQ-MAPREPLAYN21OQ8: replay the fleet on the map ([#7531](https://github.com/ashlrai/phantom/issues/7531)) ([24f45a8](https://github.com/ashlrai/phantom/commit/24f45a86f95318c715dfa866c33a6881b653a54e))
* **RQ-PHX-RECORDEDSCHEDULECLI684S:** BRIDGE_NOTES: RQ-PHX-RECORDEDSCHEDULECLI684S ([#7517](https://github.com/ashlrai/phantom/issues/7517)) ([3a01a9d](https://github.com/ashlrai/phantom/commit/3a01a9df7a753ab87defbd4e77fe59c5296ed0c0))
* **RQ-PHX-RECORDEDSLOTPROJECT683S:** BRIDGE_NOTES: RQ-PHX-RECORDEDSLOTPROJECT683S ([#7516](https://github.com/ashlrai/phantom/issues/7516)) ([29b31d0](https://github.com/ashlrai/phantom/commit/29b31d0ad5efe92471d93ef78fb880a299bb0de0))
* **RQ-PHX-REDTESTFIXC685:** RQ-PHX-REDTESTFIXC685 — REDTESTFIX recut of [#7391](https://github.com/ashlrai/phantom/issues/7391) ([#7519](https://github.com/ashlrai/phantom/issues/7519)) ([4a22fd8](https://github.com/ashlrai/phantom/commit/4a22fd8dd9a08bbf153c2280f7b94569adeb19e5))
* **RQ-READMEVERBSN21MQ8:** RQ-READMEVERBSN21MQ8 ([#7512](https://github.com/ashlrai/phantom/issues/7512)) ([77268f2](https://github.com/ashlrai/phantom/commit/77268f2f53f7dcabc0fa99c0db3c333a08a50fd0))
* **RQ-RELCARDN21MQ8:** RQ-RELCARDN21MQ8: release cards ([#7511](https://github.com/ashlrai/phantom/issues/7511)) ([f41ec0b](https://github.com/ashlrai/phantom/commit/f41ec0bff5bde7aea10bb29cd6656cecca7f6019))
* **RQ-SHIPREPON21IQ8:** ([#7528](https://github.com/ashlrai/phantom/issues/7528)) ([717422c](https://github.com/ashlrai/phantom/commit/717422cfba4a9fe92babb15d76b4762a9c7bd361))
* **RQ-TEAMJOINN21MQ8:** RQ-TEAMJOINN21MQ8: bring co-founders on ([#7513](https://github.com/ashlrai/phantom/issues/7513)) ([9740aa4](https://github.com/ashlrai/phantom/commit/9740aa486ed89c0443a44e8515dd31cd4efbb73b))
* **RQ-WTCHECKN21OQ8:** BRIDGE_NOTES: RQ-WTCHECKN21OQ8 ([#7526](https://github.com/ashlrai/phantom/issues/7526)) ([1574862](https://github.com/ashlrai/phantom/commit/15748626548cb7ed81d088c5e7988cd43010849c))

## [3.30.45] - 2026-11-20


### Changes

* **FIXUP-CI-phantom-ci-576447:** FIXUP-CI-phantom-ci-576447 ([#7502](https://github.com/ashlrai/phantom/issues/7502)) ([2e7a2fd](https://github.com/ashlrai/phantom/commit/2e7a2fd3fc0baa53cb89d48ad48b679cf7df4b97))
* **RQ-CONTEXTPACKN21IQ8:** BRIDGE_NOTES: RQ-CONTEXTPACKN21IQ8 ([#7484](https://github.com/ashlrai/phantom/issues/7484)) ([735565f](https://github.com/ashlrai/phantom/commit/735565fa1f122c29cd6b5a5761e4b65488daf91b))
* **RQ-EMPTYGATEN21KQ8:** BRIDGE_NOTES: RQ-EMPTYGATEN21KQ8 ([#7493](https://github.com/ashlrai/phantom/issues/7493)) ([afc52cf](https://github.com/ashlrai/phantom/commit/afc52cf8fbf963c2622fd6557ae2f0dbad1d0bdc))
* **RQ-EMPTYWHYN21IQ8:** BRIDGE_NOTES: RQ-EMPTYWHYN21IQ8 ([#7478](https://github.com/ashlrai/phantom/issues/7478)) ([ac0e0c5](https://github.com/ashlrai/phantom/commit/ac0e0c56fbf6263846ba13460580bd98f32b7f84))
* **RQ-FEEDBETSN21IQ8:** BRIDGE_NOTES: RQ-FEEDBETSN21IQ8 ([#7486](https://github.com/ashlrai/phantom/issues/7486)) ([05ab3aa](https://github.com/ashlrai/phantom/commit/05ab3aa48b45c1d1fa2ef06272a7ad2a48ecf091))
* **RQ-FLEETDRIFTN21KQ8:** BRIDGE_NOTES: RQ-FLEETDRIFTN21KQ8 ([#7495](https://github.com/ashlrai/phantom/issues/7495)) ([152b953](https://github.com/ashlrai/phantom/commit/152b953fb6a71abe0b327b00b937771bb673f140))
* **RQ-JOBACTIONSN21IQ8:** BRIDGE_NOTES: RQ-JOBACTIONSN21IQ8 ([#7482](https://github.com/ashlrai/phantom/issues/7482)) ([68f03a5](https://github.com/ashlrai/phantom/commit/68f03a54096eae35b9c79b27918a692896eb061f))
* **RQ-JOBSAYN21KQ8:** BRIDGE_NOTES: RQ-JOBSAYN21KQ8 ([#7500](https://github.com/ashlrai/phantom/issues/7500)) ([539eacd](https://github.com/ashlrai/phantom/commit/539eacd57861544bebb09cb14e71f6cfef313861))
* **RQ-MERGELATN21IQ8:** BRIDGE_NOTES: RQ-MERGELATN21IQ8 ([#7489](https://github.com/ashlrai/phantom/issues/7489)) ([23dff2d](https://github.com/ashlrai/phantom/commit/23dff2d200fa05bf1cb556a197f7d66811ba6d27))
* **RQ-NODEPOOLN21IQ8:** BRIDGE_NOTES: RQ-NODEPOOLN21IQ8 ([#7487](https://github.com/ashlrai/phantom/issues/7487)) ([38d25a6](https://github.com/ashlrai/phantom/commit/38d25a6588d293239acc6f25091e674200660046))
* **RQ-PHX-PLANFORMATRECOVER681S:** BRIDGE_NOTES: RQ-PHX-PLANFORMATRECOVER681S ([#7501](https://github.com/ashlrai/phantom/issues/7501)) ([8c182ac](https://github.com/ashlrai/phantom/commit/8c182acb46e12cd7549b5c5483c56cb913556424))
* **RQ-PHX-RECORDEDAVAILRECOVER678S:** BRIDGE_NOTES: RQ-PHX-RECORDEDAVAILRECOVER678S ([#7490](https://github.com/ashlrai/phantom/issues/7490)) ([fe2a9af](https://github.com/ashlrai/phantom/commit/fe2a9aff9e6e8e6f1908d2d4f9c6350416a39a71))
* **RQ-PHX-RECORDEDISSUECLASS679S:** BRIDGE_NOTES: RQ-PHX-RECORDEDISSUECLASS679S ([#7491](https://github.com/ashlrai/phantom/issues/7491)) ([1c92d17](https://github.com/ashlrai/phantom/commit/1c92d177037ec47a3f4d1f2df1fd16a9cab7c911))
* **RQ-PHX-RECORDEDLOGINRECOVER677S:** BRIDGE_NOTES: RQ-PHX-RECORDEDLOGINRECOVER677S ([#7488](https://github.com/ashlrai/phantom/issues/7488)) ([71f91a9](https://github.com/ashlrai/phantom/commit/71f91a9bc146327ad87c682f759b2bec1274632c))
* **RQ-TOKENCAPTN21KQ8:** RQ-TOKENCAPTN21KQ8 ([#7498](https://github.com/ashlrai/phantom/issues/7498)) ([272cce0](https://github.com/ashlrai/phantom/commit/272cce03f7ab1c499c58ab6a8d11369e2611092a))
* **RQ-WASTEALERTN21IQ8:** BRIDGE_NOTES: RQ-WASTEALERTN21IQ8 ([#7481](https://github.com/ashlrai/phantom/issues/7481)) ([fbe2650](https://github.com/ashlrai/phantom/commit/fbe265057c076290dc11b733ec5023769de087fe))
* **RQ-WEBSHIPN21IQ8:** RQ-WEBSHIPN21IQ8 ([#7485](https://github.com/ashlrai/phantom/issues/7485)) ([e1b6428](https://github.com/ashlrai/phantom/commit/e1b64284c7d905d33716c4ec9fc86a3d481b3a36))
* **RQ-ZAIYIELDN21IQ8:** RQ-ZAIYIELDN21IQ8: lane yield weight ([#7479](https://github.com/ashlrai/phantom/issues/7479)) ([c1b9a97](https://github.com/ashlrai/phantom/commit/c1b9a97382c0c9c97ef47032da3ebb7678fb659d))

## [3.30.44] - 2026-11-20


### Changes

* **RQ-MAPFILTERR3N21GQ8:** RQ-MAPFILTERR3N21GQ8 ([#7461](https://github.com/ashlrai/phantom/issues/7461)) ([e410168](https://github.com/ashlrai/phantom/commit/e4101682a130e1aa5b88d062e44129ec346162e1))
* **RQ-MERGEWAITN21HQ8:** BRIDGE_NOTES: RQ-MERGEWAITN21HQ8 ([#7466](https://github.com/ashlrai/phantom/issues/7466)) ([1780666](https://github.com/ashlrai/phantom/commit/178066652e1d14bee2bc2bbdb64424a9b5ad3891))
* **RQ-NODEOFFLOADN21GQ8:** BRIDGE_NOTES: RQ-NODEOFFLOADN21GQ8 ([#7468](https://github.com/ashlrai/phantom/issues/7468)) ([05f3658](https://github.com/ashlrai/phantom/commit/05f365847b14a67d59d6986ea6d0205a96ee0b79))
* **RQ-PHX-RECORDEDCONFIGRECOVER673S:** RQ-PHX-RECORDEDCONFIGRECOVER673S: recorded scheduler-config ([#7460](https://github.com/ashlrai/phantom/issues/7460)) ([9fd0974](https://github.com/ashlrai/phantom/commit/9fd097402db31d72d4bc2b64123c448324dd903f))
* **RQ-STRANDEDN21GQ8:** BRIDGE_NOTES: RQ-STRANDEDN21GQ8 ([#7462](https://github.com/ashlrai/phantom/issues/7462)) ([c615631](https://github.com/ashlrai/phantom/commit/c615631fae6e11ebfed60a61b1a780eb767eb713))
* **RQ-SUPPLYLOWN21GQ8:** RQ-SUPPLYLOWN21GQ8: `phm queue supply` and the `supply_low` ([#7464](https://github.com/ashlrai/phantom/issues/7464)) ([aa3d736](https://github.com/ashlrai/phantom/commit/aa3d736f421619ef19bbc095709f2cbe7404ac95))
* **RQ-SWAPWHYN21GQ8:** BRIDGE_NOTES: RQ-SWAPWHYN21GQ8 ([#7465](https://github.com/ashlrai/phantom/issues/7465)) ([521eff5](https://github.com/ashlrai/phantom/commit/521eff5ee65d1f84d231a0d292fd8cf49c6f74a8))
* **RQ-TOKENCOSTN21GQ8:** RQ-TOKENCOSTN21GQ8: `phm jobs cost` ([#7469](https://github.com/ashlrai/phantom/issues/7469)) ([4ec92a6](https://github.com/ashlrai/phantom/commit/4ec92a6da6767f3fef197305a0920b2ef5dcde33))

## [3.30.43] - 2026-11-20


### Changes

* **RQ-AUTOFILLIDEASN21AQ8:** RQ-AUTOFILLIDEASN21AQ8 — autofill takes Ideas first ([#7426](https://github.com/ashlrai/phantom/issues/7426)) ([1625e65](https://github.com/ashlrai/phantom/commit/1625e653f72ae122553749ac88d4b70fc875971b))
* **RQ-CL-DOCS-1795136383:** ([#7440](https://github.com/ashlrai/phantom/issues/7440)) ([9649dc4](https://github.com/ashlrai/phantom/commit/9649dc484c23e408790795527074399ae95dbca9))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795106146-N17:** ([#7430](https://github.com/ashlrai/phantom/issues/7430)) ([67fefa5](https://github.com/ashlrai/phantom/commit/67fefa53a0e191b8a18a83003c02b271cc613cba))
* **RQ-DISKBURNN21EQ8:** RQ-DISKBURNN21EQ8: `phm host disk` ([#7444](https://github.com/ashlrai/phantom/issues/7444)) ([107c0be](https://github.com/ashlrai/phantom/commit/107c0bec0f637411cfb3f764409faa928bdb25ad))
* **RQ-DVL-BUS-1795106618:** ([#7427](https://github.com/ashlrai/phantom/issues/7427)) ([f75116c](https://github.com/ashlrai/phantom/commit/f75116c21b08ba76060363c11f5b10ede8dbc885))
* **RQ-DVL-RSI-1795108320:** ([#7431](https://github.com/ashlrai/phantom/issues/7431)) ([2bc4b2a](https://github.com/ashlrai/phantom/commit/2bc4b2ac020a0ccaffba749beae9fea300f802ea))
* **RQ-GOALSV4N21AQ8:** BRIDGE_NOTES: RQ-GOALSV4N21AQ8 ([#7442](https://github.com/ashlrai/phantom/issues/7442)) ([118be53](https://github.com/ashlrai/phantom/commit/118be5398399d352a018dd202253f9c31fd397d3))
* **RQ-LOADBLAMEN21AQ8:** RQ-LOADBLAMEN21AQ8 ([#7425](https://github.com/ashlrai/phantom/issues/7425)) ([cd44d35](https://github.com/ashlrai/phantom/commit/cd44d3507360aebbf542b4b5c993f3f4b2ce0e02))
* **RQ-PHX-RECORDEDDECISION665S:** RQ-PHX-RECORDEDDECISION665S: recorded decision-row projectio ([#7428](https://github.com/ashlrai/phantom/issues/7428)) ([551e92f](https://github.com/ashlrai/phantom/commit/551e92f50a1b6c2ba206c03482c246f732e96047))
* **RQ-PHX-RECORDEDHOSTRECOVER666S:** BRIDGE_NOTES: RQ-PHX-RECORDEDHOSTRECOVER666S ([#7432](https://github.com/ashlrai/phantom/issues/7432)) ([2644b8b](https://github.com/ashlrai/phantom/commit/2644b8be6b21258d6d117b4f237d3791337feec8))
* **RQ-PHX-RECORDEDPOOLRECOVER668S:** RQ-PHX-RECORDEDPOOLRECOVER668S: recorded pool availability ([#7445](https://github.com/ashlrai/phantom/issues/7445)) ([a8296d8](https://github.com/ashlrai/phantom/commit/a8296d85ee27f01ad1a978ae1cbd521ee550a65a))
* **RQ-SLEEPGAPN21CQ8:** RQ-SLEEPGAPN21CQ8: sleep gaps, keep-awake, digest line ([#7436](https://github.com/ashlrai/phantom/issues/7436)) ([545b0ae](https://github.com/ashlrai/phantom/commit/545b0aeb97c83bb7eccb5ebfa06b760d0e56e511))
* **RQ-WTREAPTICKN21AQ8:** BRIDGE_NOTES: RQ-WTREAPTICKN21AQ8 ([#7435](https://github.com/ashlrai/phantom/issues/7435)) ([1bcc131](https://github.com/ashlrai/phantom/commit/1bcc13121a6717fe2fce9a74d69bc118eba33c9c))

## [3.30.42] - 2026-11-19


### Changes

* **RQ-AUTOFILLTICKN20YQ8:** RQ-AUTOFILLTICKN20YQ8: autofill runs inside self-tick ([#7406](https://github.com/ashlrai/phantom/issues/7406)) ([c2034b3](https://github.com/ashlrai/phantom/commit/c2034b349f717387bc67afe14fce382c0a17fc41))
* **RQ-CL-DOCS-1795101739:** ([#7394](https://github.com/ashlrai/phantom/issues/7394)) ([41d8b21](https://github.com/ashlrai/phantom/commit/41d8b21daf4ecf9dd653f8b0eb81f39b99b6b17b))
* **RQ-CL-DOCS-1795105644:** ([#7414](https://github.com/ashlrai/phantom/issues/7414)) ([c818801](https://github.com/ashlrai/phantom/commit/c818801df9c19485bfe94691718995286980fe9f))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795099848-N17:** ([#7402](https://github.com/ashlrai/phantom/issues/7402)) ([c589f4f](https://github.com/ashlrai/phantom/commit/c589f4fb3535e1c28adaf64625dab017f9c7e6cf))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795100971-N17:** ([#7400](https://github.com/ashlrai/phantom/issues/7400)) ([2a6df29](https://github.com/ashlrai/phantom/commit/2a6df29312f200cc23137596954527450a439e04))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795100068-N17:** ([#7403](https://github.com/ashlrai/phantom/issues/7403)) ([7d47faf](https://github.com/ashlrai/phantom/commit/7d47fafde495bf3c8bf7c4b614526a8adc8937d7))
* **RQ-DVL-BUS-1795101918:** ([#7401](https://github.com/ashlrai/phantom/issues/7401)) ([ccbaec1](https://github.com/ashlrai/phantom/commit/ccbaec17136e689294233f8c909564c68c3ce5a8))
* **RQ-DVL-BUS-1795102832:** ([#7407](https://github.com/ashlrai/phantom/issues/7407)) ([82fcc21](https://github.com/ashlrai/phantom/commit/82fcc21b661f927edea1a83ed7c102cf467b3909))
* **RQ-DVL-RSI-1795099722:** ([#7398](https://github.com/ashlrai/phantom/issues/7398)) ([ec04479](https://github.com/ashlrai/phantom/commit/ec04479c289765237c6a77cf1a352b832151d7e3))
* **RQ-EMPTYFAMILYN20YQ8:** RQ-EMPTYFAMILYN20YQ8: `phm jobs empty --by-family` ([#7408](https://github.com/ashlrai/phantom/issues/7408)) ([38081ef](https://github.com/ashlrai/phantom/commit/38081ef5033adcd205ac93db4d991ba27e9476fe))
* **RQ-NEEDSYOUN20YQ8:** RQ-NEEDSYOUN20YQ8 ([#7409](https://github.com/ashlrai/phantom/issues/7409)) ([a8ce268](https://github.com/ashlrai/phantom/commit/a8ce26848804d6af35ecbf70795a5fd7bccea665))
* **RQ-PHX-DEADLINEEVIDENCERECOVER661S:** RQ-PHX-DEADLINEEVIDENCERECOVER661S — notes ([#7396](https://github.com/ashlrai/phantom/issues/7396)) ([746244b](https://github.com/ashlrai/phantom/commit/746244b96bb2deefd159d580d38e5fce971e5a04))
* **RQ-PHX-RECORDEDCOEFFICIENT663S:** RQ-PHX-RECORDEDCOEFFICIENT663S bridge notes ([#7415](https://github.com/ashlrai/phantom/issues/7415)) ([01869ae](https://github.com/ashlrai/phantom/commit/01869ae4867daba1706a0e92a2b77c43624b35bf))
* **RQ-PHX-RECORDEDRUNWAYRECOVER662S:** BRIDGE_NOTES: RQ-PHX-RECORDEDRUNWAYRECOVER662S ([#7413](https://github.com/ashlrai/phantom/issues/7413)) ([c2351a1](https://github.com/ashlrai/phantom/commit/c2351a110e2913e0e08d0b7d9c2b80fcb51c0faa))
* **RQ-PHX-RECORDEDWINDOWRECOVER660S:** RQ-PHX-RECORDEDWINDOWRECOVER660S ([#7392](https://github.com/ashlrai/phantom/issues/7392)) ([c5eef65](https://github.com/ashlrai/phantom/commit/c5eef65e49e90b42134d9dcd21449e7970305905))
* **RQ-QUEUESUPPLYQ8:** RQ-QUEUESUPPLYQ8 ([#7395](https://github.com/ashlrai/phantom/issues/7395)) ([e918a73](https://github.com/ashlrai/phantom/commit/e918a73321a334f0c4126d5474be35d062c0f726))
* **RQ-RELCADENCEN20YQ8:** RQ-RELCADENCEN20YQ8: `phm release cadence` ([#7410](https://github.com/ashlrai/phantom/issues/7410)) ([00a01e0](https://github.com/ashlrai/phantom/commit/00a01e0fdf19c5c3087e9de622c4ce34d12a8056))
* **RQ-TOKENMEASUREN20YQ8:** RQ-TOKENMEASUREN20YQ8 ([#7412](https://github.com/ashlrai/phantom/issues/7412)) ([b2fbb23](https://github.com/ashlrai/phantom/commit/b2fbb2319b2a39356df8d1a243013b6ca0418fc7))


### Tests

* **fleet-mains:** expect emptyAttempts/retryHold in guardian JSON ([#7411](https://github.com/ashlrai/phantom/issues/7411)) ([bff6429](https://github.com/ashlrai/phantom/commit/bff6429a7636f6e9e6567ef54ecb9dfaebcccf21))

## [3.30.41] - 2026-11-19


### Changes

* **FIXUP-CI-phantom-unrelated-pr-recover-589097:** FIXUP-CI-phantom-unrelated-pr-recover-589097 ([#7258](https://github.com/ashlrai/phantom/issues/7258)) ([1dab8b2](https://github.com/ashlrai/phantom/commit/1dab8b222bcb33824f155a95fd1e76f16fbbf394))
* **RQ-ASKSN20MQ8:** BRIDGE_NOTES: RQ-ASKSN20MQ8 ([#7293](https://github.com/ashlrai/phantom/issues/7293)) ([5993ade](https://github.com/ashlrai/phantom/commit/5993adef30155e2b679470d720fa69fc10f45f9d))
* **RQ-BETCHECKN20GQ8:** RQ-BETCHECKN20GQ8: `phm bets check` ([#7250](https://github.com/ashlrai/phantom/issues/7250)) ([5ba6598](https://github.com/ashlrai/phantom/commit/5ba6598ec6ec85f381688bf599e7fcf1e32228f9))
* **RQ-BETGATEN20MQ8:** BRIDGE_NOTES: RQ-BETGATEN20MQ8 ([#7285](https://github.com/ashlrai/phantom/issues/7285)) ([0059d28](https://github.com/ashlrai/phantom/commit/0059d28f2bf4ed6ac50d1229617a41a6499d19d9))
* **RQ-BETPROPOSER2N20QQ8:** RQ-BETPROPOSER2N20QQ8 (recovery of RQ-BETPROPOSEN20OQ8) ([#7325](https://github.com/ashlrai/phantom/issues/7325)) ([139ed0b](https://github.com/ashlrai/phantom/commit/139ed0b7153fc24b412e44530a8b98582599e08d))
* **RQ-CL-DESK2-1795076306:** ([#7252](https://github.com/ashlrai/phantom/issues/7252)) ([3d9714c](https://github.com/ashlrai/phantom/commit/3d9714c4a6c82caea81cfd3c52bfc4601ff8e949))
* **RQ-CL-DOCS-1795082034:** ([#7279](https://github.com/ashlrai/phantom/issues/7279)) ([591a7ae](https://github.com/ashlrai/phantom/commit/591a7ae4d3fe9f064afd30d4c57048336cba6275))
* **RQ-CL-DOCS-1795092105:** ([#7342](https://github.com/ashlrai/phantom/issues/7342)) ([2c57e60](https://github.com/ashlrai/phantom/commit/2c57e60cb89429f2f40fdc2952b885dba23fa5b0))
* **RQ-CL-DOCS-1795093948:** ([#7357](https://github.com/ashlrai/phantom/issues/7357)) ([eba807f](https://github.com/ashlrai/phantom/commit/eba807f08ba4fca2407b8ca6a41a6d797b8072c0))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795076704-N17:** ([#7256](https://github.com/ashlrai/phantom/issues/7256)) ([36159ac](https://github.com/ashlrai/phantom/commit/36159ac0f7546df8e6ca55f7d4359dce75035236))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795078353-N17:** ([#7262](https://github.com/ashlrai/phantom/issues/7262)) ([980bc1f](https://github.com/ashlrai/phantom/commit/980bc1f7f0a5a0397afa6da37b1484b868e89e17))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795079210-N17:** ([#7275](https://github.com/ashlrai/phantom/issues/7275)) ([96a189f](https://github.com/ashlrai/phantom/commit/96a189f6b301c8e7692ab9392cd8e6dda532087d))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795082955-N17:** ([#7302](https://github.com/ashlrai/phantom/issues/7302)) ([7fe5f68](https://github.com/ashlrai/phantom/commit/7fe5f68747d9ccf5ba8f61cd42b810ec6a7f2ac0))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795086048-N17:** ([#7318](https://github.com/ashlrai/phantom/issues/7318)) ([62490a9](https://github.com/ashlrai/phantom/commit/62490a9ad28779f98c497decbeaca7ebcb2ce4ae))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795089744-N17:** ([#7337](https://github.com/ashlrai/phantom/issues/7337)) ([cfaee3a](https://github.com/ashlrai/phantom/commit/cfaee3ae97131c3dfe1fcc1f9667819d1bf9a3a3))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795091313-N17:** ([#7343](https://github.com/ashlrai/phantom/issues/7343)) ([9be697d](https://github.com/ashlrai/phantom/commit/9be697d71a516340f5372165e835228f968a386f))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795092394-N17:** ([#7359](https://github.com/ashlrai/phantom/issues/7359)) ([9e3a742](https://github.com/ashlrai/phantom/commit/9e3a7423a8a8299eaf5ad31743b17130589f85f3))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795074728-N17:** ([#7245](https://github.com/ashlrai/phantom/issues/7245)) ([a1b8414](https://github.com/ashlrai/phantom/commit/a1b841468370fe92216277c67f5e0767bb309f43))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795076967-N17:** ([#7259](https://github.com/ashlrai/phantom/issues/7259)) ([eb55b77](https://github.com/ashlrai/phantom/commit/eb55b77ade35a273d2645dcc5142e3e7a310e82e))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795078849-N17:** ([#7268](https://github.com/ashlrai/phantom/issues/7268)) ([e6096b9](https://github.com/ashlrai/phantom/commit/e6096b95769d530cb6dd39e9999f4730c678cce1))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795079907-N17:** ([#7282](https://github.com/ashlrai/phantom/issues/7282)) ([63da77a](https://github.com/ashlrai/phantom/commit/63da77a92ae0fc778d7fe06ae762e784f58d7ffb))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795083293-N17:** ([#7290](https://github.com/ashlrai/phantom/issues/7290)) ([3181139](https://github.com/ashlrai/phantom/commit/31811390b1f72edc68a969ee5f866a48fd095e8d))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795084305-N17:** ([#7295](https://github.com/ashlrai/phantom/issues/7295)) ([382ed6f](https://github.com/ashlrai/phantom/commit/382ed6f5a9216067797c1b5741abf83cc29f1e60))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795085354-N17:** ([#7305](https://github.com/ashlrai/phantom/issues/7305)) ([efc9e8b](https://github.com/ashlrai/phantom/commit/efc9e8b98d0f166c302e842aebe89f3dd4ea2f6a))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795086594-N17:** ([#7317](https://github.com/ashlrai/phantom/issues/7317)) ([2b9939f](https://github.com/ashlrai/phantom/commit/2b9939fb0ae6c594d6360192b4d3c29e18838932))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795088539-N17:** ([#7324](https://github.com/ashlrai/phantom/issues/7324)) ([4ca43b7](https://github.com/ashlrai/phantom/commit/4ca43b710cb47bd5460abb5cd1b0c350d227c1c5))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795090197-N17:** ([#7340](https://github.com/ashlrai/phantom/issues/7340)) ([c803600](https://github.com/ashlrai/phantom/commit/c8036003014c5312f05d7bb78ba0720ec45d3ec3))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795091886-N17:** ([#7350](https://github.com/ashlrai/phantom/issues/7350)) ([87d54e1](https://github.com/ashlrai/phantom/commit/87d54e14064bd7e559487b68e127fc470fa48adb))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795093517-N17:** ([#7368](https://github.com/ashlrai/phantom/issues/7368)) ([49bd17f](https://github.com/ashlrai/phantom/commit/49bd17fccbb57f1df4039ba683b74fa3e74a828d))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795096872-N17:** ([#7372](https://github.com/ashlrai/phantom/issues/7372)) ([78a74a0](https://github.com/ashlrai/phantom/commit/78a74a0be020d77c3972d303629762dcc8d07c2e))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795077744-N17:** ([#7266](https://github.com/ashlrai/phantom/issues/7266)) ([9e6611a](https://github.com/ashlrai/phantom/commit/9e6611aca7bccd5aa2dff0d53e74110ca268d9f4))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795082316-N17:** ([#7286](https://github.com/ashlrai/phantom/issues/7286)) ([18e9dc1](https://github.com/ashlrai/phantom/commit/18e9dc13f872bbf8f95a6cfac64117515b8af7cf))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795083865-N17:** ([#7300](https://github.com/ashlrai/phantom/issues/7300)) ([2635420](https://github.com/ashlrai/phantom/commit/2635420ec46aca92511a7547510c0651f5997845))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795085960-N17:** ([#7314](https://github.com/ashlrai/phantom/issues/7314)) ([08721e8](https://github.com/ashlrai/phantom/commit/08721e821ca5c0a8c6da1294e27add40140b0fd4))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795087927-N17:** ([#7322](https://github.com/ashlrai/phantom/issues/7322)) ([8a9178d](https://github.com/ashlrai/phantom/commit/8a9178d07b794a461fd45b9af2bc7d0e9afef0cb))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795090342-N17:** ([#7347](https://github.com/ashlrai/phantom/issues/7347)) ([0ffe782](https://github.com/ashlrai/phantom/commit/0ffe7825eefb2ac61a29f047c2bbc4a545bf2a42))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795092906-N17:** ([#7361](https://github.com/ashlrai/phantom/issues/7361)) ([387c139](https://github.com/ashlrai/phantom/commit/387c1391f8cc964097f1100db69250ad645098dd))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795095298-N17:** ([#7367](https://github.com/ashlrai/phantom/issues/7367)) ([650afaa](https://github.com/ashlrai/phantom/commit/650afaae48afc9d51f28590944f08d93d5e8aa1e))
* **RQ-DVL-BUS-1795077005:** ([#7254](https://github.com/ashlrai/phantom/issues/7254)) ([68ebe08](https://github.com/ashlrai/phantom/commit/68ebe08f4541610b887481b05d477e77c51bc1f8))
* **RQ-DVL-BUS-1795077941:** ([#7264](https://github.com/ashlrai/phantom/issues/7264)) ([5569ecf](https://github.com/ashlrai/phantom/commit/5569ecf78897ab16214586bb10e9f5aa7d564a56))
* **RQ-DVL-BUS-1795079518:** ([#7273](https://github.com/ashlrai/phantom/issues/7273)) ([466bfab](https://github.com/ashlrai/phantom/commit/466bfabb23c9a802ee56cc7fd7fcf75029d33830))
* **RQ-DVL-BUS-1795080364:** ([#7278](https://github.com/ashlrai/phantom/issues/7278)) ([528f178](https://github.com/ashlrai/phantom/commit/528f178c2db09b4b83b5f2573b81563f700e0df5))
* **RQ-DVL-BUS-1795082201:** ([#7288](https://github.com/ashlrai/phantom/issues/7288)) ([ac08c94](https://github.com/ashlrai/phantom/commit/ac08c9409770b6fd64fced12ee5dd9bedbaaf40e))
* **RQ-DVL-BUS-1795084004:** ([#7303](https://github.com/ashlrai/phantom/issues/7303)) ([ecd51c4](https://github.com/ashlrai/phantom/commit/ecd51c4972e6ca8cc0732dfc9b051014596c6b05))
* **RQ-DVL-BUS-1795086130:** ([#7308](https://github.com/ashlrai/phantom/issues/7308)) ([d6dc694](https://github.com/ashlrai/phantom/commit/d6dc69438577f8123463649fd655c2544984aff1))
* **RQ-DVL-BUS-1795086885:** ([#7316](https://github.com/ashlrai/phantom/issues/7316)) ([67fe3bb](https://github.com/ashlrai/phantom/commit/67fe3bbcb00be616673336438e8ebb1a1624ac3d))
* **RQ-DVL-BUS-1795089414:** ([#7358](https://github.com/ashlrai/phantom/issues/7358)) ([436e5f5](https://github.com/ashlrai/phantom/commit/436e5f5aa87a325f58afb99f850f915bcf8b5445))
* **RQ-DVL-FLEET-1795073906:** ([#7246](https://github.com/ashlrai/phantom/issues/7246)) ([cea6603](https://github.com/ashlrai/phantom/commit/cea660333a25814ce0d3cf292911f10543eaec25))
* **RQ-DVL-FLEET-1795076998:** ([#7257](https://github.com/ashlrai/phantom/issues/7257)) ([91d3db8](https://github.com/ashlrai/phantom/commit/91d3db89d94a15a4f4efb5cb3b93d4a2a393f105))
* **RQ-DVL-FLEET-1795080362:** ([#7299](https://github.com/ashlrai/phantom/issues/7299)) ([dce5eb7](https://github.com/ashlrai/phantom/commit/dce5eb7751d579f8fa8a8dfdd2f3aace02abd849))
* **RQ-DVL-FLEET-1795085945:** ([#7320](https://github.com/ashlrai/phantom/issues/7320)) ([e24b7b2](https://github.com/ashlrai/phantom/commit/e24b7b22b6a09c49170a3b4dd4245c3e49267053))
* **RQ-DVL-FLEET-1795088751:** ([#7331](https://github.com/ashlrai/phantom/issues/7331)) ([625ae29](https://github.com/ashlrai/phantom/commit/625ae295573f2d95fb71a12fade9ed1a16ee512f))
* **RQ-DVL-FLEET-1795090449:** ([#7341](https://github.com/ashlrai/phantom/issues/7341)) ([26067ad](https://github.com/ashlrai/phantom/commit/26067ad94ccff9f7cdd9fd754f420b2f970bbfa9))
* **RQ-DVL-FLEET-1795095082:** ([#7366](https://github.com/ashlrai/phantom/issues/7366)) ([ac7ab02](https://github.com/ashlrai/phantom/commit/ac7ab02497006083fc0818eaf872cdaa3715414d))
* **RQ-DVL-RSI-1795078554:** ([#7277](https://github.com/ashlrai/phantom/issues/7277)) ([7f0bb14](https://github.com/ashlrai/phantom/commit/7f0bb14f3a080fc22f598dd29194b79302f6b2e2))
* **RQ-DVL-RSI-1795082188:** ([#7291](https://github.com/ashlrai/phantom/issues/7291)) ([2076272](https://github.com/ashlrai/phantom/commit/2076272fba4c7507d5d9e73c2c85819646f842db))
* **RQ-DVL-RSI-1795084268:** ([#7296](https://github.com/ashlrai/phantom/issues/7296)) ([91cfa39](https://github.com/ashlrai/phantom/commit/91cfa39aad46cea4a84c86a022f5185878ed7903))
* **RQ-DVL-RSI-1795085345:** ([#7301](https://github.com/ashlrai/phantom/issues/7301)) ([b4f776e](https://github.com/ashlrai/phantom/commit/b4f776e849ea7cac7dd053eaa585f984b1fb7f7d))
* **RQ-DVL-RSI-1795086018:** ([#7313](https://github.com/ashlrai/phantom/issues/7313)) ([de55680](https://github.com/ashlrai/phantom/commit/de55680b769616d96d96aa75c69020053d1c27a3))
* **RQ-DVL-RSI-1795088833:** ([#7326](https://github.com/ashlrai/phantom/issues/7326)) ([501215d](https://github.com/ashlrai/phantom/commit/501215d621b2b24e3574300806317c3ec1c7c34d))
* **RQ-DVL-RSI-1795091482:** ([#7344](https://github.com/ashlrai/phantom/issues/7344)) ([5cc681c](https://github.com/ashlrai/phantom/commit/5cc681c09e4a1324f1ce02a0fbdcb87876ff4881))
* **RQ-DVL-RSI-1795092437:** ([#7352](https://github.com/ashlrai/phantom/issues/7352)) ([d180392](https://github.com/ashlrai/phantom/commit/d18039280b725e2898b04e696b04421aa97427f4))
* **RQ-DVL-RSI-1795093613:** ([#7363](https://github.com/ashlrai/phantom/issues/7363)) ([6e05caa](https://github.com/ashlrai/phantom/commit/6e05caa36a4a8703247646e19e074fcb1e1860dc))
* **RQ-EMPTYWHYN20SQ8:** BRIDGE_NOTES: RQ-EMPTYWHYN20SQ8 ([#7351](https://github.com/ashlrai/phantom/issues/7351)) ([7daa3c0](https://github.com/ashlrai/phantom/commit/7daa3c0d770d0f3bc0c0cf2e3204009b3b04e257))
* **RQ-LANEBADGEN20OQ8:** RQ-LANEBADGEN20OQ8: lane health verdict + badges ([#7309](https://github.com/ashlrai/phantom/issues/7309)) ([2fdc492](https://github.com/ashlrai/phantom/commit/2fdc492b85a4691eb58c84941eca4fe3b90ff6d9))
* **RQ-LEADERSEATR2N20UQ8:** BRIDGE NOTES: RQ-LEADERSEATR2N20UQ8 ([#7369](https://github.com/ashlrai/phantom/issues/7369)) ([f78ead0](https://github.com/ashlrai/phantom/commit/f78ead0cc08f47146c4ed1cd75898e562919b783))
* **RQ-LOADSRCN20KQ8:** RQ-LOADSRCN20KQ8: who owns the machine's load ([#7260](https://github.com/ashlrai/phantom/issues/7260)) ([ba4195e](https://github.com/ashlrai/phantom/commit/ba4195e71b4f5aa4d16633c21781113edbc198c7))
* **RQ-MERGELIVEN20GQ8:** RQ-MERGELIVEN20GQ8 ([#7265](https://github.com/ashlrai/phantom/issues/7265)) ([5c8cd5b](https://github.com/ashlrai/phantom/commit/5c8cd5ba5bef7ec3f0915d1038112b6a5be4faff))
* **RQ-MOBILEASKSR2N20QQ8:** RQ-MOBILEASKSR2N20QQ8 (recovery of RQ-MOBILEASKSN20OQ8) ([#7327](https://github.com/ashlrai/phantom/issues/7327)) ([f6f02c7](https://github.com/ashlrai/phantom/commit/f6f02c76d521aec593bbab4bd29c3644e42f6891))
* **RQ-MOBILEORGN20SQ8:** RQ-MOBILEORGN20SQ8: phone layout for the Org view ([#7355](https://github.com/ashlrai/phantom/issues/7355)) ([2128c22](https://github.com/ashlrai/phantom/commit/2128c22d28c6a165eedb67dd4e737d5195b1f8af))
* **RQ-NODESN20SQ8:** RQ-NODESN20SQ8: machines as one pool ([#7353](https://github.com/ashlrai/phantom/issues/7353)) ([6a1108f](https://github.com/ashlrai/phantom/commit/6a1108fbee6fc1d58eec076f3528fe7eaf384192))
* **RQ-ORGMAPN20QQ8:** RQ-ORGMAPN20QQ8: org map ([#7332](https://github.com/ashlrai/phantom/issues/7332)) ([ab13a10](https://github.com/ashlrai/phantom/commit/ab13a10013b18425e5b3f11e3750255e1fccd5f9))
* **RQ-PHX-ADAPTERCONTRACTRECOVER644S:** BRIDGE_NOTES: RQ-PHX-ADAPTERCONTRACTRECOVER644S ([#7276](https://github.com/ashlrai/phantom/issues/7276)) ([4f4b925](https://github.com/ashlrai/phantom/commit/4f4b9259430b06364e2da44e3e04a44029f14768))
* **RQ-PHX-CATALOGREADRECOVER642S:** RQ-PHX-CATALOGREADRECOVER642S: coding CLI catalog parser rec ([#7272](https://github.com/ashlrai/phantom/issues/7272)) ([d4c29a2](https://github.com/ashlrai/phantom/commit/d4c29a2f597223efa764f534cfb44d0cbbb67c4a))
* **RQ-PHX-COHORTRECOVER652S:** RQ-PHX-COHORTRECOVER652S: offline canary-cohort replay (work ([#7338](https://github.com/ashlrai/phantom/issues/7338)) ([22504ee](https://github.com/ashlrai/phantom/commit/22504ee16c291db000e5cd29d354c2e0a634bd2a))
* **RQ-PHX-COOLDOWNEVIDENCE640S:** RQ-PHX-COOLDOWNEVIDENCE640S: recover the CLI cooldown eviden ([#7271](https://github.com/ashlrai/phantom/issues/7271)) ([7ee2f6a](https://github.com/ashlrai/phantom/commit/7ee2f6ab7194f7f8f0e003ade5fa1b3ea98dcf3e))
* **RQ-PHX-DECISIONREADRECOVER646S:** RQ-PHX-DECISIONREADRECOVER646S: router-decision reader recov ([#7294](https://github.com/ashlrai/phantom/issues/7294)) ([453acf1](https://github.com/ashlrai/phantom/commit/453acf16988720d3ce3c8442bad9e63b7b97c66a))
* **RQ-PHX-LEDGERSCOREPRESERVE639S:** RQ-PHX-LEDGERSCOREPRESERVE639S: recover the SpendDecision po ([#7269](https://github.com/ashlrai/phantom/issues/7269)) ([c77538b](https://github.com/ashlrai/phantom/commit/c77538bca195ed8b4ffab709586fed00a3a6c01f))
* **RQ-PHX-OFFLINEREPLAYRECOVER648S:** RQ-PHX-OFFLINEREPLAYRECOVER648S: offline IPS and doubly robu ([#7310](https://github.com/ashlrai/phantom/issues/7310)) ([20ad8b2](https://github.com/ashlrai/phantom/commit/20ad8b219c3fba018269f4b646805533bc015785))
* **RQ-PHX-POSTERIORCOMPARE645S:** RQ-PHX-POSTERIORCOMPARE645S: posterior comparison recovery ( ([#7292](https://github.com/ashlrai/phantom/issues/7292)) ([ec69906](https://github.com/ashlrai/phantom/commit/ec699066e0d6690b186e75b3f674805b7c7dac63))
* **RQ-PHX-POSTERIORSAMPLERECOVER651S:** RQ-PHX-POSTERIORSAMPLERECOVER651S: bounded recovery of the s ([#7336](https://github.com/ashlrai/phantom/issues/7336)) ([dccfc06](https://github.com/ashlrai/phantom/commit/dccfc067eb714ea8d1982200de5cd786e82f87e2))
* **RQ-PHX-POSTERIORUPDATERECOVER650S:** RQ-PHX-POSTERIORUPDATERECOVER650S ([#7319](https://github.com/ashlrai/phantom/issues/7319)) ([1f9ad51](https://github.com/ashlrai/phantom/commit/1f9ad5154247cefba2cff684e31c6968b81cb6f5))
* **RQ-PHX-QUEUESTUCKPRESERVE637S:** BRIDGE_NOTES: RQ-PHX-QUEUESTUCKPRESERVE637S ([#7249](https://github.com/ashlrai/phantom/issues/7249)) ([7f662c9](https://github.com/ashlrai/phantom/commit/7f662c9b13455f058c6680d58dd55d015cca825c))
* **RQ-PHX-REGRETRECOVER647S:** RQ-PHX-REGRETRECOVER647S: offline coding regret (PR [#5952](https://github.com/ashlrai/phantom/issues/5952) sl ([#7298](https://github.com/ashlrai/phantom/issues/7298)) ([eaf4bfa](https://github.com/ashlrai/phantom/commit/eaf4bfa44a64505d2cf063247201670deda4ada9))
* **RQ-PHX-SCHEDULEVALUERECOVER653S:** BRIDGE_NOTES: RQ-PHX-SCHEDULEVALUERECOVER653S ([#7345](https://github.com/ashlrai/phantom/issues/7345)) ([3760580](https://github.com/ashlrai/phantom/commit/376058020477be7c5f846e39d01a4fa17f056b3b))
* **RQ-PHX-SOLUTIONPROJECTRECOVER655S:** BRIDGE NOTES: RQ-PHX-SOLUTIONPROJECTRECOVER655S ([#7362](https://github.com/ashlrai/phantom/issues/7362)) ([1ac4abe](https://github.com/ashlrai/phantom/commit/1ac4abec8d8f5114e9f5fc6dee60bd3bc709fdd6))
* **RQ-PHX-SPENDAPPENDRECOVER638S:** RQ-PHX-SPENDAPPENDRECOVER638S: spend-ledger append recovery ([#7267](https://github.com/ashlrai/phantom/issues/7267)) ([51e2810](https://github.com/ashlrai/phantom/commit/51e28104fcd861846e51581b070aaf80f7df07a9))
* **RQ-PHX-WORKSTATEPUBLISHGATE654:** BRIDGE_NOTES — RQ-PHX-WORKSTATEPUBLISHGATE654 ([#7354](https://github.com/ashlrai/phantom/issues/7354)) ([43e6bbb](https://github.com/ashlrai/phantom/commit/43e6bbbff9496f6de4b6845d61e0f8b240bc77de))
* **RQ-PLANDUPN20SQ8:** RQ-PLANDUPN20SQ8: `phm plan dup` ([#7349](https://github.com/ashlrai/phantom/issues/7349)) ([5f50fe1](https://github.com/ashlrai/phantom/commit/5f50fe19008d87e1cf08a6ca06495f28f7da4c99))
* **RQ-POOLPACEN20MQ8:** RQ-POOLPACEN20MQ8: pool burn from real readings, plain verdi ([#7283](https://github.com/ashlrai/phantom/issues/7283)) ([a9ad5c6](https://github.com/ashlrai/phantom/commit/a9ad5c6c38db556232b3d12839ef582168dc8eea))
* **RQ-PUBRESUMEN20QQ8:** RQ-PUBRESUMEN20QQ8: `phm publish resume` and `phm publish or ([#7335](https://github.com/ashlrai/phantom/issues/7335)) ([809292a](https://github.com/ashlrai/phantom/commit/809292a807ff79b16fd5ca7f3ff64606ef2f83dc))
* **RQ-RELNOTESN20SQ8:** BRIDGE_NOTES: RQ-RELNOTESN20SQ8 ([#7348](https://github.com/ashlrai/phantom/issues/7348)) ([e4b532f](https://github.com/ashlrai/phantom/commit/e4b532f32fdcb9eabc482b8d47742507864fd828))
* **RQ-REPLYFEEDN20OQ8:** RQ-REPLYFEEDN20OQ8: hourly leader reply into the outbox ([#7307](https://github.com/ashlrai/phantom/issues/7307)) ([eca6d1e](https://github.com/ashlrai/phantom/commit/eca6d1e400b5153242fa2cc9e8c19e6126dfe67e))
* **RQ-SLACKSTATESN20UQ8:** BRIDGE NOTES: RQ-SLACKSTATESN20UQ8 ([#7370](https://github.com/ashlrai/phantom/issues/7370)) ([aa9ca61](https://github.com/ashlrai/phantom/commit/aa9ca6106d4c945c41e5d8b0ec324e5a9f4bba73))
* **RQ-SPENDDOWNN20OQ8:** RQ-SPENDDOWNN20OQ8: spend-down chart ([#7306](https://github.com/ashlrai/phantom/issues/7306)) ([74f356f](https://github.com/ashlrai/phantom/commit/74f356fdb23d3684577faa16b397b10949413d3c))
* **RQ-STARVEN20MQ8:** BRIDGE_NOTES: RQ-STARVEN20MQ8 ([#7280](https://github.com/ashlrai/phantom/issues/7280)) ([05b7c64](https://github.com/ashlrai/phantom/commit/05b7c64c8e89d6f2334c35e430cb516c66d4e8be))
* **RQ-THRUPUTN20UQ8:** BRIDGE NOTES: RQ-THRUPUTN20UQ8 ([#7371](https://github.com/ashlrai/phantom/issues/7371)) ([cef21e2](https://github.com/ashlrai/phantom/commit/cef21e20368a6fac5cbdf8cdb796b428bec109e5))
* **RQ-ZAIEXITN20KQ8:** RQ-ZAIEXITN20KQ8: job outcomes, not exit codes ([#7284](https://github.com/ashlrai/phantom/issues/7284)) ([4fe1a7a](https://github.com/ashlrai/phantom/commit/4fe1a7aa89e1c9e82939f4a30e0f185466e644c8))

## [3.30.40] - 2026-11-19


### Fixes

* carry jobs-state help and current proofs forward from 6793 ([#7003](https://github.com/ashlrai/phantom/issues/7003)) ([37ee500](https://github.com/ashlrai/phantom/commit/37ee500f7215082851c2968ef4c8e9f25e4d0609))
* **dispatchd:** group-aware absence for maxruntime escalation ([#7220](https://github.com/ashlrai/phantom/issues/7220)) ([d59f72e](https://github.com/ashlrai/phantom/commit/d59f72eda557e437b52313cf8f2bdc2a78238b33))
* **dispatchd:** require affirmative absence before retiring pending TERM candidates ([#7186](https://github.com/ashlrai/phantom/issues/7186)) ([5f2e29d](https://github.com/ashlrai/phantom/commit/5f2e29d3995dbd8d0608547e7018401fea7b55f5))
* **dispatchd:** track SIGKILL escalation completion per recorded group ([#7144](https://github.com/ashlrai/phantom/issues/7144)) ([e6e53aa](https://github.com/ashlrai/phantom/commit/e6e53aab1bf13d5043494a70302da5448c66bc58))
* keep recent session identity ahead of stale claims ([#6962](https://github.com/ashlrai/phantom/issues/6962)) ([ecca67e](https://github.com/ashlrai/phantom/commit/ecca67eb5b728bc45ba090ef6c27a6d961cb4a34))
* repair fast-gate regressions blocking release 3.30.40 ([#7159](https://github.com/ashlrai/phantom/issues/7159)) ([8c2f6bd](https://github.com/ashlrai/phantom/commit/8c2f6bdfa152697c55210a7d336dd06b201e9aef))


### Changes

* **FIXUP-CI-phantom-release-pr-469633:** FIXUP-CI-phantom-release-pr-469633 ([#7006](https://github.com/ashlrai/phantom/issues/7006)) ([a289e98](https://github.com/ashlrai/phantom/commit/a289e98ac98cdeab97bd1712da2913d51de0eedf))
* **RQ-A2AVIEWN19YQ8:** BRIDGE_NOTES: RQ-A2AVIEWN19YQ8 (agent conversations on the m ([#7134](https://github.com/ashlrai/phantom/issues/7134)) ([d4bb647](https://github.com/ashlrai/phantom/commit/d4bb6475b40bc411623c308687cbebb1a4798fb3))
* **RQ-APPEARN19NQ8:** RQ-APPEARN19NQ8: Settings &gt; Appearance ([#7055](https://github.com/ashlrai/phantom/issues/7055)) ([34b1e1f](https://github.com/ashlrai/phantom/commit/34b1e1f18d311ea9200fab0fd939cd3fa75a7008))
* **RQ-CL-DESK-1795032428:** ([#7010](https://github.com/ashlrai/phantom/issues/7010)) ([b1c8cc0](https://github.com/ashlrai/phantom/commit/b1c8cc087baf7897b14848b2569a0d9ea821891a))
* **RQ-CL-DESK-1795034763:** ([#7021](https://github.com/ashlrai/phantom/issues/7021)) ([db02540](https://github.com/ashlrai/phantom/commit/db02540de55eee26844a6cb4a73a3ac1466243d3))
* **RQ-CL-DESK-1795036065:** ([#7025](https://github.com/ashlrai/phantom/issues/7025)) ([7d2e294](https://github.com/ashlrai/phantom/commit/7d2e2940bb24bf53e3f2c5fabd67e38db392f734))
* **RQ-CL-DESK-1795051890:** ([#7095](https://github.com/ashlrai/phantom/issues/7095)) ([06904c9](https://github.com/ashlrai/phantom/commit/06904c97351457a209bd57a00bc201035e6ad5d8))
* **RQ-CL-DESK-1795067345:** ([#7183](https://github.com/ashlrai/phantom/issues/7183)) ([a9f4e63](https://github.com/ashlrai/phantom/commit/a9f4e634dcfec8d8ebd5c8d973c8094626c7c910))
* **RQ-CL-DESK-1795067988:** ([#7190](https://github.com/ashlrai/phantom/issues/7190)) ([a4ea09d](https://github.com/ashlrai/phantom/commit/a4ea09da528db2fd748fada561fbb08e49fd51b6))
* **RQ-CL-DESK-1795070091:** ([#7201](https://github.com/ashlrai/phantom/issues/7201)) ([93ec09a](https://github.com/ashlrai/phantom/commit/93ec09a4bbfdb0a40c0390dbffa1095b59957337))
* **RQ-CL-DESK-1795070812:** ([#7208](https://github.com/ashlrai/phantom/issues/7208)) ([b6cc81a](https://github.com/ashlrai/phantom/commit/b6cc81a87f24f725c6f6d76b81f3b2e579a18f0d))
* **RQ-CL-DESK-1795072018:** ([#7216](https://github.com/ashlrai/phantom/issues/7216)) ([8c1336f](https://github.com/ashlrai/phantom/commit/8c1336ffee7c907584df888916c37607e7308fbf))
* **RQ-CL-DESK2-1795059654:** ([#7131](https://github.com/ashlrai/phantom/issues/7131)) ([657b427](https://github.com/ashlrai/phantom/commit/657b4271381c419ce84cb05cafdfa78e50249107))
* **RQ-CL-DESK2-1795060528:** ([#7135](https://github.com/ashlrai/phantom/issues/7135)) ([9c8ee30](https://github.com/ashlrai/phantom/commit/9c8ee30e81bc1d6b43949744fd345085914437ab))
* **RQ-CL-DESK2-1795062191:** ([#7148](https://github.com/ashlrai/phantom/issues/7148)) ([ca9d06b](https://github.com/ashlrai/phantom/commit/ca9d06b4fb8c3e5b523a122b0308cf2b00c0f912))
* **RQ-CL-DESK2-1795064513:** ([#7165](https://github.com/ashlrai/phantom/issues/7165)) ([15bc2f1](https://github.com/ashlrai/phantom/commit/15bc2f178144bb56f50f74ea39e183a04e2841c5))
* **RQ-CL-DESK2-1795065084:** ([#7172](https://github.com/ashlrai/phantom/issues/7172)) ([0db92e8](https://github.com/ashlrai/phantom/commit/0db92e87b2627a21e774a1a5d72728b2327b3a24))
* **RQ-CL-DESK2-1795066145:** ([#7175](https://github.com/ashlrai/phantom/issues/7175)) ([3f3b73f](https://github.com/ashlrai/phantom/commit/3f3b73f6561dcdac7906dd34fc2612c33639a6f9))
* **RQ-CL-DESK2-1795066785:** ([#7179](https://github.com/ashlrai/phantom/issues/7179)) ([488eb72](https://github.com/ashlrai/phantom/commit/488eb725956e4a5b85205451f1430b1491aab6c6))
* **RQ-CL-DESK2-1795067533:** ([#7187](https://github.com/ashlrai/phantom/issues/7187)) ([849f555](https://github.com/ashlrai/phantom/commit/849f5557762d2654c67f927fd1cf153318c03c3e))
* **RQ-CL-DESK2-1795068370:** ([#7189](https://github.com/ashlrai/phantom/issues/7189)) ([b339961](https://github.com/ashlrai/phantom/commit/b339961a8d98cda856276cf7e610f491f897ee37))
* **RQ-CL-DESK2-1795069424:** ([#7196](https://github.com/ashlrai/phantom/issues/7196)) ([3e2e504](https://github.com/ashlrai/phantom/commit/3e2e5049b06e5a1400e1950e595d3d271f1a329b))
* **RQ-CL-DESK2-1795070036:** ([#7199](https://github.com/ashlrai/phantom/issues/7199)) ([a5c754f](https://github.com/ashlrai/phantom/commit/a5c754fc921406765b88a50a6c380607174f4d4f))
* **RQ-CL-DESK2-1795070412:** ([#7200](https://github.com/ashlrai/phantom/issues/7200)) ([0359815](https://github.com/ashlrai/phantom/commit/035981561802792691314f87854263b67ea2983d))
* **RQ-CL-DESK2-1795070793:** ([#7207](https://github.com/ashlrai/phantom/issues/7207)) ([30ce469](https://github.com/ashlrai/phantom/commit/30ce469d7910943efdb44a68054d5eef82570c39))
* **RQ-CL-DESK2-1795071747:** ([#7209](https://github.com/ashlrai/phantom/issues/7209)) ([172a459](https://github.com/ashlrai/phantom/commit/172a45952575d2a78f82b6d48819d18e8dbce2c3))
* **RQ-CL-DESK2-1795072384:** ([#7219](https://github.com/ashlrai/phantom/issues/7219)) ([74da6ea](https://github.com/ashlrai/phantom/commit/74da6ea4415863301c06ba73a32686f538748ab2))
* **RQ-CL-DOCS-1795032428:** ([#7004](https://github.com/ashlrai/phantom/issues/7004)) ([4547405](https://github.com/ashlrai/phantom/commit/4547405cdba0f57ea1dfddb894b5dcd518e76a6b))
* **RQ-CL-DOCS-1795034080:** ([#7012](https://github.com/ashlrai/phantom/issues/7012)) ([b21c4d5](https://github.com/ashlrai/phantom/commit/b21c4d53e5cae30168b38df71a9b6e2e5cfef781))
* **RQ-CL-DOCS-1795037531:** ([#7028](https://github.com/ashlrai/phantom/issues/7028)) ([ec0f384](https://github.com/ashlrai/phantom/commit/ec0f3840775366dc163c279c0057baedaca1533b))
* **RQ-CL-DOCS-1795041171:** ([#7039](https://github.com/ashlrai/phantom/issues/7039)) ([e0fca02](https://github.com/ashlrai/phantom/commit/e0fca028124d020908643d44e913b9c4aaaaac5e))
* **RQ-CL-DOCS-1795047014:** ([#7058](https://github.com/ashlrai/phantom/issues/7058)) ([662c847](https://github.com/ashlrai/phantom/commit/662c847ab101e69121de8c0f94cc101f8e87fafe))
* **RQ-CL-DOCS-1795055343:** ([#7099](https://github.com/ashlrai/phantom/issues/7099)) ([4a861be](https://github.com/ashlrai/phantom/commit/4a861bef73f4f5ef00086efa2d67fa4e190d6fa6))
* **RQ-CL-DOCS-1795062415:** ([#7146](https://github.com/ashlrai/phantom/issues/7146)) ([3a41311](https://github.com/ashlrai/phantom/commit/3a41311461d1f8dd7d037421bf6a3534bdc754b5))
* **RQ-CL-DOCS-1795066629:** ([#7177](https://github.com/ashlrai/phantom/issues/7177)) ([3ceb1a6](https://github.com/ashlrai/phantom/commit/3ceb1a61643becc348fbdf10ab87be4d7ec4a44e))
* **RQ-CL-DOCS-1795070050:** ([#7198](https://github.com/ashlrai/phantom/issues/7198)) ([09799ea](https://github.com/ashlrai/phantom/commit/09799ea2a8397c5661c19255e2effa54faab34e2))
* **RQ-DEVINCLOUD-BRIDGESCOPE-N17:** ([#7007](https://github.com/ashlrai/phantom/issues/7007)) ([02e3cd3](https://github.com/ashlrai/phantom/commit/02e3cd3ceac15771182a42d5afa1331bffd6143b))
* **RQ-DEVINCLOUD-COWNERS-N17:** ([#7047](https://github.com/ashlrai/phantom/issues/7047)) ([baa378b](https://github.com/ashlrai/phantom/commit/baa378b4c18bef5a7be6da26cde1d132e39dee06))
* **RQ-DEVINCLOUD-POSTRUNENV-N17:** ([#7009](https://github.com/ashlrai/phantom/issues/7009)) ([5210dd3](https://github.com/ashlrai/phantom/commit/5210dd32f23bd89da7bb0f7eef0c977966bcdb8a))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795055514-N17:** ([#7121](https://github.com/ashlrai/phantom/issues/7121)) ([b46a7b7](https://github.com/ashlrai/phantom/commit/b46a7b74136b87e73d1deef7ebdb2ae2c3ea6741))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795059461-N17:** ([#7132](https://github.com/ashlrai/phantom/issues/7132)) ([a77b5f7](https://github.com/ashlrai/phantom/commit/a77b5f7ea8e3cd7b5e38c62ca4814c7de1ba8684))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795062770-N17:** ([#7153](https://github.com/ashlrai/phantom/issues/7153)) ([20b2ebd](https://github.com/ashlrai/phantom/commit/20b2ebd88bd811fb22bbe95327939d40620c1166))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795063661-N17:** ([#7166](https://github.com/ashlrai/phantom/issues/7166)) ([2aec92d](https://github.com/ashlrai/phantom/commit/2aec92d2b6046594f9e910abf0b8981cc921c4e9))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795065123-N17:** ([#7173](https://github.com/ashlrai/phantom/issues/7173)) ([c2ded6c](https://github.com/ashlrai/phantom/commit/c2ded6c9105a5e79c1df8b55e606ba1469aaea0f))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795066324-N17:** ([#7184](https://github.com/ashlrai/phantom/issues/7184)) ([7f0edd2](https://github.com/ashlrai/phantom/commit/7f0edd24d3f51144e9475534037e7addabe9d2ee))
* **RQ-DEVINCLOUD-RQ-DVL-BUS-1795069160-N17:** ([#7210](https://github.com/ashlrai/phantom/issues/7210)) ([14b8ce7](https://github.com/ashlrai/phantom/commit/14b8ce798d7af08e36b4c9d8997ded961152fb91))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795059284-N17:** ([#7128](https://github.com/ashlrai/phantom/issues/7128)) ([d5614b0](https://github.com/ashlrai/phantom/commit/d5614b06b06ec83af3a06484fcc8cf13ec998245))
* **RQ-DEVINCLOUD-RQ-DVL-FLEET-1795070135-N17:** ([#7211](https://github.com/ashlrai/phantom/issues/7211)) ([21623d9](https://github.com/ashlrai/phantom/commit/21623d9862f9698581fe3dd3d9fe786b184f6c81))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795059280-N17:** ([#7143](https://github.com/ashlrai/phantom/issues/7143)) ([79364a0](https://github.com/ashlrai/phantom/commit/79364a08b78fa95f2e081d5131927976510e2b1f))
* **RQ-DEVINCLOUD-RQ-DVL-RSI-1795069966-N17:** ([#7215](https://github.com/ashlrai/phantom/issues/7215)) ([3e8b321](https://github.com/ashlrai/phantom/commit/3e8b321112e1212e8c175a947d80b2636c024998))
* **RQ-DEVINCLOUD-RTVERB-N17:** ([#7019](https://github.com/ashlrai/phantom/issues/7019)) ([ffdcdd6](https://github.com/ashlrai/phantom/commit/ffdcdd6e6d63b543e0d1dfbf8409433f745dcae5))
* **RQ-DEVINCLOUD-RVFRESH-N17:** ([#7011](https://github.com/ashlrai/phantom/issues/7011)) ([a6c0309](https://github.com/ashlrai/phantom/commit/a6c0309bff6279ab2e0d416983f71094bac52a1f))
* **RQ-DEVINCLOUD-SLACKKEY-N17:** ([#7050](https://github.com/ashlrai/phantom/issues/7050)) ([2e0f14d](https://github.com/ashlrai/phantom/commit/2e0f14d8bf7e8229707fd91ac5d6f8bbe448583a))
* **RQ-DEVINCLOUD-WDFENCE-N17:** ([#7015](https://github.com/ashlrai/phantom/issues/7015)) ([541e304](https://github.com/ashlrai/phantom/commit/541e304653e1c75545eda5ee786706099579d2f6))
* **RQ-DEVINCLOUD-WDFENCE3-N17:** ([#7046](https://github.com/ashlrai/phantom/issues/7046)) ([5bc7c2f](https://github.com/ashlrai/phantom/commit/5bc7c2f7ba3f7c4ac4d0a209bfc657767138aca1))
* **RQ-DISKPLANN19YQ8:** BRIDGE_NOTES: RQ-DISKPLANN19YQ8 ([#7115](https://github.com/ashlrai/phantom/issues/7115)) ([3e33cd4](https://github.com/ashlrai/phantom/commit/3e33cd445af46560729721305b93ae03308df8c8))
* **RQ-DISKTESTN20AQ8:** RQ-DISKTESTN20AQ8 bridge notes ([#7156](https://github.com/ashlrai/phantom/issues/7156)) ([27369de](https://github.com/ashlrai/phantom/commit/27369de980f149a8e2975d4f7d7c6644702411a8))
* **RQ-DISKTRENDN21Q8:** ([#7101](https://github.com/ashlrai/phantom/issues/7101)) ([0b176a5](https://github.com/ashlrai/phantom/commit/0b176a5aeab4db8bf8c6506919a29c64537bf0e7))
* **RQ-DOCSCLIN19WQ8:** BRIDGE_NOTES: RQ-DOCSCLIN19WQ8 ([#7098](https://github.com/ashlrai/phantom/issues/7098)) ([08bc25e](https://github.com/ashlrai/phantom/commit/08bc25eb4c5f2555a35e87b2d698a07b3c316d8d))
* **RQ-DVL-BUS-1795046796:** ([#7059](https://github.com/ashlrai/phantom/issues/7059)) ([ef84c9d](https://github.com/ashlrai/phantom/commit/ef84c9d1da84c5eff2a369b8a6eb5985c2956356))
* **RQ-DVL-BUS-1795048323:** ([#7067](https://github.com/ashlrai/phantom/issues/7067)) ([85f48bb](https://github.com/ashlrai/phantom/commit/85f48bbdbe0e9b5aea7271237de6753a36b4dd0e))
* **RQ-DVL-BUS-1795053476:** ([#7103](https://github.com/ashlrai/phantom/issues/7103)) ([cd6dffa](https://github.com/ashlrai/phantom/commit/cd6dffacf32b2a0005cfde560bf5e8fce4fe1331))
* **RQ-DVL-BUS-1795058063:** ([#7122](https://github.com/ashlrai/phantom/issues/7122)) ([47c4ab0](https://github.com/ashlrai/phantom/commit/47c4ab005cadff3f1cc06a1e987569744cf63269))
* **RQ-DVL-BUS-1795062975:** ([#7161](https://github.com/ashlrai/phantom/issues/7161)) ([9247890](https://github.com/ashlrai/phantom/commit/92478905be03a2a72b4892789ad5bca8e0250f21))
* **RQ-DVL-BUS-1795069054:** ([#7205](https://github.com/ashlrai/phantom/issues/7205)) ([bf5b650](https://github.com/ashlrai/phantom/commit/bf5b65097181d913cfad1ceaffe48fd3c2ba7560))
* **RQ-DVL-FLEET-1795046796:** ([#7064](https://github.com/ashlrai/phantom/issues/7064)) ([48885e4](https://github.com/ashlrai/phantom/commit/48885e4977d32eb0b70ddb83c08f4f8a83c34c84))
* **RQ-DVL-FLEET-1795049079:** ([#7071](https://github.com/ashlrai/phantom/issues/7071)) ([5f08cef](https://github.com/ashlrai/phantom/commit/5f08cef53f87671fc8a1e2bd166adffefd84c33b))
* **RQ-DVL-FLEET-1795050528:** ([#7075](https://github.com/ashlrai/phantom/issues/7075)) ([a1b5ca5](https://github.com/ashlrai/phantom/commit/a1b5ca51735f6da20ceb4cf8707f0352035e4402))
* **RQ-DVL-FLEET-1795060409:** ([#7152](https://github.com/ashlrai/phantom/issues/7152)) ([b52618f](https://github.com/ashlrai/phantom/commit/b52618fbdd06b769c99b1a52a0be6a82207388d8))
* **RQ-DVL-FLEET-1795065391:** ([#7181](https://github.com/ashlrai/phantom/issues/7181)) ([046f6d5](https://github.com/ashlrai/phantom/commit/046f6d5ef7dfe4adca0fcdb89edb996ba6e56822))
* **RQ-DVL-RSI-1795046796:** ([#7061](https://github.com/ashlrai/phantom/issues/7061)) ([dff5099](https://github.com/ashlrai/phantom/commit/dff50997168c851e82f0c5047e6ffaaf09a30a4f))
* **RQ-DVL-RSI-1795048526:** ([#7070](https://github.com/ashlrai/phantom/issues/7070)) ([9a45d2e](https://github.com/ashlrai/phantom/commit/9a45d2ed395a29dcd9ba5b67c0c8384fe1eab573))
* **RQ-DVL-RSI-1795051227:** ([#7083](https://github.com/ashlrai/phantom/issues/7083)) ([719524e](https://github.com/ashlrai/phantom/commit/719524e1a24f70e6a967b66097193823c1dfaa68))
* **RQ-DVL-RSI-1795056745:** ([#7129](https://github.com/ashlrai/phantom/issues/7129)) ([0e2c625](https://github.com/ashlrai/phantom/commit/0e2c625dd13849c22d9cc24570c82dd25505cef3))
* **RQ-DVL-RSI-1795060480:** ([#7150](https://github.com/ashlrai/phantom/issues/7150)) ([bc1995f](https://github.com/ashlrai/phantom/commit/bc1995fec1f095b4d79826f76b8cee162fa88b5d))
* **RQ-DVL-RSI-1795066014:** ([#7191](https://github.com/ashlrai/phantom/issues/7191)) ([9332a6a](https://github.com/ashlrai/phantom/commit/9332a6a9ca928159b28a46115ebbec6bfd27caf2))
* **RQ-DVL-RSI-1795069059:** ([#7203](https://github.com/ashlrai/phantom/issues/7203)) ([f87a9eb](https://github.com/ashlrai/phantom/commit/f87a9ebc66411fb59dc9e9f689e607b3bc76dccd))
* **RQ-EMPTYWHY18YQ8:** integrate empty reasons while preserving stopfile controls ([#6952](https://github.com/ashlrai/phantom/issues/6952)) ([9af8d63](https://github.com/ashlrai/phantom/commit/9af8d6372bce0af702e1262fc9e6b40df01ce199))
* **RQ-EMPTYWHYN19NQ8:** RQ-EMPTYWHYN19NQ8: why fleet runs end empty ([#7054](https://github.com/ashlrai/phantom/issues/7054)) ([092772c](https://github.com/ashlrai/phantom/commit/092772c96acb8bc0e56eea72a12ad4e8ae2ba1a2))
* **RQ-EMPTYWORKN21Q8:** rebase recut admission onto current dispatch state ([#6881](https://github.com/ashlrai/phantom/issues/6881)) ([d8a1690](https://github.com/ashlrai/phantom/commit/d8a1690e349cb2ab1849b10ff58ff0608e9f553c))
* **RQ-FAMYIELDN19NQ8:** RQ-FAMYIELDN19NQ8: family yield in `phm fleet yield` ([#7052](https://github.com/ashlrai/phantom/issues/7052)) ([6375242](https://github.com/ashlrai/phantom/commit/63752423375f89c57532dbc8fc04da3e56168eff))
* **RQ-FEEDVIEWN19NQ8:** RQ-FEEDVIEWN19NQ8: Feed gaps closed ([#7057](https://github.com/ashlrai/phantom/issues/7057)) ([a9ad06a](https://github.com/ashlrai/phantom/commit/a9ad06a380e50653eaa66d1ed2df2fb14e5c02ae))
* **RQ-GOALSVIEWN19LQ8:** RQ-GOALSVIEWN19LQ8: Goals view ([#7033](https://github.com/ashlrai/phantom/issues/7033)) ([a9fb3ac](https://github.com/ashlrai/phantom/commit/a9fb3ace611d8a42809e4fe4f4c130ea140630f7))
* **RQ-GOALSVIEWN19YQ8:** BRIDGE_NOTES: RQ-GOALSVIEWN19YQ8 ([#7119](https://github.com/ashlrai/phantom/issues/7119)) ([b7d9326](https://github.com/ashlrai/phantom/commit/b7d932665863d3ecdbd973f10b348fe1f17d3bbb))
* **RQ-HOSTTOPN18ZQ8:** RQ-HOSTTOPN18ZQ8: `phm host top`, what is using this Mac ([#6954](https://github.com/ashlrai/phantom/issues/6954)) ([8b39331](https://github.com/ashlrai/phantom/commit/8b39331272b6563e4f5f02a7a01fa4b3b2650481))
* **RQ-INCLIMITQ8:** RQ-INCLIMITQ8 ([#7038](https://github.com/ashlrai/phantom/issues/7038)) ([fd43388](https://github.com/ashlrai/phantom/commit/fd43388a5a4d2032799c352a96c495056e8a5e48))
* **RQ-INVPANELSN19QQ8:** RQ-INVPANELSN19QQ8: one inventory of everything this install ([#7074](https://github.com/ashlrai/phantom/issues/7074)) ([abf3f0d](https://github.com/ashlrai/phantom/commit/abf3f0da6f9ddd978b1f9459a7ff608f1176b37d))
* **RQ-LANEHELDN19LQ8:** RQ-LANEHELDN19LQ8: `phm fleet held` ([#7030](https://github.com/ashlrai/phantom/issues/7030)) ([1d824f5](https://github.com/ashlrai/phantom/commit/1d824f56713653f488645fe19102608ea6419b4a))
* **RQ-LAUNCHRATEN19QQ8:** RQ-LAUNCHRATEN19QQ8: job starts per hour and where they go ([#7069](https://github.com/ashlrai/phantom/issues/7069)) ([0c78662](https://github.com/ashlrai/phantom/commit/0c786620fe351576f6ffd429eab9c1c3769002ec))
* **RQ-LEADERCHATN19UQ8:** RQ-LEADERCHATN19UQ8 — one Leader thread ([#7086](https://github.com/ashlrai/phantom/issues/7086)) ([0748e7b](https://github.com/ashlrai/phantom/commit/0748e7bc48a7ae115ee2645e849ee00f73013980))
* **RQ-LEADERSEATN19BQ8:** RQ-LEADERSEATN19BQ8: model-agnostic leader seating ([#6965](https://github.com/ashlrai/phantom/issues/6965)) ([73626d4](https://github.com/ashlrai/phantom/commit/73626d4bb7b4d89be92f0ab23d4c24b959a9bd2d))
* **RQ-LOADTREEN19UQ8:** RQ-LOADTREEN19UQ8: host load by process tree ([#7085](https://github.com/ashlrai/phantom/issues/7085)) ([223116c](https://github.com/ashlrai/phantom/commit/223116c39bde2adb5b0e9b36c35549d309b1f117))
* RQ-MAP3DN18RQ8 ([#6906](https://github.com/ashlrai/phantom/issues/6906)) ([174241f](https://github.com/ashlrai/phantom/commit/174241f1a7eacbe8391eb61b303bed234b668fc4))
* **RQ-MAP3DORGN19WQ8:** BRIDGE_NOTES: RQ-MAP3DORGN19WQ8 ([#7100](https://github.com/ashlrai/phantom/issues/7100)) ([0e1da5b](https://github.com/ashlrai/phantom/commit/0e1da5b4933d4ac37197bc8f8c8016e82483788b))
* **RQ-MERGERECOVERYQ8:** RQ-MERGERECOVERYQ8 ([#7180](https://github.com/ashlrai/phantom/issues/7180)) ([3a056e6](https://github.com/ashlrai/phantom/commit/3a056e667e465e92b56b2c5c64ee3dbc12faae3d))
* **RQ-MERGEWAIT19AQ8:** RQ-MERGEWAIT19AQ8 ([#6964](https://github.com/ashlrai/phantom/issues/6964)) ([ae15f76](https://github.com/ashlrai/phantom/commit/ae15f7661479640ba8bb17609f62bf26558325eb))
* **RQ-MSGEDGESQ8:** BRIDGE_NOTES: RQ-MSGEDGESQ8 ([#7041](https://github.com/ashlrai/phantom/issues/7041)) ([2b55b69](https://github.com/ashlrai/phantom/commit/2b55b69eb4096a8d04fa531aec4ead38667fa23d))
* **RQ-NEEDSYOUN19NQ8:** RQ-NEEDSYOUN19NQ8: Needs you, four limits only ([#7056](https://github.com/ashlrai/phantom/issues/7056)) ([bd197b2](https://github.com/ashlrai/phantom/commit/bd197b25a694e6bfccebaae8ae93bb87eefb3355))
* **RQ-NODELIVEN18ZQ8:** RQ-NODELIVEN18ZQ8: every map node opens a live window ([#6958](https://github.com/ashlrai/phantom/issues/6958)) ([8624cee](https://github.com/ashlrai/phantom/commit/8624cee0ec1f187b77052247f418b6bb9e6ea4d4))
* **RQ-ORGMAPN19SQ8:** RQ-ORGMAPN19SQ8: fleet map by org ([#7081](https://github.com/ashlrai/phantom/issues/7081)) ([1acb565](https://github.com/ashlrai/phantom/commit/1acb565f815a06531fe25820977cf92a67512afd))
* **RQ-PACEALERTN20AQ8:** RQ-PACEALERTN20AQ8: plan pace warning ([#7139](https://github.com/ashlrai/phantom/issues/7139)) ([2efb0d8](https://github.com/ashlrai/phantom/commit/2efb0d80122765933d3353a8e4a8ea1265918565))
* **RQ-PHONEASKN19YQ8:** BRIDGE_NOTES: RQ-PHONEASKN19YQ8 ([#7116](https://github.com/ashlrai/phantom/issues/7116)) ([a778c24](https://github.com/ashlrai/phantom/commit/a778c2452e76e2ccf2f5cc18c2cc39fb2e269bcc))
* **RQ-PHONEHOMEN20AQ8:** RQ-PHONEHOMEN20AQ8: phone home answers "is the fleet doing w ([#7176](https://github.com/ashlrai/phantom/issues/7176)) ([fea711f](https://github.com/ashlrai/phantom/commit/fea711f3f58ed82dbbc323622df65307f7daa931))
* **RQ-PHX-BUSPROVIDERRECOVER616S:** RQ-PHX-BUSPROVIDERRECOVER616S ([#7077](https://github.com/ashlrai/phantom/issues/7077)) ([06160ba](https://github.com/ashlrai/phantom/commit/06160ba065b4d6398065e7ad0237b8cc51d32229))
* **RQ-PHX-CAPABILITYRETRYPRESERVE590S:** Capability retry preservation handoff ([#6982](https://github.com/ashlrai/phantom/issues/6982)) ([6d09314](https://github.com/ashlrai/phantom/commit/6d09314b057d769860323f5e7165143d30ccc758))
* **RQ-PHX-CLAIMDRIFTPRESERVE603S:** Claim drift preservation ([#7001](https://github.com/ashlrai/phantom/issues/7001)) ([b8a4e46](https://github.com/ashlrai/phantom/commit/b8a4e466e9ccabb5d8a1b07ec598782dedbc35f8))
* **RQ-PHX-DESKMACHINESGLANCE631:** RQ-PHX-DESKMACHINESGLANCE631: Machines row in the verse flee ([#7174](https://github.com/ashlrai/phantom/issues/7174)) ([45007d1](https://github.com/ashlrai/phantom/commit/45007d1f16b830087025bc609c2df17c553a9311))
* **RQ-PHX-DESKRECUT595:** RQ-PHX-DESKRECUT595 ([#6991](https://github.com/ashlrai/phantom/issues/6991)) ([95deefd](https://github.com/ashlrai/phantom/commit/95deefd4ec51e186407cb9591bbbde7e0149ac84))
* **RQ-PHX-DESKRETURNHISTORY594S:** RQ-PHX-DESKRETURNHISTORY594S ([#6989](https://github.com/ashlrai/phantom/issues/6989)) ([bbb619e](https://github.com/ashlrai/phantom/commit/bbb619e8b5aa8427346f2063d6078f74d3ebd128))
* **RQ-PHX-DIGESTHEADINGRECOVER618S:** RQ-PHX-DIGESTHEADINGRECOVER618S: source-heading parser recov ([#7082](https://github.com/ashlrai/phantom/issues/7082)) ([00be1ef](https://github.com/ashlrai/phantom/commit/00be1effa1c24f94496a4599121f689242d60aca))
* **RQ-PHX-DOTEVIDENCEPACKET631:** RQ-PHX-DOTEVIDENCEPACKET631 ([#7202](https://github.com/ashlrai/phantom/issues/7202)) ([af9fcc5](https://github.com/ashlrai/phantom/commit/af9fcc56e15641f6a887310ff8cb0318f593bc21))
* **RQ-PHX-EMPTYRETRYEVIDENCE585S:** Retry evidence preservation ([#6971](https://github.com/ashlrai/phantom/issues/6971)) ([20cd581](https://github.com/ashlrai/phantom/commit/20cd5817d80896dcaadb5a7789f9dae25e1aae6a))
* **RQ-PHX-IMSGTICKRECOVER622S:** BRIDGE_NOTES: RQ-PHX-IMSGTICKRECOVER622S ([#7104](https://github.com/ashlrai/phantom/issues/7104)) ([7535256](https://github.com/ashlrai/phantom/commit/7535256a0376455fa189f647a38a9781d1a3f54e))
* **RQ-PHX-LEADERLIVENESSPRESERVE608S:** BRIDGE_NOTES — RQ-PHX-LEADERLIVENESSPRESERVE608S ([#7035](https://github.com/ashlrai/phantom/issues/7035)) ([80467a6](https://github.com/ashlrai/phantom/commit/80467a6a8dee6b3f174c4a16bb0394ff0189fc85))
* **RQ-PHX-LOOPSTOPRECOVER628S:** BRIDGE_NOTES — RQ-PHX-LOOPSTOPRECOVER628S ([#7157](https://github.com/ashlrai/phantom/issues/7157)) ([aa7ccad](https://github.com/ashlrai/phantom/commit/aa7ccadad7824553b584b00ed1227328d823d897))
* **RQ-PHX-MCPOBSERVEPRESERVE600S:** RQ-PHX-MCPOBSERVEPRESERVE600S ([#6997](https://github.com/ashlrai/phantom/issues/6997)) ([e3fcb9d](https://github.com/ashlrai/phantom/commit/e3fcb9d31baa0c367289478b5a505a5a5152369a))
* **RQ-PHX-NODERUNNERPRESERVE605S:** RQ-PHX-NODERUNNERPRESERVE605S ([#7005](https://github.com/ashlrai/phantom/issues/7005)) ([c25d773](https://github.com/ashlrai/phantom/commit/c25d773a5fa3320071f4ce7c1b711f37e5cab1fe))
* **RQ-PHX-NODETASKRECOVER615S:** RQ-PHX-NODETASKRECOVER615S: embedded node-task transport ([#7076](https://github.com/ashlrai/phantom/issues/7076)) ([3795bad](https://github.com/ashlrai/phantom/commit/3795badff731a29ce58fe2447af52cfb3a072889))
* **RQ-PHX-NODEWITHDRAWRECOVER607S:** RQ-PHX-NODEWITHDRAWRECOVER607S ([#7027](https://github.com/ashlrai/phantom/issues/7027)) ([f97847d](https://github.com/ashlrai/phantom/commit/f97847d48636c7de277a1051e3850a2de069974a))
* **RQ-PHX-NOTICEASOFRECOVER588S:** Claim notice as-of recovery ([#6979](https://github.com/ashlrai/phantom/issues/6979)) ([b94e2e1](https://github.com/ashlrai/phantom/commit/b94e2e1dcf72461ab2920db44a47aee88026adc4))
* **RQ-PHX-NOTICEQUALIFY598S:** Claim notice qualification handoff ([#6994](https://github.com/ashlrai/phantom/issues/6994)) ([1f52c72](https://github.com/ashlrai/phantom/commit/1f52c72522651513a472fac9c518be2214e124cb))
* **RQ-PHX-NOTICEQUERYFINISH597S:** Claim-notice query qualification ([#6992](https://github.com/ashlrai/phantom/issues/6992)) ([8cbc675](https://github.com/ashlrai/phantom/commit/8cbc67576f6db5e86d14bce82c0bfa77098d34f1))
* **RQ-PHX-ORGBOARDRECOVER621S:** RQ-PHX-ORGBOARDRECOVER621S: read-only org board slice of PR ([#7094](https://github.com/ashlrai/phantom/issues/7094)) ([413bf5b](https://github.com/ashlrai/phantom/commit/413bf5b3092f57ef928465351debbd9bb332b31f))
* **RQ-PHX-ORGOUTBOXRECOVER632S:** RQ-PHX-ORGOUTBOXRECOVER632S: org-membership bus outbox recov ([#7213](https://github.com/ashlrai/phantom/issues/7213)) ([678a27a](https://github.com/ashlrai/phantom/commit/678a27a0b375f6d297c7192751335d93817eb02b))
* **RQ-PHX-OUTCOMELEDGERPRESERVE612S:** BRIDGE_NOTES: RQ-PHX-OUTCOMELEDGERPRESERVE612S ([#7045](https://github.com/ashlrai/phantom/issues/7045)) ([9fddc17](https://github.com/ashlrai/phantom/commit/9fddc178cbc07a52b516bd2e31040207917aa5a9))
* **RQ-PHX-OWNERSHAREPRESERVE585S:** Owner-share preservation ([#6972](https://github.com/ashlrai/phantom/issues/6972)) ([a864674](https://github.com/ashlrai/phantom/commit/a864674fd84bf36fcd591313c6c1cb19c769b178))
* **RQ-PHX-PARKEDREADRECOVER627S:** BRIDGE_NOTES: RQ-PHX-PARKEDREADRECOVER627S ([#7154](https://github.com/ashlrai/phantom/issues/7154)) ([a2e7b19](https://github.com/ashlrai/phantom/commit/a2e7b19c77a6924d63cba404e26de9ad1303b0de))
* **RQ-PHX-PENDINGREADRECOVER626S:** BRIDGE_NOTES: RQ-PHX-PENDINGREADRECOVER626S ([#7141](https://github.com/ashlrai/phantom/issues/7141)) ([8e2bcb8](https://github.com/ashlrai/phantom/commit/8e2bcb828f41df435411c7f02d03a3aaf2207690))
* **RQ-PHX-POOLCARDPRESERVE599S:** RQ-PHX-POOLCARDPRESERVE599S ([#6996](https://github.com/ashlrai/phantom/issues/6996)) ([e987d7d](https://github.com/ashlrai/phantom/commit/e987d7d749c17d77ad5afe1d013543615fba8547))
* **RQ-PHX-QUEUEOVERLAPPRESERVE606S:** RQ-PHX-QUEUEOVERLAPPRESERVE606S ([#7023](https://github.com/ashlrai/phantom/issues/7023)) ([67b0a6d](https://github.com/ashlrai/phantom/commit/67b0a6d6d416e260facfe6826b311311cdd098fc))
* **RQ-PHX-QUOTATICKRECOVER633S:** RQ-PHX-QUOTATICKRECOVER633S — periodic native-Claude quota r ([#7217](https://github.com/ashlrai/phantom/issues/7217)) ([aade7a9](https://github.com/ashlrai/phantom/commit/aade7a901b5464f73848445b372eab33c23c1478))
* **RQ-PHX-RECUTCOREFLEETC579:** RQ-PHX-RECUTCOREFLEETC579 ([#6960](https://github.com/ashlrai/phantom/issues/6960)) ([8f44965](https://github.com/ashlrai/phantom/commit/8f44965ecd97b27c8b04c1d438c7db4ad6a0657c))
* **RQ-PHX-RECUTFLEETCLIC606:** Supersedes [#6633](https://github.com/ashlrai/phantom/issues/6633) ([#7013](https://github.com/ashlrai/phantom/issues/7013)) ([d942db3](https://github.com/ashlrai/phantom/commit/d942db31c1619b0650cb315028871172422098ed))
* **RQ-PHX-RECUTMODC592R1:** RQ-PHX-RECUTMODC592R1 ([#6986](https://github.com/ashlrai/phantom/issues/6986)) ([c199eaa](https://github.com/ashlrai/phantom/commit/c199eaa9edf371f68d080def27fe15616ae8def8))
* **RQ-PHX-RECUTWEBUIC606:** RQ-PHX-RECUTWEBUIC606 ([#7017](https://github.com/ashlrai/phantom/issues/7017)) ([5773174](https://github.com/ashlrai/phantom/commit/5773174e41ecb8d2990c246863303a4979440599))
* **RQ-PHX-REDTESTFIXC583:** RQ-PHX-REDTESTFIXC583 ([#6968](https://github.com/ashlrai/phantom/issues/6968)) ([d7d6738](https://github.com/ashlrai/phantom/commit/d7d673894fb03c25d48175f7d64a23c4e4ad7e79))
* **RQ-PHX-REDTESTFIXC606:** RQ-PHX-REDTESTFIXC606 ([#7018](https://github.com/ashlrai/phantom/issues/7018)) ([d92abc3](https://github.com/ashlrai/phantom/commit/d92abc39e377fd3815a9ffbd5c16e36de41bb432))
* **RQ-PHX-REDTESTFIXC608:** RQ-PHX-REDTESTFIXC608 ([#7029](https://github.com/ashlrai/phantom/issues/7029)) ([778d6f0](https://github.com/ashlrai/phantom/commit/778d6f039a82b5476aebabf0a82748d640167644))
* **RQ-PHX-RETURNFULLHEAD593S:** RQ-PHX-RETURNFULLHEAD593S ([#6987](https://github.com/ashlrai/phantom/issues/6987)) ([81b0556](https://github.com/ashlrai/phantom/commit/81b05568f98b57746b59b95764ab7ca3cf751e86))
* **RQ-PHX-RETURNHISTORYCLOCK592S:** Return history clock 592s ([#6985](https://github.com/ashlrai/phantom/issues/6985)) ([5640c3d](https://github.com/ashlrai/phantom/commit/5640c3dc4a5f6ff6b9d2253a0d2521d0f9bb5104))
* **RQ-PHX-RETURNLISTHISTORY595S:** RQ-PHX-RETURNLISTHISTORY595S ([#6990](https://github.com/ashlrai/phantom/issues/6990)) ([7f86ef0](https://github.com/ashlrai/phantom/commit/7f86ef0dbe6aa371d922257bcf3b8de11b1960fe))
* **RQ-PHX-RUNTIMEASOFRECOVER588S:** RQ-PHX-RUNTIMEASOFRECOVER588S ([#6980](https://github.com/ashlrai/phantom/issues/6980)) ([6275906](https://github.com/ashlrai/phantom/commit/627590646c6140e78ec240e58699419c2e07cd75))
* **RQ-PHX-SESSIONECONRECOVER620S:** BRIDGE_NOTES: RQ-PHX-SESSIONECONRECOVER620S ([#7090](https://github.com/ashlrai/phantom/issues/7090)) ([6d47dd7](https://github.com/ashlrai/phantom/commit/6d47dd70e22562ea80f7e9accd5d061c6e5c91c4))
* **RQ-PHX-SLACKBLOCKDELIVERY576S:** RQ-PHX-SLACKBLOCKDELIVERY576S ([#6950](https://github.com/ashlrai/phantom/issues/6950)) ([20d9951](https://github.com/ashlrai/phantom/commit/20d995159abd0e5e5bd2e1d11bc424c09ae96aa8))
* **RQ-PHX-SLACKDELIVERYCONTENTION577S:** RQ-PHX-SLACKDELIVERYCONTENTION577S ([#6953](https://github.com/ashlrai/phantom/issues/6953)) ([b00e2f9](https://github.com/ashlrai/phantom/commit/b00e2f9204fc3c2b56521c2f1b05101093d522e3))
* **RQ-PHX-SLACKIDENTITYRESTART579S:** RQ-PHX-SLACKIDENTITYRESTART579S ([#6961](https://github.com/ashlrai/phantom/issues/6961)) ([a28044f](https://github.com/ashlrai/phantom/commit/a28044fa90b7e837a80fa6f694e60c2600b1c534))
* **RQ-PHX-SLACKLEASEDELIVERY576S:** RQ-PHX-SLACKLEASEDELIVERY576S ([#6951](https://github.com/ashlrai/phantom/issues/6951)) ([1804315](https://github.com/ashlrai/phantom/commit/18043150ab7dbbbf114d85bb632aa94c6ddf3d9a))
* **RQ-PHX-SLACKPRRECONCILE611C:** RQ-PHX-SLACKPRRECONCILE611C: Slack PR reconcile ([#7066](https://github.com/ashlrai/phantom/issues/7066)) ([e996e82](https://github.com/ashlrai/phantom/commit/e996e82d3ecb70ca49f6fc55c0fa7280f36b43bb))
* **RQ-PHX-SLACKRATELIMITREPLAY578S:** Slack rate-limit replay qualification ([#6956](https://github.com/ashlrai/phantom/issues/6956)) ([1100162](https://github.com/ashlrai/phantom/commit/1100162264567b0a5ecd375b4f621415504a5d44))
* **RQ-PHX-SLACKRESPONSEPROOF579S:** RQ-PHX-SLACKRESPONSEPROOF579S ([#6963](https://github.com/ashlrai/phantom/issues/6963)) ([fceedd8](https://github.com/ashlrai/phantom/commit/fceedd836e43e753cb500b73ceb61845082e54ce))
* **RQ-PHX-SLACKTHREADISOLATION578S:** Slack notice thread isolation 578s ([#6959](https://github.com/ashlrai/phantom/issues/6959)) ([cca7e03](https://github.com/ashlrai/phantom/commit/cca7e0301c54833a91d1befe2857099ee323afef))
* **RQ-PHX-SLACKTRACEWORKSTATE631:** RQ-PHX-SLACKTRACEWORKSTATE631 ([#7204](https://github.com/ashlrai/phantom/issues/7204)) ([0763300](https://github.com/ashlrai/phantom/commit/07633009c9a7e4c832b462ae349efac58e172343))
* **RQ-PHX-SPENDLEDGERRECOVER629S:** BRIDGE_NOTES: RQ-PHX-SPENDLEDGERRECOVER629S ([#7163](https://github.com/ashlrai/phantom/issues/7163)) ([dd2c392](https://github.com/ashlrai/phantom/commit/dd2c392a04a7a8c6edb5abb3afe5a6047aa08619))
* **RQ-PHX-UPDATERLAZYRECOVER630S:** RQ-PHX-UPDATERLAZYRECOVER630S: lazy desktop-update API recov ([#7206](https://github.com/ashlrai/phantom/issues/7206)) ([eb57c16](https://github.com/ashlrai/phantom/commit/eb57c163fd413b848ab838b877cb64b76cdb858b))
* **RQ-POOLRUNWAYN19LQ8:** RQ-POOLRUNWAYN19LQ8: per-pool runway and next-job share ([#7026](https://github.com/ashlrai/phantom/issues/7026)) ([c0d729c](https://github.com/ashlrai/phantom/commit/c0d729c2a9923c5e85682d69a420e9b4154b068b))
* **RQ-PRODUCERSN20CQ8:** RQ-PRODUCERSN20CQ8: who is spending each plan ([#7182](https://github.com/ashlrai/phantom/issues/7182)) ([34cd901](https://github.com/ashlrai/phantom/commit/34cd90188885a601e39d4aa546a6925057a6e324))
* RQ-QUEUERECOVERYQ8 ([#6416](https://github.com/ashlrai/phantom/issues/6416)) ([95bb394](https://github.com/ashlrai/phantom/commit/95bb394758f8734aa4d34d08e69e388f7dd42cfc))
* **RQ-RECOVERYDEDUPQ8:** RQ-RECOVERYDEDUPQ8 ([#7008](https://github.com/ashlrai/phantom/issues/7008)) ([8c7d039](https://github.com/ashlrai/phantom/commit/8c7d039d3186ed21e1c52096194a3a127b8401a9))
* **RQ-RECUTPROMPTN18ZQ8:** integrate plan and prompt with unknown-evidence handling ([#6955](https://github.com/ashlrai/phantom/issues/6955)) ([96ad064](https://github.com/ashlrai/phantom/commit/96ad064e27a6132d68e8b282271cef932af65a49))
* **RQ-RELDIRN19HQ8:** RQ-RELDIRN19HQ8 ([#6983](https://github.com/ashlrai/phantom/issues/6983)) ([8016580](https://github.com/ashlrai/phantom/commit/801658040e90c1f43fe621cff49b19cf7498e265))
* **RQ-RELNOTESN19YQ8:** RQ-RELNOTESN19YQ8: plain release notes ([#7138](https://github.com/ashlrai/phantom/issues/7138)) ([3a587ab](https://github.com/ashlrai/phantom/commit/3a587ab349fa707ba39a463394f3896409ac1351))
* **RQ-REPUB619N19YQ8:** BRIDGE_NOTES: RQ-REPUB619N19YQ8 ([#7110](https://github.com/ashlrai/phantom/issues/7110)) ([b8495f6](https://github.com/ashlrai/phantom/commit/b8495f69a0dc05c65c1f39b7798ce447bc73341c))
* **RQ-REPUBDRIFTN19LQ8:** RQ-REPUBDRIFTN19LQ8 ([#7024](https://github.com/ashlrai/phantom/issues/7024)) ([4e1580e](https://github.com/ashlrai/phantom/commit/4e1580e44990c310f5a7fa2938892a61b455ad6e))
* **RQ-REPUBLIBRARYN19QQ8:** RQ-REPUBLIBRARYN19QQ8 ([#7044](https://github.com/ashlrai/phantom/issues/7044)) ([74ccc08](https://github.com/ashlrai/phantom/commit/74ccc08c4fc463f39f124080e42213570e40b420))
* **RQ-REPUBMERGEWAITN19LQ8:** RQ-REPUBMERGEWAITN19LQ8 ([#7022](https://github.com/ashlrai/phantom/issues/7022)) ([37e3052](https://github.com/ashlrai/phantom/commit/37e305257fa346b05b1cae8cd637f155f5091e21))
* **RQ-REPUBMRCN20CQ8:** BRIDGE_NOTES: RQ-REPUBMRCN20CQ8 ([#7194](https://github.com/ashlrai/phantom/issues/7194)) ([9352d81](https://github.com/ashlrai/phantom/commit/9352d8104c9bba552eaa5ae958c0a96984d99e56))
* **RQ-RETRYDEDUPQ8:** RQ-RETRYDEDUPQ8 ([#6984](https://github.com/ashlrai/phantom/issues/6984)) ([406ded1](https://github.com/ashlrai/phantom/commit/406ded143693ad1622bd75492bbd0e80636a4b69))
* **RQ-RUNWAYN19BQ8:** RQ-RUNWAYN19BQ8: steer by pool runway ([#6966](https://github.com/ashlrai/phantom/issues/6966)) ([dffe469](https://github.com/ashlrai/phantom/commit/dffe469d558c876f77c691d4fa71f1f33af73fac))
* **RQ-RUNWAYN19WQ8:** BRIDGE_NOTES: RQ-RUNWAYN19WQ8 ([#7096](https://github.com/ashlrai/phantom/issues/7096)) ([26b4e5f](https://github.com/ashlrai/phantom/commit/26b4e5f40ec28dcabc8328b24c2866b35c1b9880))
* **RQ-SESSIONTREEN18TQ8:** integrate session tree after upstream authority pin repair ([#6919](https://github.com/ashlrai/phantom/issues/6919)) ([096f77d](https://github.com/ashlrai/phantom/commit/096f77d3d57ffa3ab0842e2ba567f06ca14f3ff3))
* **RQ-SESSIONWINN19QQ8:** RQ-SESSIONWINN19QQ8: one window into any job ([#7072](https://github.com/ashlrai/phantom/issues/7072)) ([decbc29](https://github.com/ashlrai/phantom/commit/decbc2920bebfde2a628684eb4e28cfea3c0105b))
* **RQ-SHIPFEEDN19FQ8:** RQ-SHIPFEEDN19FQ8 ([#6975](https://github.com/ashlrai/phantom/issues/6975)) ([97cc5f2](https://github.com/ashlrai/phantom/commit/97cc5f2f4221fddf3c934f2cc8fe736bb81dc9e3))
* **RQ-SOURCEMETERQ8:** RQ-SOURCEMETERQ8 — `phm jobs producers` ([#7185](https://github.com/ashlrai/phantom/issues/7185)) ([c954f4b](https://github.com/ashlrai/phantom/commit/c954f4b9107032913c9da0fe18b54a3cafc96405))
* **RQ-STOPFILEN18XQ8:** integrate stop file and fix optional help catalog detection ([#6946](https://github.com/ashlrai/phantom/issues/6946)) ([9b8beec](https://github.com/ashlrai/phantom/commit/9b8beecdffda5a5e2a4a1d41a0d04f40c567fcaf))
* **RQ-STRANDEDN19NQ8:** RQ-STRANDEDN19NQ8: find finished work that never became a PR ([#7060](https://github.com/ashlrai/phantom/issues/7060)) ([ef373dd](https://github.com/ashlrai/phantom/commit/ef373ddec20169be0adc9336baf35d81310e7a95))
* **RQ-STRANDEDN20BQ8:** RQ-STRANDEDN20BQ8: `phm jobs stranded --json` ([#7147](https://github.com/ashlrai/phantom/issues/7147)) ([65412de](https://github.com/ashlrai/phantom/commit/65412de54f2103e960baace8055d1c5e5b8cfd72))
* **RQ-UPKEEP-DOCS-phantom-20261118:** BRIDGE_NOTES: RQ-UPKEEP-DOCS-phantom-20261118 ([#6973](https://github.com/ashlrai/phantom/issues/6973)) ([629cfab](https://github.com/ashlrai/phantom/commit/629cfabe5eca4ee11675f7e8135fd13e16b76ae9))
* **RQ-USAGEGRAPHN19LQ8:** RQ-USAGEGRAPHN19LQ8: usage spend-down graphs ([#7032](https://github.com/ashlrai/phantom/issues/7032)) ([fce6500](https://github.com/ashlrai/phantom/commit/fce6500f4f71aafb80206580d14b4e8b9b97efa9))
* **RQ-WORKLOGN19NQ8:** RQ-WORKLOGN19NQ8: work log numbers, one command and one pane ([#7062](https://github.com/ashlrai/phantom/issues/7062)) ([b521730](https://github.com/ashlrai/phantom/commit/b5217303c9105a452a922a32bff11c84c10ac0a9))
* **RQ-YIELDDUPN20BQ8:** RQ-YIELDDUPN20BQ8 bridge notes ([#7195](https://github.com/ashlrai/phantom/issues/7195)) ([e55d2c4](https://github.com/ashlrai/phantom/commit/e55d2c49157640630f551041b9898669f55e1e38))


### Documentation

* integrate leader replies registry coverage and current generated reference ([#6977](https://github.com/ashlrai/phantom/issues/6977)) ([c474595](https://github.com/ashlrai/phantom/commit/c4745953a95cfe10d8d9328e49c0ab765cc796f5))
* regenerate CODEMAP for src/core/providers ([#7170](https://github.com/ashlrai/phantom/issues/7170)) ([91f9696](https://github.com/ashlrai/phantom/commit/91f96963354e215a7dbc3a0ea384c364d2feaf63))


### Tests

* repair fast-gate and authority-drift regressions blocking release PR and fleet verify ([#7126](https://github.com/ashlrai/phantom/issues/7126)) ([81a9ffd](https://github.com/ashlrai/phantom/commit/81a9ffd2f735d4cf77496d0fc34ad4cf0dcf77b4))

## [3.30.39] - 2026-11-18


### Changes

* **RQ-MERGEWAIT18Q8:** RQ-MERGEWAIT18Q8 ([#6926](https://github.com/ashlrai/phantom/issues/6926)) ([9be600e](https://github.com/ashlrai/phantom/commit/9be600e7f4627a25defa78d60a97bba616956aa3))
* **RQ-PHX-SLACKENQUEUEEVIDENCE570S:** RQ-PHX-SLACKENQUEUEEVIDENCE570S ([#6923](https://github.com/ashlrai/phantom/issues/6923)) ([49617bd](https://github.com/ashlrai/phantom/commit/49617bdf64e3a7199831789b800573618a603181))
* **RQ-YIELDSTOP18Q8:** RQ-YIELDSTOP18Q8 ([#6924](https://github.com/ashlrai/phantom/issues/6924)) ([99374b6](https://github.com/ashlrai/phantom/commit/99374b62c820835081c76f462306fe87f88b8e25))

## [3.30.38] - 2026-11-18


### Changes

* **RQ-DEVINCLOUD-AUTOTAG1-N17:** ([#6902](https://github.com/ashlrai/phantom/issues/6902)) ([b8bedf4](https://github.com/ashlrai/phantom/commit/b8bedf4353d00a451e56f4e3dbf7280dc00675e7))
* **RQ-DEVINCLOUD-UPGRADEFIX1-N17:** ([#6916](https://github.com/ashlrai/phantom/issues/6916)) ([9b113ae](https://github.com/ashlrai/phantom/commit/9b113aed8130557d3d8a0fe1ee4d56b2eab7e082))
* **RQ-FAMILYYIELDN18RQ8:** RQ-FAMILYYIELDN18RQ8: job yield ([#6905](https://github.com/ashlrai/phantom/issues/6905)) ([46caa2f](https://github.com/ashlrai/phantom/commit/46caa2f6d259a974071035961497a65a7ac756b3))
* **RQ-PHX-SLACKABORTREJECTION564S:** Slack abort rejection bridge ([#6900](https://github.com/ashlrai/phantom/issues/6900)) ([a24d6d4](https://github.com/ashlrai/phantom/commit/a24d6d480d0388ea2783e24de37d4491e15a5504))
* **RQ-PHX-SLACKHEALTHDURABLE569S:** RQ-PHX-SLACKHEALTHDURABLE569S ([#6912](https://github.com/ashlrai/phantom/issues/6912)) ([2c05929](https://github.com/ashlrai/phantom/commit/2c059296901580203b6e237d6b9a4bd249088f87))
* **RQ-PHX-SLACKPARTIALHEALTH567S:** Slack partial notice health — bridge report ([#6903](https://github.com/ashlrai/phantom/issues/6903)) ([4c722cf](https://github.com/ashlrai/phantom/commit/4c722cf3f6fa3c2ad57e5aaca2d41ce495d70713))
* **RQ-PHX-SLACKPREVSTATEWIRE562S:** Slack prior-state factory handoff ([#6897](https://github.com/ashlrai/phantom/issues/6897)) ([1cbb741](https://github.com/ashlrai/phantom/commit/1cbb7410a2a77cdeb92c64d2e442385b2345d41e))
* **RQ-PHX-SLACKREACQUIRE566S:** RQ-PHX-SLACKREACQUIRE566S ([#6901](https://github.com/ashlrai/phantom/issues/6901)) ([4694f96](https://github.com/ashlrai/phantom/commit/4694f96df95bc6739172bd2996f501337323bfa4))
* **RQ-PHX-SLACKRUNOUTAGE563S:** RQ-PHX-SLACKRUNOUTAGE563S ([#6898](https://github.com/ashlrai/phantom/issues/6898)) ([2435fc4](https://github.com/ashlrai/phantom/commit/2435fc4d1e8df7f97604cc007ebc7c2005913e4d))
* **RQ-PHX-SLACKSNAPSHOTWRITE563S:** Snapshot checkpoint health handoff ([#6899](https://github.com/ashlrai/phantom/issues/6899)) ([382cad0](https://github.com/ashlrai/phantom/commit/382cad04dc60acdd4c6b26d1cdea1614f24e8f6e))
* **RQ-PULSEN18RQ8:** RQ-PULSEN18RQ8: fleet Pulse ([#6904](https://github.com/ashlrai/phantom/issues/6904)) ([c59cbb3](https://github.com/ashlrai/phantom/commit/c59cbb3b1b5158cebaff828cde39d7145d1e8b7e))
* **RQ-QUEUEWAIT18Q8:** RQ-QUEUEWAIT18Q8 ([#6914](https://github.com/ashlrai/phantom/issues/6914)) ([67139e7](https://github.com/ashlrai/phantom/commit/67139e784e0cb8c7da212d76c89a78cf3b4e70b8))


### Tests

* **slack:** assert current status digest in owner roundtrip proof ([#6910](https://github.com/ashlrai/phantom/issues/6910)) ([1a9ced3](https://github.com/ashlrai/phantom/commit/1a9ced3ff9ad0ceef248ce56c8e42686e43d7ee8))

## [3.30.37] - 2026-11-18


### Changes

* **RQ-CHANNELSN18BQ8:** RQ-CHANNELSN18BQ8: `phm channels` overview + desktop Channel ([#6810](https://github.com/ashlrai/phantom/issues/6810)) ([b726de2](https://github.com/ashlrai/phantom/commit/b726de21d38b2ce3272bc4670ae4f397cda04118))
* RQ-CLAUDEROUTEQ8 ([#6634](https://github.com/ashlrai/phantom/issues/6634)) ([bfa6cc7](https://github.com/ashlrai/phantom/commit/bfa6cc78884fbd21e3b7e5ac4eab245cdc9bfb41))
* RQ-CONSTRAINT-AUDIT-1 ([#6485](https://github.com/ashlrai/phantom/issues/6485)) ([a9e2a9e](https://github.com/ashlrai/phantom/commit/a9e2a9e7b1e3767b982618699c02dec703d766a7))
* **RQ-DEVINCLOUD-PR6800R-N17:** ([#6804](https://github.com/ashlrai/phantom/issues/6804)) ([5d36545](https://github.com/ashlrai/phantom/commit/5d36545c8e52cc048216e5dc6c475c78b73175bd))
* **RQ-DEVINCLOUD-REDTEST5038-N17:** ([#6808](https://github.com/ashlrai/phantom/issues/6808)) ([fe1b416](https://github.com/ashlrai/phantom/commit/fe1b4165a82c3d0399dc76ee8863448bc2ed07ca))
* **RQ-DEVINCLOUD-SEATRACE-N17:** ([#6813](https://github.com/ashlrai/phantom/issues/6813)) ([1adfa6e](https://github.com/ashlrai/phantom/commit/1adfa6ec72076f4fdeb2e2bd41f57f4d9ed61f92))
* **RQ-LIBRARYN18DQ8:** RQ-LIBRARYN18DQ8: Library (owner, size, show, detail pane) ([#6809](https://github.com/ashlrai/phantom/issues/6809)) ([36da0bd](https://github.com/ashlrai/phantom/commit/36da0bd0bb5789df6b5aebcbb87e444ad7b60b7d))
* RQ-OMLXFITN16IQ8 ([#6480](https://github.com/ashlrai/phantom/issues/6480)) ([5e56af4](https://github.com/ashlrai/phantom/commit/5e56af4e1c72917a52015b4af075a54a6587d2f1))
* RQ-ORGVIEWN18BQ8 ([#6795](https://github.com/ashlrai/phantom/issues/6795)) ([f412018](https://github.com/ashlrai/phantom/commit/f412018662132007872ff5dbfd502438ed2a94d7))
* RQ-REBASE-PHANTOM-1048 ([#5812](https://github.com/ashlrai/phantom/issues/5812)) ([a61814d](https://github.com/ashlrai/phantom/commit/a61814d9874d1aad785e788dc6dc5061392551ac))
* RQ-REBASE-PHANTOM-3294 ([#5831](https://github.com/ashlrai/phantom/issues/5831)) ([94ac56e](https://github.com/ashlrai/phantom/commit/94ac56e62ffe704c3b9b0fc7d1d4a5b006937a6e))
* RQ-REBASE-PHANTOM-3896 ([#5843](https://github.com/ashlrai/phantom/issues/5843)) ([88720c3](https://github.com/ashlrai/phantom/commit/88720c3ddaf70e7609e348ba6f8d13640ce3d606))
* RQ-REBASE-PHANTOM-4036 ([#5855](https://github.com/ashlrai/phantom/issues/5855)) ([1159ae3](https://github.com/ashlrai/phantom/commit/1159ae3fc41ba08bade2f7cc27113e99876b3bed))
* **RQ-RELEASE-TRAIN-UNBLOCK-1:** RQ-RELEASE-TRAIN-UNBLOCK-1 ([#5162](https://github.com/ashlrai/phantom/issues/5162)) ([3c9586f](https://github.com/ashlrai/phantom/commit/3c9586f6a7a16395cfbbd860028638b3146f1500))

## [3.30.36] - 2026-11-17


### Features

* **autofix:** act on Eng Ops incident files ([#6407](https://github.com/ashlrai/phantom/issues/6407)) ([2c41c4a](https://github.com/ashlrai/phantom/commit/2c41c4a2c7aefbc1cdcfa97defd843f2438b3cdd))
* **fleet:** launch queue and launch cost in fleet vitals (integrates [#6431](https://github.com/ashlrai/phantom/issues/6431), [#6428](https://github.com/ashlrai/phantom/issues/6428)) ([#6433](https://github.com/ashlrai/phantom/issues/6433)) ([ee9ba7e](https://github.com/ashlrai/phantom/commit/ee9ba7ed8a5d0c027b3ca93f0dc1144f019b2962))
* **metrics:** add phm metrics prod publication evidence ([#6366](https://github.com/ashlrai/phantom/issues/6366)) ([2e94b4a](https://github.com/ashlrai/phantom/commit/2e94b4a4f5d30f7612fa0a70c6a6efe78dc802f5))
* **router:** add the loopback router gateway ([#6381](https://github.com/ashlrai/phantom/issues/6381)) ([7b7a078](https://github.com/ashlrai/phantom/commit/7b7a078271c5a19e1918c18a8ba44b03846d2dab))
* **security:** add the publish/merge action-class registry ([#6380](https://github.com/ashlrai/phantom/issues/6380)) ([efb0989](https://github.com/ashlrai/phantom/commit/efb0989421c45f53d85d872037fada11dc1f40a4))


### Fixes

* **ci:** RQ-FULLRED3 fleet help and portable checks ([#6339](https://github.com/ashlrai/phantom/issues/6339)) ([c633956](https://github.com/ashlrai/phantom/commit/c63395642fadf6f465732ec3e1e2f56a27713551))
* **ci:** RQ-FULLRED3 iMessage findings clock ([#6359](https://github.com/ashlrai/phantom/issues/6359)) ([29f7ba4](https://github.com/ashlrai/phantom/commit/29f7ba4a3c4f959284417dc1bdf3eabdd6bfc50e))
* **ci:** RQ-FULLRED3 sitemap lastmod ([#6362](https://github.com/ashlrai/phantom/issues/6362)) ([19fe1fc](https://github.com/ashlrai/phantom/commit/19fe1fc77a7d56e0e893edb850141409a84b108e))
* **ci:** RQ-FULLRED3-MAC4 gmail evidence contracts ([#6368](https://github.com/ashlrai/phantom/issues/6368)) ([e567b50](https://github.com/ashlrai/phantom/commit/e567b5040c526d1cad4031be5ef2463cda65bfad))
* **ci:** RQ-FULLRED3-MAC4 recheck reply and orders ([#6369](https://github.com/ashlrai/phantom/issues/6369)) ([7b813b6](https://github.com/ashlrai/phantom/commit/7b813b6dd03afe67d1096a47e07ba32501efdf33))
* **ci:** RQ-FULLRED3-MAC4 runtime contract drifts ([#6371](https://github.com/ashlrai/phantom/issues/6371)) ([e5cebbb](https://github.com/ashlrai/phantom/commit/e5cebbb30bc94e397280db21847e1e1d02651088))
* **ci:** RQ-FULLRED3-MAC4 surface copy contracts ([#6370](https://github.com/ashlrai/phantom/issues/6370)) ([28d5402](https://github.com/ashlrai/phantom/commit/28d5402f9e1fe704bd5dc2d7d1c532117b816863))
* **ci:** size fast-gate fallback shards to the runner ([#6384](https://github.com/ashlrai/phantom/issues/6384)) ([ac1b923](https://github.com/ashlrai/phantom/commit/ac1b9238aa97a2a8a895cd59ad22296daa42069e))
* **publish:** do not arm auto-merge on a head whose CI already failed ([#6406](https://github.com/ashlrai/phantom/issues/6406)) ([aab8a33](https://github.com/ashlrai/phantom/commit/aab8a3315cbbfa86c096f89c8b7da6e6370608eb))
* **release:** admit a tagged sha by package version and release-gate receipt ([#6387](https://github.com/ashlrai/phantom/issues/6387)) ([e7c212a](https://github.com/ashlrai/phantom/commit/e7c212acb7607e218409287c75c1b27f123f663f))
* **release:** cap finalize retries and stop caching the Rust toolchain ([#6382](https://github.com/ashlrai/phantom/issues/6382)) ([0f6143f](https://github.com/ashlrai/phantom/commit/0f6143fc2262d8b0a5b40e2e3e08ca9c0aa03548))
* **release:** finalize with zero reviewers and a KILL check ([#6383](https://github.com/ashlrai/phantom/issues/6383)) ([c59ae01](https://github.com/ashlrai/phantom/commit/c59ae015c084ca4a86bfa7cfebbc61c0a7345082))
* **release:** name finalize runs and page a day of attempts ([#6389](https://github.com/ashlrai/phantom/issues/6389)) ([a8662b1](https://github.com/ashlrai/phantom/commit/a8662b1d1a2e887c50d99329e030804ed3a723a7))
* **release:** retry autorun publish and skip v3.30.34 ([#6375](https://github.com/ashlrai/phantom/issues/6375)) ([a9d0d68](https://github.com/ashlrai/phantom/commit/a9d0d68607f8911a3ac1a6d83c1f61b19ddf3b7f))
* **security:** own the account-home resolver in CODEOWNERS ([#6377](https://github.com/ashlrai/phantom/issues/6377)) ([0d415a8](https://github.com/ashlrai/phantom/commit/0d415a8d5d5940989dd1a009a6b49e7fd05d178e))


### Changes

* **FIXUP-CI-phantom-ci-406917:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-406917 ([#6479](https://github.com/ashlrai/phantom/issues/6479)) ([9933b2b](https://github.com/ashlrai/phantom/commit/9933b2b189a09629725b644fcb72eb50551aa427))
* **FIXUP-CI-phantom-preflight-fixer-639848:** FIXUP-CI-phantom-preflight-fixer-639848 ([#6401](https://github.com/ashlrai/phantom/issues/6401)) ([f6416ef](https://github.com/ashlrai/phantom/commit/f6416efc7cc0e16976e9275b1d4558271f2e4c60))
* **FIXUP-CI-phantom-publish-qualified-ph-846425:** FIXUP-CI publish-qualified-phantom-npm ([#6419](https://github.com/ashlrai/phantom/issues/6419)) ([e8e6249](https://github.com/ashlrai/phantom/commit/e8e62494dc0db30107fd38168df88fc80db5ef54))
* **RQ-ADMITRANKN16DQ8:** RQ-ADMITRANKN16DQ8 ([#6430](https://github.com/ashlrai/phantom/issues/6430)) ([b4cde84](https://github.com/ashlrai/phantom/commit/b4cde8459e52f14135df3405927b22c1c5f8031f))
* **RQ-AGENT-BUS-TRANSPORTS-1:** RQ-AGENT-BUS-TRANSPORTS-1: pluggable bus transports and role ([#6423](https://github.com/ashlrai/phantom/issues/6423)) ([a9168ad](https://github.com/ashlrai/phantom/commit/a9168ad095d27331a8f27d227e80300fcf69ff88))
* **RQ-AGENT-IDENTITY-1:** RQ-AGENT-IDENTITY-1 ([#6438](https://github.com/ashlrai/phantom/issues/6438)) ([dbce584](https://github.com/ashlrai/phantom/commit/dbce5842d18594952e71cc20492e9dc5aa1e7b44))
* **RQ-AGENTMSGSN17PQ8:** RQ-AGENTMSGSN17PQ8: agent-to-agent messages ([#6674](https://github.com/ashlrai/phantom/issues/6674)) ([9559925](https://github.com/ashlrai/phantom/commit/955992563fef94b77363e9a3b1b330c93fe45586))
* **RQ-APPEARANCEN17AQ8:** RQ-APPEARANCEN17AQ8: Settings &gt; Appearance, phone parity, `p ([#6539](https://github.com/ashlrai/phantom/issues/6539)) ([869fe39](https://github.com/ashlrai/phantom/commit/869fe39acea876627efd61b35c8faea0b005f6be))
* **RQ-APPEARANCEN17IQ8:** RQ-APPEARANCEN17IQ8: Settings &gt; Appearance ([#6645](https://github.com/ashlrai/phantom/issues/6645)) ([0f81c38](https://github.com/ashlrai/phantom/commit/0f81c38a14bd21d6118669fb2967910e8b78a50e))
* **RQ-APPSN17VQ8:** RQ-APPSN17VQ8: `phm apps` known-app surface + Apps panel ([#6735](https://github.com/ashlrai/phantom/issues/6735)) ([a7bd49b](https://github.com/ashlrai/phantom/commit/a7bd49ba0b65e4a383fc0ac53e3a44c2438cd5ff))
* **RQ-ASKSN17VQ8:** RQ-ASKSN17VQ8: `phm asks` ([#6730](https://github.com/ashlrai/phantom/issues/6730)) ([76da880](https://github.com/ashlrai/phantom/commit/76da88050c7d96fc968c992e08b7a7bd3fe6ed18))
* **RQ-AUTONOMYN17RQ8:** RQ-AUTONOMYN17RQ8 ([#6690](https://github.com/ashlrai/phantom/issues/6690)) ([fe93532](https://github.com/ashlrai/phantom/commit/fe9353280521696b84a2a1c74f7ac890d5aa0de1))
* **RQ-BATCHSESSN16DQ8:** RQ-BATCHSESSN16DQ8 ([#6424](https://github.com/ashlrai/phantom/issues/6424)) ([274985d](https://github.com/ashlrai/phantom/commit/274985dbf3d612bf42457daed8b819a43933b541))
* **RQ-BETDEDUPN16AQ8:** RQ-BETDEDUPN16AQ8 ([#6458](https://github.com/ashlrai/phantom/issues/6458)) ([d8ddb18](https://github.com/ashlrai/phantom/commit/d8ddb18edf7ba4c0731fbb51fad9fcafe5f7cc48))
* **RQ-BETS-LANE-1:** BRIDGE_NOTES: RQ-BETS-LANE-1 (bets lane and self-awareness l ([#6308](https://github.com/ashlrai/phantom/issues/6308)) ([f5fe350](https://github.com/ashlrai/phantom/commit/f5fe350f3d301c1202a99a9a8a6a3ae22ad54331))
* **RQ-BRANDS-LOGOS-1:** RQ-BRANDS-LOGOS-1: provider brand-logo system ([#6478](https://github.com/ashlrai/phantom/issues/6478)) ([8fc8710](https://github.com/ashlrai/phantom/commit/8fc871041d27d16cffeb61acc1a9947018c82c2b))
* **RQ-CI-AUTOTAG-SKIP-SCOPE-1:** scope skipped-pass to 3 names, pin workflow_run repo/branch ([#6379](https://github.com/ashlrai/phantom/issues/6379)) ([0a95798](https://github.com/ashlrai/phantom/commit/0a95798564d800e533c0f60700eaf021fe250335))
* **RQ-CIFIXRECOVERYQ8:** RQ-CIFIXRECOVERYQ8 ([#6418](https://github.com/ashlrai/phantom/issues/6418)) ([bfd99dc](https://github.com/ashlrai/phantom/commit/bfd99dc757c9a1a80bb5efab48e3ea8be66effdf))
* **RQ-CIRECOVERYQ8:** RQ-CIRECOVERYQ8 ([#6417](https://github.com/ashlrai/phantom/issues/6417)) ([7523dcb](https://github.com/ashlrai/phantom/commit/7523dcb45afb7f9f269c6dace175fa0fe01cd3de))
* **RQ-CLAUDETOKENS17Q8:** RQ-CLAUDETOKENS17Q8 ([#6732](https://github.com/ashlrai/phantom/issues/6732)) ([add6fee](https://github.com/ashlrai/phantom/commit/add6fee95fe41bd15e18762f64e09e3356b4977c))
* **RQ-CMP-DESKTOP-LANE-1:** BRIDGE_NOTES: RQ-CMP-DESKTOP-LANE-1 ([#6422](https://github.com/ashlrai/phantom/issues/6422)) ([53ed50a](https://github.com/ashlrai/phantom/commit/53ed50a4e0dcc1b4fedc7932931361202b550929))
* **RQ-DESKTOP-POLISH-1:** BRIDGE_NOTES — RQ-DESKTOP-POLISH-1 ([#6474](https://github.com/ashlrai/phantom/issues/6474)) ([f2b6107](https://github.com/ashlrai/phantom/commit/f2b61072354f47dafd459ef304ae7841f841934d))
* **RQ-DEVINCLOUD-ACKDOCS-N17:** ([#6610](https://github.com/ashlrai/phantom/issues/6610)) ([d591f86](https://github.com/ashlrai/phantom/commit/d591f8664f194f18d5502095690ef67515b73199))
* **RQ-DEVINCLOUD-ACKEVID-N17:** ([#6615](https://github.com/ashlrai/phantom/issues/6615)) ([0610d66](https://github.com/ashlrai/phantom/commit/0610d66c60da41dd34f61e6a2cd7eef09e6d9566))
* **RQ-DEVINCLOUD-ACPSEAT4-N17:** ([#6718](https://github.com/ashlrai/phantom/issues/6718)) ([43fb469](https://github.com/ashlrai/phantom/commit/43fb469d540f66a85673df31665daef4e91bed76))
* **RQ-DEVINCLOUD-AGENTCHAT-N17:** ([#6567](https://github.com/ashlrai/phantom/issues/6567)) ([478e184](https://github.com/ashlrai/phantom/commit/478e1843689347ac0b7801e312566e53b2b31788))
* **RQ-DEVINCLOUD-APPADAPT6-N17:** ([#6688](https://github.com/ashlrai/phantom/issues/6688)) ([05ed77f](https://github.com/ashlrai/phantom/commit/05ed77fa9cb0f6e9ca136a36747b6dd0731b1f45))
* **RQ-DEVINCLOUD-CATALOGFRESH2-N17:** ([#6696](https://github.com/ashlrai/phantom/issues/6696)) ([9a44191](https://github.com/ashlrai/phantom/commit/9a44191c7dccdaac062ecbd8b726f1dec3a4c460))
* **RQ-DEVINCLOUD-CIRERUN3-N17:** ([#6685](https://github.com/ashlrai/phantom/issues/6685)) ([4c4ff25](https://github.com/ashlrai/phantom/commit/4c4ff257cb724c4636d959b4d1cf4f313a0213e0))
* **RQ-DEVINCLOUD-CIWALL-N17:** ([#6572](https://github.com/ashlrai/phantom/issues/6572)) ([1bc5f18](https://github.com/ashlrai/phantom/commit/1bc5f1804dcd9a4f1e24430cfce701103e156120))
* **RQ-DEVINCLOUD-DAEMONFIX-N17:** ([#6562](https://github.com/ashlrai/phantom/issues/6562)) ([c9389df](https://github.com/ashlrai/phantom/commit/c9389df5ee63f78e5ef976ee8166e6475da22a1f))
* **RQ-DEVINCLOUD-DAEMONPATH-N17:** ([#6598](https://github.com/ashlrai/phantom/issues/6598)) ([f16775b](https://github.com/ashlrai/phantom/commit/f16775b09b6c8d96100ff30c46338265c3e3e115))
* **RQ-DEVINCLOUD-DESKSIGN-N17:** ([#6619](https://github.com/ashlrai/phantom/issues/6619)) ([4d9dcd7](https://github.com/ashlrai/phantom/commit/4d9dcd75c57273becbeca67264442988026417bb))
* **RQ-DEVINCLOUD-DESKUPGRADE3-N17:** ([#6742](https://github.com/ashlrai/phantom/issues/6742)) ([5020faa](https://github.com/ashlrai/phantom/commit/5020faaf8ff48bdd4e96492d0acf5158f6cdaa94))
* **RQ-DEVINCLOUD-DEVINBURN-N17:** ([#6621](https://github.com/ashlrai/phantom/issues/6621)) ([809ce76](https://github.com/ashlrai/phantom/commit/809ce7601a2d49beb63d07230fa960d65a1e75de))
* **RQ-DEVINCLOUD-DEVINCAP-N17:** ([#6552](https://github.com/ashlrai/phantom/issues/6552)) ([aa056ab](https://github.com/ashlrai/phantom/commit/aa056abcdddbd711f6d25895004c6e55e55a7e06))
* **RQ-DEVINCLOUD-EXREADME-N17:** ([#6554](https://github.com/ashlrai/phantom/issues/6554)) ([375b1ae](https://github.com/ashlrai/phantom/commit/375b1aee10ed1b0e79cba4ac89ae209782d9fd95))
* **RQ-DEVINCLOUD-INGRESSDOCS3-N17:** ([#6681](https://github.com/ashlrai/phantom/issues/6681)) ([58f85f6](https://github.com/ashlrai/phantom/commit/58f85f687b74e0009594f082920a3c5a73cc01b6))
* **RQ-DEVINCLOUD-LANEFIX-N17:** ([#6691](https://github.com/ashlrai/phantom/issues/6691)) ([9dc1493](https://github.com/ashlrai/phantom/commit/9dc149324da25c304e1fbec50271560c88136883))
* **RQ-DEVINCLOUD-M3FLAKE2-N17:** ([#6604](https://github.com/ashlrai/phantom/issues/6604)) ([e9e0246](https://github.com/ashlrai/phantom/commit/e9e0246027fc37d7430d52c4e4f56b1b519d7f05))
* **RQ-DEVINCLOUD-MASTERFIX-N17:** ([#6564](https://github.com/ashlrai/phantom/issues/6564)) ([99776b4](https://github.com/ashlrai/phantom/commit/99776b49d9e327c83bfa7b8711184625bee2fdf9))
* **RQ-DEVINCLOUD-MASTERFIX10-N17:** ([#6699](https://github.com/ashlrai/phantom/issues/6699)) ([cfa1be0](https://github.com/ashlrai/phantom/commit/cfa1be0f08bd97a56d4d7eb9b08a5bafe44307da))
* **RQ-DEVINCLOUD-MASTERFIX11-N17:** ([#6712](https://github.com/ashlrai/phantom/issues/6712)) ([c24faec](https://github.com/ashlrai/phantom/commit/c24faec7d20d3cf14ff8ffb3479c11d281b7d196))
* **RQ-DEVINCLOUD-MASTERFIX12-N17:** ([#6724](https://github.com/ashlrai/phantom/issues/6724)) ([034bdb3](https://github.com/ashlrai/phantom/commit/034bdb3a66896bd7ae7c4769738f64a7734f312d))
* **RQ-DEVINCLOUD-MASTERFIX13-N17:** ([#6737](https://github.com/ashlrai/phantom/issues/6737)) ([2d149bb](https://github.com/ashlrai/phantom/commit/2d149bbdd32eddf8e7854874c9bc1b7da352abb9))
* **RQ-DEVINCLOUD-MASTERFIX2-N17:** ([#6580](https://github.com/ashlrai/phantom/issues/6580)) ([efe2142](https://github.com/ashlrai/phantom/commit/efe214274ebdf845756a0de90355b857238dd617))
* **RQ-DEVINCLOUD-MASTERFIX3-N17:** ([#6590](https://github.com/ashlrai/phantom/issues/6590)) ([17eaa74](https://github.com/ashlrai/phantom/commit/17eaa7445b9fd3b6fe64491035e4d2b5d95eb267))
* **RQ-DEVINCLOUD-MASTERFIX5-N17:** ([#6601](https://github.com/ashlrai/phantom/issues/6601)) ([657c8fa](https://github.com/ashlrai/phantom/commit/657c8fa9c4f3455e0b6c6fa4736686a97cbd5d2a))
* **RQ-DEVINCLOUD-MASTERFIX6-N17:** ([#6612](https://github.com/ashlrai/phantom/issues/6612)) ([346ae4c](https://github.com/ashlrai/phantom/commit/346ae4c370f8dfa5ebbbd1cf4ddd5f179759aef0))
* **RQ-DEVINCLOUD-MASTERFIX7-N17:** ([#6613](https://github.com/ashlrai/phantom/issues/6613)) ([1701b6a](https://github.com/ashlrai/phantom/commit/1701b6af90179a49d1c990716e4ae437345ddfa1))
* **RQ-DEVINCLOUD-MASTERFIX8-N17:** ([#6665](https://github.com/ashlrai/phantom/issues/6665)) ([4b9968e](https://github.com/ashlrai/phantom/commit/4b9968e963a2a6145a706712d088924493ac8129))
* **RQ-DEVINCLOUD-MASTERFIX9-N17:** ([#6692](https://github.com/ashlrai/phantom/issues/6692)) ([f91f529](https://github.com/ashlrai/phantom/commit/f91f529442f1c8d6ae2405975f1c02666f208ff8))
* **RQ-DEVINCLOUD-MCPEFF-N17:** ([#6609](https://github.com/ashlrai/phantom/issues/6609)) ([5645356](https://github.com/ashlrai/phantom/commit/564535629295a64fec3a4c8482584dd2f271b3ef))
* **RQ-DEVINCLOUD-MERGETRAIN-N17:** ([#6548](https://github.com/ashlrai/phantom/issues/6548)) ([9607677](https://github.com/ashlrai/phantom/commit/96076779d8856b1471feeb1c5d8b8ce17bc0b038))
* **RQ-DEVINCLOUD-OWNERINGRESS-N17:** ([#6587](https://github.com/ashlrai/phantom/issues/6587)) ([51b5855](https://github.com/ashlrai/phantom/commit/51b5855cfb8fde2a9148b965a4552fd564a760d7))
* **RQ-DEVINCLOUD-PAIRING-N17:** ([#6549](https://github.com/ashlrai/phantom/issues/6549)) ([6a1d0f2](https://github.com/ashlrai/phantom/commit/6a1d0f273a19014eb963349f2b06036383db599a))
* **RQ-DEVINCLOUD-POSTUREPROV-N17:** ([#6702](https://github.com/ashlrai/phantom/issues/6702)) ([964cbcb](https://github.com/ashlrai/phantom/commit/964cbcb45c0b26e72ee04434f0af55bbc9f3596d))
* **RQ-DEVINCLOUD-READERSCOPE-N17:** ([#6713](https://github.com/ashlrai/phantom/issues/6713)) ([dcd7e93](https://github.com/ashlrai/phantom/commit/dcd7e93ad877ad648adb03e61b52f9652e477031))
* **RQ-DEVINCLOUD-RESVIEW-N17:** ([#6676](https://github.com/ashlrai/phantom/issues/6676)) ([900680e](https://github.com/ashlrai/phantom/commit/900680e3ec854a81c546e822afd1fdb6d92b8cdf))
* **RQ-DEVINCLOUD-SLACKDOCS-N17:** ([#6616](https://github.com/ashlrai/phantom/issues/6616)) ([6fae147](https://github.com/ashlrai/phantom/commit/6fae1477eafea53288e49d7fb9380fd86a191f1f))
* **RQ-DEVINCLOUD-SLACKRES2-N17:** ([#6605](https://github.com/ashlrai/phantom/issues/6605)) ([3f64128](https://github.com/ashlrai/phantom/commit/3f6412880c6baff86e96da867a9f29ab29a903b3))
* **RQ-DEVINCLOUD-SPENDDOWN-N17:** ([#6614](https://github.com/ashlrai/phantom/issues/6614)) ([eb8f575](https://github.com/ashlrai/phantom/commit/eb8f575820cf7b305cf487e6ceabaee839f4b020))
* **RQ-DEVINCLOUD-TICKFAST2-N17:** ([#6608](https://github.com/ashlrai/phantom/issues/6608)) ([351f367](https://github.com/ashlrai/phantom/commit/351f36788e234bd57b997c7ac4dde2217187e59b))
* **RQ-DEVINCLOUD-TICKFAST3-N17:** ([#6700](https://github.com/ashlrai/phantom/issues/6700)) ([bf6dcf6](https://github.com/ashlrai/phantom/commit/bf6dcf6751a5230c48424af701f157b8a773d979))
* **RQ-DEVINCLOUD-TIERS-N17:** ([#6556](https://github.com/ashlrai/phantom/issues/6556)) ([5648603](https://github.com/ashlrai/phantom/commit/5648603209a788f740dd795847984c3768a4e81d))
* **RQ-DEVINCLOUD-USAGE-N17:** ([#6557](https://github.com/ashlrai/phantom/issues/6557)) ([008c401](https://github.com/ashlrai/phantom/commit/008c401cf169da5640033bc5638a753f9d3bca24))
* **RQ-DEVINCLOUD-USAGEHIST-N17:** ([#6569](https://github.com/ashlrai/phantom/issues/6569)) ([91b6893](https://github.com/ashlrai/phantom/commit/91b6893a7891ca7b250bcde5ee407549cef6eba6))
* **RQ-DEVINCLOUD-WEBFIX-N17:** ([#6583](https://github.com/ashlrai/phantom/issues/6583)) ([a48f5f5](https://github.com/ashlrai/phantom/commit/a48f5f5ef33a3b75910f80cdccb5a9e7dd6f1868))
* **RQ-DEVINCLOUD-WEBFIX3-N17:** ([#6620](https://github.com/ashlrai/phantom/issues/6620)) ([be2f3db](https://github.com/ashlrai/phantom/commit/be2f3db8fe33305fe8abde615ad2e48156887c0c))
* **RQ-DISKBURNN16AQ8:** RQ-DISKBURNN16AQ8 ([#6427](https://github.com/ashlrai/phantom/issues/6427)) ([a1db854](https://github.com/ashlrai/phantom/commit/a1db854fcb294ed66f9bd24f6946348a71ff4db8))
* **RQ-DISKGROWTHN17Q8:** RQ-DISKGROWTHN17Q8 ([#6576](https://github.com/ashlrai/phantom/issues/6576)) ([b919d79](https://github.com/ashlrai/phantom/commit/b919d79f4042a5af12b5956ed2249ef89f51fb1c))
* **RQ-DOCSNEWN17VQ8:** RQ-DOCSNEWN17VQ8 ([#6726](https://github.com/ashlrai/phantom/issues/6726)) ([3a737f0](https://github.com/ashlrai/phantom/commit/3a737f0679c943511dff76caf3f32b3d0ff3d68d))
* **RQ-EMPTYCAUSEN16LQ8:** RQ-EMPTYCAUSEN16LQ8: typed causes for empty jobs ([#6512](https://github.com/ashlrai/phantom/issues/6512)) ([92e4d56](https://github.com/ashlrai/phantom/commit/92e4d5651ec8971ff62ad07ab725fd38a22443ce))
* **RQ-EMPTYCUTN16EQ8:** RQ-EMPTYCUTN16EQ8 ([#6437](https://github.com/ashlrai/phantom/issues/6437)) ([98fd192](https://github.com/ashlrai/phantom/commit/98fd1929a6544cc52ea82e4b1ee506927367f4cb))
* **RQ-EMPTYWHYN17NQ8:** RQ-EMPTYWHYN17NQ8: `phm empties` ([#6661](https://github.com/ashlrai/phantom/issues/6661)) ([81049fc](https://github.com/ashlrai/phantom/commit/81049fc7f3a5de039cfbe30bad49998f875fb6a3))
* **RQ-FEEDVIEWN17HQ8:** RQ-FEEDVIEWN17HQ8 ([#6626](https://github.com/ashlrai/phantom/issues/6626)) ([e002d0f](https://github.com/ashlrai/phantom/commit/e002d0f80521250a1129b9c3cc55006c9d273e53))
* **RQ-FIX-6390-URL-STRIP-ORDER:** Bridge notes ([#6432](https://github.com/ashlrai/phantom/issues/6432)) ([c506ace](https://github.com/ashlrai/phantom/commit/c506ace9db0ff51a900dfdec852b9488616fc4ce))
* **RQ-FLEET-AWARE-1:** RQ-FLEET-AWARE-1 ([#6471](https://github.com/ashlrai/phantom/issues/6471)) ([0177f5e](https://github.com/ashlrai/phantom/commit/0177f5e462a02e2c3f6e4d939fe55d6282aa220b))
* **RQ-GOALSVIEWN17EQ8:** RQ-GOALSVIEWN17EQ8: Goals screen (fleet scorecard) ([#6647](https://github.com/ashlrai/phantom/issues/6647)) ([f54d33c](https://github.com/ashlrai/phantom/commit/f54d33cc76cd93c785534ef57f9f7ec9eb40c7cc))
* **RQ-HOMEVIEWN17TQ8:** RQ-HOMEVIEWN17TQ8: `phm home` and the desktop Home view ([#6717](https://github.com/ashlrai/phantom/issues/6717)) ([2e53c92](https://github.com/ashlrai/phantom/commit/2e53c924aa3c45da9d692ae5e4f52299f404264b))
* **RQ-IMESSAGE-VITALS-DIGEST-1:** fix(comms): bound and sanitize the teammate fleet-vitals dig ([#6390](https://github.com/ashlrai/phantom/issues/6390)) ([7953848](https://github.com/ashlrai/phantom/commit/79538487910c8ef9f99a1f27a0a359d7b42757da))
* **RQ-IMSGCONVN16JQ8:** RQ-IMSGCONVN16JQ8: conversational iMessage teammate replies ([#6493](https://github.com/ashlrai/phantom/issues/6493)) ([d95fc9a](https://github.com/ashlrai/phantom/commit/d95fc9a843037502e18eb0126143c0d9d3aa2ce6))
* **RQ-INTERJECTN17PQ8:** RQ-INTERJECTN17PQ8: one Leader thread ([#6677](https://github.com/ashlrai/phantom/issues/6677)) ([30a99f7](https://github.com/ashlrai/phantom/commit/30a99f7c7a0068e0d0febb38aace6281bf402724))
* **RQ-JOB-MAX-RUNTIME-1:** RQ-JOB-MAX-RUNTIME-1: per-job max runtime watchdog ([#6410](https://github.com/ashlrai/phantom/issues/6410)) ([4fc0c1b](https://github.com/ashlrai/phantom/commit/4fc0c1b8288fb2e0322a2fd402f29c0c81ca8e67))
* **RQ-JOBCTLN17TQ8:** RQ-JOBCTLN17TQ8: steer a running job ([#6716](https://github.com/ashlrai/phantom/issues/6716)) ([78c3867](https://github.com/ashlrai/phantom/commit/78c3867c0aaaab9d74d64b40450b7540893d54ed))
* **RQ-LANEBUDGETQ8:** RQ-LANEBUDGETQ8 bridge notes ([#6411](https://github.com/ashlrai/phantom/issues/6411)) ([7d5c22b](https://github.com/ashlrai/phantom/commit/7d5c22b009f00b2fbc029efa2d8ebf334f6259dc))
* **RQ-LANECAPSN16LQ8:** BRIDGE_NOTES: RQ-LANECAPSN16LQ8 ([#6511](https://github.com/ashlrai/phantom/issues/6511)) ([aaf6ee2](https://github.com/ashlrai/phantom/commit/aaf6ee21d60ba28622aafa92c619ea980b8da403))
* **RQ-LEADERREPLYN16NQ8:** RQ-LEADERREPLYN16NQ8: leader replies reach the Leader thread ([#6536](https://github.com/ashlrai/phantom/issues/6536)) ([aecf53e](https://github.com/ashlrai/phantom/commit/aecf53e77b35ae76650372b2ff4442e92e35a8b3))
* **RQ-LIBRARYVIEWN17IQ8:** - Added one typed Library projection for CLI/desktop: four k ([#6646](https://github.com/ashlrai/phantom/issues/6646)) ([dec9520](https://github.com/ashlrai/phantom/commit/dec952007bc028bca8a1095c6614b376b78577b9))
* **RQ-LIVEMAPN17TQ8:** RQ-LIVEMAPN17TQ8: `phm map` and the desktop Map pane ([#6715](https://github.com/ashlrai/phantom/issues/6715)) ([10b4f31](https://github.com/ashlrai/phantom/commit/10b4f311ea720bf894f94d0d1857d142fe4dd850))
* **RQ-MASTERREDSN17RQ8:** RQ-MASTERREDSN17RQ8 ([#6689](https://github.com/ashlrai/phantom/issues/6689)) ([12804c4](https://github.com/ashlrai/phantom/commit/12804c42f4f0ee988518f84aa076ca270fcbb19d))
* **RQ-MERGEFLOWN17Q8:** RQ-MERGEFLOWN17Q8 ([#6669](https://github.com/ashlrai/phantom/issues/6669)) ([0cd3938](https://github.com/ashlrai/phantom/commit/0cd3938474ec8813740b3bbb52f553c2283e1367))
* **RQ-MERGELATENCYN16Q8:** RQ-MERGELATENCYN16Q8 ([#6429](https://github.com/ashlrai/phantom/issues/6429)) ([e572399](https://github.com/ashlrai/phantom/commit/e572399e4477b0b258264b5e15db57989f23f920))
* **RQ-MERGELATENCYN17KQ8Q8:** RQ-MERGELATENCYN17KQ8Q8 ([#6643](https://github.com/ashlrai/phantom/issues/6643)) ([c655bc4](https://github.com/ashlrai/phantom/commit/c655bc428ae2cfd17a2f676c5d7c57f6a19d612a))
* **RQ-MERGEWAIT17Q8:** RQ-MERGEWAIT17Q8 ([#6599](https://github.com/ashlrai/phantom/issues/6599)) ([1016939](https://github.com/ashlrai/phantom/commit/1016939f4701f280e6bb120c263c886702c44900))
* **RQ-METRICSGRAPHN17BQ8:** RQ-METRICSGRAPHN17BQ8 ([#6546](https://github.com/ashlrai/phantom/issues/6546)) ([fee22fb](https://github.com/ashlrai/phantom/commit/fee22fbb245f4fed023ee6e0bbf0b9245778ebb0))
* **RQ-MIDYIELD17Q8:** RQ-MIDYIELD17Q8 ([#6727](https://github.com/ashlrai/phantom/issues/6727)) ([990f190](https://github.com/ashlrai/phantom/commit/990f190a30c6d1d2c50f9bf8441b7e851f92a45f))
* RQ-MODELREGN17VQ8 ([#6734](https://github.com/ashlrai/phantom/issues/6734)) ([49bb3b7](https://github.com/ashlrai/phantom/commit/49bb3b7409b8ad453b26433e4ca360e2174d69be))
* **RQ-MODELVERIFYN17NQ8:** RQ-MODELVERIFYN17NQ8 — partial source handoff; uncommitted. ([#6659](https://github.com/ashlrai/phantom/issues/6659)) ([6a01c80](https://github.com/ashlrai/phantom/commit/6a01c80811d0a8b21a95ff5e13f3e016ab4f98fe))
* **RQ-NEXTBETSN17XQ8:** RQ-NEXTBETSN17XQ8: `phm bets suggest` and `phm bets explain` ([#6746](https://github.com/ashlrai/phantom/issues/6746)) ([f20a742](https://github.com/ashlrai/phantom/commit/f20a74247c3740d0d5610e431d71f830194a4d51))
* **RQ-NODEPLACE17Q8:** RQ-NODEPLACE17Q8 ([#6729](https://github.com/ashlrai/phantom/issues/6729)) ([aa0fc00](https://github.com/ashlrai/phantom/commit/aa0fc00bd0ab1236213430cc3b5395664828b1bc))
* **RQ-NODESN17RQ8:** RQ-NODESN17RQ8: `phm nodes` and the desktop Computers pane ([#6701](https://github.com/ashlrai/phantom/issues/6701)) ([640d89e](https://github.com/ashlrai/phantom/commit/640d89e35ff152234bb95b9066bd479964b1be58))
* **RQ-NOTIFYROUTEN17NQ8:** RQ-NOTIFYROUTEN17NQ8 ([#6658](https://github.com/ashlrai/phantom/issues/6658)) ([385b49b](https://github.com/ashlrai/phantom/commit/385b49bcc5169a5d934c4fdc77e3486cb403dae0))
* **RQ-ORGMAPN16LQ8:** RQ-ORGMAPN16LQ8 ([#6514](https://github.com/ashlrai/phantom/issues/6514)) ([eba7fb4](https://github.com/ashlrai/phantom/commit/eba7fb4d222a312cca01d40d4a25188fbbd66932))
* **RQ-ORGVIEWN17NQ8:** RQ-ORGVIEWN17NQ8 ([#6663](https://github.com/ashlrai/phantom/issues/6663)) ([1388309](https://github.com/ashlrai/phantom/commit/1388309447f3a243af1180290e503b4d73545410))
* **RQ-PH-RELPREP-RATELIMIT-RETRY-1:** Release prep retry handoff ([#6397](https://github.com/ashlrai/phantom/issues/6397)) ([2a5c475](https://github.com/ashlrai/phantom/commit/2a5c47588e10b4caac885e3abf109c20860bbf4e))
* **RQ-PHX-ASOFLABEL524:** Bridge notes ([#6630](https://github.com/ashlrai/phantom/issues/6630)) ([a214661](https://github.com/ashlrai/phantom/commit/a214661f555917b89a1fce2c465ff37d26eeadf1))
* **RQ-PHX-BINDINGOUTAGEREPLAY488S:** RQ-PHX-BINDINGOUTAGEREPLAY488S ([#6445](https://github.com/ashlrai/phantom/issues/6445)) ([45cd3f0](https://github.com/ashlrai/phantom/commit/45cd3f065d6c63e8d4e79cfbbe977d592fe83c8a))
* **RQ-PHX-BLOCKERCHANGE491S:** RQ-PHX-BLOCKERCHANGE491S ([#6499](https://github.com/ashlrai/phantom/issues/6499)) ([c2ace01](https://github.com/ashlrai/phantom/commit/c2ace016db879ce9af7f6f25098af02dff4f3868))
* **RQ-PHX-CLAIMDESKTOPROUNDTRIP536S:** RQ-PHX-CLAIMDESKTOPROUNDTRIP536S ([#6708](https://github.com/ashlrai/phantom/issues/6708)) ([2694514](https://github.com/ashlrai/phantom/commit/26945148659da9a1a11b6a676027cbb955fc17e8))
* **RQ-PHX-CLAIMDRIFTDISKRETURN537S:** RQ-PHX-CLAIMDRIFTDISKRETURN537S ([#6719](https://github.com/ashlrai/phantom/issues/6719)) ([93792e8](https://github.com/ashlrai/phantom/commit/93792e8fb3ecea12c7d6e3556494e188328f6a3a))
* **RQ-PHX-CLAIMMCPSETTLERETURN536S:** RQ-PHX-CLAIMMCPSETTLERETURN536S ([#6714](https://github.com/ashlrai/phantom/issues/6714)) ([9a38673](https://github.com/ashlrai/phantom/commit/9a3867302ba97aac1a6926292129026c12215990))
* **RQ-PHX-LAUNCHSTALLWHY524:** RQ-PHX-LAUNCHSTALLWHY524 ([#6627](https://github.com/ashlrai/phantom/issues/6627)) ([d46ffe7](https://github.com/ashlrai/phantom/commit/d46ffe78b61b116d19aa2e68b01599ce0f25aa10))
* **RQ-PHX-LIBRARYSOURCEQUALIFY522S:** BRIDGE_NOTES: RQ-PHX-LIBRARYSOURCEQUALIFY522S ([#6625](https://github.com/ashlrai/phantom/issues/6625)) ([1feaf9c](https://github.com/ashlrai/phantom/commit/1feaf9c9ad7c8dfb7b2123fb34e186590824c720))
* **RQ-PHX-MCPCOLDOWNER524S:** RQ-PHX-MCPCOLDOWNER524S ([#6632](https://github.com/ashlrai/phantom/issues/6632)) ([f5a93f9](https://github.com/ashlrai/phantom/commit/f5a93f93be3724210f157b6ea1eda670b3eed984))
* **RQ-PHX-MCPCOLDRESTART530S:** RQ-PHX-MCPCOLDRESTART530S ([#6655](https://github.com/ashlrai/phantom/issues/6655)) ([030091b](https://github.com/ashlrai/phantom/commit/030091b706e1be9cb33a3c2459747c10d6f3d4c0))
* **RQ-PHX-NOTICEBURSTRETURN490S:** RQ-PHX-NOTICEBURSTRETURN490S ([#6495](https://github.com/ashlrai/phantom/issues/6495)) ([822236d](https://github.com/ashlrai/phantom/commit/822236de1a341b3eac139a69cd86fe150e41a764))
* **RQ-PHX-NOTICECONFIGRESUME494S:** RQ-PHX-NOTICECONFIGRESUME494S ([#6501](https://github.com/ashlrai/phantom/issues/6501)) ([3f9baa2](https://github.com/ashlrai/phantom/commit/3f9baa2111e0a7e005dabd56a4ddad19fe786df2))
* **RQ-PHX-NOTICECROSSREPOSTHREAD495S:** RQ-PHX-NOTICECROSSREPOSTHREAD495S ([#6503](https://github.com/ashlrai/phantom/issues/6503)) ([6a37abe](https://github.com/ashlrai/phantom/commit/6a37abe0e752865b7c921cdff46d35e48d10d403))
* **RQ-PHX-NOTICEDRYRUNRECOVERY486S:** Claim notice dry-run recovery ([#6460](https://github.com/ashlrai/phantom/issues/6460)) ([fe90302](https://github.com/ashlrai/phantom/commit/fe903029548aead8ac3f8aa37b43d08f38ae365a))
* **RQ-PHX-NOTICEEXACTDELIVERY489S:** RQ-PHX-NOTICEEXACTDELIVERY489S ([#6494](https://github.com/ashlrai/phantom/issues/6494)) ([dc1d54d](https://github.com/ashlrai/phantom/commit/dc1d54dd468dec72ff1b87c1c3698fc262f7f5df))
* **RQ-PHX-NOTICEKILLRESUME494S:** RQ-PHX-NOTICEKILLRESUME494S ([#6502](https://github.com/ashlrai/phantom/issues/6502)) ([3ca4912](https://github.com/ashlrai/phantom/commit/3ca4912187ac2a71a4efcc67cc7f874270bdce87))
* **RQ-PHX-NOTICEPARTIALRESTART485S:** RQ-PHX-NOTICEPARTIALRESTART485S ([#6449](https://github.com/ashlrai/phantom/issues/6449)) ([1ab7afc](https://github.com/ashlrai/phantom/commit/1ab7afc5a50900d048f51a53952e708723fb2677))
* **RQ-PHX-NOTICEPREVOUTAGE492S:** PREV outage recovery ([#6496](https://github.com/ashlrai/phantom/issues/6496)) ([fead2fd](https://github.com/ashlrai/phantom/commit/fead2fd891d7370d5bc82092710c18689b7b114a))
* **RQ-PHX-NOTICESNAPSHOTWRITE493S:** RQ-PHX-NOTICESNAPSHOTWRITE493S ([#6519](https://github.com/ashlrai/phantom/issues/6519)) ([92c46d6](https://github.com/ashlrai/phantom/commit/92c46d6496de31770c8861cbce80b204656f57e7))
* **RQ-PHX-NOTICETEAMFENCERESTART495S:** RQ-PHX-NOTICETEAMFENCERESTART495S ([#6504](https://github.com/ashlrai/phantom/issues/6504)) ([b0904be](https://github.com/ashlrai/phantom/commit/b0904be39770ac65f21f9825f50b0fea30e3ccba))
* **RQ-PHX-ORDERPROVENANCE533S:** Order work-state provenance qualification ([#6698](https://github.com/ashlrai/phantom/issues/6698)) ([717499e](https://github.com/ashlrai/phantom/commit/717499ef2c4f61c8719b45172318f50de69435e9))
* **RQ-PHX-RECUTCLIC482:** RQ-PHX-RECUTCLIC482 ([#6326](https://github.com/ashlrai/phantom/issues/6326)) ([8d620d9](https://github.com/ashlrai/phantom/commit/8d620d9a2997b966edcb50ce19dc428f6ae51018))
* **RQ-PHX-RECUTCOMMSC514:** RQ-PHX-RECUTCOMMSC514 ([#6591](https://github.com/ashlrai/phantom/issues/6591)) ([4333486](https://github.com/ashlrai/phantom/commit/43334865794460aea42d152b874eb5cdcb61ca57))
* **RQ-PHX-RECUTCOREC497:** RQ-PHX-RECUTCOREC497 ([#6509](https://github.com/ashlrai/phantom/issues/6509)) ([ac8afda](https://github.com/ashlrai/phantom/commit/ac8afdaa12ad5161dd86df329b5ca471eff5911a))
* **RQ-PHX-RECUTCOREFLEETC515:** RQ-PHX-RECUTCOREFLEETC515 — bridge notes ([#6582](https://github.com/ashlrai/phantom/issues/6582)) ([152405b](https://github.com/ashlrai/phantom/commit/152405b1b43b6122f4e80299bc51b9fabf5b4056))
* **RQ-PHX-RECUTCOREFLEETC531:** Supersedes [#6306](https://github.com/ashlrai/phantom/issues/6306) ([#6667](https://github.com/ashlrai/phantom/issues/6667)) ([536b33d](https://github.com/ashlrai/phantom/commit/536b33ddd146e80e398d84c5263627a83c6c8b5f))
* **RQ-PHX-RECUTFLEETCLIC488:** RQ-PHX-RECUTFLEETCLIC488 ([#6486](https://github.com/ashlrai/phantom/issues/6486)) ([c4274e9](https://github.com/ashlrai/phantom/commit/c4274e992ace545329fbc8c5234eb9d166690b52))
* **RQ-PHX-RECUTFLEETCLIC501:** RQ-PHX-RECUTFLEETCLIC501 ([#6525](https://github.com/ashlrai/phantom/issues/6525)) ([81da8ec](https://github.com/ashlrai/phantom/commit/81da8ec111a27978bb3bbc45866de26163d7c619))
* **RQ-PHX-RECUTLEADERC533:** RQ-PHX-RECUTLEADERC533 ([#6684](https://github.com/ashlrai/phantom/issues/6684)) ([9311436](https://github.com/ashlrai/phantom/commit/93114366fde644f7d7ce363deb117dfadfdb0092))
* **RQ-PHX-RECUTSCRIPTSC497:** RQ-PHX-RECUTSCRIPTSC497 ([#6516](https://github.com/ashlrai/phantom/issues/6516)) ([38b23ff](https://github.com/ashlrai/phantom/commit/38b23ffe4bef4b26b1e4f1a757fca06769dfcb43))
* **RQ-PHX-RECUTSCRIPTSC509:** RQ-PHX-RECUTSCRIPTSC509 ([#6588](https://github.com/ashlrai/phantom/issues/6588)) ([b8de271](https://github.com/ashlrai/phantom/commit/b8de2716a5fdb1ef90a15f18487516e7e344ab60))
* **RQ-PHX-RECUTTESTONLYC456:** RQ-PHX-RECUTTESTONLYC456 ([#6440](https://github.com/ashlrai/phantom/issues/6440)) ([9ca2e99](https://github.com/ashlrai/phantom/commit/9ca2e991338a7a9e7a577071fdfd74b63ce2e93e))
* **RQ-PHX-RECUTTESTONLYC536:** Supersedes [#6639](https://github.com/ashlrai/phantom/issues/6639) ([#6706](https://github.com/ashlrai/phantom/issues/6706)) ([d59acaf](https://github.com/ashlrai/phantom/commit/d59acaf75e2613f1f8dbcb8b493b731c2013c127))
* **RQ-PHX-RECUTVERSEC458:** RQ-PHX-RECUTVERSEC458 ([#6442](https://github.com/ashlrai/phantom/issues/6442)) ([f35470d](https://github.com/ashlrai/phantom/commit/f35470db981882ca400aea9179fd307b3a5b14b9))
* **RQ-PHX-RECUTVERSEC501:** RQ-PHX-RECUTVERSEC501 ([#6526](https://github.com/ashlrai/phantom/issues/6526)) ([015fe29](https://github.com/ashlrai/phantom/commit/015fe29307e22497a8824ff39a6fe0f57af54a87))
* **RQ-PHX-RECUTVERSEC533:** RQ-PHX-RECUTVERSEC533 ([#6704](https://github.com/ashlrai/phantom/issues/6704)) ([53f32ba](https://github.com/ashlrai/phantom/commit/53f32ba52e1217858d2605403dceebfbf6d051e4))
* **RQ-PHX-RECUTWEBUIC489:** RQ-PHX-RECUTWEBUIC489 ([#6487](https://github.com/ashlrai/phantom/issues/6487)) ([d048f55](https://github.com/ashlrai/phantom/commit/d048f55f814b4fb980001f617bd9725116c3f699))
* **RQ-PHX-RECUTWEBUIC529:** RQ-PHX-RECUTWEBUIC529 ([#6662](https://github.com/ashlrai/phantom/issues/6662)) ([a912b46](https://github.com/ashlrai/phantom/commit/a912b4636f3dc101254d16596775a93e4e6f78fa))
* **RQ-PHX-REDTESTFIXC503:** RQ-PHX-REDTESTFIXC503 ([#6541](https://github.com/ashlrai/phantom/issues/6541)) ([b3599b6](https://github.com/ashlrai/phantom/commit/b3599b6814eea875c0545f7816d005e13b944627))
* **RQ-PHX-REDTESTFIXC529:** RQ-PHX-REDTESTFIXC529 ([#6656](https://github.com/ashlrai/phantom/issues/6656)) ([eef7bea](https://github.com/ashlrai/phantom/commit/eef7beae87c62b419f137ff5cc941222ca82caa7))
* **RQ-PHX-REDTESTFIXC532:** RQ-PHX-REDTESTFIXC532 — REDTESTFIX selection report ([#6671](https://github.com/ashlrai/phantom/issues/6671)) ([aff5145](https://github.com/ashlrai/phantom/commit/aff5145f88c07d3ba994657ac6792b6ce70d0dfe))
* **RQ-PHX-REPOIDENTITYREPLAY488S:** BRIDGE_NOTES: RQ-PHX-REPOIDENTITYREPLAY488S ([#6448](https://github.com/ashlrai/phantom/issues/6448)) ([bc181fb](https://github.com/ashlrai/phantom/commit/bc181fb931aa0c5fc47ed2fb53b50f3eb6c9fb2c))
* **RQ-PHX-RESULTCHAINQUALIFY528S:** RQ-PHX-RESULTCHAINQUALIFY528S ([#6652](https://github.com/ashlrai/phantom/issues/6652)) ([5c105ae](https://github.com/ashlrai/phantom/commit/5c105aea4064d6e3a01d38a942a3568cfbe7152a))
* **RQ-PHX-RESULTCORRECTION520S:** RQ-PHX-RESULTCORRECTION520S — continuation of [#6497](https://github.com/ashlrai/phantom/issues/6497) ([#6641](https://github.com/ashlrai/phantom/issues/6641)) ([ce21ad9](https://github.com/ashlrai/phantom/commit/ce21ad9187da23a59b413e3194c2f4ee3226f4bc))
* **RQ-PHX-RETURNHEADCONFLICT539S:** RQ-PHX-RETURNHEADCONFLICT539S ([#6736](https://github.com/ashlrai/phantom/issues/6736)) ([46b5ded](https://github.com/ashlrai/phantom/commit/46b5ded1404271990d335c0ad056dcc4ebf8cf02))
* **RQ-PHX-RETURNSGETREADONLY538S:** RQ-PHX-RETURNSGETREADONLY538S ([#6722](https://github.com/ashlrai/phantom/issues/6722)) ([672cbfb](https://github.com/ashlrai/phantom/commit/672cbfbc51bfad999cecea00ab3744fb2a9a11c3))
* **RQ-PHX-RETURNSTEMPORAL539S:** RQ-PHX-RETURNSTEMPORAL539S: stale GitHub-verified receipts c ([#6739](https://github.com/ashlrai/phantom/issues/6739)) ([2aa2aa1](https://github.com/ashlrai/phantom/commit/2aa2aa18437cf9baacc48ee49b1def7246c9ce38))
* **RQ-PHX-RUNNINGCLAIMPROOF531S:** Running claim proof ([#6670](https://github.com/ashlrai/phantom/issues/6670)) ([5db3546](https://github.com/ashlrai/phantom/commit/5db3546748ae1b7cf20b5b92da9d3b625673018b))
* **RQ-PHX-RUNTIMEAPICLOCK533S:** Runtime identity API source-clock qualification ([#6678](https://github.com/ashlrai/phantom/issues/6678)) ([35323d1](https://github.com/ashlrai/phantom/commit/35323d1e12a490e44a81a5beb181a7aa8493dfa7))
* **RQ-PHX-RUNTIMECLIOUTPUTQUALIFY534S:** Runtime identity CLI qualification ([#6679](https://github.com/ashlrai/phantom/issues/6679)) ([1c7241e](https://github.com/ashlrai/phantom/commit/1c7241e3ac77585155e7d5020e746d5d5cead1a0))
* **RQ-PHX-RUNTIMEPATHBIND535S:** RQ-PHX-RUNTIMEPATHBIND535S ([#6705](https://github.com/ashlrai/phantom/issues/6705)) ([4c1f1f2](https://github.com/ashlrai/phantom/commit/4c1f1f2c772ab009bdc7ed2e065a0795f940c9dd))
* **RQ-PHX-RUNTIMEPROOFQUALIFY529S:** BRIDGE_NOTES: RQ-PHX-RUNTIMEPROOFQUALIFY529S ([#6651](https://github.com/ashlrai/phantom/issues/6651)) ([e97f60a](https://github.com/ashlrai/phantom/commit/e97f60a975c8f00d2edaa0eadcc3286960ec1398))
* **RQ-PHX-SLACKABORTRETURN499S:** RQ-PHX-SLACKABORTRETURN499S ([#6520](https://github.com/ashlrai/phantom/issues/6520)) ([20ab1cc](https://github.com/ashlrai/phantom/commit/20ab1cc8fce933f5162a51a8608366755ad4b38a))
* **RQ-PHX-SLACKAUDIENCERETURN503S:** Slack audience return qualification ([#6540](https://github.com/ashlrai/phantom/issues/6540)) ([8f30729](https://github.com/ashlrai/phantom/commit/8f30729c0c1a5ef6237d2b102b83adc590a0b567))
* **RQ-PHX-SLACKBRIDGEREPAIRTRANSPORT483S:** Slack bridge ledger transport recovery ([#6444](https://github.com/ashlrai/phantom/issues/6444)) ([8b94b64](https://github.com/ashlrai/phantom/commit/8b94b640ce9be1a9c13b6ded19399a2ac8478ca9))
* **RQ-PHX-SLACKCAUSALDISKREPAIR496S:** RQ-PHX-SLACKCAUSALDISKREPAIR496S ([#6505](https://github.com/ashlrai/phantom/issues/6505)) ([61eae1a](https://github.com/ashlrai/phantom/commit/61eae1aa58a508c98836e326b781bd634921d10a))
* **RQ-PHX-SLACKFUTURERECEIPTRECOVERY502S:** RQ-PHX-SLACKFUTURERECEIPTRECOVERY502S ([#6535](https://github.com/ashlrai/phantom/issues/6535)) ([fd320f6](https://github.com/ashlrai/phantom/commit/fd320f619e2c67bf5fcbc0fd3a962637ed571fa6))
* **RQ-PHX-SLACKORDERPROCESSIDENTITY482S:** Slack orders process identity qualification ([#6443](https://github.com/ashlrai/phantom/issues/6443)) ([acaf566](https://github.com/ashlrai/phantom/commit/acaf5669d55872568eabcd00d0acdefa7e75e353))
* **RQ-PHX-SLACKOVERLAPRETURN504S:** RQ-PHX-SLACKOVERLAPRETURN504S ([#6543](https://github.com/ashlrai/phantom/issues/6543)) ([fe1981b](https://github.com/ashlrai/phantom/commit/fe1981b20d780d1e16ad0b1b4ecacadf427330b0))
* **RQ-PHX-SLACKOWNERQUALIFY518S:** Slack owner handoff qualification — RQ-PHX-SLACKOWNERQUALIFY ([#6607](https://github.com/ashlrai/phantom/issues/6607)) ([5c8b573](https://github.com/ashlrai/phantom/commit/5c8b573cfbb9cef7a9833c73e29549f18d9435a1))
* **RQ-PHX-SLACKPAGEDRECOVERY504S:** RQ-PHX-SLACKPAGEDRECOVERY504S ([#6545](https://github.com/ashlrai/phantom/issues/6545)) ([6972bbd](https://github.com/ashlrai/phantom/commit/6972bbd230fd8f6d769a951618c2932b852328f3))
* **RQ-PHX-SLACKPEEROWNERISOLATION497S:** RQ-PHX-SLACKPEEROWNERISOLATION497S ([#6508](https://github.com/ashlrai/phantom/issues/6508)) ([416452f](https://github.com/ashlrai/phantom/commit/416452fa231fd66374f4161af1fef5cdb652da13))
* **RQ-PHX-SLACKPENDINGPAIRRECOVERY498S:** Slack pending pair recovery ([#6517](https://github.com/ashlrai/phantom/issues/6517)) ([3f5a0c3](https://github.com/ashlrai/phantom/commit/3f5a0c3648dcfec0b85dc23113f9a92a9aaeefae))
* **RQ-PHX-SLACKPHYSICALREPLAY501S:** Slack physical alias disk replay ([#6523](https://github.com/ashlrai/phantom/issues/6523)) ([e9e7c48](https://github.com/ashlrai/phantom/commit/e9e7c48f319d247a3ee073f4ec324b5d3067474d))
* **RQ-PHX-SLACKRECONCILEIDENTITY498S:** Slack reconciliation identity qualification ([#6518](https://github.com/ashlrai/phantom/issues/6518)) ([fcaf8ce](https://github.com/ashlrai/phantom/commit/fcaf8ceca1f9436076a0e38508c5d093829f648e))
* **RQ-PHX-SLACKREPLYASOF527:** RQ-PHX-SLACKREPLYASOF527 ([#6640](https://github.com/ashlrai/phantom/issues/6640)) ([6394d20](https://github.com/ashlrai/phantom/commit/6394d201d55cadbccf4d8dc5cf3870ab5009838a))
* **RQ-PHX-SLACKSOCKETREDELIVERY497S:** RQ-PHX-SLACKSOCKETREDELIVERY497S ([#6507](https://github.com/ashlrai/phantom/issues/6507)) ([6ae98e9](https://github.com/ashlrai/phantom/commit/6ae98e94b016d9a27ba1c829ec0727e9c99a474c))
* **RQ-PHX-SLACKSTATUSQUALIFY528S:** RQ-PHX-SLACKSTATUSQUALIFY528S ([#6653](https://github.com/ashlrai/phantom/issues/6653)) ([3738d0a](https://github.com/ashlrai/phantom/commit/3738d0ac126329de4cf986889d42c327dac01d54))
* **RQ-PHX-SLACKSTORECAPRECOVERY502S:** RQ-PHX-SLACKSTORECAPRECOVERY502S ([#6542](https://github.com/ashlrai/phantom/issues/6542)) ([4d9aeb2](https://github.com/ashlrai/phantom/commit/4d9aeb272f68eef974a0b3f859fa2528b4707cbc))
* **RQ-PHX-SLACKTHREADREQUESTDISK496S:** RQ-PHX-SLACKTHREADREQUESTDISK496S ([#6506](https://github.com/ashlrai/phantom/issues/6506)) ([9433c6a](https://github.com/ashlrai/phantom/commit/9433c6a9d0bb6fd9df9ac24e5cf4b5b756825030))
* **RQ-PHX-SLACKWORKIDENTITY500S:** RQ-PHX-SLACKWORKIDENTITY500S ([#6521](https://github.com/ashlrai/phantom/issues/6521)) ([aff9224](https://github.com/ashlrai/phantom/commit/aff922429e99e2547d2640efeab086937d585423))
* **RQ-PHX-TICKCLOCKRECOVERY489S:** RQ-PHX-TICKCLOCKRECOVERY489S ([#6489](https://github.com/ashlrai/phantom/issues/6489)) ([506d90e](https://github.com/ashlrai/phantom/commit/506d90e430195b1e4ba165e4886af17539d3f77e))
* **RQ-PHX-WORKSTATEBATCHQUALIFY534S:** Work-state batch qualification ([#6697](https://github.com/ashlrai/phantom/issues/6697)) ([0d7a545](https://github.com/ashlrai/phantom/commit/0d7a545d6f47fbe940aff26da91b9de7d0e5c562))
* **RQ-PHX-WORKSTATECONTRACT524:** RQ-PHX-WORKSTATECONTRACT524 ([#6631](https://github.com/ashlrai/phantom/issues/6631)) ([eb2cdba](https://github.com/ashlrai/phantom/commit/eb2cdbadf2df3757a71c9e5cefe78e1f07b69e75))
* **RQ-PLUGSKILLPANELN17BQ8:** RQ-PLUGSKILLPANELN17BQ8: Plugins and Skills panels (ask A2) ([#6566](https://github.com/ashlrai/phantom/issues/6566)) ([ecc72b5](https://github.com/ashlrai/phantom/commit/ecc72b5df01521e258e7b9f3dfff8fc7ab50b2d5))
* **RQ-POOLSPENDN16LQ8:** RQ-POOLSPENDN16LQ8: spend-down per pool ([#6513](https://github.com/ashlrai/phantom/issues/6513)) ([48eef1a](https://github.com/ashlrai/phantom/commit/48eef1a791b5a0b1051aaf783ffba8c4af61d778))
* **RQ-QUEUEBATCHN16NQ8:** RQ-QUEUEBATCHN16NQ8: `phm queue coalesce` ([#6532](https://github.com/ashlrai/phantom/issues/6532)) ([05983f5](https://github.com/ashlrai/phantom/commit/05983f5de0130d781818edd0e9491fe988fc9078))
* **RQ-QUEUEHEALTHQ8:** RQ-QUEUEHEALTHQ8 ([#6470](https://github.com/ashlrai/phantom/issues/6470)) ([ef8103e](https://github.com/ashlrai/phantom/commit/ef8103ea8470438eeaba86e2464379abb0960fe2))
* **RQ-REAPSTUCKN16CQ8:** RQ-REAPSTUCKN16CQ8 ([#6457](https://github.com/ashlrai/phantom/issues/6457)) ([9f5be7a](https://github.com/ashlrai/phantom/commit/9f5be7ae34911b3b5630e9f96fc8b74b1afdc082))
* **RQ-REBASEDUPQ8:** RQ-REBASEDUPQ8 ([#6420](https://github.com/ashlrai/phantom/issues/6420)) ([03bb495](https://github.com/ashlrai/phantom/commit/03bb4959aa173c219e009e1672fbb8a4f5b5f2ce))
* **RQ-RECUTRECOVERYN16MQ8:** RQ-RECUTRECOVERYN16MQ8 ([#6527](https://github.com/ashlrai/phantom/issues/6527)) ([d8b94fd](https://github.com/ashlrai/phantom/commit/d8b94fd19c01a28bc6634423cee455ec6832ea06))
* **RQ-RECUTX1N16NQ8:** RQ-RECUTX1N16NQ8 ([#6537](https://github.com/ashlrai/phantom/issues/6537)) ([c35d6b9](https://github.com/ashlrai/phantom/commit/c35d6b9b97a9937fe479600abe6d90744977072b))
* **RQ-RECUTYIELDQ8:** RQ-RECUTYIELDQ8 ([#6723](https://github.com/ashlrai/phantom/issues/6723)) ([ad77da0](https://github.com/ashlrai/phantom/commit/ad77da098e5f87a1b09211aa4abe1cda83a38144))
* **RQ-RELEASE-AUTORUN-GUARDS-1:** Bring live autorun guards into the repo copy so the next re- ([#6405](https://github.com/ashlrai/phantom/issues/6405)) ([2cf6c66](https://github.com/ashlrai/phantom/commit/2cf6c66f5cd68546f889ba3ef84734f5b3d3681e))
* **RQ-RELEASE-AUTORUN-REPIN-1-REV3B:** Sync contrib/mac/release-autorun.sh to the RELEASE-AUTORUN-R ([#6414](https://github.com/ashlrai/phantom/issues/6414)) ([5b6cafb](https://github.com/ashlrai/phantom/commit/5b6cafb9d702d8291b5fe5d07edb93e728049ca3))
* **RQ-RELNOTESN17PQ8:** RQ-RELNOTESN17PQ8 ([#6673](https://github.com/ashlrai/phantom/issues/6673)) ([dd40629](https://github.com/ashlrai/phantom/commit/dd406298fe46548a820311ade3007a7a0a21a280))
* **RQ-RELSTATEN16DQ8:** RQ-RELSTATEN16DQ8 ([#6434](https://github.com/ashlrai/phantom/issues/6434)) ([2670510](https://github.com/ashlrai/phantom/commit/2670510e7425837b595c6e4622cdca1cde39fd95))
* **RQ-REPUBCMDPALN17VQ8:** RQ-REPUBCMDPALN17VQ8 ([#6725](https://github.com/ashlrai/phantom/issues/6725)) ([c376954](https://github.com/ashlrai/phantom/commit/c37695415b2a75535f62af84192f2d43f8254ce6))
* **RQ-REPUBFLATN16KQ8:** RQ-REPUBFLATN16KQ8 ([#6492](https://github.com/ashlrai/phantom/issues/6492)) ([ac1904f](https://github.com/ashlrai/phantom/commit/ac1904fc3cae24e1d8d4afd60d1728981d26bd89))
* **RQ-REPUBIDEASN17NQ8:** RQ-REPUBIDEASN17NQ8 ([#6657](https://github.com/ashlrai/phantom/issues/6657)) ([e5ea947](https://github.com/ashlrai/phantom/commit/e5ea94715378f19d2af134d5e3596764925e70e9))
* **RQ-REPUBLEASEN16KQ8:** RQ-REPUBLEASEN16KQ8 ([#6490](https://github.com/ashlrai/phantom/issues/6490)) ([5248030](https://github.com/ashlrai/phantom/commit/52480307c6b3fa449b0fcab77076ab132bc6f9b0))
* **RQ-REPUBMAPLOGOSN17CQ8:** RQ-REPUBMAPLOGOSN17CQ8 ([#6571](https://github.com/ashlrai/phantom/issues/6571)) ([699d617](https://github.com/ashlrai/phantom/commit/699d6173ac7b11f1979eb46a7b4bb29bc4993f9d))
* **RQ-REPUBSLACKN17CQ8:** RQ-REPUBSLACKN17CQ8 ([#6575](https://github.com/ashlrai/phantom/issues/6575)) ([a4b849d](https://github.com/ashlrai/phantom/commit/a4b849d4bb6773eebf8d5dbf9b16183b74388090))
* **RQ-REPUBSLOTSN16KQ8:** RQ-REPUBSLOTSN16KQ8 ([#6491](https://github.com/ashlrai/phantom/issues/6491)) ([418d861](https://github.com/ashlrai/phantom/commit/418d86133e1b39e26c1c621750e79d158f8efe87))
* **RQ-RESEARCH-HOSTLOAD-1:** BRIDGE_NOTES — RQ-RESEARCH-HOSTLOAD-1 ([#6472](https://github.com/ashlrai/phantom/issues/6472)) ([2aab062](https://github.com/ashlrai/phantom/commit/2aab06237e6e0ecb9295cc0986db5b1fbf2cb27a))
* **RQ-RESEARCH-MODELS-1:** BRIDGE_NOTES: RQ-RESEARCH-MODELS-1 ([#6498](https://github.com/ashlrai/phantom/issues/6498)) ([e138432](https://github.com/ashlrai/phantom/commit/e138432c4c68584b53af3b8a5e15a0bbe61ef006))
* **RQ-RESOURCE-LIVE-1:** RQ-RESOURCE-LIVE-1: bridge notes ([#6426](https://github.com/ashlrai/phantom/issues/6426)) ([bf4b15b](https://github.com/ashlrai/phantom/commit/bf4b15baecb0441f2a147a0555c71b3292b80016))
* **RQ-ROUTEBUDGETQ8:** RQ-ROUTEBUDGETQ8 ([#6415](https://github.com/ashlrai/phantom/issues/6415)) ([497cf44](https://github.com/ashlrai/phantom/commit/497cf44928f85e8f2b35baa1c5e4b0607a5b0d55))
* **RQ-SETTLEADAPTN17TQ8:** RQ-SETTLEADAPTN17TQ8 ([#6711](https://github.com/ashlrai/phantom/issues/6711)) ([7426d92](https://github.com/ashlrai/phantom/commit/7426d9238b1b99571ba2b1dd290c487c8b84bf7a))
* **RQ-SHARED-QUEUE-1:** RQ-SHARED-QUEUE-1 — shared company queue: capability routing ([#6533](https://github.com/ashlrai/phantom/issues/6533)) ([f6f3512](https://github.com/ashlrai/phantom/commit/f6f3512e40b774a8f05576eb3b58f67e2d1d79de))
* **RQ-SHOTS-README-1:** RQ-SHOTS-README-1 handoff ([#6483](https://github.com/ashlrai/phantom/issues/6483)) ([76cd027](https://github.com/ashlrai/phantom/commit/76cd02783c78b05009df74ddfdab71d7ebc50726))
* **RQ-SLACKRECEIPTN16AQ8:** RQ-SLACKRECEIPTN16AQ8 ([#6462](https://github.com/ashlrai/phantom/issues/6462)) ([6832fd7](https://github.com/ashlrai/phantom/commit/6832fd7288a04f8abb2b7cbc5e89c700ae552e73))
* **RQ-SLOTYIELDN16NQ8:** RQ-SLOTYIELDN16NQ8: `phm fleet yield` ([#6530](https://github.com/ashlrai/phantom/issues/6530)) ([af84c08](https://github.com/ashlrai/phantom/commit/af84c089bd010fa2ac0178d30a5dddec6de164e3))
* **RQ-SPENDVIEWN17GQ8:** RQ-SPENDVIEWN17GQ8 ([#6624](https://github.com/ashlrai/phantom/issues/6624)) ([3413f47](https://github.com/ashlrai/phantom/commit/3413f47444f416244142c68a2fcb6697090cafe9))
* **RQ-STALEJOBSQ8:** RQ-STALEJOBSQ8 ([#6467](https://github.com/ashlrai/phantom/issues/6467)) ([5a7a187](https://github.com/ashlrai/phantom/commit/5a7a187206ad5a036b37f8017c22806472c74444))
* **RQ-STATEMAP-HYGIENE-1:** RQ-STATEMAP-HYGIENE-1 ([#6488](https://github.com/ashlrai/phantom/issues/6488)) ([0a97362](https://github.com/ashlrai/phantom/commit/0a9736274ca00a09cda4f6a79d11b3df21d2a07b))
* **RQ-STUCKJOBSN16NQ8:** RQ-STUCKJOBSN16NQ8: `phm fleet stuck` ([#6529](https://github.com/ashlrai/phantom/issues/6529)) ([321895f](https://github.com/ashlrai/phantom/commit/321895f69e1ba19fe95dfc11aaf76e4e0e160b1c))
* **RQ-SUPERSEDEN17XQ8:** RQ-SUPERSEDEN17XQ8: `phm queue supersede` ([#6745](https://github.com/ashlrai/phantom/issues/6745)) ([e12e690](https://github.com/ashlrai/phantom/commit/e12e690b63aaec37d69d018d0e3a666cbc22d265))
* **RQ-THROUGHPUTN17PQ8:** RQ-THROUGHPUTN17PQ8: `phm throughput` and the desktop Throug ([#6683](https://github.com/ashlrai/phantom/issues/6683)) ([6bd8099](https://github.com/ashlrai/phantom/commit/6bd8099e0aae6df93d835bc5ceb7f88c73b2dfb7))
* **RQ-TIER1-AGENTIC-1:** RQ-TIER1-AGENTIC-1: tier1-verify, agentic deep verification ([#6473](https://github.com/ashlrai/phantom/issues/6473)) ([d8309b8](https://github.com/ashlrai/phantom/commit/d8309b8b0709eb925ff87a282c9c8c8653f6b73e))
* **RQ-TIERYIELDN16AQ8:** RQ-TIERYIELDN16AQ8 ([#6459](https://github.com/ashlrai/phantom/issues/6459)) ([63baf4d](https://github.com/ashlrai/phantom/commit/63baf4dbb3f52c0477b7dc466f18b6b5aef3c1db))
* **RQ-TOOLCHAIN-DOCS-1:** RQ-TOOLCHAIN-DOCS-1 bridge notes ([#6482](https://github.com/ashlrai/phantom/issues/6482)) ([3b13394](https://github.com/ashlrai/phantom/commit/3b13394a02d3e6133434a28328751a9a374876fe))
* **RQ-TOOLPARITYN17NQ8:** RQ-TOOLPARITYN17NQ8: `phm tools parity` and `phm tools requi ([#6664](https://github.com/ashlrai/phantom/issues/6664)) ([ec31154](https://github.com/ashlrai/phantom/commit/ec31154b0e34b271714b1ec090ccd0e90a67f252))
* **RQ-TOOLPARITYN17XQ8:** RQ-TOOLPARITYN17XQ8: `phm tools` lane-by-tool matrix and des ([#6747](https://github.com/ashlrai/phantom/issues/6747)) ([294bdfd](https://github.com/ashlrai/phantom/commit/294bdfda5a544c2a7e86605f6a6de54479be0442))
* **RQ-VIZ-NODECAP-1:** RQ-VIZ-NODECAP-1: node-pool capacity in the fleet compute ma ([#6465](https://github.com/ashlrai/phantom/issues/6465)) ([174f6b3](https://github.com/ashlrai/phantom/commit/174f6b3e3936eb8a0274bf3872e76ca4d5b2b0b0))
* RQ-WORKER-CLAIM-RELEASE-1 ([#6412](https://github.com/ashlrai/phantom/issues/6412)) ([9eb7577](https://github.com/ashlrai/phantom/commit/9eb7577de98615c25aae2812e243fb536dc6e204))
* **RQ-WORKLOGN17GQ8:** RQ-WORKLOGN17GQ8 ([#6635](https://github.com/ashlrai/phantom/issues/6635)) ([54eae65](https://github.com/ashlrai/phantom/commit/54eae652080c0453b56d3f1c11c217ef433c6c99))
* **RQ-WORKLOGN17RQ8:** RQ-WORKLOGN17RQ8: one work log ([#6694](https://github.com/ashlrai/phantom/issues/6694)) ([f8300e9](https://github.com/ashlrai/phantom/commit/f8300e9234b25714e96d851978bc00521b9472a2))
* **RQ-WORKTREESN17XQ8:** RQ-WORKTREESN17XQ8: `phm worktrees` + Home Disk card ([#6748](https://github.com/ashlrai/phantom/issues/6748)) ([4b9c9d2](https://github.com/ashlrai/phantom/commit/4b9c9d2c597c80f08637baaa37858869219d2988))


### Documentation

* **agent:** list the intent_* native MCP tools in agentDocsText ([#6450](https://github.com/ashlrai/phantom/issues/6450)) ([732ec34](https://github.com/ashlrai/phantom/commit/732ec34b8c266478a23186524c264196adbfe57b))
* **fleet:** document fleet vitals in help and generated CLI docs; print the next launch window in text output ([#6447](https://github.com/ashlrai/phantom/issues/6447)) ([39ccbb1](https://github.com/ashlrai/phantom/commit/39ccbb12c7f1db0bd5220aa28be50b7a98e74a52))


### Tests

* **slack:** align 441s evidence-bundle fixtures with journal and unknown-ingress contracts ([#6454](https://github.com/ashlrai/phantom/issues/6454)) ([09293e2](https://github.com/ashlrai/phantom/commit/09293e2216b8d01dae29119fb2ea907fb24d871a))


### CI

* bound preflight history with a shallow fetch ([#6408](https://github.com/ashlrai/phantom/issues/6408)) ([e808ea2](https://github.com/ashlrai/phantom/commit/e808ea2c186a582eaf295495cfb245ed21cbc83f))
* dispatch the dependency audit on the release tag ([#6409](https://github.com/ashlrai/phantom/issues/6409)) ([57d3804](https://github.com/ashlrai/phantom/commit/57d3804b81019a4aee4f32072f725a2df67e00f6))
* drop redundant 30-min crons, path-filter custody (CI-PHANTOM-CRON-30MIN, MQ-REAPER-CRON, DAILY-CRONS) ([#6400](https://github.com/ashlrai/phantom/issues/6400)) ([297df3c](https://github.com/ashlrai/phantom/commit/297df3cfd1af52ca846a56d2fbb820ad154641da))
* drop workflow_run from the preflight fixer ([#6386](https://github.com/ashlrai/phantom/issues/6386)) ([0e6a248](https://github.com/ashlrai/phantom/commit/0e6a248ad61bfc7c8354e184eb2f04909bfff5b4))
* drop workflow_run from unrelated PR recovery ([#6391](https://github.com/ashlrai/phantom/issues/6391)) ([fed53cc](https://github.com/ashlrai/phantom/commit/fed53cc9581991e6e9cc820a78108846174e8ad9))
* perf budget once per PR, not per push (CI-PHANTOM-PERF-BUDGET-CHURN) ([#6393](https://github.com/ashlrai/phantom/issues/6393)) ([ae75b28](https://github.com/ashlrai/phantom/commit/ae75b28ac90d7b6a5fdc0a6946cfbc53dd5b0eae))
* preflight predicted reds before the scheduled full suite ([#6372](https://github.com/ashlrai/phantom/issues/6372)) ([b08002b](https://github.com/ashlrai/phantom/commit/b08002b8067c9c210d95330a947e562ef24578b7))
* Quick typecheck materializes the full tree before the master-push typecheck ([#6446](https://github.com/ashlrai/phantom/issues/6446)) ([496ddd3](https://github.com/ashlrai/phantom/commit/496ddd31d8bbfee9917722e1571a82e7dea574b1))
* Quick typecheck skips duplicate typecheck on PR and merge_group (CI-PHANTOM-QUICK-DUP) ([#6403](https://github.com/ashlrai/phantom/issues/6403)) ([13a2a70](https://github.com/ashlrai/phantom/commit/13a2a70537095c2155a552368f38fc44882b9e7e))
* recover auto-merge PRs after unrelated gate failures ([#6385](https://github.com/ashlrai/phantom/issues/6385)) ([75dcc12](https://github.com/ashlrai/phantom/commit/75dcc122b81a6bbb9ff19a4604c44d853988bdfe))
* **release:** cache the tag build and dispatch finalize ([#6378](https://github.com/ashlrai/phantom/issues/6378)) ([1eeacca](https://github.com/ashlrai/phantom/commit/1eeacca22a54764dc67ba92adbfe55762373cd96))
* **release:** run smoke and release suites once per master sha ([#6373](https://github.com/ashlrai/phantom/issues/6373)) ([82bdd88](https://github.com/ashlrai/phantom/commit/82bdd88537f1604ce16794a26ebbbe09d0efa30b))
* **release:** run the version bump live every five minutes ([#6374](https://github.com/ashlrai/phantom/issues/6374)) ([eae9dc8](https://github.com/ashlrai/phantom/commit/eae9dc835bae6edcf0ac5a8740f99e8fcc485689))

## [3.30.35] - 2026-11-16


### Fixes

* **desktop:** match write allowlist to installed app bundle ids ([#6213](https://github.com/ashlrai/phantom/issues/6213)) ([97df142](https://github.com/ashlrai/phantom/commit/97df142fcf65c41e604a6b47f55faf00d548eda6))


### Changes

* **FIXUP-CI-phantom-ci-815859:** FIXUP-CI-phantom-ci-815859 ([#6290](https://github.com/ashlrai/phantom/issues/6290)) ([7d212b8](https://github.com/ashlrai/phantom/commit/7d212b80e00ab3396a0790c31ba5bfc8ec5307f1))
* **FIXUP-CI-phantom-ci-978022:** FIXUP-CI-phantom-ci-978022 ([#6267](https://github.com/ashlrai/phantom/issues/6267)) ([a739560](https://github.com/ashlrai/phantom/commit/a739560e4605cb2966eeaeb024f6816769b8c00d))
* **RQ-APP-AUTOUPDATE-1:** RQ-APP-AUTOUPDATE-1 ([#6224](https://github.com/ashlrai/phantom/issues/6224)) ([b6f9c4e](https://github.com/ashlrai/phantom/commit/b6f9c4e0a472953e7236336bad4e2123a61f3296))
* **RQ-APP-DIRECT-BOX-1:** RQ-APP-DIRECT-BOX-1: desktop direct box + live panels ([#6240](https://github.com/ashlrai/phantom/issues/6240)) ([0ebf1da](https://github.com/ashlrai/phantom/commit/0ebf1da818ded1af33fc21f2c828dcf525a135b7))
* **RQ-APP-ORG-GROKUI-1A:** RQ-APP-ORG-GROKUI-1A: Org view ([#6223](https://github.com/ashlrai/phantom/issues/6223)) ([752c47c](https://github.com/ashlrai/phantom/commit/752c47c6334c627db48c9a7d621a2d128071aa58))
* **RQ-BOT-TEMPLATES-1:** RQ-BOT-TEMPLATES-1: bots from templates ([#6228](https://github.com/ashlrai/phantom/issues/6228)) ([bab0318](https://github.com/ashlrai/phantom/commit/bab0318670b7853daf12c3412341484659b52874))
* RQ-CI-MASTER-FULL-1 ([#6268](https://github.com/ashlrai/phantom/issues/6268)) ([94a14dc](https://github.com/ashlrai/phantom/commit/94a14dc3d33ee79f29dc98f9a494f6c8be6319be))
* **RQ-DISPATCHD-POSTRUN-PR-1:** RQ-DISPATCHD-POSTRUN-PR-1 ([#6266](https://github.com/ashlrai/phantom/issues/6266)) ([8bfe657](https://github.com/ashlrai/phantom/commit/8bfe657a2ad45458100275174898b4d8fd520546))
* **RQ-GROK-DOCS-TRUTH-1:** RQ-GROK-DOCS-TRUTH-1 ([#6214](https://github.com/ashlrai/phantom/issues/6214)) ([b459279](https://github.com/ashlrai/phantom/commit/b45927987fa446291738979ee1b2deb591f05820))
* **RQ-GROK-ORCH-AUDIT-1:** RQ-GROK-ORCH-AUDIT-1 — orchestration loop audit ([#6234](https://github.com/ashlrai/phantom/issues/6234)) ([5599a11](https://github.com/ashlrai/phantom/commit/5599a114c1ba2e1a449ffcb3929b4edbf04a02ef))
* **RQ-GROK-SEC-AUDIT-1:** RQ-GROK-SEC-AUDIT-1 — Security posture audit of today's auto ([#6215](https://github.com/ashlrai/phantom/issues/6215)) ([2c6bc30](https://github.com/ashlrai/phantom/commit/2c6bc30c9279fca49417774e6418a8624141a05e))
* **RQ-GROKBOT-CHANGELOG-WATCH-1:** BRIDGE_NOTES - RQ-GROKBOT-CHANGELOG-WATCH-1 ([#6255](https://github.com/ashlrai/phantom/issues/6255)) ([0dead77](https://github.com/ashlrai/phantom/commit/0dead773e0de6465021e0d220d881091c35b112c))
* **RQ-MCP-PERJOB-1:** RQ-MCP-PERJOB-1 notes ([#6216](https://github.com/ashlrai/phantom/issues/6216)) ([f6152c6](https://github.com/ashlrai/phantom/commit/f6152c6df7b74873aa0441510c5903cf8af68435))
* **RQ-MERGEQ-BATCH-1:** BRIDGE_NOTES: RQ-MERGEQ-BATCH-1 (merge-queue throughput, 7 r ([#6250](https://github.com/ashlrai/phantom/issues/6250)) ([7e6d005](https://github.com/ashlrai/phantom/commit/7e6d005749a0c8d69b018c4e36a243bcdd68672e))
* **RQ-NODE-AUTOSCALE-1:** RQ-NODE-AUTOSCALE-1: generic node autoscaling and (node, pro ([#6235](https://github.com/ashlrai/phantom/issues/6235)) ([677ba7e](https://github.com/ashlrai/phantom/commit/677ba7e793b5b293ad4577b39402774a7b0df78d))
* **RQ-NODE-MBP8-1:** RQ-NODE-MBP8-1: second MacBook Pro (8 GB) node profile ([#6222](https://github.com/ashlrai/phantom/issues/6222)) ([45191e1](https://github.com/ashlrai/phantom/commit/45191e1d4f8ee34b2b4b5e02a213532e5520f982))
* **RQ-PH-AUTHDRIFT-ROOT-1:** BRIDGE_NOTES: RQ-PH-AUTHDRIFT-ROOT-1 ([#6262](https://github.com/ashlrai/phantom/issues/6262)) ([bc2bf3a](https://github.com/ashlrai/phantom/commit/bc2bf3a99c5db20296f5e439206417168d273561))
* **RQ-PH-V33034-REDNOTE-1:** RQ-PH-V33034-REDNOTE-1 ([#6260](https://github.com/ashlrai/phantom/issues/6260)) ([18b658b](https://github.com/ashlrai/phantom/commit/18b658b9d70a5ce87e1b1f50e12ce75c35562c6e))
* **RQ-PHX-CLOUDROUTESRUNTIME379:** Bridge Notes for RQ-PHX-CLOUDROUTESRUNTIME379 ([#6217](https://github.com/ashlrai/phantom/issues/6217)) ([763d40d](https://github.com/ashlrai/phantom/commit/763d40dcccd2773271b9b40ab98d54652a8b964f))
* **RQ-PHX-IMSGALIASWITHDRAW462S:** RQ-PHX-IMSGALIASWITHDRAW462S ([#6254](https://github.com/ashlrai/phantom/issues/6254)) ([0a3038d](https://github.com/ashlrai/phantom/commit/0a3038d50bab1e2603525498244c256c0996b940))
* **RQ-PHX-IMSGCLIEXACT466S:** RQ-PHX-IMSGCLIEXACT466S ([#6272](https://github.com/ashlrai/phantom/issues/6272)) ([2211f51](https://github.com/ashlrai/phantom/commit/2211f51025272733733961b22cfe52c873d206a7))
* **RQ-PHX-MCPCLAIMIDENTITY465S:** BRIDGE_NOTES — RQ-PHX-MCPCLAIMIDENTITY465S ([#6275](https://github.com/ashlrai/phantom/issues/6275)) ([9ee3328](https://github.com/ashlrai/phantom/commit/9ee3328782f688b253425f1cd2e7a7980af7d7c4))
* **RQ-PHX-RECUTFLEETCLIC462:** BRIDGE_NOTES — RQ-PHX-RECUTFLEETCLIC462 (FLEETCLI bucket) ([#6258](https://github.com/ashlrai/phantom/issues/6258)) ([90b73cf](https://github.com/ashlrai/phantom/commit/90b73cf85350b65869cdab076f3d042a866a535f))
* **RQ-PHX-RECUTLEADERC465:** BRIDGE_NOTES — RQ-PHX-RECUTLEADERC465 (bucket: LEADER) ([#6270](https://github.com/ashlrai/phantom/issues/6270)) ([70bbbc0](https://github.com/ashlrai/phantom/commit/70bbbc07dbc958ef5db46adc5b1f2cdb3710f3b0))
* **RQ-PHX-RECUTMCPC460:** BRIDGE_NOTES — RQ-PHX-RECUTMCPC460 (MCP bucket) ([#6253](https://github.com/ashlrai/phantom/issues/6253)) ([9e125be](https://github.com/ashlrai/phantom/commit/9e125be892221068f803bd1825cf778488f09ef3))
* **RQ-PHX-RECUTTESTONLYC462:** RQ-PHX-RECUTTESTONLYC462 ([#6251](https://github.com/ashlrai/phantom/issues/6251)) ([7b5c063](https://github.com/ashlrai/phantom/commit/7b5c063a3b8e9747c292edb07de47ed5f21dbd0a))
* **RQ-PHX-REDTESTFIXC460:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXC460 ([#6257](https://github.com/ashlrai/phantom/issues/6257)) ([0a0fca3](https://github.com/ashlrai/phantom/commit/0a0fca3d04ec2d9f21cde5656c9750802c651ed2))
* **RQ-PHX-REDTESTFIXC468:** RQ-PHX-REDTESTFIXC468 ([#6278](https://github.com/ashlrai/phantom/issues/6278)) ([b84374e](https://github.com/ashlrai/phantom/commit/b84374e992222408e8be3679ee0e60013082abbc))
* **RQ-PHX-REDTYPEFIXC459:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXC459 ([#6276](https://github.com/ashlrai/phantom/issues/6276)) ([2e14b74](https://github.com/ashlrai/phantom/commit/2e14b741afb84ceffd01923709b5fe3bc8b6b4bb))
* **RQ-PHX-SLACKBUSRETRYRECOVERY467S:** Slack bus retry disk recovery ([#6274](https://github.com/ashlrai/phantom/issues/6274)) ([186235e](https://github.com/ashlrai/phantom/commit/186235e902b6cfca940f13b4488c2d267c9e6c92))
* **RQ-PHX-SLACKDISKDEGRADED469S:** BRIDGE_NOTES — RQ-PHX-SLACKDISKDEGRADED469S ([#6285](https://github.com/ashlrai/phantom/issues/6285)) ([ebb4d11](https://github.com/ashlrai/phantom/commit/ebb4d11449341d4cbd9a55efac9031ebc6886085))
* **RQ-PHX-SLACKHTTPDISKLOSS471S:** Goal: Qualify the desktop Slack evidence HTTP route when dur ([#6284](https://github.com/ashlrai/phantom/issues/6284)) ([4f2568d](https://github.com/ashlrai/phantom/commit/4f2568dcb6fcc02826c5cbae58efd5f38260a8ad))
* **RQ-PHX-SLACKMCPDISKLOSS470S:** Bridge notes ([#6280](https://github.com/ashlrai/phantom/issues/6280)) ([7e30461](https://github.com/ashlrai/phantom/commit/7e30461239c3722977c7e5466f7d884967e4f7e6))
* **RQ-PHX-SLACKMCPDISKPROOF461S:** RQ-PHX-SLACKMCPDISKPROOF461S ([#6249](https://github.com/ashlrai/phantom/issues/6249)) ([48d668f](https://github.com/ashlrai/phantom/commit/48d668f4daf055bd953004682adcf7e99e1b8255))
* **RQ-PHX-SLACKREQUESTDISKROUNDTRIP459S:** BRIDGE_NOTES — RQ-PHX-SLACKREQUESTDISKROUNDTRIP459S ([#6244](https://github.com/ashlrai/phantom/issues/6244)) ([c45bc65](https://github.com/ashlrai/phantom/commit/c45bc65b78afe7371594011365bb13c4836e174e))
* **RQ-PHX-SLACKSIBLINGDISK472S:** RQ-PHX-SLACKSIBLINGDISK472S ([#6286](https://github.com/ashlrai/phantom/issues/6286)) ([8513623](https://github.com/ashlrai/phantom/commit/8513623a57f9e287d8cce47553417c8e4f860596))
* **RQ-PHX-SLACKTRACEEXACT463S:** RQ-PHX-SLACKTRACEEXACT463S ([#6261](https://github.com/ashlrai/phantom/issues/6261)) ([1b56d2a](https://github.com/ashlrai/phantom/commit/1b56d2ac2bfce4bf4630bf85d6ceb21655f1ef53))
* **RQ-PHX-SLACKTRACEFAILURE466S:** BRIDGE_NOTES — RQ-PHX-SLACKTRACEFAILURE466S ([#6271](https://github.com/ashlrai/phantom/issues/6271)) ([cd2c85a](https://github.com/ashlrai/phantom/commit/cd2c85a008a491a9519c5b121b6c6272fdf6d642))
* **RQ-PHX-SLACKUNKNOWNALLOCATION461S:** RQ-PHX-SLACKUNKNOWNALLOCATION461S ([#6245](https://github.com/ashlrai/phantom/issues/6245)) ([6ba5947](https://github.com/ashlrai/phantom/commit/6ba5947e2ccf327601d5a61601a59fc075de8554))
* **RQ-PHX-SLACKUNKNOWNDISK463S:** RQ-PHX-SLACKUNKNOWNDISK463S ([#6263](https://github.com/ashlrai/phantom/issues/6263)) ([1214247](https://github.com/ashlrai/phantom/commit/1214247c4cb4eedc30194954a0413d15d27a92fc))
* **RQ-PHX-TASKCLAIMDRIFTPROOF468S:** RQ-PHX-TASKCLAIMDRIFTPROOF468S ([#6277](https://github.com/ashlrai/phantom/issues/6277)) ([dc530f5](https://github.com/ashlrai/phantom/commit/dc530f59383e77aeea8bd11d17e873ed20f18c4e))
* **RQ-PHX-TASKMCPHEALTH473S:** RQ-PHX-TASKMCPHEALTH473S ([#6287](https://github.com/ashlrai/phantom/issues/6287)) ([8ba54fd](https://github.com/ashlrai/phantom/commit/8ba54fdab209ddd747bd187d44f5c2d5c3db953e))
* **RQ-PHX-TASKSETTLEMENTRECOVERY468S:** BRIDGE_NOTES — RQ-PHX-TASKSETTLEMENTRECOVERY468S ([#6282](https://github.com/ashlrai/phantom/issues/6282)) ([917872c](https://github.com/ashlrai/phantom/commit/917872cf5c717c434880becefe202f0281967acd))
* **RQ-PHX-TEAMTASKAPIBINDING473S:** BRIDGE_NOTES — RQ-PHX-TEAMTASKAPIBINDING473S ([#6288](https://github.com/ashlrai/phantom/issues/6288)) ([617f72e](https://github.com/ashlrai/phantom/commit/617f72ed0967037e9850809c19b649f3bebc666f))
* **RQ-PHX-TEAMTASKAPIEXACT471S:** RQ-PHX-TEAMTASKAPIEXACT471S ([#6283](https://github.com/ashlrai/phantom/issues/6283)) ([5f7ded1](https://github.com/ashlrai/phantom/commit/5f7ded13bae0988052426dedc7697b3dafad1fe6))
* **RQ-PHX-TEAMTASKCLIALIAS458S:** RQ-PHX-TEAMTASKCLIALIAS458S: teammate-tasks delegates to cmd ([#6237](https://github.com/ashlrai/phantom/issues/6237)) ([2126b26](https://github.com/ashlrai/phantom/commit/2126b26f5686538c16c64823f208a316084ff130))
* **RQ-PHX-TEAMTASKDISKUNAVAILABLE469S:** Source SHA: b84374e992222408e8be3679ee0e60013082abbc (origin ([#6279](https://github.com/ashlrai/phantom/issues/6279)) ([95f1a70](https://github.com/ashlrai/phantom/commit/95f1a702346c430ad3edd70de29637dbed7c272a))
* **RQ-PHX-WITHDRAWAPIDISK464S:** BRIDGE_NOTES — RQ-PHX-WITHDRAWAPIDISK464S ([#6265](https://github.com/ashlrai/phantom/issues/6265)) ([ee00abf](https://github.com/ashlrai/phantom/commit/ee00abfec2b006e838f25a314e8e6b2d3a62b2d5))
* **RQ-PHX-WITHDRAWRECEIPT458S:** RQ-PHX-WITHDRAWRECEIPT458S ([#6247](https://github.com/ashlrai/phantom/issues/6247)) ([9db8c95](https://github.com/ashlrai/phantom/commit/9db8c95685485019e6e6da432a0698609cba245e))
* **RQ-PR-CLEAR-1B:** RQ-PR-CLEAR-1B ([#6218](https://github.com/ashlrai/phantom/issues/6218)) ([85869cf](https://github.com/ashlrai/phantom/commit/85869cf3989099c8eb2b0363fcc698bcd2ba4166))
* RQ-REBASE-PHANTOM-3961 ([#6230](https://github.com/ashlrai/phantom/issues/6230)) ([25ce32d](https://github.com/ashlrai/phantom/commit/25ce32d03c87664b3d5c2574ddbf568ef18f3bb1))
* **RQ-RECOVER-NOV10-COMMITS-1:** BRIDGE_NOTES: RQ-RECOVER-NOV10-COMMITS-1 ([#6252](https://github.com/ashlrai/phantom/issues/6252)) ([2b680df](https://github.com/ashlrai/phantom/commit/2b680df0fce2b1a131c5cb9dc6a95a5613fea188))
* **RQ-RELEASE-BUILD-STALL-1:** RQ-RELEASE-BUILD-STALL-1 ([#6239](https://github.com/ashlrai/phantom/issues/6239)) ([2a6d016](https://github.com/ashlrai/phantom/commit/2a6d016b90b6ab915d30ee7500e6cfa85509c2fd))
* **RQ-RELEASE-FIXFORWARD-1:** RQ-RELEASE-FIXFORWARD-1: fix the release train forward past ([#6256](https://github.com/ashlrai/phantom/issues/6256)) ([281d213](https://github.com/ashlrai/phantom/commit/281d2139d6a2a545701110d5b98c555e9119f07d))
* **RQ-RELEASE-UNSTICK-1:** BRIDGE_NOTES — RQ-RELEASE-UNSTICK-1 ([#6233](https://github.com/ashlrai/phantom/issues/6233)) ([b109dc6](https://github.com/ashlrai/phantom/commit/b109dc6c9c87758c9432761a24374dff752172d8))
* **RQ-REPO-OWNERS-1:** RQ-REPO-OWNERS-1 ([#6241](https://github.com/ashlrai/phantom/issues/6241)) ([9483457](https://github.com/ashlrai/phantom/commit/9483457d43fe0772b556af0cade406c58bd6f73f))
* **RQ-SLACK-SYNC-1:** RQ-SLACK-SYNC-1 ([#6221](https://github.com/ashlrai/phantom/issues/6221)) ([4cc853a](https://github.com/ashlrai/phantom/commit/4cc853a13e2beaf9493df28150ce8be4bc057216))
* **RQ-USAGE-READER-AUDIT-1:** BRIDGE_NOTES — RQ-USAGE-READER-AUDIT-1 ([#6243](https://github.com/ashlrai/phantom/issues/6243)) ([eb9c12d](https://github.com/ashlrai/phantom/commit/eb9c12d35ab10d3e906c0d1986f5a0e3d410fb93))


### Documentation

* regenerate llms.txt (master Quick 'Check generated files' red) ([#6219](https://github.com/ashlrai/phantom/issues/6219)) ([b7759cf](https://github.com/ashlrai/phantom/commit/b7759cfb56d17d82891b018aabf50643a628b76e))

## [3.30.34] - 2026-11-16

> **Tagged on red.** Tag `v3.30.34` points at commit `8060b4bd1d14228fe609cfef0576a49dee83bc61`, and the master push CI run on that exact commit ([run 43807308941](https://github.com/ashlrai/phantom/actions/runs/43807308941)) failed the step "Check generated files" (Merge Gate succeeded). Auto-tag [run 43807308912](https://github.com/ashlrai/phantom/actions/runs/43807308912) created the tag anyway. The tag and the GitHub release "Phantom 3.30.34" are kept as they are, neither deleted nor retargeted, and this note does not change the tree. Treat 3.30.34 as not release-grade; the next green cut supersedes it.


### Changes

* **FIXUP-CI-phantom-ci-014958:** FIXUP-CI-phantom-ci-014958 ([#5698](https://github.com/ashlrai/phantom/issues/5698)) ([eca8713](https://github.com/ashlrai/phantom/commit/eca871344271418402edd1d867d4e8a77e9defcb))
* **FIXUP-CI-phantom-ci-022173:** FIXUP-CI-phantom-ci-022173 ([#5689](https://github.com/ashlrai/phantom/issues/5689)) ([46510ba](https://github.com/ashlrai/phantom/commit/46510ba69673b91a43fb7ee052995a22e617b694))
* **FIXUP-CI-phantom-ci-084295:** FIXUP-CI-phantom-ci-084295 ([#5964](https://github.com/ashlrai/phantom/issues/5964)) ([4567b71](https://github.com/ashlrai/phantom/commit/4567b71657421f0a38b9b06b6e5ee2c3b9e21486))
* **FIXUP-CI-phantom-ci-088438:** FIXUP-CI-phantom-ci-088438 ([#6024](https://github.com/ashlrai/phantom/issues/6024)) ([b3798c3](https://github.com/ashlrai/phantom/commit/b3798c3dc376a3e7bfe606c4dfb2a0a3d8af93ac))
* **FIXUP-CI-phantom-ci-134884:** FIXUP-CI-phantom-ci-134884 ([#5730](https://github.com/ashlrai/phantom/issues/5730)) ([81011a5](https://github.com/ashlrai/phantom/commit/81011a58b4d3fbd40c35341f9a50bded348a6007))
* **FIXUP-CI-phantom-ci-147956:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-147956 ([#6008](https://github.com/ashlrai/phantom/issues/6008)) ([c3c29f3](https://github.com/ashlrai/phantom/commit/c3c29f3554559455d184d4e5b0fab65220ff9879))
* **FIXUP-CI-phantom-ci-178742:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-178742 ([#6067](https://github.com/ashlrai/phantom/issues/6067)) ([b69a2ba](https://github.com/ashlrai/phantom/commit/b69a2bad5f0de93706154ec3113adb941f77095f))
* **FIXUP-CI-phantom-ci-203269:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-203269 ([#5620](https://github.com/ashlrai/phantom/issues/5620)) ([b969c5c](https://github.com/ashlrai/phantom/commit/b969c5c33329b3e56176f4afe039f33163df02ec))
* **FIXUP-CI-phantom-ci-208888:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-208888 ([#6103](https://github.com/ashlrai/phantom/issues/6103)) ([d4a9519](https://github.com/ashlrai/phantom/commit/d4a9519253e0aa66d8046de06a59b0f38a027dee))
* **FIXUP-CI-phantom-ci-298850:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-298850 ([#5573](https://github.com/ashlrai/phantom/issues/5573)) ([f8aa311](https://github.com/ashlrai/phantom/commit/f8aa3117b5b37a9fc835ab824c660d67ec80301e))
* **FIXUP-CI-phantom-ci-310188:** FIXUP-CI-phantom-ci-310188 ([#5978](https://github.com/ashlrai/phantom/issues/5978)) ([466ae0c](https://github.com/ashlrai/phantom/commit/466ae0cb52818b21f0ca1e89ea7e2ac24466988f))
* **FIXUP-CI-phantom-ci-332536:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-332536 ([#6001](https://github.com/ashlrai/phantom/issues/6001)) ([8310060](https://github.com/ashlrai/phantom/commit/831006081df2bffbff64fb80dc99909087c3bba3))
* **FIXUP-CI-phantom-ci-438761:** FIXUP-CI-phantom-ci-438761 ([#5593](https://github.com/ashlrai/phantom/issues/5593)) ([22aceb7](https://github.com/ashlrai/phantom/commit/22aceb73149842b7f33aa44ecf25abca21520029))
* **FIXUP-CI-phantom-ci-444459:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-444459 ([#5983](https://github.com/ashlrai/phantom/issues/5983)) ([5683bea](https://github.com/ashlrai/phantom/commit/5683bea6a7909d5c8a0b5b7d003627e2d3508a9c))
* **FIXUP-CI-phantom-ci-508176:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-508176 ([#6170](https://github.com/ashlrai/phantom/issues/6170)) ([097ccec](https://github.com/ashlrai/phantom/commit/097ccecd22af6d894c2dacbf217d61d6bfdeae2e))
* **FIXUP-CI-phantom-ci-533641:** FIXUP-CI-phantom-ci-533641 ([#5971](https://github.com/ashlrai/phantom/issues/5971)) ([54b78e7](https://github.com/ashlrai/phantom/commit/54b78e7619e2dd6f897cde132c5984474585ede1))
* **FIXUP-CI-phantom-ci-556958:** FIXUP-CI-phantom-ci-556958 ([#5913](https://github.com/ashlrai/phantom/issues/5913)) ([d43b6ac](https://github.com/ashlrai/phantom/commit/d43b6ac7055c825bab49a8e0a25183f29cba45f9))
* **FIXUP-CI-phantom-ci-579226:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-579226 ([#5575](https://github.com/ashlrai/phantom/issues/5575)) ([0372bfe](https://github.com/ashlrai/phantom/commit/0372bfea3a5d0e79b144b59da2c3001afd356e20))
* **FIXUP-CI-phantom-ci-597579:** FIXUP-CI-phantom-ci-597579 ([#5751](https://github.com/ashlrai/phantom/issues/5751)) ([f53d08a](https://github.com/ashlrai/phantom/commit/f53d08a05fdf4a9990836e7e9442c1a6e2b2bb6b))
* **FIXUP-CI-phantom-ci-608897:** FIXUP-CI-phantom-ci-608897 ([#5762](https://github.com/ashlrai/phantom/issues/5762)) ([2e8fb4c](https://github.com/ashlrai/phantom/commit/2e8fb4c93baf10a44ddc0ac988adfb917695d3d6))
* **FIXUP-CI-phantom-ci-621864:** FIXUP-CI-phantom-ci-621864 ([#5745](https://github.com/ashlrai/phantom/issues/5745)) ([f3512cc](https://github.com/ashlrai/phantom/commit/f3512ccbffd4b337d467ee554baeb243beeecc6b))
* **FIXUP-CI-phantom-ci-622898:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-622898 ([#5999](https://github.com/ashlrai/phantom/issues/5999)) ([2c64234](https://github.com/ashlrai/phantom/commit/2c6423455b8b507c19eb7ba75da32dc167ee5e26))
* **FIXUP-CI-phantom-ci-652916:** FIXUP-CI-phantom-ci-652916 ([#5919](https://github.com/ashlrai/phantom/issues/5919)) ([421c6bf](https://github.com/ashlrai/phantom/commit/421c6bf01e1f27a675020189283910cab2e0e9e7))
* **FIXUP-CI-phantom-ci-666887:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-666887 ([#6032](https://github.com/ashlrai/phantom/issues/6032)) ([4f7d843](https://github.com/ashlrai/phantom/commit/4f7d84315e450eb6426e7d5c96dd2314be65e282))
* **FIXUP-CI-phantom-ci-683851:** FIXUP-CI-phantom-ci-683851 ([#6165](https://github.com/ashlrai/phantom/issues/6165)) ([5d37010](https://github.com/ashlrai/phantom/commit/5d3701075d0bb2801127f25c92abe8b5fa18d7b5))
* **FIXUP-CI-phantom-ci-696379:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-696379 ([#5671](https://github.com/ashlrai/phantom/issues/5671)) ([acaa348](https://github.com/ashlrai/phantom/commit/acaa3480c4f81200628e033f6079b2ebd4dc08ff))
* **FIXUP-CI-phantom-ci-718815:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-718815 ([#5724](https://github.com/ashlrai/phantom/issues/5724)) ([45997a3](https://github.com/ashlrai/phantom/commit/45997a3b0f5d60b11e3d24762d8cc850c3db1446))
* **FIXUP-CI-phantom-ci-723395:** BRIDGE NOTES: FIXUP-CI-phantom-ci-723395 ([#5769](https://github.com/ashlrai/phantom/issues/5769)) ([ad99673](https://github.com/ashlrai/phantom/commit/ad9967345406e3a3a0b94cc432ad275be6d4a9f6))
* **FIXUP-CI-phantom-ci-768897:** FIXUP-CI-phantom-ci-768897 ([#6111](https://github.com/ashlrai/phantom/issues/6111)) ([c62bf79](https://github.com/ashlrai/phantom/commit/c62bf7996430bac58ca867d3b49cad5abbc25457))
* **FIXUP-CI-phantom-ci-781964:** FIXUP-CI-phantom-ci-781964 ([#6079](https://github.com/ashlrai/phantom/issues/6079)) ([e70207d](https://github.com/ashlrai/phantom/commit/e70207d304affcf7d261aa12eba34e0b30ba51d9))
* **FIXUP-CI-phantom-ci-836238:** FIXUP-CI-phantom-ci-836238 ([#5886](https://github.com/ashlrai/phantom/issues/5886)) ([1f1abab](https://github.com/ashlrai/phantom/commit/1f1abab2926a30caf878ba17fc2f84b0b872f824))
* **FIXUP-CI-phantom-ci-843835:** FIXUP-CI-phantom-ci-843835 ([#5838](https://github.com/ashlrai/phantom/issues/5838)) ([168f201](https://github.com/ashlrai/phantom/commit/168f2016d1e7c8917ef34907266d964a73749715))
* **FIXUP-CI-phantom-ci-863432:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-863432 ([#5650](https://github.com/ashlrai/phantom/issues/5650)) ([abd5f30](https://github.com/ashlrai/phantom/commit/abd5f30e49f132b9fc40fb31bccda28b52f49fc3))
* **FIXUP-CI-phantom-ci-931984:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-931984 ([#6039](https://github.com/ashlrai/phantom/issues/6039)) ([3462070](https://github.com/ashlrai/phantom/commit/34620707b793f4e195a54f78096da0b034cc2efb))
* **FIXUP-CI-phantom-ci-948020:** FIXUP-CI-phantom-ci-948020 ([#5629](https://github.com/ashlrai/phantom/issues/5629)) ([fe522d6](https://github.com/ashlrai/phantom/commit/fe522d65a46f70bddbf5d473e7945314eadb14a8))
* **FIXUP-CI-phantom-ci-953582:** BRIDGE_NOTES: FIXUP-CI-phantom-ci-953582 ([#6058](https://github.com/ashlrai/phantom/issues/6058)) ([88793ec](https://github.com/ashlrai/phantom/commit/88793ecc4bc1338265cbc9b6d3f52f92c65de475))
* **FIXUP-CI-phantom-ecosystem-stats-040129:** BRIDGE_NOTES: FIXUP-CI-phantom-ecosystem-stats-040129 ([#5646](https://github.com/ashlrai/phantom/issues/5646)) ([82092a9](https://github.com/ashlrai/phantom/commit/82092a984c32e50c47615cbb0776394cff5e783f))
* **FIXUP-MAIN-phantom-306ef16-r2:** FIXUP-MAIN-phantom-306ef16-r2 ([#5563](https://github.com/ashlrai/phantom/issues/5563)) ([e78a1e0](https://github.com/ashlrai/phantom/commit/e78a1e0fd182e8a118abeccfddf62d96b3d73baa))
* **FIXUP-MAIN-phantom-a0aac28-r2:** FIXUP-MAIN-phantom-a0aac28-r2 ([#6042](https://github.com/ashlrai/phantom/issues/6042)) ([8db2605](https://github.com/ashlrai/phantom/commit/8db2605c1612e9a140993db202574def8401c630))
* **FIXUP-MAIN-phantom-a0aac28:** FIXUP-MAIN-phantom-a0aac28 ([#6043](https://github.com/ashlrai/phantom/issues/6043)) ([bd91922](https://github.com/ashlrai/phantom/commit/bd91922b30ab67f4e43a741201fab1b1ff8719ab))
* **FIXUP-MAIN-phantom-b69588f-r2:** FIXUP-MAIN-phantom-b69588f-r2 ([#6020](https://github.com/ashlrai/phantom/issues/6020)) ([0e3f13f](https://github.com/ashlrai/phantom/commit/0e3f13f571714cc56f4e7b05f7a5fc0e7a99e5b4))
* **FIXUP-MAIN-phantom-b69588f:** FIXUP-MAIN-phantom-b69588f ([#6019](https://github.com/ashlrai/phantom/issues/6019)) ([2d579d7](https://github.com/ashlrai/phantom/commit/2d579d70c378c45edc9c04a7ac64bbca3d03fd7a))
* **FIXUP-MAIN-phantom-db0bd17-r2:** FIXUP-MAIN-phantom-db0bd17-r2 ([#5937](https://github.com/ashlrai/phantom/issues/5937)) ([454fc7c](https://github.com/ashlrai/phantom/commit/454fc7c56dd4173b8ddabb102f91951eb3e0a773))
* **FIXUP-MAIN-phantom-db0bd17:** FIXUP-MAIN-phantom-db0bd17 ([#5942](https://github.com/ashlrai/phantom/issues/5942)) ([022576b](https://github.com/ashlrai/phantom/commit/022576b02b44e530d180222b420faf576a43c937))
* **FIXUP-MAIN-phantom-f53d08a-r2:** Bridge Notes: Restore order-state typechecking ([#5761](https://github.com/ashlrai/phantom/issues/5761)) ([cba4b6c](https://github.com/ashlrai/phantom/commit/cba4b6c1b08606d17cccd3fefdeb1fbe7d254696))
* **FIXUP-MAIN-phantom-f53d08a:** FIXUP-MAIN-phantom-f53d08a ([#5760](https://github.com/ashlrai/phantom/issues/5760)) ([20034d5](https://github.com/ashlrai/phantom/commit/20034d535e05a05972ca3c2777ad2b63510ec7c2))
* **RQ-AGENTNET-PEERBUS-1:** RQ-AGENTNET-PEERBUS-1 — uncommitted handoff ([#5819](https://github.com/ashlrai/phantom/issues/5819)) ([92d03bd](https://github.com/ashlrai/phantom/commit/92d03bdb79cc463deec4383b06230f5e0cffd51f))
* **RQ-AMPLIFY-CMD-1:** RQ-AMPLIFY-CMD-1 ([#5586](https://github.com/ashlrai/phantom/issues/5586)) ([d8b9d26](https://github.com/ashlrai/phantom/commit/d8b9d26bfada5daae0fcebcb5d1bf83c5a65b20c))
* **RQ-BRANCH-GARDENER-1:** RQ-BRANCH-GARDENER-1 handoff ([#5584](https://github.com/ashlrai/phantom/issues/5584)) ([7e04d58](https://github.com/ashlrai/phantom/commit/7e04d589df940d0ab5c55608cf7ee83004b0f59f))
* **RQ-BUSV2-IMPL-1:** RQ-BUSV2-IMPL-1 ([#6137](https://github.com/ashlrai/phantom/issues/6137)) ([9979459](https://github.com/ashlrai/phantom/commit/9979459b9cd66be06f844ca59d5be970c52fe593))
* **RQ-CI-RIGHTSIZING-1:** RQ-CI-RIGHTSIZING-1 ([#5585](https://github.com/ashlrai/phantom/issues/5585)) ([665657e](https://github.com/ashlrai/phantom/commit/665657e1d6f78348367846a5e6972e00681bb41c))
* **RQ-CIFIX-PH-17:** REWORKS_PR: 915 — cifix ([#3926](https://github.com/ashlrai/phantom/issues/3926)) ([d0bd3da](https://github.com/ashlrai/phantom/commit/d0bd3da2940d2e8c0d727054d673f8d060d6bfee))
* **RQ-CLAUDE-BURN-8:** RQ-CLAUDE-BURN-8 ([#5587](https://github.com/ashlrai/phantom/issues/5587)) ([e6c6cc7](https://github.com/ashlrai/phantom/commit/e6c6cc73b06447605a6727b3dd4af9da3bb4bd10))
* **RQ-CMP-BURN-13:** RQ-CMP-BURN-13 ([#5589](https://github.com/ashlrai/phantom/issues/5589)) ([c98c276](https://github.com/ashlrai/phantom/commit/c98c276e2c420850e975615823f1d7b4d771dcb4))
* **RQ-CMP-BURN-14:** RQ-CMP-BURN-14 ([#5590](https://github.com/ashlrai/phantom/issues/5590)) ([6b61886](https://github.com/ashlrai/phantom/commit/6b6188621652c57aaae3ff9c4bb4d9d443841a92))
* **RQ-CMP-BURN-18:** RQ-CMP-BURN-18 bridge notes ([#5588](https://github.com/ashlrai/phantom/issues/5588)) ([d12ba40](https://github.com/ashlrai/phantom/commit/d12ba4022543de7a878d17d8547f678f6ae4d081))
* **RQ-CMP-BURN-20:** RQ-CMP-BURN-20 — consolidate cloud reference pricing ([#5592](https://github.com/ashlrai/phantom/issues/5592)) ([45bc117](https://github.com/ashlrai/phantom/commit/45bc1179dbf00d4154a9677b3e973c0efe94ed61))
* **RQ-CMP-BURN-25:** RQ-CMP-BURN-25 ([#5596](https://github.com/ashlrai/phantom/issues/5596)) ([1498d57](https://github.com/ashlrai/phantom/commit/1498d5769d5da70373e4842bee38ff78712a2995))
* **RQ-CMP-BURN-26:** RQ-CMP-BURN-26 ([#5597](https://github.com/ashlrai/phantom/issues/5597)) ([dc9231d](https://github.com/ashlrai/phantom/commit/dc9231dc0c04469d3898c83ba44d7ebee40dfaf1))
* **RQ-CMP-BURN-28:** RQ-CMP-BURN-28 ([#5599](https://github.com/ashlrai/phantom/issues/5599)) ([f1b7e9c](https://github.com/ashlrai/phantom/commit/f1b7e9c78a0dec6982f5e493ad6f08d0851271e5))
* **RQ-CMP-BURN-29:** BRIDGE_NOTES — RQ-CMP-BURN-29 ([#5604](https://github.com/ashlrai/phantom/issues/5604)) ([9104659](https://github.com/ashlrai/phantom/commit/910465951033c9854653013db012db3c098825a4))
* **RQ-CMP-BURN-2:** RQ-CMP-BURN-2 ([#5591](https://github.com/ashlrai/phantom/issues/5591)) ([33d1dd7](https://github.com/ashlrai/phantom/commit/33d1dd77bdb4820273d2796153c221830da17dd0))
* **RQ-CMP-BURN-4:** RQ-CMP-BURN-4 ([#5600](https://github.com/ashlrai/phantom/issues/5600)) ([e46e9c1](https://github.com/ashlrai/phantom/commit/e46e9c10459aafdc4ac4cdf5a109044d864854e1))
* **RQ-CMP-BURN-9:** RQ-CMP-BURN-9 ([#5601](https://github.com/ashlrai/phantom/issues/5601)) ([e65d9e9](https://github.com/ashlrai/phantom/commit/e65d9e9d83ae9ba9af8b590ac4d82546efab7a69))
* **RQ-CMP-CROSSREPO-SYNC-1:** RQ-CMP-CROSSREPO-SYNC-1 ([#5598](https://github.com/ashlrai/phantom/issues/5598)) ([e11c066](https://github.com/ashlrai/phantom/commit/e11c066e57fce669578721106d70905f71d5e0ab))
* **RQ-CMP-FRICTIONLESS-1:** RQ-CMP-FRICTIONLESS-1 ([#5602](https://github.com/ashlrai/phantom/issues/5602)) ([de2d611](https://github.com/ashlrai/phantom/commit/de2d61190bdea708b52effcece41a8a4534c5c98))
* **RQ-CMP-MERGE-VELOCITY-1:** RQ-CMP-MERGE-VELOCITY-1 ([#5603](https://github.com/ashlrai/phantom/issues/5603)) ([e0454ec](https://github.com/ashlrai/phantom/commit/e0454ec8812bdb83c3a328e67e2d5b6d1440c3d3))
* **RQ-CMP-STRATEGY-BRAIN-1:** RQ-CMP-STRATEGY-BRAIN-1 bridge notes ([#5607](https://github.com/ashlrai/phantom/issues/5607)) ([81e3303](https://github.com/ashlrai/phantom/commit/81e33032938f575f81954d8c3fb22b1471218c1f))
* **RQ-COMMS-OPENDOT-1:** RQ-COMMS-OPENDOT-1 bridge notes ([#5605](https://github.com/ashlrai/phantom/issues/5605)) ([1365112](https://github.com/ashlrai/phantom/commit/1365112f30f9c9d755f8377e604fc9d9565a5a1d))
* **RQ-COMPANY-VIEW-2-1:** RQ-COMPANY-VIEW-2-1 ([#6143](https://github.com/ashlrai/phantom/issues/6143)) ([da3a285](https://github.com/ashlrai/phantom/commit/da3a2850cbbf49533b7129960c8f27a616168f44))
* **RQ-DESK-COMPANYVIEW-1:** RQ-DESK-COMPANYVIEW-1 ([#5798](https://github.com/ashlrai/phantom/issues/5798)) ([a786168](https://github.com/ashlrai/phantom/commit/a786168825632bfcc0ffbec1c159a67819035ee2))
* **RQ-DESK-OWNERASSIST-1:** RQ-DESK-OWNERASSIST-1 ([#5802](https://github.com/ashlrai/phantom/issues/5802)) ([554085e](https://github.com/ashlrai/phantom/commit/554085ec0355a740742533714cc1ea8415675b07))
* **RQ-DEVIN-MODELWIRE-1:** RQ-DEVIN-MODELWIRE-1 ([#5881](https://github.com/ashlrai/phantom/issues/5881)) ([2e628cc](https://github.com/ashlrai/phantom/commit/2e628cc4329c93e35309315720ce340a876eb8d4))
* **RQ-DYNCONFIG-1:** BRIDGE_NOTES — RQ-DYNCONFIG-1 ([#6100](https://github.com/ashlrai/phantom/issues/6100)) ([f4923eb](https://github.com/ashlrai/phantom/commit/f4923eba66cb455f50e8fee6df54192b6be51b28))
* **RQ-EMPTY-SIGNAL-1:** BRIDGE_NOTES — RQ-EMPTY-SIGNAL-1 ([#6138](https://github.com/ashlrai/phantom/issues/6138)) ([31538fc](https://github.com/ashlrai/phantom/commit/31538fc026ccdf01b4772bd42a05d4dcd75b0aa2))
* **RQ-FLEET-PAGE-POLISH-1:** RQ-FLEET-PAGE-POLISH-1 ([#6139](https://github.com/ashlrai/phantom/issues/6139)) ([47c0c83](https://github.com/ashlrai/phantom/commit/47c0c830ad39fc171097fa2e937d5d6ae13f8131))
* **RQ-FLEET-VIZ-1:** RQ-FLEET-VIZ-1 — Unified fleet compute and agent visualizati ([#5920](https://github.com/ashlrai/phantom/issues/5920)) ([afcaf30](https://github.com/ashlrai/phantom/commit/afcaf30f61edd2605d6ce42ed7362510f1922a45))
* **RQ-GROK-CHIEFOFSTAFF-1:** RQ-GROK-CHIEFOFSTAFF-1 ([#5818](https://github.com/ashlrai/phantom/issues/5818)) ([ce33266](https://github.com/ashlrai/phantom/commit/ce33266e6ed1d898d00ff31a6155fabc27c47d44))
* **RQ-GROK-FEEDBACKLOOP-1:** RQ-GROK-FEEDBACKLOOP-1 handoff ([#5799](https://github.com/ashlrai/phantom/issues/5799)) ([6cbbae1](https://github.com/ashlrai/phantom/commit/6cbbae162be15db3f90dace82e76e19d04d964ac))
* **RQ-GROK-PROOFARTIFACT-1:** RQ-GROK-PROOFARTIFACT-1: bounded fleet proof artifacts ([#5821](https://github.com/ashlrai/phantom/issues/5821)) ([f7ed9c4](https://github.com/ashlrai/phantom/commit/f7ed9c48469403fe7d779f569339b99e956dcf95))
* **RQ-GROK-SELFMETRICS-1:** RQ-GROK-SELFMETRICS-1 ([#5800](https://github.com/ashlrai/phantom/issues/5800)) ([58d9683](https://github.com/ashlrai/phantom/commit/58d96834fa65a18c76f3146790f9132f5a8070cc))
* **RQ-GROK-SPECIALISTS-1:** RQ-GROK-SPECIALISTS-1 ([#5820](https://github.com/ashlrai/phantom/issues/5820)) ([2599abc](https://github.com/ashlrai/phantom/commit/2599abc2e6f9031ee982965ee81c4b42864b903e))
* **RQ-GROW-BRANDMEDIA-1:** RQ-GROW-BRANDMEDIA-1 — Brand media kit ([#5816](https://github.com/ashlrai/phantom/issues/5816)) ([6424b64](https://github.com/ashlrai/phantom/commit/6424b648329bd3842af385074938776e6a0172eb))
* **RQ-GROW-DESKTOP-CURRENCY-1:** BRIDGE_NOTES — RQ-GROW-DESKTOP-CURRENCY-1 ([#5797](https://github.com/ashlrai/phantom/issues/5797)) ([eb828bd](https://github.com/ashlrai/phantom/commit/eb828bd712be6ee04362df8f03bae349b3a7bbfd))
* **RQ-GROW-README-HERO-1:** RQ-GROW-README-HERO-1 handoff ([#5801](https://github.com/ashlrai/phantom/issues/5801)) ([5d79cab](https://github.com/ashlrai/phantom/commit/5d79cab8e65b84c76d269054cd3dc527c84dcc43))
* **RQ-IDEATION-LOOP-1:** RQ-IDEATION-LOOP-1 handoff ([#5805](https://github.com/ashlrai/phantom/issues/5805)) ([50f12bd](https://github.com/ashlrai/phantom/commit/50f12bddd5abb36c8e52f9e26b10c214e2a9dbfa))
* **RQ-MERGATE-GATEAUDIT-1:** RQ-MERGATE-GATEAUDIT-1 ([#6141](https://github.com/ashlrai/phantom/issues/6141)) ([62e238c](https://github.com/ashlrai/phantom/commit/62e238c2da8862409486643daf389090ea487cd9))
* **RQ-MUSE-OMLX-1:** RQ-MUSE-OMLX-1 ([#5804](https://github.com/ashlrai/phantom/issues/5804)) ([130cbbb](https://github.com/ashlrai/phantom/commit/130cbbbbda073091f6debc9034cb4112668bc33a))
* **RQ-MUSE-WIRE-1:** RQ-MUSE-WIRE-1 ([#5808](https://github.com/ashlrai/phantom/issues/5808)) ([f29d2d1](https://github.com/ashlrai/phantom/commit/f29d2d13b5a20aa14f7ad015f2496e8626bdb1c8))
* **RQ-NODE-CAPACITY-1:** BRIDGE_NOTES — RQ-NODE-CAPACITY-1 ([#5890](https://github.com/ashlrai/phantom/issues/5890)) ([0647b3b](https://github.com/ashlrai/phantom/commit/0647b3ba0e33a74529fe247a1dd6e262c4fce3e6))
* **RQ-NODE-RUNNER-1:** RQ-NODE-RUNNER-1 ([#5806](https://github.com/ashlrai/phantom/issues/5806)) ([63b7458](https://github.com/ashlrai/phantom/commit/63b74581929f485817fd9adc23f9dab2117fbc5e))
* **RQ-ORCH-LOOP-1:** RQ-ORCH-LOOP-1 ([#6106](https://github.com/ashlrai/phantom/issues/6106)) ([4272833](https://github.com/ashlrai/phantom/commit/427283353b3fd13dc322a2c935695b0312e49bb9))
* **RQ-ORCH-PEERPLAN-1:** BRIDGE_NOTES — RQ-ORCH-PEERPLAN-1 ([#6145](https://github.com/ashlrai/phantom/issues/6145)) ([2229280](https://github.com/ashlrai/phantom/commit/2229280f241a229a9b77cb6a91008c63e820ab6f))
* **RQ-OWNERASSIST-V2-1:** BRIDGE_NOTES — RQ-OWNERASSIST-V2-1 ([#6148](https://github.com/ashlrai/phantom/issues/6148)) ([4f02d58](https://github.com/ashlrai/phantom/commit/4f02d588cf772f2d0b8775e4c3f5a4591e969757))
* **RQ-PHX-AGENTROUTESDOC373:** RQ-PHX-AGENTROUTESDOC373 ([#5714](https://github.com/ashlrai/phantom/issues/5714)) ([205b58e](https://github.com/ashlrai/phantom/commit/205b58e613133b0b6cfa4be15832ca017c577545))
* **RQ-PHX-AUTOPILOTEXHAUSTONLY391:** BRIDGE_NOTES — RQ-PHX-AUTOPILOTEXHAUSTONLY391 ([#5926](https://github.com/ashlrai/phantom/issues/5926)) ([4b22504](https://github.com/ashlrai/phantom/commit/4b2250400644c9845a5a8f910ec585ebb069517d))
* **RQ-PHX-BRIDGEANSWERAGE430S:** BRIDGE_NOTES — RQ-PHX-BRIDGEANSWERAGE430S ([#6104](https://github.com/ashlrai/phantom/issues/6104)) ([869f513](https://github.com/ashlrai/phantom/commit/869f51367d2842eee53e8212494253f5ad05312e))
* **RQ-PHX-BRIDGECARDIDENTITY417C:** BRIDGE_NOTES — RQ-PHX-BRIDGECARDIDENTITY417C ([#6066](https://github.com/ashlrai/phantom/issues/6066)) ([13c55ba](https://github.com/ashlrai/phantom/commit/13c55baf37afceee6c6e1defa9f61c40f4c5825c))
* **RQ-PHX-BRIDGECHECKCARD410C:** BRIDGE_NOTES — RQ-PHX-BRIDGECHECKCARD410C ([#6040](https://github.com/ashlrai/phantom/issues/6040)) ([7f603f0](https://github.com/ashlrai/phantom/commit/7f603f0aa75f6a7963f78bffb2b61b2c85788c43))
* **RQ-PHX-BRIDGECHECKMCP406C:** RQ-PHX-BRIDGECHECKMCP406C — fleet_bridge_check MCP tool ([#6017](https://github.com/ashlrai/phantom/issues/6017)) ([225bb45](https://github.com/ashlrai/phantom/commit/225bb4533be9a5afd2d2d75b43cf283779a9de76))
* **RQ-PHX-BRIDGECHECKROUTE408C:** RQ-PHX-BRIDGECHECKROUTE408C ([#6026](https://github.com/ashlrai/phantom/issues/6026)) ([51b6873](https://github.com/ashlrai/phantom/commit/51b687347bcbd6acdbd12fa1f32ea9b4a4cea3b3))
* **RQ-PHX-BRIDGECHECKVERB408C:** RQ-PHX-BRIDGECHECKVERB408C ([#6025](https://github.com/ashlrai/phantom/issues/6025)) ([f12bbd4](https://github.com/ashlrai/phantom/commit/f12bbd4e25926880ad02bd5b3d0047f19877c8d5))
* **RQ-PHX-BRIDGECLAIMEXPIRY411S:** Bridge claim expiry qualification ([#6041](https://github.com/ashlrai/phantom/issues/6041)) ([e2ba1b9](https://github.com/ashlrai/phantom/commit/e2ba1b9eb0ac77cd749927016ccacf96ed78bb93))
* **RQ-PHX-BRIDGECLAIMSHAPE417S:** BRIDGE_NOTES — RQ-PHX-BRIDGECLAIMSHAPE417S ([#6065](https://github.com/ashlrai/phantom/issues/6065)) ([c2696a8](https://github.com/ashlrai/phantom/commit/c2696a8c9e0bbaab355cf8f0cf58d21751883e38))
* **RQ-PHX-BRIDGECLAIMTIME418S:** BRIDGE_NOTES — RQ-PHX-BRIDGECLAIMTIME418S ([#6069](https://github.com/ashlrai/phantom/issues/6069)) ([9a9b5af](https://github.com/ashlrai/phantom/commit/9a9b5af085da764a832d440dc4cb8efcdd5ed3d8))
* **RQ-PHX-BRIDGECLIDISK409S:** Bridge disk qualification ([#6033](https://github.com/ashlrai/phantom/issues/6033)) ([b446a11](https://github.com/ashlrai/phantom/commit/b446a1142f10669dcee9db8e7a08e16aa5c8a3b6))
* **RQ-PHX-BRIDGECLIDURABLE430S:** RQ-PHX-BRIDGECLIDURABLE430S ([#6098](https://github.com/ashlrai/phantom/issues/6098)) ([9ede363](https://github.com/ashlrai/phantom/commit/9ede363d2d1148b3dc83a0ec6ce763b728cd4368))
* **RQ-PHX-BRIDGECLIFIXTURE420S:** Bridge CLI claim fixture ([#6072](https://github.com/ashlrai/phantom/issues/6072)) ([1b189d1](https://github.com/ashlrai/phantom/commit/1b189d1a417e419293b9b2afd46bc1c4704e2268))
* **RQ-PHX-BRIDGECLIIDENTITY415S:** BRIDGE_NOTES — RQ-PHX-BRIDGECLIIDENTITY415S ([#6059](https://github.com/ashlrai/phantom/issues/6059)) ([8877811](https://github.com/ashlrai/phantom/commit/8877811bcd3d3378be4b507455c00ec7437b2e5b))
* **RQ-PHX-BRIDGECLIRETURN417S:** Bridge CLI return qualification ([#6064](https://github.com/ashlrai/phantom/issues/6064)) ([edb20cc](https://github.com/ashlrai/phantom/commit/edb20ccca4bcf19d2707a4014d19ee3947791607))
* **RQ-PHX-BRIDGEEVIDENCE409S:** BRIDGE_NOTES — RQ-PHX-BRIDGEEVIDENCE409S ([#6034](https://github.com/ashlrai/phantom/issues/6034)) ([acb8890](https://github.com/ashlrai/phantom/commit/acb8890ca981d9fde5738e926606d4c9126db547))
* **RQ-PHX-BRIDGEHTTPCONCURRENT419S:** HTTP bridge concurrency regression ([#6070](https://github.com/ashlrai/phantom/issues/6070)) ([5371a27](https://github.com/ashlrai/phantom/commit/5371a27c8568318e7b1e53eef0b8c9ca75937b28))
* **RQ-PHX-BRIDGEHTTPDISK410S:** BRIDGE_NOTES — RQ-PHX-BRIDGEHTTPDISK410S ([#6037](https://github.com/ashlrai/phantom/issues/6037)) ([ca56f44](https://github.com/ashlrai/phantom/commit/ca56f44166f9686a6f7c49a51a7563c2c7e8a407))
* **RQ-PHX-BRIDGEHTTPFRESH414S:** BRIDGE_NOTES — RQ-PHX-BRIDGEHTTPFRESH414S ([#6056](https://github.com/ashlrai/phantom/issues/6056)) ([90f3f5c](https://github.com/ashlrai/phantom/commit/90f3f5c6c1416f46a05861759626743770e34220))
* **RQ-PHX-BRIDGEHTTPHANDOFF431S:** Bridge HTTP durable handoff qualification ([#6105](https://github.com/ashlrai/phantom/issues/6105)) ([e15f429](https://github.com/ashlrai/phantom/commit/e15f429b7f730f4b4318060222aede351750709b))
* **RQ-PHX-BRIDGEHTTPRETURN418S:** HTTP bridge claim return ([#6068](https://github.com/ashlrai/phantom/issues/6068)) ([6da6102](https://github.com/ashlrai/phantom/commit/6da61025e8e438c1521089e60c4e29e3f25d8f7a))
* **RQ-PHX-BRIDGEMCPPROVENANCE420S:** BRIDGE_NOTES — RQ-PHX-BRIDGEMCPPROVENANCE420S ([#6073](https://github.com/ashlrai/phantom/issues/6073)) ([091c538](https://github.com/ashlrai/phantom/commit/091c538adddff5213341909c556bd32f632aa5aa))
* **RQ-PHX-BRIDGEMCPRETURN414S:** Bridge claim return qualification ([#6055](https://github.com/ashlrai/phantom/issues/6055)) ([2851674](https://github.com/ashlrai/phantom/commit/285167455647965ea76315ff2f11f05298902b95))
* **RQ-PHX-BRIDGEPEERDISK412S:** Bridge peer disk qualification ([#6048](https://github.com/ashlrai/phantom/issues/6048)) ([e5111cb](https://github.com/ashlrai/phantom/commit/e5111cb890ca6c9e34a88e6de9c00978009be015))
* **RQ-PHX-BRIDGEREADERDEADLINE413S:** BRIDGE_NOTES — RQ-PHX-BRIDGEREADERDEADLINE413S ([#6053](https://github.com/ashlrai/phantom/issues/6053)) ([68289f7](https://github.com/ashlrai/phantom/commit/68289f7fe37d71c1d0498a736510a6b96b2e0c1a))
* **RQ-PHX-BRIDGERUNTIMEFRESH412S:** BRIDGE_NOTES — RQ-PHX-BRIDGERUNTIMEFRESH412S ([#6049](https://github.com/ashlrai/phantom/issues/6049)) ([db66c49](https://github.com/ashlrai/phantom/commit/db66c49fa0d3d966daf7ff75e1d00abea256ea83))
* **RQ-PHX-BRIDGESLACKDISK410S:** Slack bridge ledger recovery qualification ([#6036](https://github.com/ashlrai/phantom/issues/6036)) ([7f5f4c6](https://github.com/ashlrai/phantom/commit/7f5f4c68fb2b8e70dd817b55e8203bfcf25ce543))
* **RQ-PHX-BUSWORKFEEDCLI442C:** RQ-PHX-BUSWORKFEEDCLI442C ([#6156](https://github.com/ashlrai/phantom/issues/6156)) ([104bab8](https://github.com/ashlrai/phantom/commit/104bab80e0cb088fe16bc65ab116eb5cfed9f921))
* **RQ-PHX-CLAIMBINDINGOVERFLOW388S:** Binding overflow now returns no bindings once more than 5,00 ([#5826](https://github.com/ashlrai/phantom/issues/5826)) ([f34dc63](https://github.com/ashlrai/phantom/commit/f34dc63937baabbcf37a67a6b6e62c93e7c9b98b))
* **RQ-PHX-CLAIMEXECCARD390:** RQ-PHX-CLAIMEXECCARD390 ([#5882](https://github.com/ashlrai/phantom/issues/5882)) ([04c86ff](https://github.com/ashlrai/phantom/commit/04c86ff04bbb35e47cab1afb117a80eaf6b8bcb5))
* **RQ-PHX-CLAIMEXECCARDTEST392:** Bridge notes ([#5921](https://github.com/ashlrai/phantom/issues/5921)) ([c9c0319](https://github.com/ashlrai/phantom/commit/c9c0319d9f22cdf4e426c3073b9456654cd84620))
* **RQ-PHX-CLAIMEXECEVIDENCE386:** BRIDGE_NOTES — RQ-PHX-CLAIMEXECEVIDENCE386 ([#5790](https://github.com/ashlrai/phantom/issues/5790)) ([925c9eb](https://github.com/ashlrai/phantom/commit/925c9eb9aa3f5a677ab18d1a6e3ea99dd44086fd))
* **RQ-PHX-CLAIMEXECMCP388:** RQ-PHX-CLAIMEXECMCP388 ([#5836](https://github.com/ashlrai/phantom/issues/5836)) ([ec252a4](https://github.com/ashlrai/phantom/commit/ec252a42eb3451a98d0f37e732c36c1f9c0536f2))
* **RQ-PHX-CLAIMEXECROUTE388:** BRIDGE_NOTES — RQ-PHX-CLAIMEXECROUTE388 ([#5833](https://github.com/ashlrai/phantom/issues/5833)) ([bdcbf27](https://github.com/ashlrai/phantom/commit/bdcbf274941fdea7eb6cbad634cf9056c1417746))
* **RQ-PHX-CLAIMEXECUTIONMCPDISK422S:** Bridge notes ([#6074](https://github.com/ashlrai/phantom/issues/6074)) ([bc22be2](https://github.com/ashlrai/phantom/commit/bc22be2cea6f7f60a7743840d7d43688871bd357))
* **RQ-PHX-CLAIMEXECUTIONTIME422S:** BRIDGE_NOTES — RQ-PHX-CLAIMEXECUTIONTIME422S ([#6075](https://github.com/ashlrai/phantom/issues/6075)) ([ba549b6](https://github.com/ashlrai/phantom/commit/ba549b6173bc51ff5b5c85a28d41145ae115e14e))
* **RQ-PHX-CLAIMEXPIREDRETURN379S:** BRIDGE_NOTES — RQ-PHX-CLAIMEXPIREDRETURN379S ([#5749](https://github.com/ashlrai/phantom/issues/5749)) ([4b4d434](https://github.com/ashlrai/phantom/commit/4b4d4345bea80f9f0315cb805bdb79ceda054590))
* **RQ-PHX-CLAIMHTTPASOF391S:** BRIDGE_NOTES — RQ-PHX-CLAIMHTTPASOF391S ([#5932](https://github.com/ashlrai/phantom/issues/5932)) ([254a0b5](https://github.com/ashlrai/phantom/commit/254a0b5e257596c672c634311eedd0e0a0f1c1ea))
* **RQ-PHX-CLAIMHTTPDISK423S:** BRIDGE_NOTES — RQ-PHX-CLAIMHTTPDISK423S ([#6078](https://github.com/ashlrai/phantom/issues/6078)) ([1af9c85](https://github.com/ashlrai/phantom/commit/1af9c852902f901aa2de9f4601a973d2b2affb5c))
* **RQ-PHX-CLAIMHTTPISOLATE423S:** Claim execution HTTP isolation ([#6077](https://github.com/ashlrai/phantom/issues/6077)) ([ea71678](https://github.com/ashlrai/phantom/commit/ea71678f5494123ed4ccd5de97d44c86bde52ea1))
* **RQ-PHX-CLAIMLEASEREAP378:** RQ-PHX-CLAIMLEASEREAP378 ([#5743](https://github.com/ashlrai/phantom/issues/5743)) ([9c5c132](https://github.com/ashlrai/phantom/commit/9c5c13219f63cbb2d6aa77c1502f1c447e566b7f))
* **RQ-PHX-CLAIMLOOPE2E378:** RQ-PHX-CLAIMLOOPE2E378 ([#5742](https://github.com/ashlrai/phantom/issues/5742)) ([ad1cae9](https://github.com/ashlrai/phantom/commit/ad1cae982af506c2095a3928684babc6d76b3fc8))
* **RQ-PHX-CLAIMMCPLIVENESS390S:** BRIDGE_NOTES — RQ-PHX-CLAIMMCPLIVENESS390S ([#5883](https://github.com/ashlrai/phantom/issues/5883)) ([12c350c](https://github.com/ashlrai/phantom/commit/12c350c8cd2f3bc5d3fbbb3107976df46882eb2d))
* **RQ-PHX-CLAIMNOTICEDELIVERY440C:** RQ-PHX-CLAIMNOTICEDELIVERY440C — claim-notice Slack delivery ([#6133](https://github.com/ashlrai/phantom/issues/6133)) ([361cf3b](https://github.com/ashlrai/phantom/commit/361cf3bf7979a5418fdbdc0ed860d30e387f60c4))
* **RQ-PHX-CLAIMNOTICEDESK438C:** BRIDGE_NOTES — RQ-PHX-CLAIMNOTICEDESK438C ([#6131](https://github.com/ashlrai/phantom/issues/6131)) ([52f8072](https://github.com/ashlrai/phantom/commit/52f807253fc1851c45688257554b32620009cfcc))
* **RQ-PHX-CLAIMNOTICEMCP440C:** RQ-PHX-CLAIMNOTICEMCP440C ([#6132](https://github.com/ashlrai/phantom/issues/6132)) ([656bd1f](https://github.com/ashlrai/phantom/commit/656bd1fbfd574fb54fdd8e153837e93f90466285))
* **RQ-PHX-CLAIMNOTICESEND383:** BRIDGE_NOTES — RQ-PHX-CLAIMNOTICESEND383 ([#5782](https://github.com/ashlrai/phantom/issues/5782)) ([48d139b](https://github.com/ashlrai/phantom/commit/48d139beab5db92111fc394e0f64af277bb70bde))
* **RQ-PHX-CLAIMORDERLINK429C:** RQ-PHX-CLAIMORDERLINK429C — bridge notes ([#6095](https://github.com/ashlrai/phantom/issues/6095)) ([2e7e607](https://github.com/ashlrai/phantom/commit/2e7e607ca6c8682fe0ff7a16a81ac804ea08f4ec))
* **RQ-PHX-CLAIMPROCESSFRESH389S:** BRIDGE_NOTES — RQ-PHX-CLAIMPROCESSFRESH389S ([#5859](https://github.com/ashlrai/phantom/issues/5859)) ([c028609](https://github.com/ashlrai/phantom/commit/c028609716bc51fc57e559007429098f75c967de))
* **RQ-PHX-CLAIMREPOIDENTITY425S:** Bridge notes ([#6083](https://github.com/ashlrai/phantom/issues/6083)) ([7b048fc](https://github.com/ashlrai/phantom/commit/7b048fcd04dd45e9edadd4cd313b3c5929fd7e43))
* **RQ-PHX-CLAIMRETURN375:** RQ-PHX-CLAIMRETURN375 ([#5727](https://github.com/ashlrai/phantom/issues/5727)) ([4962b71](https://github.com/ashlrai/phantom/commit/4962b7175437c86fdd466a48a7d78d2d64f79f1d))
* **RQ-PHX-CLAIMSTALEBADGE406C:** RQ-PHX-CLAIMSTALEBADGE406C ([#6011](https://github.com/ashlrai/phantom/issues/6011)) ([aa14bc5](https://github.com/ashlrai/phantom/commit/aa14bc57652af8d7169f340d98651c50bddac150))
* **RQ-PHX-CLAIMTHREADBIND443C:** RQ-PHX-CLAIMTHREADBIND443C — `ashlr fleet claim-bind` ([#6163](https://github.com/ashlrai/phantom/issues/6163)) ([0db73eb](https://github.com/ashlrai/phantom/commit/0db73ebd0d160d1b146f732fa412692d868e5316))
* **RQ-PHX-CLAIMTHREADNOTICE378:** RQ-PHX-CLAIMTHREADNOTICE378 ([#5741](https://github.com/ashlrai/phantom/issues/5741)) ([c07ad1b](https://github.com/ashlrai/phantom/commit/c07ad1b92736a0f7e3705714ed756f603b4842ff))
* **RQ-PHX-CLAIMTOKENBOUNDARY427S:** BRIDGE_NOTES — RQ-PHX-CLAIMTOKENBOUNDARY427S ([#6089](https://github.com/ashlrai/phantom/issues/6089)) ([90785df](https://github.com/ashlrai/phantom/commit/90785dfea8c6c31b91b0879b31dffcf38f18e4c0))
* **RQ-PHX-CLAIMWORKERPROOF388S:** BRIDGE_NOTES — RQ-PHX-CLAIMWORKERPROOF388S ([#5832](https://github.com/ashlrai/phantom/issues/5832)) ([98a3747](https://github.com/ashlrai/phantom/commit/98a3747078e29af33b9fe9b003e23a8c94fa10f0))
* **RQ-PHX-CLAUDEPOOLOBSERVED391:** RQ-PHX-CLAUDEPOOLOBSERVED391 bridge notes ([#5914](https://github.com/ashlrai/phantom/issues/5914)) ([7adb148](https://github.com/ashlrai/phantom/commit/7adb14818cb0f8df72839709d3e3f805d86f818b))
* **RQ-PHX-COORDCLAIMHTTP376:** RQ-PHX-COORDCLAIMHTTP376: HTTP claim/return on the advisory ([#5735](https://github.com/ashlrai/phantom/issues/5735)) ([2130431](https://github.com/ashlrai/phantom/commit/2130431b14f3c4d18ef520bcf6811cecae41ede8))
* **RQ-PHX-COORDCLAIMSMCP376:** RQ-PHX-COORDCLAIMSMCP376 ([#5734](https://github.com/ashlrai/phantom/issues/5734)) ([ceac20b](https://github.com/ashlrai/phantom/commit/ceac20bcebbd5f666a9c06d193121f442451fa45))
* **RQ-PHX-COORDRETURNDOC376:** Bridge notes ([#5732](https://github.com/ashlrai/phantom/issues/5732)) ([d48e0ea](https://github.com/ashlrai/phantom/commit/d48e0ea342cec8bcf89c20ac34421c53f8207f55))
* **RQ-PHX-COORDRETURNSMCP392:** RQ-PHX-COORDRETURNSMCP392 ([#5924](https://github.com/ashlrai/phantom/issues/5924)) ([d5d807f](https://github.com/ashlrai/phantom/commit/d5d807f0b0e93b2825ba6cb52f9849f575bc28dd))
* **RQ-PHX-COORDRETURNSREAD377:** RQ-PHX-COORDRETURNSREAD377 ([#5737](https://github.com/ashlrai/phantom/issues/5737)) ([1e57a4a](https://github.com/ashlrai/phantom/commit/1e57a4a2fa237c82ad162fca39db4385654a2652))
* **RQ-PHX-DESKTESTRECOVER437S:** Desktop transport preservation receipt ([#6121](https://github.com/ashlrai/phantom/issues/6121)) ([956274b](https://github.com/ashlrai/phantom/commit/956274b1c53ef5f8c7b899be49b9508a8eebeac4))
* **RQ-PHX-EMPTYMERGESVERB371:** RQ-PHX-EMPTYMERGESVERB371 — `ashlr fleet empty-merges` ([#5711](https://github.com/ashlrai/phantom/issues/5711)) ([f76d89e](https://github.com/ashlrai/phantom/commit/f76d89e275d7dede0d3c1761b6f23fa73790d890))
* **RQ-PHX-HANDOFFMCP401:** RQ-PHX-HANDOFFMCP401 ([#5988](https://github.com/ashlrai/phantom/issues/5988)) ([e0a6388](https://github.com/ashlrai/phantom/commit/e0a6388e93c591e5e35d37f3b4d4ef0ae18e31f4))
* **RQ-PHX-HISTORYRETENTIONCLI342S:** BRIDGE_NOTES: RQ-PHX-HISTORYRETENTIONCLI342S ([#5583](https://github.com/ashlrai/phantom/issues/5583)) ([a819b09](https://github.com/ashlrai/phantom/commit/a819b09386dbacf3b0eaa6c40cce6231a8b936a2))
* **RQ-PHX-HOSTHTTPRECOVERY354S:** BRIDGE_NOTES — RQ-PHX-HOSTHTTPRECOVERY354S ([#5642](https://github.com/ashlrai/phantom/issues/5642)) ([1bb9dd2](https://github.com/ashlrai/phantom/commit/1bb9dd2d17a9e2b69b5f4b084209295682a44dae))
* **RQ-PHX-HOSTREACHROUTE353:** BRIDGE_NOTES — RQ-PHX-HOSTREACHROUTE353 ([#5635](https://github.com/ashlrai/phantom/issues/5635)) ([0456079](https://github.com/ashlrai/phantom/commit/0456079b8307d80ec4a64d4a509889b58487e293))
* **RQ-PHX-IDEATIONSTATUS401:** RQ-PHX-IDEATIONSTATUS401: `ashlr fleet ideation-status` ([#5989](https://github.com/ashlrai/phantom/issues/5989)) ([2e73c29](https://github.com/ashlrai/phantom/commit/2e73c29341a66e377847592b28078392c56f339a))
* **RQ-PHX-INTENTCLOSUREFIX406C:** BRIDGE_NOTES — RQ-PHX-INTENTCLOSUREFIX406C ([#6018](https://github.com/ashlrai/phantom/issues/6018)) ([635adb8](https://github.com/ashlrai/phantom/commit/635adb8418da1cf490677b97f03dc42bd11e5341))
* **RQ-PHX-INTERJECTRECEIPT406C:** BRIDGE_NOTES — RQ-PHX-INTERJECTRECEIPT406C ([#6016](https://github.com/ashlrai/phantom/issues/6016)) ([b0728d0](https://github.com/ashlrai/phantom/commit/b0728d025170e5afc788a585444da8886dc09032))
* **RQ-PHX-INTERJECTSERVERSTATE416C:** BRIDGE_NOTES — RQ-PHX-INTERJECTSERVERSTATE416C ([#6063](https://github.com/ashlrai/phantom/issues/6063)) ([0534179](https://github.com/ashlrai/phantom/commit/0534179382939b3b06c648075222b14a43f28b1f))
* **RQ-PHX-JOURNALWRITETIME445S:** RQ-PHX-JOURNALWRITETIME445S ([#6172](https://github.com/ashlrai/phantom/issues/6172)) ([b1a2cd1](https://github.com/ashlrai/phantom/commit/b1a2cd1ee58c86ce1c5b26c5cd21c0398bc86967))
* **RQ-PHX-LAUNCHEDWORD416C:** RQ-PHX-LAUNCHEDWORD416C ([#6061](https://github.com/ashlrai/phantom/issues/6061)) ([2603775](https://github.com/ashlrai/phantom/commit/26037756c90afbecb45c8b5b44d78e99df5758f2))
* **RQ-PHX-MCPBRIDGECONCURRENT416S:** RQ-PHX-MCPBRIDGECONCURRENT416S ([#6062](https://github.com/ashlrai/phantom/issues/6062)) ([97ca364](https://github.com/ashlrai/phantom/commit/97ca364453e39189d762f3b2c7e16fa45b75bb2e))
* **RQ-PHX-MCPBRIDGEDISK411S:** BRIDGE_NOTES — RQ-PHX-MCPBRIDGEDISK411S ([#6044](https://github.com/ashlrai/phantom/issues/6044)) ([93731d7](https://github.com/ashlrai/phantom/commit/93731d762f76216fc08e226f228517ea183221d5))
* **RQ-PHX-MCPCLAIMFRESH425S:** BRIDGE_NOTES — RQ-PHX-MCPCLAIMFRESH425S ([#6084](https://github.com/ashlrai/phantom/issues/6084)) ([3f2f8e1](https://github.com/ashlrai/phantom/commit/3f2f8e1728b817836ed0b7666cbeb42a2eea119e))
* **RQ-PHX-MCPCLAIMISOLATE424S:** RQ-PHX-MCPCLAIMISOLATE424S ([#6081](https://github.com/ashlrai/phantom/issues/6081)) ([7f22cbc](https://github.com/ashlrai/phantom/commit/7f22cbccb6134e7cabf5f432f72d506fb0c01ac9))
* **RQ-PHX-MCPRUNTIMEISOLATION429S:** RQ-PHX-MCPRUNTIMEISOLATION429S ([#6093](https://github.com/ashlrai/phantom/issues/6093)) ([f026a47](https://github.com/ashlrai/phantom/commit/f026a47c61e9583b3dbbaffc96dbf261942b5b2b))
* **RQ-PHX-MCPRUNTIMELIFECYCLE429S:** MCP runtime durable lifecycle qualification ([#6094](https://github.com/ashlrai/phantom/issues/6094)) ([61c7e6a](https://github.com/ashlrai/phantom/commit/61c7e6a790b56b41fa7ab1b23fb8687ce1ddbb17))
* **RQ-PHX-MERGECOCKPITRECOVER10SRJ2:** Merge cockpit recovery ([#4664](https://github.com/ashlrai/phantom/issues/4664)) ([a352d7f](https://github.com/ashlrai/phantom/commit/a352d7f3fbfc3519520de0f172e0711b84d79a53))
* **RQ-PHX-NOAUTORESERVEMONITOR391:** RQ-PHX-NOAUTORESERVEMONITOR391 ([#5922](https://github.com/ashlrai/phantom/issues/5922)) ([db2b1ef](https://github.com/ashlrai/phantom/commit/db2b1ef6750a56a78fc199ca17cb325209b1ba36))
* **RQ-PHX-NOTICEEVIDENCE351S:** BRIDGE_NOTES — RQ-PHX-NOTICEEVIDENCE351S ([#5625](https://github.com/ashlrai/phantom/issues/5625)) ([8601d25](https://github.com/ashlrai/phantom/commit/8601d2591c2750513a8af143002ab025bf8fce90))
* **RQ-PHX-NOTICEFUTUREBOUND445S:** BRIDGE_NOTES — RQ-PHX-NOTICEFUTUREBOUND445S ([#6171](https://github.com/ashlrai/phantom/issues/6171)) ([8ebeeea](https://github.com/ashlrai/phantom/commit/8ebeeea58a7f1a9769dc3ff1f4b31618cdeaa860))
* **RQ-PHX-NOTIFYDRYRUNRECOVERY348S:** BRIDGE_NOTES — RQ-PHX-NOTIFYDRYRUNRECOVERY348S ([#5610](https://github.com/ashlrai/phantom/issues/5610)) ([c106660](https://github.com/ashlrai/phantom/commit/c106660d190a2621ba46b2be7a85fd2a0c9d0fb1))
* **RQ-PHX-NOTIFYKILLRESUME344S:** BRIDGE_NOTES — RQ-PHX-NOTIFYKILLRESUME344S ([#5611](https://github.com/ashlrai/phantom/issues/5611)) ([b1ac601](https://github.com/ashlrai/phantom/commit/b1ac601c9712f20fed468fe838712dbe228bf9aa))
* **RQ-PHX-NOTIFYLEDGERRECOVERY338S:** Bridge Notes - RQ-PHX-NOTIFYLEDGERRECOVERY338S ([#5576](https://github.com/ashlrai/phantom/issues/5576)) ([f4e92ad](https://github.com/ashlrai/phantom/commit/f4e92adc4052e2abf096f075d603946e5f6e3dd9))
* **RQ-PHX-NOTIFYLIMITPRESERVE353S:** BRIDGE_NOTES — RQ-PHX-NOTIFYLIMITPRESERVE353S ([#5639](https://github.com/ashlrai/phantom/issues/5639)) ([0482d39](https://github.com/ashlrai/phantom/commit/0482d39a5b6b2c76e6ff7bf3d8dd71f9b8a6d532))
* **RQ-PHX-NOTIFYPENDINGSUPERSEDE344S:** BRIDGE_NOTES — RQ-PHX-NOTIFYPENDINGSUPERSEDE344S ([#5567](https://github.com/ashlrai/phantom/issues/5567)) ([27e0e05](https://github.com/ashlrai/phantom/commit/27e0e05f99cc0579475b7c86c99d6c4c6a6918de))
* **RQ-PHX-NOTIFYQUEUESTATUS350S:** BRIDGE_NOTES — RQ-PHX-NOTIFYQUEUESTATUS350S ([#5622](https://github.com/ashlrai/phantom/issues/5622)) ([8f8a3e0](https://github.com/ashlrai/phantom/commit/8f8a3e0db27bb189ac78629c56f009fb7fc60e34))
* **RQ-PHX-NOTIFYTHREADREBIND349S:** BRIDGE_NOTES — RQ-PHX-NOTIFYTHREADREBIND349S ([#5617](https://github.com/ashlrai/phantom/issues/5617)) ([408cfba](https://github.com/ashlrai/phantom/commit/408cfba072eaa7b252fb4c3a3995106e34814770))
* **RQ-PHX-ORCHJOURNALDESK442C:** RQ-PHX-ORCHJOURNALDESK442C ([#6157](https://github.com/ashlrai/phantom/issues/6157)) ([a30c45d](https://github.com/ashlrai/phantom/commit/a30c45deabdce0ca0d9763adab1cc34d86b8bc21))
* **RQ-PHX-ORCHJOURNALREAD438C:** RQ-PHX-ORCHJOURNALREAD438C ([#6130](https://github.com/ashlrai/phantom/issues/6130)) ([a2a901f](https://github.com/ashlrai/phantom/commit/a2a901f3d40debf2cebb58f42efa8c49b0f394f4))
* **RQ-PHX-ORDERAPIDEADLINE371S:** BRIDGE_NOTES — RQ-PHX-ORDERAPIDEADLINE371S ([#5707](https://github.com/ashlrai/phantom/issues/5707)) ([9083c30](https://github.com/ashlrai/phantom/commit/9083c30e107947223c833735d14903b71fcba190))
* **RQ-PHX-ORDERAPIEVIDENCEOWNER366:** BRIDGE_NOTES — RQ-PHX-ORDERAPIEVIDENCEOWNER366 ([#5685](https://github.com/ashlrai/phantom/issues/5685)) ([5562969](https://github.com/ashlrai/phantom/commit/5562969eba685fc936dd6dc6cdbbe66cf7c0bc8d))
* **RQ-PHX-ORDERAPIHELD368S:** BRIDGE_NOTES — RQ-PHX-ORDERAPIHELD368S ([#5692](https://github.com/ashlrai/phantom/issues/5692)) ([89b408c](https://github.com/ashlrai/phantom/commit/89b408cc2bb599c882daff937289cfa50df94da1))
* **RQ-PHX-ORDERAPILIVE362S:** BRIDGE_NOTES — RQ-PHX-ORDERAPILIVE362S ([#5669](https://github.com/ashlrai/phantom/issues/5669)) ([4931ec1](https://github.com/ashlrai/phantom/commit/4931ec1f8a123335f12faf312381809a13d14cf1))
* **RQ-PHX-ORDERAPIREROUTEPROOF370S:** RQ-PHX-ORDERAPIREROUTEPROOF370S ([#5699](https://github.com/ashlrai/phantom/issues/5699)) ([9721ece](https://github.com/ashlrai/phantom/commit/9721ece18cd8f8981d580b669137ed6517dc9d04))
* **RQ-PHX-ORDERCLIDISKRECOVERY363S:** BRIDGE_NOTES — RQ-PHX-ORDERCLIDISKRECOVERY363S ([#5679](https://github.com/ashlrai/phantom/issues/5679)) ([1c18d78](https://github.com/ashlrai/phantom/commit/1c18d78d4ae7c1f0185def3ecf640fcf04d58a76))
* **RQ-PHX-ORDERCLIEVIDENCEOWNER366:** ([#5720](https://github.com/ashlrai/phantom/issues/5720)) ([f3cb8d2](https://github.com/ashlrai/phantom/commit/f3cb8d28b0f515ad77ad7d9ef1aca0fd00353b5d))
* **RQ-PHX-ORDERCLISOURCERECOVERY360S:** ([#5703](https://github.com/ashlrai/phantom/issues/5703)) ([58e4473](https://github.com/ashlrai/phantom/commit/58e44738a7b7d759648a5df39c87baa5140c690b))
* **RQ-PHX-ORDEREMPTYBLOCKED370:** BRIDGE_NOTES — RQ-PHX-ORDEREMPTYBLOCKED370 ([#5701](https://github.com/ashlrai/phantom/issues/5701)) ([a7eb85a](https://github.com/ashlrai/phantom/commit/a7eb85ada72f125062fa369c57717e9561b309c8))
* **RQ-PHX-ORDEREXECJOIN390:** BRIDGE_NOTES — RQ-PHX-ORDEREXECJOIN390 ([#5896](https://github.com/ashlrai/phantom/issues/5896)) ([3d1239a](https://github.com/ashlrai/phantom/commit/3d1239ac8d90acc12093d1aa5925c8eb25c78a79))
* **RQ-PHX-ORDERFOLLOWUP370:** RQ-PHX-ORDERFOLLOWUP370 ([#5702](https://github.com/ashlrai/phantom/issues/5702)) ([f074042](https://github.com/ashlrai/phantom/commit/f074042a7086ee90b1e747776c9d493053c5cf93))
* **RQ-PHX-ORDERHOLDRECOVERY367S:** BRIDGE_NOTES — RQ-PHX-ORDERHOLDRECOVERY367S ([#5691](https://github.com/ashlrai/phantom/issues/5691)) ([7dfb3d7](https://github.com/ashlrai/phantom/commit/7dfb3d7d5a85aecde738e8b9e8802bb238e63247))
* **RQ-PHX-ORDERJOBSVERB363:** ([#5739](https://github.com/ashlrai/phantom/issues/5739)) ([8b0e9eb](https://github.com/ashlrai/phantom/commit/8b0e9eb62129e0fde715e4923274d3c31819ad29))
* **RQ-PHX-ORDERLANEBLOCKED366:** RQ-PHX-ORDERLANEBLOCKED366: orders reach BLOCKED on a held l ([#5684](https://github.com/ashlrai/phantom/issues/5684)) ([e0310b5](https://github.com/ashlrai/phantom/commit/e0310b56c3cf49ae1fb469f928237e9c32554b6d))
* **RQ-PHX-ORDERMCPDEADLINERETRY372S:** RQ-PHX-ORDERMCPDEADLINERETRY372S ([#5710](https://github.com/ashlrai/phantom/issues/5710)) ([61c73bd](https://github.com/ashlrai/phantom/commit/61c73bdcc8ffb6e6fcb2303dd583e1adbc3f52f0))
* **RQ-PHX-ORDERMCPHELDPARITY369S:** BRIDGE_NOTES — RQ-PHX-ORDERMCPHELDPARITY369S ([#5694](https://github.com/ashlrai/phantom/issues/5694)) ([b3faec9](https://github.com/ashlrai/phantom/commit/b3faec9ccb7aaefb0d0f3cce2f06b524da18cf7a))
* **RQ-PHX-ORDERMCPMULTIBIND371S:** BRIDGE_NOTES — RQ-PHX-ORDERMCPMULTIBIND371S ([#5708](https://github.com/ashlrai/phantom/issues/5708)) ([932c880](https://github.com/ashlrai/phantom/commit/932c880150213f26002bd57b2b267e632c7496b5))
* **RQ-PHX-ORDERMCPRECONNECT365S:** BRIDGE_NOTES — RQ-PHX-ORDERMCPRECONNECT365S ([#5683](https://github.com/ashlrai/phantom/issues/5683)) ([0ed4723](https://github.com/ashlrai/phantom/commit/0ed4723e99a7a528dc8fba767095ce69c12c2f92))
* **RQ-PHX-ORDERMERGETRUTH360S:** BRIDGE_NOTES — RQ-PHX-ORDERMERGETRUTH360S ([#5664](https://github.com/ashlrai/phantom/issues/5664)) ([a2766f6](https://github.com/ashlrai/phantom/commit/a2766f609d39a064266d1fae33733fdb5061f494))
* **RQ-PHX-ORDERMIXEDLANES367S:** ([#5704](https://github.com/ashlrai/phantom/issues/5704)) ([8ab938d](https://github.com/ashlrai/phantom/commit/8ab938db3e7ab61414e38c1deec7ca8b3a1466cf))
* **RQ-PHX-ORDERMULTIJOBLIVE363S:** BRIDGE_NOTES — RQ-PHX-ORDERMULTIJOBLIVE363S ([#5673](https://github.com/ashlrai/phantom/issues/5673)) ([22fd692](https://github.com/ashlrai/phantom/commit/22fd69255c7c18dbdd0c0f6a4503743f181c1c91))
* **RQ-PHX-ORDEROWNERMCP365:** BRIDGE_NOTES — RQ-PHX-ORDEROWNERMCP365 ([#5680](https://github.com/ashlrai/phantom/issues/5680)) ([4d41a6a](https://github.com/ashlrai/phantom/commit/4d41a6af2086d82f2aaa44dd9c4ac3ae07e5d730))
* **RQ-PHX-ORDEROWNERSTRIP365:** RQ-PHX-ORDEROWNERSTRIP365 ([#5681](https://github.com/ashlrai/phantom/issues/5681)) ([4a6762e](https://github.com/ashlrai/phantom/commit/4a6762efe04be88103af8065ed0a560ebaa20b3e))
* **RQ-PHX-ORDERPROMPTBOUNDRECOVERY361S:** BRIDGE_NOTES — RQ-PHX-ORDERPROMPTBOUNDRECOVERY361S ([#5676](https://github.com/ashlrai/phantom/issues/5676)) ([80620eb](https://github.com/ashlrai/phantom/commit/80620ebe11adaa0269b0d1512834841b27a9ce99))
* **RQ-PHX-ORDERQUEUEDLANE368:** RQ-PHX-ORDERQUEUEDLANE368 — bridge notes ([#5693](https://github.com/ashlrai/phantom/issues/5693)) ([c9bd9ae](https://github.com/ashlrai/phantom/commit/c9bd9ae73b589de394d84dd1d64240e3df2270c2))
* **RQ-PHX-ORDERRUNNINGLIVE359:** BRIDGE_NOTES — RQ-PHX-ORDERRUNNINGLIVE359 ([#5660](https://github.com/ashlrai/phantom/issues/5660)) ([4021098](https://github.com/ashlrai/phantom/commit/4021098e95277a5f7aeaed981f3c3b7af7540210))
* **RQ-PHX-ORDERSLACKVERIFY363:** RQ-PHX-ORDERSLACKVERIFY363 — Slack order → work-board result ([#5674](https://github.com/ashlrai/phantom/issues/5674)) ([27d4635](https://github.com/ashlrai/phantom/commit/27d4635ac8281840447cb6d5d2b6dadd7b100e74))
* **RQ-PHX-ORDERSOURCECLI364S:** Bridge Notes: Cross-Channel Order Attribution Preservation ([#5752](https://github.com/ashlrai/phantom/issues/5752)) ([3e3b7a0](https://github.com/ashlrai/phantom/commit/3e3b7a02052d18d948c10388039588c1b588781b))
* **RQ-PHX-ORDERSREPLYBLOCKED369:** RQ-PHX-ORDERSREPLYBLOCKED369 — Slack "orders" reply reports ([#5695](https://github.com/ashlrai/phantom/issues/5695)) ([07951f4](https://github.com/ashlrai/phantom/commit/07951f4714248f97eaf712a6e6938c317c452569))
* **RQ-PHX-ORDERSTATEAPI359:** BRIDGE_NOTES — RQ-PHX-ORDERSTATEAPI359 ([#5659](https://github.com/ashlrai/phantom/issues/5659)) ([8551f9b](https://github.com/ashlrai/phantom/commit/8551f9bc6dc579c8ba9abbfeba0f7ae586e4cba1))
* **RQ-PHX-ORDERSTATEMCPTOOL364:** BRIDGE_NOTES — RQ-PHX-ORDERSTATEMCPTOOL364 ([#5677](https://github.com/ashlrai/phantom/issues/5677)) ([61c0bbe](https://github.com/ashlrai/phantom/commit/61c0bbe75ae3e05fe0a0ba9455a4ea9dc1d4e44c))
* **RQ-PHX-ORDERSTATESTRIP359:** BRIDGE_NOTES — RQ-PHX-ORDERSTATESTRIP359 ([#5661](https://github.com/ashlrai/phantom/issues/5661)) ([f241b07](https://github.com/ashlrai/phantom/commit/f241b07623e6dd200b727370199c3f011f46e52f))
* **RQ-PHX-ORDERSTRIPBLOCKER369:** BRIDGE_NOTES — RQ-PHX-ORDERSTRIPBLOCKER369 ([#5697](https://github.com/ashlrai/phantom/issues/5697)) ([9749599](https://github.com/ashlrai/phantom/commit/97495991d1bc19731cba0790fa8ec15e988a5bd5))
* **RQ-PHX-ORDERSTRIPLIVEHONEST364:** BRIDGE_NOTES — RQ-PHX-ORDERSTRIPLIVEHONEST364 ([#5678](https://github.com/ashlrai/phantom/issues/5678)) ([619b124](https://github.com/ashlrai/phantom/commit/619b12422879072310fcc27256bfb0e34fbfdf9d))
* **RQ-PHX-ORDERWORKERLIFECYCLE361S:** BRIDGE_NOTES — RQ-PHX-ORDERWORKERLIFECYCLE361S ([#5667](https://github.com/ashlrai/phantom/issues/5667)) ([cc4b757](https://github.com/ashlrai/phantom/commit/cc4b757efe9ff2b890bfaf750551d5337d401777))
* **RQ-PHX-PACINGFULLUSE391:** RQ-PHX-PACINGFULLUSE391 ([#5915](https://github.com/ashlrai/phantom/issues/5915)) ([317bdb7](https://github.com/ashlrai/phantom/commit/317bdb7d69b547082bd1d3d7a9d557e73b9333ca))
* **RQ-PHX-PEERBROADCASTELIGIBLE405S:** BRIDGE_NOTES — RQ-PHX-PEERBROADCASTELIGIBLE405S ([#6005](https://github.com/ashlrai/phantom/issues/6005)) ([0d302b9](https://github.com/ashlrai/phantom/commit/0d302b91e366bd6d2822d855d7555e946f72efe6))
* **RQ-PHX-PEERBUSROWS393:** RQ-PHX-PEERBUSROWS393 ([#5927](https://github.com/ashlrai/phantom/issues/5927)) ([8ace2ba](https://github.com/ashlrai/phantom/commit/8ace2ba95bc2bc97015eb5440be2a047d11b12a3))
* **RQ-PHX-PEERCARDPATHFIX410C:** RQ-PHX-PEERCARDPATHFIX410C ([#6038](https://github.com/ashlrai/phantom/issues/6038)) ([c91aa0c](https://github.com/ashlrai/phantom/commit/c91aa0c305d5ee11d35cf833a0f4db9cb8f17b78))
* **RQ-PHX-PEERCHANNELREPLY406S:** BRIDGE_NOTES — RQ-PHX-PEERCHANNELREPLY406S ([#6015](https://github.com/ashlrai/phantom/issues/6015)) ([756f249](https://github.com/ashlrai/phantom/commit/756f249e716d3979ea926914a9023a5d447f4db5))
* **RQ-PHX-PEERCLICLOCKRECOVERY399S:** RQ-PHX-PEERCLICLOCKRECOVERY399S ([#5979](https://github.com/ashlrai/phantom/issues/5979)) ([32e4d1f](https://github.com/ashlrai/phantom/commit/32e4d1f5371926e19308425749e980b598ebed84))
* **RQ-PHX-PEERCLIRECONNECT396S:** RQ-PHX-PEERCLIRECONNECT396S ([#5962](https://github.com/ashlrai/phantom/issues/5962)) ([2eaedd5](https://github.com/ashlrai/phantom/commit/2eaedd516ed23aa9e94a3aa5294f0f4efa143156))
* **RQ-PHX-PEERCLIRETRY397S:** Bridge notes ([#5972](https://github.com/ashlrai/phantom/issues/5972)) ([bd68d5f](https://github.com/ashlrai/phantom/commit/bd68d5f5334af4021bb47a9b94be83ddc6ca06ef))
* **RQ-PHX-PEERCLISELECTRECOVERY402S:** Peer ledger selected recovery 402s ([#5993](https://github.com/ashlrai/phantom/issues/5993)) ([5e281a1](https://github.com/ashlrai/phantom/commit/5e281a155ba48c70cb8df854140fa6bb3c619a36))
* **RQ-PHX-PEERDELAYEDDELIVERY403S:** BRIDGE_NOTES — RQ-PHX-PEERDELAYEDDELIVERY403S ([#6000](https://github.com/ashlrai/phantom/issues/6000)) ([723e8e3](https://github.com/ashlrai/phantom/commit/723e8e3ab34151cbd0054e5d2f6f9d9b0709eac8))
* **RQ-PHX-PEERHTTPRETRY406S:** RQ-PHX-PEERHTTPRETRY406S ([#6012](https://github.com/ashlrai/phantom/issues/6012)) ([af0aa7e](https://github.com/ashlrai/phantom/commit/af0aa7e477d3a80e0e4dbd8893de83430fe153ac))
* **RQ-PHX-PEERLEDGERCARD395:** RQ-PHX-PEERLEDGERCARD395 ([#5960](https://github.com/ashlrai/phantom/issues/5960)) ([4175cae](https://github.com/ashlrai/phantom/commit/4175cae9efbd2826e24f593fcba23d471e0d36a1))
* **RQ-PHX-PEERLEDGERHTTP404S:** BRIDGE_NOTES — RQ-PHX-PEERLEDGERHTTP404S ([#6004](https://github.com/ashlrai/phantom/issues/6004)) ([b440143](https://github.com/ashlrai/phantom/commit/b440143db28172e5aab76d289bebf0e1344252d4))
* **RQ-PHX-PEERLEDGERMCP395:** RQ-PHX-PEERLEDGERMCP395 ([#5953](https://github.com/ashlrai/phantom/issues/5953)) ([092d215](https://github.com/ashlrai/phantom/commit/092d2150a68afda37ecead254333231b11592abc))
* **RQ-PHX-PEERLEDGERVERB393:** RQ-PHX-PEERLEDGERVERB393 — `ashlr fleet peer-ledger` ([#5938](https://github.com/ashlrai/phantom/issues/5938)) ([41fe581](https://github.com/ashlrai/phantom/commit/41fe58188d67e8d108eedc67088f03c6390b00ce))
* **RQ-PHX-PEERMCPACTUALBUDGET408S:** Peer MCP budget qualification ([#6027](https://github.com/ashlrai/phantom/issues/6027)) ([0bb6ea0](https://github.com/ashlrai/phantom/commit/0bb6ea0bf6ff0ffdb6c4f2165a8dcf05469d985c))
* **RQ-PHX-PEERMCPOFFLINERECOVERY397S:** RQ-PHX-PEERMCPOFFLINERECOVERY397S ([#5973](https://github.com/ashlrai/phantom/issues/5973)) ([76252b0](https://github.com/ashlrai/phantom/commit/76252b0e08f773a07cf73c8c6939dd90813e63cb))
* **RQ-PHX-PEERMCPPAIRLOOKUP402S:** BRIDGE_NOTES — RQ-PHX-PEERMCPPAIRLOOKUP402S ([#5996](https://github.com/ashlrai/phantom/issues/5996)) ([3442a17](https://github.com/ashlrai/phantom/commit/3442a178f92213a9dc700c6068122d59ac223cc9))
* **RQ-PHX-PEERMCPTRUNCATION399S:** RQ-PHX-PEERMCPTRUNCATION399S — fleet_peer_ledger truncation ([#5986](https://github.com/ashlrai/phantom/issues/5986)) ([a5c4f7a](https://github.com/ashlrai/phantom/commit/a5c4f7a5628677f9f508ed67e4718b598ec8ba77))
* **RQ-PHX-PEERPAIRLOOKUP400S:** BRIDGE_NOTES — RQ-PHX-PEERPAIRLOOKUP400S ([#5982](https://github.com/ashlrai/phantom/issues/5982)) ([d4c3d88](https://github.com/ashlrai/phantom/commit/d4c3d88da60d427cee476d99f3b6fe34cd3a6058))
* **RQ-PHX-PEERREADCLIRESUME405S:** Bridge notes ([#6007](https://github.com/ashlrai/phantom/issues/6007)) ([988910c](https://github.com/ashlrai/phantom/commit/988910c1e3749ed8177a50d1382e92be9aab90f6))
* **RQ-PHX-PEERRENEWCLIREPLY408S:** BRIDGE_NOTES — RQ-PHX-PEERRENEWCLIREPLY408S ([#6030](https://github.com/ashlrai/phantom/issues/6030)) ([2ef0c01](https://github.com/ashlrai/phantom/commit/2ef0c01848c39b3601d446decfcae0a245dec610))
* **RQ-PHX-PEERRETRYEVIDENCE396S:** BRIDGE_NOTES — RQ-PHX-PEERRETRYEVIDENCE396S ([#5961](https://github.com/ashlrai/phantom/issues/5961)) ([3cc91ef](https://github.com/ashlrai/phantom/commit/3cc91ef7001e9a39c7c93ac07839be52344c1363))
* **RQ-PHX-PEERSENDRETRY401S:** BRIDGE_NOTES — RQ-PHX-PEERSENDRETRY401S ([#5990](https://github.com/ashlrai/phantom/issues/5990)) ([a140be1](https://github.com/ashlrai/phantom/commit/a140be12cc358811b62f1adc642fab63aaab1f75))
* **RQ-PHX-PEERSESSIONRENEW407S:** RQ-PHX-PEERSESSIONRENEW407S ([#6022](https://github.com/ashlrai/phantom/issues/6022)) ([561bd20](https://github.com/ashlrai/phantom/commit/561bd20f7514e6e689ab74458aea75f7e963d227))
* **RQ-PHX-PEERSUNENROLLED394:** Bridge notes ([#5944](https://github.com/ashlrai/phantom/issues/5944)) ([d81756a](https://github.com/ashlrai/phantom/commit/d81756a3dc6d4a6aefc39a647dc209cb5dd1fc49))
* **RQ-PHX-POOLALIASCASES355:** Bridge Notes: Pool Reach Alias Test Cases ([#5647](https://github.com/ashlrai/phantom/issues/5647)) ([e6e38cf](https://github.com/ashlrai/phantom/commit/e6e38cf308376a6b69efc826cec43ba811197d0c))
* **RQ-PHX-POOLCLIAMBIGUITY354S:** BRIDGE_NOTES — RQ-PHX-POOLCLIAMBIGUITY354S ([#5641](https://github.com/ashlrai/phantom/issues/5641)) ([9927d9a](https://github.com/ashlrai/phantom/commit/9927d9ac7807b5ebbf924dbe4c83d5899d465f37))
* **RQ-PHX-POOLCLICONFIGFAIL357S:** BRIDGE_NOTES — RQ-PHX-POOLCLICONFIGFAIL357S ([#5654](https://github.com/ashlrai/phantom/issues/5654)) ([d43a5e0](https://github.com/ashlrai/phantom/commit/d43a5e0dd0b5d4adf0ab7459325773d706ef9776))
* **RQ-PHX-POOLIDENTITYCERTAINTY355S:** BRIDGE_NOTES — RQ-PHX-POOLIDENTITYCERTAINTY355S ([#5644](https://github.com/ashlrai/phantom/issues/5644)) ([20eb305](https://github.com/ashlrai/phantom/commit/20eb305fc6dcd04400715894b3085cafc2bcf730))
* **RQ-PHX-POOLMCPREALRECOVERY359S:** BRIDGE_NOTES — RQ-PHX-POOLMCPREALRECOVERY359S ([#5662](https://github.com/ashlrai/phantom/issues/5662)) ([cc77a40](https://github.com/ashlrai/phantom/commit/cc77a40b486b8a23a24207932453614f5d5dc24b))
* **RQ-PHX-POOLREACH351:** BRIDGE_NOTES — RQ-PHX-POOLREACH351 ([#5627](https://github.com/ashlrai/phantom/issues/5627)) ([e670e56](https://github.com/ashlrai/phantom/commit/e670e56f2408de443a571b9b98b038ec5bfbc110))
* **RQ-PHX-POOLREACHCARD353:** BRIDGE_NOTES — RQ-PHX-POOLREACHCARD353 ([#5637](https://github.com/ashlrai/phantom/issues/5637)) ([b6bc3ae](https://github.com/ashlrai/phantom/commit/b6bc3ae6dde964c4e0cf1225a3cca84dd5be5dad))
* **RQ-PHX-POOLREACHMCP353:** BRIDGE_NOTES — RQ-PHX-POOLREACHMCP353 ([#5638](https://github.com/ashlrai/phantom/issues/5638)) ([e040b07](https://github.com/ashlrai/phantom/commit/e040b07ee8c4d362ae07c1c3aad532b24976ec6d))
* **RQ-PHX-POOLSELFSTOPPED356S:** BRIDGE_NOTES — RQ-PHX-POOLSELFSTOPPED356S ([#5649](https://github.com/ashlrai/phantom/issues/5649)) ([02ea586](https://github.com/ashlrai/phantom/commit/02ea58622149d5517164509df5ebec6f33a64682))
* **RQ-PHX-POOLSELFTRUNCATION358S:** BRIDGE_NOTES — RQ-PHX-POOLSELFTRUNCATION358S ([#5658](https://github.com/ashlrai/phantom/issues/5658)) ([8a370fc](https://github.com/ashlrai/phantom/commit/8a370fcb72d8c89b94730ffd629085484ffc4a95))
* **RQ-PHX-QUEUEAMBIGUITY370:** BRIDGE_NOTES — RQ-PHX-QUEUEAMBIGUITY370 ([#5700](https://github.com/ashlrai/phantom/issues/5700)) ([cba117d](https://github.com/ashlrai/phantom/commit/cba117dd1494ee888d1d17165ad538366f15bd7e))
* **RQ-PHX-RECHECKCOMPUTERSDELTA352:** RQ-PHX-RECHECKCOMPUTERSDELTA352 — retained tailnet computer ([#5634](https://github.com/ashlrai/phantom/issues/5634)) ([efb3c28](https://github.com/ashlrai/phantom/commit/efb3c28d32c658936c70ae06c564c9bf58b5284f))
* **RQ-PHX-RECHECKORDERSLINE362:** BRIDGE_NOTES — RQ-PHX-RECHECKORDERSLINE362 ([#5672](https://github.com/ashlrai/phantom/issues/5672)) ([08e1676](https://github.com/ashlrai/phantom/commit/08e16769ae2590123c8d0324db89d40d77f393c1))
* **RQ-PHX-RECHECKORDERSLIVE367:** RQ-PHX-RECHECKORDERSLIVE367 ([#5688](https://github.com/ashlrai/phantom/issues/5688)) ([67b42f2](https://github.com/ashlrai/phantom/commit/67b42f252424551a4670ce72fc1ef12ddf56c57f))
* **RQ-PHX-RECHECKPEERSLINE396:** RQ-PHX-RECHECKPEERSLINE396 ([#5963](https://github.com/ashlrai/phantom/issues/5963)) ([f0a23a9](https://github.com/ashlrai/phantom/commit/f0a23a9f2619fdc1fde31f3de5a865800bb5d3ac))
* **RQ-PHX-RECHECKPOOLLINE355:** BRIDGE_NOTES — RQ-PHX-RECHECKPOOLLINE355 ([#5645](https://github.com/ashlrai/phantom/issues/5645)) ([61ff35a](https://github.com/ashlrai/phantom/commit/61ff35a275c069e0b86ca2b5aabcf0b4529f9d02))
* **RQ-PHX-RECHECKREPLYCOMPUTERS352:** BRIDGE_NOTES — RQ-PHX-RECHECKREPLYCOMPUTERS352 ([#5632](https://github.com/ashlrai/phantom/issues/5632)) ([f182c30](https://github.com/ashlrai/phantom/commit/f182c30940d9c7a1c719f004ba03f3d381de8fbe))
* **RQ-PHX-RECHECKREPLYPREVIEW349:** RQ-PHX-RECHECKREPLYPREVIEW349 — bridge notes ([#5619](https://github.com/ashlrai/phantom/issues/5619)) ([1c9aa06](https://github.com/ashlrai/phantom/commit/1c9aa069250e3c653c332e7c7884fd9fe3dc129f))
* **RQ-PHX-RECHECKSURFACEOWNER387:** RQ-PHX-RECHECKSURFACEOWNER387 ([#5824](https://github.com/ashlrai/phantom/issues/5824)) ([e7fe074](https://github.com/ashlrai/phantom/commit/e7fe0746137c38612153e501ff9b4a852c3153b8))
* **RQ-PHX-RECHECKTAILNET350:** RQ-PHX-RECHECKTAILNET350 ([#5624](https://github.com/ashlrai/phantom/issues/5624)) ([00ab505](https://github.com/ashlrai/phantom/commit/00ab505d4516540701b99bafc863f5efe56d208a))
* **RQ-PHX-RECUTAGENTNETC443:** BRIDGE_NOTES — RQ-PHX-RECUTAGENTNETC443 ([#6166](https://github.com/ashlrai/phantom/issues/6166)) ([2ebc273](https://github.com/ashlrai/phantom/commit/2ebc273bf429a244bf282d80660e2574caf04dfa))
* **RQ-PHX-RECUTCLIC380:** RQ-PHX-RECUTCLIC380 bridge notes ([#5754](https://github.com/ashlrai/phantom/issues/5754)) ([6635ccf](https://github.com/ashlrai/phantom/commit/6635ccfc4b34d5e39f508e64fe92b6f886dea42e))
* **RQ-PHX-RECUTCLIC405:** RQ-PHX-RECUTCLIC405 ([#6006](https://github.com/ashlrai/phantom/issues/6006)) ([129ba2b](https://github.com/ashlrai/phantom/commit/129ba2bf489d714c503f586f78a12f20bddb308f))
* **RQ-PHX-RECUTCLIC436:** BRIDGE_NOTES — RQ-PHX-RECUTCLIC436 ([#6127](https://github.com/ashlrai/phantom/issues/6127)) ([ec00f5c](https://github.com/ashlrai/phantom/commit/ec00f5ca2c0b7814465e025024802eb0d5f79075))
* **RQ-PHX-RECUTCLIOLDC341:** RQ-PHX-RECUTCLIOLDC341 — recut of [#4437](https://github.com/ashlrai/phantom/issues/4437) (RQ-PHX-INTENTMERGEB ([#5582](https://github.com/ashlrai/phantom/issues/5582)) ([937ed31](https://github.com/ashlrai/phantom/commit/937ed3194d9e71a6049890b1c57c16f3027b4e56))
* **RQ-PHX-RECUTCOMMSC341:** RQ-PHX-RECUTCOMMSC341 — no eligible COMMS recut ([#5580](https://github.com/ashlrai/phantom/issues/5580)) ([7d4da4a](https://github.com/ashlrai/phantom/commit/7d4da4a4908207edbe9658d760231e9184b7e406))
* **RQ-PHX-RECUTCOMMSC381:** RQ-PHX-RECUTCOMMSC381 ([#5765](https://github.com/ashlrai/phantom/issues/5765)) ([97a2b61](https://github.com/ashlrai/phantom/commit/97a2b61c44e70425ec15da2aee338970887a322b))
* **RQ-PHX-RECUTCOMMSC382:** RQ-PHX-RECUTCOMMSC382 ([#5771](https://github.com/ashlrai/phantom/issues/5771)) ([7ff181b](https://github.com/ashlrai/phantom/commit/7ff181ba2ffbe301fceb22c37bc698773dd0cd2b))
* **RQ-PHX-RECUTCOMMSC384:** RQ-PHX-RECUTCOMMSC384 ([#5784](https://github.com/ashlrai/phantom/issues/5784)) ([e132e47](https://github.com/ashlrai/phantom/commit/e132e47b8e9d9764acaaa28f07c675fb3df64c76))
* **RQ-PHX-RECUTCOMMSC387:** RQ-PHX-RECUTCOMMSC387 ([#5813](https://github.com/ashlrai/phantom/issues/5813)) ([f5b176a](https://github.com/ashlrai/phantom/commit/f5b176a49570fab16ac251d6b8b9cd57d2c02fa3))
* **RQ-PHX-RECUTCOREC382:** RQ-PHX-RECUTCOREC382 ([#5775](https://github.com/ashlrai/phantom/issues/5775)) ([c553d24](https://github.com/ashlrai/phantom/commit/c553d246315fca602f90ef931e0c9a96aba98c72))
* **RQ-PHX-RECUTCOREC387:** RQ-PHX-RECUTCOREC387 ([#5817](https://github.com/ashlrai/phantom/issues/5817)) ([a9a230b](https://github.com/ashlrai/phantom/commit/a9a230be5f006a09613fee5101cd1ab74705d5ac))
* **RQ-PHX-RECUTCOREC399:** Recut of [#5204](https://github.com/ashlrai/phantom/issues/5204) ([#5985](https://github.com/ashlrai/phantom/issues/5985)) ([87ca4eb](https://github.com/ashlrai/phantom/commit/87ca4ebce18e5aaa798618270d8b05ecd42182c4))
* **RQ-PHX-RECUTCOREC405:** BRIDGE_NOTES — RQ-PHX-RECUTCOREC405 ([#6009](https://github.com/ashlrai/phantom/issues/6009)) ([a70a625](https://github.com/ashlrai/phantom/commit/a70a625e40c13773ec81d72e67c9973d74bc32e8))
* **RQ-PHX-RECUTCOREC409:** BRIDGE_NOTES — RQ-PHX-RECUTCOREC409 ([#6035](https://github.com/ashlrai/phantom/issues/6035)) ([a0aac28](https://github.com/ashlrai/phantom/commit/a0aac287c387b07016ee2a28bc44287a98668473))
* **RQ-PHX-RECUTCOREC411:** Supersedes [#4516](https://github.com/ashlrai/phantom/issues/4516) ([#6047](https://github.com/ashlrai/phantom/issues/6047)) ([f9dc7a4](https://github.com/ashlrai/phantom/commit/f9dc7a475d934c820e3f6a81333307bc518cf3ba))
* **RQ-PHX-RECUTCOREC412:** RQ-PHX-RECUTCOREC412 — CORE bucket recut notes ([#6050](https://github.com/ashlrai/phantom/issues/6050)) ([8930152](https://github.com/ashlrai/phantom/commit/893015276efdc7f8d2bc5ac18caac7dc0e60fa8d))
* **RQ-PHX-RECUTCOREC422:** BRIDGE_NOTES — RQ-PHX-RECUTCOREC422 ([#6076](https://github.com/ashlrai/phantom/issues/6076)) ([75cdfb5](https://github.com/ashlrai/phantom/commit/75cdfb5b4cecf19ea27179834b974d3085c6b469))
* **RQ-PHX-RECUTCOREC426:** BRIDGE_NOTES — RQ-PHX-RECUTCOREC426 ([#6087](https://github.com/ashlrai/phantom/issues/6087)) ([a2ade05](https://github.com/ashlrai/phantom/commit/a2ade05960eaedffc891564f7f13384b93271ccc))
* **RQ-PHX-RECUTCOREFLEETC397:** BRIDGE_NOTES — RQ-PHX-RECUTCOREFLEETC397 ([#5975](https://github.com/ashlrai/phantom/issues/5975)) ([a742a0a](https://github.com/ashlrai/phantom/commit/a742a0aa14d1be7e0de8a3f98cab21c7810f3a90))
* **RQ-PHX-RECUTCOREFLEETC400:** Recut of [#5746](https://github.com/ashlrai/phantom/issues/5746) ([#5984](https://github.com/ashlrai/phantom/issues/5984)) ([d479fcd](https://github.com/ashlrai/phantom/commit/d479fcd7e8da82da589715e2ee63c57e7cc9613a))
* **RQ-PHX-RECUTCOREFLEETC402:** Recut of [#5845](https://github.com/ashlrai/phantom/issues/5845) ([#5995](https://github.com/ashlrai/phantom/issues/5995)) ([e97f116](https://github.com/ashlrai/phantom/commit/e97f116c3014d847590a682159fe520591c9e92f))
* **RQ-PHX-RECUTCOREFLEETC405:** RQ-PHX-RECUTCOREFLEETC405 — COREFLEET recut notes ([#6010](https://github.com/ashlrai/phantom/issues/6010)) ([b69588f](https://github.com/ashlrai/phantom/commit/b69588fa3ac87bdf973022f6fd31e9add84492b8))
* **RQ-PHX-RECUTCOREFLEETC407:** RQ-PHX-RECUTCOREFLEETC407 — bridge notes ([#6023](https://github.com/ashlrai/phantom/issues/6023)) ([0e82383](https://github.com/ashlrai/phantom/commit/0e82383277f6ec512bdcb443f944795e1a47b184))
* **RQ-PHX-RECUTCOREFLEETC411:** RQ-PHX-RECUTCOREFLEETC411 ([#6045](https://github.com/ashlrai/phantom/issues/6045)) ([fe75717](https://github.com/ashlrai/phantom/commit/fe75717d98a0cc876ad4782efaaac6ef8b4c007d))
* **RQ-PHX-RECUTCOREFLEETC415:** BRIDGE_NOTES — RQ-PHX-RECUTCOREFLEETC415 (COREFLEET bucket) ([#6060](https://github.com/ashlrai/phantom/issues/6060)) ([9ca8849](https://github.com/ashlrai/phantom/commit/9ca88492e810e287eda650aaf71ca977621a2593))
* **RQ-PHX-RECUTCOREFLEETC430:** BRIDGE_NOTES — RQ-PHX-RECUTCOREFLEETC430 (COREFLEET bucket) ([#6101](https://github.com/ashlrai/phantom/issues/6101)) ([4b05f0a](https://github.com/ashlrai/phantom/commit/4b05f0aefc28a03f4c9d1faa21def8bf0a8b84fa))
* **RQ-PHX-RECUTCOREFLEETC435:** RQ-PHX-RECUTCOREFLEETC435 ([#6118](https://github.com/ashlrai/phantom/issues/6118)) ([e8c770e](https://github.com/ashlrai/phantom/commit/e8c770e053017502d6cd268b9cc212d0c91e01db))
* **RQ-PHX-RECUTCOREOLDC341:** RQ-PHX-RECUTCOREOLDC341 — no qualifying recut ([#5581](https://github.com/ashlrai/phantom/issues/5581)) ([89285f3](https://github.com/ashlrai/phantom/commit/89285f31500258467329e97004638ec34845e57c))
* **RQ-PHX-RECUTCOREOLDC342:** BRIDGE_NOTES — RQ-PHX-RECUTCOREOLDC342 (slot: `src/core/flee ([#5568](https://github.com/ashlrai/phantom/issues/5568)) ([7b6f31f](https://github.com/ashlrai/phantom/commit/7b6f31fe63a3452bf042f3ef33f6ed92e75c9a45))
* **RQ-PHX-RECUTCOREOLDC344:** BRIDGE_NOTES — RQ-PHX-RECUTCOREOLDC344 ([#5572](https://github.com/ashlrai/phantom/issues/5572)) ([1a9fdfe](https://github.com/ashlrai/phantom/commit/1a9fdfea64203f07716713d17b715a81fe293287))
* **RQ-PHX-RECUTCORES0C342:** RQ-PHX-RECUTCORES0C342 ([#5579](https://github.com/ashlrai/phantom/issues/5579)) ([339eaf7](https://github.com/ashlrai/phantom/commit/339eaf7a30ec2de322ed8003f2057cd6784409d6))
* **RQ-PHX-RECUTCORES0C343:** Recut of [#4664](https://github.com/ashlrai/phantom/issues/4664) ([#5569](https://github.com/ashlrai/phantom/issues/5569)) ([6a6d26c](https://github.com/ashlrai/phantom/commit/6a6d26cd8160badcada4b293c8accc9bc08045b0))
* **RQ-PHX-RECUTCORES0C344:** BRIDGE_NOTES — RQ-PHX-RECUTCORES0C344 ([#5574](https://github.com/ashlrai/phantom/issues/5574)) ([a1bd766](https://github.com/ashlrai/phantom/commit/a1bd766b4c6b7ccb61633d109accc873e30e0dd9))
* **RQ-PHX-RECUTFLEETALC356:** Bridge Notes — RQ-PHX-RECUTFLEETALC356 ([#5653](https://github.com/ashlrai/phantom/issues/5653)) ([34c276a](https://github.com/ashlrai/phantom/commit/34c276a6754942dbec2c8e3257bda122fb32b35a))
* **RQ-PHX-RECUTFLEETALC380:** RQ-PHX-RECUTFLEETALC380 ([#5757](https://github.com/ashlrai/phantom/issues/5757)) ([47f0540](https://github.com/ashlrai/phantom/commit/47f054098918b6a8c090ec469329f84d92f63804))
* **RQ-PHX-RECUTFLEETCLIC382:** RQ-PHX-RECUTFLEETCLIC382 ([#5772](https://github.com/ashlrai/phantom/issues/5772)) ([c934576](https://github.com/ashlrai/phantom/commit/c934576839e9cbba62bfa46810fa28a57b7feaf1))
* **RQ-PHX-RECUTFLEETCLIC432:** BRIDGE_NOTES — RQ-PHX-RECUTFLEETCLIC432 ([#6109](https://github.com/ashlrai/phantom/issues/6109)) ([4f9c454](https://github.com/ashlrai/phantom/commit/4f9c454d36c1fe22bf43d043e479d484c31f5450))
* **RQ-PHX-RECUTFLEETMZC356:** Bridge Notes — RQ-PHX-RECUTFLEETMZC356 ([#5652](https://github.com/ashlrai/phantom/issues/5652)) ([579da49](https://github.com/ashlrai/phantom/commit/579da493679da50c0a89e43fcd29d17493ba9544))
* **RQ-PHX-RECUTFLEETMZC361:** BRIDGE_NOTES — RQ-PHX-RECUTFLEETMZC361 ([#5668](https://github.com/ashlrai/phantom/issues/5668)) ([82fe22a](https://github.com/ashlrai/phantom/commit/82fe22aa52b8b96d8db8ef847192f5d0a657b5b4))
* **RQ-PHX-RECUTFLEETMZC380:** RQ-PHX-RECUTFLEETMZC380 ([#5755](https://github.com/ashlrai/phantom/issues/5755)) ([8ec7a62](https://github.com/ashlrai/phantom/commit/8ec7a622ec6557f9f0c2649c666ebaa97c2e5089))
* **RQ-PHX-RECUTFLEETMZC382:** BRIDGE_NOTES — RQ-PHX-RECUTFLEETMZC382 ([#5777](https://github.com/ashlrai/phantom/issues/5777)) ([b273544](https://github.com/ashlrai/phantom/commit/b27354425589ccd53a53f8ac4d8d424f286552b3))
* **RQ-PHX-RECUTLEADERC428:** BRIDGE_NOTES — RQ-PHX-RECUTLEADERC428 ([#6096](https://github.com/ashlrai/phantom/issues/6096)) ([243436a](https://github.com/ashlrai/phantom/commit/243436a4a814c16de668e7e68d46ff96db9a201c))
* **RQ-PHX-RECUTMCPC343:** BRIDGE_NOTES — RQ-PHX-RECUTMCPC343 ([#5570](https://github.com/ashlrai/phantom/issues/5570)) ([5c293aa](https://github.com/ashlrai/phantom/commit/5c293aab84cfe15ae32900e3438ae648cca1e6ff))
* **RQ-PHX-RECUTMCPC346:** RQ-PHX-RECUTMCPC346 — BRIDGE_NOTES ([#5577](https://github.com/ashlrai/phantom/issues/5577)) ([0c9514a](https://github.com/ashlrai/phantom/commit/0c9514a1ccb265364e8a098ccb5439affa752ace))
* **RQ-PHX-RECUTMCPC356:** Bridge Notes — RQ-PHX-RECUTMCPC356 ([#5651](https://github.com/ashlrai/phantom/issues/5651)) ([573e7a4](https://github.com/ashlrai/phantom/commit/573e7a4c8ed5be28be69b3ece292eaae858d792c))
* **RQ-PHX-RECUTMCPC381:** RQ-PHX-RECUTMCPC381 ([#5766](https://github.com/ashlrai/phantom/issues/5766)) ([3e3d5e6](https://github.com/ashlrai/phantom/commit/3e3d5e61afe50668a1a8e3e356a935cb7c460c57))
* **RQ-PHX-RECUTMCPC387:** RQ-PHX-RECUTMCPC387 ([#5807](https://github.com/ashlrai/phantom/issues/5807)) ([2628509](https://github.com/ashlrai/phantom/commit/2628509c01808c951b4917376e5d96cb9c78cd61))
* **RQ-PHX-RECUTN1R3900S92:** Recut of [#4049](https://github.com/ashlrai/phantom/issues/4049) ([#4841](https://github.com/ashlrai/phantom/issues/4841)) ([99fdaf0](https://github.com/ashlrai/phantom/commit/99fdaf0c8f9c058053267be4f9b467dd6b6e924d))
* **RQ-PHX-RECUTSETTINGSDESK67:** RQ-PHX-RECUTSETTINGSDESK67: recut of [#4365](https://github.com/ashlrai/phantom/issues/4365) (What's New card ([#4650](https://github.com/ashlrai/phantom/issues/4650)) ([f7d4425](https://github.com/ashlrai/phantom/commit/f7d44254a039103e344f634076eb2f96dc5c3a87))
* **RQ-PHX-RECUTTESTONLYC354:** BRIDGE_NOTES — RQ-PHX-RECUTTESTONLYC354 (cluster TESTONLY) ([#5643](https://github.com/ashlrai/phantom/issues/5643)) ([657779a](https://github.com/ashlrai/phantom/commit/657779a342d1be0041cbd2965bd255399d53eb8e))
* **RQ-PHX-RECUTTESTONLYC437:** RQ-PHX-RECUTTESTONLYC437 — TESTONLY backlog audit ([#6122](https://github.com/ashlrai/phantom/issues/6122)) ([3d81e39](https://github.com/ashlrai/phantom/commit/3d81e39990d354eebefe46d2cbd402276e4ea266))
* **RQ-PHX-RECUTTESTONLYC441:** RQ-PHX-RECUTTESTONLYC441 ([#6149](https://github.com/ashlrai/phantom/issues/6149)) ([f5c7223](https://github.com/ashlrai/phantom/commit/f5c72234e4f30d38179cda2d59c79149e04531ef))
* **RQ-PHX-RECUTVERSEC361:** BRIDGE_NOTES — RQ-PHX-RECUTVERSEC361 ([#5675](https://github.com/ashlrai/phantom/issues/5675)) ([12a4948](https://github.com/ashlrai/phantom/commit/12a4948084edddfdc97d1a7a7853d40180f0e1c3))
* **RQ-PHX-RECUTVERSEC380:** RQ-PHX-RECUTVERSEC380 ([#5759](https://github.com/ashlrai/phantom/issues/5759)) ([a958494](https://github.com/ashlrai/phantom/commit/a9584947b866470bb3a62f38bc225594b37ae88c))
* **RQ-PHX-RECUTVERSEC382:** RQ-PHX-RECUTVERSEC382 ([#5773](https://github.com/ashlrai/phantom/issues/5773)) ([3ea16ae](https://github.com/ashlrai/phantom/commit/3ea16ae1d22dd54769fa1787af0af98df01bb699))
* **RQ-PHX-RECUTWEBUIC380:** RQ-PHX-RECUTWEBUIC380 ([#5756](https://github.com/ashlrai/phantom/issues/5756)) ([f14096e](https://github.com/ashlrai/phantom/commit/f14096e6743cf7ca28b8103caeec5b0b91a68ec9))
* **RQ-PHX-RECUTWEBUIC387:** BRIDGE_NOTES — RQ-PHX-RECUTWEBUIC387 ([#5811](https://github.com/ashlrai/phantom/issues/5811)) ([b7b1fcd](https://github.com/ashlrai/phantom/commit/b7b1fcdc7f8debf18f7243a53e302eb4743f7a51))
* **RQ-PHX-RECUTWEBUIC432:** RQ-PHX-RECUTWEBUIC432 ([#6108](https://github.com/ashlrai/phantom/issues/6108)) ([a6ec354](https://github.com/ashlrai/phantom/commit/a6ec354c00a767fcc50a878e57d2ed1e7d58dec9))
* **RQ-PHX-RECUTWEBUIC443:** RQ-PHX-RECUTWEBUIC443 ([#6164](https://github.com/ashlrai/phantom/issues/6164)) ([b11e39c](https://github.com/ashlrai/phantom/commit/b11e39c1e8eedc8562d4818a7496791d0646dd32))
* **RQ-PHX-REDTESTFIXC358:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXC358 ([#5663](https://github.com/ashlrai/phantom/issues/5663)) ([1b900ab](https://github.com/ashlrai/phantom/commit/1b900ab706b006730d329ec1831383512aa7f08a))
* **RQ-PHX-REDTESTFIXC397:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXC397 ([#5977](https://github.com/ashlrai/phantom/issues/5977)) ([6b18692](https://github.com/ashlrai/phantom/commit/6b186926bd5f60fe3d9f2bd33a6b62e43328b68f))
* **RQ-PHX-REDTESTFIXC398:** Fix of [#4841](https://github.com/ashlrai/phantom/issues/4841) ([#5980](https://github.com/ashlrai/phantom/issues/5980)) ([4b9c26e](https://github.com/ashlrai/phantom/commit/4b9c26ea3adc36c306791b3d4a52b01e4af43ea1))
* **RQ-PHX-REDTESTFIXC437:** RQ-PHX-REDTESTFIXC437 ([#6124](https://github.com/ashlrai/phantom/issues/6124)) ([8155a0a](https://github.com/ashlrai/phantom/commit/8155a0a82439086a2e7ca34e9f05bc1f5e4ddf2c))
* **RQ-PHX-REDTESTFIXC441:** RQ-PHX-REDTESTFIXC441 ([#6150](https://github.com/ashlrai/phantom/issues/6150)) ([d88962a](https://github.com/ashlrai/phantom/commit/d88962a40e8253bddcc6a5f1fc7dde07c37c62e4))
* **RQ-PHX-REDTYPEFIXC357:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXC357 ([#5655](https://github.com/ashlrai/phantom/issues/5655)) ([4b402aa](https://github.com/ashlrai/phantom/commit/4b402aa1d374648e88bf2b4a1456fbd82d2338d1))
* **RQ-PHX-REDTYPEFIXC358:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXC358 ([#5665](https://github.com/ashlrai/phantom/issues/5665)) ([91ce390](https://github.com/ashlrai/phantom/commit/91ce390e60828343ccfd9e08e3a3c4dfd78a9fed))
* **RQ-PHX-REDTYPEFIXC380:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXC380 ([#5758](https://github.com/ashlrai/phantom/issues/5758)) ([22c0ec7](https://github.com/ashlrai/phantom/commit/22c0ec7d3ee18e05af9a151a64f6d7f17dc70683))
* **RQ-PHX-REDTYPEFIXC382:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXC382 ([#5770](https://github.com/ashlrai/phantom/issues/5770)) ([ad80558](https://github.com/ashlrai/phantom/commit/ad805588d905803e851f2cb75264495556c69241))
* **RQ-PHX-REDTYPEFIXC384:** RQ-PHX-REDTYPEFIXC384 ([#5783](https://github.com/ashlrai/phantom/issues/5783)) ([869df6e](https://github.com/ashlrai/phantom/commit/869df6e1fc076e25372fd4eee2a81551661603bf))
* **RQ-PHX-REDTYPEFIXC387:** RQ-PHX-REDTYPEFIXC387 ([#5796](https://github.com/ashlrai/phantom/issues/5796)) ([0ff45a7](https://github.com/ashlrai/phantom/commit/0ff45a70414e0b221a64100a17bf3e651cd619ef))
* **RQ-PHX-REDTYPEFIXC427:** RQ-PHX-REDTYPEFIXC427 ([#6090](https://github.com/ashlrai/phantom/issues/6090)) ([31d743e](https://github.com/ashlrai/phantom/commit/31d743eecc20d3463c7d8ebfd980157686d2fa99))
* **RQ-PHX-REENTRANTNOTICE350S:** RQ-PHX-REENTRANTNOTICE350S ([#5621](https://github.com/ashlrai/phantom/issues/5621)) ([b85d0ba](https://github.com/ashlrai/phantom/commit/b85d0ba2c0b35cbfbd72636d73bcd06273a0c8d8))
* **RQ-PHX-REPLYIDENTITY442S:** RQ-PHX-REPLYIDENTITY442S ([#6155](https://github.com/ashlrai/phantom/issues/6155)) ([5b44541](https://github.com/ashlrai/phantom/commit/5b4454196673f8e6ef1bbb1735877e8480d1dbb9))
* **RQ-PHX-RESULTCLAIMATTRIBUTION346S:** BRIDGE_NOTES — RQ-PHX-RESULTCLAIMATTRIBUTION346S ([#5628](https://github.com/ashlrai/phantom/issues/5628)) ([9264ae1](https://github.com/ashlrai/phantom/commit/9264ae15715bdfb08c2d0e1be33b2813741c0799))
* **RQ-PHX-RESULTCROSSSURFACERETRY345S:** BRIDGE NOTES: RQ-PHX-RESULTCROSSSURFACERETRY345S ([#5616](https://github.com/ashlrai/phantom/issues/5616)) ([539f9b1](https://github.com/ashlrai/phantom/commit/539f9b199c58e8485a33c56136579caaeb863a16))
* **RQ-PHX-RESULTEXPIRYROUNDTRIP340S:** Result expiry roundtrip (RQ-PHX-RESULTEXPIRYROUNDTRIP340S) ([#5578](https://github.com/ashlrai/phantom/issues/5578)) ([103efba](https://github.com/ashlrai/phantom/commit/103efba741a8d79e0cda5263fffbc9c02bba6b8b))
* **RQ-PHX-RESULTHTTPDURABLE343S:** BRIDGE_NOTES — RQ-PHX-RESULTHTTPDURABLE343S ([#5571](https://github.com/ashlrai/phantom/issues/5571)) ([0241e65](https://github.com/ashlrai/phantom/commit/0241e65ef92729e7eb96a6eff1ed6036853ecb12))
* **RQ-PHX-RESULTOUTPUTRECOVERY347S:** Bridge Notes for RQ-PHX-RESULTOUTPUTRECOVERY347S ([#5636](https://github.com/ashlrai/phantom/issues/5636)) ([68d0774](https://github.com/ashlrai/phantom/commit/68d0774828838e1dc80d219be1ae80dfadb5664a))
* **RQ-PHX-RESULTROOTISOLATION348S:** BRIDGE_NOTES — RQ-PHX-RESULTROOTISOLATION348S ([#5612](https://github.com/ashlrai/phantom/issues/5612)) ([263c7ec](https://github.com/ashlrai/phantom/commit/263c7ec3b16aad9643d3cce90aa4e028c08e9142))
* **RQ-PHX-RESULTUTF8RETURN349S:** RQ-PHX-RESULTUTF8RETURN349S — bridge notes ([#5618](https://github.com/ashlrai/phantom/issues/5618)) ([b83d8a8](https://github.com/ashlrai/phantom/commit/b83d8a89ff6034efefb8ea4fca682a6f03e0581a))
* **RQ-PHX-RETURNCLOCKEVIDENCE395S:** BRIDGE_NOTES — RQ-PHX-RETURNCLOCKEVIDENCE395S ([#5959](https://github.com/ashlrai/phantom/issues/5959)) ([f431358](https://github.com/ashlrai/phantom/commit/f4313581fcb79b9c1d92d87d2c2d33e9e4016b09))
* **RQ-PHX-RETURNEXPIRYRECONNECT382S:** BRIDGE NOTES — RQ-PHX-RETURNEXPIRYRECONNECT382S ([#5774](https://github.com/ashlrai/phantom/issues/5774)) ([944c284](https://github.com/ashlrai/phantom/commit/944c284b711be3522ed3f2ef0f0f447e5e611939))
* **RQ-PHX-RETURNHANDOFFPROOF381S:** BRIDGE_NOTES — RQ-PHX-RETURNHANDOFFPROOF381S ([#5768](https://github.com/ashlrai/phantom/issues/5768)) ([58f312a](https://github.com/ashlrai/phantom/commit/58f312ad65429a0efb0bd8a17c230efe34e36009))
* **RQ-PHX-RETURNHTTPHANDOFF383S:** BRIDGE_NOTES — RQ-PHX-RETURNHTTPHANDOFF383S ([#5780](https://github.com/ashlrai/phantom/issues/5780)) ([1f3025b](https://github.com/ashlrai/phantom/commit/1f3025bc51cf763fcf181ee69115cbef7626d7ef))
* **RQ-PHX-RETURNREJECTLIVE382S:** RQ-PHX-RETURNREJECTLIVE382S ([#5776](https://github.com/ashlrai/phantom/issues/5776)) ([444cdff](https://github.com/ashlrai/phantom/commit/444cdffe5da0ca547f4cf63eff91ac67ace31bdd))
* **RQ-PHX-RETURNREPLAYEVIDENCE386S:** Return replay evidence qualification ([#5791](https://github.com/ashlrai/phantom/issues/5791)) ([1a38ea6](https://github.com/ashlrai/phantom/commit/1a38ea60fbd2b42f142cb583deb62f30dbb78508))
* **RQ-PHX-RETURNREPOISOLATION379S:** RQ-PHX-RETURNREPOISOLATION379S ([#5747](https://github.com/ashlrai/phantom/issues/5747)) ([6b77cad](https://github.com/ashlrai/phantom/commit/6b77cad5570385993a328a406d5b184b1254d738))
* **RQ-PHX-RETURNSPRCHECK396:** BRIDGE_NOTES — RQ-PHX-RETURNSPRCHECK396 ([#5966](https://github.com/ashlrai/phantom/issues/5966)) ([6c5ff59](https://github.com/ashlrai/phantom/commit/6c5ff59e673bbf9060b761ab9cec57930edf09d9))
* **RQ-PHX-RETURNSROUTE408C:** RQ-PHX-RETURNSROUTE408C ([#6028](https://github.com/ashlrai/phantom/issues/6028)) ([15dad2b](https://github.com/ashlrai/phantom/commit/15dad2b89031d9a2b1eebb79c5c7e03096ef0093))
* **RQ-PHX-RETURNSSTRIP392:** RQ-PHX-RETURNSSTRIP392 ([#5925](https://github.com/ashlrai/phantom/issues/5925)) ([edcfdd0](https://github.com/ashlrai/phantom/commit/edcfdd0bdf9c948b19ffc7a974b11e6b6d163f33))
* **RQ-PHX-REVIEWAPIREADRECOVERY375S:** BRIDGE_NOTES — RQ-PHX-REVIEWAPIREADRECOVERY375S ([#5728](https://github.com/ashlrai/phantom/issues/5728)) ([75eaad7](https://github.com/ashlrai/phantom/commit/75eaad70f8ef5187e45771e839e5d6c0713647ee))
* **RQ-PHX-REVIEWCLIBOUND374:** BRIDGE_NOTES — RQ-PHX-REVIEWCLIBOUND374 ([#5722](https://github.com/ashlrai/phantom/issues/5722)) ([98ad26d](https://github.com/ashlrai/phantom/commit/98ad26d654245dc0b4ac9e78aa9ef10b39b0ba6e))
* **RQ-PHX-REVIEWCLIFRESHRETURN373S:** Bridge notes ([#5713](https://github.com/ashlrai/phantom/issues/5713)) ([7dc4d24](https://github.com/ashlrai/phantom/commit/7dc4d246f10183581824cc3db42a94b4e45792d0))
* **RQ-PHX-REVIEWCLIRELEASE377S:** Review CLI durable release qualification ([#5736](https://github.com/ashlrai/phantom/issues/5736)) ([78c0f1c](https://github.com/ashlrai/phantom/commit/78c0f1c30ecb197c0c71ce1817b7678415b4a64e))
* **RQ-PHX-REVIEWDISKCLAIM374:** Bridge notes ([#5716](https://github.com/ashlrai/phantom/issues/5716)) ([67b9348](https://github.com/ashlrai/phantom/commit/67b93482dff642cd1b7e69dbb74c01314161ab3f))
* **RQ-PHX-REVIEWLEASEATRETURN380S:** BRIDGE NOTES — RQ-PHX-REVIEWLEASEATRETURN380S ([#5763](https://github.com/ashlrai/phantom/issues/5763)) ([894df1e](https://github.com/ashlrai/phantom/commit/894df1e2b64230d2c4aa2367b49595eb018117b8))
* **RQ-PHX-REVIEWMCPASOF375S:** Bridge notes ([#5725](https://github.com/ashlrai/phantom/issues/5725)) ([07efd82](https://github.com/ashlrai/phantom/commit/07efd82fcd3248e29be4839d5e8552a6dadc97fa))
* **RQ-PHX-REVIEWMCPCLOSED376S:** BRIDGE_NOTES — RQ-PHX-REVIEWMCPCLOSED376S ([#5733](https://github.com/ashlrai/phantom/issues/5733)) ([6da8fd6](https://github.com/ashlrai/phantom/commit/6da8fd6901b0c279013bc07650a6c31ae7fcc5d9))
* **RQ-PHX-REVIEWMULTIREADFAIL376S:** RQ-PHX-REVIEWMULTIREADFAIL376S ([#5731](https://github.com/ashlrai/phantom/issues/5731)) ([8c19ac7](https://github.com/ashlrai/phantom/commit/8c19ac770abb87aa9f60e5cbaed0a66f551f5e9f))
* **RQ-PHX-REVIEWPICK371:** RQ-PHX-REVIEWPICK371 — `fleet review-pick` ([#5706](https://github.com/ashlrai/phantom/issues/5706)) ([be232b5](https://github.com/ashlrai/phantom/commit/be232b535ddfd86e9d1d5008fca243a0543e0672))
* **RQ-PHX-REVIEWPICKAPI374:** RQ-PHX-REVIEWPICKAPI374 ([#5717](https://github.com/ashlrai/phantom/issues/5717)) ([c1eff82](https://github.com/ashlrai/phantom/commit/c1eff822e755064c9319ea0a622019976f7d7c7e))
* **RQ-PHX-REVIEWPICKCROSSREPO374:** Bridge Notes: Review Pick Ownership Rules Test ([#5753](https://github.com/ashlrai/phantom/issues/5753)) ([fbb14a0](https://github.com/ashlrai/phantom/commit/fbb14a01400ce1271b5068bc0b27e0ac5fe111cc))
* **RQ-PHX-REVIEWPICKLEDGERPROOF375:** Review-pick ledger proof ([#5726](https://github.com/ashlrai/phantom/issues/5726)) ([a97ad94](https://github.com/ashlrai/phantom/commit/a97ad9466a01e50538c1209e4b6ec520294cb8b4))
* **RQ-PHX-REVIEWPICKMCP374:** RQ-PHX-REVIEWPICKMCP374 bridge notes ([#5719](https://github.com/ashlrai/phantom/issues/5719)) ([d43e202](https://github.com/ashlrai/phantom/commit/d43e202783ce6497224a94d1b379e15967fc01b1))
* **RQ-PHX-REVIEWPICKREPOS374:** RQ-PHX-REVIEWPICKREPOS374 ([#5718](https://github.com/ashlrai/phantom/issues/5718)) ([524c742](https://github.com/ashlrai/phantom/commit/524c742d1902c3013a22131ef76578e1df61941d))
* **RQ-PHX-REVIEWPICKSTRIP374:** BRIDGE_NOTES — RQ-PHX-REVIEWPICKSTRIP374 ([#5723](https://github.com/ashlrai/phantom/issues/5723)) ([07d8b34](https://github.com/ashlrai/phantom/commit/07d8b34315fe699e76f2a6e93318c07ec051ec4b))
* **RQ-PHX-REVIEWREADDEADLINE373:** BRIDGE_NOTES — RQ-PHX-REVIEWREADDEADLINE373 ([#5715](https://github.com/ashlrai/phantom/issues/5715)) ([4fad7fb](https://github.com/ashlrai/phantom/commit/4fad7fb420420ca3b7c0b84ae610f18754d10561))
* **RQ-PHX-REVIEWTAKE375:** RQ-PHX-REVIEWTAKE375 ([#5729](https://github.com/ashlrai/phantom/issues/5729)) ([7673959](https://github.com/ashlrai/phantom/commit/7673959f998313b021db074fb65ddf05743165e2))
* **RQ-PHX-REVIEWTAKEHEAD377S:** BRIDGE_NOTES — RQ-PHX-REVIEWTAKEHEAD377S ([#5738](https://github.com/ashlrai/phantom/issues/5738)) ([b52db7f](https://github.com/ashlrai/phantom/commit/b52db7fbe12b9c4d49b2835c305f7a40455790cd))
* **RQ-PHX-REVOKEDHANDOFF407S:** BRIDGE_NOTES — RQ-PHX-REVOKEDHANDOFF407S ([#6021](https://github.com/ashlrai/phantom/issues/6021)) ([a20e876](https://github.com/ashlrai/phantom/commit/a20e8765050ceb9c0f7cc22755b88c84e9064d09))
* **RQ-PHX-RUNTIMECLAIMLIFECYCLE387S:** Runtime claim lifecycle qualification ([#5810](https://github.com/ashlrai/phantom/issues/5810)) ([03c690d](https://github.com/ashlrai/phantom/commit/03c690d8f892a1a0b55637cbfde3afa6daa77c11))
* **RQ-PHX-RUNTIMECLAIMVALID424S:** BRIDGE_NOTES — RQ-PHX-RUNTIMECLAIMVALID424S ([#6082](https://github.com/ashlrai/phantom/issues/6082)) ([5690cad](https://github.com/ashlrai/phantom/commit/5690cad750d0ca08272564ba12cb5ff8246af30e))
* **RQ-PHX-RUNTIMECLIDURABLE427S:** Bridge notes: RQ-PHX-RUNTIMECLIDURABLE427S ([#6088](https://github.com/ashlrai/phantom/issues/6088)) ([d892ab2](https://github.com/ashlrai/phantom/commit/d892ab26394ca707df4bb88edaa970ad24d1984d))
* **RQ-PHX-RUNTIMECLIPROOF424S:** RQ-PHX-RUNTIMECLIPROOF424S ([#6080](https://github.com/ashlrai/phantom/issues/6080)) ([b2e8669](https://github.com/ashlrai/phantom/commit/b2e8669cc1a24406d7bbff4d04e49d626c2ed30e))
* **RQ-PHX-RUNTIMECLOCKRECOVERY383S:** Runtime snapshot clock recovery ([#5778](https://github.com/ashlrai/phantom/issues/5778)) ([b4e2e21](https://github.com/ashlrai/phantom/commit/b4e2e21a6c03dcec7bb225371ab21af0acee249c))
* **RQ-PHX-RUNTIMEHTTPDEADLINE386S:** BRIDGE_NOTES — RQ-PHX-RUNTIMEHTTPDEADLINE386S ([#5793](https://github.com/ashlrai/phantom/issues/5793)) ([0956337](https://github.com/ashlrai/phantom/commit/0956337f202a9ef7081366f75a4e7d7f092cd702))
* **RQ-PHX-RUNTIMEHTTPDURABLE428S:** Bridge notes ([#6091](https://github.com/ashlrai/phantom/issues/6091)) ([b387c65](https://github.com/ashlrai/phantom/commit/b387c6570627642a3815f4c2326531f269f3c44b))
* **RQ-PHX-RUNTIMEHTTPRESPONSE426S:** RQ-PHX-RUNTIMEHTTPRESPONSE426S ([#6085](https://github.com/ashlrai/phantom/issues/6085)) ([ed702bf](https://github.com/ashlrai/phantom/commit/ed702bf890e560a769a84b52027d6717fc4dce72))
* **RQ-PHX-RUNTIMEIDENTITYVERB378:** RQ-PHX-RUNTIMEIDENTITYVERB378 ([#5744](https://github.com/ashlrai/phantom/issues/5744)) ([bc54f2a](https://github.com/ashlrai/phantom/commit/bc54f2a02e079902e7601e1b74e4cd7d762e4ced))
* **RQ-PHX-RUNTIMEOBSERVATIONCLOCK392S:** BRIDGE_NOTES — RQ-PHX-RUNTIMEOBSERVATIONCLOCK392S ([#5965](https://github.com/ashlrai/phantom/issues/5965)) ([3527bc0](https://github.com/ashlrai/phantom/commit/3527bc094d3d28f89daa8fd2af0bf1b66c1d0e07))
* **RQ-PHX-RUNTIMEONEBOARD390S:** RQ-PHX-RUNTIMEONEBOARD390S ([#5884](https://github.com/ashlrai/phantom/issues/5884)) ([eb1aefa](https://github.com/ashlrai/phantom/commit/eb1aefad14b0012ffe969ff52ea4a5d17cf3bdc3))
* **RQ-PHX-RUNTIMEPATHRECOVERY385S:** RQ-PHX-RUNTIMEPATHRECOVERY385S ([#5789](https://github.com/ashlrai/phantom/issues/5789)) ([fb5a57a](https://github.com/ashlrai/phantom/commit/fb5a57a3c606d61c1f4c0139bc8ce14101039d0a))
* **RQ-PHX-RUNTIMESNAPSHOTCARD384:** BRIDGE_NOTES — RQ-PHX-RUNTIMESNAPSHOTCARD384 ([#5787](https://github.com/ashlrai/phantom/issues/5787)) ([940409c](https://github.com/ashlrai/phantom/commit/940409cebe32e19cf48dc89ecbf71171dca08a9d))
* **RQ-PHX-RUNTIMESNAPSHOTMCP379:** RQ-PHX-RUNTIMESNAPSHOTMCP379 ([#5748](https://github.com/ashlrai/phantom/issues/5748)) ([254e9f3](https://github.com/ashlrai/phantom/commit/254e9f3922d78acb72f624e0f41e7688dc07b94f))
* **RQ-PHX-RUNTIMESNAPSHOTROUTE384:** RQ-PHX-RUNTIMESNAPSHOTROUTE384 ([#5785](https://github.com/ashlrai/phantom/issues/5785)) ([666c344](https://github.com/ashlrai/phantom/commit/666c3443d269b35b292364df41604a23ca94c005))
* **RQ-PHX-RUNTIMESUMMARYFRESH426S:** BRIDGE_NOTES — RQ-PHX-RUNTIMESUMMARYFRESH426S ([#6086](https://github.com/ashlrai/phantom/issues/6086)) ([ff7d9b3](https://github.com/ashlrai/phantom/commit/ff7d9b30d4d66015737169afa300f2bf732c6ea9))
* **RQ-PHX-SIDEBARRUNTIMEID406C:** BRIDGE_NOTES — RQ-PHX-SIDEBARRUNTIMEID406C ([#6014](https://github.com/ashlrai/phantom/issues/6014)) ([e89a8c8](https://github.com/ashlrai/phantom/commit/e89a8c8f13c6e63e5176d7688d50032605bfd359))
* **RQ-PHX-SLACKBRIDGEASK408C:** Bridge ask 408C ([#6029](https://github.com/ashlrai/phantom/issues/6029)) ([d9f9373](https://github.com/ashlrai/phantom/commit/d9f9373e50e59e2cdddff25fb46c23ab68335710))
* **RQ-PHX-SLACKBRIDGEIDENTITY413S:** Bridge runtime identity ([#6052](https://github.com/ashlrai/phantom/issues/6052)) ([daa278d](https://github.com/ashlrai/phantom/commit/daa278d0c26f49d2d731c52cd0e673320d881276))
* **RQ-PHX-SLACKBRIDGEPROVENANCE419S:** BRIDGE_NOTES — RQ-PHX-SLACKBRIDGEPROVENANCE419S ([#6071](https://github.com/ashlrai/phantom/issues/6071)) ([c1633f1](https://github.com/ashlrai/phantom/commit/c1633f10326747be88f84833ededf71512ec6716))
* **RQ-PHX-SLACKEVIDENCE441S:** Bridge notes ([#6147](https://github.com/ashlrai/phantom/issues/6147)) ([e2560e4](https://github.com/ashlrai/phantom/commit/e2560e4663d7e97b1bd0816f61814cc9b2febfbf))
* **RQ-PHX-SLACKEVIDENCECHANNEL444S:** BRIDGE_NOTES — RQ-PHX-SLACKEVIDENCECHANNEL444S ([#6168](https://github.com/ashlrai/phantom/issues/6168)) ([ee2327b](https://github.com/ashlrai/phantom/commit/ee2327b67a2f0984a5b872cc1d5c955abe58f403))
* **RQ-PHX-SLACKEVIDENCECLIUNAVAILABLE446S:** Slack evidence CLI unavailable boundary ([#6173](https://github.com/ashlrai/phantom/issues/6173)) ([6aa04ae](https://github.com/ashlrai/phantom/commit/6aa04ae10f1f1bca6383e0db8233282969a780da))
* **RQ-PHX-SLACKEVIDENCEFRESH443S:** Slack evidence freshness handoff ([#6162](https://github.com/ashlrai/phantom/issues/6162)) ([2ec2c39](https://github.com/ashlrai/phantom/commit/2ec2c396b8545cef041d13c19873a875a5586a0e))
* **RQ-PHX-SLACKEVIDENCEMCP444S:** BRIDGE_NOTES — RQ-PHX-SLACKEVIDENCEMCP444S ([#6169](https://github.com/ashlrai/phantom/issues/6169)) ([ffed5b1](https://github.com/ashlrai/phantom/commit/ffed5b1b7b2e5feb35caa9391f5da1349cb3ab70))
* **RQ-PHX-SLACKEVIDENCEMCPCHANNEL446S:** BRIDGE_NOTES — RQ-PHX-SLACKEVIDENCEMCPCHANNEL446S ([#6174](https://github.com/ashlrai/phantom/issues/6174)) ([92bd0fd](https://github.com/ashlrai/phantom/commit/92bd0fd74004f74e34e7cc4baeaf64842f3c1c3c))
* **RQ-PHX-SLACKINGRESSPROOF438S:** RQ-PHX-SLACKINGRESSPROOF438S ([#6125](https://github.com/ashlrai/phantom/issues/6125)) ([52eafcb](https://github.com/ashlrai/phantom/commit/52eafcb392ddd9a990c8813eda2422f40b21eac0))
* **RQ-PHX-SLACKJOURNALAPPEND441S:** RQ-PHX-SLACKJOURNALAPPEND441S ([#6152](https://github.com/ashlrai/phantom/issues/6152)) ([cedc1b5](https://github.com/ashlrai/phantom/commit/cedc1b51c2b2f8dc049db3ee4a8d47874d8a4982))
* **RQ-PHX-SLACKJOURNALVALID439S:** BRIDGE_NOTES — RQ-PHX-SLACKJOURNALVALID439S ([#6129](https://github.com/ashlrai/phantom/issues/6129)) ([3a8efac](https://github.com/ashlrai/phantom/commit/3a8eface8a13a32d9300c3245d8fe71c09454219))
* **RQ-PHX-SLACKLEDGERRECOVERY438S:** BRIDGE_NOTES — RQ-PHX-SLACKLEDGERRECOVERY438S ([#6126](https://github.com/ashlrai/phantom/issues/6126)) ([3666a3b](https://github.com/ashlrai/phantom/commit/3666a3bb216a1bc92c535741c6258e91f473fbef))
* **RQ-PHX-SLACKMAPRECOVERY352S:** BRIDGE_NOTES — RQ-PHX-SLACKMAPRECOVERY352S ([#5631](https://github.com/ashlrai/phantom/issues/5631)) ([b20b636](https://github.com/ashlrai/phantom/commit/b20b636873450e518658a6d1985f026ee1dd90a4))
* **RQ-PHX-SLACKMCPJOURNAL343S:** BRIDGE_NOTES: RQ-PHX-SLACKMCPJOURNAL343S ([#5615](https://github.com/ashlrai/phantom/issues/5615)) ([57f5e38](https://github.com/ashlrai/phantom/commit/57f5e3859b0545209d51ee92328c0b59c33828f6))
* **RQ-PHX-SLACKNOTICEBLOCKED433S:** RQ-PHX-SLACKNOTICEBLOCKED433S ([#6113](https://github.com/ashlrai/phantom/issues/6113)) ([ba36a7c](https://github.com/ashlrai/phantom/commit/ba36a7c593a9e345b6979764cd87b2976f06ba3b))
* **RQ-PHX-SLACKNOTICECONFLICT436S:** BRIDGE_NOTES — RQ-PHX-SLACKNOTICECONFLICT436S ([#6120](https://github.com/ashlrai/phantom/issues/6120)) ([8e9e20a](https://github.com/ashlrai/phantom/commit/8e9e20a4270da8b183d0dec94beedb22086b3219))
* **RQ-PHX-SLACKNOTICEIDENTITY434S:** BRIDGE_NOTES — RQ-PHX-SLACKNOTICEIDENTITY434S ([#6115](https://github.com/ashlrai/phantom/issues/6115)) ([05101be](https://github.com/ashlrai/phantom/commit/05101be1e504e0c8d74c193f37a33e6cfc42a29c))
* **RQ-PHX-SLACKORDERSASK366:** RQ-PHX-SLACKORDERSASK366 — "orders" short-ask for the Slack ([#5686](https://github.com/ashlrai/phantom/issues/5686)) ([af54918](https://github.com/ashlrai/phantom/commit/af54918dc84bf6e37ed9a39d203c79cdfdf4d26f))
* **RQ-PHX-SLACKOWNERSASK386:** RQ-PHX-SLACKOWNERSASK386 — exact `owners` ask in the owner-g ([#5792](https://github.com/ashlrai/phantom/issues/5792)) ([2f65895](https://github.com/ashlrai/phantom/commit/2f6589586c84ac66b32d2026b824dad3ca9f7710))
* **RQ-PHX-SLACKOWNERSDURABLE432S:** Durable Slack owner qualification ([#6107](https://github.com/ashlrai/phantom/issues/6107)) ([c74e295](https://github.com/ashlrai/phantom/commit/c74e2952875653bb0638b2b3c214edbf5739d360))
* **RQ-PHX-SLACKPEERPAIR404S:** BRIDGE_NOTES — RQ-PHX-SLACKPEERPAIR404S ([#6003](https://github.com/ashlrai/phantom/issues/6003)) ([4a9fb13](https://github.com/ashlrai/phantom/commit/4a9fb132dd829b8892c8117a2b8af54bc54b8e6d))
* **RQ-PHX-SLACKPEERRETRY398S:** BRIDGE_NOTES — RQ-PHX-SLACKPEERRETRY398S ([#5976](https://github.com/ashlrai/phantom/issues/5976)) ([3e54a1f](https://github.com/ashlrai/phantom/commit/3e54a1fb00f6f204916a61efceb039a96db558a0))
* **RQ-PHX-SLACKPEERSASK396:** RQ-PHX-SLACKPEERSASK396 ([#5969](https://github.com/ashlrai/phantom/issues/5969)) ([85d6d4c](https://github.com/ashlrai/phantom/commit/85d6d4c4f73a9b5350619438b839ec91e12ac1e7))
* **RQ-PHX-SLACKREPLYRECEIVETIME439S:** RQ-PHX-SLACKREPLYRECEIVETIME439S ([#6128](https://github.com/ashlrai/phantom/issues/6128)) ([23bd4f2](https://github.com/ashlrai/phantom/commit/23bd4f290250f65bc302ceb2e7940b8ea1a1f49f))
* **RQ-PHX-SLACKREVIEWASK374:** BRIDGE_NOTES — RQ-PHX-SLACKREVIEWASK374 ([#5721](https://github.com/ashlrai/phantom/issues/5721)) ([d0dc506](https://github.com/ashlrai/phantom/commit/d0dc506e2d32cf10943c8546c9cbd3f270b7d330))
* **RQ-PHX-SLACKRUNCLAIMTICK389:** RQ-PHX-SLACKRUNCLAIMTICK389: proactive claim notices in `phm ([#5860](https://github.com/ashlrai/phantom/issues/5860)) ([2304dff](https://github.com/ashlrai/phantom/commit/2304dff5074623c17eb19b9e39bdda6698a8b80f))
* **RQ-PHX-SLACKRUNTIMEDURABLE428S:** RQ-PHX-SLACKRUNTIMEDURABLE428S — bridge notes ([#6092](https://github.com/ashlrai/phantom/issues/6092)) ([03e5847](https://github.com/ashlrai/phantom/commit/03e58474f3cbbd14a5da10ebdf89a095f1704e1f))
* **RQ-PHX-SLACKSTATUSINGRESS440S:** Slack status failed ingress ([#6134](https://github.com/ashlrai/phantom/issues/6134)) ([b8379f0](https://github.com/ashlrai/phantom/commit/b8379f00503abd123baf5f09908d3a490bba61e2))
* **RQ-PHX-SLACKSTATUSRUNTIME383:** RQ-PHX-SLACKSTATUSRUNTIME383 ([#5781](https://github.com/ashlrai/phantom/issues/5781)) ([dcb4b78](https://github.com/ashlrai/phantom/commit/dcb4b78b7244916fc539a95e4ee9322c67c4e451))
* **RQ-PHX-SLACKTICKSINGLEFLIGHT435S:** RQ-PHX-SLACKTICKSINGLEFLIGHT435S ([#6117](https://github.com/ashlrai/phantom/issues/6117)) ([e9771e9](https://github.com/ashlrai/phantom/commit/e9771e975e1a265165b1a59cf4e258439ebbb473))
* **RQ-PHX-SLACKTRACEATTEMPT433S:** RQ-PHX-SLACKTRACEATTEMPT433S ([#6114](https://github.com/ashlrai/phantom/issues/6114)) ([ea732d0](https://github.com/ashlrai/phantom/commit/ea732d0529d94108ee4b56e94269edbca540edf2))
* **RQ-PHX-SLACKTRACEDESK440C:** BRIDGE_NOTES — RQ-PHX-SLACKTRACEDESK440C ([#6136](https://github.com/ashlrai/phantom/issues/6136)) ([0e3ed56](https://github.com/ashlrai/phantom/commit/0e3ed569e47c53f2f049df6e66e8b2182ef442bc))
* **RQ-PHX-SLACKTRACEEVIDENCE435S:** RQ-PHX-SLACKTRACEEVIDENCE435S ([#6116](https://github.com/ashlrai/phantom/issues/6116)) ([bc62df9](https://github.com/ashlrai/phantom/commit/bc62df926c15709c633c4b192f00e2413d72d1cf))
* **RQ-PHX-SNAPSHOTEXEC388:** RQ-PHX-SNAPSHOTEXEC388 ([#5839](https://github.com/ashlrai/phantom/issues/5839)) ([9af1f5f](https://github.com/ashlrai/phantom/commit/9af1f5f42d00d3b8ed9fb13fa3f6511a5a1e051e))
* **RQ-PHX-SNAPSHOTEXECLINE390:** Runtime execution row ([#5872](https://github.com/ashlrai/phantom/issues/5872)) ([035b79e](https://github.com/ashlrai/phantom/commit/035b79edef4e7da4e60f5938150c55516b2f90e3))
* **RQ-PHX-STATUSCOMPUTERS351:** RQ-PHX-STATUSCOMPUTERS351 ([#5626](https://github.com/ashlrai/phantom/issues/5626)) ([5e3a395](https://github.com/ashlrai/phantom/commit/5e3a395325f0d719d5f9b64b31bb2ded7e093e4b))
* **RQ-PHX-STATUSNODERUNS401:** RQ-PHX-STATUSNODERUNS401 — node runs line in the status dige ([#5991](https://github.com/ashlrai/phantom/issues/5991)) ([373b47b](https://github.com/ashlrai/phantom/commit/373b47b281b514d8804c77215ccf637ff7a5b2d5))
* **RQ-PHX-STATUSPEERSLINE396:** RQ-PHX-STATUSPEERSLINE396 ([#5968](https://github.com/ashlrai/phantom/issues/5968)) ([9e90594](https://github.com/ashlrai/phantom/commit/9e90594c6eb7c827b04e071aa1a2a829ef5bfd27))
* **RQ-PHX-STATUSWORDGRADE406C:** BRIDGE_NOTES: RQ-PHX-STATUSWORDGRADE406C ([#6013](https://github.com/ashlrai/phantom/issues/6013)) ([6ff77ff](https://github.com/ashlrai/phantom/commit/6ff77ffbd47cc7d09a3745382ca9b951520519b2))
* **RQ-PHX-STRAYPATCHDROP373:** Bridge notes ([#5712](https://github.com/ashlrai/phantom/issues/5712)) ([49d5b74](https://github.com/ashlrai/phantom/commit/49d5b747c071678dc7a8dbc22ba7c0f92bbabbbb))
* **RQ-PHX-SURFACECLIHISTORYDEADLINE394S:** Bridge notes ([#5946](https://github.com/ashlrai/phantom/issues/5946)) ([963052d](https://github.com/ashlrai/phantom/commit/963052d6eb0dc3e3c50f842134a0a88766316aef))
* **RQ-PHX-SURFACEHTTPREADBOUND393S:** RQ-PHX-SURFACEHTTPREADBOUND393S ([#5929](https://github.com/ashlrai/phantom/issues/5929)) ([0402201](https://github.com/ashlrai/phantom/commit/04022011c6dec0bcb73a844d82097565c4f8e8e9))
* **RQ-PHX-SURFACEMCPREADBOUND393S:** RQ-PHX-SURFACEMCPREADBOUND393S ([#5928](https://github.com/ashlrai/phantom/issues/5928)) ([e84c082](https://github.com/ashlrai/phantom/commit/e84c0821a8e60b6b055067d196da28f7ba920366))
* **RQ-PHX-SURFACEOWNERCARD392:** RQ-PHX-SURFACEOWNERCARD392 ([#5933](https://github.com/ashlrai/phantom/issues/5933)) ([1b10215](https://github.com/ashlrai/phantom/commit/1b10215525e4cb81d5b8e6c822b01a12082865f1))
* **RQ-PHX-SURFACEOWNERMCP384:** RQ-PHX-SURFACEOWNERMCP384 ([#5786](https://github.com/ashlrai/phantom/issues/5786)) ([3c9f90a](https://github.com/ashlrai/phantom/commit/3c9f90a1c58cad4dc1c219fa78b8b4b96a284372))
* **RQ-PHX-SURFACEOWNERREPO387S:** BRIDGE_NOTES — RQ-PHX-SURFACEOWNERREPO387S ([#5814](https://github.com/ashlrai/phantom/issues/5814)) ([a2315b0](https://github.com/ashlrai/phantom/commit/a2315b0437ce50cd74bb5bd8d34e78645072bb05))
* **RQ-PHX-SURFACEOWNERROUTE386:** BRIDGE_NOTES — RQ-PHX-SURFACEOWNERROUTE386 ([#5794](https://github.com/ashlrai/phantom/issues/5794)) ([4f3f610](https://github.com/ashlrai/phantom/commit/4f3f610c7fe24036da5b29fb2f40e0eb29ac3433))
* **RQ-PHX-SURFACEOWNERVERB379:** RQ-PHX-SURFACEOWNERVERB379 — `ashlr fleet surface-owner` ([#5750](https://github.com/ashlrai/phantom/issues/5750)) ([b3d32d3](https://github.com/ashlrai/phantom/commit/b3d32d32e278d97d3674729cae1e73edd8e436ab))
* **RQ-PHX-TAILNETBACKENDTRUTH353S:** Bridge Notes: RQ-PHX-TAILNETBACKENDTRUTH353S ([#5640](https://github.com/ashlrai/phantom/issues/5640)) ([f8f2351](https://github.com/ashlrai/phantom/commit/f8f235118fecefe31c3b1c611afef26032bbd4cc))
* **RQ-PHX-TAILNETBACKENDUNKNOWN358S:** BRIDGE_NOTES — RQ-PHX-TAILNETBACKENDUNKNOWN358S ([#5666](https://github.com/ashlrai/phantom/issues/5666)) ([8db67f0](https://github.com/ashlrai/phantom/commit/8db67f055bba1b3a3f7933ad32a724f74f1bf088))
* **RQ-PHX-TAILNETMCPFRESH352S:** BRIDGE_NOTES — RQ-PHX-TAILNETMCPFRESH352S ([#5630](https://github.com/ashlrai/phantom/issues/5630)) ([bd5d679](https://github.com/ashlrai/phantom/commit/bd5d679f8344d882b37cc8516ed63a33465f8a2a))
* **RQ-PHX-TAILNETPEERSCARD348:** RQ-PHX-TAILNETPEERSCARD348 ([#5614](https://github.com/ashlrai/phantom/issues/5614)) ([ec8bd96](https://github.com/ashlrai/phantom/commit/ec8bd966f1293fe85aa7b4b6ab69c7e2cb45213f))
* **RQ-PHX-TAILNETPEERSMCP350:** RQ-PHX-TAILNETPEERSMCP350 — fleet_tailnet_peers MCP tool ([#5623](https://github.com/ashlrai/phantom/issues/5623)) ([83577b6](https://github.com/ashlrai/phantom/commit/83577b65532818c6aa08f531de6970702e7ea458))
* **RQ-PHX-TAILNETPEERSREAD348:** BRIDGE_NOTES — RQ-PHX-TAILNETPEERSREAD348 ([#5613](https://github.com/ashlrai/phantom/issues/5613)) ([0cd02cd](https://github.com/ashlrai/phantom/commit/0cd02cd835932ea0fca3406ca18adaab44df4bfa))
* **RQ-PHX-TAILNETREASONBOUND355S:** RQ-PHX-TAILNETREASONBOUND355S - Bridge Notes ([#5648](https://github.com/ashlrai/phantom/issues/5648)) ([fc4c1a4](https://github.com/ashlrai/phantom/commit/fc4c1a4abc27cfbadc9d0f80321c2460eb25ca0e))
* **RQ-PHX-TEAMTASKRECOVER437S:** BRIDGE_NOTES — RQ-PHX-TEAMTASKRECOVER437S ([#6123](https://github.com/ashlrai/phantom/issues/6123)) ([ef2d67a](https://github.com/ashlrai/phantom/commit/ef2d67a6032871384ac81db54703f625b56b956b))
* **RQ-PHX-VERIFYEMPTYTEST371:** Added an early changed-test content check and seven focused ([#5709](https://github.com/ashlrai/phantom/issues/5709)) ([05eb31a](https://github.com/ashlrai/phantom/commit/05eb31abd5a4e3e1cdeff38a67d2dc0d6f9ed937))
* **RQ-PHX-VERSEROUTEPARITY408C:** BRIDGE_NOTES — RQ-PHX-VERSEROUTEPARITY408C ([#6031](https://github.com/ashlrai/phantom/issues/6031)) ([d08bdef](https://github.com/ashlrai/phantom/commit/d08bdefd959562e350f9cacbc915dfbd8acb5e41))
* **RQ-PROOF-LOOP-1:** BRIDGE_NOTES — RQ-PROOF-LOOP-1 ([#6142](https://github.com/ashlrai/phantom/issues/6142)) ([6f6205d](https://github.com/ashlrai/phantom/commit/6f6205d8a50efc3eb5fb6d1baa14e415c123c8ad))
* **RQ-PUBLISH-WORKTREE-SCOPE-1:** RQ-PUBLISH-WORKTREE-SCOPE-1: publish.sh scopes the PR diff t ([#6099](https://github.com/ashlrai/phantom/issues/6099)) ([7ab7979](https://github.com/ashlrai/phantom/commit/7ab797911de8aa00a03d6cd7d5e7a0f2305daaf7))
* **RQ-REBASE-PHANTOM-2884:** RQ-REBASE-PHANTOM-2884 ([#5823](https://github.com/ashlrai/phantom/issues/5823)) ([9d7ae1c](https://github.com/ashlrai/phantom/commit/9d7ae1c4b795e1f8868171844f4b40459b9443c8))
* **RQ-REBASE-PHANTOM-2910:** BRIDGE_NOTES — RQ-REBASE-PHANTOM-2910 ([#5822](https://github.com/ashlrai/phantom/issues/5822)) ([01e0a92](https://github.com/ashlrai/phantom/commit/01e0a92ce2135d6d1a2d7bfef00f8620ff20713b))
* **RQ-REBASE-PHANTOM-3510:** RQ-REBASE-PHANTOM-3510 ([#5837](https://github.com/ashlrai/phantom/issues/5837)) ([4c26975](https://github.com/ashlrai/phantom/commit/4c26975a13b28def4c8b031fcd497b9fed5a7359))
* **RQ-REBASE-PHANTOM-3514:** RQ-REBASE-PHANTOM-3514 ([#5834](https://github.com/ashlrai/phantom/issues/5834)) ([30b1d81](https://github.com/ashlrai/phantom/commit/30b1d81841fc5fcaa47a50c4e3dd46d547c75800))
* **RQ-REBASE-PHANTOM-3519:** RQ-REBASE-PHANTOM-3519 ([#5835](https://github.com/ashlrai/phantom/issues/5835)) ([6e5ccfd](https://github.com/ashlrai/phantom/commit/6e5ccfd81e0dcaa9fb773f71fae99e05a0e6d863))
* **RQ-REBASE-PHANTOM-3529:** RQ-REBASE-PHANTOM-3529 ([#5841](https://github.com/ashlrai/phantom/issues/5841)) ([4843973](https://github.com/ashlrai/phantom/commit/4843973ad6c6ebbe2aefa7a961b0346819224186))
* **RQ-REBASE-PHANTOM-3917:** RQ-REBASE-PHANTOM-3917 ([#5842](https://github.com/ashlrai/phantom/issues/5842)) ([2ef2749](https://github.com/ashlrai/phantom/commit/2ef274962fa42539b6e5235ac57cf26a1ec91c5b))
* **RQ-REBASE-PHANTOM-3922:** RQ-REBASE-PHANTOM-3922 ([#5846](https://github.com/ashlrai/phantom/issues/5846)) ([d9075d7](https://github.com/ashlrai/phantom/commit/d9075d7763a2c598d8e70a59b79a9e2063578703))
* **RQ-REBASE-PHANTOM-4027:** RQ-REBASE-PHANTOM-4027 ([#5851](https://github.com/ashlrai/phantom/issues/5851)) ([31e6823](https://github.com/ashlrai/phantom/commit/31e6823a569411aec458f643c05d781eb35f5a80))
* **RQ-REBASE-PHANTOM-4053:** RQ-REBASE-PHANTOM-4053 — BLOCKED, local CI repair prepared ([#5856](https://github.com/ashlrai/phantom/issues/5856)) ([92bb05b](https://github.com/ashlrai/phantom/commit/92bb05bfced67e297fbb402321f506d19a46a34a))
* **RQ-REBASE-PHANTOM-4133:** BRIDGE_NOTES — RQ-REBASE-PHANTOM-4133 ([#5868](https://github.com/ashlrai/phantom/issues/5868)) ([6013c47](https://github.com/ashlrai/phantom/commit/6013c4775461fb6bcddb0b294ac145ef7f6a2006))
* **RQ-REBASE-PHANTOM-4204:** RQ-REBASE-PHANTOM-4204 ([#5871](https://github.com/ashlrai/phantom/issues/5871)) ([e7882ec](https://github.com/ashlrai/phantom/commit/e7882eca97ed84e51983aea7e21f3333b2ba8337))
* **RQ-REBASE-PHANTOM-4258:** RQ-REBASE-PHANTOM-4258 ([#5873](https://github.com/ashlrai/phantom/issues/5873)) ([12e8744](https://github.com/ashlrai/phantom/commit/12e87444d083503cad4cf2c5e409eda86d0dbec3))
* **RQ-REBASE-PHANTOM-4281:** RQ-REBASE-PHANTOM-4281 ([#5874](https://github.com/ashlrai/phantom/issues/5874)) ([a1d65b0](https://github.com/ashlrai/phantom/commit/a1d65b02f626d807497842545767500e2442d1be))
* **RQ-REBASE-PHANTOM-4325:** RQ-REBASE-PHANTOM-4325 ([#5876](https://github.com/ashlrai/phantom/issues/5876)) ([bebf405](https://github.com/ashlrai/phantom/commit/bebf405812146a462ed57bfcc84e9b13f331dc40))
* **RQ-REBASE-PHANTOM-4387:** BRIDGE_NOTES — RQ-REBASE-PHANTOM-4387 ([#5880](https://github.com/ashlrai/phantom/issues/5880)) ([43b0955](https://github.com/ashlrai/phantom/commit/43b095585879b405d73052c7078bc3c9ba17c9f2))
* **RQ-REBASE-PHANTOM-4453:** RQ-REBASE-PHANTOM-4453 ([#5878](https://github.com/ashlrai/phantom/issues/5878)) ([e25c4f5](https://github.com/ashlrai/phantom/commit/e25c4f5ccfb8ae4fa86ec72e5b5d6a218021dd40))
* **RQ-REBASE-PHANTOM-4590:** RQ-REBASE-PHANTOM-4590 ([#5887](https://github.com/ashlrai/phantom/issues/5887)) ([e4f2dbc](https://github.com/ashlrai/phantom/commit/e4f2dbce82ab4ff69063f9e9abdb99799245cc6d))
* **RQ-REBASE-PHANTOM-4650:** RQ-REBASE-PHANTOM-4650 ([#5889](https://github.com/ashlrai/phantom/issues/5889)) ([4fd42da](https://github.com/ashlrai/phantom/commit/4fd42dad9f01b3b712e87daeb3287566ec47d23e))
* **RQ-REBASE-PHANTOM-4661:** RQ-REBASE-PHANTOM-4661 ([#5891](https://github.com/ashlrai/phantom/issues/5891)) ([921cac4](https://github.com/ashlrai/phantom/commit/921cac4907f8f9056d85825852197d7d12bd5b0c))
* **RQ-REBASE-PHANTOM-4776:** RQ-REBASE-PHANTOM-4776 — existing PR [#4776](https://github.com/ashlrai/phantom/issues/4776) only ([#5898](https://github.com/ashlrai/phantom/issues/5898)) ([1ec003a](https://github.com/ashlrai/phantom/commit/1ec003a5c0812baf34288122746e74c391652839))
* RQ-REBASE-PHANTOM-4845 ([#5918](https://github.com/ashlrai/phantom/issues/5918)) ([dc26e68](https://github.com/ashlrai/phantom/commit/dc26e6868323645281ca3efd3dc4ffa0c5c0088f))
* **RQ-REBASE-PHANTOM-4846:** RQ-REBASE-PHANTOM-4846 ([#5901](https://github.com/ashlrai/phantom/issues/5901)) ([db0bd17](https://github.com/ashlrai/phantom/commit/db0bd17fbef780284ee76d47a3553a7a65dd8e43))
* **RQ-REBASE-PHANTOM-4957:** RQ-REBASE-PHANTOM-4957 ([#5907](https://github.com/ashlrai/phantom/issues/5907)) ([1a6d08b](https://github.com/ashlrai/phantom/commit/1a6d08b9fcb49c43542fa8e55f9dde3f3462df8c))
* **RQ-REBASE-PHANTOM-4989:** RQ-REBASE-PHANTOM-4989 ([#5909](https://github.com/ashlrai/phantom/issues/5909)) ([00834cd](https://github.com/ashlrai/phantom/commit/00834cd986e5bd1389fccb977d4246a6dbaac26e))
* **RQ-REBASE-PHANTOM-5005:** RQ-REBASE-PHANTOM-5005 ([#5911](https://github.com/ashlrai/phantom/issues/5911)) ([80c8499](https://github.com/ashlrai/phantom/commit/80c84993a851c3a3cfdecc3afed2b83b5ed29eaf))
* **RQ-REBASE-PHANTOM-5017:** RQ-REBASE-PHANTOM-5017 ([#5912](https://github.com/ashlrai/phantom/issues/5912)) ([831858a](https://github.com/ashlrai/phantom/commit/831858a9367e789d3c2cb6848d557871aa2af26e))
* **RQ-REBASE-PHANTOM-5037:** RQ-REBASE-PHANTOM-5037 ([#5916](https://github.com/ashlrai/phantom/issues/5916)) ([4f7db75](https://github.com/ashlrai/phantom/commit/4f7db75ff43a0f388556d9a7023a719f40a14807))
* **RQ-REBASE-PHANTOM-5062:** RQ-REBASE-PHANTOM-5062 ([#5917](https://github.com/ashlrai/phantom/issues/5917)) ([48948cd](https://github.com/ashlrai/phantom/commit/48948cd80e32862905b226aef06e37c3cb8f2776))
* **RQ-REBASE-PHANTOM-5197:** RQ-REBASE-PHANTOM-5197 ([#5935](https://github.com/ashlrai/phantom/issues/5935)) ([44090ae](https://github.com/ashlrai/phantom/commit/44090aed4b9b631c50374a18888f29e75bc4a808))
* **RQ-REBASE-PHANTOM-5346:** BRIDGE_NOTES: RQ-REBASE-PHANTOM-5346 ([#5939](https://github.com/ashlrai/phantom/issues/5939)) ([56292af](https://github.com/ashlrai/phantom/commit/56292afc0195c78be24f4aacd9a0c66c556b8a4e))
* **RQ-RESEARCH-FLEET-1:** BRIDGE_NOTES — RQ-RESEARCH-FLEET-1 ([#5949](https://github.com/ashlrai/phantom/issues/5949)) ([6328386](https://github.com/ashlrai/phantom/commit/63283860155ef123e8bca71b38ba18d4dbe7a03a))
* **RQ-SCHEDLOOP-1:** RQ-SCHEDLOOP-1 ([#6161](https://github.com/ashlrai/phantom/issues/6161)) ([e9d0af3](https://github.com/ashlrai/phantom/commit/e9d0af362c0f922aa876350f102d346a6994929f))
* **RQ-SESSION-ECON-1:** RQ-SESSION-ECON-1 ([#5954](https://github.com/ashlrai/phantom/issues/5954)) ([b846925](https://github.com/ashlrai/phantom/commit/b8469252bc26d2bab1ce5620d0d2a71130ac6388))
* **RQ-SESSION-HANDOFF-1:** RQ-SESSION-HANDOFF-1 ([#5955](https://github.com/ashlrai/phantom/issues/5955)) ([2385cdf](https://github.com/ashlrai/phantom/commit/2385cdf86ebdcaac1b10e0dcbef860edc04f05e9))
* **RQ-STACKSYNC-WIRE-1:** RQ-STACKSYNC-WIRE-1 bridge notes ([#5957](https://github.com/ashlrai/phantom/issues/5957)) ([6ab44ab](https://github.com/ashlrai/phantom/commit/6ab44abb127c6bad15d837f98d93b0ff553ae8df))
* **RQ-UPKEEP-DOCS-phantom-20261114:** RQ-UPKEEP-DOCS-phantom-20261114 ([#5956](https://github.com/ashlrai/phantom/issues/5956)) ([f099c26](https://github.com/ashlrai/phantom/commit/f099c26b9f751640de3222010f5a9d18fdf51169))
* **RQ-UPKEEP-DOCS-phantom-20261115:** BRIDGE_NOTES: RQ-UPKEEP-DOCS-phantom-20261115 ([#6057](https://github.com/ashlrai/phantom/issues/6057)) ([f978ee4](https://github.com/ashlrai/phantom/commit/f978ee4231f4806e60a9e875c8147c470cbb059f))
* **RQ-VIZ-MAP-2D-1:** RQ-VIZ-MAP-2D-1 ([#6140](https://github.com/ashlrai/phantom/issues/6140)) ([89060d4](https://github.com/ashlrai/phantom/commit/89060d4fee4048b0fa8c47924ddd7b43197fb5f7))
* **RQ-VIZ-MAP-3D-1:** RQ-VIZ-MAP-3D-1 — 3D fleet map ([#6146](https://github.com/ashlrai/phantom/issues/6146)) ([ef70204](https://github.com/ashlrai/phantom/commit/ef70204c9cd3b668cf031333381f788306e20d77))
* **RQ-VIZ-SESSIONS-1:** RQ-VIZ-SESSIONS-1 ([#6102](https://github.com/ashlrai/phantom/issues/6102)) ([f465575](https://github.com/ashlrai/phantom/commit/f46557585e00d2a8af426ac7e973ecaa909c3eaf))


### Maintenance

* rename ashlar-landing refs to ashlr-landing after repo rename ([#5795](https://github.com/ashlrai/phantom/issues/5795)) ([562069d](https://github.com/ashlrai/phantom/commit/562069d86720c571294cf64f5876d3147584b239))

## [3.30.33] - 2026-11-13


### Changes

* **FIXUP-CI-phantom-auto-tag-251471:** BRIDGE_NOTES: FIXUP-CI-phantom-auto-tag-251471 ([#4798](https://github.com/ashlrai/phantom/issues/4798)) ([fadcf89](https://github.com/ashlrai/phantom/commit/fadcf897e72c07fa364f834b3d5f8c9708f64b0e))
* **RQ-APP-LOCALBUILD-ZOMBIEFIX:** ([#4900](https://github.com/ashlrai/phantom/issues/4900)) ([9a0b080](https://github.com/ashlrai/phantom/commit/9a0b08038d0f9a9c6262b36b312311ac78d93263))
* **RQ-APP-ZOMBIE-REAP-1:** RQ-APP-ZOMBIE-REAP-1 ([#4783](https://github.com/ashlrai/phantom/issues/4783)) ([435de59](https://github.com/ashlrai/phantom/commit/435de59d91d32150f722ce7cef472003fcac7732))
* **RQ-BATCH-SESSIONS-2:** BRIDGE_NOTES: RQ-BATCH-SESSIONS-2 (P0, CONCURRENCY-MAX-1) ([#4942](https://github.com/ashlrai/phantom/issues/4942)) ([ddc34d7](https://github.com/ashlrai/phantom/commit/ddc34d7f2af7dd0a5ad917ffcc9c6ad94136a6c9))
* **RQ-CODEXP-EMPTY-1:** RQ-CODEXP-EMPTY-1: codex-personal empty-output rate ([#4804](https://github.com/ashlrai/phantom/issues/4804)) ([e5f6ef9](https://github.com/ashlrai/phantom/commit/e5f6ef9827cd0e930753b4d2635ecb36d4353539))
* **RQ-CONCURRENCY-MAX-1:** RQ-CONCURRENCY-MAX-1 handoff ([#4790](https://github.com/ashlrai/phantom/issues/4790)) ([923a7af](https://github.com/ashlrai/phantom/commit/923a7afa9e2f4a799091386ddc0921ec1d2944ce))
* **RQ-DESK-APPROVALS-1:** BRIDGE_NOTES — RQ-DESK-APPROVALS-1 ([#4947](https://github.com/ashlrai/phantom/issues/4947)) ([b71d883](https://github.com/ashlrai/phantom/commit/b71d883285ad0ca797a247343bd382c599c17c8f))
* **RQ-DESK-OBSERVE-POLISH-1:** BRIDGE_NOTES — RQ-DESK-OBSERVE-POLISH-1 ([#4918](https://github.com/ashlrai/phantom/issues/4918)) ([b6f87aa](https://github.com/ashlrai/phantom/commit/b6f87aaf96991bce9c484d14459edeb7b6e000c4))
* **RQ-DESK-SIDEBAR-RESIZE-1:** RQ-DESK-SIDEBAR-RESIZE-1 ([#4904](https://github.com/ashlrai/phantom/issues/4904)) ([3000760](https://github.com/ashlrai/phantom/commit/30007600a4ba134c1074afe91bf73a612211de52))
* **RQ-DESK-TOOLTIPS-1:** RQ-DESK-TOOLTIPS-1 — bridge notes ([#4908](https://github.com/ashlrai/phantom/issues/4908)) ([27c628b](https://github.com/ashlrai/phantom/commit/27c628b39b8a32f8554a4b0af832f1a71b8432ca))
* **RQ-DESK-VERSE-STRINGS-1:** RQ-DESK-VERSE-STRINGS-1 ([#4905](https://github.com/ashlrai/phantom/issues/4905)) ([3649e58](https://github.com/ashlrai/phantom/commit/3649e588292dfa4f2e4032231b208f50230fb286))
* **RQ-FIX-PHANTOM-2960:** BRIDGE_NOTES — RQ-FIX-PHANTOM-2960 ([#4740](https://github.com/ashlrai/phantom/issues/4740)) ([f17adaf](https://github.com/ashlrai/phantom/commit/f17adafa060f571ed962e04c957f20032bbfc203))
* **RQ-FIX-PHANTOM-3146:** BRIDGE_NOTES — RQ-FIX-PHANTOM-3146 ([#4745](https://github.com/ashlrai/phantom/issues/4745)) ([35ac6ec](https://github.com/ashlrai/phantom/commit/35ac6ecd098b8d212e08dc11aef898d4ff3a2e06))
* **RQ-FIX-PHANTOM-3230:** BRIDGE_NOTES — RQ-FIX-PHANTOM-3230 (PR [#3230](https://github.com/ashlrai/phantom/issues/3230), bridge RQ-QUEU ([#4760](https://github.com/ashlrai/phantom/issues/4760)) ([483f2bb](https://github.com/ashlrai/phantom/commit/483f2bbb4e0752e3f523c1f2a80d4fd4d01181e7))
* **RQ-FIX-PHANTOM-3235:** BRIDGE_NOTES — RQ-FIX-PHANTOM-3235 ([#4763](https://github.com/ashlrai/phantom/issues/4763)) ([88f045b](https://github.com/ashlrai/phantom/commit/88f045b474ca83850ffe31671bfb11b76f836832))
* **RQ-FIX-PHANTOM-3237:** BRIDGE_NOTES — RQ-FIX-PHANTOM-3237 ([#4761](https://github.com/ashlrai/phantom/issues/4761)) ([8b91b70](https://github.com/ashlrai/phantom/commit/8b91b707fa6349ea1e3cbe7509cae8ca38330cbd))
* **RQ-FIX-PHANTOM-3326:** RQ-FIX-PHANTOM-3326 — update PR [#3326](https://github.com/ashlrai/phantom/issues/3326) (bridge RQ-AGL-MEM-1) ([#4822](https://github.com/ashlrai/phantom/issues/4822)) ([cb629dc](https://github.com/ashlrai/phantom/commit/cb629dc740f1c2eda8bb90acc9485969a163f0a6))
* **RQ-FIX-PHANTOM-3357:** BRIDGE NOTES — RQ-FIX-PHANTOM-3357 ([#4858](https://github.com/ashlrai/phantom/issues/4858)) ([45f9176](https://github.com/ashlrai/phantom/commit/45f9176fc1e779fa44fbcaa40581a68038e1ae86))
* **RQ-FIX-PHANTOM-3359:** BRIDGE_NOTES — RQ-FIX-PHANTOM-3359 ([#4867](https://github.com/ashlrai/phantom/issues/4867)) ([47e5ec1](https://github.com/ashlrai/phantom/commit/47e5ec19c9f120c66b9737e4d499b634818052c5))
* **RQ-FIX-PHANTOM-3465:** BRIDGE_NOTES — RQ-FIX-PHANTOM-3465 ([#4928](https://github.com/ashlrai/phantom/issues/4928)) ([20b7750](https://github.com/ashlrai/phantom/commit/20b7750cdfd2e987cf213863e433827c14500d64))
* **RQ-FIX-PHANTOM-3917:** RQ-FIX-PHANTOM-3917 ([#4945](https://github.com/ashlrai/phantom/issues/4945)) ([dd51596](https://github.com/ashlrai/phantom/commit/dd51596dd0a14d6a2bd1e2f1788575c894a74799))
* **RQ-FIX-PHANTOM-3972:** BRIDGE_NOTES: RQ-FIX-PHANTOM-3972 ([#4949](https://github.com/ashlrai/phantom/issues/4949)) ([4cab334](https://github.com/ashlrai/phantom/commit/4cab334054cc0390c63a3abf5e32f5091a1a874b))
* **RQ-FIX-PHANTOM-4027:** RQ-FIX-PHANTOM-4027 — PR [#4027](https://github.com/ashlrai/phantom/issues/4027) (bridge RQ-REBASE-PH-28) reba ([#4986](https://github.com/ashlrai/phantom/issues/4986)) ([ba8106a](https://github.com/ashlrai/phantom/commit/ba8106a1ac53b9f5f0d7a99025693717ae0c76cc))
* **RQ-FIX-PHANTOM-4222:** RQ-FIX-PHANTOM-4222 handoff ([#4630](https://github.com/ashlrai/phantom/issues/4630)) ([87c8406](https://github.com/ashlrai/phantom/commit/87c8406675427ce5f62f07531089baadd954dbcd))
* **RQ-FLEET-LOADBALANCER-1:** BRIDGE_NOTES: RQ-FLEET-LOADBALANCER-1 (unified fleet control ([#4975](https://github.com/ashlrai/phantom/issues/4975)) ([c6aed9a](https://github.com/ashlrai/phantom/commit/c6aed9a3fe8d032a2c629fbe0e5dab4cf0f3d971))
* **RQ-GROK2-PH-SWARM-1:** Agent Bus v2 work-feed audit ([#4896](https://github.com/ashlrai/phantom/issues/4896)) ([b403336](https://github.com/ashlrai/phantom/commit/b403336b87611ef38ef9de8a0e9c543747156f7f))
* **RQ-PHX-APPEARANCEAGENTSET119:** BRIDGE_NOTES — RQ-PHX-APPEARANCEAGENTSET119 ([#4925](https://github.com/ashlrai/phantom/issues/4925)) ([fa46a73](https://github.com/ashlrai/phantom/commit/fa46a73216209587eb0966761ebfe2ef16600e0c))
* **RQ-PHX-APPSRECOVERYEXACT180:** BRIDGE_NOTES — RQ-PHX-APPSRECOVERYEXACT180 ([#5173](https://github.com/ashlrai/phantom/issues/5173)) ([cddb327](https://github.com/ashlrai/phantom/commit/cddb32744337e5d12286f253b87730c54452ff0e))
* **RQ-PHX-AUTOPILOTREADORIGINAL270S:** BRIDGE_NOTES — RQ-PHX-AUTOPILOTREADORIGINAL270S ([#5360](https://github.com/ashlrai/phantom/issues/5360)) ([bb230f9](https://github.com/ashlrai/phantom/commit/bb230f9e444508abfb4c0affed4ac89b4156af5d))
* **RQ-PHX-BACKLOGORIGINALRECONCILE237S:** RQ-PHX-BACKLOGORIGINALRECONCILE237S - Original PR Reconcilia ([#5335](https://github.com/ashlrai/phantom/issues/5335)) ([87c61b9](https://github.com/ashlrai/phantom/commit/87c61b9ebca2780db32cf218916c7b3814f70267))
* **RQ-PHX-BRIEFCLIORIGINAL263S:** BRIDGE_NOTES — RQ-PHX-BRIEFCLIORIGINAL263S ([#5353](https://github.com/ashlrai/phantom/issues/5353)) ([c2f5f20](https://github.com/ashlrai/phantom/commit/c2f5f20ebc61b8956f6508400c6925a2344eb1a9))
* **RQ-PHX-BUNBUILDROOTRM144:** RQ-PHX-BUNBUILDROOTRM144 ([#5045](https://github.com/ashlrai/phantom/issues/5045)) ([0d1ec5d](https://github.com/ashlrai/phantom/commit/0d1ec5d7c82328fcfe400f3a17914c092270beab))
* **RQ-PHX-BUSCLAIMWIRE197S:** BRIDGE_NOTES — RQ-PHX-BUSCLAIMWIRE197S ([#5233](https://github.com/ashlrai/phantom/issues/5233)) ([5c018fb](https://github.com/ashlrai/phantom/commit/5c018fbaafd370ad90100460f5670da3b33e22f5))
* **RQ-PHX-BUSFAILURECONTINUE10SSH2:** Bridge notes ([#4779](https://github.com/ashlrai/phantom/issues/4779)) ([f995e4b](https://github.com/ashlrai/phantom/commit/f995e4bde6786afa244181cf13dc7f44ff0897df))
* **RQ-PHX-BUSFILTERPRESERVE201S:** BRIDGE_NOTES — RQ-PHX-BUSFILTERPRESERVE201S ([#5244](https://github.com/ashlrai/phantom/issues/5244)) ([351e893](https://github.com/ashlrai/phantom/commit/351e89377af0f86a5bad73a3f316d81832917f77))
* **RQ-PHX-BUSPROTOCOLPROOF244S:** BRIDGE_NOTES — RQ-PHX-BUSPROTOCOLPROOF244S ([#5332](https://github.com/ashlrai/phantom/issues/5332)) ([3983ea1](https://github.com/ashlrai/phantom/commit/3983ea172ae0008fef9716d962a369100a0a99d3))
* **RQ-PHX-CHANGELOGORIGINAL251S:** BRIDGE_NOTES — RQ-PHX-CHANGELOGORIGINAL251S ([#5341](https://github.com/ashlrai/phantom/issues/5341)) ([3df993f](https://github.com/ashlrai/phantom/commit/3df993f12781011388c2c21e971b9c68ed76740d))
* **RQ-PHX-CHANNELREPLYLAG96:** RQ-PHX-CHANNELREPLYLAG96 — per-channel reply lag on the Chan ([#4782](https://github.com/ashlrai/phantom/issues/4782)) ([66bb199](https://github.com/ashlrai/phantom/commit/66bb199524145e90ebe85a0a36e0fd74f43d45d9))
* **RQ-PHX-CLAUDEQUOTAREADPRESERVE203S:** BRIDGE_NOTES — RQ-PHX-CLAUDEQUOTAREADPRESERVE203S ([#5250](https://github.com/ashlrai/phantom/issues/5250)) ([f5f231e](https://github.com/ashlrai/phantom/commit/f5f231e40df2d3087cc7a7980037f153bf59a39b))
* **RQ-PHX-CODEMAPORIGINAL276S:** BRIDGE_NOTES — RQ-PHX-CODEMAPORIGINAL276S ([#5364](https://github.com/ashlrai/phantom/issues/5364)) ([9143722](https://github.com/ashlrai/phantom/commit/91437223a4e390d569f47b77597334863840b5c5))
* **RQ-PHX-COMMSBATCHRECEIPT101:** Batch receipt coverage ([#4780](https://github.com/ashlrai/phantom/issues/4780)) ([7df631c](https://github.com/ashlrai/phantom/commit/7df631c382fa58e5d374136769230ec180594095))
* **RQ-PHX-COMMSDIGESTORIGINAL252S:** BRIDGE_NOTES — RQ-PHX-COMMSDIGESTORIGINAL252S ([#5342](https://github.com/ashlrai/phantom/issues/5342)) ([60175de](https://github.com/ashlrai/phantom/commit/60175de7da72066a9674522ba561f7ca8b987af8))
* **RQ-PHX-COMMSSTATUSPATH101:** BRIDGE_NOTES — RQ-PHX-COMMSSTATUSPATH101 ([#4781](https://github.com/ashlrai/phantom/issues/4781)) ([97bb206](https://github.com/ashlrai/phantom/commit/97bb2064189e329586a49a7ded932c4759134342))
* **RQ-PHX-COMMSTRIAGEORIGINAL274S:** BRIDGE_NOTES — RQ-PHX-COMMSTRIAGEORIGINAL274S ([#5362](https://github.com/ashlrai/phantom/issues/5362)) ([7f5434e](https://github.com/ashlrai/phantom/commit/7f5434e5d77d884a012b5eb07a5712b8069a0d73))
* **RQ-PHX-COMPOSERHOLDSTATUS89:** BRIDGE_NOTES — RQ-PHX-COMPOSERHOLDSTATUS89 ([#4769](https://github.com/ashlrai/phantom/issues/4769)) ([f21bdc4](https://github.com/ashlrai/phantom/commit/f21bdc4d8f936df9fe1e0c210f0b29dc08fc5758))
* **RQ-PHX-COMPOSEROPEN108:** RQ-PHX-COMPOSEROPEN108 ([#4784](https://github.com/ashlrai/phantom/issues/4784)) ([25524c2](https://github.com/ashlrai/phantom/commit/25524c24e2e716d108c628ab62d53f8302b349b9))
* **RQ-PHX-CONNECTOREXECORIGINAL266S:** BRIDGE_NOTES — RQ-PHX-CONNECTOREXECORIGINAL266S ([#5356](https://github.com/ashlrai/phantom/issues/5356)) ([b9e4b9d](https://github.com/ashlrai/phantom/commit/b9e4b9dfc8b5d9bf23edc82d3de6cffe208bbb20))
* **RQ-PHX-COSDECLINEORIGINAL248S:** BRIDGE_NOTES — RQ-PHX-COSDECLINEORIGINAL248S ([#5337](https://github.com/ashlrai/phantom/issues/5337)) ([e5612ff](https://github.com/ashlrai/phantom/commit/e5612ff924bde2920b105cebf24433639fab6be7))
* **RQ-PHX-DESKTOPCRASHREPORT100:** RQ-PHX-DESKTOPCRASHREPORT100 — desktop pane crashes reach th ([#4788](https://github.com/ashlrai/phantom/issues/4788)) ([fbe115f](https://github.com/ashlrai/phantom/commit/fbe115f77ac58d941e13fdfc10d379684cc1ea51))
* **RQ-PHX-DEVINMODELEVIDENCEPORT192S:** BRIDGE_NOTES — RQ-PHX-DEVINMODELEVIDENCEPORT192S ([#5219](https://github.com/ashlrai/phantom/issues/5219)) ([0665558](https://github.com/ashlrai/phantom/commit/0665558c5a53d513c9a3465ee30de2a73951a988))
* **RQ-PHX-DEVLOOPORIGINAL278S:** BRIDGE_NOTES — RQ-PHX-DEVLOOPORIGINAL278S ([#5366](https://github.com/ashlrai/phantom/issues/5366)) ([bd31dd6](https://github.com/ashlrai/phantom/commit/bd31dd6855a04233a2beaa68db2233dfbe889e45))
* **RQ-PHX-DONEORIGINALRECONCILE265S:** BRIDGE_NOTES — RQ-PHX-DONEORIGINALRECONCILE265S ([#5355](https://github.com/ashlrai/phantom/issues/5355)) ([927f1a0](https://github.com/ashlrai/phantom/commit/927f1a09c973229fbbaceb2d30006c630b6efbe1))
* **RQ-PHX-DOTAGEORIGINALPORT192S:** BRIDGE_NOTES — RQ-PHX-DOTAGEORIGINALPORT192S ([#5218](https://github.com/ashlrai/phantom/issues/5218)) ([afa7e0f](https://github.com/ashlrai/phantom/commit/afa7e0f43f8cc266814d1b1ffbb46f7ffa80c309))
* **RQ-PHX-DOTAGEORIGINALROUTE241S:** BRIDGE_NOTES — RQ-PHX-DOTAGEORIGINALROUTE241S ([#5328](https://github.com/ashlrai/phantom/issues/5328)) ([c4260bd](https://github.com/ashlrai/phantom/commit/c4260bd626e02d46d03cf7e861856e9906d53438))
* **RQ-PHX-DOTCONTEXTFRESH143:** BRIDGE_NOTES — RQ-PHX-DOTCONTEXTFRESH143 ([#5041](https://github.com/ashlrai/phantom/issues/5041)) ([5535de6](https://github.com/ashlrai/phantom/commit/5535de6f63b2d391418ac77ee439720d1f6b9b71))
* **RQ-PHX-DOTCONTEXTSALVAGE146:** Recut of [#5041](https://github.com/ashlrai/phantom/issues/5041) ([#5051](https://github.com/ashlrai/phantom/issues/5051)) ([c95f598](https://github.com/ashlrai/phantom/commit/c95f5981120db9d9c7ba629decd26eec25b44809))
* **RQ-PHX-DOTFRESHNESSEXACT157:** Bridge notes: teammate context freshness ([#5087](https://github.com/ashlrai/phantom/issues/5087)) ([9e6a180](https://github.com/ashlrai/phantom/commit/9e6a180958e4139ffcf4a0992cc6f60d81009d43))
* **RQ-PHX-DOTREPLYCHRONOLOGY148:** Goal: Report only chronologically valid replies and exclude ([#5059](https://github.com/ashlrai/phantom/issues/5059)) ([f170315](https://github.com/ashlrai/phantom/commit/f1703154a366c9ce18cd98e77601c09baa913d24))
* **RQ-PHX-DOTREPLYUIRECOVER161:** RQ-PHX-DOTREPLYUIRECOVER161 ([#5106](https://github.com/ashlrai/phantom/issues/5106)) ([994412f](https://github.com/ashlrai/phantom/commit/994412feeb8aa05a1cf3af6703bedfd800e36cd8))
* **RQ-PHX-DOTRESOURCEROW94:** RQ-PHX-DOTRESOURCEROW94 — Dot (Ashlr.) as a fleet resource i ([#4796](https://github.com/ashlrai/phantom/issues/4796)) ([72c2e51](https://github.com/ashlrai/phantom/commit/72c2e51e48257e38ee0f8e49c3c1fc4bf0eb7428))
* **RQ-PHX-EMAILBATCHINPUTCANCEL107:** Bridge notes — RQ-PHX-EMAILBATCHINPUTCANCEL107 ([#4785](https://github.com/ashlrai/phantom/issues/4785)) ([356cfc2](https://github.com/ashlrai/phantom/commit/356cfc28015193d4476b1c28f98d23b43d07f17c))
* **RQ-PHX-EMAILBATCHINPUTDEADLINE114:** BRIDGE_NOTES — RQ-PHX-EMAILBATCHINPUTDEADLINE114 ([#4875](https://github.com/ashlrai/phantom/issues/4875)) ([a203eaf](https://github.com/ashlrai/phantom/commit/a203eaf9e2c2ef6331a17aba7ada4bb6d98e6d81))
* **RQ-PHX-EMAILBATCHMCPCONFIG117:** BRIDGE_NOTES — RQ-PHX-EMAILBATCHMCPCONFIG117 ([#4913](https://github.com/ashlrai/phantom/issues/4913)) ([e86dc1d](https://github.com/ashlrai/phantom/commit/e86dc1d0f92ea48b099c7e0784db38c41fcb44b0))
* **RQ-PHX-EMAILBATCHMIXEDPROOF116:** Batch mixed CLI qualification ([#4906](https://github.com/ashlrai/phantom/issues/4906)) ([4ba0480](https://github.com/ashlrai/phantom/commit/4ba0480ff0e000160aeace382d185297cb1293b3))
* **RQ-PHX-EMAILBATCHREADTRUTH107:** RQ-PHX-EMAILBATCHREADTRUTH107 ([#4792](https://github.com/ashlrai/phantom/issues/4792)) ([f64d689](https://github.com/ashlrai/phantom/commit/f64d6896dc9293b371bef36e0076718d06057ec0))
* **RQ-PHX-EMAILCRASHBATCHPRESERVE103:** RQ-PHX-EMAILCRASHBATCHPRESERVE103 ([#4791](https://github.com/ashlrai/phantom/issues/4791)) ([a314fe1](https://github.com/ashlrai/phantom/commit/a314fe111ba73cfde6de34d4d4fda110494b1e2e))
* **RQ-PHX-EMAILOUTBOXCOVER179:** BRIDGE_NOTES — RQ-PHX-EMAILOUTBOXCOVER179 ([#5167](https://github.com/ashlrai/phantom/issues/5167)) ([96d88fc](https://github.com/ashlrai/phantom/commit/96d88fcf21db44f5052fd6510e86745e80e536f4))
* **RQ-PHX-EMAILREADSOURCE112:** RQ-PHX-EMAILREADSOURCE112 ([#4839](https://github.com/ashlrai/phantom/issues/4839)) ([7ff9a41](https://github.com/ashlrai/phantom/commit/7ff9a412adf1848137c135385f667a801331416b))
* **RQ-PHX-EMAILSINGLECONFIGBOUND115:** Single-email configuration deadline ([#4894](https://github.com/ashlrai/phantom/issues/4894)) ([4287168](https://github.com/ashlrai/phantom/commit/4287168ef04b3a5ecc5874650d224ed71ff0ef76))
* **RQ-PHX-EMAILSINGLEWAITPROOF111:** Handoff: single email await public path ([#4825](https://github.com/ashlrai/phantom/issues/4825)) ([2abb80a](https://github.com/ashlrai/phantom/commit/2abb80a0d223c51512b21f3cee23f7da8f08ee4e))
* **RQ-PHX-EMAILSTATUSASK143:** RQ-PHX-EMAILSTATUSASK143 — "Phantom status" over email gets ([#5044](https://github.com/ashlrai/phantom/issues/5044)) ([1c11e8e](https://github.com/ashlrai/phantom/commit/1c11e8edcfd7538280ce66d03eaffeffe75d48b9))
* **RQ-PHX-EMAILSTATUSCLOCK145:** Email fleet status clock recovery ([#5048](https://github.com/ashlrai/phantom/issues/5048)) ([049fe88](https://github.com/ashlrai/phantom/commit/049fe88f6b8ed8ab2f0f2597f5e064e9cfd31059))
* **RQ-PHX-EMAILSTATUSFRESH149:** BRIDGE_NOTES — RQ-PHX-EMAILSTATUSFRESH149 ([#5064](https://github.com/ashlrai/phantom/issues/5064)) ([b26c030](https://github.com/ashlrai/phantom/commit/b26c03050a55090b9bb0dd30d8b703f39451bcbf))
* **RQ-PHX-EMPTYREASONSOWNERQUALIFY288S:** BRIDGE NOTES — RQ-PHX-EMPTYREASONSOWNERQUALIFY288S ([#5378](https://github.com/ashlrai/phantom/issues/5378)) ([d669b11](https://github.com/ashlrai/phantom/commit/d669b11275a081e2f681a79c826e8fb6b0b48f96))
* **RQ-PHX-EMPTYRETRYOWNERQUALIFY292S:** BRIDGE NOTES — RQ-PHX-EMPTYRETRYOWNERQUALIFY292S ([#5385](https://github.com/ashlrai/phantom/issues/5385)) ([364ce71](https://github.com/ashlrai/phantom/commit/364ce71772dd8175fed5f20a6bfb0a291b5516ff))
* **RQ-PHX-FEEDAWAYDIGEST95:** BRIDGE_NOTES — RQ-PHX-FEEDAWAYDIGEST95 ([#4795](https://github.com/ashlrai/phantom/issues/4795)) ([9f076ee](https://github.com/ashlrai/phantom/commit/9f076eeab92f10827bdd919e07012198b35ecc6c))
* **RQ-PHX-FEEDMERGEBURST117:** Feed merge bursts ([#4915](https://github.com/ashlrai/phantom/issues/4915)) ([1ad46a4](https://github.com/ashlrai/phantom/commit/1ad46a47d3586dae15cc2e19b57561d5a4b19679))
* **RQ-PHX-FEEDMUTEKIND97:** Feed mute-by-kind: item overflow actions persist kinds in th ([#4793](https://github.com/ashlrai/phantom/issues/4793)) ([1400342](https://github.com/ashlrai/phantom/commit/1400342ca5ab26a355a17d1bd1f0e61b8eb88209))
* **RQ-PHX-FEEDNAVUNREAD91:** Feed navigation badge uses the Feed's shared query keys, sou ([#4794](https://github.com/ashlrai/phantom/issues/4794)) ([1295498](https://github.com/ashlrai/phantom/commit/129549807560d7dd56f8c0e73efd0f625362c698))
* **RQ-PHX-FEEDTELLLEADER91:** Bridge notes ([#4803](https://github.com/ashlrai/phantom/issues/4803)) ([73b1cb5](https://github.com/ashlrai/phantom/commit/73b1cb5baaf14cbfff29988cffdfe57a78adad24))
* **RQ-PHX-FINDINGSORIGINALRECONCILE268S:** BRIDGE_NOTES — RQ-PHX-FINDINGSORIGINALRECONCILE268S ([#5358](https://github.com/ashlrai/phantom/issues/5358)) ([5732da1](https://github.com/ashlrai/phantom/commit/5732da186ae7897acc54eef820758d09a3a06495))
* **RQ-PHX-FIRSTRUNEMPTYRUNS100:** First-run empty runs guard — incomplete ([#4800](https://github.com/ashlrai/phantom/issues/4800)) ([72c99d5](https://github.com/ashlrai/phantom/commit/72c99d5e5da73f97e8c2b55b64e8db334a875052))
* **RQ-PHX-FLEETRESERVESVERB111:** BRIDGE_NOTES — RQ-PHX-FLEETRESERVESVERB111 ([#4826](https://github.com/ashlrai/phantom/issues/4826)) ([8852aaa](https://github.com/ashlrai/phantom/commit/8852aaa9710b09abf9a31d244284198046343658))
* **RQ-PHX-FLEETSTATUSDIGEST143:** Serves Mason: Phantom status for agents ([#5039](https://github.com/ashlrai/phantom/issues/5039)) ([3d7bb17](https://github.com/ashlrai/phantom/commit/3d7bb17668229d585d0bd067ee2a6361779cb1d6))
* **RQ-PHX-GMAILAPISAMPLESCOPE120:** Gmail API sample evidence ([#4926](https://github.com/ashlrai/phantom/issues/4926)) ([e93c18f](https://github.com/ashlrai/phantom/commit/e93c18f40c0b9e1ca3cfbc47d6b237689423161a))
* **RQ-PHX-GMAILARCHIVEMCPSCOPE120:** BRIDGE_NOTES — RQ-PHX-GMAILARCHIVEMCPSCOPE120 ([#4927](https://github.com/ashlrai/phantom/issues/4927)) ([951d8f0](https://github.com/ashlrai/phantom/commit/951d8f0e1b4382abb0d4263b0d8799cad063df0b))
* **RQ-PHX-GMAILARCHIVEOVER100118:** BRIDGE_NOTES — RQ-PHX-GMAILARCHIVEOVER100118 ([#4921](https://github.com/ashlrai/phantom/issues/4921)) ([3135532](https://github.com/ashlrai/phantom/commit/3135532f2e411254ef8c30f1f6d613b545de4772))
* **RQ-PHX-GMAILARCHIVESTATUSSCOPE129:** Gmail archive scope handoff ([#4984](https://github.com/ashlrai/phantom/issues/4984)) ([920b67b](https://github.com/ashlrai/phantom/commit/920b67b94a98fb49f4418a603a8248476de19c08))
* **RQ-PHX-GMAILBATCHDRAFTINDEX122:** Gmail batch draft index ([#4936](https://github.com/ashlrai/phantom/issues/4936)) ([4d58bf5](https://github.com/ashlrai/phantom/commit/4d58bf56db84f711b40090c2ab340cdde19d838f))
* **RQ-PHX-GMAILCARDSCOPE121:** RQ-PHX-GMAILCARDSCOPE121 ([#4931](https://github.com/ashlrai/phantom/issues/4931)) ([4349acf](https://github.com/ashlrai/phantom/commit/4349acf0af96d3e6b87e7332aaaa9ccd5a33a5e9))
* **RQ-PHX-GMAILMCPBOTH124:** BRIDGE_NOTES: RQ-PHX-GMAILMCPBOTH124 ([#4950](https://github.com/ashlrai/phantom/issues/4950)) ([075c345](https://github.com/ashlrai/phantom/commit/075c345db2faf7213a6d53535ba4079fd22ed3f2))
* **RQ-PHX-GMAILPLANINBOXJOIN104:** Gmail archive plan concurrent writers ([#4801](https://github.com/ashlrai/phantom/issues/4801)) ([4c506db](https://github.com/ashlrai/phantom/commit/4c506dbf686dcc4016603ddd744bee6881524948))
* **RQ-PHX-GMAILPLANMCPROUNDTRIP108:** Gmail archive plan CLI-to-MCP round trip ([#4799](https://github.com/ashlrai/phantom/issues/4799)) ([eef781a](https://github.com/ashlrai/phantom/commit/eef781a0744ddde04f5bd3ff6e0478f47c22cdd2))
* **RQ-PHX-GMAILPLANSCOPESAVE127:** Gmail archive plan scope handoff ([#4968](https://github.com/ashlrai/phantom/issues/4968)) ([861c645](https://github.com/ashlrai/phantom/commit/861c645a881d3215a49b4b0fadf6d01a92943f89))
* **RQ-PHX-GMAILREPLAYDRAFT104:** Gmail draft replay handoff ([#4802](https://github.com/ashlrai/phantom/issues/4802)) ([5c890c6](https://github.com/ashlrai/phantom/commit/5c890c62765fda1340f52e3842a4137b33901a5e))
* **RQ-PHX-GMAILSAVEDSCOPE123:** BRIDGE_NOTES — RQ-PHX-GMAILSAVEDSCOPE123 ([#4948](https://github.com/ashlrai/phantom/issues/4948)) ([8852239](https://github.com/ashlrai/phantom/commit/8852239e4cfb5f4c1037b3f5b9c684a594388ca8))
* **RQ-PHX-GMAILSTATUS122:** BRIDGE_NOTES — RQ-PHX-GMAILSTATUS122 ([#4938](https://github.com/ashlrai/phantom/issues/4938)) ([2812d81](https://github.com/ashlrai/phantom/commit/2812d81d39b8e040223698816231965af3bd9353))
* **RQ-PHX-GMAILSTATUSBOTH123:** Gmail status evidence handoff ([#4943](https://github.com/ashlrai/phantom/issues/4943)) ([9abfaf5](https://github.com/ashlrai/phantom/commit/9abfaf50273b7a4898bfedf40c11ab1de103b2e2))
* **RQ-PHX-GMAILSTATUSSCOPE127:** Gmail status scope handoff ([#4969](https://github.com/ashlrai/phantom/issues/4969)) ([d861b9f](https://github.com/ashlrai/phantom/commit/d861b9f4aedf66a16aec4936fb70dd8ea3f528b0))
* **RQ-PHX-GMAILTRIAGEBOTH121:** BRIDGE_NOTES — RQ-PHX-GMAILTRIAGEBOTH121 ([#4932](https://github.com/ashlrai/phantom/issues/4932)) ([0e74ff0](https://github.com/ashlrai/phantom/commit/0e74ff043105da9ed96025cc3ddaf7f5c3ea9539))
* **RQ-PHX-GMAILTRIAGEPERSIST119:** BRIDGE_NOTES — RQ-PHX-GMAILTRIAGEPERSIST119 ([#4923](https://github.com/ashlrai/phantom/issues/4923)) ([14470a7](https://github.com/ashlrai/phantom/commit/14470a7174fe98a79c65e510764304485ec21651))
* **RQ-PHX-GMAILTRIAGESAMPLETRUTH118:** Gmail triage sample truth ([#4919](https://github.com/ashlrai/phantom/issues/4919)) ([97a4268](https://github.com/ashlrai/phantom/commit/97a42685a60b034bd74bd977bb70cc5370bc2588))
* **RQ-PHX-GMAILTRIAGESCAN121:** BRIDGE_NOTES — RQ-PHX-GMAILTRIAGESCAN121 ([#4930](https://github.com/ashlrai/phantom/issues/4930)) ([499f528](https://github.com/ashlrai/phantom/commit/499f5282b95fe1c4c2ccd77cd77effee2a4e3035))
* **RQ-PHX-GOALADDDESK92:** BRIDGE_NOTES — RQ-PHX-GOALADDDESK92: Mason can add a goal fr ([#4809](https://github.com/ashlrai/phantom/issues/4809)) ([79c37cf](https://github.com/ashlrai/phantom/commit/79c37cf52d64ff57a76029da214eaf66067cb292))
* **RQ-PHX-HANDOFFAPISTATEPROOF10SSL2:** Library handoff API boundary ([#4805](https://github.com/ashlrai/phantom/issues/4805)) ([92666e5](https://github.com/ashlrai/phantom/commit/92666e5efb0b950a23f9c004f54aea0e3466e6c1))
* **RQ-PHX-HANDOFFEXITCLEAN116:** BRIDGE_NOTES — RQ-PHX-HANDOFFEXITCLEAN116 ([#4914](https://github.com/ashlrai/phantom/issues/4914)) ([61c97fb](https://github.com/ashlrai/phantom/commit/61c97fb6aa721df1fd747b6084fd91dfa90c7472))
* **RQ-PHX-HANDOFFLIBRARY86:** RQ-PHX-HANDOFFLIBRARY86 ([#4746](https://github.com/ashlrai/phantom/issues/4746)) ([117e960](https://github.com/ashlrai/phantom/commit/117e960ea30fb6d75b791dfafea2556d4e39ab85))
* **RQ-PHX-HANDOFFPIPEE2EPROOF110:** Handoff pipe public round trip ([#4806](https://github.com/ashlrai/phantom/issues/4806)) ([7a30517](https://github.com/ashlrai/phantom/commit/7a30517a9fcf4501ea293a2e31e2894b74825b24))
* **RQ-PHX-HANDOFFPIPEPROCESSCANCEL114:** Handoff pipe process cancellation ([#4881](https://github.com/ashlrai/phantom/issues/4881)) ([a499f81](https://github.com/ashlrai/phantom/commit/a499f81e3d6b47c5f056b03f6a0fceb0c6b1857d))
* **RQ-PHX-HANDOFFPREFIXPRESERVE10SSH1:** Handoff prefix preservation ([#4807](https://github.com/ashlrai/phantom/issues/4807)) ([e809257](https://github.com/ashlrai/phantom/commit/e809257a3131bd2765ce13c6da137190b1c359d7))
* **RQ-PHX-HANDOFFREAD86:** RQ-PHX-HANDOFFREAD86 — Phantom reads the agent handoff folde ([#4747](https://github.com/ashlrai/phantom/issues/4747)) ([8466a4c](https://github.com/ashlrai/phantom/commit/8466a4c6bb1b7616ad19a74dd8b4633ccd9c5d44))
* **RQ-PHX-HANDOFFREADTRUTH10SSI1:** Implemented typed handoff read outcomes, retaining successfu ([#4808](https://github.com/ashlrai/phantom/issues/4808)) ([a6d3e0f](https://github.com/ashlrai/phantom/commit/a6d3e0f9dad93289d5887d8b46ca988ef7db0f3c))
* **RQ-PHX-HANDOFFRECEIVEDEADLINE10SSB1:** BRIDGE_NOTES — RQ-PHX-HANDOFFRECEIVEDEADLINE10SSB1 ([#4766](https://github.com/ashlrai/phantom/issues/4766)) ([b4df332](https://github.com/ashlrai/phantom/commit/b4df3321d4a8241e709e1b3e3a3ff137aa906bec))
* **RQ-PHX-HANDOFFRECEIVESIGNAL115:** Handoff receive cancellation ([#4893](https://github.com/ashlrai/phantom/issues/4893)) ([a3a831d](https://github.com/ashlrai/phantom/commit/a3a831db0e254e82356241a886ffd14b4aec96d4))
* **RQ-PHX-HANDOFFRECEIVETIMEOUT113:** Handoff receive deadline qualification ([#4847](https://github.com/ashlrai/phantom/issues/4847)) ([5e7a874](https://github.com/ashlrai/phantom/commit/5e7a874d9d576548b81cbe74d4a2820cfa414012))
* **RQ-PHX-HANDOFFREPLYCLICANCEL112:** Bridge notes ([#4835](https://github.com/ashlrai/phantom/issues/4835)) ([34f37ef](https://github.com/ashlrai/phantom/commit/34f37ef4b35bab430892cbe1a7f748c840e29e80))
* **RQ-PHX-HANDOFFREPLYCONTROL10SSG1:** Handoff reply execution controls ([#4812](https://github.com/ashlrai/phantom/issues/4812)) ([1330903](https://github.com/ashlrai/phantom/commit/13309036bd9c7e9b42865161de5ab71f3e93e91d))
* **RQ-PHX-HANDOFFREPLYPAGE10SSJ2:** Source: 7df631c382fa58e5d374136769230ec180594095 (origin/mas ([#4810](https://github.com/ashlrai/phantom/issues/4810)) ([42202ec](https://github.com/ashlrai/phantom/commit/42202eca841ec628cdd67cac5ea774d8b9cded15))
* **RQ-PHX-HANDOFFRETRYCONCURRENT10SSK2:** Handoff concurrent retry evidence ([#4811](https://github.com/ashlrai/phantom/issues/4811)) ([c360198](https://github.com/ashlrai/phantom/commit/c3601985a8c94720f169272b5fd1f241ae3dbcf5))
* **RQ-PHX-HANDOFFRETRYPROOF88:** Handoff retry proof 88 ([#4757](https://github.com/ashlrai/phantom/issues/4757)) ([95ee979](https://github.com/ashlrai/phantom/commit/95ee979aa6490e7e94120df27759b5e9b6ac2f00))
* **RQ-PHX-HANDOFFRUNCANCEL10SSB2:** Handoff worker cancellation ([#4765](https://github.com/ashlrai/phantom/issues/4765)) ([cc0dc6f](https://github.com/ashlrai/phantom/commit/cc0dc6f5833be8b5a333e123dbe81262ad4011b3))
* **RQ-PHX-HANDOFFRUNCLICANCEL111:** BRIDGE NOTES — RQ-PHX-HANDOFFRUNCLICANCEL111 ([#4830](https://github.com/ashlrai/phantom/issues/4830)) ([79be566](https://github.com/ashlrai/phantom/commit/79be56644beadf38149d238b82f99cf3336d4a95))
* **RQ-PHX-HANDOFFSENDCONTRACT10SSC1:** Handoff send receiver contract ([#4770](https://github.com/ashlrai/phantom/issues/4770)) ([42a385c](https://github.com/ashlrai/phantom/commit/42a385c578f2f84857107eac354c95d87d5b27e5))
* **RQ-PHX-HANDOFFSPOOLTTL10SSC2:** BRIDGE_NOTES — RQ-PHX-HANDOFFSPOOLTTL10SSC2 ([#4777](https://github.com/ashlrai/phantom/issues/4777)) ([34ea67b](https://github.com/ashlrai/phantom/commit/34ea67b8595829c061bc90af98b90a7fe33dd8e0))
* **RQ-PHX-HEADLESSCLIPRESERVE225S:** BRIDGE_NOTES — RQ-PHX-HEADLESSCLIPRESERVE225S ([#5310](https://github.com/ashlrai/phantom/issues/5310)) ([8401844](https://github.com/ashlrai/phantom/commit/8401844444d48575978c2c6d194f8912e25a6f12))
* **RQ-PHX-IDEANOTNOW94:** BRIDGE_NOTES — RQ-PHX-IDEANOTNOW94 ([#4814](https://github.com/ashlrai/phantom/issues/4814)) ([682f7c2](https://github.com/ashlrai/phantom/commit/682f7c2da4be0c167ce74beac348e7e22a5ce250))
* **RQ-PHX-IDEASAPIPRESERVE191S:** BRIDGE_NOTES — RQ-PHX-IDEASAPIPRESERVE191S ([#5213](https://github.com/ashlrai/phantom/issues/5213)) ([1e385a0](https://github.com/ashlrai/phantom/commit/1e385a0210427ea77ca89d86dd7b3f2318701920))
* **RQ-PHX-IMSGMAILBOXDEDUPE138:** BRIDGE_NOTES — RQ-PHX-IMSGMAILBOXDEDUPE138 ([#5019](https://github.com/ashlrai/phantom/issues/5019)) ([a8ffcc6](https://github.com/ashlrai/phantom/commit/a8ffcc6caae9682a2228aca0ef0a860d18f72279))
* **RQ-PHX-IMSGOWNERQUALIFY293S:** BRIDGE NOTES — RQ-PHX-IMSGOWNERQUALIFY293S ([#5388](https://github.com/ashlrai/phantom/issues/5388)) ([3bca242](https://github.com/ashlrai/phantom/commit/3bca242c924e05da894460569cf04ea4dd8dba0c))
* **RQ-PHX-IMSGSTATUSASK143:** BRIDGE_NOTES — RQ-PHX-IMSGSTATUSASK143 ([#5043](https://github.com/ashlrai/phantom/issues/5043)) ([4a4f039](https://github.com/ashlrai/phantom/commit/4a4f0395036b9551a39293b919479340483bf9b8))
* **RQ-PHX-INBOXFLAGNOISE85:** RQ-PHX-INBOXFLAGNOISE85 ([#4738](https://github.com/ashlrai/phantom/issues/4738)) ([18e41e5](https://github.com/ashlrai/phantom/commit/18e41e5038c9f2c3a7fa25b7ec138728197693a1))
* **RQ-PHX-INTENTFAILUREPRESERVE231S:** BRIDGE_NOTES — RQ-PHX-INTENTFAILUREPRESERVE231S ([#5318](https://github.com/ashlrai/phantom/issues/5318)) ([74d7437](https://github.com/ashlrai/phantom/commit/74d74379bf2c9214f8d1373101858ef5175c86e4))
* **RQ-PHX-INTENTLINKSERIAL10SRY2:** Intent link preservation ([#4737](https://github.com/ashlrai/phantom/issues/4737)) ([2ff826a](https://github.com/ashlrai/phantom/commit/2ff826ab843977265295d405fc07a3c8ed8f9f40))
* **RQ-PHX-INTENTMERGEDTRANSACTION10SSA1:** BRIDGE_NOTES — RQ-PHX-INTENTMERGEDTRANSACTION10SSA1 ([#4752](https://github.com/ashlrai/phantom/issues/4752)) ([0888261](https://github.com/ashlrai/phantom/commit/08882616bbd7ce48236014a38b8f087b7035b952))
* **RQ-PHX-INTENTMERGEOBSERVEPRESERVE231S:** BRIDGE_NOTES — RQ-PHX-INTENTMERGEOBSERVEPRESERVE231S ([#5319](https://github.com/ashlrai/phantom/issues/5319)) ([249b4b3](https://github.com/ashlrai/phantom/commit/249b4b3e123fd7bffb9e97908d2f38a7438e57d2))
* **RQ-PHX-INTENTSWEEPSERIAL10SRY1:** BRIDGE_NOTES — RQ-PHX-INTENTSWEEPSERIAL10SRY1 ([#4743](https://github.com/ashlrai/phantom/issues/4743)) ([4e9372c](https://github.com/ashlrai/phantom/commit/4e9372c9d5d8f9c0ddfb91b67766d8b336e7719d))
* **RQ-PHX-INTENTWORLDPROOF228S:** BRIDGE_NOTES — RQ-PHX-INTENTWORLDPROOF228S ([#5314](https://github.com/ashlrai/phantom/issues/5314)) ([d4746fb](https://github.com/ashlrai/phantom/commit/d4746fba4ff540515ebe46bb093281cf752b0b4e))
* **RQ-PHX-JOBOVERRUN87:** Bridge notes — RQ-PHX-JOBOVERRUN87 ([#4755](https://github.com/ashlrai/phantom/issues/4755)) ([e74ff8a](https://github.com/ashlrai/phantom/commit/e74ff8a03d81659a55d51585b90b4eb23e7948f6))
* **RQ-PHX-JOBSHEETRUNAGAIN91:** RQ-PHX-JOBSHEETRUNAGAIN91 ([#4816](https://github.com/ashlrai/phantom/issues/4816)) ([06b9276](https://github.com/ashlrai/phantom/commit/06b927612e010bee3d1bba3ead6b6088c548f37b))
* **RQ-PHX-JOBSHEETSTOP89:** Bridge notes ([#4767](https://github.com/ashlrai/phantom/issues/4767)) ([6aaf34c](https://github.com/ashlrai/phantom/commit/6aaf34c707329999fbf589eba5ad1136b1d874f7))
* **RQ-PHX-LANEHOLDTHREAD87:** BRIDGE_NOTES — RQ-PHX-LANEHOLDTHREAD87 ([#4753](https://github.com/ashlrai/phantom/issues/4753)) ([085b292](https://github.com/ashlrai/phantom/commit/085b292a6c605fa7f2bc9bcc26dd96a7c005b4ee))
* **RQ-PHX-LANELABELALL89:** Bridge notes ([#4764](https://github.com/ashlrai/phantom/issues/4764)) ([811b239](https://github.com/ashlrai/phantom/commit/811b239884e65b33fe00f8b409538b124ee1d19b))
* **RQ-PHX-LANEPICKWHY85:** RQ-PHX-LANEPICKWHY85 ([#4739](https://github.com/ashlrai/phantom/issues/4739)) ([902afb1](https://github.com/ashlrai/phantom/commit/902afb134096dab12da0d9f8c441b6f9746b1d44))
* **RQ-PHX-LANESTATEORIGINAL207S:** BRIDGE_NOTES: RQ-PHX-LANESTATEORIGINAL207S ([#5269](https://github.com/ashlrai/phantom/issues/5269)) ([bd3a208](https://github.com/ashlrai/phantom/commit/bd3a2087b9d79c3417ab4261f246ac14726efd48))
* **RQ-PHX-LEADERARCHIVEUNIQUE148:** BRIDGE_NOTES — RQ-PHX-LEADERARCHIVEUNIQUE148 ([#5060](https://github.com/ashlrai/phantom/issues/5060)) ([341e04f](https://github.com/ashlrai/phantom/commit/341e04f1a6c04e7d6b5e445e3a861f76e60640a5))
* **RQ-PHX-LEADERBOARDORIGINAL269S:** BRIDGE_NOTES — RQ-PHX-LEADERBOARDORIGINAL269S ([#5359](https://github.com/ashlrai/phantom/issues/5359)) ([26e6473](https://github.com/ashlrai/phantom/commit/26e6473b79d27d124e5cb2d4d6f56677f17261a2))
* **RQ-PHX-LEADERHISTORYPAGE143:** RQ-PHX-LEADERHISTORYPAGE143 ([#5040](https://github.com/ashlrai/phantom/issues/5040)) ([4c34313](https://github.com/ashlrai/phantom/commit/4c343138c656ad242c77d1740ca6e5279a28487a))
* **RQ-PHX-LEADERPUSHCLIENT194S:** Leader thread push recovery ([#5222](https://github.com/ashlrai/phantom/issues/5222)) ([33e7d64](https://github.com/ashlrai/phantom/commit/33e7d6436b072fbb6607fcb38658f8733caf6a90))
* **RQ-PHX-LEADERREPLYPRESERVE220S:** BRIDGE_NOTES — RQ-PHX-LEADERREPLYPRESERVE220S ([#5304](https://github.com/ashlrai/phantom/issues/5304)) ([de43b4d](https://github.com/ashlrai/phantom/commit/de43b4dd29aea7e156916fd213af62a572cae868))
* **RQ-PHX-LEADERROLLUPFRESH147:** Leader rollup freshness handoff ([#5053](https://github.com/ashlrai/phantom/issues/5053)) ([fed0dc2](https://github.com/ashlrai/phantom/commit/fed0dc299bf2681730cfe05372e677ef23aab7c3))
* **RQ-PHX-LEADERROLLUPUNKNOWN142:** Leader status rollup evidence ([#5035](https://github.com/ashlrai/phantom/issues/5035)) ([761156f](https://github.com/ashlrai/phantom/commit/761156ff58e0dcc84f964dfc77898a5394c3cb78))
* **RQ-PHX-LIBRARYMEDIA119:** RQ-PHX-LIBRARYMEDIA119 ([#4924](https://github.com/ashlrai/phantom/issues/4924)) ([8cb3445](https://github.com/ashlrai/phantom/commit/8cb34456a809c3011b072ebef3210ab557fec297))
* **RQ-PHX-LIBRARYMEMORYORIGINAL257S:** BRIDGE_NOTES — RQ-PHX-LIBRARYMEMORYORIGINAL257S ([#5347](https://github.com/ashlrai/phantom/issues/5347)) ([6135077](https://github.com/ashlrai/phantom/commit/613507798a5c0d41bac346c5afe032bcf95a1b88))
* **RQ-PHX-LIBRARYPINSAPIRECOVER249S:** BRIDGE_NOTES — RQ-PHX-LIBRARYPINSAPIRECOVER249S ([#5339](https://github.com/ashlrai/phantom/issues/5339)) ([49db54c](https://github.com/ashlrai/phantom/commit/49db54c527c221d5ff23c12534d0d65517c1fb68))
* **RQ-PHX-LOCALMAILBOXSALVAGE146:** BRIDGE_NOTES: RQ-PHX-LOCALMAILBOXSALVAGE146 ([#5050](https://github.com/ashlrai/phantom/issues/5050)) ([c872046](https://github.com/ashlrai/phantom/commit/c872046e60f0d5d6525dc0959d69d0cec31800f5))
* **RQ-PHX-LOOPBENCHORIGINAL277S:** BRIDGE_NOTES — RQ-PHX-LOOPBENCHORIGINAL277S ([#5365](https://github.com/ashlrai/phantom/issues/5365)) ([5bb65e5](https://github.com/ashlrai/phantom/commit/5bb65e5adb0c8629b950c8b9b2e24265184eaccc))
* **RQ-PHX-MAILBOXEXACTRECUT157:** BRIDGE_NOTES: RQ-PHX-MAILBOXEXACTRECUT157 ([#5088](https://github.com/ashlrai/phantom/issues/5088)) ([de12788](https://github.com/ashlrai/phantom/commit/de127887c987d90f66d4d8d43825dc0382dd4523))
* **RQ-PHX-MCPATTRIBUTIONRECOVER195S:** BRIDGE_NOTES — RQ-PHX-MCPATTRIBUTIONRECOVER195S ([#5228](https://github.com/ashlrai/phantom/issues/5228)) ([2e5a671](https://github.com/ashlrai/phantom/commit/2e5a671a84dfc1878ac2e6cdca2e71a773565f08))
* **RQ-PHX-MCPPROVENANCERECOVER130:** BRIDGE_NOTES — RQ-PHX-MCPPROVENANCERECOVER130 ([#4988](https://github.com/ashlrai/phantom/issues/4988)) ([4e5b3d1](https://github.com/ashlrai/phantom/commit/4e5b3d1c8a21412bc7ab474ee61279ba1ce4aad4))
* **RQ-PHX-MCPVERBSPRESERVE152:** BRIDGE_NOTES — RQ-PHX-MCPVERBSPRESERVE152 ([#5071](https://github.com/ashlrai/phantom/issues/5071)) ([ac355d6](https://github.com/ashlrai/phantom/commit/ac355d6f9b0ce4879917ae27b02307f3cc28c3d4))
* **RQ-PHX-MDOPENERCOVER185S:** BRIDGE_NOTES — RQ-PHX-MDOPENERCOVER185S ([#5190](https://github.com/ashlrai/phantom/issues/5190)) ([402845d](https://github.com/ashlrai/phantom/commit/402845de07e575d790673c12a7df119971807757))
* **RQ-PHX-MERGEPLANORIGINAL202S:** BRIDGE_NOTES — RQ-PHX-MERGEPLANORIGINAL202S ([#5247](https://github.com/ashlrai/phantom/issues/5247)) ([785f88e](https://github.com/ashlrai/phantom/commit/785f88ec2da8ae805bf13f6b3d0162f9f1b8e855))
* **RQ-PHX-NATIVEEVIDENCERECONCILE235S:** BRIDGE_NOTES — RQ-PHX-NATIVEEVIDENCERECONCILE235S ([#5323](https://github.com/ashlrai/phantom/issues/5323)) ([0c08289](https://github.com/ashlrai/phantom/commit/0c08289393d02aff340c6960eb5df48e2e8ba8fa))
* **RQ-PHX-NATIVEREADOWNERQUALIFY291S:** RQ-PHX-NATIVEREADOWNERQUALIFY291S — Bridge Notes ([#5383](https://github.com/ashlrai/phantom/issues/5383)) ([0081e87](https://github.com/ashlrai/phantom/commit/0081e8738c4923d58fb70dce1022d67d80d3377b))
* **RQ-PHX-OWNERLIVENOTICERECOVER171:** BRIDGE_NOTES — RQ-PHX-OWNERLIVENOTICERECOVER171 ([#5134](https://github.com/ashlrai/phantom/issues/5134)) ([56456a0](https://github.com/ashlrai/phantom/commit/56456a09bf8065833eea0655d51815ddeb847892))
* **RQ-PHX-OWNERLIVESTAGEQUALIFY287S:** BRIDGE NOTES — RQ-PHX-OWNERLIVESTAGEQUALIFY287S ([#5377](https://github.com/ashlrai/phantom/issues/5377)) ([22cfd44](https://github.com/ashlrai/phantom/commit/22cfd44d6533cef136bc6737516f4bc152c09e4b))
* **RQ-PHX-OWNERREADORIGINAL254S:** BRIDGE_NOTES — RQ-PHX-OWNERREADORIGINAL254S ([#5344](https://github.com/ashlrai/phantom/issues/5344)) ([16fdac3](https://github.com/ashlrai/phantom/commit/16fdac3e7c4fe022ad95c433a93da1da9b75bc32))
* **RQ-PHX-OWNERTHREADORIGINAL248S:** BRIDGE_NOTES — RQ-PHX-OWNERTHREADORIGINAL248S ([#5338](https://github.com/ashlrai/phantom/issues/5338)) ([1982fb5](https://github.com/ashlrai/phantom/commit/1982fb5a8eb5550f88e6ec0e8db5e43f6c7d2fd8))
* **RQ-PHX-PACEREADBOUNDED138:** Bound status file reads to 1 MiB plus one sentinel byte, dec ([#5018](https://github.com/ashlrai/phantom/issues/5018)) ([7812232](https://github.com/ashlrai/phantom/commit/7812232a0c9ba406e987c6b61df7532b8dacf9b4))
* **RQ-PHX-PALETTEALLPANES97:** Palette panes ([#4818](https://github.com/ashlrai/phantom/issues/4818)) ([c3775e8](https://github.com/ashlrai/phantom/commit/c3775e86830ee36e9ee37e7dd7ba8fc6e9beee06))
* **RQ-PHX-PANELINKCHAT108:** Bridge notes ([#4819](https://github.com/ashlrai/phantom/issues/4819)) ([820f296](https://github.com/ashlrai/phantom/commit/820f296bc8fc93f043705284a839ddd234e84f6e))
* **RQ-PHX-PATCHANNOUNCEORIGINAL262S:** BRIDGE_NOTES — RQ-PHX-PATCHANNOUNCEORIGINAL262S ([#5352](https://github.com/ashlrai/phantom/issues/5352)) ([60eedaa](https://github.com/ashlrai/phantom/commit/60eedaaea6a7cca36dd7e136c768cfdc8063084e))
* **RQ-PHX-PATCHARTIFACT131:** BRIDGE_NOTES — RQ-PHX-PATCHARTIFACT131 ([#4991](https://github.com/ashlrai/phantom/issues/4991)) ([d3aeffa](https://github.com/ashlrai/phantom/commit/d3aeffa50e89d9dcfa9ce756dc204f4a368e537c))
* **RQ-PHX-PATCHCOVERPRESERVE155:** RQ-PHX-PATCHCOVERPRESERVE155 ([#5081](https://github.com/ashlrai/phantom/issues/5081)) ([3c9ddde](https://github.com/ashlrai/phantom/commit/3c9ddde844e2882bd8468d9aa2d86744c8be5146))
* **RQ-PHX-PHONEGOALSIDEAS106:** BRIDGE_NOTES — RQ-PHX-PHONEGOALSIDEAS106 ([#4824](https://github.com/ashlrai/phantom/issues/4824)) ([eb13ea9](https://github.com/ashlrai/phantom/commit/eb13ea9ad90e1158d840b157ce97fa23812a6cac))
* **RQ-PHX-PHONELEADERPUSH107:** Phone Leader push ([#4823](https://github.com/ashlrai/phantom/issues/4823)) ([5cd74ad](https://github.com/ashlrai/phantom/commit/5cd74ad39a7d38058a1b90e18b0cc78a4907c4d8))
* **RQ-PHX-PLANNERSTATUSASKS101:** RQ-PHX-PLANNERSTATUSASKS101 ([#4829](https://github.com/ashlrai/phantom/issues/4829)) ([ed7a11a](https://github.com/ashlrai/phantom/commit/ed7a11aa0d44606c64f8e70358e4515a1b6eb80f))
* **RQ-PHX-PROFILECLIRECOVER133:** BRIDGE_NOTES — RQ-PHX-PROFILECLIRECOVER133 ([#4997](https://github.com/ashlrai/phantom/issues/4997)) ([fb8e641](https://github.com/ashlrai/phantom/commit/fb8e64188c84d069f1ada5387203612fdf1adb22))
* **RQ-PHX-PROFILEHISTORYRECOVER132:** BRIDGE_NOTES — RQ-PHX-PROFILEHISTORYRECOVER132 ([#4994](https://github.com/ashlrai/phantom/issues/4994)) ([5c08c30](https://github.com/ashlrai/phantom/commit/5c08c304f7f515067176e1ebeef4bda380a94a32))
* **RQ-PHX-QUEUEDEPTHLINE84:** BRIDGE_NOTES — RQ-PHX-QUEUEDEPTHLINE84 ([#4736](https://github.com/ashlrai/phantom/issues/4736)) ([34610d8](https://github.com/ashlrai/phantom/commit/34610d8525b73735b9ea5eefd4ffe7270b801f02))
* **RQ-PHX-QUEUEHIERARCHYPRESERVE201S:** Queue hierarchy preservation bridge ([#5249](https://github.com/ashlrai/phantom/issues/5249)) ([73324fb](https://github.com/ashlrai/phantom/commit/73324fbaa5d8460afac3f1e0026e7bf50d445c6e))
* **RQ-PHX-QUEUELINTORIGINAL247S:** BRIDGE_NOTES — RQ-PHX-QUEUELINTORIGINAL247S ([#5336](https://github.com/ashlrai/phantom/issues/5336)) ([800a5c4](https://github.com/ashlrai/phantom/commit/800a5c456a0da64b966a208774fa860a6f2ba61d))
* **RQ-PHX-QUEUEROWPRESERVE210S:** BRIDGE_NOTES — RQ-PHX-QUEUEROWPRESERVE210S ([#5277](https://github.com/ashlrai/phantom/issues/5277)) ([888e32e](https://github.com/ashlrai/phantom/commit/888e32ee0ce5786953b3fede392b14859aa40693))
* **RQ-PHX-QUIETHOURSORIGINAL236S:** BRIDGE_NOTES — RQ-PHX-QUIETHOURSORIGINAL236S ([#5324](https://github.com/ashlrai/phantom/issues/5324)) ([78c0eed](https://github.com/ashlrai/phantom/commit/78c0eedc86406a238eb1d34f7ef813b1de772f3a))
* **RQ-PHX-REBASECLUSTERORIGINAL273S:** BRIDGE_NOTES — RQ-PHX-REBASECLUSTERORIGINAL273S ([#5361](https://github.com/ashlrai/phantom/issues/5361)) ([33e7b77](https://github.com/ashlrai/phantom/commit/33e7b772163da7633f7497cf44c776ba15bff88a))
* **RQ-PHX-RECONCILECOMMS164:** BRIDGE_NOTES — RQ-PHX-RECONCILECOMMS164 ([#5118](https://github.com/ashlrai/phantom/issues/5118)) ([d3aee71](https://github.com/ashlrai/phantom/commit/d3aee71c7f07059079019032b343952fa4a759f7))
* **RQ-PHX-RECUTCOMMSC157:** BRIDGE_NOTES — RQ-PHX-RECUTCOMMSC157 ([#5092](https://github.com/ashlrai/phantom/issues/5092)) ([c8d1752](https://github.com/ashlrai/phantom/commit/c8d17523efb2560a84a8c98274a88b9c69ac4a70))
* **RQ-PHX-RECUTCOMMSC158:** BRIDGE_NOTES — RQ-PHX-RECUTCOMMSC158 ([#5093](https://github.com/ashlrai/phantom/issues/5093)) ([72cd4ca](https://github.com/ashlrai/phantom/commit/72cd4ca81bd9863c8aef4763b22df55d7d76f877))
* **RQ-PHX-RECUTCOMMSC162:** BRIDGE_NOTES — RQ-PHX-RECUTCOMMSC162 ([#5109](https://github.com/ashlrai/phantom/issues/5109)) ([ce4e230](https://github.com/ashlrai/phantom/commit/ce4e2306747bdd284a04753e9da4ee3beb735a77))
* **RQ-PHX-RECUTCOMMSC170:** BRIDGE_NOTES: RQ-PHX-RECUTCOMMSC170 ([#5131](https://github.com/ashlrai/phantom/issues/5131)) ([55e4b56](https://github.com/ashlrai/phantom/commit/55e4b5667ad61681b4d5d97773b649c4019747e9))
* **RQ-PHX-RECUTCOMMSC174:** BRIDGE_NOTES — RQ-PHX-RECUTCOMMSC174 ([#5147](https://github.com/ashlrai/phantom/issues/5147)) ([f2d6391](https://github.com/ashlrai/phantom/commit/f2d6391e586a4d1be9eaee9ec0f7adfeb5942dbd))
* **RQ-PHX-RECUTCOMMSC175:** BRIDGE_NOTES — RQ-PHX-RECUTCOMMSC175 (slot: comms-newest) ([#5150](https://github.com/ashlrai/phantom/issues/5150)) ([05bd0bc](https://github.com/ashlrai/phantom/commit/05bd0bca9827b13f6faf9ec0777f8e958498d3ed))
* **RQ-PHX-RECUTCOMMSC185:** BRIDGE_NOTES — RQ-PHX-RECUTCOMMSC185 (lane: devin) ([#5191](https://github.com/ashlrai/phantom/issues/5191)) ([eb9b1fd](https://github.com/ashlrai/phantom/commit/eb9b1fd71da31a14feb50ad2f0741bdd58f19a41))
* **RQ-PHX-RECUTCOMMSC194:** BRIDGE_NOTES — RQ-PHX-RECUTCOMMSC194 ([#5225](https://github.com/ashlrai/phantom/issues/5225)) ([ba04024](https://github.com/ashlrai/phantom/commit/ba0402474dc023692ef1366f1022bac7e8bad8df))
* **RQ-PHX-RECUTCOMMSC206:** BRIDGE_NOTES — RQ-PHX-RECUTCOMMSC206 ([#5267](https://github.com/ashlrai/phantom/issues/5267)) ([81021c5](https://github.com/ashlrai/phantom/commit/81021c59d56fd7001957768215a2beddb6fa5ad4))
* **RQ-PHX-RECUTCOMMSN1C155:** RQ-PHX-RECUTCOMMSN1C155 — bridge notes ([#5082](https://github.com/ashlrai/phantom/issues/5082)) ([5a2009b](https://github.com/ashlrai/phantom/commit/5a2009ba634613054497ca4968abc5ab57f53ca7))
* **RQ-PHX-RECUTCOMMSO1S123:** BRIDGE_NOTES — RQ-PHX-RECUTCOMMSO1S123 ([#4952](https://github.com/ashlrai/phantom/issues/4952)) ([86f3526](https://github.com/ashlrai/phantom/commit/86f35267d7a0832ad153383314578e3f287f66ac))
* **RQ-PHX-RECUTCOMMSO1S128:** BRIDGE_NOTES — RQ-PHX-RECUTCOMMSO1S128 ([#4976](https://github.com/ashlrai/phantom/issues/4976)) ([fdbdc65](https://github.com/ashlrai/phantom/commit/fdbdc6562607dcc9773c51cc2f90f4713d2c9356))
* **RQ-PHX-RECUTCOMMSOLDC160:** Recut of [#3511](https://github.com/ashlrai/phantom/issues/3511) ([#5104](https://github.com/ashlrai/phantom/issues/5104)) ([90775e5](https://github.com/ashlrai/phantom/commit/90775e5248a40d9531f549cbff95eb6d68ca0a10))
* **RQ-PHX-RECUTCOMMSOLDC165:** Comms recut handoff ([#5114](https://github.com/ashlrai/phantom/issues/5114)) ([abc4791](https://github.com/ashlrai/phantom/commit/abc47911d82839650f9d4a92d8b6510423e5845b))
* **RQ-PHX-RECUTCOMMSOLDS162:** BRIDGE_NOTES — RQ-PHX-RECUTCOMMSOLDS162 ([#5110](https://github.com/ashlrai/phantom/issues/5110)) ([e6a830b](https://github.com/ashlrai/phantom/commit/e6a830bf92f4e47efc1bb9474e3177962fb905bd))
* **RQ-PHX-RECUTCOREN1C151:** Recut of [#4909](https://github.com/ashlrai/phantom/issues/4909) ([#5069](https://github.com/ashlrai/phantom/issues/5069)) ([b6f4925](https://github.com/ashlrai/phantom/commit/b6f49251a827f9e3d3d4eeff2a249dad1e561280))
* **RQ-PHX-RECUTCOREN1C153:** Recut of [#5058](https://github.com/ashlrai/phantom/issues/5058) ([#5073](https://github.com/ashlrai/phantom/issues/5073)) ([f891d9c](https://github.com/ashlrai/phantom/commit/f891d9cb9df85af279982eac19dab7f9c6a090a1))
* **RQ-PHX-RECUTCOREN1C154:** Recut of [#4851](https://github.com/ashlrai/phantom/issues/4851) ([#5078](https://github.com/ashlrai/phantom/issues/5078)) ([c4e6e5b](https://github.com/ashlrai/phantom/commit/c4e6e5bd91de82323d526e18232d00556d6350a1))
* **RQ-PHX-RECUTCOREN1C156:** Recut of [#4965](https://github.com/ashlrai/phantom/issues/4965) ([#5084](https://github.com/ashlrai/phantom/issues/5084)) ([e1b8336](https://github.com/ashlrai/phantom/commit/e1b8336d1eec2060149e70ffb538e6b4e539ded8))
* **RQ-PHX-RECUTCOREN1S134:** RQ-PHX-RECUTCOREN1S134 ([#5006](https://github.com/ashlrai/phantom/issues/5006)) ([f34dc06](https://github.com/ashlrai/phantom/commit/f34dc06edc134d47a4b32baa6414c4bc8249e842))
* **RQ-PHX-RECUTCOREN2C154:** Recut of [#4851](https://github.com/ashlrai/phantom/issues/4851) ([#5079](https://github.com/ashlrai/phantom/issues/5079)) ([b5281a8](https://github.com/ashlrai/phantom/commit/b5281a8a47826e2baf98b575bb1eaceea048342c))
* **RQ-PHX-RECUTCOREN2S128:** BRIDGE_NOTES — RQ-PHX-RECUTCOREN2S128 ([#4978](https://github.com/ashlrai/phantom/issues/4978)) ([fb3c58c](https://github.com/ashlrai/phantom/commit/fb3c58c60f05715bf4185b8e085e66392c6ca9fb))
* **RQ-PHX-RECUTCOREO1C148:** Recut of [#4685](https://github.com/ashlrai/phantom/issues/4685) ([#5061](https://github.com/ashlrai/phantom/issues/5061)) ([c088fa2](https://github.com/ashlrai/phantom/commit/c088fa2936ce16229799c6edde25d3c7e6c079fb))
* **RQ-PHX-RECUTCOREO1S128:** BRIDGE_NOTES — RQ-PHX-RECUTCOREO1S128 ([#4977](https://github.com/ashlrai/phantom/issues/4977)) ([28e4287](https://github.com/ashlrai/phantom/commit/28e4287662c045b8f4fb7adfbf375015c699f0dc))
* **RQ-PHX-RECUTCOREO1S132:** Recut of [#3162](https://github.com/ashlrai/phantom/issues/3162) ([#5002](https://github.com/ashlrai/phantom/issues/5002)) ([1745b3d](https://github.com/ashlrai/phantom/commit/1745b3dd919a5589af135c31f60b368addbb3da5))
* **RQ-PHX-RECUTCOREO1S136:** BRIDGE_NOTES — RQ-PHX-RECUTCOREO1S136 ([#5015](https://github.com/ashlrai/phantom/issues/5015)) ([857aa96](https://github.com/ashlrai/phantom/commit/857aa9669957a9883317ca059d6181015adf81ac))
* **RQ-PHX-RECUTCOREOLDC160:** Recut of [#3151](https://github.com/ashlrai/phantom/issues/3151) ([#5102](https://github.com/ashlrai/phantom/issues/5102)) ([83088fe](https://github.com/ashlrai/phantom/commit/83088fe26adc9d29cb5b4ae1767ab9a4a187456f))
* **RQ-PHX-RECUTCOREOLDC161:** Recut of [#3231](https://github.com/ashlrai/phantom/issues/3231) ([#5107](https://github.com/ashlrai/phantom/issues/5107)) ([1a68cbf](https://github.com/ashlrai/phantom/commit/1a68cbfaf6b3484ce46883dc68e1df8e87012581))
* **RQ-PHX-RECUTCOREOLDC162:** BRIDGE_NOTES — RQ-PHX-RECUTCOREOLDC162 ([#5112](https://github.com/ashlrai/phantom/issues/5112)) ([108dec2](https://github.com/ashlrai/phantom/commit/108dec2cfc082508e5e08de895150c1f27c3e825))
* **RQ-PHX-RECUTCOREOLDC166:** RQ-PHX-RECUTCOREOLDC166 ([#5116](https://github.com/ashlrai/phantom/issues/5116)) ([5d3eed5](https://github.com/ashlrai/phantom/commit/5d3eed58c5a9b8ee9d5b8f9b3650ea095d10f074))
* **RQ-PHX-RECUTCOREOLDC173:** BRIDGE_NOTES — RQ-PHX-RECUTCOREOLDC173 ([#5142](https://github.com/ashlrai/phantom/issues/5142)) ([58b3cc7](https://github.com/ashlrai/phantom/commit/58b3cc7ecdfae896eda9f19c62046b29a0416b93))
* **RQ-PHX-RECUTCOREOLDC175:** RQ-PHX-RECUTCOREOLDC175 — bridge notes ([#5151](https://github.com/ashlrai/phantom/issues/5151)) ([ea44994](https://github.com/ashlrai/phantom/commit/ea449943f5e8fa337f8fd4db5b8bd4bba56f9f55))
* **RQ-PHX-RECUTCOREOLDC189:** BRIDGE_NOTES — RQ-PHX-RECUTCOREOLDC189 ([#5208](https://github.com/ashlrai/phantom/issues/5208)) ([b3a171f](https://github.com/ashlrai/phantom/commit/b3a171f4e7c3e90d93ecd85b3f16ce5d034533e2))
* **RQ-PHX-RECUTCOREOLDC218:** BRIDGE_NOTES — RQ-PHX-RECUTCOREOLDC218 ([#5299](https://github.com/ashlrai/phantom/issues/5299)) ([2b81d76](https://github.com/ashlrai/phantom/commit/2b81d76036747722d5ed5b3015b49c3d6d35c29e))
* **RQ-PHX-RECUTCORES0C171:** BRIDGE_NOTES — RQ-PHX-RECUTCORES0C171 ([#5135](https://github.com/ashlrai/phantom/issues/5135)) ([ebe0efd](https://github.com/ashlrai/phantom/commit/ebe0efd97418ea3f45344ec644076c682847102c))
* **RQ-PHX-RECUTCORES0C177:** BRIDGE_NOTES — RQ-PHX-RECUTCORES0C177 ([#5159](https://github.com/ashlrai/phantom/issues/5159)) ([b0f22e6](https://github.com/ashlrai/phantom/commit/b0f22e68ae099347875deffb554e219e4428c709))
* **RQ-PHX-RECUTCORES0C184:** BRIDGE_NOTES — RQ-PHX-RECUTCORES0C184 ([#5189](https://github.com/ashlrai/phantom/issues/5189)) ([096ea85](https://github.com/ashlrai/phantom/commit/096ea8500f2784fb166405ad0f75ae6cd477af73))
* **RQ-PHX-RECUTCORES0C188:** RQ-PHX-RECUTCORES0C188 — recut of [#5196](https://github.com/ashlrai/phantom/issues/5196) ([#5201](https://github.com/ashlrai/phantom/issues/5201)) ([3ab0680](https://github.com/ashlrai/phantom/commit/3ab06801920b6f4cba09ac697b64d153c184f871))
* **RQ-PHX-RECUTCORES0C194:** BRIDGE_NOTES — RQ-PHX-RECUTCORES0C194 ([#5226](https://github.com/ashlrai/phantom/issues/5226)) ([f8adad3](https://github.com/ashlrai/phantom/commit/f8adad3d8f7a009cbb90a273ec97c41ba3952393))
* **RQ-PHX-RECUTCORES0C212:** BRIDGE_NOTES — RQ-PHX-RECUTCORES0C212 ([#5281](https://github.com/ashlrai/phantom/issues/5281)) ([a827c4a](https://github.com/ashlrai/phantom/commit/a827c4aee1732212405eceeaaa6df2490ce46902))
* **RQ-PHX-RECUTCORES1C157:** BRIDGE_NOTES — RQ-PHX-RECUTCORES1C157 ([#5090](https://github.com/ashlrai/phantom/issues/5090)) ([24f77af](https://github.com/ashlrai/phantom/commit/24f77aff8aa252d7e518d5c1d9c6d1a0986f1a7a))
* **RQ-PHX-RECUTCORES1C169:** BRIDGE_NOTES — RQ-PHX-RECUTCORES1C169 ([#5128](https://github.com/ashlrai/phantom/issues/5128)) ([2b13d91](https://github.com/ashlrai/phantom/commit/2b13d91ba09aa695500c44652b9cd1457f660f18))
* **RQ-PHX-RECUTCORES1C171:** BRIDGE_NOTES — RQ-PHX-RECUTCORES1C171 (slot: core-second-new ([#5139](https://github.com/ashlrai/phantom/issues/5139)) ([83f110a](https://github.com/ashlrai/phantom/commit/83f110a4b8401befda36c1b625b8f5ebb8b97bf0))
* **RQ-PHX-RECUTCORES1C173:** BRIDGE_NOTES — RQ-PHX-RECUTCORES1C173 ([#5143](https://github.com/ashlrai/phantom/issues/5143)) ([cb510f4](https://github.com/ashlrai/phantom/commit/cb510f4691024787aa850259cec55af75d0776ea))
* **RQ-PHX-RECUTCORES1C175:** RQ-PHX-RECUTCORES1C175 ([#5148](https://github.com/ashlrai/phantom/issues/5148)) ([63b1ed3](https://github.com/ashlrai/phantom/commit/63b1ed31d3d35b69518313fbf7c3fc2e5b8e115b))
* **RQ-PHX-RECUTCORES1C187:** BRIDGE_NOTES — RQ-PHX-RECUTCORES1C187 ([#5198](https://github.com/ashlrai/phantom/issues/5198)) ([5b8b096](https://github.com/ashlrai/phantom/commit/5b8b0960d7e3d559c144cd91733c69272bd31754))
* **RQ-PHX-RECUTDESKN1C151:** Recut of [#5003](https://github.com/ashlrai/phantom/issues/5003) ([#5070](https://github.com/ashlrai/phantom/issues/5070)) ([5809895](https://github.com/ashlrai/phantom/commit/58098959087a9d235b81a7665543ee310f248482))
* **RQ-PHX-RECUTDESKN1S135:** Recut of [#5001](https://github.com/ashlrai/phantom/issues/5001) ([#5010](https://github.com/ashlrai/phantom/issues/5010)) ([06b1934](https://github.com/ashlrai/phantom/commit/06b1934cca5f84c3c808df0917460ef9185f918a))
* **RQ-PHX-RECUTDESKN1S139:** Recut of [#5001](https://github.com/ashlrai/phantom/issues/5001) ([#5023](https://github.com/ashlrai/phantom/issues/5023)) ([fa5ac26](https://github.com/ashlrai/phantom/commit/fa5ac2636297befb2bb79ce7b9d0b49561cb54a8))
* **RQ-PHX-RECUTDESKN2S125:** Recut of [#4457](https://github.com/ashlrai/phantom/issues/4457) ([#4960](https://github.com/ashlrai/phantom/issues/4960)) ([dfa8373](https://github.com/ashlrai/phantom/commit/dfa8373458de844bf7957114255490adb3253399))
* **RQ-PHX-RECUTDESKN2S131:** Recovers [#4382](https://github.com/ashlrai/phantom/issues/4382) (head d2fd31a9586b417f56ca82c305dbfde8ff075ec ([#4992](https://github.com/ashlrai/phantom/issues/4992)) ([156d359](https://github.com/ashlrai/phantom/commit/156d35964b576fa27bb9a244a495010fdbdfd231))
* **RQ-PHX-RECUTDESKN2S139:** Recut of [#4879](https://github.com/ashlrai/phantom/issues/4879) ([#5024](https://github.com/ashlrai/phantom/issues/5024)) ([579d0e7](https://github.com/ashlrai/phantom/commit/579d0e7f4b86acb1bf8647b1d91e50792d70846b))
* **RQ-PHX-RECUTDESKN3S122:** BRIDGE_NOTES — RQ-PHX-RECUTDESKN3S122 ([#4940](https://github.com/ashlrai/phantom/issues/4940)) ([85ea692](https://github.com/ashlrai/phantom/commit/85ea692f7725f55f2d75078b7a0daad2345efb43))
* **RQ-PHX-RECUTDESKO1C152:** RQ-PHX-RECUTDESKO1C152 ([#5072](https://github.com/ashlrai/phantom/issues/5072)) ([8be4ad9](https://github.com/ashlrai/phantom/commit/8be4ad949fcce2bc3125fc3e0671712a3fbb1de2))
* **RQ-PHX-RECUTDESKO1C156:** RQ-PHX-RECUTDESKO1C156 — Recut of [#950](https://github.com/ashlrai/phantom/issues/950) ([#5085](https://github.com/ashlrai/phantom/issues/5085)) ([7c45d06](https://github.com/ashlrai/phantom/commit/7c45d06754e705756c0054ed85c9b8783df79b44))
* **RQ-PHX-RECUTDESKO1S123:** BRIDGE_NOTES: RQ-PHX-RECUTDESKO1S123 ([#4951](https://github.com/ashlrai/phantom/issues/4951)) ([ee91401](https://github.com/ashlrai/phantom/commit/ee914017e5adc1cf9a5be531ff30fc41a6d74575))
* **RQ-PHX-RECUTDESKO1S133:** RQ-PHX-RECUTDESKO1S133 ([#4998](https://github.com/ashlrai/phantom/issues/4998)) ([d4c0e7e](https://github.com/ashlrai/phantom/commit/d4c0e7ef032a8846d827d9f37317d340338d9964))
* **RQ-PHX-RECUTDESKO1S136:** BRIDGE_NOTES — RQ-PHX-RECUTDESKO1S136 ([#5016](https://github.com/ashlrai/phantom/issues/5016)) ([e367b9b](https://github.com/ashlrai/phantom/commit/e367b9bba05d98763da14dc84fd9d5035f891f15))
* **RQ-PHX-RECUTDESKOLDC161:** Recut of [#4553](https://github.com/ashlrai/phantom/issues/4553) ([#5108](https://github.com/ashlrai/phantom/issues/5108)) ([f180889](https://github.com/ashlrai/phantom/commit/f180889bdf4f0b6b7b69d3c8b64852f1ee357ede))
* **RQ-PHX-RECUTDESKOLDC182:** Bridge notes: RQ-PHX-RECUTDESKOLDC182 — recut of [#3918](https://github.com/ashlrai/phantom/issues/3918) (RQ-S ([#5179](https://github.com/ashlrai/phantom/issues/5179)) ([1a50d60](https://github.com/ashlrai/phantom/commit/1a50d6001b8d3628905b6e9918297d5a7a56cfde))
* **RQ-PHX-RECUTDESKOLDC187:** BRIDGE_NOTES — RQ-PHX-RECUTDESKOLDC187 ([#5199](https://github.com/ashlrai/phantom/issues/5199)) ([baa4e83](https://github.com/ashlrai/phantom/commit/baa4e83f0f60c68857512078d9ebb13c5ed0f321))
* **RQ-PHX-RECUTDESKOLDC188:** BRIDGE_NOTES — RQ-PHX-RECUTDESKOLDC188 ([#5202](https://github.com/ashlrai/phantom/issues/5202)) ([6d1d2a2](https://github.com/ashlrai/phantom/commit/6d1d2a23f680197a0a129a1ec3240a1902c96140))
* **RQ-PHX-RECUTDESKOLDC191:** BRIDGE_NOTES — RQ-PHX-RECUTDESKOLDC191 ([#5215](https://github.com/ashlrai/phantom/issues/5215)) ([48792fa](https://github.com/ashlrai/phantom/commit/48792fa14766b2637d86c0233ab7df8f6a4d27cd))
* **RQ-PHX-RECUTDESKOLDC218:** BRIDGE_NOTES — RQ-PHX-RECUTDESKOLDC218 ([#5298](https://github.com/ashlrai/phantom/issues/5298)) ([788ffdc](https://github.com/ashlrai/phantom/commit/788ffdc4fdf6617cc6934eb3f1569338cb0003be))
* **RQ-PHX-RECUTDESKOLDS162:** BRIDGE_NOTES — RQ-PHX-RECUTDESKOLDS162 ([#5111](https://github.com/ashlrai/phantom/issues/5111)) ([fdbde87](https://github.com/ashlrai/phantom/commit/fdbde87165190838f36ce0ec4fb7f505f28f7429))
* **RQ-PHX-RECUTDESKS0C160:** Recut of [#4848](https://github.com/ashlrai/phantom/issues/4848) ([#5100](https://github.com/ashlrai/phantom/issues/5100)) ([0775571](https://github.com/ashlrai/phantom/commit/077557133c7830cf5fc3f127ec393e49f4508bc7))
* **RQ-PHX-RECUTDESKS0C175:** RQ-PHX-RECUTDESKS0C175 — recut of [#4356](https://github.com/ashlrai/phantom/issues/4356) (desk-newest slot) ([#5153](https://github.com/ashlrai/phantom/issues/5153)) ([2483fc1](https://github.com/ashlrai/phantom/commit/2483fc1ac2757b1d579782c8f39fdcef80233f23))
* **RQ-PHX-RECUTDESKS0C185:** BRIDGE_NOTES — RQ-PHX-RECUTDESKS0C185 ([#5193](https://github.com/ashlrai/phantom/issues/5193)) ([bce1b4b](https://github.com/ashlrai/phantom/commit/bce1b4b7aa28d9f1035089827c7eeed45cfc8c76))
* **RQ-PHX-RECUTDESKS0C194:** RQ-PHX-RECUTDESKS0C194 — recut of PR [#5152](https://github.com/ashlrai/phantom/issues/5152) ([#5223](https://github.com/ashlrai/phantom/issues/5223)) ([4334103](https://github.com/ashlrai/phantom/commit/4334103cd4b5c7071b41c9d06869b4bb5260c402))
* **RQ-PHX-RECUTDESKS0C197:** BRIDGE_NOTES — RQ-PHX-RECUTDESKS0C197 (desk-newest slot) ([#5234](https://github.com/ashlrai/phantom/issues/5234)) ([c538292](https://github.com/ashlrai/phantom/commit/c538292fb561cfd3434b4fe9b4e981dd96d97c47))
* **RQ-PHX-RECUTDESKS0C200:** BRIDGE_NOTES — RQ-PHX-RECUTDESKS0C200 ([#5241](https://github.com/ashlrai/phantom/issues/5241)) ([04c08d3](https://github.com/ashlrai/phantom/commit/04c08d3470973450f0377b8f2e8975a99a1636ae))
* **RQ-PHX-RECUTDESKS0C207:** BRIDGE_NOTES — RQ-PHX-RECUTDESKS0C207 ([#5272](https://github.com/ashlrai/phantom/issues/5272)) ([17bd4e6](https://github.com/ashlrai/phantom/commit/17bd4e6bc8c734273327fe2059c287390ac6dbb9))
* **RQ-PHX-RECUTDESKS0CL209:** BRIDGE_NOTES — RQ-PHX-RECUTDESKS0CL209 ([#5275](https://github.com/ashlrai/phantom/issues/5275)) ([1393dcb](https://github.com/ashlrai/phantom/commit/1393dcb0537ba780aa7161681af5e3f5647e8b1a))
* **RQ-PHX-RECUTN1R2000S92:** Recut of [#2960](https://github.com/ashlrai/phantom/issues/2960) ([#4831](https://github.com/ashlrai/phantom/issues/4831)) ([28d8cd7](https://github.com/ashlrai/phantom/commit/28d8cd74c307d67c9bba0eb43b14fcc63c687a26))
* **RQ-PHX-RECUTN1R3300S105:** RQ-PHX-RECUTN1R3300S105: land the NEWEST unclaimed stranded ([#4833](https://github.com/ashlrai/phantom/issues/4833)) ([0535fdd](https://github.com/ashlrai/phantom/commit/0535fddc57bf6fecd13214416696dd863cb7c69f))
* **RQ-PHX-RECUTN1R3300S92:** Recut of [#3599](https://github.com/ashlrai/phantom/issues/3599) ([#4834](https://github.com/ashlrai/phantom/issues/4834)) ([c0b15e9](https://github.com/ashlrai/phantom/commit/c0b15e9da7c37ba3672c647616f70986cb2e158f))
* **RQ-PHX-RECUTN1R3900S115:** Recut investigation — incomplete ([#4897](https://github.com/ashlrai/phantom/issues/4897)) ([094e905](https://github.com/ashlrai/phantom/commit/094e90598f46111b6a6a04f4510f079883383325))
* **RQ-PHX-RECUTN1R4200S115:** Recut [#4292](https://github.com/ashlrai/phantom/issues/4292) ([#4895](https://github.com/ashlrai/phantom/issues/4895)) ([56faff3](https://github.com/ashlrai/phantom/commit/56faff36e3ba5859c4ae43388e20359a141f1da6))
* **RQ-PHX-RECUTN1R4200S116:** RQ-PHX-RECUTN1R4200S116 ([#4902](https://github.com/ashlrai/phantom/issues/4902)) ([cb7ba9a](https://github.com/ashlrai/phantom/commit/cb7ba9a6d7a240b81f0216d61df8ac5ae6f85256))
* **RQ-PHX-RECUTN1R4200S92:** Recut of [#4343](https://github.com/ashlrai/phantom/issues/4343) ([#4840](https://github.com/ashlrai/phantom/issues/4840)) ([440220f](https://github.com/ashlrai/phantom/commit/440220f1a685c028dcf21b5bcc7b5a9ce54884a1))
* **RQ-PHX-RECUTN1R4350S116:** RQ-PHX-RECUTN1R4350S116 ([#4903](https://github.com/ashlrai/phantom/issues/4903)) ([c0bbc44](https://github.com/ashlrai/phantom/commit/c0bbc4495e5a236303deb470f96da807e876b4ef))
* **RQ-PHX-RECUTN1R4480S98:** BRIDGE_NOTES — RQ-PHX-RECUTN1R4480S98 ([#4849](https://github.com/ashlrai/phantom/issues/4849)) ([8b2e496](https://github.com/ashlrai/phantom/commit/8b2e49612b3d927a201036d636b6dd97a03cd8a1))
* **RQ-PHX-RECUTN1R4600S115:** No qualifying PR in 4600-4699 ([#4898](https://github.com/ashlrai/phantom/issues/4898)) ([1f3d9ca](https://github.com/ashlrai/phantom/commit/1f3d9ca3bfb741ad26b74c1f9bf340f07d289d0b))
* **RQ-PHX-RECUTN1R4600S116:** Recut of [#4697](https://github.com/ashlrai/phantom/issues/4697) ([#4911](https://github.com/ashlrai/phantom/issues/4911)) ([7f26faa](https://github.com/ashlrai/phantom/commit/7f26faa2c75ea875c78d77b5d69ef9843467d854))
* **RQ-PHX-RECUTN1R4800S116:** Recut of [#4891](https://github.com/ashlrai/phantom/issues/4891) ([#4912](https://github.com/ashlrai/phantom/issues/4912)) ([0ea72e9](https://github.com/ashlrai/phantom/commit/0ea72e9309ca46bbe037ead05ff9cb01e994ac89))
* **RQ-PHX-RECUTN2R4600S92:** Recut of [#4789](https://github.com/ashlrai/phantom/issues/4789) ([#4855](https://github.com/ashlrai/phantom/issues/4855)) ([91ebec9](https://github.com/ashlrai/phantom/commit/91ebec97a6c48405abfe01ad9e029f519c6bc6fe))
* **RQ-PHX-RECUTN2R4700S115:** Bridge notes ([#4892](https://github.com/ashlrai/phantom/issues/4892)) ([22aee11](https://github.com/ashlrai/phantom/commit/22aee1176f3e107bb408577d84ea111533b5cc6f))
* **RQ-PHX-RECUTN2R4800S116:** Recut of [#4885](https://github.com/ashlrai/phantom/issues/4885) ([#4907](https://github.com/ashlrai/phantom/issues/4907)) ([bfac222](https://github.com/ashlrai/phantom/commit/bfac2220498c03eab9cbaee474da0f1d03635fb4))
* **RQ-PHX-RECUTN3R4700S102:** Recut of [#4789](https://github.com/ashlrai/phantom/issues/4789) ([#4861](https://github.com/ashlrai/phantom/issues/4861)) ([10c3c13](https://github.com/ashlrai/phantom/commit/10c3c13bae24d0150738d9484d15959e827804f7))
* **RQ-PHX-RECUTO1R4600S104:** BRIDGE_NOTES — RQ-PHX-RECUTO1R4600S104 ([#4865](https://github.com/ashlrai/phantom/issues/4865)) ([d242825](https://github.com/ashlrai/phantom/commit/d2428252fec807df18f443575cabf1e885e2a06b))
* **RQ-PHX-RECUTO1R4700S104:** RQ-PHX-RECUTO1R4700S104 ([#4868](https://github.com/ashlrai/phantom/issues/4868)) ([cd7e8b5](https://github.com/ashlrai/phantom/commit/cd7e8b5d2bf83279104ad70943e3e5a3a8e6e340))
* **RQ-PHX-RECUTO1R4700S116:** Recut of [#4702](https://github.com/ashlrai/phantom/issues/4702) ([#4910](https://github.com/ashlrai/phantom/issues/4910)) ([0de906b](https://github.com/ashlrai/phantom/commit/0de906bb6348fb1c4f93c7a12feb5c8880161d46))
* **RQ-PHX-RECUTO1R4800S115:** RQ-PHX-RECUTO1R4800S115 ([#4901](https://github.com/ashlrai/phantom/issues/4901)) ([2416da3](https://github.com/ashlrai/phantom/commit/2416da337f51436ca5c8bd47112eb67ac08c1d11))
* **RQ-PHX-REDDESKFIXC169:** BRIDGE_NOTES — RQ-PHX-REDDESKFIXC169 ([#5129](https://github.com/ashlrai/phantom/issues/5129)) ([4aab667](https://github.com/ashlrai/phantom/commit/4aab6676a5e6f5c48f55417cbd09650409e9b274))
* **RQ-PHX-REDDESKFIXC171:** RQ-PHX-REDDESKFIXC171 — fix of [#4964](https://github.com/ashlrai/phantom/issues/4964) ([#5138](https://github.com/ashlrai/phantom/issues/5138)) ([b564e6e](https://github.com/ashlrai/phantom/commit/b564e6ed2f3f94cda36bb3d2c7e48fc24477aef9))
* **RQ-PHX-REDDESKFIXC180:** BRIDGE_NOTES — RQ-PHX-REDDESKFIXC180 ([#5174](https://github.com/ashlrai/phantom/issues/5174)) ([73a6618](https://github.com/ashlrai/phantom/commit/73a661891f238826126880a41ecc7289fed22076))
* **RQ-PHX-REDDESKFIXC183:** BRIDGE_NOTES — RQ-PHX-REDDESKFIXC183 ([#5184](https://github.com/ashlrai/phantom/issues/5184)) ([22cacde](https://github.com/ashlrai/phantom/commit/22cacde81061bc14318b6c64d98d8812528cd794))
* **RQ-PHX-REDDESKFIXC192:** BRIDGE_NOTES — RQ-PHX-REDDESKFIXC192 ([#5220](https://github.com/ashlrai/phantom/issues/5220)) ([fdedfc3](https://github.com/ashlrai/phantom/commit/fdedfc3a1424fbc1e7beba15cc499180184760a6))
* **RQ-PHX-REDDESKFIXC202:** BRIDGE_NOTES — RQ-PHX-REDDESKFIXC202 ([#5248](https://github.com/ashlrai/phantom/issues/5248)) ([fb17930](https://github.com/ashlrai/phantom/commit/fb17930b757c7113711b85aa6a51ce53d9f5b4fc))
* **RQ-PHX-REDDESKFIXC203:** BRIDGE_NOTES — RQ-PHX-REDDESKFIXC203 ([#5255](https://github.com/ashlrai/phantom/issues/5255)) ([8a5b7ee](https://github.com/ashlrai/phantom/commit/8a5b7ee3902373ca336e42c1354fb16dd37e98e1))
* **RQ-PHX-REDDESKFIXC206:** BRIDGE_NOTES — RQ-PHX-REDDESKFIXC206 ([#5317](https://github.com/ashlrai/phantom/issues/5317)) ([3028658](https://github.com/ashlrai/phantom/commit/3028658dc8481b338df946cad7bd89abee19ece5))
* **RQ-PHX-REDDESKFIXC212:** BRIDGE_NOTES — RQ-PHX-REDDESKFIXC212 ([#5285](https://github.com/ashlrai/phantom/issues/5285)) ([3b50fb9](https://github.com/ashlrai/phantom/commit/3b50fb97605e3c7305651b43d74cf7dcef805e6e))
* **RQ-PHX-REDDESKFIXC216:** BRIDGE_NOTES — RQ-PHX-REDDESKFIXC216 ([#5293](https://github.com/ashlrai/phantom/issues/5293)) ([e9f7aed](https://github.com/ashlrai/phantom/commit/e9f7aedfa7f35d88221a986653bd60995fda9acc))
* **RQ-PHX-REDDESKFIXCL209:** RQ-PHX-REDDESKFIXCL209 — redfix for PR [#5262](https://github.com/ashlrai/phantom/issues/5262) ([#5276](https://github.com/ashlrai/phantom/issues/5276)) ([33216fe](https://github.com/ashlrai/phantom/commit/33216febfb4084199534a6c57ab6abc6355dc528))
* **RQ-PHX-REDDESKFIXCL211:** RQ-PHX-REDDESKFIXCL211 — redfix for PR [#5272](https://github.com/ashlrai/phantom/issues/5272) ([#5279](https://github.com/ashlrai/phantom/issues/5279)) ([f152f39](https://github.com/ashlrai/phantom/commit/f152f39f631fc3d8c4a53a7ef16318f78a1ab3fa))
* **RQ-PHX-REDDESKOLDCL208:** BRIDGE_NOTES — RQ-PHX-REDDESKOLDCL208 ([#5274](https://github.com/ashlrai/phantom/issues/5274)) ([fa1dc20](https://github.com/ashlrai/phantom/commit/fa1dc20ec350e082ab7038c19758f0eae373206e))
* **RQ-PHX-REDTESTDESKN1C152:** RQ-PHX-REDTESTDESKN1C152 — bridge notes ([#5075](https://github.com/ashlrai/phantom/issues/5075)) ([76468a1](https://github.com/ashlrai/phantom/commit/76468a1b73d0048fd4dafb15bab562c9ecde6d0f))
* **RQ-PHX-REDTESTDESKN1C154:** Fix of [#5067](https://github.com/ashlrai/phantom/issues/5067) ([#5083](https://github.com/ashlrai/phantom/issues/5083)) ([388c711](https://github.com/ashlrai/phantom/commit/388c711689dd4b0fbd855acd97140e660d3f7d84))
* **RQ-PHX-REDTESTDESKN1S128:** RQ-PHX-REDTESTDESKN1S128 — BRIDGE_NOTES ([#4982](https://github.com/ashlrai/phantom/issues/4982)) ([a69ee59](https://github.com/ashlrai/phantom/commit/a69ee59b256600efd07cb3775f884a90f1eed489))
* **RQ-PHX-REDTESTDESKN1S135:** BRIDGE_NOTES — RQ-PHX-REDTESTDESKN1S135 ([#5013](https://github.com/ashlrai/phantom/issues/5013)) ([769f0a9](https://github.com/ashlrai/phantom/commit/769f0a9971aefe4743d55fb2e85bdbb5d9f4c5f2))
* **RQ-PHX-REDTESTDESKN1S138:** RQ-PHX-REDTESTDESKN1S138 — Recut of [#4999](https://github.com/ashlrai/phantom/issues/4999) ([#5026](https://github.com/ashlrai/phantom/issues/5026)) ([26d8e2f](https://github.com/ashlrai/phantom/commit/26d8e2f4cbb3a1117722fabf2b85873029a340b0))
* **RQ-PHX-REDTESTFIXC159:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXC159 ([#5098](https://github.com/ashlrai/phantom/issues/5098)) ([fb0b88d](https://github.com/ashlrai/phantom/commit/fb0b88d6ac0037be3206ad5cc27774458f5d28de))
* **RQ-PHX-REDTESTFIXC166:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXC166 ([#5123](https://github.com/ashlrai/phantom/issues/5123)) ([f166df6](https://github.com/ashlrai/phantom/commit/f166df6c5880413a507f4432acee4971d0dc9f6e))
* **RQ-PHX-REDTESTFIXC167:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXC167 ([#5125](https://github.com/ashlrai/phantom/issues/5125)) ([a367c45](https://github.com/ashlrai/phantom/commit/a367c45518e5c0306e25727a02ec6c1921b73771))
* **RQ-PHX-REDTESTFIXC169:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXC169 ([#5132](https://github.com/ashlrai/phantom/issues/5132)) ([d790b7a](https://github.com/ashlrai/phantom/commit/d790b7ac016566501c906b1944078b7a7e4ea13e))
* **RQ-PHX-REDTESTFIXC177:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXC177 ([#5164](https://github.com/ashlrai/phantom/issues/5164)) ([afec063](https://github.com/ashlrai/phantom/commit/afec06386b75a215bd494195aed425c382c61656))
* **RQ-PHX-REDTESTFIXC180:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXC180 ([#5176](https://github.com/ashlrai/phantom/issues/5176)) ([0401dc6](https://github.com/ashlrai/phantom/commit/0401dc6b5b4f20007453f0cb9fc6cd83b679b079))
* **RQ-PHX-REDTESTFIXC182:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXC182 (lane: devin) ([#5186](https://github.com/ashlrai/phantom/issues/5186)) ([bc3a8b2](https://github.com/ashlrai/phantom/commit/bc3a8b233b67b61f0c87de7f4b34e0a824acc52a))
* **RQ-PHX-REDTESTFIXC183:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXC183 ([#5194](https://github.com/ashlrai/phantom/issues/5194)) ([43f0df5](https://github.com/ashlrai/phantom/commit/43f0df57642c8dc3fb930678c52c91898d5c7737))
* **RQ-PHX-REDTESTFIXC187:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXC187 ([#5200](https://github.com/ashlrai/phantom/issues/5200)) ([d61a794](https://github.com/ashlrai/phantom/commit/d61a79436e47c66e51f0cf3f95d44bfed3477e73))
* **RQ-PHX-REDTESTFIXC191:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXC191 ([#5217](https://github.com/ashlrai/phantom/issues/5217)) ([7b33a0c](https://github.com/ashlrai/phantom/commit/7b33a0c82efbf619a5201bfdec2ea17fea2b56b0))
* **RQ-PHX-REDTESTFIXC205:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXC205 ([#5265](https://github.com/ashlrai/phantom/issues/5265)) ([7a4e87b](https://github.com/ashlrai/phantom/commit/7a4e87be715bd35f3935e2019791d044050075ab))
* **RQ-PHX-REDTESTFIXC214:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXC214 ([#5290](https://github.com/ashlrai/phantom/issues/5290)) ([2dfcfa8](https://github.com/ashlrai/phantom/commit/2dfcfa82f031aad2805778ae3c33763139f836f5))
* **RQ-PHX-REDTESTFIXN1C152:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXN1C152 ([#5074](https://github.com/ashlrai/phantom/issues/5074)) ([ce3f21c](https://github.com/ashlrai/phantom/commit/ce3f21c677a5691a191fe1dbef8f11e3288dd919))
* **RQ-PHX-REDTESTFIXN1C156:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXN1C156 ([#5086](https://github.com/ashlrai/phantom/issues/5086)) ([139111b](https://github.com/ashlrai/phantom/commit/139111b33715d537afa60b210bef5362bcb1b990))
* **RQ-PHX-REDTESTFIXN1S116:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXN1S116 ([#4916](https://github.com/ashlrai/phantom/issues/4916)) ([6c36d6c](https://github.com/ashlrai/phantom/commit/6c36d6c621cfb7810d70a3c06be6ff9fdf8dbcd4))
* **RQ-PHX-REDTESTFIXN1S123:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXN1S123 ([#4954](https://github.com/ashlrai/phantom/issues/4954)) ([f017f25](https://github.com/ashlrai/phantom/commit/f017f257b66a2e41c8d830849c4123206bd44bae))
* **RQ-PHX-REDTESTFIXN1S126:** Recut of [#4860](https://github.com/ashlrai/phantom/issues/4860) — bridge: RQ-PHX-RECUTN3R4700S103 (`phantom_f ([#4967](https://github.com/ashlrai/phantom/issues/4967)) ([831efd5](https://github.com/ashlrai/phantom/commit/831efd5682f35b7f2e41f401d7bc2ad46bc78346))
* **RQ-PHX-REDTESTFIXN1S128:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXN1S128 ([#4979](https://github.com/ashlrai/phantom/issues/4979)) ([65839a3](https://github.com/ashlrai/phantom/commit/65839a3c960c84976ef723a1ba49725b5539318f))
* **RQ-PHX-REDTESTFIXN1S131:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXN1S131 ([#4996](https://github.com/ashlrai/phantom/issues/4996)) ([d1f2a4c](https://github.com/ashlrai/phantom/commit/d1f2a4c7564c01e3a6e2e747647e6252e7e4a2cd))
* **RQ-PHX-REDTESTFIXN1S134:** BRIDGE_NOTES — RQ-PHX-REDTESTFIXN1S134 ([#5008](https://github.com/ashlrai/phantom/issues/5008)) ([69f8f17](https://github.com/ashlrai/phantom/commit/69f8f1734248572ef1fb3adbc354375ad0d0afde))
* **RQ-PHX-REDTESTFIXN1S138:** RQ-PHX-REDTESTFIXN1S138 — Recut of [#4971](https://github.com/ashlrai/phantom/issues/4971) ([#5022](https://github.com/ashlrai/phantom/issues/5022)) ([4e4b2fa](https://github.com/ashlrai/phantom/commit/4e4b2fa6e9c95006cb17c58630c28c2b1dae4ae7))
* **RQ-PHX-REDTYPEDESKN1S122:** RQ-PHX-REDTYPEDESKN1S122 ([#4937](https://github.com/ashlrai/phantom/issues/4937)) ([8985fb1](https://github.com/ashlrai/phantom/commit/8985fb1bb9f647b9777ae6a9841fb12df762d66d))
* **RQ-PHX-REDTYPEDESKN1S125:** Recut of [#4836](https://github.com/ashlrai/phantom/issues/4836) ([#4961](https://github.com/ashlrai/phantom/issues/4961)) ([42e6ae5](https://github.com/ashlrai/phantom/commit/42e6ae5324cde745b918a15a579475e2f416c392))
* **RQ-PHX-REDTYPEDESKN1S129:** Fix of [#4838](https://github.com/ashlrai/phantom/issues/4838) ([#4981](https://github.com/ashlrai/phantom/issues/4981)) ([4c1a6f8](https://github.com/ashlrai/phantom/commit/4c1a6f84b280a2cca4924faa92c464bc056e977b))
* **RQ-PHX-REDTYPEDESKN1S131:** BRIDGE_NOTES — RQ-PHX-REDTYPEDESKN1S131 ([#4999](https://github.com/ashlrai/phantom/issues/4999)) ([00b28a2](https://github.com/ashlrai/phantom/commit/00b28a27f3a450eb709add18f57c7341c6281167))
* **RQ-PHX-REDTYPEDESKN1S135:** BRIDGE_NOTES — RQ-PHX-REDTYPEDESKN1S135 ([#5014](https://github.com/ashlrai/phantom/issues/5014)) ([5467ceb](https://github.com/ashlrai/phantom/commit/5467cebe978408617166df643420f71acc84279c))
* **RQ-PHX-REDTYPEFIXC158:** ([#5094](https://github.com/ashlrai/phantom/issues/5094)) ([19c5a49](https://github.com/ashlrai/phantom/commit/19c5a49010816a2c90940159482e5dfe1ece4e26))
* **RQ-PHX-REDTYPEFIXC164:** RQ-PHX-REDTYPEFIXC164 — bridge notes ([#5115](https://github.com/ashlrai/phantom/issues/5115)) ([5b15c19](https://github.com/ashlrai/phantom/commit/5b15c19349f0c21ff80c0d9e4faaea938b710d98))
* **RQ-PHX-REDTYPEFIXC172:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXC172 ([#5140](https://github.com/ashlrai/phantom/issues/5140)) ([db1bc6a](https://github.com/ashlrai/phantom/commit/db1bc6a571c2162ebf00ac0dade58ff32a4016c2))
* **RQ-PHX-REDTYPEFIXC175:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXC175 ([#5155](https://github.com/ashlrai/phantom/issues/5155)) ([563a242](https://github.com/ashlrai/phantom/commit/563a24252768c07015dc89dfb2aceec413420891))
* **RQ-PHX-REDTYPEFIXC176:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXC176 (lane zai) ([#5172](https://github.com/ashlrai/phantom/issues/5172)) ([2671b39](https://github.com/ashlrai/phantom/commit/2671b395dcecfec817c733bdf99ad19909ee1296))
* **RQ-PHX-REDTYPEFIXC178:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXC178 ([#5188](https://github.com/ashlrai/phantom/issues/5188)) ([780ebda](https://github.com/ashlrai/phantom/commit/780ebdaef475a1e0b04398ca15d07f2906f24c60))
* **RQ-PHX-REDTYPEFIXC180:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXC180 ([#5185](https://github.com/ashlrai/phantom/issues/5185)) ([bc6678c](https://github.com/ashlrai/phantom/commit/bc6678c86964a2cb648d84da140143e9abac4ef2))
* **RQ-PHX-REDTYPEFIXC190:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXC190 ([#5216](https://github.com/ashlrai/phantom/issues/5216)) ([859d3db](https://github.com/ashlrai/phantom/commit/859d3db1e4be7dcfd6c9a82d2818ac62e390c804))
* **RQ-PHX-REDTYPEFIXC193:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXC193 ([#5227](https://github.com/ashlrai/phantom/issues/5227)) ([f8da884](https://github.com/ashlrai/phantom/commit/f8da884dfc5ee9ead8e7b3e33d245b8ecb451214))
* **RQ-PHX-REDTYPEFIXC197:** RQ-PHX-REDTYPEFIXC197 — no qualifying PR (empty result, with ([#5245](https://github.com/ashlrai/phantom/issues/5245)) ([addb684](https://github.com/ashlrai/phantom/commit/addb6842ed36a9cd92447a194fe303d89a9f47fc))
* **RQ-PHX-REDTYPEFIXC198:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXC198 ([#5237](https://github.com/ashlrai/phantom/issues/5237)) ([f760541](https://github.com/ashlrai/phantom/commit/f76054162e61c935014e2155631809fb840d8aaf))
* **RQ-PHX-REDTYPEFIXC212:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXC212 ([#5289](https://github.com/ashlrai/phantom/issues/5289)) ([8f36332](https://github.com/ashlrai/phantom/commit/8f3633289f1adb10f9969174b40ba11e680a7f58))
* **RQ-PHX-REDTYPEFIXC213:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXC213 ([#5287](https://github.com/ashlrai/phantom/issues/5287)) ([b6787c4](https://github.com/ashlrai/phantom/commit/b6787c426ff273d07ae707d9574269cd64a1f480))
* **RQ-PHX-REDTYPEFIXN1C152:** BRIDGE_NOTES — RQ-PHX-REDTYPEFIXN1C152 ([#5099](https://github.com/ashlrai/phantom/issues/5099)) ([4496f22](https://github.com/ashlrai/phantom/commit/4496f2212937b787235008db8f79a74247547525))
* **RQ-PHX-REDTYPEFIXN1S104:** RQ-PHX-REDTYPEFIXN1S104 ([#4873](https://github.com/ashlrai/phantom/issues/4873)) ([86085b8](https://github.com/ashlrai/phantom/commit/86085b87545576f7c3a5f222dcfd4872ead4950e))
* **RQ-PHX-REDTYPEFIXN2S104:** RQ-PHX-REDTYPEFIXN2S104 ([#4878](https://github.com/ashlrai/phantom/issues/4878)) ([3e0f81c](https://github.com/ashlrai/phantom/commit/3e0f81c9138b1173f6bae93324a0775751844f8b))
* **RQ-PHX-REDTYPEFIXSIXTH88:** RQ-PHX-REDTYPEFIXSIXTH88 — land a real Quick-typecheck failu ([#4775](https://github.com/ashlrai/phantom/issues/4775)) ([1297d9d](https://github.com/ashlrai/phantom/commit/1297d9ddd56acb531874a0647f4115d481aa9be4))
* **RQ-PHX-RELEASECHAINHTTPRECOVER190S:** BRIDGE_NOTES — RQ-PHX-RELEASECHAINHTTPRECOVER190S ([#5209](https://github.com/ashlrai/phantom/issues/5209)) ([845edf9](https://github.com/ashlrai/phantom/commit/845edf91166e33f99d77f642cf99b4aa75160caa))
* **RQ-PHX-RELEASECHAINREAD85:** RQ-PHX-RELEASECHAINREAD85 — `ashlr fleet release-chain` ([#4741](https://github.com/ashlrai/phantom/issues/4741)) ([3bba390](https://github.com/ashlrai/phantom/commit/3bba3902e45ccff43d4bcc0a5ed606b0763d0a44))
* **RQ-PHX-RELEASECHAINRECOVERY100:** Release chain recovery ([#4880](https://github.com/ashlrai/phantom/issues/4880)) ([dab7b74](https://github.com/ashlrai/phantom/commit/dab7b746be5453b24b4c70f0b7fcd466d0280588))
* **RQ-PHX-RELEASEEVIDENCEJOIN88:** BRIDGE_NOTES — RQ-PHX-RELEASEEVIDENCEJOIN88 ([#4759](https://github.com/ashlrai/phantom/issues/4759)) ([e19af37](https://github.com/ashlrai/phantom/commit/e19af37323e612815b285e27716917b8ebf03448))
* **RQ-PHX-RELEASELAGBACKENDRECOVER240S:** BRIDGE_NOTES — RQ-PHX-RELEASELAGBACKENDRECOVER240S ([#5327](https://github.com/ashlrai/phantom/issues/5327)) ([0a2753a](https://github.com/ashlrai/phantom/commit/0a2753ad9d029f37d7504407668d2d4004b3b8d6))
* **RQ-PHX-RELEASELIVEANNOUNCE96:** RQ-PHX-RELEASELIVEANNOUNCE96 ([#4886](https://github.com/ashlrai/phantom/issues/4886)) ([6e489b0](https://github.com/ashlrai/phantom/commit/6e489b05e4e060513dfac59446185bcf1f27a1dd))
* **RQ-PHX-RELEASESTARTRECOVER125:** Release-start recovery handoff ([#4955](https://github.com/ashlrai/phantom/issues/4955)) ([bb462a3](https://github.com/ashlrai/phantom/commit/bb462a3c07f2e54c33672ce1950426435f4b2309))
* **RQ-PHX-REPLYCLEANORIGINAL238S:** BRIDGE_NOTES — RQ-PHX-REPLYCLEANORIGINAL238S ([#5325](https://github.com/ashlrai/phantom/issues/5325)) ([00aab8c](https://github.com/ashlrai/phantom/commit/00aab8ca38f39150937ee5f54c7894e71a9f3e63))
* **RQ-PHX-REPLYCLIORIGINAL275S:** RQ-PHX-REPLYCLIORIGINAL275S — Reconcile PR [#4551](https://github.com/ashlrai/phantom/issues/4551) (leader rep ([#5363](https://github.com/ashlrai/phantom/issues/5363)) ([9e87ddd](https://github.com/ashlrai/phantom/commit/9e87ddd6887e15062013120e1cb3210b94b5cc3b))
* **RQ-PHX-REPLYGAPCOMPAT178:** Leader reply-gap compatibility bridge ([#5166](https://github.com/ashlrai/phantom/issues/5166)) ([44de3b2](https://github.com/ashlrai/phantom/commit/44de3b2182667160b463a368862391878a88cf33))
* **RQ-PHX-REPLYGAPORIGINAL260S:** BRIDGE_NOTES — RQ-PHX-REPLYGAPORIGINAL260S ([#5351](https://github.com/ashlrai/phantom/issues/5351)) ([cb7c33d](https://github.com/ashlrai/phantom/commit/cb7c33d18c984ac26418e25e356350e8974eed60))
* **RQ-PHX-REPLYOSNOTIFY120:** Reply desktop notifications ([#4929](https://github.com/ashlrai/phantom/issues/4929)) ([876f80e](https://github.com/ashlrai/phantom/commit/876f80ec3ae97b07136be99894e8b06d65d8f717))
* **RQ-PHX-REPORTLEDGERRECOVER245S:** BRIDGE_NOTES — RQ-PHX-REPORTLEDGERRECOVER245S ([#5333](https://github.com/ashlrai/phantom/issues/5333)) ([78d2d6a](https://github.com/ashlrai/phantom/commit/78d2d6aafc87ee8be1699f5b1fa0391e77e4f952))
* **RQ-PHX-RESERVEORIGINALRECONCILE242S:** BRIDGE_NOTES — RQ-PHX-RESERVEORIGINALRECONCILE242S ([#5330](https://github.com/ashlrai/phantom/issues/5330)) ([155b095](https://github.com/ashlrai/phantom/commit/155b095a23fc1273dc2f470fa426796b1600921f))
* **RQ-PHX-RESETSTIMELINE90:** RQ-PHX-RESETSTIMELINE90 ([#4771](https://github.com/ashlrai/phantom/issues/4771)) ([1fcf68e](https://github.com/ashlrai/phantom/commit/1fcf68ea3686a8bbadaf5436ca3ea89ff2ce879f))
* **RQ-PHX-SAFARIORIGINALPROOF286S:** BRIDGE_NOTES — RQ-PHX-SAFARIORIGINALPROOF286S ([#5375](https://github.com/ashlrai/phantom/issues/5375)) ([15bf3fb](https://github.com/ashlrai/phantom/commit/15bf3fb49c677f7208270152299219b42ee09c46))
* **RQ-PHX-SESSIONGUIDANCEIORECOVER224S:** BRIDGE_NOTES — RQ-PHX-SESSIONGUIDANCEIORECOVER224S ([#5309](https://github.com/ashlrai/phantom/issues/5309)) ([a101eab](https://github.com/ashlrai/phantom/commit/a101eab9dc02f208e5b25a0ee3767e1a9a097b6b))
* **RQ-PHX-SETTINGSCOVERRECOVER176:** Settings persistence recovery 176 ([#5160](https://github.com/ashlrai/phantom/issues/5160)) ([aad88da](https://github.com/ashlrai/phantom/commit/aad88dabbbffb37885e01c7f11bf7b9160c58207))
* **RQ-PHX-SETTINGSPERSISTEXACT215S:** BRIDGE_NOTES — RQ-PHX-SETTINGSPERSISTEXACT215S ([#5288](https://github.com/ashlrai/phantom/issues/5288)) ([12d26e1](https://github.com/ashlrai/phantom/commit/12d26e1ebd6841064aa07d24d568b563dacdbf55))
* **RQ-PHX-SLACKFAIRORIGINAL258S:** BRIDGE_NOTES — RQ-PHX-SLACKFAIRORIGINAL258S ([#5348](https://github.com/ashlrai/phantom/issues/5348)) ([3453c82](https://github.com/ashlrai/phantom/commit/3453c829f79f3545696c960a984472935c3ee0ff))
* **RQ-PHX-SLACKOFFLINEEVIDENCE279S:** BRIDGE_NOTES — RQ-PHX-SLACKOFFLINEEVIDENCE279S ([#5367](https://github.com/ashlrai/phantom/issues/5367)) ([7fa7ae9](https://github.com/ashlrai/phantom/commit/7fa7ae90b601278330a1acb4765c7c632378f862))
* **RQ-PHX-SLACKRECEIPTOWNERPROOF282S:** BRIDGE_NOTES — RQ-PHX-SLACKRECEIPTOWNERPROOF282S ([#5370](https://github.com/ashlrai/phantom/issues/5370)) ([d5a42df](https://github.com/ashlrai/phantom/commit/d5a42df76aa3957cb81c31973bac45195c504c53))
* **RQ-PHX-SLACKSTATUSORIGINAL259S:** BRIDGE_NOTES — RQ-PHX-SLACKSTATUSORIGINAL259S ([#5349](https://github.com/ashlrai/phantom/issues/5349)) ([f679ad3](https://github.com/ashlrai/phantom/commit/f679ad3f8dced4f07ac04815035b85500346f4d0))
* **RQ-PHX-SLACKSTATUSPRESERVE221S:** BRIDGE_NOTES — RQ-PHX-SLACKSTATUSPRESERVE221S ([#5305](https://github.com/ashlrai/phantom/issues/5305)) ([d8d55d0](https://github.com/ashlrai/phantom/commit/d8d55d07bdada28915a98073116a27f33a5d845f))
* **RQ-PHX-SLACKSTATUSROUNDTRIP100:** BRIDGE_NOTES — RQ-PHX-SLACKSTATUSROUNDTRIP100 ([#4882](https://github.com/ashlrai/phantom/issues/4882)) ([1d92677](https://github.com/ashlrai/phantom/commit/1d926776163b2c0ea6d6cae437b44898585937a3))
* **RQ-PHX-SPENDPRESERVE220S:** RQ-PHX-SPENDPRESERVE220S — reconcile PR [#4499](https://github.com/ashlrai/phantom/issues/4499) (RQ-USAGESPEND ([#5302](https://github.com/ashlrai/phantom/issues/5302)) ([2252c34](https://github.com/ashlrai/phantom/commit/2252c34ddeee2f6cdafa0d03fca37ecffe86425f))
* **RQ-PHX-STALLWHY109:** RQ-PHX-STALLWHY109: Lanes pane says WHY no job is launching ([#4884](https://github.com/ashlrai/phantom/issues/4884)) ([4c0259b](https://github.com/ashlrai/phantom/commit/4c0259bcda6ee7858e5dc111ebed26bd1d44cd07))
* **RQ-PHX-STATUSASKUNIFY134:** Bridge notes ([#5004](https://github.com/ashlrai/phantom/issues/5004)) ([129a6f0](https://github.com/ashlrai/phantom/commit/129a6f06e463ba3fb43624265e44a0fc7dae4482))
* **RQ-PHX-STATUSLANES145:** BRIDGE_NOTES — RQ-PHX-STATUSLANES145 ([#5049](https://github.com/ashlrai/phantom/issues/5049)) ([ecb486f](https://github.com/ashlrai/phantom/commit/ecb486fae53e4717ccce5625e6b39b46397dd140))
* **RQ-PHX-STATUSORIGINALRECONCILE234S:** BRIDGE_NOTES — RQ-PHX-STATUSORIGINALRECONCILE234S ([#5322](https://github.com/ashlrai/phantom/issues/5322)) ([55a0fd3](https://github.com/ashlrai/phantom/commit/55a0fd3cba968122cdda3c6062cf76f14340e5a5))
* **RQ-PHX-STATUSOWNERPROOF281S:** RQ-PHX-STATUSOWNERPROOF281S — evidence for existing owner PR ([#5369](https://github.com/ashlrai/phantom/issues/5369)) ([30b3ba8](https://github.com/ashlrai/phantom/commit/30b3ba8ad05459ebcea3f2c08470f70e22bb9c0a))
* **RQ-PHX-STEERCORRECT99:** RQ-PHX-STEERCORRECT99: correct the last steer message in one ([#4887](https://github.com/ashlrai/phantom/issues/4887)) ([c596913](https://github.com/ashlrai/phantom/commit/c596913cf11b8db26068e9175f49b114406c41ce))
* **RQ-PHX-STEERJOBTARGET87:** Mason can type @ in the steer box, choose a running job and ([#4751](https://github.com/ashlrai/phantom/issues/4751)) ([b6b8ca1](https://github.com/ashlrai/phantom/commit/b6b8ca1715b4bcb9bb228e54063eaffda992dc00))
* **RQ-PHX-STEERNOTEKEEP106:** Bridge notes ([#4888](https://github.com/ashlrai/phantom/issues/4888)) ([85712d2](https://github.com/ashlrai/phantom/commit/85712d255734cab87e76f598e484ce4d4ab49430))
* **RQ-PHX-STEERSCREENSHOT90:** BRIDGE_NOTES — RQ-PHX-STEERSCREENSHOT90 ([#4772](https://github.com/ashlrai/phantom/issues/4772)) ([0aed853](https://github.com/ashlrai/phantom/commit/0aed8539dd2e59a01143d87ed8d4f09f961a141b))
* **RQ-PHX-STEERTARGETOUTCOME90:** RQ-PHX-STEERTARGETOUTCOME90 — steer-target outcome lines in ([#4773](https://github.com/ashlrai/phantom/issues/4773)) ([44f8cc6](https://github.com/ashlrai/phantom/commit/44f8cc636f947850e2d43096bb2fba1e6610e870))
* **RQ-PHX-SUPPLYLANECOVER144:** Supply lane coverage bridge ([#5047](https://github.com/ashlrai/phantom/issues/5047)) ([fcc7474](https://github.com/ashlrai/phantom/commit/fcc74742c0fd4374df4c276cdc285b3ee1c42b37))
* **RQ-PHX-TEAMINBOXTAIL139:** Bridge notes ([#5025](https://github.com/ashlrai/phantom/issues/5025)) ([eb08675](https://github.com/ashlrai/phantom/commit/eb08675ae029678e232f6f125d6ab2398f8f3208))
* **RQ-PHX-TEAMOVERDUEINTENT142:** BRIDGE_NOTES — RQ-PHX-TEAMOVERDUEINTENT142 ([#5036](https://github.com/ashlrai/phantom/issues/5036)) ([a9fbc5e](https://github.com/ashlrai/phantom/commit/a9fbc5e7878670e44c6b9e88e41be38e4f3d729a))
* **RQ-PHX-TEAMRECEIPTCAP139:** BRIDGE_NOTES — RQ-PHX-TEAMRECEIPTCAP139 ([#5027](https://github.com/ashlrai/phantom/issues/5027)) ([15bf654](https://github.com/ashlrai/phantom/commit/15bf65461a338179c0c2df39afdda4995784c15f))
* **RQ-PHX-TGSTATUSFRESH149:** Telegram dispatcher freshness handoff ([#5063](https://github.com/ashlrai/phantom/issues/5063)) ([eb2ae96](https://github.com/ashlrai/phantom/commit/eb2ae96e29dab0feac87963d0379f9bb0a6df37c))
* **RQ-PHX-THREADFIND86:** RQ-PHX-THREADFIND86 ([#4748](https://github.com/ashlrai/phantom/issues/4748)) ([8269377](https://github.com/ashlrai/phantom/commit/82693779f9ddd42dbc0fbb2dae02489c5eef01c9))
* **RQ-PHX-THREADNOISE101:** Mason now sees short inbox status requests as muted rows wit ([#4890](https://github.com/ashlrai/phantom/issues/4890)) ([0bff606](https://github.com/ashlrai/phantom/commit/0bff606544324f08b9e9adda4f389edfb0a59392))
* **RQ-PHX-THREADSCREENSHOTVIEW117:** RQ-PHX-THREADSCREENSHOTVIEW117 — bridge notes ([#4917](https://github.com/ashlrai/phantom/issues/4917)) ([70bc1ee](https://github.com/ashlrai/phantom/commit/70bc1ee1b0ed89a43c34e187030ae3d27434ce20))
* **RQ-PHX-UPDATEWHYPRESERVE226S:** BRIDGE_NOTES — RQ-PHX-UPDATEWHYPRESERVE226S ([#5311](https://github.com/ashlrai/phantom/issues/5311)) ([2e5c5dc](https://github.com/ashlrai/phantom/commit/2e5c5dc7f45f05a6e406ef2554c4acf4708a9891))
* **RQ-PHX-USAGELOGBOUNDED136:** BRIDGE_NOTES — RQ-PHX-USAGELOGBOUNDED136 ([#5011](https://github.com/ashlrai/phantom/issues/5011)) ([0b22830](https://github.com/ashlrai/phantom/commit/0b228308003774dc9cebb5ec1e44c0a5c63be9e5))
* **RQ-PHX-USAGEPACECHIP95:** RQ-PHX-USAGEPACECHIP95 ([#4889](https://github.com/ashlrai/phantom/issues/4889)) ([d1d6123](https://github.com/ashlrai/phantom/commit/d1d612392f2a6e2288f3958e6bf107aef0be7452))
* **RQ-PHX-USAGEQUOTATTL136:** Bridge notes ([#5012](https://github.com/ashlrai/phantom/issues/5012)) ([da39dd1](https://github.com/ashlrai/phantom/commit/da39dd126da088d2e348c6a8ffade52eceb92c3c))
* **RQ-PHX-USAGERESETFACT147:** RQ-PHX-USAGERESETFACT147 ([#5057](https://github.com/ashlrai/phantom/issues/5057)) ([c9b4f10](https://github.com/ashlrai/phantom/commit/c9b4f10df8a333e151d0ccc0dafd985eab9d015c))
* **RQ-PHX-USAGERESETTRUTH126:** BRIDGE_NOTES — RQ-PHX-USAGERESETTRUTH126 ([#4963](https://github.com/ashlrai/phantom/issues/4963)) ([2a7e35c](https://github.com/ashlrai/phantom/commit/2a7e35cb24640fb57befa8c4f979e57201040e3a))
* **RQ-PHX-USAGESELFRECONCILE222S:** BRIDGE_NOTES — RQ-PHX-USAGESELFRECONCILE222S (reconcile PR # ([#5306](https://github.com/ashlrai/phantom/issues/5306)) ([0427b16](https://github.com/ashlrai/phantom/commit/0427b167f1aec975905a05203d54452a33dd70a9))
* **RQ-PHX-USAGEWRITERFIELDS147:** BRIDGE_NOTES — RQ-PHX-USAGEWRITERFIELDS147 ([#5056](https://github.com/ashlrai/phantom/issues/5056)) ([0dd6bc6](https://github.com/ashlrai/phantom/commit/0dd6bc690485d7dfd7dcd67afaa96b8a83077c38))
* **RQ-PHX-VERSESTATUSASK143:** Serves Mason: Phantom status in the desktop/phone Leader thr ([#5042](https://github.com/ashlrai/phantom/issues/5042)) ([8dc7e09](https://github.com/ashlrai/phantom/commit/8dc7e097fa22da0f604e0381446b51f12ee7764d))
* **RQ-PHX-VISIONEXACTRECOVER174:** RQ-PHX-VISIONEXACTRECOVER174 bridge notes ([#5145](https://github.com/ashlrai/phantom/issues/5145)) ([3263fd2](https://github.com/ashlrai/phantom/commit/3263fd231a911f76268f3792f62939e2f4cc2083))
* **RQ-RENAME-ALIASES-1:** BRIDGE_NOTES — RQ-RENAME-ALIASES-1 (rename slice 3: Phantom ([#4959](https://github.com/ashlrai/phantom/issues/4959)) ([a44148e](https://github.com/ashlrai/phantom/commit/a44148ead47fdad94f99e28aadbd457ab3123b85))
* **RQ-RENAME-FIXTURES-1:** RQ-RENAME-FIXTURES-1 handoff ([#4956](https://github.com/ashlrai/phantom/issues/4956)) ([0a446f2](https://github.com/ashlrai/phantom/commit/0a446f250a0bc9a0198123af705b94b750dc84be))
* **RQ-RENAME-INTERNAL-1:** BRIDGE_NOTES — RQ-RENAME-INTERNAL-1 (slice 1: app root compo ([#4972](https://github.com/ashlrai/phantom/issues/4972)) ([f8e7abb](https://github.com/ashlrai/phantom/commit/f8e7abbe61a5aac59f0f2e037b7c8fa1823410cb))
* **RQ-RENAME-UNIVERSE-1:** Bridge notes ([#4958](https://github.com/ashlrai/phantom/issues/4958)) ([b594e56](https://github.com/ashlrai/phantom/commit/b594e5637fcc8ef58c51840fee42c923560f3d5e))
* **RQ-TEAM-AGENT-ACCESS-1:** BRIDGE_NOTES — RQ-TEAM-AGENT-ACCESS-1 ([#4922](https://github.com/ashlrai/phantom/issues/4922)) ([b671753](https://github.com/ashlrai/phantom/commit/b671753ec2d5e1786394f796564c7172a95a5b1c))
* **RQ-USAGE-LIVE-2:** BRIDGE_NOTES: RQ-USAGE-LIVE-2 ([#4933](https://github.com/ashlrai/phantom/issues/4933)) ([9a2bc97](https://github.com/ashlrai/phantom/commit/9a2bc971865747776b11d849906e01dfca1a6da7))
* **RQ-USAGE-LIVE-BROWSER-2:** RQ-USAGE-LIVE-BROWSER-2 ([#4935](https://github.com/ashlrai/phantom/issues/4935)) ([51e807a](https://github.com/ashlrai/phantom/commit/51e807ab80fcd15560d01393b3c7cd3ff04ae732))


### CI

* make Quick typecheck advisory on fast merge events ([#5387](https://github.com/ashlrai/phantom/issues/5387)) ([746c064](https://github.com/ashlrai/phantom/commit/746c0647e10a226466a9aac761a843d68dfc1d23))

## [3.30.32] - 2026-11-10


### Fixes

* **release-train:** drop the 60-minute HOURLY_MINUTES enqueue default ([#4614](https://github.com/ashlrai/phantom/issues/4614)) ([19b1d23](https://github.com/ashlrai/phantom/commit/19b1d233ebcdb3eab538eaa20f12aef4eac0789b))


### Changes

* **FIXUP-CI-phantom-auto-tag-829874:** FIXUP-CI-phantom-auto-tag-829874 ([#4619](https://github.com/ashlrai/phantom/issues/4619)) ([f482d66](https://github.com/ashlrai/phantom/commit/f482d66c6911b647664d04a7d6bf45a75e30c00e))
* **FIXUP-CI-phantom-ci-595121:** FIXUP-CI-phantom-ci-595121 ([#4686](https://github.com/ashlrai/phantom/issues/4686)) ([3315870](https://github.com/ashlrai/phantom/commit/33158705df581c6bf488522327d89efff2d68c6e))
* **RQ-DESK-11-SECRETS-VIEW:** RQ-DESK-11-SECRETS-VIEW ([#4618](https://github.com/ashlrai/phantom/issues/4618)) ([5b52c78](https://github.com/ashlrai/phantom/commit/5b52c782f3c4345be570e54d1180564bb4357d99))
* **RQ-DESK-3-ACTIONS:** RQ-DESK-3-ACTIONS ([#4617](https://github.com/ashlrai/phantom/issues/4617)) ([fb1b116](https://github.com/ashlrai/phantom/commit/fb1b1168b79c9c065e37bc5bec3dea014bf7b996))
* **RQ-DESK-9-STEER:** RQ-DESK-9-STEER: Verse agent steer pane ([#4623](https://github.com/ashlrai/phantom/issues/4623)) ([155ebde](https://github.com/ashlrai/phantom/commit/155ebde0f9848316fc7fc74428cbccf805b7e9c6))
* **RQ-EMPTYJOBYIELDQ8:** BRIDGE_NOTES: RQ-EMPTYJOBYIELDQ8 ([#4615](https://github.com/ashlrai/phantom/issues/4615)) ([252a3c5](https://github.com/ashlrai/phantom/commit/252a3c56d3311ef2735ef0b69a737e0558b235a4))
* **RQ-FIX-PHANTOM-1022:** BRIDGE_NOTES: RQ-FIX-PHANTOM-1022 ([#4704](https://github.com/ashlrai/phantom/issues/4704)) ([7617995](https://github.com/ashlrai/phantom/commit/7617995ff2f706842dfeeb47ba44215e6edec4ae))
* **RQ-FIX-PHANTOM-1050:** BRIDGE_NOTES: RQ-FIX-PHANTOM-1050 (update PR [#1050](https://github.com/ashlrai/phantom/issues/1050), bridge ([#4707](https://github.com/ashlrai/phantom/issues/4707)) ([6e19cce](https://github.com/ashlrai/phantom/commit/6e19cce19d43622ce32be054da7f49a2e92bba1b))
* **RQ-FIX-PHANTOM-1099:** BRIDGE_NOTES: RQ-FIX-PHANTOM-1099 (PR [#1099](https://github.com/ashlrai/phantom/issues/1099), RQ-GROKBOT-OFF ([#4699](https://github.com/ashlrai/phantom/issues/4699)) ([826e611](https://github.com/ashlrai/phantom/commit/826e611ede8c14477e756418c3d2db5ee28aa966))
* **RQ-FIX-PHANTOM-1128:** BRIDGE_NOTES: RQ-FIX-PHANTOM-1128 ([#4714](https://github.com/ashlrai/phantom/issues/4714)) ([f8fc93c](https://github.com/ashlrai/phantom/commit/f8fc93c6dad15ffc619868ccbd274198e0f6cd64))
* **RQ-FIX-PHANTOM-1565:** BRIDGE_NOTES: RQ-FIX-PHANTOM-1565 (PR [#1565](https://github.com/ashlrai/phantom/issues/1565), RQ-MERGEDRAINQ ([#4716](https://github.com/ashlrai/phantom/issues/4716)) ([cf262a1](https://github.com/ashlrai/phantom/commit/cf262a1faf5dd4a57a228b896d980f74ae67b3eb))
* **RQ-FIX-PHANTOM-3391:** RQ-FIX-PHANTOM-3391 ([#4621](https://github.com/ashlrai/phantom/issues/4621)) ([67732c1](https://github.com/ashlrai/phantom/commit/67732c1880ee4c3d5ae93b9eb41b3ce4db69c2e2))
* **RQ-FIX-PHANTOM-4068:** RQ-FIX-PHANTOM-4068 ([#4628](https://github.com/ashlrai/phantom/issues/4628)) ([cf0ac60](https://github.com/ashlrai/phantom/commit/cf0ac60de14a56cd8b7b2e752640f161de4632e1))
* **RQ-FIX-PHANTOM-4194:** RQ-FIX-PHANTOM-4194 ([#4629](https://github.com/ashlrai/phantom/issues/4629)) ([de10741](https://github.com/ashlrai/phantom/commit/de10741dc3cd31192da955033ede701706214f5e))
* **RQ-FIX-PHANTOM-4202:** RQ-FIX-PHANTOM-4202 handoff ([#4631](https://github.com/ashlrai/phantom/issues/4631)) ([0948f4c](https://github.com/ashlrai/phantom/commit/0948f4c1e2fd5009871d76f62a8b4e612b5d5a2e))
* **RQ-LEDGER-CONTEXT-1:** Bridge notes ([#4655](https://github.com/ashlrai/phantom/issues/4655)) ([b345548](https://github.com/ashlrai/phantom/commit/b345548d797bd8c1e1dc5d09a766ac0e19642b8a))
* **RQ-PHANTOM-VERSE-CPU-1:** BRIDGE_NOTES: RQ-PHANTOM-VERSE-CPU-1 ([#4611](https://github.com/ashlrai/phantom/issues/4611)) ([94aa593](https://github.com/ashlrai/phantom/commit/94aa593fc449be0a9c2a43b77ceab234fce342fc))
* **RQ-PHX-APPEARANCELIVEAPPLY83:** Appearance live application ([#4726](https://github.com/ashlrai/phantom/issues/4726)) ([f137cb6](https://github.com/ashlrai/phantom/commit/f137cb65e69db0816d9a34b4a2d757b54096d40d))
* **RQ-PHX-BRIEFPRESERVEPROOF10SRP2:** PR [#4355](https://github.com/ashlrai/phantom/issues/4355) preservation evidence ([#4690](https://github.com/ashlrai/phantom/issues/4690)) ([8b285ec](https://github.com/ashlrai/phantom/commit/8b285ecfa6c08ab305786a14e98867380b92184d))
* **RQ-PHX-CAPABILITYPRESERVEPROOF10SRM2:** Capability audit [#4311](https://github.com/ashlrai/phantom/issues/4311) preservation ([#4682](https://github.com/ashlrai/phantom/issues/4682)) ([4ba8f63](https://github.com/ashlrai/phantom/commit/4ba8f631e31ed829edcda05b00bed3e8cf867389))
* **RQ-PHX-COMMSLIMITSROW83:** RQ-PHX-COMMSLIMITSROW83: comms limits row in Settings ([#4729](https://github.com/ashlrai/phantom/issues/4729)) ([0c2e56a](https://github.com/ashlrai/phantom/commit/0c2e56afb7730fa18897ebe5a431305c1589fa7f))
* **RQ-PHX-CONTEXTPACKPROOF10SRN2:** Context pack [#4304](https://github.com/ashlrai/phantom/issues/4304) preservation ([#4688](https://github.com/ashlrai/phantom/issues/4688)) ([b9a11ee](https://github.com/ashlrai/phantom/commit/b9a11ee77848734d0750575d5b7028de3a0b449b))
* **RQ-PHX-CREDITSLABELWHY83:** Credit reason labels ([#4727](https://github.com/ashlrai/phantom/issues/4727)) ([edd5c69](https://github.com/ashlrai/phantom/commit/edd5c69a71150bd644d7020a443b364792bb1e4a))
* **RQ-PHX-EMPTYRETRYPRESERVE10SRD1:** BRIDGE_NOTES: RQ-PHX-EMPTYRETRYPRESERVE10SRD1 ([#4635](https://github.com/ashlrai/phantom/issues/4635)) ([3f0684f](https://github.com/ashlrai/phantom/commit/3f0684f41e9c3bcb9a6cc37fb0b08d70b4a31b60))
* **RQ-PHX-FEEDRELEASEITEM82:** Release Feed observations ([#4721](https://github.com/ashlrai/phantom/issues/4721)) ([0ef01dc](https://github.com/ashlrai/phantom/commit/0ef01dc0eed7c6ef7ba567df975be165cbacbfad))
* **RQ-PHX-INTENTCONCURRENTWRITERS10SRW1:** BRIDGE_NOTES: RQ-PHX-INTENTCONCURRENTWRITERS10SRW1 ([#4731](https://github.com/ashlrai/phantom/issues/4731)) ([6fdf6b2](https://github.com/ashlrai/phantom/commit/6fdf6b2680f7afe53486699dc5e0eaaa81fbbcf8))
* **RQ-PHX-INTENTRELEASEREPLAY09SQV1:** Release evidence replay qualification ([#4656](https://github.com/ashlrai/phantom/issues/4656)) ([ff8889c](https://github.com/ashlrai/phantom/commit/ff8889c04c583317bbcdd6f6bf8865008740b0a4))
* **RQ-PHX-INTERJECTROUNDTRIP81:** RQ-PHX-INTERJECTROUNDTRIP81: Leader interject round trip ([#4718](https://github.com/ashlrai/phantom/issues/4718)) ([c4026ef](https://github.com/ashlrai/phantom/commit/c4026ef747329e4c9ed68752f54b77bf49bc0287))
* **RQ-PHX-LIBRARYPINCORE10SRL1:** Library pins recovery ([#4680](https://github.com/ashlrai/phantom/issues/4680)) ([b5fb563](https://github.com/ashlrai/phantom/commit/b5fb563d855c36f7b27c6b9cd0e13ed46465e3b1))
* **RQ-PHX-OUTCOMEEVALRECOVER10SRJ1:** BRIDGE_NOTES: RQ-PHX-OUTCOMEEVALRECOVER10SRJ1 ([#4687](https://github.com/ashlrai/phantom/issues/4687)) ([2ae9956](https://github.com/ashlrai/phantom/commit/2ae995617c2dda50eda2b7788005973db448fffd))
* **RQ-PHX-OWNERTHREADPRESERVE10SRV1:** BRIDGE_NOTES: RQ-PHX-OWNERTHREADPRESERVE10SRV1 ([#4730](https://github.com/ashlrai/phantom/issues/4730)) ([706a9ee](https://github.com/ashlrai/phantom/commit/706a9eedac2225f30886775f9797c9569b22b948))
* **RQ-PHX-PINCONTEXTRESTORE10SRQ1:** Context pack pin preservation handoff ([#4691](https://github.com/ashlrai/phantom/issues/4691)) ([30bb8d0](https://github.com/ashlrai/phantom/commit/30bb8d06bb550b50bd9bcc30f5af374d3f03925c))
* **RQ-PHX-QUEUELINTRECOVER10SRH1:** Queue lint recovery handoff ([#4657](https://github.com/ashlrai/phantom/issues/4657)) ([31e3ac1](https://github.com/ashlrai/phantom/commit/31e3ac1c1540608ce978a70c3056e43815d74a7e))
* **RQ-PHX-RECUTCLIVERB64:** BRIDGE_NOTES: RQ-PHX-RECUTCLIVERB64 ([#4640](https://github.com/ashlrai/phantom/issues/4640)) ([d2ef666](https://github.com/ashlrai/phantom/commit/d2ef6662aa4ad3fc00d6e31ee6477f1d7c526286))
* **RQ-PHX-RECUTCOMMSNEW68:** BRIDGE_NOTES: RQ-PHX-RECUTCOMMSNEW68 ([#4637](https://github.com/ashlrai/phantom/issues/4637)) ([3412dc9](https://github.com/ashlrai/phantom/commit/3412dc9e6faae5734450291f40140d05e1f5d878))
* **RQ-PHX-RECUTDESKLOWOLD70:** RQ-PHX-RECUTDESKLOWOLD70: recut of [#3154](https://github.com/ashlrai/phantom/issues/3154) (desktop forum boar ([#4645](https://github.com/ashlrai/phantom/issues/4645)) ([3a2cfc0](https://github.com/ashlrai/phantom/commit/3a2cfc0ed81c0d081bc8287fa5dff4ed9740f9b4))
* **RQ-PHX-RECUTDESKNEW68:** RQ-PHX-RECUTDESKNEW68: recut of [#4555](https://github.com/ashlrai/phantom/issues/4555) (RQ-PHX-DISKRUNWAYHOST ([#4643](https://github.com/ashlrai/phantom/issues/4643)) ([f4ef7b4](https://github.com/ashlrai/phantom/commit/f4ef7b49117a27194d780afa5c83a7a6667f5047))
* **RQ-PHX-RECUTDESKNEW71:** RQ-PHX-RECUTDESKNEW71 ([#4659](https://github.com/ashlrai/phantom/issues/4659)) ([e8aac10](https://github.com/ashlrai/phantom/commit/e8aac1086ba16d5bbd2aeebe2e831aaf7beeb4f3))
* **RQ-PHX-RECUTDESKOLD71:** BRIDGE_NOTES: RQ-PHX-RECUTDESKOLD71 ([#4662](https://github.com/ashlrai/phantom/issues/4662)) ([274b6e4](https://github.com/ashlrai/phantom/commit/274b6e497827297ddd02bb0ad77969a94a1d830c))
* **RQ-PHX-RECUTLEADERDESK65:** RQ-PHX-RECUTLEADERDESK65: recut of [#4355](https://github.com/ashlrai/phantom/issues/4355) (RQ-PHX-LEADERBRIEF ([#4642](https://github.com/ashlrai/phantom/issues/4642)) ([a636788](https://github.com/ashlrai/phantom/commit/a636788cc27660363769937153e2727e8644fb72))
* **RQ-PHX-RECUTLEADERDESKNEW72:** Bridge notes ([#4668](https://github.com/ashlrai/phantom/issues/4668)) ([ec08309](https://github.com/ashlrai/phantom/commit/ec0830986682c15c785a49181b72eb7363b96b33))
* **RQ-PHX-RECUTN2R4350S76:** RQ-PHX-RECUTN2R4350S76: recut of [#4362](https://github.com/ashlrai/phantom/issues/4362) (Ask Leader from Feed ([#4689](https://github.com/ashlrai/phantom/issues/4689)) ([df9960e](https://github.com/ashlrai/phantom/commit/df9960e966ea647232274017ebd375e93a86c7cb))
* **RQ-PHX-RECUTN4350S74:** RQ-PHX-RECUTN4350S74 ([#4679](https://github.com/ashlrai/phantom/issues/4679)) ([2b35b8c](https://github.com/ashlrai/phantom/commit/2b35b8c6ba4d2bb89cf6de78a1cddc1e10a76056))
* **RQ-PHX-RECUTN4R2000S79:** BRIDGE_NOTES: RQ-PHX-RECUTN4R2000S79 ([#4703](https://github.com/ashlrai/phantom/issues/4703)) ([10728d5](https://github.com/ashlrai/phantom/commit/10728d5009acfa447546ac734f452de3243d9235))
* **RQ-PHX-RECUTN4R3300S79:** BRIDGE_NOTES: RQ-PHX-RECUTN4R3300S79 ([#4711](https://github.com/ashlrai/phantom/issues/4711)) ([5b1c280](https://github.com/ashlrai/phantom/commit/5b1c28033c7e606d593214b9a790987caf1cb8af))
* **RQ-PHX-RECUTN4R3900S79:** BRIDGE_NOTES: RQ-PHX-RECUTN4R3900S79 ([#4700](https://github.com/ashlrai/phantom/issues/4700)) ([c8771dd](https://github.com/ashlrai/phantom/commit/c8771dd6e15415c9e3051f600fcc2d33557a8f8c))
* **RQ-PHX-RECUTN4R4350S79:** BRIDGE_NOTES: RQ-PHX-RECUTN4R4350S79 ([#4705](https://github.com/ashlrai/phantom/issues/4705)) ([7d928d2](https://github.com/ashlrai/phantom/commit/7d928d2e72917cee9cf556c12acf39aee4ed7667))
* **RQ-PHX-RECUTN5R4480S84:** Recut handoff ([#4732](https://github.com/ashlrai/phantom/issues/4732)) ([8da86bc](https://github.com/ashlrai/phantom/commit/8da86bcd538bc37cddf60a4b8dc729ca5bf128ba))
* **RQ-PHX-RECUTO2R4350S75:** RQ-PHX-RECUTO2R4350S75 ([#4684](https://github.com/ashlrai/phantom/issues/4684)) ([8a8ffa6](https://github.com/ashlrai/phantom/commit/8a8ffa6bc34d78c1bd16680bb30fac4cae4785f5))
* **RQ-PHX-RECUTO3R2000S78:** Supersedes [#2884](https://github.com/ashlrai/phantom/issues/2884) ([#4695](https://github.com/ashlrai/phantom/issues/4695)) ([e6182c6](https://github.com/ashlrai/phantom/commit/e6182c6b68a552cb2a2dd3f8e03368d1893d36b3))
* **RQ-PHX-RECUTO3R4050S78:** RQ-PHX-RECUTO3R4050S78 ([#4693](https://github.com/ashlrai/phantom/issues/4693)) ([7486b02](https://github.com/ashlrai/phantom/commit/7486b0212cf5df2c3203c8181717be18d6e1e9fc))
* **RQ-PHX-RECUTO4R2000S80:** Bridge notes: selection blocked ([#4709](https://github.com/ashlrai/phantom/issues/4709)) ([e900c0b](https://github.com/ashlrai/phantom/commit/e900c0b3cd54d02781240290c499dd1a06fb0ef5))
* **RQ-PHX-RECUTO4R3000S80:** Bridge notes ([#4710](https://github.com/ashlrai/phantom/issues/4710)) ([6fb9d9c](https://github.com/ashlrai/phantom/commit/6fb9d9ca8a79b8d6322121297554942327e4c8f3))
* **RQ-PHX-RECUTO4R3300S80:** RQ-PHX-RECUTO4R3300S80 ([#4712](https://github.com/ashlrai/phantom/issues/4712)) ([5af27df](https://github.com/ashlrai/phantom/commit/5af27df7027d690cbf28ccc94e84ebf677f03507))
* **RQ-PHX-RECUTOLDG60:** BRIDGE_NOTES: RQ-PHX-RECUTOLDG60 ([#4654](https://github.com/ashlrai/phantom/issues/4654)) ([0ecec5e](https://github.com/ashlrai/phantom/commit/0ecec5e574ba29c57d05e000dd659f69b6d27183))
* **RQ-PHX-RECUTPR4500NEW71:** Bridge notes ([#4658](https://github.com/ashlrai/phantom/issues/4658)) ([669d4ff](https://github.com/ashlrai/phantom/commit/669d4fff44bb6dd0cf83a3cf47837ea59bd54ec7))
* **RQ-PHX-RECUTQUEUE63:** RQ-PHX-RECUTQUEUE63 ([#4648](https://github.com/ashlrai/phantom/issues/4648)) ([02b28e0](https://github.com/ashlrai/phantom/commit/02b28e092891d6cda9f05788871979f84af9bd26))
* **RQ-PHX-REDTYPEFIXSECOND78:** Supersedes [#4352](https://github.com/ashlrai/phantom/issues/4352) ([#4694](https://github.com/ashlrai/phantom/issues/4694)) ([c814319](https://github.com/ashlrai/phantom/commit/c81431910fa9bb4c6d4f2d5ff808a7abd57d6fde))
* **RQ-PHX-RELAYRESTARTPROOF10SRT1:** Leader reply relay restart preservation ([#4708](https://github.com/ashlrai/phantom/issues/4708)) ([e9e2797](https://github.com/ashlrai/phantom/commit/e9e2797c35363fb70f2d68cb18384796c922c2d1))
* **RQ-PHX-SLACKSTATUSPROOF71:** Slack status round-trip proof ([#4666](https://github.com/ashlrai/phantom/issues/4666)) ([078c55e](https://github.com/ashlrai/phantom/commit/078c55e1f56819dadbf620cd9bfcc1e252914398))
* **RQ-PHX-THREADCHANNELCHIP82:** Already on master: src/web-ui/routes/verse/leader-thread/Lea ([#4720](https://github.com/ashlrai/phantom/issues/4720)) ([7e7712b](https://github.com/ashlrai/phantom/commit/7e7712be335b7a72bca5a75c829b8554ceef8e6c))
* **RQ-PHX-UISTOREOLDSTATE82:** RQ-PHX-UISTOREOLDSTATE82: 3.30.x console opens on 3.29.15 p ([#4724](https://github.com/ashlrai/phantom/issues/4724)) ([00d7961](https://github.com/ashlrai/phantom/commit/00d7961158d01f3c0d1f8e1b44a26a0ca4302d39))
* **RQ-PHX-UPDATEFEEDTRUTH81:** Update feed truth ([#4713](https://github.com/ashlrai/phantom/issues/4713)) ([60ca23a](https://github.com/ashlrai/phantom/commit/60ca23ae7ef4b2972258cd04c48f86a88e1ae4d3))
* **RQ-PHX-UPDATEKEEPSFLEETNOTE83:** BRIDGE_NOTES: RQ-PHX-UPDATEKEEPSFLEETNOTE83 ([#4728](https://github.com/ashlrai/phantom/issues/4728)) ([60635ca](https://github.com/ashlrai/phantom/commit/60635cad697890acff25db2d2e35044c463b6bb3))
* **RQ-REBASE-PH-17:** RQ-REBASE-PH-17 bridge notes ([#4023](https://github.com/ashlrai/phantom/issues/4023)) ([720e05c](https://github.com/ashlrai/phantom/commit/720e05c2871ad26a1e7f5cb2dab28de8d2fe8b60))
* **RQ-RELEASE-ISOLATED-BUILD-1:** BRIDGE_NOTES: RQ-RELEASE-ISOLATED-BUILD-1 ([#4677](https://github.com/ashlrai/phantom/issues/4677)) ([9680d22](https://github.com/ashlrai/phantom/commit/9680d22d4416a37bb51b9568f3bfc0d68490f920))
* **RQ-ROUTER-HARDSTEP-1:** RQ-ROUTER-HARDSTEP-1 handoff ([#4676](https://github.com/ashlrai/phantom/issues/4676)) ([a2068ab](https://github.com/ashlrai/phantom/commit/a2068ab9d0287e75eb2a55cd6c87ac601e46f144))

## [3.30.31] - 2026-11-10


### Fixes

* **ci:** fail the quick job when generated files are stale ([#4612](https://github.com/ashlrai/phantom/issues/4612)) ([bfc5371](https://github.com/ashlrai/phantom/commit/bfc5371ea103335deddacf1087e814d7f4e17817))
* **release-train:** dispatch tag-ref builds with the App token ([#4607](https://github.com/ashlrai/phantom/issues/4607)) ([a8c04fe](https://github.com/ashlrai/phantom/commit/a8c04fe4a5fbcf4edbd0ac8e8f1e0a4dab946088))
* **release:** dispatch with GITHUB_TOKEN, drop actions perm from App mints (fix-forward [#4607](https://github.com/ashlrai/phantom/issues/4607)) ([#4608](https://github.com/ashlrai/phantom/issues/4608)) ([751ef03](https://github.com/ashlrai/phantom/commit/751ef03a1fd130db129fceaa242e9c35a0bfedec))


### Changes

* **RQ-PH-NOTHROTTLE-1:** RQ-PH-NOTHROTTLE-1 ([#4601](https://github.com/ashlrai/phantom/issues/4601)) ([e2e5b81](https://github.com/ashlrai/phantom/commit/e2e5b815af78ef4d2d0cd9b176968be7050dff10))
* **RQ-PHX-INTENTSWEEPPRESERVE09SQR1:** Handoff ([#4606](https://github.com/ashlrai/phantom/issues/4606)) ([2180322](https://github.com/ashlrai/phantom/commit/2180322788b43032610b1b04e9794b4d78b24cd8))
* **RQ-PHX-RECUTOLDA60:** BRIDGE_NOTES: RQ-PHX-RECUTOLDA60 ([#4602](https://github.com/ashlrai/phantom/issues/4602)) ([3261d5f](https://github.com/ashlrai/phantom/commit/3261d5ffc0f82e1fa4e340f2c7f0586a7729c596))
* **RQ-PHX-RECUTOLDB60:** BRIDGE_NOTES: RQ-PHX-RECUTOLDB60 ([#4605](https://github.com/ashlrai/phantom/issues/4605)) ([99b3d17](https://github.com/ashlrai/phantom/commit/99b3d17a1c9f6704f1fad9de5cd1d47635ae5b95))
* **RQ-PHX-RECUTOLDE60:** RQ-PHX-RECUTOLDE60: recut of [#4259](https://github.com/ashlrai/phantom/issues/4259) (RQ-PHX-RECONCILEDECLINE0 ([#4604](https://github.com/ashlrai/phantom/issues/4604)) ([321c625](https://github.com/ashlrai/phantom/commit/321c6258ba55381c6a8c77bf6828425f23e4b65e))

## [3.30.30] - 2026-11-10


### Fixes

* **release-train:** do not treat pending or later check suites as red ([#4585](https://github.com/ashlrai/phantom/issues/4585)) ([f19e152](https://github.com/ashlrai/phantom/commit/f19e1521e6122b53a0dc413c7b6415bd984faf2f))
* **release-train:** drop buildCooldown, fixed waits, and the hourly enqueue floor ([#4592](https://github.com/ashlrai/phantom/issues/4592)) ([3f9d769](https://github.com/ashlrai/phantom/commit/3f9d769dd7eb191821759d400b3a5e3b2c305e02))
* **site-freshness:** admit Fable 5.2 Claude catalog labels ([#4594](https://github.com/ashlrai/phantom/issues/4594)) ([8368998](https://github.com/ashlrai/phantom/commit/836899844e9f4784fe764c8010b2e18da1dd6152))


### Changes

* **RQ-DEVIN-RADAR-CHANGELOG-1:** Add official Devin CLI and Desktop changelogs to radar ([#4595](https://github.com/ashlrai/phantom/issues/4595)) ([70185b4](https://github.com/ashlrai/phantom/commit/70185b46203d9ba3b827d043a17c8a1513738292))
* **RQ-DEVIN-UNIFY-ROSTER-1:** Show local and cloud Devin CLI sessions in the Phantom app r ([#4596](https://github.com/ashlrai/phantom/issues/4596)) ([b38ee69](https://github.com/ashlrai/phantom/commit/b38ee6900420f513f9988efe690261a992556a9c))
* **RQ-DRAIN-4128:** RQ-DRAIN-4128 handoff ([#4559](https://github.com/ashlrai/phantom/issues/4559)) ([92811ff](https://github.com/ashlrai/phantom/commit/92811ff1eff6c360bdddd7acf8bdf6f9767cc1cd))
* **RQ-FT-TOOLDRILL-7:** RQ-FT-TOOLDRILL-7 handoff ([#4573](https://github.com/ashlrai/phantom/issues/4573)) ([f5b929a](https://github.com/ashlrai/phantom/commit/f5b929aa1881785378b9361e9d2fb0abc6f03349))
* **RQ-GUARDIANHEALTHN9Q8:** BRIDGE_NOTES — RQ-GUARDIANHEALTHN9Q8 ([#4561](https://github.com/ashlrai/phantom/issues/4561)) ([44eada4](https://github.com/ashlrai/phantom/commit/44eada4c023cddf6a881c605fd72e25dec934b5b))
* **RQ-MERGEBLOCKERSQ8:** BRIDGE_NOTES: RQ-MERGEBLOCKERSQ8 ([#4576](https://github.com/ashlrai/phantom/issues/4576)) ([62e2cea](https://github.com/ashlrai/phantom/commit/62e2cea98a73f6b2cd37ac803716f17284d5c73e))
* **RQ-MERGEWAITN9Q8:** BRIDGE_NOTES — RQ-MERGEWAITN9Q8 ([#4563](https://github.com/ashlrai/phantom/issues/4563)) ([06953fb](https://github.com/ashlrai/phantom/commit/06953fb4bf7700091592d79b25ac8c65a2483438))
* **RQ-METRICSTRUTHN9Q8:** Bridge notes ([#4560](https://github.com/ashlrai/phantom/issues/4560)) ([9948f55](https://github.com/ashlrai/phantom/commit/9948f55c742f88ef3db6349d6bf7595d3a2f8ab9))
* **RQ-PHX-CHECKSPANEHONEST56:** BRIDGE_NOTES — RQ-PHX-CHECKSPANEHONEST56 ([#4569](https://github.com/ashlrai/phantom/issues/4569)) ([422a788](https://github.com/ashlrai/phantom/commit/422a7885c4707af96fb0b8152636eef9e903fca4))
* **RQ-PHX-DIRTYPHXNEWEST57:** RQ-PHX-DIRTYPHXNEWEST57 — bridge notes ([#4582](https://github.com/ashlrai/phantom/issues/4582)) ([9189dc3](https://github.com/ashlrai/phantom/commit/9189dc3d889efa3faabe4a9cf2635c42b95d5ab7))
* **RQ-PHX-DIRTYPHXRECUT55:** RQ-PHX-DIRTYPHXRECUT55: recut of [#4290](https://github.com/ashlrai/phantom/issues/4290) (RQ-PHX-OWNERTHREADDE ([#4571](https://github.com/ashlrai/phantom/issues/4571)) ([03d6bfc](https://github.com/ashlrai/phantom/commit/03d6bfce3f974a9d68edb6adc5ca2186885900fe))
* **RQ-PHX-DIRTYPHXRECUT57:** BRIDGE_NOTES: RQ-PHX-DIRTYPHXRECUT57 ([#4579](https://github.com/ashlrai/phantom/issues/4579)) ([d49206e](https://github.com/ashlrai/phantom/commit/d49206e41ae5f5e35569113deb0982fb4fb231e6))
* **RQ-PHX-FEEDNEWSINCE53:** RQ-PHX-FEEDNEWSINCE53: Feed marks what is new since last loo ([#4558](https://github.com/ashlrai/phantom/issues/4558)) ([c074463](https://github.com/ashlrai/phantom/commit/c074463332a34f0ad0a6005c5a096d072018ab79))
* **RQ-PHX-FEEDOPENPANE57:** RQ-PHX-FEEDOPENPANE57: Feed items open the pane that owns th ([#4580](https://github.com/ashlrai/phantom/issues/4580)) ([400cfdd](https://github.com/ashlrai/phantom/commit/400cfdd964fec0a16355303adb1a9e5a4b13f48d))
* **RQ-PHX-INTENTEXPORTAUDIT09SQM2:** Intent preservation evidence refresh ([#4583](https://github.com/ashlrai/phantom/issues/4583)) ([d4c200f](https://github.com/ashlrai/phantom/commit/d4c200f5fbb1487b573aca14576a230748f697cb))
* **RQ-PHX-INTENTIMPORTJOIN09SQJ1:** Intent import join evidence bridge ([#4566](https://github.com/ashlrai/phantom/issues/4566)) ([933b952](https://github.com/ashlrai/phantom/commit/933b952237a5363f4ad35ec97d2fa175c1137309))
* **RQ-PHX-INTENTNATIVEIMPORT09SQM1:** BRIDGE_NOTES — RQ-PHX-INTENTNATIVEIMPORT09SQM1 ([#4586](https://github.com/ashlrai/phantom/issues/4586)) ([f68e83e](https://github.com/ashlrai/phantom/commit/f68e83e0a41ea02553534e9baf52badb1134f3a5))
* **RQ-PHX-INTENTUNIFIEDLIFECYCLE09SQK1:** Unified intent lifecycle qualification ([#4570](https://github.com/ashlrai/phantom/issues/4570)) ([aabcd2d](https://github.com/ashlrai/phantom/commit/aabcd2d515243aa6b1800e1aadd4e62695f86a0b))
* **RQ-PHX-LAUNCHSTALLBANNER57:** RQ-PHX-LAUNCHSTALLBANNER57: the Lanes pane says when the fle ([#4581](https://github.com/ashlrai/phantom/issues/4581)) ([49ee2cf](https://github.com/ashlrai/phantom/commit/49ee2cf8968266c6975d1972c214c53702d65907))
* **RQ-PHX-LEADERDRAFTKEEP53:** RQ-PHX-LEADERDRAFTKEEP53 — Leader drafts persist ([#4564](https://github.com/ashlrai/phantom/issues/4564)) ([f07ae64](https://github.com/ashlrai/phantom/commit/f07ae649a6cb5e16f51c550a3d9ddb65ad344f2b))
* **RQ-PHX-NEEDSYOUHARDLIMIT55:** RQ-PHX-NEEDSYOUHARDLIMIT55: hard-limit chips in the Needs-yo ([#4568](https://github.com/ashlrai/phantom/issues/4568)) ([0f6f3d3](https://github.com/ashlrai/phantom/commit/0f6f3d393c2c6ffdbc381b38960ca2bd8b8a6639))
* **RQ-PHX-PANESSERVERDOWN56:** BRIDGE_NOTES — RQ-PHX-PANESSERVERDOWN56 ([#4574](https://github.com/ashlrai/phantom/issues/4574)) ([130285b](https://github.com/ashlrai/phantom/commit/130285b367c6ac48debe95d46a5c5c3830e219db))
* **RQ-PHX-RECUTNONPHX59:** RQ-PHX-RECUTNONPHX59: recut of [#4552](https://github.com/ashlrai/phantom/issues/4552) (RQ-IMSGLEADERN9SQ8) ([#4589](https://github.com/ashlrai/phantom/issues/4589)) ([c554ded](https://github.com/ashlrai/phantom/commit/c554dedbf5d0716eeac4a5ca2a85c33921ad72d6))
* **RQ-PHX-RECUTRANGED58:** BRIDGE_NOTES — RQ-PHX-RECUTRANGED58 ([#4584](https://github.com/ashlrai/phantom/issues/4584)) ([e1794bf](https://github.com/ashlrai/phantom/commit/e1794bf94747c80388b796d0edee651a122bd24c))
* **RQ-PHX-RECUTRANGEE58:** BRIDGE_NOTES: RQ-PHX-RECUTRANGEE58 ([#4587](https://github.com/ashlrai/phantom/issues/4587)) ([dbb28e8](https://github.com/ashlrai/phantom/commit/dbb28e85c2c6ff65b12a25e759ad2b15fda291a8))
* **RQ-RELEASE-SMOKE-CLEANTREE-1:** Release smoke clean-tree handoff ([#4562](https://github.com/ashlrai/phantom/issues/4562)) ([7b36f35](https://github.com/ashlrai/phantom/commit/7b36f35cb626bfc179abe37a15753b05337285fc))
* **RQ-SEC-SANDBOX-LOGSTREAM-1:** Reap sandbox log-stream watchers on wrapper death ([#4597](https://github.com/ashlrai/phantom/issues/4597)) ([1995a07](https://github.com/ashlrai/phantom/commit/1995a07ead525ede445eccadf60fbfdaffcc1fc0))
* **RQ-YIELDTRIAGEN9Q8:** BRIDGE_NOTES — RQ-YIELDTRIAGEN9Q8 ([#4572](https://github.com/ashlrai/phantom/issues/4572)) ([16e2eb7](https://github.com/ashlrai/phantom/commit/16e2eb7f048ac0d3d4060ecbb427019f26455654))

## [3.30.29] - 2026-11-09


### Fixes

* **master:** Comms owner files use the account home ([#4269](https://github.com/ashlrai/phantom/issues/4269)) ([7f7e89b](https://github.com/ashlrai/phantom/commit/7f7e89b46c92e3ebb7c242626114dc28baed6b9e))
* **master:** count the three Comms MCP tools in the output budget. ([#4252](https://github.com/ashlrai/phantom/issues/4252)) ([1b5794b](https://github.com/ashlrai/phantom/commit/1b5794bb07de5946f98c3a95a43776e942d39d92))


### Changes

* **FIXUP-CI-phantom-release-train-160006:** FIXUP-CI release train ([#4251](https://github.com/ashlrai/phantom/issues/4251)) ([183015d](https://github.com/ashlrai/phantom/commit/183015dddd45e2d3cb1ec90f5056949f8e7ecc3b))
* **FIXUP-MAIN-phantom-71e72cc-r2:** FIXUP-MAIN-phantom-71e72cc-r2 ([#4312](https://github.com/ashlrai/phantom/issues/4312)) ([6fbafab](https://github.com/ashlrai/phantom/commit/6fbafabb006c46ba04263b9e676cabd1fca91357))
* **FIXUP-MAIN-phantom-71e72cc:** FIXUP-MAIN-phantom-71e72cc ([#4291](https://github.com/ashlrai/phantom/issues/4291)) ([01ce5ca](https://github.com/ashlrai/phantom/commit/01ce5ca86d72ff7164f51f7c4495137f0d03b6fc))
* **FIXUP-MAIN-phantom-b4b6e4b:** FIXUP-MAIN-phantom-b4b6e4b ([#4278](https://github.com/ashlrai/phantom/issues/4278)) ([0e3eb19](https://github.com/ashlrai/phantom/commit/0e3eb1950974e3e26d0a24c269e5023f6ad301f4))
* **FIXUP-MAIN-phantom-d04e3a7-r2:** FIXUP-MAIN-phantom-d04e3a7-r2 ([#4327](https://github.com/ashlrai/phantom/issues/4327)) ([8a90e1d](https://github.com/ashlrai/phantom/commit/8a90e1d280bf6794549f522cb6b591085d6390d3))
* **FIXUP-MAIN-phantom-d04e3a7:** FIXUP-MAIN-phantom-d04e3a7 ([#4320](https://github.com/ashlrai/phantom/issues/4320)) ([b22cef2](https://github.com/ashlrai/phantom/commit/b22cef29b2c0cba1e19c5a3a865b9ebd77656d95))
* **RQ-AGENTEDGES3N9LQ8:** Bridge notes ([#4389](https://github.com/ashlrai/phantom/issues/4389)) ([daeb9c2](https://github.com/ashlrai/phantom/commit/daeb9c269789f97232e745d6e0acdbf2c2ea84d4))
* **RQ-APPTRUTH-6-SPLIT:** RQ-APPTRUTH-6-SPLIT ([#4229](https://github.com/ashlrai/phantom/issues/4229)) ([5ad89a9](https://github.com/ashlrai/phantom/commit/5ad89a999fc2b8d678febc9fff8024c4e30f9a8c))
* **RQ-AUTHORITY-REGEN-1:** RQ-AUTHORITY-REGEN-1 ([#4228](https://github.com/ashlrai/phantom/issues/4228)) ([765210b](https://github.com/ashlrai/phantom/commit/765210b0d4714dd69707e7be548b6eff19d9b50e))
* **RQ-BUS-LIVE-RT-CODEX-DEVIN-R2:** Bus reachability check ([#4237](https://github.com/ashlrai/phantom/issues/4237)) ([071716a](https://github.com/ashlrai/phantom/commit/071716ae48fb2f82b2e037c85d79ec2ef3393885))
* **RQ-BUS-ROSTER-CLAIMSTORE-R2:** Bridge notes ([#4241](https://github.com/ashlrai/phantom/issues/4241)) ([555c1f3](https://github.com/ashlrai/phantom/commit/555c1f3b1f54802f37f81ef65be0fe1ef7e0567d))
* **RQ-CI-HELP-FLAKE-1:** RQ-CI-HELP-FLAKE-1 ([#4330](https://github.com/ashlrai/phantom/issues/4330)) ([aa473f2](https://github.com/ashlrai/phantom/commit/aa473f2f5cf5486e5ee6e67bd043323386797ac0))
* **RQ-DESKTOP-PERF:** RQ-DESKTOP-PERF — measure, then fix, Phantom desktop startup ([#4294](https://github.com/ashlrai/phantom/issues/4294)) ([9531e03](https://github.com/ashlrai/phantom/commit/9531e03834ea2960ac5e4bf396afd93de925d734))
* **RQ-DISKBURNN9CQ8:** Disk growth handoff ([#4257](https://github.com/ashlrai/phantom/issues/4257)) ([1ab7b0f](https://github.com/ashlrai/phantom/commit/1ab7b0fd9491f7f1dd47e262a1233a02cb822072))
* **RQ-DISKFORECASTQ8:** RQ-DISKFORECASTQ8 ([#4374](https://github.com/ashlrai/phantom/issues/4374)) ([2edfd39](https://github.com/ashlrai/phantom/commit/2edfd39e0fad3f83afca7ea2f14f46b54842c345))
* **RQ-DISKPRESSURE9Q8:** Bridge notes ([#4342](https://github.com/ashlrai/phantom/issues/4342)) ([e0d9ea2](https://github.com/ashlrai/phantom/commit/e0d9ea21fc08785756e611d6ec92d81281519f17))
* **RQ-EMPTYTOP2N9LQ8:** RQ-EMPTYTOP2N9LQ8 ([#4388](https://github.com/ashlrai/phantom/issues/4388)) ([dd76beb](https://github.com/ashlrai/phantom/commit/dd76beb11bd24e9c77c617bac16d40cb876fe414))
* **RQ-EMPTYWHYN9JQ8:** RQ-EMPTYWHYN9JQ8 ([#4358](https://github.com/ashlrai/phantom/issues/4358)) ([dafbf32](https://github.com/ashlrai/phantom/commit/dafbf320baf6817207cd3a77e9036e2a8f3b98cd))
* **RQ-FLEETDEPLOYN9FQ8:** RQ-FLEETDEPLOYN9FQ8 ([#4305](https://github.com/ashlrai/phantom/issues/4305)) ([fef7637](https://github.com/ashlrai/phantom/commit/fef76371c65f25ce6cba8f9011d770726f5ee40e))
* **RQ-GUARDIANHEALTH9Q8:** Guardian health handoff ([#4390](https://github.com/ashlrai/phantom/issues/4390)) ([ca2c268](https://github.com/ashlrai/phantom/commit/ca2c268e0301d4881657865294108578479bfbfa))
* **RQ-HELPSNAPN9KQ8:** RQ-HELPSNAPN9KQ8: README command table snapshot test ([#4393](https://github.com/ashlrai/phantom/issues/4393)) ([59d5f1e](https://github.com/ashlrai/phantom/commit/59d5f1e72cf3738bacce8994fcc69734d432f63e))
* **RQ-LANE-GLM-LITE-1:** RQ-LANE-GLM-LITE-1 ([#4247](https://github.com/ashlrai/phantom/issues/4247)) ([f2fd596](https://github.com/ashlrai/phantom/commit/f2fd59646bf140c529942296526b84c6c07a1f45))
* **RQ-LEADERRELAYN9KQ8:** RQ-LEADERRELAYN9KQ8 ([#4370](https://github.com/ashlrai/phantom/issues/4370)) ([f0075ba](https://github.com/ashlrai/phantom/commit/f0075ba8ed6ea67acd4c118dd0b85199886dee1d))
* **RQ-LEADERTHREADN9HQ8:** RQ-LEADERTHREADN9HQ8 ([#4322](https://github.com/ashlrai/phantom/issues/4322)) ([ae98f5e](https://github.com/ashlrai/phantom/commit/ae98f5e4ccb406a7739246be4ebc3964e6e10031))
* **RQ-MA-SESSIONS-1:** RQ-MA-SESSIONS-1: resumable agent sessions ([#4289](https://github.com/ashlrai/phantom/issues/4289)) ([536952b](https://github.com/ashlrai/phantom/commit/536952bcae1a0cc570a816738ed157b9428f1882))
* **RQ-MERGELATENCY9Q8:** Bridge notes ([#4340](https://github.com/ashlrai/phantom/issues/4340)) ([ed0cb7a](https://github.com/ashlrai/phantom/commit/ed0cb7aa60cf3a74c9daf1d42632060e3e308ea0))
* **RQ-MERGELATNOV9Q8:** RQ-MERGELATNOV9Q8 ([#4276](https://github.com/ashlrai/phantom/issues/4276)) ([269f23d](https://github.com/ashlrai/phantom/commit/269f23d372f9b8e88c781f43a58de59f5ddba274))
* **RQ-PAIDDENYN9DQ8:** Bridge notes ([#4273](https://github.com/ashlrai/phantom/issues/4273)) ([b916e2a](https://github.com/ashlrai/phantom/commit/b916e2a9d86d242f84447feb54f07ca612b072c9))
* **RQ-PH-MCP-SHARDSEL-1:** RQ-PH-MCP-SHARDSEL-1 handoff ([#4245](https://github.com/ashlrai/phantom/issues/4245)) ([79fdc23](https://github.com/ashlrai/phantom/commit/79fdc23ed7c4fc9cba5ea3fac415fd760078e1e8))
* **RQ-PH-SHARDED-NOBAIL-1R2:** RQ-PH-SHARDED-NOBAIL-1R2 handoff ([#4285](https://github.com/ashlrai/phantom/issues/4285)) ([71e72cc](https://github.com/ashlrai/phantom/commit/71e72cc7affcc96a48941eed5666dd92adf9e39f))
* **RQ-PH-SHARDED-NOBAIL-1:** Sharded runner handoff ([#4270](https://github.com/ashlrai/phantom/issues/4270)) ([fd242f8](https://github.com/ashlrai/phantom/commit/fd242f8d2a31b17d58ce68f29053f5f3418d98fe))
* **RQ-PHREDBLAMEN9IQ8:** RQ-PHREDBLAMEN9IQ8: `phm main blame` ([#4338](https://github.com/ashlrai/phantom/issues/4338)) ([78ac823](https://github.com/ashlrai/phantom/commit/78ac82365930a902ddf2cc96eb7357e5c6b02780))
* **RQ-PHTYPEGATEN9IQ8:** RQ-PHTYPEGATEN9IQ8 ([#4334](https://github.com/ashlrai/phantom/issues/4334)) ([768e47f](https://github.com/ashlrai/phantom/commit/768e47f0f156609f761bdcf4f907ffda122932c4))
* **RQ-PHX-APPSWATCHATTEMPT03SONZ1:** Bridge notes ([#3163](https://github.com/ashlrai/phantom/issues/3163)) ([74e369a](https://github.com/ashlrai/phantom/commit/74e369a68fac53f71be4b2258f05314714c5ec4a))
* **RQ-PHX-CAPABILITYGAPSDESK16:** RQ-PHX-CAPABILITYGAPSDESK16 ([#4376](https://github.com/ashlrai/phantom/issues/4376)) ([6d17690](https://github.com/ashlrai/phantom/commit/6d176901cc61d3de5cb75e5727e3e1f33ef44af5))
* **RQ-PHX-COMPOSERSLASH11:** RQ-PHX-COMPOSERSLASH11: slash commands in the Leader compose ([#4364](https://github.com/ashlrai/phantom/issues/4364)) ([605bb0c](https://github.com/ashlrai/phantom/commit/605bb0c1ef5aeffe92cfdb3692c6c9b95c1a375b))
* **RQ-PHX-DEADROUTEAUDIT16:** RQ-PHX-DEADROUTEAUDIT16: dead desktop route audit ([#4377](https://github.com/ashlrai/phantom/issues/4377)) ([445d394](https://github.com/ashlrai/phantom/commit/445d39404d395a52e98edffe459f4d652200ace0))
* **RQ-PHX-FEEDBUSPRIORITY10:** RQ-PHX-FEEDBUSPRIORITY10 ([#4347](https://github.com/ashlrai/phantom/issues/4347)) ([2292046](https://github.com/ashlrai/phantom/commit/229204664de8a2ae9ad80139ef18b40319c5ac08))
* **RQ-PHX-FEEDDISMISS17:** RQ-PHX-FEEDDISMISS17: Feed items can be dismissed and stay d ([#4379](https://github.com/ashlrai/phantom/issues/4379)) ([8aa7a4a](https://github.com/ashlrai/phantom/commit/8aa7a4a8ce29a2d75a793b2c4bac30ddf56e2db4))
* **RQ-PHX-FEEDOWNERLINES09:** RQ-PHX-FEEDOWNERLINES09 ([#4309](https://github.com/ashlrai/phantom/issues/4309)) ([12ea4f1](https://github.com/ashlrai/phantom/commit/12ea4f1994b6b66b61f04d3ccefc1a7dffda3430))
* **RQ-PHX-FEEDUPDATEITEMS09:** RQ-PHX-FEEDUPDATEITEMS09 ([#4318](https://github.com/ashlrai/phantom/issues/4318)) ([85b5759](https://github.com/ashlrai/phantom/commit/85b575959e8148242cc044717c3c24675a61a1f7))
* **RQ-PHX-GMAILTRIAGELATEST19:** RQ-PHX-GMAILTRIAGELATEST19 ([#4397](https://github.com/ashlrai/phantom/issues/4397)) ([2e8afa6](https://github.com/ashlrai/phantom/commit/2e8afa676db0b43bdcecaaedd1a6ee8a00c6816c))
* **RQ-PHX-GMAILTRIAGEVERB18:** Gmail saved-mail triage ([#4381](https://github.com/ashlrai/phantom/issues/4381)) ([9f8d17f](https://github.com/ashlrai/phantom/commit/9f8d17f14867cbf35da5d271c94792f655877f04))
* **RQ-PHX-GOALDRIFTIDEAS10:** RQ-PHX-GOALDRIFTIDEAS10 ([#4336](https://github.com/ashlrai/phantom/issues/4336)) ([378ae36](https://github.com/ashlrai/phantom/commit/378ae367ff9abb29ed635d86a7f5e7086370ec52))
* **RQ-PHX-GOALSLIVEMETRIC09:** RQ-PHX-GOALSLIVEMETRIC09 ([#4323](https://github.com/ashlrai/phantom/issues/4323)) ([70c52d0](https://github.com/ashlrai/phantom/commit/70c52d096442884c18a4503ea53fcefd6cfae0ba))
* **RQ-PHX-GOALSPANE09:** RQ-PHX-GOALSPANE09: Goals pane for the /verse/ dock ([#4315](https://github.com/ashlrai/phantom/issues/4315)) ([25836a6](https://github.com/ashlrai/phantom/commit/25836a684bfec575e95570ddb36b3a259e502e4b))
* **RQ-PHX-GOALSTEER13:** RQ-PHX-GOALSTEER13: Steer a goal from the Goals pane ([#4357](https://github.com/ashlrai/phantom/issues/4357)) ([83cff25](https://github.com/ashlrai/phantom/commit/83cff251757324bca6d17c4b2facd5908feb3247))
* **RQ-PHX-HOMEKEYS11:** Home keyboard commands ([#4337](https://github.com/ashlrai/phantom/issues/4337)) ([3f5b0c1](https://github.com/ashlrai/phantom/commit/3f5b0c1aeb69928c428393caf958ed502c90be86))
* **RQ-PHX-IDEANEXTSTEER18:** RQ-PHX-IDEANEXTSTEER18 ([#4385](https://github.com/ashlrai/phantom/issues/4385)) ([2aff28d](https://github.com/ashlrai/phantom/commit/2aff28d7f583a05235ffb2e69e62edcad3db76b1))
* **RQ-PHX-IDEASPANE09:** RQ-PHX-IDEASPANE09: Ideas pane ([#4313](https://github.com/ashlrai/phantom/issues/4313)) ([c2dfd8a](https://github.com/ashlrai/phantom/commit/c2dfd8aa99a556c1055e00709164c958bf016df0))
* **RQ-PHX-IMSGHEALTHCARD16:** Bridge notes ([#4375](https://github.com/ashlrai/phantom/issues/4375)) ([4668f32](https://github.com/ashlrai/phantom/commit/4668f32cb5c8ea5dd2c8cce730f8f27826f3955e))
* **RQ-PHX-LEADERHOMEFIRST09:** RQ-PHX-LEADERHOMEFIRST09 ([#4328](https://github.com/ashlrai/phantom/issues/4328)) ([24e4544](https://github.com/ashlrai/phantom/commit/24e454464b5818417f6e9246189d556815f31fb8))
* **RQ-PHX-LEADERREPLYNOTIFY11:** RQ-PHX-LEADERREPLYNOTIFY11: notification when the Leader ans ([#4360](https://github.com/ashlrai/phantom/issues/4360)) ([3fdf81d](https://github.com/ashlrai/phantom/commit/3fdf81dc062ce7475f8d224a36343070edd47e30))
* **RQ-PHX-LEADERSCREENSHOT17:** RQ-PHX-LEADERSCREENSHOT17 ([#4380](https://github.com/ashlrai/phantom/issues/4380)) ([9f87d2c](https://github.com/ashlrai/phantom/commit/9f87d2c8478ed68abbad81b8b5c16db1fdb0b558))
* **RQ-PHX-LEADERTAILVERB12:** Bridge notes ([#4345](https://github.com/ashlrai/phantom/issues/4345)) ([d5b451b](https://github.com/ashlrai/phantom/commit/d5b451bdd4bd4481b63025b16ce683094776850f))
* **RQ-PHX-LEADERTHREADSEARCH12:** Leader thread search ([#4349](https://github.com/ashlrai/phantom/issues/4349)) ([59c980c](https://github.com/ashlrai/phantom/commit/59c980cdb177a011b703f98de1b6a5b6ab500c69))
* **RQ-PHX-LIBRARYBUSLIVE10:** RQ-PHX-LIBRARYBUSLIVE10: Library shows recent agent bus mess ([#4331](https://github.com/ashlrai/phantom/issues/4331)) ([aa8b9a6](https://github.com/ashlrai/phantom/commit/aa8b9a6a405cbb3c1f760c96d7da2599f4b15011))
* **RQ-PHX-LIBRARYOPENREF09:** Bridge notes ([#4321](https://github.com/ashlrai/phantom/issues/4321)) ([557cbe8](https://github.com/ashlrai/phantom/commit/557cbe860d30640c17bc06e2592627d5e7a3848d))
* **RQ-PHX-LIBRARYPANE09:** RQ-PHX-LIBRARYPANE09: Library pane ([#4310](https://github.com/ashlrai/phantom/issues/4310)) ([dd57d33](https://github.com/ashlrai/phantom/commit/dd57d33133d9ecbb543a6d5e3308869a9fc23c62))
* **RQ-PHX-LIVESLOWPRS09:** RQ-PHX-LIVESLOWPRS09 — Live status "Slow PRs" block + read-o ([#3401](https://github.com/ashlrai/phantom/issues/3401)) ([2d46a4d](https://github.com/ashlrai/phantom/commit/2d46a4d362e646c09aa8bd0bbb317d290ec3e993))
* **RQ-PHX-MASONMSGSTATE12:** RQ-PHX-MASONMSGSTATE12 ([#4353](https://github.com/ashlrai/phantom/issues/4353)) ([de9f47a](https://github.com/ashlrai/phantom/commit/de9f47ad32c3fa2fde6d5f7be2262937d4504d19))
* **RQ-PHX-NAVUNREADMARKS11:** RQ-PHX-NAVUNREADMARKS11: unread counts on Leader and Feed ([#4361](https://github.com/ashlrai/phantom/issues/4361)) ([27c641d](https://github.com/ashlrai/phantom/commit/27c641d103be6182923e83b2a31b08542ca981c4))
* **RQ-PHX-NEEDSMASONTRIAGEDESK09:** RQ-PHX-NEEDSMASONTRIAGEDESK09 ([#4314](https://github.com/ashlrai/phantom/issues/4314)) ([d04e3a7](https://github.com/ashlrai/phantom/commit/d04e3a7531b425855fe5ec11759c93cd0dc73108))
* **RQ-PHX-OWNERADAPTERNEXTSTEP09:** Bridge notes ([#4283](https://github.com/ashlrai/phantom/issues/4283)) ([a41928b](https://github.com/ashlrai/phantom/commit/a41928bb61207c1a7b54d3cee57363e0db248b49))
* **RQ-PHX-OWNERCHANNELSTRIP09:** Owner channel strip ([#4296](https://github.com/ashlrai/phantom/issues/4296)) ([1dc3083](https://github.com/ashlrai/phantom/commit/1dc30836e35a725557e3b5c1297cf9f136ce0f5e))
* **RQ-PHX-OWNERHISTORYREAD09:** Owner thread archive history ([#4316](https://github.com/ashlrai/phantom/issues/4316)) ([a1a3b2d](https://github.com/ashlrai/phantom/commit/a1a3b2d6dabaaae602b75094bd2dfc12efbd5ea1))
* **RQ-PHX-OWNERPULLVERB09:** Owner pull handoff ([#4295](https://github.com/ashlrai/phantom/issues/4295)) ([8814342](https://github.com/ashlrai/phantom/commit/8814342dde933ca68321381ef6d9a0a6923a97f1))
* **RQ-PHX-OWNERROUNDTRIP09:** RQ-PHX-OWNERROUNDTRIP09 ([#4298](https://github.com/ashlrai/phantom/issues/4298)) ([dcea224](https://github.com/ashlrai/phantom/commit/dcea2243272bd8c5eb337523a4fdc8324c1ebbc5))
* **RQ-PHX-OWNERTHREADPANE09:** RQ-PHX-OWNERTHREADPANE09: owner thread inline in the Leader ([#4287](https://github.com/ashlrai/phantom/issues/4287)) ([57affd7](https://github.com/ashlrai/phantom/commit/57affd7477c3736c6f895c0750b65bb4a3920a42))
* **RQ-PHX-OWNERTHREADROTATE09:** Owner thread rotation archives the oldest messages when eith ([#4302](https://github.com/ashlrai/phantom/issues/4302)) ([2ea5006](https://github.com/ashlrai/phantom/commit/2ea50062da0ecd15adca8d8ea214c930201a59c7))
* **RQ-PHX-OWNERTHREADSERVE16:** RQ-PHX-OWNERTHREADSERVE16 ([#4372](https://github.com/ashlrai/phantom/issues/4372)) ([eb05a13](https://github.com/ashlrai/phantom/commit/eb05a13c0eca16b6e39a3dc5ad1f88d29e94bee9))
* **RQ-PHX-PANEPICKERSECTIONS09:** RQ-PHX-PANEPICKERSECTIONS09 ([#4324](https://github.com/ashlrai/phantom/issues/4324)) ([fffab70](https://github.com/ashlrai/phantom/commit/fffab70efae7627bff29c68f54ba15bf695218fd))
* **RQ-PHX-PHONEOWNERLINES09:** RQ-PHX-PHONEOWNERLINES09 ([#4300](https://github.com/ashlrai/phantom/issues/4300)) ([a12ec34](https://github.com/ashlrai/phantom/commit/a12ec3418870b319a60df6fdf17d843a88f1023c))
* **RQ-PHX-RECONCILEAPPLAUNCH09SNV1:** BRIDGE_NOTES: RQ-PHX-RECONCILEAPPLAUNCH09SNV1 ([#4307](https://github.com/ashlrai/phantom/issues/4307)) ([f5fff31](https://github.com/ashlrai/phantom/commit/f5fff31d3f64cbebed1a1af36cfedf663179670e))
* **RQ-PHX-RECONCILEATTEMPTS09SNN2:** PR 4063 preservation ([#4272](https://github.com/ashlrai/phantom/issues/4272)) ([65c0338](https://github.com/ashlrai/phantom/commit/65c0338bd2e7d9ca0f476f047731115682d3de65))
* **RQ-PHX-RECONCILECAPABILITY09SNW1:** Capability audit reconciliation handoff ([#4311](https://github.com/ashlrai/phantom/issues/4311)) ([e0486b7](https://github.com/ashlrai/phantom/commit/e0486b7f541e15e3a78aac3d2adba58c812a2a72))
* **RQ-PHX-RECONCILECOCHANGES09SNT1:** Bridge preservation notes ([#4297](https://github.com/ashlrai/phantom/issues/4297)) ([f47ed68](https://github.com/ashlrai/phantom/commit/f47ed68536c37031b6f02b913b33bef67d946d17))
* **RQ-PHX-RECONCILECONTEXTPACK09SNU1:** Context-pack reconciliation handoff ([#4304](https://github.com/ashlrai/phantom/issues/4304)) ([938ee8d](https://github.com/ashlrai/phantom/commit/938ee8dc73873fac42afd2ff591992c30b3cf441))
* **RQ-PHX-RECONCILEDONEEVAL09SNX1:** RQ-PHX-RECONCILEDONEEVAL09SNX1: done-contract evaluator (sli ([#4317](https://github.com/ashlrai/phantom/issues/4317)) ([676c0e9](https://github.com/ashlrai/phantom/commit/676c0e98a0557565f6808b5b41bb86cd0ad0880d))
* **RQ-PHX-RECONCILEDONEPLAN09SNV2:** RQ-PHX-RECONCILEDONEPLAN09SNV2: done-contract parsing and pr ([#4308](https://github.com/ashlrai/phantom/issues/4308)) ([1d78d30](https://github.com/ashlrai/phantom/commit/1d78d3040ae6598e58a49e22a20f6ab239eca0a6))
* **RQ-PHX-RECONCILEDONESCHEMA09SNY1:** Done-contract schema reconciliation ([#4329](https://github.com/ashlrai/phantom/issues/4329)) ([a4e6cb6](https://github.com/ashlrai/phantom/commit/a4e6cb65ddc5bdca29649bfddfc36409b86b3b71))
* **RQ-PHX-RECONCILEDOTTTL09SNN1:** PR [#4059](https://github.com/ashlrai/phantom/issues/4059) preservation evidence ([#4271](https://github.com/ashlrai/phantom/issues/4271)) ([268b642](https://github.com/ashlrai/phantom/commit/268b6421c4104208d653df90664a622967c9f9b0))
* **RQ-PHX-RECONCILEEVENTREAD09SNQ1:** Event reader reconciliation ([#4282](https://github.com/ashlrai/phantom/issues/4282)) ([8d8f913](https://github.com/ashlrai/phantom/commit/8d8f91378e2e1448b0716d0b662d3fd262ebcc11))
* **RQ-PHX-RECONCILEINTENTEVIDENCE09SPA1:** BRIDGE_NOTES: RQ-PHX-RECONCILEINTENTEVIDENCE09SPA1 ([#4333](https://github.com/ashlrai/phantom/issues/4333)) ([09d6ff1](https://github.com/ashlrai/phantom/commit/09d6ff13a806d76d5c72043e0643c747f7703a08))
* **RQ-PHX-RECONCILEINTENTEVIDENCECLI09SPC2:** Intent evidence CLI bridge ([#4344](https://github.com/ashlrai/phantom/issues/4344)) ([46f4e26](https://github.com/ashlrai/phantom/commit/46f4e26401b89781a3879c0a104b188c12e946ca))
* **RQ-PHX-RECONCILEINTENTIMPORT09SPH1:** RQ-PHX-RECONCILEINTENTIMPORT09SPH1 ([#4378](https://github.com/ashlrai/phantom/issues/4378)) ([1ccd17b](https://github.com/ashlrai/phantom/commit/1ccd17b36b54e745041763181615d336c64b10e4))
* **RQ-PHX-RECONCILEINTENTMCP09SPJ1:** RQ-PHX-RECONCILEINTENTMCP09SPJ1 — fleet_intent_read ([#4383](https://github.com/ashlrai/phantom/issues/4383)) ([ae288c6](https://github.com/ashlrai/phantom/commit/ae288c6556e97b65a4bf09574a8e95a0cf743a9e))
* **RQ-PHX-RECONCILEINTENTQUALITY09SPJ2:** Bridge notes ([#4392](https://github.com/ashlrai/phantom/issues/4392)) ([f7a6ba5](https://github.com/ashlrai/phantom/commit/f7a6ba56b11eceee46b4cbe7d60222164484b8c1))
* **RQ-PHX-RECONCILEINTENTREAD09SPE1:** Intent read reconciliation handoff ([#4363](https://github.com/ashlrai/phantom/issues/4363)) ([4281ef4](https://github.com/ashlrai/phantom/commit/4281ef41e3eecfe62eac6ce061c179f57fa5fb51))
* **RQ-PHX-RECONCILEINTENTSTORE09SNZ1:** Intent store reconciliation ([#4326](https://github.com/ashlrai/phantom/issues/4326)) ([077cc60](https://github.com/ashlrai/phantom/commit/077cc601bd487cf57b15b3356c5975edc6e080ad))
* **RQ-PHX-RECONCILEINTENTSUMMARY09SPC1:** Intent summary reconciliation ([#4346](https://github.com/ashlrai/phantom/issues/4346)) ([7714a37](https://github.com/ashlrai/phantom/commit/7714a37ae63d082df144e41958c0e37f6dcf13df))
* **RQ-PHX-RECONCILEINTENTSWEEP09SPD1:** Intent sweep reconciliation: RQ-PHX-RECONCILEINTENTSWEEP09SP ([#4351](https://github.com/ashlrai/phantom/issues/4351)) ([8e33267](https://github.com/ashlrai/phantom/commit/8e33267fa7390c592cb77905f8ba7f5256148b69))
* **RQ-PHX-RECONCILENODES09SNU2:** Bridge handoff: node inventory slice ([#4301](https://github.com/ashlrai/phantom/issues/4301)) ([d38604d](https://github.com/ashlrai/phantom/commit/d38604dc8fe1e0e7488960acc0b6bc664990ed5d))
* **RQ-PHX-RECONCILEPINNEDMCP09STM2:** Bridge notes ([#4260](https://github.com/ashlrai/phantom/issues/4260)) ([0ed974c](https://github.com/ashlrai/phantom/commit/0ed974c160b90e9a4d20cecdc1f9119c8ce06c34))
* **RQ-PHX-RECOVERYHISTORYAPI03SOOL1:** Recovery history API bridge ([#3176](https://github.com/ashlrai/phantom/issues/3176)) ([c0804a7](https://github.com/ashlrai/phantom/commit/c0804a7ea228cf601f10e264f2c4270f3cce8e5f))
* **RQ-PHX-UNIFIEDINBOXCARD19:** RQ-PHX-UNIFIEDINBOXCARD19 ([#4396](https://github.com/ashlrai/phantom/issues/4396)) ([49b55e4](https://github.com/ashlrai/phantom/commit/49b55e409d9dd6cb91c8bdb1744c3c8f1f461698))
* **RQ-PHX-UNIFIEDINBOXSERVE18:** RQ-PHX-UNIFIEDINBOXSERVE18 ([#4384](https://github.com/ashlrai/phantom/issues/4384)) ([5afe05d](https://github.com/ashlrai/phantom/commit/5afe05da530005f7a88fb785d7d29114b7e8a3b7))
* **RQ-PHX-WORLDCARDREADING09:** RQ-PHX-WORLDCARDREADING09 ([#4279](https://github.com/ashlrai/phantom/issues/4279)) ([be09e15](https://github.com/ashlrai/phantom/commit/be09e1532633f0a57412553d4f04e318b23bb8d2))
* **RQ-PHX-WORLDFLEETLANES09:** Bridge notes ([#4249](https://github.com/ashlrai/phantom/issues/4249)) ([a8134e7](https://github.com/ashlrai/phantom/commit/a8134e764be09114beccf325e9e8f10135cd886f))
* **RQ-PRECHECKWHY9Q8:** RQ-PRECHECKWHY9Q8 ([#4391](https://github.com/ashlrai/phantom/issues/4391)) ([8a5bd30](https://github.com/ashlrai/phantom/commit/8a5bd30a7f83bd1243e57d8bf44d9ce77757a3d4))
* **RQ-QUEUEAGE9Q8:** RQ-QUEUEAGE9Q8: queue age summary ([#4394](https://github.com/ashlrai/phantom/issues/4394)) ([af14c8b](https://github.com/ashlrai/phantom/commit/af14c8b72aa32f0c1580d1b29fd0613a064dffce))
* **RQ-QUEUEQUALITYQ8:** RQ-QUEUEQUALITYQ8 ([#4371](https://github.com/ashlrai/phantom/issues/4371)) ([93149d1](https://github.com/ashlrai/phantom/commit/93149d1acf9d0811cd7ebcce7bb7a23e03492bd0))
* **RQ-RADAR-IDEAS-1:** Bridge notes ([#4254](https://github.com/ashlrai/phantom/issues/4254)) ([89fd7b6](https://github.com/ashlrai/phantom/commit/89fd7b6cdbf670773f3c82bb3206329dfe4dc975))
* **RQ-RADAR-SCHEDULE-1:** RQ-RADAR-SCHEDULE-1 bridge notes ([#4274](https://github.com/ashlrai/phantom/issues/4274)) ([f807b49](https://github.com/ashlrai/phantom/commit/f807b49f5edb4c287c7f55e33ed9e4d9f40109a0))
* **RQ-REBASE-SPIRAL-POLICY:** BRIDGE_NOTES: RQ-REBASE-SPIRAL-POLICY ([#4226](https://github.com/ashlrai/phantom/issues/4226)) ([b8911f0](https://github.com/ashlrai/phantom/commit/b8911f02ba9ddeed9875f8d1979ce31678587046))
* **RQ-RECUTLOOPQ8:** RQ-RECUTLOOPQ8 ([#3822](https://github.com/ashlrai/phantom/issues/3822)) ([bba7617](https://github.com/ashlrai/phantom/commit/bba7617611066f326e46edc98eff61a0d4f04094))
* **RQ-REPORANK-APP-1:** Repo ranking desktop work ([#4263](https://github.com/ashlrai/phantom/issues/4263)) ([56a2e8b](https://github.com/ashlrai/phantom/commit/56a2e8ba2d49614736f75ca525db50c3f649450c))
* **RQ-REPORANK-DISPATCH-1:** RQ-REPORANK-DISPATCH-1 ([#4264](https://github.com/ashlrai/phantom/issues/4264)) ([b4b6e4b](https://github.com/ashlrai/phantom/commit/b4b6e4b9336785270965dcfe36adc597aa71f69a))
* **RQ-RESTOCKBATCHN9EQ8:** RQ-RESTOCKBATCHN9EQ8 ([#4293](https://github.com/ashlrai/phantom/issues/4293)) ([266536d](https://github.com/ashlrai/phantom/commit/266536d5cf6240638cdb595b62e758d8fe4c07b7))
* **RQ-ROOT-ARTIFACTS-1:** BRIDGE_NOTES.md ([#4239](https://github.com/ashlrai/phantom/issues/4239)) ([ccea430](https://github.com/ashlrai/phantom/commit/ccea430f3ed328e59dcb63b50b7f68c581b106d7))
* **RQ-SALVAGEFEEDN9BQ8:** Salvage feed handoff ([#4266](https://github.com/ashlrai/phantom/issues/4266)) ([7f09a2f](https://github.com/ashlrai/phantom/commit/7f09a2fa3471050d25f74c7f637825f24bde2d2b))
* **RQ-SEC-4206-SHA-PIN:** RQ-SEC-4206-SHA-PIN handoff ([#4238](https://github.com/ashlrai/phantom/issues/4238)) ([c6f9f36](https://github.com/ashlrai/phantom/commit/c6f9f36dcf4b907a9af52faffcda4997b39740d1))
* **RQ-SEC-4207-REBASE:** RQ-SEC-4207-REBASE handoff ([#4236](https://github.com/ashlrai/phantom/issues/4236)) ([18183bf](https://github.com/ashlrai/phantom/commit/18183bf7d97e8e6752c006784381fe32cdaff67a))
* **RQ-SELFSUPPLYN9BQ8:** RQ-SELFSUPPLYN9BQ8 — self-supply: refill idle lanes between ([#4267](https://github.com/ashlrai/phantom/issues/4267)) ([16093c0](https://github.com/ashlrai/phantom/commit/16093c0559ae8ad86713e1a288e1542e273e0244))
* **RQ-SHIPPARTIALN9JQ8:** Ship useful partial work with honest gaps ([#4354](https://github.com/ashlrai/phantom/issues/4354)) ([900df56](https://github.com/ashlrai/phantom/commit/900df5619f2f8435411c3bb7f64f7d52beac4db4))
* **RQ-SUPPLYQUALITY9GQ8:** Bridge notes ([#4306](https://github.com/ashlrai/phantom/issues/4306)) ([75a43aa](https://github.com/ashlrai/phantom/commit/75a43aad9d71a4b85370d935d382dbfed008f7b7))
* **RQ-TEAMORG-1:** RQ-TEAMORG-1 bridge notes ([#4256](https://github.com/ashlrai/phantom/issues/4256)) ([d95ede1](https://github.com/ashlrai/phantom/commit/d95ede1ba0c372566145626924779f9a7d86fc62))
* **RQ-TICKBUDGETN9DQ8:** RQ-TICKBUDGETN9DQ8 ([#4277](https://github.com/ashlrai/phantom/issues/4277)) ([ad06f7a](https://github.com/ashlrai/phantom/commit/ad06f7a0933d8fb9fca4b62289f8a2432af25ab8))
* **RQ-UPKEEP-DOCS-phantom-20261109:** BRIDGE_NOTES: RQ-UPKEEP-DOCS-phantom-20261109 ([#4339](https://github.com/ashlrai/phantom/issues/4339)) ([eda20a2](https://github.com/ashlrai/phantom/commit/eda20a21da74ec0776ce173787bf1f9d67a0d9ec))
* **RQ-USAGEFRESHN9KQ8:** RQ-USAGEFRESHN9KQ8 handoff ([#4369](https://github.com/ashlrai/phantom/issues/4369)) ([6350435](https://github.com/ashlrai/phantom/commit/6350435c2fadaf12f41516decab764dac30497d8))


### Documentation

* governed-client gateway opt-in design note ([#878](https://github.com/ashlrai/phantom/issues/878)) ([3612036](https://github.com/ashlrai/phantom/commit/36120368575dafe615038b51e867076d380847a4))

## [3.30.28] - 2026-11-09


### Fixes

* read the installed app version for update status ([#4195](https://github.com/ashlrai/phantom/issues/4195)) ([08d305f](https://github.com/ashlrai/phantom/commit/08d305f32b8f773c082bc0251dd7b19132976b49))


### Changes

* **RQ-CI-RELEASE-GATE-TAG-CANDIDATE:** Bridge notes ([#4182](https://github.com/ashlrai/phantom/issues/4182)) ([9169482](https://github.com/ashlrai/phantom/commit/9169482fcc71e5fac5381d52212f4b1687bb47eb))
* **RQ-CIFIX-PH-07-R2:** RQ-CIFIX-PH-07-R2 ([#4197](https://github.com/ashlrai/phantom/issues/4197)) ([8af40ab](https://github.com/ashlrai/phantom/commit/8af40ab8ed305fffbe7a2efdbf4184a734f49d90))
* **RQ-DRAIN2-PH-16-R2:** RQ-DRAIN2-PH-16-R2 ([#4196](https://github.com/ashlrai/phantom/issues/4196)) ([4623bfd](https://github.com/ashlrai/phantom/commit/4623bfd6d2a2eb3aaa70f0efa6c0595a7f2739bd))
* **RQ-DRAIN2-PH-29-R2:** RQ-DRAIN2-PH-29-R2 bridge notes ([#4198](https://github.com/ashlrai/phantom/issues/4198)) ([79dc1bf](https://github.com/ashlrai/phantom/commit/79dc1bf59bde420e7892898fecaedf474e3b4701))
* **RQ-DUPLAUNCHQ11Q8:** RQ-DUPLAUNCHQ11Q8 ([#4162](https://github.com/ashlrai/phantom/issues/4162)) ([c6cba1a](https://github.com/ashlrai/phantom/commit/c6cba1a87bf9aa1a67176bbc3193e41687149de0))
* **RQ-GUARDHEALTHQ10Q8:** Bridge notes — RQ-GUARDHEALTHQ10Q8 ([#4144](https://github.com/ashlrai/phantom/issues/4144)) ([fb83f81](https://github.com/ashlrai/phantom/commit/fb83f818720684b0831e5ad2805b4976e066c0c8))
* **RQ-LOCALEMPTYN9Q8:** RQ-LOCALEMPTYN9Q8 handoff ([#4200](https://github.com/ashlrai/phantom/issues/4200)) ([19a1620](https://github.com/ashlrai/phantom/commit/19a162088526c0a16b5801022c388393c8953589))
* **RQ-MERGELATQ10Q8:** RQ-MERGELATQ10Q8 bridge notes ([#4145](https://github.com/ashlrai/phantom/issues/4145)) ([86ba599](https://github.com/ashlrai/phantom/commit/86ba599348550cae607dafd74f981be00aa3a84f))
* **RQ-MERGELATQ11Q8:** RQ-MERGELATQ11Q8 ([#4157](https://github.com/ashlrai/phantom/issues/4157)) ([48cf866](https://github.com/ashlrai/phantom/commit/48cf866870222b24f41248607c2a6d06903671a9))
* **RQ-NS-NO-PASTE-SECURE-ENTRY:** RQ-NS-NO-PASTE-SECURE-ENTRY handoff ([#4189](https://github.com/ashlrai/phantom/issues/4189)) ([87a574d](https://github.com/ashlrai/phantom/commit/87a574d568fdbd90a96b7b409eb4da9c01a8e2d7))
* **RQ-ONB-9-PHMDEV:** RQ-ONB-9-PHMDEV handoff ([#4201](https://github.com/ashlrai/phantom/issues/4201)) ([eb7bd10](https://github.com/ashlrai/phantom/commit/eb7bd106b3de2be3ded0de6b14e18c3e86f1dc36))
* **RQ-PH-DEPAUDIT-PATHS-1:** Dependency audit trigger handoff ([#4191](https://github.com/ashlrai/phantom/issues/4191)) ([1251c95](https://github.com/ashlrai/phantom/commit/1251c959221c9c56ad09bf289ffbc07e532afa87))
* **RQ-QUEUE-REDESIGN-1R2:** Queue depth handoff ([#4199](https://github.com/ashlrai/phantom/issues/4199)) ([ff5f72f](https://github.com/ashlrai/phantom/commit/ff5f72f2853278be5f58dea5b541fd482d715b10))
* **RQ-RC3705BQ8:** Supersedes [#3705](https://github.com/ashlrai/phantom/issues/3705) ([#4177](https://github.com/ashlrai/phantom/issues/4177)) ([8725bec](https://github.com/ashlrai/phantom/commit/8725bec84f2a2eb44ed224fda415b95f351f745f))
* **RQ-RC3718BQ8:** Supersedes [#3718](https://github.com/ashlrai/phantom/issues/3718) ([#4174](https://github.com/ashlrai/phantom/issues/4174)) ([54d016e](https://github.com/ashlrai/phantom/commit/54d016e44df154c49afc73026155f9ed00f0f332))
* **RQ-RCDEEPWIKIQ8:** RQ-RCDEEPWIKIQ8 ([#4178](https://github.com/ashlrai/phantom/issues/4178)) ([d2def71](https://github.com/ashlrai/phantom/commit/d2def711bc0bba65ab179debc061d56b92dd6771))
* **RQ-RCINCPIPEQ8:** RQ-RCINCPIPEQ8 ([#4176](https://github.com/ashlrai/phantom/issues/4176)) ([b2b362f](https://github.com/ashlrai/phantom/commit/b2b362f09ca364837fc5b4bb796371b032d3348d))
* **RQ-RCMCPBQ8:** Supersedes: none (all four candidate PRs were closed). ([#4172](https://github.com/ashlrai/phantom/issues/4172)) ([d5442bd](https://github.com/ashlrai/phantom/commit/d5442bda819579a5b8f146dac8a22e3fc1eddb8b))
* **RQ-RCTOOLMESHQ8:** RQ-RCTOOLMESHQ8 ([#4175](https://github.com/ashlrai/phantom/issues/4175)) ([b619a4c](https://github.com/ashlrai/phantom/commit/b619a4cdb0bb67f3970df70f968c6bcd9fae7287))
* **RQ-RELEASE-ENQUEUE-1:** RQ-RELEASE-ENQUEUE-1 bridge ([#4143](https://github.com/ashlrai/phantom/issues/4143)) ([6cd6c8c](https://github.com/ashlrai/phantom/commit/6cd6c8c8b7fc9048bfea34d92a375cc092f4b108))
* **RQ-SEC-PAUSE-FAILCLOSED-4152:** Fix-forward of [#4152](https://github.com/ashlrai/phantom/issues/4152) ([#4186](https://github.com/ashlrai/phantom/issues/4186)) ([82484f1](https://github.com/ashlrai/phantom/commit/82484f1c6f8f1637bf9d9e61c7ae8726379b1538))
* **RQ-SWE5-CLAUDE-CTX-MEM:** RQ-SWE5-CLAUDE-CTX-MEM — checkpoint freshness + invalidation ([#4148](https://github.com/ashlrai/phantom/issues/4148)) ([6ce4f52](https://github.com/ashlrai/phantom/commit/6ce4f52e78d9afa7cab9534384ca8e53e90ffd15))
* **RQ-SWE5-CLAUDE-MERGE-ENGINE:** BRIDGE_NOTES — RQ-SWE5-CLAUDE-MERGE-ENGINE ([#4149](https://github.com/ashlrai/phantom/issues/4149)) ([7845cf3](https://github.com/ashlrai/phantom/commit/7845cf3c45eb5263701be61bc9d15adff7302439))
* **RQ-SWE5-CLAUDE-SHOWLAYER:** RQ-SWE5-CLAUDE-SHOWLAYER — Show mode ambient layer ([#4147](https://github.com/ashlrai/phantom/issues/4147)) ([873ea19](https://github.com/ashlrai/phantom/commit/873ea19c515bd5ae9ec0111fa6dd475b1bc7e6b0))
* **RQ-SWE5-DESK-OBSERVE:** RQ-SWE5-DESK-OBSERVE — Observe cockpit pane ([#4164](https://github.com/ashlrai/phantom/issues/4164)) ([260e571](https://github.com/ashlrai/phantom/commit/260e5719c953a04e31caa33052f7a4fb1e0251e2))
* **RQ-SWE5-DESK-SELFDRIVE:** RQ-SWE5-DESK-SELFDRIVE bridge notes ([#4155](https://github.com/ashlrai/phantom/issues/4155)) ([768ff63](https://github.com/ashlrai/phantom/commit/768ff631a7a37e926e1a0773fc0f83e3ce15af49))
* **RQ-SWE5-DESK-SESSIONS:** RQ-SWE5-DESK-SESSIONS handoff ([#4154](https://github.com/ashlrai/phantom/issues/4154)) ([a79c9d0](https://github.com/ashlrai/phantom/commit/a79c9d03ca506f71077348e4700a11d700057233))
* **RQ-SWE5-FASTREVERT:** BRIDGE_NOTES — RQ-SWE5-FASTREVERT ([#4171](https://github.com/ashlrai/phantom/issues/4171)) ([6dbf499](https://github.com/ashlrai/phantom/commit/6dbf49901268133f21b5958c5f1b4549b43cf9a9))
* **RQ-SWE5-GROK-SEC-COMMS:** RQ-SWE5-GROK-SEC-COMMS — comms/ + integrations/ security rev ([#4152](https://github.com/ashlrai/phantom/issues/4152)) ([52c9fa8](https://github.com/ashlrai/phantom/commit/52c9fa86ea7ef6db42f2436d3b1f297ada0c2382))
* **RQ-SWE5-LEAD-WORKER:** BRIDGE_NOTES — RQ-SWE5-LEAD-WORKER ([#4166](https://github.com/ashlrai/phantom/issues/4166)) ([3d21736](https://github.com/ashlrai/phantom/commit/3d2173645eee49cf9df5dd93f2aed630fc137df4))
* **RQ-SWE5-LEADER-VISION:** BRIDGE_NOTES — RQ-SWE5-LEADER-VISION ([#4168](https://github.com/ashlrai/phantom/issues/4168)) ([d72ea09](https://github.com/ashlrai/phantom/commit/d72ea09f513db3b859b5bfc5b4f70162b29468e2))
* **RQ-SWE5-MACHINERY-AS-CODE:** RQ-SWE5-MACHINERY-AS-CODE — machinery-as-code deploy plane ([#4181](https://github.com/ashlrai/phantom/issues/4181)) ([8256e8b](https://github.com/ashlrai/phantom/commit/8256e8b1c80dd43d41eb61accf84ba3403c49b2a))
* **RQ-SWE5-PASSK-EVAL:** BRIDGE_NOTES — RQ-SWE5-PASSK-EVAL ([#4170](https://github.com/ashlrai/phantom/issues/4170)) ([b0fe575](https://github.com/ashlrai/phantom/commit/b0fe575df214b856a31e4e441213af1228dc2ccd))
* **RQ-SWE5-RESEARCH-LOOP:** BRIDGE_NOTES — RQ-SWE5-RESEARCH-LOOP ([#4159](https://github.com/ashlrai/phantom/issues/4159)) ([2ff691e](https://github.com/ashlrai/phantom/commit/2ff691e60e207b460054477dcbf913c95b357f9b))
* **RQ-SWE5-SCAFFOLD-AUDIT:** ([#4179](https://github.com/ashlrai/phantom/issues/4179)) ([e154512](https://github.com/ashlrai/phantom/commit/e154512b748a8074a7ce5a91e7d262167b644a29))
* **RQ-SWE5-SELF-TOOLS:** RQ-SWE5-SELF-TOOLS handoff ([#4156](https://github.com/ashlrai/phantom/issues/4156)) ([902cebf](https://github.com/ashlrai/phantom/commit/902cebffd90f7535d0dfb59c648c4180c1f3374b))
* **RQ-SWE5-STIGMERGY:** BRIDGE_NOTES — RQ-SWE5-STIGMERGY ([#4160](https://github.com/ashlrai/phantom/issues/4160)) ([afcafe6](https://github.com/ashlrai/phantom/commit/afcafe6b85008eb62c112661b7f98c83aff43a6a))
* **RQ-SWE5-VERIFY-METRIC:** BRIDGE_NOTES — RQ-SWE5-VERIFY-METRIC ([#4184](https://github.com/ashlrai/phantom/issues/4184)) ([50f0fc3](https://github.com/ashlrai/phantom/commit/50f0fc312f64d22c990e663bfc73a2c1817bdb90))

## [3.30.27] - 2026-11-09


### Changes

* **RQ-CIFIX3-PH-01:** RQ-CIFIX3-PH-01 ([#4125](https://github.com/ashlrai/phantom/issues/4125)) ([79e8614](https://github.com/ashlrai/phantom/commit/79e86140000433c7248a166490f5395c273e659c))
* **RQ-CIFIX3-PH-03:** RQ-CIFIX3-PH-03 ([#4124](https://github.com/ashlrai/phantom/issues/4124)) ([5c1484f](https://github.com/ashlrai/phantom/commit/5c1484fc80510e5769eb4a3ab3acf7e6890e861e))
* **RQ-CIFIX3-PH-04:** RQ-CIFIX3-PH-04 ([#4126](https://github.com/ashlrai/phantom/issues/4126)) ([4aec52e](https://github.com/ashlrai/phantom/commit/4aec52e0167c54fb83a215522927a9fe56ca3f29))
* **RQ-DRAIN3-PH-10:** RQ-DRAIN3-PH-10 ([#4121](https://github.com/ashlrai/phantom/issues/4121)) ([9a5a50c](https://github.com/ashlrai/phantom/commit/9a5a50c84e05269f67c3096428f17d042b3e5b90))
* **RQ-SWE4-API-FLEET-RACE:** RQ-SWE4-API-FLEET-RACE ([#4116](https://github.com/ashlrai/phantom/issues/4116)) ([192a74a](https://github.com/ashlrai/phantom/commit/192a74a4a5c48419dbb7d1c755fda4dcc04648fc))
* **RQ-SWE4-API-RESBAR:** RQ-SWE4-API-RESBAR handoff ([#4117](https://github.com/ashlrai/phantom/issues/4117)) ([bdda6a4](https://github.com/ashlrai/phantom/commit/bdda6a49d8876130d8c769fcddfb4d52a76e1d1a))
* **RQ-SWE4-API-SEC-PROXY:** RQ-SWE4-API-SEC-PROXY ([#4118](https://github.com/ashlrai/phantom/issues/4118)) ([75378fc](https://github.com/ashlrai/phantom/commit/75378fcea6c9d1c8a5aa2076695fc0920980dc50))
* **RQ-SWE4-RELEASETAG-1:** RQ-SWE4-RELEASETAG-1 handoff ([#4127](https://github.com/ashlrai/phantom/issues/4127)) ([de42a64](https://github.com/ashlrai/phantom/commit/de42a64958a664d19b5c96c7e874a4284398b508))
* **RQ-SWE4-TERRA-CLI-PH:** RQ-SWE4-TERRA-CLI-PH ([#4123](https://github.com/ashlrai/phantom/issues/4123)) ([5449b94](https://github.com/ashlrai/phantom/commit/5449b94af61a257ba460ce41bf01b50d7b94ae5e))
* **RQ-SWE4-TERRA-SECBUS:** RQ-SWE4-TERRA-SECBUS ([#4120](https://github.com/ashlrai/phantom/issues/4120)) ([0da1acd](https://github.com/ashlrai/phantom/commit/0da1acd79bf26931e92a78d16f4bf74eab41c770))
* **RQ-SWE4-TERRA-TESTS-PH:** Bridge notes — RQ-SWE4-TERRA-TESTS-PH ([#4119](https://github.com/ashlrai/phantom/issues/4119)) ([5992379](https://github.com/ashlrai/phantom/commit/5992379074ca85a3b0c6acf5f0c777e00db7a943))

## [3.30.26] - 2026-11-08


### Changes

* **RQ-DEVINFAILQ8:** RQ-DEVINFAILQ8 handoff ([#4113](https://github.com/ashlrai/phantom/issues/4113)) ([79f8cc0](https://github.com/ashlrai/phantom/commit/79f8cc0930f70d6040e148fa6cacf374779f80eb))
* **RQ-MERGEAGEQ8Q8:** RQ-MERGEAGEQ8Q8 handoff ([#4100](https://github.com/ashlrai/phantom/issues/4100)) ([88e1667](https://github.com/ashlrai/phantom/commit/88e166731c3bcc3fdab990902db7e08a6ef6d03f))
* **RQ-MERGELATENCY8Q8:** Bridge notes ([#4103](https://github.com/ashlrai/phantom/issues/4103)) ([6e1fcc4](https://github.com/ashlrai/phantom/commit/6e1fcc4b6f0353fb112d0bd7acf66d4f6cd735b7))
* **RQ-MERGEPARK8Q8:** RQ-MERGEPARK8Q8 handoff ([#4105](https://github.com/ashlrai/phantom/issues/4105)) ([818fe78](https://github.com/ashlrai/phantom/commit/818fe7861cffeb537ea7ca554ecc4646968f1e0d))
* **RQ-MERGEPARKQ8Q8:** RQ-MERGEPARKQ8Q8 handoff ([#4102](https://github.com/ashlrai/phantom/issues/4102)) ([72161c9](https://github.com/ashlrai/phantom/commit/72161c9e45ab87af4d80b0a1fe395261bcb1b064))
* **RQ-MERGEQUEUEQ8:** RQ-MERGEQUEUEQ8 handoff ([#4099](https://github.com/ashlrai/phantom/issues/4099)) ([6f430fe](https://github.com/ashlrai/phantom/commit/6f430fe552e082351edfe9ac9627dabe46dbe9ae))
* **RQ-MERGEWAKE8Q8:** RQ-MERGEWAKE8Q8 handoff ([#4104](https://github.com/ashlrai/phantom/issues/4104)) ([c089039](https://github.com/ashlrai/phantom/commit/c0890391939cf69f87f7a36ee473604f0d2e1f1c))
* **RQ-PARKLATENCYQ8:** RQ-PARKLATENCYQ8 ([#4114](https://github.com/ashlrai/phantom/issues/4114)) ([f6c706d](https://github.com/ashlrai/phantom/commit/f6c706dd95e324e71174a22ddd13bc2fd3a4d0bf))
* **RQ-PARKWAKEQ8:** RQ-PARKWAKEQ8 handoff ([#4109](https://github.com/ashlrai/phantom/issues/4109)) ([26d1e88](https://github.com/ashlrai/phantom/commit/26d1e88ec359665dd6c98a6b7ebad7361a63c4a7))
* **RQ-REAPCONVERGEQ8Q8:** Bridge notes ([#4101](https://github.com/ashlrai/phantom/issues/4101)) ([31ad6ee](https://github.com/ashlrai/phantom/commit/31ad6eeb98e51cc1c49cc3ad632b5811281a469a))
* **RQ-SWE3-FAIRROUND-1:** BRIDGE_NOTES — RQ-SWE3-FAIRROUND-1 ([#4108](https://github.com/ashlrai/phantom/issues/4108)) ([59bba03](https://github.com/ashlrai/phantom/commit/59bba0341c8015a5754e4e27f471c11e633ab765))
* **RQ-SWE3-MERGE-ACCEL-1:** BRIDGE_NOTES — RQ-SWE3-MERGE-ACCEL-1 ([#4112](https://github.com/ashlrai/phantom/issues/4112)) ([e26351a](https://github.com/ashlrai/phantom/commit/e26351a0cf727c02dc7b9bf594b339244c0afb1d))
* **RQ-SWE3-PRTRIAGE-1:** BRIDGE_NOTES — RQ-SWE3-PRTRIAGE-1 ([#4111](https://github.com/ashlrai/phantom/issues/4111)) ([9aa58a2](https://github.com/ashlrai/phantom/commit/9aa58a2a83488cd0820980f306702f049b7438d2))
* **RQ-SWE3-REDIRECT-FIX-1:** BRIDGE_NOTES — RQ-SWE3-REDIRECT-FIX-1 ([#4106](https://github.com/ashlrai/phantom/issues/4106)) ([35f2650](https://github.com/ashlrai/phantom/commit/35f265092bf56b37f843af3a26d8047b8b9ab1d9))
* **RQ-SWE3-SESS-REAPER-1:** BRIDGE_NOTES — RQ-SWE3-SESS-REAPER-1 `phm fleet session-audi ([#4110](https://github.com/ashlrai/phantom/issues/4110)) ([4b57b00](https://github.com/ashlrai/phantom/commit/4b57b00d8e33144a04b2657d15530a46a6c2ca3b))

## [3.30.25] - 2026-11-08

### Added

- Add a prioritized read-only unified inbox for pending needs-you items, teammate texts, drafts and unclaimed bus work ([#4080](https://github.com/ashlrai/phantom/pull/4080)).
- Add `phm fleet wt-audit` to inspect worktree lifecycle evidence and preview conservative reap candidates ([#4076](https://github.com/ashlrai/phantom/pull/4076)).
- Add `phm fleet eval-report` for evidence-based post-merge durability and fleet outcome metrics ([#4077](https://github.com/ashlrai/phantom/pull/4077)).
- Add the read-only `phm fleet merge-batch` planner for ordering overlapping pull requests ([#4072](https://github.com/ashlrai/phantom/pull/4072)).
- Add opt-in desktop control for Claude, Codex and Devin, with capability and permission status ([#4000](https://github.com/ashlrai/phantom/pull/4000)).
- Add a Fleet resource and activity board with lane quota observations, recent actions and merges, refreshed while visible ([#3939](https://github.com/ashlrai/phantom/pull/3939)).
- Add Show Mode for browsing recent fleet activity and a merge ticker ([#3934](https://github.com/ashlrai/phantom/pull/3934)).
- Add validated agent checkpoint handoffs and the read-only `phm checkpoint resume` command ([#3921](https://github.com/ashlrai/phantom/pull/3921)).
- Add explicit local delivery acknowledgments and receipt metadata to bus threads ([#3912](https://github.com/ashlrai/phantom/pull/3912)).
- Add a read-only fleet status API projection through `phm fleet status-api --json` ([#3870](https://github.com/ashlrai/phantom/pull/3870)).
- `phm disk` reports worktree and quarantine sizes, free space and conservative cleanup eligibility without deleting files. Unreadable evidence stays unknown. ([#3349](https://github.com/ashlrai/phantom/pull/3349)).
- Fleet adds read-only lane trim suggestions and abort summaries, including a GitHub push failure signal. Idle-lane reports can identify lanes stuck after a measured period of inactivity. ([#3375](https://github.com/ashlrai/phantom/pull/3375), [#3370](https://github.com/ashlrai/phantom/pull/3370), [#3371](https://github.com/ashlrai/phantom/pull/3371)).
- Fleet draft checks validate batches against a single `origin/master` snapshot and report path collisions. MCP tools expose batch prechecks and bounded job and path history as advisory evidence, not dispatch or merge authorization. ([#3345](https://github.com/ashlrai/phantom/pull/3345), [#3365](https://github.com/ashlrai/phantom/pull/3365), [#3389](https://github.com/ashlrai/phantom/pull/3389), [#3376](https://github.com/ashlrai/phantom/pull/3376)).

### Changed

- Add fleet links and recent merges to phone Home, preserving unknown and unavailable states ([#3932](https://github.com/ashlrai/phantom/pull/3932)).
- Show per-lane observability details and resource usage information in the console ([#3910](https://github.com/ashlrai/phantom/pull/3910), [#3936](https://github.com/ashlrai/phantom/pull/3936)).

### Fixes

- Self-update status shows scrubbed paths blocking a clean update, and automatic updates pause after a failed build until a newer master commit is available. Fleet capacity distinguishes idle lanes without a usage meter from other unknown lane states. ([#3367](https://github.com/ashlrai/phantom/pull/3367), [#3372](https://github.com/ashlrai/phantom/pull/3372), [#3362](https://github.com/ashlrai/phantom/pull/3362)).

## [3.30.24] — 2026-11-07


### Changes

* **RQ-PINHONORQ8:** RQ-PINHONORQ8 ([#3858](https://github.com/ashlrai/phantom/issues/3858)) ([3d20a97](https://github.com/ashlrai/phantom/commit/3d20a97c3e479658f6f560033a4c61819734a441))
* **RQ-PRWAITQ8:** RQ-PRWAITQ8 handoff ([#3859](https://github.com/ashlrai/phantom/issues/3859)) ([2502506](https://github.com/ashlrai/phantom/commit/2502506c1e5fcc85e3bdb656f1b449e2aab8a0eb))
* **RQ-SKIPREASONSQ8:** RQ-SKIPREASONSQ8 handoff ([#3857](https://github.com/ashlrai/phantom/issues/3857)) ([100d609](https://github.com/ashlrai/phantom/commit/100d6096bddf8f7ac2ae7fc9b63c3decea101ecf))
* **RQ-STRANDEDQ8:** RQ-STRANDEDQ8 bridge notes ([#3860](https://github.com/ashlrai/phantom/issues/3860)) ([e4b744b](https://github.com/ashlrai/phantom/commit/e4b744b29d23af7253983728e7e3f0b2f6cfb0d2))
* **RQ-TICKWALLQ8:** RQ-TICKWALLQ8 ([#3856](https://github.com/ashlrai/phantom/issues/3856)) ([4312fc4](https://github.com/ashlrai/phantom/commit/4312fc4cf2f56e65732c89015cedd154f406c68f))

## [3.30.23] — 2026-11-07


### Changes

* **FIXUP-CI-phantom-release-pr-820728:** Release cadence timeout fix ([#3847](https://github.com/ashlrai/phantom/issues/3847)) ([3bc475c](https://github.com/ashlrai/phantom/commit/3bc475cf433f1a45ea4b905a94ed2e52a3a85d1a))
* RQ-CI-PR-EVENT-BASE-ADVANCE-NOV7 ([#3846](https://github.com/ashlrai/phantom/issues/3846)) ([7e8e896](https://github.com/ashlrai/phantom/commit/7e8e896a49ef688bfae9b339e10f25388173feb7))
* **RQ-CI-SAME-RUNNER-SMOKE-NOV7:** Fold fast unsigned preparation and smoke into one existing r ([#3852](https://github.com/ashlrai/phantom/issues/3852)) ([e6d5e46](https://github.com/ashlrai/phantom/commit/e6d5e46d55fb114251c8c66dd834dddeb905d384))
* **RQ-CONTROLLER-MEMQ8:** Add a separately labeled macOS memory availability advisory ([#3848](https://github.com/ashlrai/phantom/issues/3848)) ([3d797e2](https://github.com/ashlrai/phantom/commit/3d797e203f68011fc529808b06d6754d6289ee96))
* **RQ-DAILYFIX-TTG:** BRIDGE_NOTES.md — RQ-DAILYFIX-TTG ([#3810](https://github.com/ashlrai/phantom/issues/3810)) ([9f42d86](https://github.com/ashlrai/phantom/commit/9f42d86907a35a3f5c8183abd3ac0d79c3ac51e2))
* **RQ-DEFERSTALEQ8:** RQ-DEFERSTALEQ8 bridge notes ([#3838](https://github.com/ashlrai/phantom/issues/3838)) ([92dbc09](https://github.com/ashlrai/phantom/commit/92dbc09359a236df790feaed4a1bfad6a5aa21a2))
* **RQ-DESKTOP-OBSERVE-1:** RQ-DESKTOP-OBSERVE-1 handoff ([#3851](https://github.com/ashlrai/phantom/issues/3851)) ([885b91e](https://github.com/ashlrai/phantom/commit/885b91ef033c557b8a35993ba9b23877d5b2ae55))
* **RQ-DIFFANOMALYQ8:** RQ-DIFFANOMALYQ8 ([#3811](https://github.com/ashlrai/phantom/issues/3811)) ([d2ebd9b](https://github.com/ashlrai/phantom/commit/d2ebd9bb6af8ae431216a80f3f285e885c843223))
* **RQ-DIFFMETRICSQ8:** RQ-DIFFMETRICSQ8 ([#3809](https://github.com/ashlrai/phantom/issues/3809)) ([8d13410](https://github.com/ashlrai/phantom/commit/8d134106130371e9c71b4f43cd6320e1925d4e58))
* **RQ-DISKGROWTHQ8:** Bridge notes: RQ-DISKGROWTHQ8 ([#3812](https://github.com/ashlrai/phantom/issues/3812)) ([9ff186f](https://github.com/ashlrai/phantom/commit/9ff186f02c229e85e3ed24652a62dd94c7547ff3))
* RQ-ESTATES-LINTFIXQ8 ([#3832](https://github.com/ashlrai/phantom/issues/3832)) ([504e833](https://github.com/ashlrai/phantom/commit/504e83380d67c524c0375ac4c944a433e31605a8))
* **RQ-GUARDSTUCKQ8Q8:** RQ-GUARDSTUCKQ8Q8 ([#3813](https://github.com/ashlrai/phantom/issues/3813)) ([8824070](https://github.com/ashlrai/phantom/commit/8824070231693c83c822c9ed4515b93739bc53b3))
* **RQ-HOLDCHECKQ8Q8:** RQ-HOLDCHECKQ8Q8 ([#3815](https://github.com/ashlrai/phantom/issues/3815)) ([ef378e1](https://github.com/ashlrai/phantom/commit/ef378e134e7f6cb7ae7f5defcc9cd4a1119aa92b))
* **RQ-IDLESLOTSQ8:** RQ-IDLESLOTSQ8 ([#3839](https://github.com/ashlrai/phantom/issues/3839)) ([e2a33ab](https://github.com/ashlrai/phantom/commit/e2a33ab6f5ab46607fca84ab7f75c805d459cce9))
* **RQ-INSTALL-QUIESCEQ8:** Refuse known local installer blockers before hosted reads. ([#3833](https://github.com/ashlrai/phantom/issues/3833)) ([0981384](https://github.com/ashlrai/phantom/commit/09813848ce147dbde7af7f0f6d937ec0acd81993))
* **RQ-KEPTAGEQ8:** RQ-KEPTAGEQ8 ([#3840](https://github.com/ashlrai/phantom/issues/3840)) ([8d6d319](https://github.com/ashlrai/phantom/commit/8d6d31988a06d11c2c0950df5db260760ac6bb93))
* **RQ-LANESTARVEQ8:** RQ-LANESTARVEQ8 ([#3827](https://github.com/ashlrai/phantom/issues/3827)) ([e57599a](https://github.com/ashlrai/phantom/commit/e57599a32217a764a5c21e3c838cf26339b46651))
* **RQ-LAUNCHABLEQ8:** RQ-LAUNCHABLEQ8 handoff ([#3844](https://github.com/ashlrai/phantom/issues/3844)) ([5282f9d](https://github.com/ashlrai/phantom/commit/5282f9d3192447a2cbabee5e01dec4356af36304))
* **RQ-LAUNCHSTALLQ8:** RQ-LAUNCHSTALLQ8 handoff ([#3829](https://github.com/ashlrai/phantom/issues/3829)) ([0e8d5e6](https://github.com/ashlrai/phantom/commit/0e8d5e639f1bc54bbac6ee2cd92686bc0da00ce2))
* **RQ-LEADER-ESTATES:** RQ-LEADER-ESTATES: Estate Card Dashboard — Implementation Su ([#3830](https://github.com/ashlrai/phantom/issues/3830)) ([624697b](https://github.com/ashlrai/phantom/commit/624697bb0f49a65ace35d779b745a213d330c209))
* **RQ-MANUAL-READQ8:** Overlap independent GitHub publication metadata reads within ([#3849](https://github.com/ashlrai/phantom/issues/3849)) ([8e7bc56](https://github.com/ashlrai/phantom/commit/8e7bc56d280da7a620ac46d77a2dc3fec6370714))
* **RQ-OPS-GROK-USAGE-HOURLY:** RQ-OPS-GROK-USAGE-HOURLY ([#3817](https://github.com/ashlrai/phantom/issues/3817)) ([d357260](https://github.com/ashlrai/phantom/commit/d3572602af75d83d2b28d5dd9c463b9d94199f8e))
* **RQ-PARKAUDITQ8Q8:** RQ-PARKAUDITQ8Q8 ([#3816](https://github.com/ashlrai/phantom/issues/3816)) ([7af1ef3](https://github.com/ashlrai/phantom/commit/7af1ef3515e7d8b1f6716b61c72ea0a4352af2cf))
* **RQ-PHX-CIRECEIPTBATCH05SRT2:** ([#3648](https://github.com/ashlrai/phantom/issues/3648)) ([e19806a](https://github.com/ashlrai/phantom/commit/e19806aac2ae7da64ddcff860b5e09f3ec18ce64))
* **RQ-PHX-KEPTREASONTEST10:** BRIDGE_NOTES — RQ-PHX-KEPTREASONTEST10 ([#3818](https://github.com/ashlrai/phantom/issues/3818)) ([e5e9b7f](https://github.com/ashlrai/phantom/commit/e5e9b7f0d46aaa866394666e8f9d5cc0b1b509f6))
* **RQ-PHX-NPM-INSTALL-CATALOG-NOV7:** Reconcile npm install catalog before consumer checks ([#3835](https://github.com/ashlrai/phantom/issues/3835)) ([80f4dd9](https://github.com/ashlrai/phantom/commit/80f4dd92ca33bd0ddab8be15291d2a49d60e2612))
* RQ-PHX-PRESSURELAUNCHE2E03 ([#3808](https://github.com/ashlrai/phantom/issues/3808)) ([56172ca](https://github.com/ashlrai/phantom/commit/56172ca624f79213e6f423c4eb950c53f061c505))
* **RQ-PHX-RELEASE-AUTORUN-NOV7:** Bind Mac release observer selection to exact attempts and re ([#3850](https://github.com/ashlrai/phantom/issues/3850)) ([addf34f](https://github.com/ashlrai/phantom/commit/addf34f52f7d7c744f37483c4700f187ecb6dd83))
* **RQ-PHX-RELEASE-CADENCE-READ-NOV7:** Retry transient release-cadence metadata reads within one fi ([#3845](https://github.com/ashlrai/phantom/issues/3845)) ([10a8840](https://github.com/ashlrai/phantom/commit/10a8840094f04b80601201ed3d959de1f5ef2daf))
* **RQ-PRREPEATQ8:** ([#3836](https://github.com/ashlrai/phantom/issues/3836)) ([d873d3c](https://github.com/ashlrai/phantom/commit/d873d3c532896824e7e1b4fd4980b4aae9b854d8))
* **RQ-PUBLICFACTSC22Q8:** Recognize the reviewed C22 complete CI workflow and preserve ([#3831](https://github.com/ashlrai/phantom/issues/3831)) ([363e1b1](https://github.com/ashlrai/phantom/commit/363e1b188340502028a4f262b13659a11736850b))
* **RQ-QUEUEMETRICSQ8:** RQ-QUEUEMETRICSQ8 ([#3823](https://github.com/ashlrai/phantom/issues/3823)) ([6bf8e97](https://github.com/ashlrai/phantom/commit/6bf8e97fb79a66aa5906a6d93cdd0cb4afe01881))
* **RQ-QUEUEREPLENISHQ8:** Bridge notes ([#3820](https://github.com/ashlrai/phantom/issues/3820)) ([e4dce8f](https://github.com/ashlrai/phantom/commit/e4dce8f4f9cbcb6f1b1a7ce89e6c479255ec983d))
* **RQ-READYBADQ8:** RQ-READYBADQ8 ([#3826](https://github.com/ashlrai/phantom/issues/3826)) ([8ce338b](https://github.com/ashlrai/phantom/commit/8ce338ba4094f0bad91aa4c5625915e46eb4cf97))
* **RQ-REAPIDEMPOTENTQ8:** RQ-REAPIDEMPOTENTQ8 ([#3821](https://github.com/ashlrai/phantom/issues/3821)) ([743ff42](https://github.com/ashlrai/phantom/commit/743ff42d98b704667845e4b069dc5a5e7270b5e8))
* RQ-REAPMARKSQ8 ([#3834](https://github.com/ashlrai/phantom/issues/3834)) ([e7cae1f](https://github.com/ashlrai/phantom/commit/e7cae1f4fac3d9455272f28aefd7ecb622c4f38c))
* RQ-REAPMARKSQ8 ([#3837](https://github.com/ashlrai/phantom/issues/3837)) ([ea82450](https://github.com/ashlrai/phantom/commit/ea824505ac3d919c79073bafa216e8b5f766b367))
* **RQ-REAPMARKSQ8:** RQ-REAPMARKSQ8 bridge notes ([#3828](https://github.com/ashlrai/phantom/issues/3828)) ([328b7de](https://github.com/ashlrai/phantom/commit/328b7decd99705fefbea475c465a06dd342a2799))
* **RQ-ROUTEMOVESQ8:** RQ-ROUTEMOVESQ8 ([#3843](https://github.com/ashlrai/phantom/issues/3843)) ([24c9bd7](https://github.com/ashlrai/phantom/commit/24c9bd7dc56736f5f8f08049a17f5ceacbaf1b82))

## [3.30.22] — 2026-11-07

### Fixes

- Connect the provider-neutral Leader to admitted native Devin CLI models, preserving exact account, Free-catalog, context and grant checks ([#3801](https://github.com/ashlrai/phantom/pull/3801)).
- Add explicit local operator pairing for the already-configured Telegram owner, with private exclusive secret setup and no synthetic inbound updates ([#3802](https://github.com/ashlrai/phantom/pull/3802)).
- Publish opt-in machine telemetry with verified process attribution and preserve host/session pressure and launch-admission evidence ([#1152](https://github.com/ashlrai/phantom/pull/1152), [#3280](https://github.com/ashlrai/phantom/pull/3280)).
- Restore durable wake hints only after accepted channel publication ([#3260](https://github.com/ashlrai/phantom/pull/3260)).

### Build and verification

- Reuse verified compiler state for exact protected-source checks while keeping actual type and authority checks ([#3805](https://github.com/ashlrai/phantom/pull/3805)).
- Bound exhaustive Mac audit concurrency with four stable runner pools, keeping release capacity separate, and restore failure-first test ordering ([#3803](https://github.com/ashlrai/phantom/pull/3803), [#3804](https://github.com/ashlrai/phantom/pull/3804)).

## [3.30.21] — 2026-11-06

### Fixes

- Keep fresh quota-custody validation off the desktop HTTP thread with a bounded single-flight worker and main-owned guarded commit ([#3799](https://github.com/ashlrai/phantom/pull/3799)).
- Show distinct resource accounts separately from supplementary usage evidence, expire session readings at their original deadlines, and label historical planning controls accurately ([#3800](https://github.com/ashlrai/phantom/pull/3800)).
- Preserve the guarded complete self-tick stage and deduplicated bus-meter behavior ([#3275](https://github.com/ashlrai/phantom/pull/3275)).


### Changes

* **RQ-DRAIN-phantom-1017:** BRIDGE_NOTES — RQ-DRAIN-phantom-1017 ([#2826](https://github.com/ashlrai/phantom/issues/2826)) ([c74f380](https://github.com/ashlrai/phantom/commit/c74f380baece0a6ba230558e1b30bb8adea3b14f))
* **RQ-DRAINPH1245Q7:** RQ-DRAINPH1245Q7 ([#1516](https://github.com/ashlrai/phantom/issues/1516)) ([562bdbc](https://github.com/ashlrai/phantom/commit/562bdbc92baaae790f265ca8946efdf1ac4a3e9f))
* **RQ-N26-PH-CLI-EXITCODES:** Bridge notes ([#1164](https://github.com/ashlrai/phantom/issues/1164)) ([557c6b7](https://github.com/ashlrai/phantom/commit/557c6b711f3e319e5d929d90723560217696e903))

## [3.30.20] — 2026-11-06


### Fixes

* **desktop:** adopt delayed first sidecar tokens ([#3796](https://github.com/ashlrai/phantom/issues/3796)) ([eae9c22](https://github.com/ashlrai/phantom/commit/eae9c2283d529a8a729592b1eaa52cdc373246c5))
* **desktop:** verify admitted large runtime entries ([#3792](https://github.com/ashlrai/phantom/issues/3792)) ([ac2b366](https://github.com/ashlrai/phantom/commit/ac2b366e65f45cb11eecf6b05438279901abf232))


### Changes

* RQ-APP-DISKUTIL-LOOP ([#3276](https://github.com/ashlrai/phantom/issues/3276)) ([93666a4](https://github.com/ashlrai/phantom/commit/93666a41b06e815afaa094e5e30290beedebecbf))
* RQ-CI-ZERO-TREE-HISTORY-NOV6 ([#3795](https://github.com/ashlrai/phantom/issues/3795)) ([d71bc1d](https://github.com/ashlrai/phantom/commit/d71bc1dd3ece960dbf502f1eb4a4a114d8d845cc))
* **RQ-CI-ZERO-TREE-HISTORY-NOV6:** History-only PRs and merge groups with the exact protected s ([#3791](https://github.com/ashlrai/phantom/issues/3791)) ([3a4074f](https://github.com/ashlrai/phantom/commit/3a4074f5257dca66cc20290a56cde030062420e1))
* **RQ-CONS-STALE-CLOSEPACK-1:** RQ-CONS-STALE-CLOSEPACK-1 handoff ([#3725](https://github.com/ashlrai/phantom/issues/3725)) ([692f8b8](https://github.com/ashlrai/phantom/commit/692f8b811debe75ece2f9dd2e56d5c2f8bc2bc0e))
* **RQ-DOTREPLYQ8:** RQ-DOTREPLYQ8 ([#3709](https://github.com/ashlrai/phantom/issues/3709)) ([3e56a5b](https://github.com/ashlrai/phantom/commit/3e56a5b93022c5d0d9313343455bdedaf0710dfd))
* **RQ-GUARDIANHEALTHQ8:** RQ-GUARDIANHEALTHQ8 handoff ([#3721](https://github.com/ashlrai/phantom/issues/3721)) ([202d2ca](https://github.com/ashlrai/phantom/commit/202d2ca42c4fc6e041047fd355ae6b6de55a56e6))
* **RQ-OSS-AGGREGATE-1:** RQ-OSS-AGGREGATE-1 bridge notes ([#3727](https://github.com/ashlrai/phantom/issues/3727)) ([db130e3](https://github.com/ashlrai/phantom/commit/db130e39e72f0d793dffe6afc2599ee8aee5e362))
* **RQ-OSS-MCP-SKILLS-1:** BRIDGE_NOTES — RQ-OSS-MCP-SKILLS-1 ([#3730](https://github.com/ashlrai/phantom/issues/3730)) ([47d86cd](https://github.com/ashlrai/phantom/commit/47d86cdd2ec07ff9483e009d0aa86d1d4376c072))
* **RQ-OSS-MULTINODE-1:** Bridge notes — RQ-OSS-MULTINODE-1 ([#3728](https://github.com/ashlrai/phantom/issues/3728)) ([cbbfedc](https://github.com/ashlrai/phantom/commit/cbbfedcb44f998c203d6ced6601cf85e87a946ea))
* **RQ-OSS-SPEED-LOCAL-1:** RQ-OSS-SPEED-LOCAL-1 bridge notes ([#3726](https://github.com/ashlrai/phantom/issues/3726)) ([bc46637](https://github.com/ashlrai/phantom/commit/bc4663781ec62573b7d40b474146298c36f67250))
* **RQ-PHX-RECONCILECANDIDATEMCP05STH1:** BRIDGE_NOTES — RQ-PHX-RECONCILECANDIDATEMCP05STH1 ([#3720](https://github.com/ashlrai/phantom/issues/3720)) ([955aa6d](https://github.com/ashlrai/phantom/commit/955aa6dc46d17d74b515d341bfd1b05b278c0bf3))
* **RQ-PHX-RECONCILEDISCOVERY05STK2:** BRIDGE_NOTES — RQ-PHX-RECONCILEDISCOVERY05STK2 ([#3734](https://github.com/ashlrai/phantom/issues/3734)) ([17b26b1](https://github.com/ashlrai/phantom/commit/17b26b1633b81abd9ceb0535ec013aeb25b63d38))
* **RQ-PHX-RECONCILELITERAL06STL2:** PR [#3479](https://github.com/ashlrai/phantom/issues/3479) preservation bridge ([#3732](https://github.com/ashlrai/phantom/issues/3732)) ([92be5c4](https://github.com/ashlrai/phantom/commit/92be5c405d21cb47764bef23a0492ac2343bc3cd))
* **RQ-PHX-RECONCILEPLANWAIT05STK1:** Receipt wait preservation bridge ([#3724](https://github.com/ashlrai/phantom/issues/3724)) ([2ce2ad6](https://github.com/ashlrai/phantom/commit/2ce2ad6bc16f46fc89439034a4659bd8143de794))
* **RQ-PHX-RECONCILERECEIPTSLICE05STG1:** PR [#3663](https://github.com/ashlrai/phantom/issues/3663) reconciliation handoff ([#3713](https://github.com/ashlrai/phantom/issues/3713)) ([3462cdb](https://github.com/ashlrai/phantom/commit/3462cdbc9e0a9105f456be5d029d4c19ce7ffa16))
* **RQ-PHX-STAGINGSTOPROOTS05STC2:** BRIDGE_NOTES: RQ-PHX-STAGINGSTOPROOTS05STC2 ([#3710](https://github.com/ashlrai/phantom/issues/3710)) ([a74f820](https://github.com/ashlrai/phantom/commit/a74f820b1bc2ccd8c730f9e91c521eebb76acf02))
* RQ-RECUT-V330-CIFIX-10R3-ONBOARD-NOV6 ([#3794](https://github.com/ashlrai/phantom/issues/3794)) ([6db19f6](https://github.com/ashlrai/phantom/commit/6db19f63d96cd6f3599ee4329309c0900fe19d21))

## [3.30.19] — 2026-11-06


### Fixes

* **release:** preserve qualified tracked native icons ([#3789](https://github.com/ashlrai/phantom/issues/3789)) ([7481256](https://github.com/ashlrai/phantom/commit/748125663263c882d0e1ea61cd4d50ce89ff0625))

## [3.30.18] — 2026-11-06


### Tests

* classify real installer proofs in the real-I/O lane ([#3786](https://github.com/ashlrai/phantom/issues/3786)) ([e3284a3](https://github.com/ashlrai/phantom/commit/e3284a36573605000ededc8d4e9a537987fcd336))

## [3.30.17] — 2026-11-06


### Changes

* RQ-RECUT-V330-CIFIX-6R2-MACMEM-NOV6 ([#3784](https://github.com/ashlrai/phantom/issues/3784)) ([a0df5df](https://github.com/ashlrai/phantom/commit/a0df5df9e6b11c8a917acfb8bcc871f5b898f5d1))

## [3.30.16] — 2026-11-06


### Changes

* RQ-RECUT-V330-CIFIX-6R2-MACMEM-NOV6 ([#3782](https://github.com/ashlrai/phantom/issues/3782)) ([b2cf6a3](https://github.com/ashlrai/phantom/commit/b2cf6a38e00103fbd6b1dbb770027bed2759b2b3))

## [3.30.15] — 2026-11-06


### Changes

* RQ-RELEASE-DESKTOP-UNQUARANTINE-2 ([#3780](https://github.com/ashlrai/phantom/issues/3780)) ([ddd0020](https://github.com/ashlrai/phantom/commit/ddd0020bc407b8852f02b27c24428ae95573e2ac))

## [3.30.14] — 2026-11-06


### Changes

* RQ-RELEASE-DESKTOP-UNQUARANTINE-2 ([#3776](https://github.com/ashlrai/phantom/issues/3776)) ([6967ffa](https://github.com/ashlrai/phantom/commit/6967ffac67716c6a296112086551cdbd8d692273))
* RQ-RELEASE-DESKTOP-UNQUARANTINE-2 ([#3777](https://github.com/ashlrai/phantom/issues/3777)) ([bd0c161](https://github.com/ashlrai/phantom/commit/bd0c161c11cb3850fe075847b985347b2b1e42b8))
* RQ-RELEASE-DESKTOP-UNQUARANTINE-2 ([#3779](https://github.com/ashlrai/phantom/issues/3779)) ([73a80b1](https://github.com/ashlrai/phantom/commit/73a80b13472024b6f81523a5bdfea4bf72c93740))

## [3.30.13] — 2026-11-06


### Changes

* RQ-RECUT-V330-FIXTURES-NOV6 ([#3771](https://github.com/ashlrai/phantom/issues/3771)) ([2106039](https://github.com/ashlrai/phantom/commit/2106039ade5cab9c35efd1be96621f06e84ed5cc))
* RQ-RECUT-V330-FIXTURES-NOV6 ([#3773](https://github.com/ashlrai/phantom/issues/3773)) ([05fd959](https://github.com/ashlrai/phantom/commit/05fd9597d2cf735824948aed8a144c46aa28c40e))
* RQ-RECUT-V330-FIXTURES-NOV6 ([#3774](https://github.com/ashlrai/phantom/issues/3774)) ([ba3db13](https://github.com/ashlrai/phantom/commit/ba3db1316b155f230b45a3b425d3b32df8d42444))
* RQ-RELEASE-DESKTOP-UNQUARANTINE-2 ([#3772](https://github.com/ashlrai/phantom/issues/3772)) ([be1946b](https://github.com/ashlrai/phantom/commit/be1946b03c19e0158d35bb8ea8a2a1239e4f5637))

## [3.30.12] — 2026-11-06


### Changes

* RQ-MAC-PUBLISH-RESILIENCE ([#1100](https://github.com/ashlrai/phantom/issues/1100)) ([cc59555](https://github.com/ashlrai/phantom/commit/cc5955587dfa26256461287c55fd20b3e109077e))
* RQ-MAC-PUBLISH-RESILIENCE ([#3746](https://github.com/ashlrai/phantom/issues/3746)) ([50143f8](https://github.com/ashlrai/phantom/commit/50143f8790eb9c9e1f3a97ebe02eabfdda58aaf9))
* RQ-PHX-TEAMMATETEXTS25 ([#3723](https://github.com/ashlrai/phantom/issues/3723)) ([e68b89e](https://github.com/ashlrai/phantom/commit/e68b89ebe68247f2a4f6fdc70441842c813479c3))
* RQ-PHX-TEAMMATETEXTS25 ([#3748](https://github.com/ashlrai/phantom/issues/3748)) ([a527459](https://github.com/ashlrai/phantom/commit/a527459b3a1f17a9d3b229365b2d206f08c28ae0))
* RQ-RECUT-V330-CIFIX-10R3-ONBOARD-NOV6 ([#3750](https://github.com/ashlrai/phantom/issues/3750)) ([963ba88](https://github.com/ashlrai/phantom/commit/963ba88ae16db7cdedf59214298070da5e35eb3c))
* **RQ-RECUT-V330-CIFIX-10R3-ONBOARD-NOV6:** Onboarding continuation handoff ([#3735](https://github.com/ashlrai/phantom/issues/3735)) ([313239b](https://github.com/ashlrai/phantom/commit/313239bc4d533b624d12bf789b0edb6515924da9))
* RQ-RECUT-V330-CIFIX-6R2-MACMEM-NOV6 ([#3754](https://github.com/ashlrai/phantom/issues/3754)) ([ba51cda](https://github.com/ashlrai/phantom/commit/ba51cdaba3e7167f54021e8b7d8ec2b574e1f3a7))
* **RQ-RECUT-V330-CIFIX-6R2-MACMEM-NOV6:** Bound the resource supervisor capacity assertion ([#3743](https://github.com/ashlrai/phantom/issues/3743)) ([fc537a9](https://github.com/ashlrai/phantom/commit/fc537a920f9618da1d0e96147c212c34db636e4d))
* **RQ-RECUT-V330-CIFIX-TITLES-NOV6:** BRIDGE_NOTES — RQ-RECUT-V330-CIFIX-TITLES-NOV6 ([#3752](https://github.com/ashlrai/phantom/issues/3752)) ([40364cb](https://github.com/ashlrai/phantom/commit/40364cb91feac0faa50e317a5ac5c784aa453222))
* RQ-RECUT-V330-CIFIX23-NATIVE-NOV6 ([#3749](https://github.com/ashlrai/phantom/issues/3749)) ([ab3d126](https://github.com/ashlrai/phantom/commit/ab3d126695316ad8adaee7c6b9087813de27971e))
* **RQ-RECUT-V330-CIFIX23-NATIVE-NOV6:** Preserve the real environment-credential reader in API versi ([#3744](https://github.com/ashlrai/phantom/issues/3744)) ([32d2100](https://github.com/ashlrai/phantom/commit/32d2100cfd9a39d11c7aa4fb7df1e489321808ef))
* **RQ-RECUT-V330-CIFIX24-COMMSV2-NOV6:** CIFIX24 communications V2 handoff ([#3755](https://github.com/ashlrai/phantom/issues/3755)) ([5826f9a](https://github.com/ashlrai/phantom/commit/5826f9a1e6befd42c9ef6db1485cfbdab2da4922))
* RQ-RECUT-V330-CLIHELP-CONTRACTS-NOV6 ([#3759](https://github.com/ashlrai/phantom/issues/3759)) ([cdb208f](https://github.com/ashlrai/phantom/commit/cdb208f17962afb21d62e5d2490220328a4145e1))
* **RQ-RECUT-V330-CLIHELP-NOV6:** CLI channels help handoff ([#3738](https://github.com/ashlrai/phantom/issues/3738)) ([05130d0](https://github.com/ashlrai/phantom/commit/05130d083751465a3f5812254ec9a26a37de076d))
* RQ-RECUT-V330-ENGINEAVAILABLE-NOV6 ([#3747](https://github.com/ashlrai/phantom/issues/3747)) ([ab93279](https://github.com/ashlrai/phantom/commit/ab93279fc2aeeb69ff8b1aaca0e6f5e07de475d3))
* **RQ-RECUT-V330-ENGINEAVAILABLE-NOV6:** Bridge notes ([#3741](https://github.com/ashlrai/phantom/issues/3741)) ([9b8f117](https://github.com/ashlrai/phantom/commit/9b8f117888fa6180965d208cca144bc8381456a9))
* **RQ-RECUT-V330-ENGINEAVAILABLE-RESOURCE-NOV6:** Resource observation repair handoff ([#3751](https://github.com/ashlrai/phantom/issues/3751)) ([7bd8384](https://github.com/ashlrai/phantom/commit/7bd83845a42ebce87df365d70a8a693dfe784121))
* **RQ-RECUT-V330-FIXTURES-NOV6:** Align retained resource and Verse fixtures with current cont ([#3760](https://github.com/ashlrai/phantom/issues/3760)) ([83afd78](https://github.com/ashlrai/phantom/commit/83afd7864b85be19fc4f1b90ec2bd72fdbb69287))
* **RQ-RECUT-V330-FLEETMCP-INVENTORY-NOV6:** Bridge notes — MCP inventory and payload guard ([#3758](https://github.com/ashlrai/phantom/issues/3758)) ([ff83725](https://github.com/ashlrai/phantom/commit/ff83725cb703416e9927181f8cc8f37f778a1fa0))
* **RQ-RECUT-V330-FLEETMCP-NOV6:** Fleet release/recovery bridge ([#3737](https://github.com/ashlrai/phantom/issues/3737)) ([2ab869c](https://github.com/ashlrai/phantom/commit/2ab869ca03ffc863c52072aa632b5f7344dee1b7))
* **RQ-RECUT-V330-FLEETMCP-PLANNER-NOV6:** Repair planner and fleet runtime contracts ([#3745](https://github.com/ashlrai/phantom/issues/3745)) ([1805d09](https://github.com/ashlrai/phantom/commit/1805d09997b6b64c35f37494a01933b7c7f4bbed))
* RQ-RECUT-V330-WEB-COMPOSER-NOV6 ([#3757](https://github.com/ashlrai/phantom/issues/3757)) ([30c77f3](https://github.com/ashlrai/phantom/commit/30c77f33fbfbedb20f9fff4ccbcc247d1a1240e2))
* **RQ-RECUT-V330-WEB-COMPOSER-NOV6:** Web composer owner continuation ([#3733](https://github.com/ashlrai/phantom/issues/3733)) ([3233354](https://github.com/ashlrai/phantom/commit/3233354e07188096bad4204115b4306cc096562a))
* RQ-RECUT-V330-WEB-FLEET-NOV6 ([#3740](https://github.com/ashlrai/phantom/issues/3740)) ([4578c11](https://github.com/ashlrai/phantom/commit/4578c117f792d42f4ed9676621d48200d4efe55c))
* **RQ-RECUT-V330-WEB-MOBILE-NOV6:** Mobile web owner continuation ([#3756](https://github.com/ashlrai/phantom/issues/3756)) ([fdb24d0](https://github.com/ashlrai/phantom/commit/fdb24d088ed465f16cbde27a49d9ae3a2f28ae45))
* **RQ-RECUT-V330-WEB-SHELL-NOV6:** Web shell release repair ([#3739](https://github.com/ashlrai/phantom/issues/3739)) ([0c81b56](https://github.com/ashlrai/phantom/commit/0c81b56588e45c6baa7332ec87cc408f467ff8b4))
* RQ-RELEASE-DESKTOP-UNQUARANTINE-2 ([#3722](https://github.com/ashlrai/phantom/issues/3722)) ([c86e881](https://github.com/ashlrai/phantom/commit/c86e881eaec747f26bb37b64c5565a6bf74f05ec))
* RQ-RELEASE-DESKTOP-UNQUARANTINE-2 ([#3742](https://github.com/ashlrai/phantom/issues/3742)) ([64ec88f](https://github.com/ashlrai/phantom/commit/64ec88f5c85977cb19ca5d8b011c24024b9d2b06))
* RQ-RELEASE-DESKTOP-UNQUARANTINE-2 ([#3753](https://github.com/ashlrai/phantom/issues/3753)) ([44f7c3e](https://github.com/ashlrai/phantom/commit/44f7c3ee38645a27a6e3f3267472376e5354617e))
* RQ-V330-CIFIX-2 ([#3630](https://github.com/ashlrai/phantom/issues/3630)) ([c7a19f3](https://github.com/ashlrai/phantom/commit/c7a19f328713c9abe078f1b5752abf330c09875a))

## [3.30.11] — 2026-11-06


### Changes

* RQ-RELEASE-DESKTOP-UNQUARANTINE-2 ([#3715](https://github.com/ashlrai/phantom/issues/3715)) ([261c520](https://github.com/ashlrai/phantom/commit/261c5200129b50ee246ec85fc1ec339c9a282915))

## [3.30.10] — 2026-11-06


### Features

* connect authenticated Slack to Phantom Leader ([#3697](https://github.com/ashlrai/phantom/issues/3697)) ([78ca550](https://github.com/ashlrai/phantom/commit/78ca55033b74b9359f4fda87e5576e4897a5b9bb))


### Fixes

* bind historical updater feed identities ([#3694](https://github.com/ashlrai/phantom/issues/3694)) ([93af05a](https://github.com/ashlrai/phantom/commit/93af05a2c7b4938b6e3301dbab136fcd1cc32255))
* include current operator guides in release package ([#3700](https://github.com/ashlrai/phantom/issues/3700)) ([91235fd](https://github.com/ashlrai/phantom/commit/91235fde153241806d04c5f689e2c0662d762d68))
* protect stable release finalizer authority ([#3692](https://github.com/ashlrai/phantom/issues/3692)) ([cd22d72](https://github.com/ashlrai/phantom/commit/cd22d72c63954436458e359f7cef110e0fdb7104))
* reconcile updater recovery and publication evidence ([#3706](https://github.com/ashlrai/phantom/issues/3706)) ([59b3097](https://github.com/ashlrai/phantom/commit/59b30970a630672055be38cf8603b4ccae73b5db))
* recover desktop smoke after empty latest release ([#3675](https://github.com/ashlrai/phantom/issues/3675)) ([3cadede](https://github.com/ashlrai/phantom/commit/3cadeded9b3c01ad3fabbfb083ba1ce2b1c33805))
* report private-safe desktop finalization phases ([#3696](https://github.com/ashlrai/phantom/issues/3696)) ([f2dc2ed](https://github.com/ashlrai/phantom/commit/f2dc2ed21b5f48053f7a971e069f2726ae27203b))
* restore local Phantom teammate replies ([#3598](https://github.com/ashlrai/phantom/issues/3598)) ([a3a2408](https://github.com/ashlrai/phantom/commit/a3a2408830d1b5aaa474ddb3fbcfc63c8c547c8a))
* run teammate replies inside Phantom ([#3695](https://github.com/ashlrai/phantom/issues/3695)) ([ef0718c](https://github.com/ashlrai/phantom/commit/ef0718c6bceb2d8ed1e18056bbc941e5f24a9833))


### Changes

* **RQ-DISKMAINT-1:** BRIDGE_NOTES - RQ-DISKMAINT-1 ([#3680](https://github.com/ashlrai/phantom/issues/3680)) ([ee5dd4e](https://github.com/ashlrai/phantom/commit/ee5dd4e789b0e038b15393188ab7274d77ab1142))
* **RQ-LEADER-CEO-1:** RQ-LEADER-CEO-1 bridge notes ([#3677](https://github.com/ashlrai/phantom/issues/3677)) ([32a92b0](https://github.com/ashlrai/phantom/commit/32a92b09ffa6457bf7e413dffc3c49465fd60fa9))
* **RQ-OUTBOXFALLBACKQ8:** RQ-OUTBOXFALLBACKQ8 ([#3707](https://github.com/ashlrai/phantom/issues/3707)) ([c633f05](https://github.com/ashlrai/phantom/commit/c633f05ce3c3ae27fda04cad561ff3cad903ad04))
* **RQ-PHX-INSTALLEDMILESTONEREAD05SSV2:** Bridge notes ([#3676](https://github.com/ashlrai/phantom/issues/3676)) ([2a98a51](https://github.com/ashlrai/phantom/commit/2a98a51d951fb568bc773495173090d1571f31a0))
* **RQ-PHX-MCPSTAGINGBATCH05SSZ2:** Staging inventory batch MCP handoff ([#3684](https://github.com/ashlrai/phantom/issues/3684)) ([ad35f75](https://github.com/ashlrai/phantom/commit/ad35f75413f979b073ebfc6d0bdf5b0feb6b4749))
* **RQ-PHX-MCPSTAGINGCANCEL05STB2:** MCP staging cancellation handoff ([#3689](https://github.com/ashlrai/phantom/issues/3689)) ([370ad1c](https://github.com/ashlrai/phantom/commit/370ad1cd998e396d313515cc712ea07d2899ba64))
* **RQ-PHX-MCPSTAGINGRETRY05STD1:** MCP staging retry handoff ([#3693](https://github.com/ashlrai/phantom/issues/3693)) ([e027319](https://github.com/ashlrai/phantom/commit/e027319f830c8ee47656a53b1c82c1563d0fffe7))
* **RQ-PHX-STAGINGASYNCDU05STA1:** Staging inventory responsiveness handoff ([#3686](https://github.com/ashlrai/phantom/issues/3686)) ([a62da61](https://github.com/ashlrai/phantom/commit/a62da61d1d275d669f6f3233c30aacd89f301379))
* **RQ-PHX-STAGINGBATCH05SSW2:** Staging inventory batch handoff ([#3679](https://github.com/ashlrai/phantom/issues/3679)) ([2d98ecd](https://github.com/ashlrai/phantom/commit/2d98ecd02c61240e14f7a84c1e818c85bd18ba15))
* **RQ-PHX-STAGINGBATCHHELP05SSZ1:** BRIDGE_NOTES: RQ-PHX-STAGINGBATCHHELP05SSZ1 ([#3688](https://github.com/ashlrai/phantom/issues/3688)) ([e61dbb1](https://github.com/ashlrai/phantom/commit/e61dbb1ecf2017d916fc233e08fc0aab691e0dde))
* **RQ-PHX-STAGINGBATCHPROGRESS05SSY1:** Staging batch progress handoff ([#3683](https://github.com/ashlrai/phantom/issues/3683)) ([b78a0d3](https://github.com/ashlrai/phantom/commit/b78a0d33bfc215a7cbda5c371ff94f0bac71367a))
* **RQ-PHX-STAGINGBATCHREACH05SSX1:** Staging batch dispatch handoff ([#3682](https://github.com/ashlrai/phantom/issues/3682)) ([ba59bf8](https://github.com/ashlrai/phantom/commit/ba59bf8c843f3f8ed1b8fd2fabc6f1d1be26dee9))
* **RQ-PHX-STAGINGBATCHSTOP05STA2:** Staging batch stop handoff ([#3687](https://github.com/ashlrai/phantom/issues/3687)) ([d2a8501](https://github.com/ashlrai/phantom/commit/d2a8501113c1b7bece31e294d982261f57cee31d))
* **RQ-PHX-STAGINGRETRY05STB1:** Staging inventory retry handoff ([#3690](https://github.com/ashlrai/phantom/issues/3690)) ([c7a1ff2](https://github.com/ashlrai/phantom/commit/c7a1ff24918b4e3d2d6d0fec1d935f3d8bdffb14))
* **RQ-PHX-STAGINGRETRYCANCEL05STC1:** Staging inventory cancellation retry handoff ([#3691](https://github.com/ashlrai/phantom/issues/3691)) ([623925f](https://github.com/ashlrai/phantom/commit/623925f9401f56c99dfdab0dd40d3ca38c8e7e5b))
* **RQ-RECUT-MACDISPATCH-SNAPSHOT-NOV5:** Bound macOS fleet process ownership observations ([#3704](https://github.com/ashlrai/phantom/issues/3704)) ([423a2a7](https://github.com/ashlrai/phantom/commit/423a2a7db52a2ef31b5b12a9e104364616b30f0b))
* **RQ-RECUT-MR-CONFLICT-DRIVERS-phantom-NOV5-R2:** Recovery Apps backlog integration against current iMessage o ([#3708](https://github.com/ashlrai/phantom/issues/3708)) ([4630340](https://github.com/ashlrai/phantom/commit/46303405152a552e75d241e5bbb4992db92a5069))
* RQ-RELEASE-DESKTOP-UNQUARANTINE-2 ([#3712](https://github.com/ashlrai/phantom/issues/3712)) ([df2b35f](https://github.com/ashlrai/phantom/commit/df2b35fcfe3f63de6b943d50252fd8f3ddf3b9f9))
* **RQ-V330-CIFIX-10R3:** RQ-V330-CIFIX-10R3 ([#3703](https://github.com/ashlrai/phantom/issues/3703)) ([6c7b0f5](https://github.com/ashlrai/phantom/commit/6c7b0f5255b42cc0dc96bd75422c95a14ac33448))
* **RQ-V330-CIFIX-15R2:** RQ-V330-CIFIX-15R2 ([#3702](https://github.com/ashlrai/phantom/issues/3702)) ([f0f9a0f](https://github.com/ashlrai/phantom/commit/f0f9a0f69194ee97d1b52ef15ac5b74f60f6d9c6))
* **RQ-V330-CIFIX-22:** BRIDGE_NOTES: RQ-V330-CIFIX-22 ([#3698](https://github.com/ashlrai/phantom/issues/3698)) ([b8a82fe](https://github.com/ashlrai/phantom/commit/b8a82fe2625288f39c4e497c626b4c6065941c16))
* **RQ-V330-CIFIX-23:** BRIDGE_NOTES - RQ-V330-CIFIX-23 ([#3701](https://github.com/ashlrai/phantom/issues/3701)) ([fb60409](https://github.com/ashlrai/phantom/commit/fb60409191a8dc2600e4d151e52cb38de4a10999))
* **RQ-V330-CIFIX-24:** RQ-V330-CIFIX-24 ([#3699](https://github.com/ashlrai/phantom/issues/3699)) ([1cb7fd5](https://github.com/ashlrai/phantom/commit/1cb7fd55f34e8450a23e44c95fa3e6cc182be37d))

## [3.30.9] — 2026-11-05


### Changes

* **RQ-PHX-CIMCPRECOVERYPIPE05SSG2:** BRIDGE_NOTES — RQ-PHX-CIMCPRECOVERYPIPE05SSG2 ([#3660](https://github.com/ashlrai/phantom/issues/3660)) ([3c9e0df](https://github.com/ashlrai/phantom/commit/3c9e0dfd6fa1675f9f835151b882f99741e18723))
* **RQ-PHX-CIRECEIPTAWAITBATCH05SRZ1:** BRIDGE_NOTES — RQ-PHX-CIRECEIPTAWAITBATCH05SRZ1 ([#3656](https://github.com/ashlrai/phantom/issues/3656)) ([89690c0](https://github.com/ashlrai/phantom/commit/89690c09bd1cac064d59719219edd8b3205bb445))
* **RQ-PHX-CIRECEIPTPROGRESS05SSH2:** Batch receipt progress bridge ([#3662](https://github.com/ashlrai/phantom/issues/3662)) ([150f8c5](https://github.com/ashlrai/phantom/commit/150f8c5e08a958e7d75488b1245f6f9779a74481))
* **RQ-PHX-CIRECEIPTSELECT05SSL1:** BRIDGE NOTES — RQ-PHX-CIRECEIPTSELECT05SSL1 ([#3665](https://github.com/ashlrai/phantom/issues/3665)) ([f69629a](https://github.com/ashlrai/phantom/commit/f69629a575303a81483df70bb1924a52e4504e2c))
* **RQ-PHX-CIRESUMERENAME05SSC1:** BRIDGE_NOTES — RQ-PHX-CIRESUMERENAME05SSC1 ([#3659](https://github.com/ashlrai/phantom/issues/3659)) ([78cc2e0](https://github.com/ashlrai/phantom/commit/78cc2e065d03b549edb4313543e0ba42b24bb91b))
* **RQ-PHX-MCPRECEIPTBATCH05SSJ1:** BRIDGE_NOTES — RQ-PHX-MCPRECEIPTBATCH05SSJ1 ([#3664](https://github.com/ashlrai/phantom/issues/3664)) ([c6a0296](https://github.com/ashlrai/phantom/commit/c6a0296af55034ca7b9b0c82a7eaa6d53a8108b6))
* **RQ-PHX-RECEIPTBATCHREPLAN05SSK1:** BRIDGE_NOTES — RQ-PHX-RECEIPTBATCHREPLAN05SSK1 ([#3666](https://github.com/ashlrai/phantom/issues/3666)) ([1ec1c18](https://github.com/ashlrai/phantom/commit/1ec1c18bb327e5080bdd8837e0e3571d5bbff57b))
* **RQ-PHX-RELEASEBATCHCANCEL05SRZ2:** RQ-PHX-RELEASEBATCHCANCEL05SRZ2 — Batch Cancellation ([#3657](https://github.com/ashlrai/phantom/issues/3657)) ([1d8a357](https://github.com/ashlrai/phantom/commit/1d8a357343260efaa057ce6e1e3957cd2242d045))
* **RQ-PHX-RELEASEPACEDRETRY05SSN2:** BRIDGE_NOTES — RQ-PHX-RELEASEPACEDRETRY05SSN2 ([#3661](https://github.com/ashlrai/phantom/issues/3661)) ([5a64590](https://github.com/ashlrai/phantom/commit/5a645908f250eec14948492e18aa5793530c82e7))
* **RQ-PHX-RELEASERETRYPIPE05SSA2:** BRIDGE_NOTES: RQ-PHX-RELEASERETRYPIPE05SSA2 ([#3655](https://github.com/ashlrai/phantom/issues/3655)) ([b7a43e7](https://github.com/ashlrai/phantom/commit/b7a43e79113fb218ed38ef03ffa08f6c3bcad1c9))
* **RQ-PHX-RELEASERETRYREENTRANT05SSD1:** RQ-PHX-RELEASERETRYREENTRANT05SSD1 ([#3658](https://github.com/ashlrai/phantom/issues/3658)) ([d5a7a3a](https://github.com/ashlrai/phantom/commit/d5a7a3acb3c7361bbdf6a1934c0874a39bfd92b7))

## [3.30.8] — 2026-11-05


### Changes

* **RQ-PHX-CANDIDATESHA05SRK2:** Candidate SHA inspection handoff ([#3629](https://github.com/ashlrai/phantom/issues/3629)) ([3e214cf](https://github.com/ashlrai/phantom/commit/3e214cfec1c5796f6b2d07eaa6cfb5dd14c6f899))
* **RQ-PHX-CIDISCOVERYPIPE05SRS1:** RQ-PHX-CIDISCOVERYPIPE05SRS1 ([#3642](https://github.com/ashlrai/phantom/issues/3642)) ([25da983](https://github.com/ashlrai/phantom/commit/25da9835a67dd9af39909f3ea2f49caa58e8b2ba))
* **RQ-PHX-CIFAILEDRETRY05SRG1:** BRIDGE_NOTES — RQ-PHX-CIFAILEDRETRY05SRG1 ([#3624](https://github.com/ashlrai/phantom/issues/3624)) ([947fd9c](https://github.com/ashlrai/phantom/commit/947fd9c48b95d78971e09a5d72c2605287a2db76))
* **RQ-PHX-CIRECEIPTAWAIT05SRU1:** BRIDGE_NOTES — RQ-PHX-CIRECEIPTAWAIT05SRU1 ([#3646](https://github.com/ashlrai/phantom/issues/3646)) ([115c825](https://github.com/ashlrai/phantom/commit/115c8257d52abe6bf8e906786cb7c1742e568255))
* **RQ-PHX-CIRECEIPTDISCOVER05SRQ1:** BRIDGE_NOTES — RQ-PHX-CIRECEIPTDISCOVER05SRQ1 ([#3641](https://github.com/ashlrai/phantom/issues/3641)) ([b658b74](https://github.com/ashlrai/phantom/commit/b658b742c987774f0d1e056d919256dea9501021))
* **RQ-PHX-CIRECEIPTFETCH05SRK1:** BRIDGE_NOTES — RQ-PHX-CIRECEIPTFETCH05SRK1 ([#3635](https://github.com/ashlrai/phantom/issues/3635)) ([fa00f95](https://github.com/ashlrai/phantom/commit/fa00f95d44fe81ed94c87edbc608fb1837e0d022))
* **RQ-PHX-CIRECEIPTSEED05SRM2:** CI input digest seeds handoff ([#3634](https://github.com/ashlrai/phantom/issues/3634)) ([b4645b5](https://github.com/ashlrai/phantom/commit/b4645b595c0bf484fffe674178d22b2061de1b3b))
* **RQ-PHX-CIRESUMEBYNAME05SRV1:** CI resume plan by artifact name ([#3649](https://github.com/ashlrai/phantom/issues/3649)) ([7ae51de](https://github.com/ashlrai/phantom/commit/7ae51ded5174eba69a3fa3fe5bbbaf21e9e163c3))
* **RQ-PHX-CIRESUMEFETCHPLAN05SRR2:** CI resume plan handoff ([#3643](https://github.com/ashlrai/phantom/issues/3643)) ([a06f7dc](https://github.com/ashlrai/phantom/commit/a06f7dc840617e7ce617352ff47ae06d2820e242))
* **RQ-PHX-CIRESUMEINPUTS05SRF1:** BRIDGE_NOTES — RQ-PHX-CIRESUMEINPUTS05SRF1 (resume-from-fail ([#3625](https://github.com/ashlrai/phantom/issues/3625)) ([b5560b2](https://github.com/ashlrai/phantom/commit/b5560b2e49d376eef9e64fa9600ca28367cb8b3b))
* **RQ-PHX-CIRESUMESTDIN05SRL2:** BRIDGE_NOTES — RQ-PHX-CIRESUMESTDIN05SRL2 (Nov 5 01:47 P0 RE ([#3633](https://github.com/ashlrai/phantom/issues/3633)) ([1bd2c48](https://github.com/ashlrai/phantom/commit/1bd2c48c7f5951b8319181a143efc8af19fd1983))
* **RQ-PHX-CISTDINREALPIPE05SRN1:** Bridge notes — real stdin pipe ([#3637](https://github.com/ashlrai/phantom/issues/3637)) ([da180c9](https://github.com/ashlrai/phantom/commit/da180c91635465d6faf80d030483739a03688c2f))
* **RQ-PHX-COMMSCUTOVER05SRB1:** BRIDGE_NOTES — RQ-PHX-COMMSCUTOVER05SRB1 ([#3618](https://github.com/ashlrai/phantom/issues/3618)) ([8d6faef](https://github.com/ashlrai/phantom/commit/8d6faef826eccf0833808832c90d10262ffeb5eb))
* **RQ-PHX-MCPCIAWAIT05SRX2:** BRIDGE_NOTES — RQ-PHX-MCPCIAWAIT05SRX2 ([#3652](https://github.com/ashlrai/phantom/issues/3652)) ([4198328](https://github.com/ashlrai/phantom/commit/419832842580698f6d6a63de7e60921904850698))
* **RQ-PHX-MCPCIRESUME05SRJ1:** RQ-PHX-MCPCIRESUME05SRJ1 — fleet_ci_resume_inputs MCP tool ([#3632](https://github.com/ashlrai/phantom/issues/3632)) ([e77fb46](https://github.com/ashlrai/phantom/commit/e77fb46332374b1f64877633c473ab9743313c71))
* **RQ-PHX-MCPCOMMSREADINESS05SRG2:** Comms readiness MCP bridge ([#3622](https://github.com/ashlrai/phantom/issues/3622)) ([b8a2116](https://github.com/ashlrai/phantom/commit/b8a21168ba6967f7738e28a0a2265a40d21a04e3))
* **RQ-PHX-MCPEMAILWAITTRUTH05SRE2:** BRIDGE_NOTES.md — RQ-PHX-MCPEMAILWAITTRUTH05SRE2 ([#3623](https://github.com/ashlrai/phantom/issues/3623)) ([233cddf](https://github.com/ashlrai/phantom/commit/233cddfce981962986dce74a93458ecdccba0320))
* **RQ-PHX-MCPIMESSAGEEVIDENCE05SRC2:** BRIDGE_NOTES — RQ-PHX-MCPIMESSAGEEVIDENCE05SRC2 ([#3619](https://github.com/ashlrai/phantom/issues/3619)) ([9d6fed7](https://github.com/ashlrai/phantom/commit/9d6fed70b7c126d5620551925a2286670312ca32))
* **RQ-PHX-RELEASEADVANCE05SRL1:** BRIDGE_NOTES — RQ-PHX-RELEASEADVANCE05SRL1 ([#3631](https://github.com/ashlrai/phantom/issues/3631)) ([3532222](https://github.com/ashlrai/phantom/commit/353222298d79f5f26c4ee1f272d4b73f0229b521))
* **RQ-PHX-RELEASEADVANCEONCE05SRP2:** BRIDGE_NOTES — RQ-PHX-RELEASEADVANCEONCE05SRP2 ([#3639](https://github.com/ashlrai/phantom/issues/3639)) ([cb96dd6](https://github.com/ashlrai/phantom/commit/cb96dd6a350800f46cbec3606ed28496622999d1))
* **RQ-PHX-RELEASEADVANCEWAIT05SRN2:** Release advance wait handoff ([#3638](https://github.com/ashlrai/phantom/issues/3638)) ([b05dc4e](https://github.com/ashlrai/phantom/commit/b05dc4e222f2fb2b2eacd139ee8c3bcdd5bd9354))
* **RQ-PHX-RELEASEASSETTRUTH05SRH2:** Release asset truth handoff ([#3626](https://github.com/ashlrai/phantom/issues/3626)) ([9d26ba7](https://github.com/ashlrai/phantom/commit/9d26ba704fc90460256e28cbe96f530ac067d312))
* **RQ-PHX-RELEASEBATCH05SRS2:** BRIDGE_NOTES — RQ-PHX-RELEASEBATCH05SRS2 ([#3644](https://github.com/ashlrai/phantom/issues/3644)) ([e8f3184](https://github.com/ashlrai/phantom/commit/e8f3184a9b2327557760db46c25b0cf915d3787f))
* **RQ-PHX-RELEASEBATCHRETRY05SRW2:** BRIDGE_NOTES — RQ-PHX-RELEASEBATCHRETRY05SRW2 ([#3653](https://github.com/ashlrai/phantom/issues/3653)) ([02e9478](https://github.com/ashlrai/phantom/commit/02e947830ee5746e3a3a0a317293d47cb57100bb))
* **RQ-PHX-RELEASECANDIDATEPLAN05SRH1:** BRIDGE_NOTES — RQ-PHX-RELEASECANDIDATEPLAN05SRH1 ([#3627](https://github.com/ashlrai/phantom/issues/3627)) ([72367cc](https://github.com/ashlrai/phantom/commit/72367cc7da4816eaca2ba1eac8ebdeab65b9143d))
* **RQ-PHX-RELEASEMILESTONES05SRF2:** Release milestone bridge ([#3621](https://github.com/ashlrai/phantom/issues/3621)) ([73664a2](https://github.com/ashlrai/phantom/commit/73664a2b0efde6de5d09b03e78d71c2706e0ec0e))
* **RQ-PHX-RELEASEMILESTONEWAIT05SRJ2:** Release milestone await handoff ([#3628](https://github.com/ashlrai/phantom/issues/3628)) ([7f4fcc8](https://github.com/ashlrai/phantom/commit/7f4fcc8d61e7dc1653ae2d06ee53da3945a0bced))
* **RQ-PHX-RELEASEONCEREALPIPE05SRV2:** BRIDGE_NOTES — RQ-PHX-RELEASEONCEREALPIPE05SRV2 ([#3651](https://github.com/ashlrai/phantom/issues/3651)) ([9acbeca](https://github.com/ashlrai/phantom/commit/9acbeca930412f4067e330b0cf50fe25a82de9b4))
* **RQ-PHX-RELEASEONCERETRY05SRT1:** BRIDGE_NOTES — RQ-PHX-RELEASEONCERETRY05SRT1 ([#3647](https://github.com/ashlrai/phantom/issues/3647)) ([13aa5cf](https://github.com/ashlrai/phantom/commit/13aa5cf486be1e7de32fb6e86e26b43830f02471))
* **RQ-PHX-RELEASEWAITSERIAL05SRR1:** BRIDGE_NOTES — RQ-PHX-RELEASEWAITSERIAL05SRR1 ([#3645](https://github.com/ashlrai/phantom/issues/3645)) ([50ff472](https://github.com/ashlrai/phantom/commit/50ff4724f172913477e9c22edc17496f630ca6c4))

## [3.30.1] — 2026-11-05

### Changed
- Prepare continuous patch releases from green master commits on a configurable
  30-minute cadence, with the README, desktop version carriers and generated
  release notes updated together in the release PR.
- Reuse the exact commit's green push CI evidence for desktop release
  qualification while keeping exhaustive platform suites in their nightly lane.
  Existing signing, artifact digests and release provenance remain required.

## [3.30.0] — 2026-11-04

### Added
- `phm autopilot` drives Phantom's own pull requests toward green: it fixes CI,
  answers review, updates the merge base and stops when the PR is not ours.
  Operator credentials stay out of fixer and verify children.
- Land the reviewed memory foundation behind a benchmark gate, with an optional
  local meaning signal measured on the same benchmark.
- Lessons show what each lesson cites and inject only the lessons about the
  task. A lessons holdout and outcome-ranked scoring gate self-improvement
  promotion on measured evidence, and lessons whose source PRs were reverted
  are withheld.
- Add a `localInference` config block for loopback-only OpenAI-compatible
  providers (Ollama, oMLX, mlx-lm): no placeholder or OAuth keys are sent to
  local URLs, doctor and status probe `GET /models` with a bounded streamed
  body, `phm --ashlr-handshake` reports the handshake, and `OLLAMA_HOST` is
  honored on loopback in the knowledge indexer and model-manager probe.
- Lay the governed-client gateway: the `gateways` config block is validated at
  load, a target validator checks destinations, and governed clients can be
  routed through an opted-in gateway.
- Fleet gains a canary enforce ladder state machine — enforce stays
  unreachable while host cancellation is unproven — plus a read-only Shadow
  Report (`automerge-canary report [--json]`) that reads the spawn custody
  ledger.
- The router spends work across Codex, then Devin, SuperGrok and oMLX, and a
  queue.v1 `fleet_hop` emitter records station exits.
- Ashlr MD becomes the out-of-box Markdown opener and registers its native
  `mdopener-mcp` in `mcp ecosystem`; Gemini CLI joins `wire` as a status-only
  target; lexicon and locus are enrolled as core-fleet repos; the Ashlr.AI
  Plugin can read the project's repo sessions and confined runs.
- First run on any machine gets portable default roots and `--json` on
  `onboard`, `enroll add`, `mcp ecosystem` and `docs`; `phm init` builds the
  repo index; `phm upgrade` runs `phm update`; `wire status` prints a
  read-only report.
- Ecosystem stars and commits are aggregated daily, artifact installs record
  their installation time, `phm status` counts repositories with no commits,
  and cloud sessions claim the companion tools they called.
- The self-improvement gate and PR autopilot become Tier-1 owned paths, and
  the promote gate's metric runs in the verification sandbox under a standing
  grant.
- Fleet job drafts get a stdin-capable draft check with header validation,
  collision output and snapshot-aware prechecks (CLI and MCP), `fleet trim`
  joins the verb registry, and idle lanes report how long they have been idle.

### Removed
- Internal dead code: 143 exported symbols with zero references anywhere in the repo (knip plus whole-repo `rg`), plus imports and private helpers they alone used. Several symbols were already cleaned by intervening PRs (the original sweep targeted 150; 7 were superseded). No CLI command, flag or config key changes.

### Fixed
- The Verse update panel lists the local changes that block self-update and
  holds on a failed update commit, and lane capacity without a meter shows as
  unknown instead of a guessed allowance.
- Resolve MCP gateway TS2300 duplicate-identifier error by deriving the
  JSON-RPC message type from `serializeMessage` rather than importing from
  a conflicting SDK module path.
- Scrub stops flagging prose, code references and public digests as secrets.
- Automations dedupe prunes against the wall clock (master was red), and the
  daily full-run drift — CLI registry, docs links, spawn-gate assertion and
  web typecheck — is cleared.
- The fleet post-merge watch stays open while CI is still running, and
  stale git lock files surface in doctor and at daemon start.
- Recover cleanly from killed or crashed agents: crash-orphaned runs are
  labeled stale in `phm runs`, scratch dirs and apply worktrees are reclaimed,
  sandbox locks are held only for worktree registration, and the fabric run
  cache is bounded with crash-safe rewrites.
- Reap zombie-only process groups and stale keep-alive worker sockets, and
  clear environment-dependent and CI cold-start flakes.
- Close per-agent auto-merge gaps — self-repo detection, exact-diff gate,
  Stop/Pause and merge-prompt injection — and pin the local auto-merge to the
  staged commit while keeping protected paths out of it. The trust-root PR
  opens through the GitHub API instead of a local checkout.
- `--help` never acts, `--json` stays machine-readable on refusals, and
  unknown options are refused before side effects across the CLI and MCP
  gateway (unknown gateway tools answer `-32602`).
- Detect ashlr-plugin installs including Claude Code marketplace layouts and
  detect Claude Code, Codex and Cursor from their CLI on PATH. `devin connect`
  refuses off macOS before asking for the key.
- Drop the desktop updater's zip feature, clearing RUSTSEC-2026-0367,
  RUSTSEC-2026-0368 and RUSTSEC-2026-0369.
- Treat renaming a test out of the suite as deleting it, and refuse cloud
  Land on test tampering rather than only showing the chip.
- The desktop app stops repainting the window per streamed token or waking
  the page for chat pulses; cold load, long chats and first ⌘K are faster,
  derived turns survive switching chats, and typing stays smooth with
  hundreds of chats.

### Performance
- The web console re-renders only the live turn's block of the transcript per
  streamed token.

## [3.29.17] — 2026-11-03

### Fixed
- The pinned `@ashlrai/locus-mcp` companion moves to 0.6.2, because the 0.5.0
  npm shim re-executed itself through `which` and forked without bound.
- The Devin bus adapter runs in read-only auto mode.

Unreleased work that landed alongside this patch release is described under
3.30.0 above.

## [3.29.16] — 2026-11-01

Tagged as `v3.29.16`. This section was written after the tag, so it does not
show that the package is published to npm.

### Added
- Fleet console: keyboard shortcuts in the fleet pane, a runs history view, a
  dispatch dock pane, a per-lane "Next up" queue view and a planner logins panel.
- Shared bus: a durable local inbox, reply and watch commands, work claims so one
  worker takes each job, consumer checkpoints that survive restarts and address
  filters.
- Planner: a brief builder that assembles context for each planner pass, and
  single-flight cycles so two planner ticks never overlap.
- Graph: neighbor and route queries, relation traversal, kind filters, Mermaid
  export, streamed node output and per-node working directories.
- Usage and resources: a resource ledger command with model usage, personal usage
  for Claude weekly-only windows and the Codex weekly API meter, and detection of
  usage resets.
- Memory pressure and recovery: a memory pressure monitor and a recovery watch
  that flags stalled runs, so unattended runs recover from crashes, hangs and
  clock skew.
- Multi-host queue: host queue ingress, a foreground worker per host, local
  leader failover with a proof test, and the mobile fleet view of queue state.
- Run receipts: an opt-in, signed `receipt.v1` record written when a run closes
  (`ASHLR_RUN_RECEIPTS=1`), with CI, merge, survival and revert follow-ups chained to it.
- Custody ledger: every engine spawn leaves a value-free record, and `phm status`
  shows the strict preflight.
- Local inference: a `localInference` config with loopback-only OpenAI-compatible
  endpoints, and doctor and status probes of the models endpoint.
- `phm upgrade` runs `phm update`, and Ashlr MD is the default Markdown opener.

### Changed
- Auto-merge canary: enforce mode stays unavailable while cancelling a merge is
  unproven. A read-only Shadow Report is available.
- The gateways config is validated when it loads, not on first use.
- Docs-only PRs take a shorter CI lane. Mac lanes on master run one push at a
  time and are skipped on draft PRs.
- Dispatch limits understand Claude weekly-only usage windows.
- Doctor shows one MCP warning instead of two on a fresh install, and one
  local-model warning instead of four when no local model is running.
- Product copy calls it Phantom, not Verse.

### Fixed
- `--help` never runs a command's side effects. Unknown options are refused
  before anything acts, across fleet, sandbox, enroll, comms and more.
- `--json` output stays machine-readable when a command refuses.
- Provider error bodies that echo the API key have the key redacted.
- The Pulse token is read from a hidden prompt or stdin, never from a command argument.
- Agents killed mid-run are recovered cleanly, and the sandbox lock is held for less time.
- Automation dedupe pruning no longer depends on the wall clock, which had kept master red.
- Zombie process groups and stale keep-alive worker sockets are cleaned up.
- Run receipts are written for real dispatches.
- Mission console reads retry transient transport failures, within a bound.

## [3.29.15] — Unreleased

### Fixed
- Local inference URLs and local Ollama defaults pin `localhost` to
  `127.0.0.1`, avoiding name resolution. Provider probes and Ollama model
  lookups refuse redirects instead of contacting another endpoint.

### Removed
- Internal dead code: 143 exported symbols with zero references anywhere in the repo (knip plus whole-repo `rg`), plus imports and private helpers they alone used (`WIRE_CONTRACT_KEYS` is kept as a compile-time contract guard). Rebased onto current master the count drops from 150 to 143: `_handlerCounts` is kept (now referenced by `test/m241.event-bus.test.ts`) and six symbols were already removed on master (`AutonomyIcon`, `ApprovalsIcon`, `ThemeIcon`, `TrashIcon`, `hasCommandHandler`, `preloadGuardDialogs`). Includes the internal `GenomeCapture` type in `src/core/types/genome.ts` (deprecated and removed in one step: it was never exported from a published entry point such as `@ashlr/hub`, `@ashlr/hub/types` or `@ashlr/hub/plugin`, so no user import can break; docs/contracts/CONTRACT-M16.md updated). No CLI command, flag or config key changes.

### Added
- Every engine spawn that is not wrapped by `phantom exec` now leaves a
  value-free custody record with a fixed reason code, including when Phantom is
  off (`phantom-disabled`). `phm status` and `status --json` break unwrapped
  spawns down by reason. `.phantom.toml` is still never copied into sandbox
  worktrees (it would select a different, empty vault).
- `phm status` and `status --json` show the strict Phantom preflight
  (`phantomPreflight`) when `ASHLR_PHANTOM_PREFLIGHT=1`: verdict, exit code,
  whether the vault was probed, and whether a fleet spawn here would wrap or
  run unwrapped with its reason. `ASHLR_PHANTOM_PREFLIGHT_VAULT=1` adds
  `--vault` to the spawn and status preflight; the default stays metadata-only.
- Run receipts now record what happened after close: the daemon appends signed
  `later[]` entries when a run's PR checks settle (ci), it merges (merge), the
  post-merge watch reports (survival) and a revert lands (revert). Best effort,
  value-free, deduplicated; runs without a receipt are skipped.
- Run receipts gain signed `later[]` entries for ci, merge, survival and revert
  (receipt.v1 R6). Each entry is signed separately and chained to the receipt
  digest, so the original signed body is never rewritten. `fleet receipt verify`,
  `show` and `timeline` check and list them; tampering fails verification.
- `phm pulse connect --token` with no value now asks for the Pulse PAT at a
  hidden prompt, and `--token-stdin` reads it from a pipe. `--token <pat>` still
  works but warns on stderr that the PAT is visible in the process list and
  shell history. The PAT reaches `phantom add` only on stdin.
- Group resource displays by provider while keeping configured references,
  current readings and verified account coverage separate. Unknown identities,
  balances and capacity stay unknown; grouping does not authorize execution.
- Add local team claims, handoffs and scoped shared context, an evidence-scored
  task context compiler, and public-only self-improvement proposals through
  the normal protected pull-request path. Human team approval, standing
  authority and provider qualification remain separate gates.
- Add bounded steward disk and session-retention planning with the existing
  operator controls; source availability does not establish runtime acceptance.

### Fixed
- Provider error bodies that echo the rejected API key no longer carry it into
  thrown errors. The OpenAI-compatible client, visual grounding and the Devin
  client now redact any run of 8 or more characters of the key they sent, so
  opaque keys with no vendor prefix are covered as well as known key shapes.
- Preserve original quota and credit expiry across resource cards, provider
  groups and capacity views. Connection and admission checks cannot refresh
  or extend retained usage evidence.
- Keep ordinary resource rows and controls available when optional provider
  grouping fails to load or returns invalid data.
- Restrict steward effects to the documented roots and actions, refuse
  symlink paths and observed file replacements, and preserve existing archives
  through exclusive creation and verification before removing an original.
- Reject established agent contexts for human team joining and approval.
  Preserve the first local human's ownership after agent activity and refuse
  agent role promotion, including inconsistent event and member kinds.
- Keep context replacements within the same owner, project and person scope;
  hidden or separately scoped evidence cannot suppress an admitted record.
- Create improvement proposals in unique owned worktrees, withhold private or
  unverified GitHub evidence, and scrub public titles consistently. Proposals
  remain drafts; automatic merging requires the existing protected process.

### Deprecated
- `npm run release:canary` and the signed observation-only release canary are
  retired: `scripts/run-signed-release-canary.mjs` and
  `scripts/verify-signed-release-canary-receipt.mjs` are removed, so the
  `release:canary` manifest alias now fails until owner-lane cleanup removes
  it and the frozen `v3.3.2` release workflows. The
  commissioned `publish-canonical-npm.yml` trusted-publishing workflow is the
  one sanctioned npm release path.
- The manual `npm pack`/`npm publish` release instructions formerly in
  `docs/RELEASING-LOCALLY.md` are retired; publish only through the
  commissioned canonical publisher and reconcile uncertain registry state by
  reads, never replayed writes. The legacy `verify:local-production` gate
  remains in-tree as evidence only and admits no canonical package.

## [3.29.14] — Unreleased

### Added
- Add an optional desktop-only Devin dashboard observation. In a separate
  account window, a user-present sign-in can read the displayed Max weekly
  percentage, on-demand balance, auto-reload state, and plan price. Each
  short-lived reading brackets Usage with matching organization IDs from
  General before and after. It is display-only and does not change launch
  admission, budgets, or the ACU ledger. Embedded sign-in and real account
  extraction still require user-present validation.
- Add an opt-in resident Mac awake preference with status and controls in
  Settings. Its installed service requests idle sleep prevention while running,
  plus system sleep prevention on AC power; a stopped service holds no assertion.
  The setting does not override lid closure or the signed authority policy. The
  resident panel includes a finite, reduced-motion-aware coffee scene with Ash.
- Add local companion task records, explicitly scoped handoff packets, manual
  reports and independent operator review in the existing proactive workbench.
  Resource evidence, offline routing comparisons and release-readiness views
  distinguish declarations from verified evidence. External companion transports
  remain unqualified; these records do not authorize provider dispatch.
- Make older completed and archived agents discoverable through Done history,
  and guide onboarding toward one bounded change with an inspected diff and
  actual repository test output.
- Add explicit native pool re-enrollment with a reviewed plan digest, atomic
  staged custody, interrupted-publication recovery and exact completed replay.
  Preserve policy, receipts, aliases and operator holds; keep retained old
  context behind its original account boundary. Runtime admission requires
  intact transition custody and fresh target collector/profile evidence, with
  subscription-only billing qualification separate from locator migration.

### Fixed
- Skip unmatched path characters in the composer's file finder without changing
  scores, ordering or result limits. Preserve the existing handler CPU budget.
- Keep a resource supervisor available when another enrolled owner atomically
  commits a valid pool ledger during its custody read. Retry only the observed
  file replacement with bounded fresh reads; unsafe data, invalid controls and
  incomplete commissioning still hold execution.
- Honor the provider's original native quota expiry across resource cards,
  account details, composer seats and mobile views. Cached readings remain
  dated history after failed refreshes; exact expiry and focus resumption clear
  current claims without renewing evidence or coupling independent credits.
- Read the installed resident service definition without following a swapped
  symlink, and report service transition states without claiming an awake
  assertion before the resident confirms it.
- Read the current Devin dashboard's bounded plan-card price and renewal fields
  when the provider renders them as leaf divs, while rejecting ambiguous cards.
- Require every task to complete before a run reports `done`; retain partial
  results and explain failed or blocked descendants.
- Finalize durable output before publishing terminal run state. Drain large SSE
  replays with backpressure, independently resume task/step/output events, and
  keep browser replay open through its terminal frame. SSE IDs are opaque
  versioned cursors; legacy numeric cursors remain accepted. Capture gaps and
  interrupted reconnects are visible separately from the run outcome.
- Reject ambiguous MCP routes and collect bounded paginated inventories before
  replacing them. Failed discovery revokes invocation routes and exposes stale
  inventory diagnostics.
- Mark cached agent boards stale after refresh failure. Preserve per-seat launch
  results and retry only confirmed unstarted attempts; disclose held first
  prompts. Clear dismissed MCP drafts and reject late parked actions without
  implying cancellation of a write already issued.
- Detect lost local coordination records with separate replay watermarks,
  replay committed acknowledgments before fresh host observations, and allow
  cancellation of an assignment that has never been handed off.
- Describe available Codex credits separately from spending authorization;
  an unreached provider spending control does not mean credit spending is off.
- Hold Devin fleet API launches under a zero or unavailable standing metered
  allowance before credentials, queue publication and every create attempt.
  Recheck tightened allowances after preparation and retry backoff. Human
  attribution and subscription labels do not establish included API billing;
  native CLI, manual launches and usage metadata keep their existing paths.
- Reject quota-proof metadata failures before native contact or after known
  settlement without falsely reporting uncertain native termination. Actual
  unknown or uncertain launches retain their durable recovery fence.

## [3.29.13] — 2026-10-12

### Added
- Allow an explicitly selected loopback llama-server to serve Fleet alongside
  subscription seats, using current slot activity and per-slot context readings.
- Select a verified organization member for Devin service-user session
  attribution and verify that attribution after creation. Attribution does not
  establish a subscription allowance, credit balance or cash billing boundary.
- Give Leader tasks an explicit goal milestone identity so rewording the same
  milestone does not queue duplicate work; distinct milestones remain separate.

### Fixed
- Hold autonomous native Codex producer calls without fresh, exact-account
  subscription-only billing-control proof, including retries. The current
  Codex quota feed does not supply that proof, so those autonomous calls remain
  held pending a genuine provider control source; manual Verse Codex chats use
  a separate turn path and are unchanged.
- Keep the served Qwen3.8 Leader's output budget for its structured memo and
  bound the streaming transport separately from the model's token allowance.
- Accept qualified local and mid-tier outcome-manager records in the workbench.
- Show stale lane capacity as unobserved and label historical remaining allowance.
- Publish exact native metadata child identity before fallible launch checks,
  preserving full signed-image verification before execution and recovery.
  Failures before durable identity publication remain held for recovery.
- Refuse local app installation while quota collection or ownership is unresolved.
- Report native launch failure stages without provider, account or command data.
- Identify whether Claude quota collection timed out during sign-in, version,
  usage or final sign-in verification while retaining the bounded probe budget.

## [3.29.12] — 2026-10-12

### Changed
- Clarify that the resident USD ceiling is secondary to signed metered authority:
  subscription and local work may continue after a positive ceiling is reached,
  while setting the ceiling to zero stops all resident work.

### Fixed
- Explain a missing Claude quota reading in Apps & Accounts and Resources using
  an allowlisted diagnostic reason. An unavailable reading remains unavailable;
  no provider output or account identifier is exposed.

## [3.29.11] — 2026-10-11

### Added
- Bind new macOS native profiles to their APFS volume UUID, directory inode and
  creation time so a device-number change after reboot can be verified without
  accepting a replaced directory. An explicit `upgrade-identity` command adds
  the witness to an unchanged older profile before its device number changes.

### Fixed
- Require a stable, source-bound merge gate for protected PRs while retaining
  the full platform matrix for non-site changes.
- Parse GitHub's optional unattributed-change approval flag and requester-specific
  ruleset bypass display when inspecting branch protection. The latter is not
  treated as policy; unknown fields and invalid values still fail.
- Permit the fixed macOS identity probes inside Claude's outer native jail so
  witnessed profiles can verify their boot and APFS volume before launch.

## [3.29.10] — 2026-10-10

### Changed
- Remove fixed 3.26 labels from the landing-page story and footer so those
  decorative elements do not imply a stale installed or published version.

### Fixed
- Restore fresh public release facts after the site-only CI lane added two
  ancillary jobs. The reader binds their names and results to the exact
  candidate workflow while retaining all 15 required release gates.
- Check the configured model through a bounded loopback `/models` probe before
  marking a keyless Ollama or llama-server fleet engine ready. Missing models and
  probe errors remain unavailable; a model listing does not claim completion.
- Keep a standing Codex judge off an unpinned native seat, allow another admitted
  independent judge family when available, and record a CLI launch refusal as
  unavailable instead of a malformed verdict. Genuine malformed replies still
  receive the strict retry.

## [3.29.9] — 2026-10-10

### Changed
- Load doctor, init and setup only for their selected CLI commands. Local
  fresh-process measurements reduced compiled Node help, version and resource-help
  startup from about 120 ms to 32–33 ms; installed native and full CI gains remain
  unmeasured.
- Keep worker mock compatibility in a lightweight setup module instead of loading
  test tooling for each worker, preserving mock behavior and complete coverage.
- Load only the selected command in package smoke fixtures. One complete local
  38-case comparison ran about 6% faster; hosted gains remain unmeasured.
- Let short Mac checks overlap unfinished general test lanes after the isolated
  lane settles. All 15 release gates remain required; hosted gains are unmeasured.
- Remove one duplicate walk over the same captured release archive per fresh
  verification, preserving complete validation and fresh source, byte and
  signature checks. Wall-time savings remain unmeasured.
- Add `check:release:fast` to run the existing workflow and packaging contracts
  with local release checks before pushing a built candidate. Hosted CI runs
  the packaging contracts once, with all 15 release gates still required.
- Explain dependency audit coverage, including the Universe example graph gap.

### Fixed
- Refresh displayed local-model speed after a successful completed local turn,
  including when an older context read is still pending. Streaming chunks and
  duplicate events do not trigger additional reads; token evidence stays server-owned.
- Describe a passed recorded access expiry without claiming the native CLI has
  signed out. Cached warnings remain non-blocking and suggest checking sign-in.

## [3.29.8] — 2026-10-10

### Added
- Install the signed Apple silicon desktop app with `phm desktop install`, using
  the matching public app and CLI artifacts without a compiler or publisher key.
  Preview the installation first; `--apply` installs into an absent app location.

### Fixed
- Wait for the original process preflight deadline when a timer wakes early, so
  a hung proof is reported as a timeout without starting the process.
- Keep newer observed chat activity when an older session snapshot arrives, and
  settle sidebar activity only from a matching completed or cancelled turn.
- Preserve unknown resource usage instead of inventing provider limits, check
  credential prerequisites before cached readiness, and distinguish budget
  headroom from provider quota.
- Preserve queued work after an uncertain persistence result so release articles
  and website metadata cannot be submitted twice by a retry.
- Update Leader documentation, installation links and candidate version metadata.

### Changed
- Load chat resize interactions separately while retaining saved panel widths and
  usable chat columns when the optional control is delayed or unavailable.
- Display resource pulse metrics to two significant figures while retaining
  exact accounting and reported, estimated or reserved provenance.

## [3.29.7] — 2026-10-10

### Added
- Optional repository-specific protected PR handoff qualification binds the repository, default branch, check identities and observed policy. Its signed operation permits PR opening; direct merge and bypass authority remain separate.
- Record unbound Claude promotional-credit history with the existing resource CLI. Date-only observations remain historical and Held; they do not authorize API spending.
- Default-off duration-weighted test sequencing and an offline original-report converter retain exact source, inventory and environment provenance. Timing hints do not reuse test results or qualify release evidence.

### Fixed
- Recover coherent signed historical tier/verification remote handoffs when their optional protection gate is absent. Malformed gates and PR-only operations do not gain direct-merge authority.
- Preserve strict historical Universe resource-task origins without turning history into dispatch authority.
- Clarify local-server connection privacy, model-catalog labels and canonical `phm` recovery examples.
- Public release metadata links the versioned Apple silicon app archive when no valid historical DMG is present. A metadata link does not qualify downloaded bytes or install the app.

### Changed
- Experiment with deferring short macOS CI jobs until the exhaustive macOS lanes settle. All 15 required jobs and original coverage remain; hosted queue order and any speed improvement are unverified.

## [3.29.6] — 2026-10-09

### Added

- Save a compact resource sidebar with one-line account readings. Hover or
  keyboard focus retains credit balances, resets and connection details;
  subscription allowances and API credits remain separate.
- Distinguish reported, estimated, reserved and unknown token totals across run
  details, usage charts and traces. Keep exact accounting and round display
  values to two significant figures; routing learns token throughput only from
  complete reported generation.
- Launch desktop metadata collectors through the signed native host, and add a
  credential-free check of the installed app and its paired CLI.

### Fixed

- Join overlapping Fleet refresh requests instead of superseding an unfinished
  read on each polling interval.
- Publish Node metadata-child process identity before execution so an interrupted
  collector can recover without guessing whether unregistered work stopped.
- Dispatch outcome Managers into their admitted workspaces while preserving
  saved project targets. Resolve the same mapping for existing interactive chats.
- Permit executable temporary build files in the isolated website builder and
  materialize validated internal Vercel output aliases before publication.
- Bind website runtime metadata to the qualified source revision and read the
  CLI's deployment response as JSON, verifying the staged deployment before promotion.
- Use current provider-neutral CLI help and explicit local model tags instead of
  a stale example model recommendation.
- Describe notification delivery from the actual delivery method rather than
  inferring whether the app is unsigned.
- Record the verified Phantom homepage and separate Secrets route. Website
  deployment, hosted services and autonomous publisher commissioning remain
  distinct.

### Changed

- Consolidate current release instructions and retain earlier procedures in a
  historical archive. Capture buffered CI phase timings after fixture cleanup;
  all release checks and original test deadlines remain intact.

## [3.29.5] — 2026-10-09

### Added

- Preview affected test modules from immutable Git inputs with an offline,
  advisory command. The preview does not execute tests or replace release checks.

### Fixed

- Keep Fleet background-refresh indicators in a fixed header position so routine
  polling does not insert a row and move the page.
- Show signing progress and errors inside the grant dialog. Distinguish previews
  from Mac authentication and explain that closing does not cancel approval.
- Preserve unrelated MCP settings, refuse malformed configuration before writing,
  and pin discovered companion commands to their physical executable paths.
- Distinguish installed model context from the runtime serving a task, and explain
  usage-collection holds without exposing internal identifiers.
- Clarify that Grok Bot account, allowance and reset evidence is independent of
  Grok Build. Configuration alone does not prove a supported invocation or balance.
- Keep version documentation accurate after publication and synchronize source
  identity across the CLI, desktop app and installation documentation.

## [3.29.4] — 2026-10-09

### Changed

- Rank eligible shared resources by current headroom and independent funding,
  without inferred provider or model-family quality tiers. Explicit selections,
  account authority and spending rules still apply.
- Resolve worker models for the selected backend. Preserve configured pins and
  authenticated learned choices without rerouting a task to another provider.
- Add opt-in acceptance phase timings after test cleanup to diagnose preparation,
  proof, delivery and request costs without changing test deadlines or outcomes.
- Hash evaluator executables with fresh, bounded streaming reads instead of a
  whole-file buffer, preserving complete-byte and file-identity verification.

### Fixed

- Bind local coding capacity to a tool-capable runtime instead of the planning-only
  builtin loop. Use another eligible resource when local execution is unavailable.
- Synchronize routing explanations with provider-neutral selection.
- Label resource summaries as current or unconfirmed usage, separately from
  connection, Chat/Fleet readiness and available allowance.
- Round credit hover text with the existing two-significant-figure formatter,
  preserving exact stored balances for accounting and admission.

## [3.29.3] — 2026-10-09

### Added

- Saved Grok Bot profiles appear separately in the reorderable resource sidebar.
  Declared account and agent identities remain unverified; Bot allowance and reset
  stay unknown rather than borrowing Build or API usage.
- Explain account-usage collection holds separately from sign-in readiness,
  preserving existing readings and provider-specific diagnostics.
- Record local Leader completion tokens, duration and immutable model/runtime
  bindings when actually reported; distinguish missing counters from zero usage.

### Changed

- Use fresh, complete llama runtime slot observations to schedule available local
  capacity. Count experiment reservations once; retain configured behavior when
  physical occupancy is unknown. CPU and RAM remain descriptive host metrics.
- Remove the hidden daily Leader conversation cap and propagate cancellation to
  native replies. Existing funding rules and explicit stop controls remain.
- Clarify that project inventory estimates differ from the context a particular
  task needs; a large repository need not prevent a narrow local-model task.
- Explain resource evidence and configured routing priors without presenting
  estimated context, hardware readings or configured tiers as measured capability.
- Update release guidance for the commissioned original-artifact trusted publisher.
- Increase the desktop first-paint baseline from 353 to 354 KiB for 43 additional
  bytes of lazy preload metadata; phone size and its 250 KiB limit are unchanged.
  This is a documented size allowance, not a measured speed improvement.

### Fixed

- Forecast Manager context from the prepared prompt and harness instead of a
  generic token estimate, then revalidate the actual dispatch before invocation.
- Pin selected Codex launches to the chosen account, executable and profile across
  Manager, worker and repair paths; preserve reported token provenance.
- Clarify native Grok transport, standalone historical resource pools, independent
  Bot funding, local measurement scope and subscription evidence in documentation.
- Show the original age of retained local runtime and readiness observations;
  keep refresh failures visible during retries until a real successful read.
- Bind local context availability to validated runtime metadata instead of the
  requested configuration; forward caller cancellation through local Leader reads.
- Keep unchanged authority-alert arrival times stable across fresh status checks,
  allowing Jev's existing advisory cache to reuse unchanged inputs. Substantive
  changes, recovery and recurrence still invalidate the observation.
- Classify the durable OutcomeStore tests in the existing real-I/O lane, retaining
  every case and complete platform coverage without changing production deadlines.
- Synchronize explicit candidate lines in the README, quickstart and desktop
  guide with package/native metadata. Preserve verified publication records and
  reject missing or duplicate markers before writing any file.

This entry describes the qualified source changes for that release; provider
activation and resident work require their own current evidence.

## [3.29.2] — 2026-10-09

### Added

- Opt-in artifact installer timing diagnostics with fixed phase names and
  durations. Default installation, signature checks and rollback stay unchanged;
  diagnostics contain no credentials, arguments or private paths.

### Fixed

- Bind local Leader text requests to the selected llama-server model, context
  and runtime identity; handle streamed output, cancellation and completion.
- Age local resource readings against the current display clock when an
  asynchronous reading arrives.
- Show Grok Build's available adapter separately from account readiness.
- Identify llama warm measurements as warm while retaining their end-to-end scope.
- Remove deliberate retry pacing from two blocked-lock test fixtures, retaining
  real lock refusal and unchanged production behavior.
- Explain independent Bot/Build/API funding, descriptive host metrics and the
  missing live execution evidence that currently holds reserve shrinking.
- Label native Grok allowance windows without treating shared consumer usage as
  a separate Build quota; preserve provider labels and independent Bot/API pools.
- Render one completed local answer when inline reasoning follows streamed text,
  preserving distinct tool calls, turns and historical messages.
- Distinguish explicitly reported token counters from missing provider details.
  Preserve numeric totals; show unknown historical details rather than measured
  zero or an unsupported exact throughput rate.

Published `@ashlr/phantom@3.29.2` through the commissioned trusted publisher in
[run 37944263148, attempt 1](https://github.com/ashlrai/phantom/actions/runs/37944263148/attempts/1).
Signed GitHub desktop assets and local installation were verified separately.
Website commissioning and resident provider activation remain incomplete.

## [3.29.0] — 2026-10-09

### Added

- Editable proactive-agent profiles with provider/account identity, setup links
  and explicit readiness. These are saved preferences; external dispatch and
  planner use are not implemented.
- On-demand task context with local evidence, history and source coverage;
  distinguish current metadata from incomplete historical observations.
- Local host RAM and interval CPU readings, runtime residency and scoped model
  speed evidence with its measurement type, context and age.

### Changed

- Show Phantom in saved work summaries and future snapshot labels while
  preserving raw goals, editors, model inputs and technical identities.
- Align Leader guidance with eligible provider-neutral routing; skip a redundant
  backlog scan after empty invention and record actual stage timings.
- Share small presentation helpers in a deferred chunk. Rank observed test spans
  in advisory CI reports; every required suite still runs with fresh evidence.
- Reconcile delayed npm `latest` visibility through bounded reads after the
  existing single tag update, without replaying publication or downgrading.

### Fixed

- Remove unsupported Phantom Secrets extraction commands; retain existing valid
  environment, private-file and native routes with accurate diagnostics. A
  value-blind vault-backed provider transport remains a separate proposal.
- Discover the prepared local Claude harness from the native launch environment
  without relying on a login shell.

Published `@ashlr/phantom@3.29.0` through the commissioned trusted publisher in
[run 37925115978, attempt 1](https://github.com/ashlrai/phantom/actions/runs/37925115978/attempts/1).
Signed GitHub desktop assets and local installation were verified separately.
Website commissioning and resident provider activation remain incomplete.

## [3.28.0] — 2026-10-09

### Added

- Explicit inventory of separately installed Phantom Secrets, Locus and Lexicon,
  with inherited Locus identity checks and MCP discovery recovery.
- Shared account-bound Leader, Manager and worker invocation for prepared
  Claude Code, Codex, Grok, included native Devin and local resources.
- Qualified original-artifact npm trusted publishing, separate consumer checks
  and public reconciliation before stable promotion.
- Optional host-owned website publication with durable Auto/Pause controls,
  exact staged-deployment reconciliation and preserved public configuration.
- One candidate-version synchronization command and clear installed-desktop
  versus interface-build versions in Settings and About.
- Shared website and article metadata generated from the freshly verified
  public release, separately from the local candidate version.

### Changed

- Reduce excess sidebar padding and enlarge the Phantom ghost, with a preview
  of the saved accent and accessible keyboard color controls.
- Reject inconsistent candidate metadata before a build; keep historical and
  dependency versions unchanged.
- Admit useful documentation, CI, dependency and maintenance improvements;
  size ordered goal plans to the work rather than padding or truncating them.
- Include eligible Codex resources in balanced routing; preserve manual choices
  and explicit account permissions. Optional Leader run limits remain explicit.
- Size native fleet lanes from account eligibility instead of a default Codex
  lock or a blanket Claude presence lock; retain allowance and funding checks.
- Check captured Locus authority before host-native account metadata access;
  unsupported sealed-job identity bridges stay separate from host invocations.
- Format Telegram dates in the operator's timezone and use concise Phantom
  wording for generated briefs while preserving user text and technical records.
- Use writable isolated Cargo runtime state and reuse unchanged source hashes
  during maintainer verification without repeating locked dependency preparation.

Published `@ashlr/phantom@3.28.0` through the commissioned trusted publisher in
[run 37910835113, attempt 2](https://github.com/ashlrai/phantom/actions/runs/37910835113/attempts/2).
Signed GitHub desktop assets and local installation were verified separately.
Website commissioning and connected-provider activation remain incomplete.

## [3.27.0] — 2026-10-09

### Added

- Separate recorded Claude API promotions from subscriptions, cloud gifts and
  purchased credits. Show exact-money tooltips, rounded dollar balances,
  verified expiry dates and explicit automatic-use holds in the resource bar
  and expandable Resources details.
- Add an internal first-party Messages adapter with durable organization-wide
  reservations, verified request pricing and retained unknown-charge exposure.
  The new API lane stays off until fresh billing, credential binding and
  explicit signed API authority are commissioned; existing grants stay closed.
- Keep verified but unbound grant history readable without manufacturing a
  credential, provider cycle or spending capability.

Publication, installation and provider activation remain separate checks.

## [3.26.1] — 2026-10-08

### Changed

- Keep mission supervision fresh after successor work settles so a waiting
  admitted successor is not closed using an earlier empty queue reading.
- Clarify Phantom and `phm` guidance in Leader help and Telegram replies while
  preserving the `ashlr` alias, saved accounts and operational identities.
- Update the Dots and Grok Bot companion guides to the Phantom name and
  canonical repository links, preserving their connection and usage limits.
- Report bounded enrollment timings in CI to distinguish filesystem sync and
  ownership-check costs without changing the existing latency requirements.
- Reject incomplete local Leader response streams rather than accepting an
  unfinished answer. Retain the normal bounded retry and failure behavior.
- Add the guarded manual installation path for an original signed published
  release after protected master advances, with fresh release evidence and
  the existing Stop, drain, rollback and separate authority requirements.

## [3.26.0] — 2026-10-08

### Changed

- Adopt `ashlrai/phantom` and `@ashlr/phantom` as the canonical workbench
  identities, with `phm.dev` as the product website. Retain the `phm` and
  `ashlr` launchers, existing accounts and saved data.
- Bind package installation, release articles and SDK smoke checks to the
  actual closed release profile, preserving original legacy receipts and
  rejecting mixed package identities.
- Direct new Leader, Telegram and cloud self-improvement tasks and adoption
  metrics to the canonical repository and package. Explicit saved targets and
  historical tasks keep their existing identity and authority.
- Default new release-article configurations to the canonical repository while
  preserving saved configurations and historical publication records.
- Finish Phantom labels in agent setup, Fleet and Telegram replies; correct the
  native CLI recovery command and current installation guides.

## [3.25.3] — 2026-10-08

### Fixed

- Configure the native updater's TLS provider before constructing its HTTPS
  client, preventing the reproduced startup abort.
- Make authority help observational and show the exact safe installer failure
  phase. Retry retained original CLI bytes through fresh verification without
  overwriting prior transactions or rollback evidence.
- Unify current UI, CLI, cloud and Devin messages and guides under Phantom.
  Preserve historical records and recognize both old and new closure markers.
- Consolidate chat evidence into an expandable footer and clarify resource
  readiness while keeping account usage and credits separate.

### Added

- A compatibility bridge for signed legacy and canonical Phantom identities.
  Existing repository/package names stay in place for this release; the closed
  canonical profile enables the subsequent migration without mixed identities.
- Advisory incremental CI observations alongside the required full checks.
  No cached result substitutes for release qualification.

## [3.25.2] — 2026-10-08

### Added

- Publisher-signed paired app/CLI updates with a fixed public trust anchor,
  qualified release preparation and bounded private downloads.
- A desktop update status panel with actual progress, clear holds and a
  persistent automatic-updates preference.
- Idle installation after prior Stop/drain and normal Quit, preserving settings
  and accounts. Equal-surface active grants stay valid; changed authority holds
  automatic installation. Installation does not restart the resident fleet.

### Hardened

- Reject mixed bytes, downgraded versions, unknown work, changed native parents
  and replayed installation attempts. Recheck candidate bytes before switching
  the app and CLI; independently verify installed bytes on the next launch.
- Bind the updater and packaged installation helper to the authority surface.
  Keep release-signing keys outside the repository and compiler environment.

### Fixed

- Make Leader and Telegram updates concise and action-oriented. Use readable
  quantities and task names while preserving exact answers, links and callbacks.
- Resolve Fleet runs from explicit terminal relationships, retaining unknown
  state when the relationship is absent or ambiguous.
- Accept runtime archives with up to 20,000 regular files. Preserve compressed,
  expanded and per-file byte limits, canonical paths and exact package identity.
- Validate the original npm archive immediately after the CI build, before long
  test suites, then reuse those exact bytes for the late consumer smoke check.
- Reuse a verified delivery report within a completed campaign observation,
  retaining independent freshness samples and existing refusal behavior.
- Clarify chat routing with Manual, Automatic, Local first and Delegate,
  accessible descriptions and unchanged saved routing preferences. Remove
  duplicated wording from resource freshness tooltips.
- Run publication preflight once before the producer build and avoid a repeated
  core typecheck. Retain web typechecking and all platform builds and tests.

## [3.25.1] — 2026-10-07

### Fixed

- Use Phantom in new Telegram messages, Leader prompts, desktop guidance and
  phone passkey display names. Preserve saved conversations, provider names,
  repository identifiers and compatible CLI, route and data identities.
- Add an explicit Telegram profile preview and update command. Apply requires
  the previewed bot ID, changes only differing default-locale display fields,
  and verifies fresh readback without sending messages or changing credentials.
- Give authenticated metadata reads a finite lifetime, including their JSON
  response bodies. Preserve cached data, caller cancellation and mutation
  behavior while reporting stalled reads as retryable failures.
- Share the phone client import and local mutation refusal handling, preserving
  method, body and response contracts. Desktop and phone startup bundles stay
  within their existing size budgets.
- Refuse new Devin session creation when local task accounting is incomplete.
  Show unknown accounting and explain unconfirmed legacy exposure instead of
  treating unreadable records as zero. Separate the local budget, reported use
  and held exposure; these readings are not the provider's subscription balance.
- Reuse one coherent campaign projection within commissioning and enrollment
  checks, refusing missing or degraded evidence. Reuse the integration ledger
  snapshot within each preflight. Fresh later checks still validate current
  evidence; these changes do not claim a whole-workflow speed improvement.
- Patch the example site's Sharp override and shadcn-scoped MCP SDK dependency,
  preserving optional platform packages. The separate braces advisory remains
  unresolved.
- Add an explicit upgrade command for recognized older Claude profile launchers,
  preserving the native sign-in, account identity and existing profile contents.
  The upgrade supports a dry run and does not automatically change live profiles.
- Retain bounded Grok run diagnostics and classify a final failed local
  verification without a saved proposal as a verification failure.
- Reuse the validated campaign event fold within one observation while retaining
  fresh ledger reads, owner checks and independent accounting samples.
- Cache native broker compilation with pinned restore/save actions and keys
  bound to compiler, SDK and source inputs. Only successful master pushes save
  entries; every original Cargo check and test still runs. Hosted cold/warm
  timing remains to be measured.

## [3.25.0] — 2026-10-07

### Added

- Add an explicit Manager mode to interactive chats and a shared resident
  manager for autonomous outcomes. One native frontier agent plans and reviews;
  independent work runs through the existing fleet queue and selected accounts.
- Save manager messages, plans and actual run results with restart and archive
  recovery. Pause/resume controls and retries preserve uncertain messages and
  drafts. A plan remains separate from verified implementation and merge.
- Default newly launched supported sessions to the confirmed full-access
  preference. Existing sessions, Plan mode and host execution boundaries retain
  their existing behavior.
- Maintain release-backed article tasks from verified public release facts.
  Publication requires the target repository's current enrollment and signed
  authority; an attempted task does not count as a published article.

### Fixed

- Resolve the manager's exact default model before route admission and check
  current native account profiles when recovering saved results. Exhausted
  allowance blocks new contacts without discarding valid terminal evidence.
- Round native credit-balance tooltips while retaining exact accounting readings,
  and describe uncapped fleet volume settings without large sentinel numbers.
- Refresh pending Devin consumption from the server cache every five seconds
  during the sidebar's first minute, then return to its normal cadence. Hidden
  windows stop polling, and an open Resources drawer owns the refresh instead.
- Keep local speed readings tied to their saved model, endpoint and context,
  preserve measurement age, and distinguish decode from end-to-end timing.
  Sum actual per-call output tokens across a completed turn and round only the
  display. Avoid redundant composer updates when routing mode stays unchanged.
- Honor account-level budget-read opt-outs. Prune deleted knowledge chunks only
  after complete scans; partial or failed listings preserve the existing index.
- Bound native fleet startup output capture and clear the busy state if worker
  creation fails. Bind custody credential reads to one unique existing item and
  preserve precise macOS failure diagnostics without exposing credentials.
- Validate release-article storage owners, modes and path identities on Linux
  as well as platform ACLs. Refuse replaced manifests and changed ancestors
  without treating a disrupted read as healthy missing configuration.
- Reuse incoming chat event validation to reduce startup code. Run independent
  native broker CI checks alongside Mac suites, retaining all required jobs and
  complete qualification before artifact admission.
- Use tiny evaluator files in inspection-only POSIX test fixtures, preserving
  real Node execution tests, fresh evidence checks and Windows behavior.
- Expose release-article commands in help and shell completions. Check existing
  CLI discovery and release metadata contracts in the fast release preflight.

## [3.24.4] — 2026-10-07

### Added

- Prepare checksum-verified, locked Cargo dependencies for host-owned maintainer
  verification. Candidate commands run offline with read-only dependencies and
  configuration; receipts record provenance, unchanged inputs and cleanup.
- Bind Phantom repository effects to fresh numeric repository identity and the
  exact current namespace. Recheck Stop and authority after metadata reads;
  redirects and replacement repositories cannot authorize writes.
- Carry numeric repository identity in paired hosted artifact schemas, retain
  historical signer namespaces, and recheck signed subject bytes after final
  repository observation before admitting a build.
- Add a source-only release preflight so publication and documentation mismatches
  surface before expensive builds and hosted qualification.
- Graph recorded Jev decision response time by kind, with call counts and an
  accessible table. Keep unknown timing distinct from zero and exclude cached
  decisions from call measurements.

### Fixed

- Distinguish preparing work from agents actually working, keep failed status
  readings visibly uncertain until a successful refresh, and collapse healthy
  helper settings while opening them when attention is needed.
- Include every runtime dependency in both npm bundle aliases and verify
  offline installation with an exclusive empty cache and empty npm configs.
- Keep chat settings loading, failure and retry feedback visible without losing
  drafts or handoff notes. Preserve warm controls during refresh, ignore stale
  acknowledgements, and name deferred settings actions while they load.
- Discover independent MCP tool lists concurrently while preserving configured
  merge order, existing routes and per-server failure isolation.
- Reuse a freshly verified campaign projection within a delivered-source read;
  later requests still revalidate registration, recovery and artifact bytes.
- Include existing stylesheet-reading design contracts in the fast development
  smoke set, and wait for initial review selection before testing keyboard
  navigation. Preserve navigation, caching and full release coverage.

## [3.24.3] — 2026-10-06

### Added

- Present the engineering workbench as Phantom by AshlrAI, using the existing
  blue ghost across desktop, phone and public pages while preserving package,
  CLI, saved-data and signed-authority identities.
- Explore real recorded Fleet runs in an optional ghost world with repository
  grouping, task inspection and links to existing run controls.
- Drag resource rows into a saved order or move them with keyboard controls;
  multiple accounts and Devin cloud, CLI and budget remain distinct.
- Explore an explicitly illustrated workflow on the landing page, with manual
  playback, selectable roles and responsive layouts.

- Qualify the complete Mac backend in four independent hosted partitions and
  one serial isolated lane, retaining case deadlines and recording actual
  passed, skipped and todo results. Candidate checkouts must match GitHub's
  original event tree before any checks run.
- Capture the tested build and exact same-job npm archive for optional local
  reuse. A separate default-branch workflow verifies full CI coverage and signs
  the original bytes; the local consumer checks fresh CI results and signatures
  before adopting into an absent build directory. Native and live gates remain
  separate; mismatches refuse reuse. End-to-end savings are not yet measured.
- Answer structured Leader questions with single choice, multiple choice,
  Select all/Clear, or short text across desktop, phone and Telegram, while
  keeping the conversation composer available for interjections.
- Record structured answers once and reconcile uncertain submissions against
  the saved question; stale controls and another device's answer cannot
  silently overwrite it.
- Show native Devin chat context readings when the official CLI reports them,
  while retaining unknown values when no reading is available.
- Add opt-in local request size and context-structure diagnostics without
  recording prompt contents or changing provider token reporting.

### Fixed

- Show resource balances, costs, tokens and performance metrics with two
  significant figures while retaining exact source readings for inspection.
- Isolate composer read caches between fake servers and freeze the fleet routing
  fixture clock so crossing UTC midnight cannot change its quota scenario.
- Fail local gates on every actual failure, including formerly known failing
  files, and remove obsolete prose assertions while retaining current contracts.

- Keep default fleet status scoped to builtin resources instead of probing
  unconfigured providers and local runtimes.
- Split local exhaustive qualification into four smaller partitions with the
  same two active workers and all isolated suites. This aims to reduce the
  last-wave tail; full-run savings are not yet measured.
- Measure release first-paint budgets from the normal build's emitted Vite
  manifest instead of rebuilding the UI. Keep standalone budget checks and
  the existing desktop/phone limits.
- Run the complete UI suite before the long backend partitions locally and in
  its existing Ubuntu CI job, retaining every suite and deadline. This improves
  failure visibility; end-to-end time savings have not yet been measured.
- Upgrade the bundled MCP SDK to 1.31.0, addressing GHSA-6qxp-vccf-f47h.
- Keep Codex subscription allowance, credit balances and provider spending holds
  distinct; unconfirmed credit access remains explicit, and Auto describes its
  subscription-only selection without authorizing credit-funded turns.
- Reuse one coherent predecessor campaign and Universe observation per sample,
  preserving fresh second-sample custody, attribution and drift checks.
- Run every foreground supervision integration case in the serial local phase
  and retain bounded trial details on failure without changing its deadlines.
- Avoid redundant private-directory permission writes and repeated dispatch
  readiness reads while preserving fresh checks immediately before launch.
- Preserve cached macOS journal permission checks when the directory is
  already private; changed permissions and special mode bits still require repair.
- Release the journal lock before waiting for parent authority to settle,
  then revalidate current journals and admission without duplicating durable rows.
- Describe the local coding agent's actual executable tools and distinguish
  file readback from required host checks that have not yet run.
- Reuse a coherent campaign observation within each read and foreground iteration,
  rechecking source bytes on subsequent observations and before execution.
- Isolate complete admission scenarios from competing local test shards and
  report actual completed cases during long suites without extending deadlines.
- Give Telegram Leader summaries readable labels and local dates while
  preserving exact action controls, literal user text and useful quantities.
- Make generated Leader notes and action outcomes readable in desktop,
  Command previews and phone views without rewriting saved conversation text.
- Name the Leader's selected account from cached labels and keep missing
  labels explicit instead of displaying machine keys.
- Retain clipped replies in full and send the saved answer on request with
  `more`, including long lines and replies longer than the phone summary.
- Group Telegram help and clarify that pause/resume controls fleet messages.
- Pace actual Telegram message chunks per bot and chat, honor reported
  rate-limit waits, and retry a confirmed short rate limit once without
  replaying a chunk after an ambiguous network response.
- Retain unresolved Devin session exposure across retries and reconcile reported
  organization consumption independently of remaining plan quota.
- Account for native Devin provider contacts across retry attempts rather than
  treating a retried turn as a single contact.
- Show installed Devin Fleet readiness using the resident authority observation,
  preserving precise paused and expired reasons. Session launch and message
  authority checks remain separate from this read-only display.
- Let pending Fleet status requests finish before the next automatic poll,
  so slow responses can update the desktop instead of being superseded forever.
- Check the selected Claude account throughout autonomous native dispatch,
  retaining fresh account, grant, role and window checks without allowing an
  unrelated held account to block it.
- Keep separately dated Codex credit history in the resource sidebar when a
  fresh balance is not reported. Current subscription usage remains separate,
  current zero replaces history, and historical balances never admit spending.
- Recheck merge authority after custody-token acquisition, and reconcile
  unanswered merge requests before retrying or crediting a fleet landing.
- Tie project-group disclosure arrows to the button's expanded state.
- Update the example website's Oxfmt worker dependency to Tinypool 2.1.2.
- Patch proxy-address handling and source-map parsing dependencies in the
  workbench and example website to their maintained security releases.
- Isolate cancellation, capacity-wait and lock-expiry test clocks from filesystem setup speed,
  preserving the actual I/O and cancellation, expiry and recovery assertions.
- Wait for Bash cancellation readiness and avoid incidental sleep children in
  the escalation fixture, retaining confirmed exit and the original deadlines.
- Publish supervision fixture readiness atomically, avoiding partial PID reads
  while retaining independent-worker cancellation and settlement coverage.
- Load the build-identity API fixture during test collection so its request
  assertions retain their existing deadlines independently of module loading.
- Treat structured native CLI errors and cancellations as failed runs even
  when the process exits successfully, preserving partial changes for review.
- Count native tool calls across initial attempts, retries and repairs in
  the run trace without changing provider usage or billing accounting.
- Run the complete transcript suite after other web workers finish, preserving
  the streaming performance target, and await effect-driven approval focus.
- Wait for the review pane's initial file selection before fixture keyboard
  navigation, retaining the original line-comment and file-switch assertions.
- Run the complete handoff-recovery fixture in the serial local integration
  phase, retaining all cases and their original delivery deadlines.
- Reuse the same CI job's verified build for packaging and run the Windows
  native-alias suite once, preserving every distinct platform test.

## [3.24.2] — 2026-10-05

### Added

- Read one selected account again from Resources without waiting for a full
  account sweep. Cached readings, refresh holds and next-check times stay
  explicit, and confirmed readback updates the shared resource view.
- Run the official Claude CLI through a host-owned native adapter with
  account-bound authentication and usage checks. Model-directed filesystem
  tools execute in separate workers with no provider credentials.
- Navigate those worktrees with paged reads and directory listings, bounded
  literal search with content-bound continuation, exact-digest edits and
  directory creation. Legacy reads and writes retain their existing behavior;
  edits preserve executable permissions.
- Show cached Devin API account type and observation time separately from
  organization consumption and tracked budgets, without exposing private
  identifiers or treating the observation as Max subscription funding proof.

### Fixed

- Fence Devin CLI model selection to the same native account and current
  catalog. Automatic selection uses a verified Free model only while its
  pricing evidence and promotional window remain current.
- Reflect suspended and paused Devin sessions without adopting a completed
  answer, and recheck current authority, account and limits before each new
  session request or retry. Unresolved ACU exposure remains held.
- Preserve unknown organization consumption when no reporting buckets exist,
  rather than displaying an invented zero reading.

### Changed

- Enable existing long-running acceptance phase output by default while
  preserving explicit caller choices, shard membership and watchdog limits.
- Keep narrow fixture copies and set executable test-fixture permissions
  explicitly so private-log umasks do not change their intended behavior.

## [3.24.1] — 2026-10-05

### Fixed

- Keep the resident fleet alive while proposal maintenance holds its own
  mutation fence. Verified contention defers the heartbeat without recording
  a renewal; missing, replaced or corrupt ownership and write failures still
  stop the daemon.
- Show verification and proposal maintenance while that pass is running,
  then restore the current tick phase without overwriting Stop or a newer tick.
- Refresh resident fleet controls and status through shared queries so saved
  changes and current progress appear together.
- Wait for asynchronous merge-decision captions and the real outcome module
  in UI tests before asserting loaded content.

## [3.24.0] — 2026-10-05

### Added

- Desktop Automatic awake requests follow observed local chats and resident
  Fleet work. Power source, system idle-sleep settings, current request and
  freshness remain separate; cloud-only sessions do not hold the host awake.
- Devin organization consumption reports fractional daily ACUs and product
  breakdowns, independently of tracked budgets or session readiness. Idle
  startup collection and a shared refresh retain dated readings and permission
  failures without inventing remaining quota, credit balances or dollar spend.
- Growth shows source-qualified npm retrievals, GitHub stars and forks,
  rolling traffic and latest-release asset downloads. Missing coverage stays
  unknown; incomparable windows never become a single user or adoption total.
- Global and per-account allowance-before-reset controls support saved-state
  readback. Explicit Off disables reset priority and reserve taper; enabling
  cannot widen signed authority or authorize purchased-credit spending.

### Fixed

- Confirm saved executable work after automatic outcome planning. Omitted or
  refused refinements retain recovery; repeated attempts honor backoff without
  suppressing unrelated Leader triggers or daily and manual recovery.
- Keep automatic planning events from contacting a provider when current
  authority cannot apply the plan. Explicit advisory runs remain available.
- Fence Devin consumption against account/key transitions, including uncertain
  writes and restarts; retain provider retry deadlines and separate permission
  failures from session health.
- Preserve GitHub secondary-rate-limit backoff without anonymous retries after
  ambiguous permission failures. Collector shutdown does not delay chat reset.

### Changed

- Run whole-project CI lint and type checks once at the minimum supported Node
  version. Every platform retains its build and assigned tests.
- Start measured longest local test partitions first to reduce the serial
  tail. Exhaustive coverage, isolated test homes and failure cleanup remain
  unchanged; full-suite timing is measured separately from this scheduling fix.
- Task-scoped reset reserves preserve signed floors, actual usage ceilings and
  current account/model evidence at each contact. Reserve release remains held
  when the actual producer account is unbound. Current Claude producers need a
  separately qualified native CLI broker with isolated tools; no such producer
  or live allowance taper is enabled by this release.
- Existing abortable parked sleep can wake at a qualified task-derived reset
  boundary. Unknown, disabled or expired boundaries retain normal backoff.

## [3.23.0] — 2026-10-02

### Added

- Automatic chat chooses an eligible account and model from the project and
  task. Advanced keeps explicit overrides; failed routing preserves the draft
  and local-only projects retain their privacy boundary.
- Fleet outcomes save a desired result, enrolled repositories and acceptance
  criteria. The Leader refines dependency-ready tasks through the resident
  queue. Edit, Pause and Resume retain revisions, runs and selected proposals;
  Plan verified describes active task evidence rather than arbitrary product success.
- Automatic fleet count preferences remove operator count ceilings without
  inventing a large worker count. Manual numbers remain available; actual work,
  serving capacity, account admission and durable journal capacity determine
  dispatch, with financial and signed-authority settings kept separate.

### Fixed

- Keep the original local task and correlated tool calls intact when old
  conversation history no longer fits the actual configured context window.
- Record outcome claims and run identities atomically. Retry temporary terminal
  record lock contention without relaunching the producer.
- Recheck active outcome scope at producer, review and merge contacts, including
  after awaited setup. Preserve recorded effects when cancellation is in flight.
- Retain producer durations across retries and proposal capture; preserve
  Claude historical display readings across mutable CLI configuration updates
  while keeping financial identity checks unchanged.

### Changed

- Update the Automatic work guide, install instructions and website workflow
  examples. Include the Automatic, Verse and resident setup guides in npm.

## [3.22.2] — 2026-10-02

### Fixed

- Load the sidebar metadata channel after chat mounts, keeping reconnection
  code out of first-paint JavaScript while preserving shared resource updates.


- Keep unresolved Devin usage reserved after local dismissal, expiry or PR
  closure. Separate reported usage and operator adjustments from held exposure
  in the resource bar, drawer and CLI; cost estimates cover recorded usage.
- Pin new Devin launches to their organization and reconcile uncertain creates
  only against a unique, complete tagged session listing and matching exact
  terminal reading. Legacy launches without an organization pin remain held.
- Stabilize the conversation date fixture across midnight and add coverage
  for midnight and New Year day separators without changing chat behavior.
- Refresh desktop resource cards when a collector finishes, using one shared
  authenticated event stream. Preserve cached values and polling fallback;
  events carry only an invalidation signal, not account balances or identities.
- Allow an explicit, previewed choice of immediate Leader permissions for the
  original starting stage within the grant's overall permission ceiling.
  Leaving the choice untouched preserves existing stage permissions.
- Keep grant scope choices when collapsing and reopening the editor. Preserve
  account permissions and uncapped volume choices; require a fresh reviewed
  preview after source changes before Touch ID approval.
- Show the signed Leader ceiling separately from each stage's actual allowed
  actions, including an explicit advisory-only starting stage.
- Admit the registered parallel local engine through the fleet quota ledger.
  Hold local work when a reachable runtime reports no valid serving capacity;
  do not treat the display fallback as permission to dispatch.

### Changed

- Accept explicitly configured Devin concurrency and daily session counts
  beyond the former 10/200 ceilings, using safe integers consistently in the
  store, HTTP and CLI. Preserve defaults, zero opt-outs and financial controls.
- Derive local lane width from reported serving slots instead of fixed
  four-slot and 32-slot ceilings. Preserve explicit operator quotas, presence
  limits and shared execution controls; allocate workers from available work.
- Custody helper 1.2.0 can reauthorize one existing GitHub App or Claude token
  after an ad-hoc helper update, without exporting or replacing the credential.
  It requires a separate operator installation and human Keychain approval;
  publishing the Hub does not activate the fleet.

## [3.22.1] — 2026-10-01

### Fixed

- Admit the shipped Grok and Devin CLI engine identities in fleet quota
  reservations, while keeping their ledgers separate from API engine usage.
- Distinguish a live preparing Fleet tick from idle without inflating working
  agent counts, and label the last completed tick separately from current progress.
- Stop repeated Jev requests for unchanged attention items after completed
  low-confidence answers. Refresh on meaningful facts and urgency changes;
  retry transient failures sooner, with bounded caching and single-flight.
- Bundle the native structural diagnostic's five source texts with the exact
  build identity and verified hashes so it can inspect its own artifact.
  Missing or invalid snapshots fail the diagnostic without disk fallback.
- Show Codex subscription usage percentages and credit balances on separate
  resource-bar lines for each account. Qualify personal-plan dollar estimates;
  preserve provider holds, stale readings and unknown percentages without
  treating available credits as unused subscription quota.
- Scroll long resource lists within the desktop sidebar so navigation and
  Settings stay accessible in short windows; preserve phone navigation.

### Changed

- Expand and collapse Fleet goals and backlog independently, preserving full
  source order and accurate active, paused and planning counts. Distinguish
  pending reads and unavailable data from an empty list.

## [3.22.0] — 2026-10-01

### Added

- Load account-bound last-known usage immediately from a private cache, with
  gray historical meters and original timestamps while fresh readings load.
  History never supplies account readiness or autonomous spending admission.
- Add lazy execution-case timelines joining exact attempts to bound verification,
  canonical GitHub PRs, authenticated merges, and recorded follow-up results.
  CI and local suite coverage remain separate; deployment remains unrecorded.
- Separate account-bound captured gift and purchased credit pools in expandable
  resource details. Preserve exact dollars, original capture time and expiration;
  distinguish historical captures from native balances and operator estimates.

- Show current account-checked Codex credit units separately from subscription
  windows, including held or unknown spending status. Known personal plans show
  an explicitly estimated dollar value using a dated public reference; balances
  are not invoices or attributed task costs.
- Add expandable Fleet execution feedback from actual completed dispatch
  records. Separate producer success, failure, cancellation and refusal from
  recorded proposals, verified delivery and shipping. Partial coverage stays
  visible; opening details uses a shared background read without a model call.
- Feed exact no-proposal failures into stable recorded retros and the Leader's
  existing planning loop. Replayed attempts do not multiply lessons; conflicting
  outcomes and incomplete proposal inventories remain qualified observations.

### Fixed

- Bind native Grok fleet execution to the actual selected account, including
  confined runs, retries and repairs. Recheck current account identity, Stop,
  grant and headroom immediately before each selected native launch.
- Keep a failed preparation or cancellation from reusing a previous selected
  task context. Match deadline-fit boundaries between routing and Jev advice.
- Preserve current credit expiry and explicit provider spending holds in the
  resource display instead of calling every exhausted subscription Spent.
- Synchronize complete private account-roster fixtures, Grok reset provenance
  and browser-safe type imports with the production contracts.

## 3.20 workbench changes — included in 3.22.0

### Added

- Add reset-aware choices for actual selected tasks and eligible accounts.
  Compare observed duration quartiles against qualified provider deadlines;
  retain ordinary routing when deadlines or compatible history are unknown.
- Read supported Claude native structured usage with matched account, session,
  plan and zero-inference evidence. Pro/Max weekly-all deadlines retain the
  provider timestamp; legacy prose stays display-only and no start is guessed.
- Estimate duration and reported tokens from completed observations matched by
  engine, model and task kind. Label pooled account history, sample coverage
  and recording time; never derive a token allowance from a quota percentage.
- Add optional Jev advice among eligible task/account pairs. Send closed-set
  metadata, keep task text and account identifiers private, and recheck account,
  model, authority, Stop and metered availability after asynchronous advice.
- Show scheduling evidence in existing resource details and Fleet capacity.
  Add strict optional Jev daily-call preferences with confirmed saved readback.
- Include a sanitized online local-runtime qualification receipt: one explicit
  coding fixture passed its independent checker. Keep actual runtime identity,
  token coverage and uncontrolled cache conditions distinct from requested labels.

### Changed

- Keep startup resource reads lightweight: scheduling details use the recorded
  selected-batch cache without launching Jev or scanning dispatch history on GET.
- Price recorded Jev usage only when a concrete response model has known rates
  or the operator supplies both rates. Unknown cost stays unknown; historical
  records are not repriced using today's model aliases.
- Patch three transitive dependencies in the separate example site's lockfile.

### Fixed

- Let a later selected task use an available cloud or lane slot while an earlier
  selected task waits for a busy local lane. Preserve result order, Stop and
  actual local, cloud and lane concurrency limits.
- Preserve saved control defaults beyond 64 seats. Validate and atomically write
  the whole private file within a 1 MiB byte bound; unsafe, malformed or oversized
  files refuse changes instead of dropping other seats' settings.
- Preserve per-account budget policies beyond 64 seats. Reject writes that
  exceed the existing readable byte bound before touching the saved policy.
- Batch completed capacity-fixture history without changing its real receipts,
  persisted history, assertions or deadline.
- Preserve the complete enrolled account roster in metadata and capacity
  snapshots, removing eight-account and 64-seat truncation. Retain private-file,
  dense-array and total-byte checks; oversized snapshots never publish a partial
  roster or overwrite the previous snapshot.

## 3.19 workbench changes — included in 3.22.0

### Added

- Add compact Review navigation beside Work with me and Work for me: current
  chat changes and sources, usage, agent review, Needs you, recorded Fleet
  decisions and the module map. Reuse existing views and preserve chats and
  drafts; opening Review does not dispatch work.
- Add advanced goal preferences for open goals, daily creation, memo proposals
  and ordinary conductor cycles, plus Leader daily-run and Grok-lane
  preferences. Positive safe integers and explicit No preference limit replace
  the fixed business ceilings. Missing settings retain existing defaults.
- Expose the existing local-agent evaluation harness as `ashlr benchmark`:
  help and receipt comparison are offline; `benchmark run` explicitly invokes
  the configured runtime. Real checker failures return failure status. Keep
  content-bearing traces private and report usage coverage honestly.

### Changed

- Load account readings progressively: a slow provider no longer holds up the
  next account. Share a short startup refresh across views, show cached readings
  immediately and keep loading, unavailable and unknown usage distinct.
- Keep the resource roster stable and expose usage windows, reset information
  and freshness in expandable details. Use Devin's actual vendor mark and label
  operator-tracked credit and ACU figures explicitly.
- Refresh the public site with an accessible two-mode demo, a measured account
  queue visualization, current workbench screenshots and updated search metadata.
- Apply freshly read operator preferences consistently in planning, delayed
  execution, routing and status. Preserve actual admitted inventory, account
  availability, signed authority, Stop, single-flight and retry behavior.
- Keep incomplete goal-create and daily-run history unknown. Finite preferences
  require complete counts; explicit unlimited choices skip only the selected
  business comparison. Recovered daily history regains coverage after the
  affected day instead of indefinitely holding future work.
- Merge only edited preference fields and require confirmed saved readback.
  Preserve the separate preference to finish current work before expanding.

### Fixed

- Execute the benchmark's original checker source instead of the agent-writable
  checker file. Replacing that file cannot turn a wrong answer into a pass.

## [3.18.0] — 2026-09-30

### Added

- Add the read-only `ashlr openai-agents sessions|inspect|turns` CLI for managed
  API metadata, using host-held authentication, bounded pages and secret-safe
  output. It does not launch or control agents or qualify a fleet seat.
- Package cited OpenAI Agents, Dots companion and harness evolution guides,
  distinguishing current commands from the remaining execution and event adapters.
- Make Work with me and Work for me the two primary workspaces, using the
  existing chats, fleet, accounts, projects and shortcuts. Workspace switches
  navigate without dispatching tasks or changing agent permissions.
- Add editable guide starters for idle empty chats and direct fleet links for
  delegating a task, reviewing agents and guiding the Leader's fleet planning.
- Add explicitly reviewed, signed change-volume limits, including a no-volume-cap
  option. Existing grants keep their prior effective scope; changing limits
  requires a compatible custody helper and a new Touch ID signature.
- Add reported/unknown token coverage to local evaluation receipts and bounded
  offline comparison for compatible tasks, models, runtime configuration and
  recorded cache conditions. Comparisons do not invoke models.

- Add explicit account enablement, role, reserve and session-ceiling edits for
  server-listed grant accounts, with before/after preview and new-signature
  approval. Untouched fields and plain renewals preserve scope.
- Keep grant approval disabled while edited choices lack a successful current
  preview; a stale preview response cannot approve newer unsaved choices.

### Changed

- Let existing scheduling and cash-budget preferences exceed the former UI
  ceilings, and honour batch parallelism above the hidden eight-worker clamp.
  Keep defaults, safe numeric validation and actual admission; report the
  current 64-item durable-journal batch capacity in the budget panel.
- Keep eligible resident zero-dollar production and deterministic maintenance
  available after ordinary positive cash-budget exhaustion. Explicit zero-stop,
  signed scope, account reserves, unknown-cost refusals and accounting holds
  remain binding; hosted Devin retains separate ACU gates.
- Use the normal run token allowance (or `daemon.perItemMaxTokens`) for proven
  zero-dollar producers instead of deriving it from cash headroom. Unproven
  inference and mandatory fresh model checks wait; no eval is a dispatch gate.
- Account single-producer runs using concrete admitted engine economics instead
  of treating a custom subscription-like tier as proof of zero cost.
- Remove the six-seat task fan-out ceiling and the 200-workspace configuration
  ceiling. Runtime admission, provider capacity, isolation and configured
  retention still apply. `ASHLR_VERSE_AGENT_CAP=none` disables retention-driven
  automatic archiving; malformed overrides keep the established default of 25.
- Allow the standalone inbox automerge path to use its explicitly configured
  file/line limits above the former 10/300 ceiling. Previously refused larger
  configurations can now become valid there; defaults remain disabled and
  conservative. Resident fleet work still requires its signed effective scope.
- Collapse optional new-agent controls while retaining their current defaults.
- Restore the saved workspace on launch instead of forcing Command each day.

### Fixed

- Update bundled Hono to 4.13.7 for the JSX-renderer escaping advisory
  [GHSA-hxh3-vqpv-xpqv](https://github.com/honojs/hono/security/advisories/GHSA-hxh3-vqpv-xpqv).
- Admit the three packaged Agents guides through exact release-portability
  entries, preserving rejection of unapproved sibling files and wildcards.
- Refuse exhausted or occupied workspace port ranges before creation or restore,
  and serialize those admissions across repositories in the owning Hub process.
- Preserve shipped Grok and Devin CLI identities in dispatch ledgers so a
  successful run does not degrade later duplicate-suppression admission.
- Scope guide insertion requests to the current chat so a previous chat cannot
  suppress the first insertion or carry draft text into another conversation.

## [3.17.2] — 2026-09-30

### Added

- Show a compact Tools and context panel for each chat turn, with reported
  tool and MCP call counts, pending/failed results, cited sources and recorded
  playbook references. Labels are bounded and sanitized; observed calls do not
  establish server identity or prove that a skill was loaded.
- Add clickable, checked source-line evidence to inferred module dependencies,
  with explicit counts for omitted citations, unresolved recognized local
  imports and source files whose language resolver is unsupported.

### Security

- Update DOMPurify to 3.4.16, the patched release for GHSA-p98j-92pf-mc4p.

### Fixed

- Scope transcript tool caches to the chat and turn so reused provider tool IDs
  cannot carry facts or search text into another chat or turn.

## [3.17.1] — 2026-09-30

### Security

- Preserve existing GitHub ruleset review options, complete nested rule/check
  parameters and App pins when adding admitted required checks. Unknown root
  fields, incompatible policy and ambiguous identities require operator review.
- Hold setup's whole protection batch when any repository needs policy or CI
  provenance review, even when another repository is ready for an update.
- Re-read all selected existing rulesets before the first write and immediately
  before each update; changed or unreadable policies stop the batch. GitHub's
  read/write operations remain non-atomic, so concurrent edits can still require
  a new review.

## [3.17.0] — 2026-09-29

### Added

- Add a searchable local Wiki module map with dependency links, cited files
  and explicit scan coverage, using the existing scanner without model calls.
- Connect fleet Claude and Codex runs to the dedicated `ashlr-mcp` efficiency
  plugin when installed, using its managed launcher and per-run configuration.

- Search large account/model rosters when starting a chat; filtering preserves
  the selected execution identity and unavailable-model explanations.
- Include GPT-6.1 Sol in the documented Codex fallback catalog; each connected
  account's own model catalog remains authoritative.
- Add an opt-in `meta-muse` fleet API engine for Meta's documented
  `muse-spark-1.3` Chat Completions endpoint. It requires `MODEL_API_KEY`, is
  metered, and gains no implicit merge authority or consumer subscription access.

### Fixed

- Show expired, frozen and incomplete Locus/Phantom setup honestly in Apps,
  with recovery guidance that preserves the intended human-selected identity.
- Route all registered API-model engines through the existing sandboxed API
  runner, including configured providers and Meta Muse. Explicit API requests
  refuse missing keys or unavailable endpoints before dispatch rather than
  substituting another provider.
- Bound local capability inspection time, reuse recent evidence and keep
  uninspected models visible as pending instead of blocking large catalogs.

- Remove fixed eight-account, 32-worker and 64/256-model discovery limits.
  Serialized byte limits, probe concurrency, serving slots, quota reserves,
  per-worker execution limits and signed authority remain enforced.
- Preserve phone drafts during successful session checks; expired, revoked or
  signed-out sessions still revoke remote action access.
- Preserve the existing phone chat and draft after a confirmed first-turn
  refusal. Pause resends after ambiguous delivery and offer read-only chat
  inspection, preventing duplicate prompts after a lost response.
- Handle a retiring phone gateway removing its admin socket between inspection
  and connection without refusing startup or deleting another owner's socket.

### Security

- Confine Wiki file reads to the enrolled repository across symlink races,
  bound growing-file reads and refuse blocking FIFO reads.
- Patch the Raycast `brace-expansion` dependency to 5.0.12.
- Update `fast-uri` to 3.1.8 and `ip-address` to 10.7.2 for newly published URI
  normalization, address-family and parser denial-of-service advisories.

## [3.16.1] — 2026-09-28

### Fixed

- Keep the paired phone's Needs You feed live after its first read by allowing
  the activity route's validated cursor query through the remote gateway.
  Other query shapes remain denied.
- Declare local networking for the native macOS WebView and preserve it when
  updating an installed app, so Verse can load its loopback server.
- Give each native release a fresh Verse window URL and serve HTML without
  storing it, so WebKit cannot reopen an old shell with removed script files.
- Cap an Ollama-backed fleet lane at its effective one serving slot and reserve
  seats across each selected batch, allowing later items to use other signed
  engines instead of piling onto the same local model.
- Show full model category names in Growth chart tooltips and tables, and apply
  the one-percent display rule consistently across Meters and remaining-budget
  views, including values just over 100%.

### Security

- Update the bundled `fast-uri` and `ip-address` dependency pins to patched
  versions 3.1.7 and 10.5.1.

### Release process

- Run the full local prepublish suite in three bounded, isolated backend shards
  before the web suite, avoiding a duplicate full test run during release.

## [3.16.0] — 2026-09-28

### Verse release integration

- A phone layout is available at `/verse/m/` for chat, fleet review,
  approvals, and dictation on supported browsers. Optional remote access uses
  a separate loopback gateway behind Cloudflare Access, Mac-approved passkey
  pairing, bounded sessions, and step-up approval for control actions. It is
  off until the operator supplies a private gateway configuration and enables
  the desktop sidecar; the local Verse server keeps its own startup token.
  When configured, private push notifications reach paired iPhone Home Screen apps.
- The Agents board, computer control HUD, terminal workbench, and native
  Browser pane are integrated with turn-scoped authority. Agents board code
  auto-merge stays off by default and requires exact code gate evidence.
- Browser actions require the chat's live access and matching act or script
  scope. The old persistent Browser MCP grant route returns 410. Agent history
  back and forward are unavailable until the native pane can inspect the
  destination before navigation. Local-only act access cannot switch to or
  close a remote tab.
- Terminal assist defaults to local models. Sending terminal context to Grok
  requires a saved auto preference, an explicit per-request allowance, and a
  visible pre-send disclosure. Launching seats from a repo file binds the
  reviewed configuration to a digest checked before any shell opens. The
  interactive `terminal_send_keys` agent tool is unavailable while safe
  command submission is being implemented.
- Signed elite-direct grants can let eligible local CLI models land at G6
  within their signed ceiling. Cloud Devin still requires two independent
  judge families. Leader goal changes require signed class A authority.
- Learning recall validates anti-playbook matches before prompt injection.
  Signed post-merge observations and stable-window identity are visible as
  evidence, while positive outcomes remain inconclusive for credit and do not
  expand merge, dispatch, or policy authority.
- The native app bundle now carries the same 3.16.0 version as the CLI, with a
  prebundle version check. The Grok Bot companion workflow is documented.

### Dictation everywhere in Verse (desktop)

- Hold **⌃⌥V** to talk (release inserts), tap it to dictate hands-free until
  the next press, **Esc** cancels; **⌃⌥⇧V** turns the words into a ⌘K query.
  A mic button sits in the chat composer, the Leader composer, ⌘K and the
  terminal; the hotkey dictates into whichever of them is focused (or was
  last).
- Local and fast: NVIDIA Parakeet TDT 0.6B v3 on the CPU in the app itself,
  downloaded once (~670 MB, checksum-verified) on first use. Partials stream
  into a floating pill, dimmed; the final lands solid at the caret.
- Your lexicon applies (`lexicon serve`, with the chat's repo), falling back
  to a cached term map (a quiet **raw** badge) when the server is down.
  Spoken file names ("browser pane dot rs") become `browser_pane.rs` when the
  chat has exactly that file. The terminal gets the words verbatim and never
  an Enter.
- Every failure has a one-click fix: allow the mic, open Privacy ▸
  Microphone or Sound, re-download the model.
- Security: websites in the browser pane can never reach the microphone or
  camera (a deny-all WebKit media delegate on every tab, plus the tap).
- `ship:local` signs with a stable local identity ("Ashlr Local") so macOS
  keeps the microphone permission across rebuilds.

### Reasoning, actions and sources in Verse chats

- Every answer ends with numbered **Sources**: files the agent read, with the
  exact line range the call or its output proved (`parser.ts:12-51`), pages it
  fetched (title and domain), web searches it ran, docs and wiki pages, and
  shared memory. A cited file opens in your editor at its line, confined to
  the chat's own folders (`POST /api/verse/sources/open`); when it cannot, the
  row shows the call that read it.
- A settled turn's footer says what it did in one line ("Read 8 files ·
  edited 3 files (+42 −7) · ran 4 commands (1 failed) · 2 web lookups"), and a
  seat that keeps its reasoning to itself (Grok, remote agents) says so
  instead of leaving a gap.
- The actions timeline previews each collapsed edit's first changed lines,
  folds runs of clean reads into one "Read 6 files" row, names web calls by
  query or page and subagents by their brief, and counts a web search apart
  from a page fetch.
- **Sources** (⇧⌘S) and **Reasoning** (⇧⌘Y) panes replace the workbench
  stubs: sources de-duplicated across the chat with the turns that cited each,
  filters and "Cite" into your message; every turn's reasoning in one scroll
  with what the turn did. The transcript's own toggles open the same panes.
- Long chats stay light: past 40 turns, turns far from the viewport are held
  as placeholders at their measured height (the newest 10 and the running
  turn always render); jumping to any call, note or turn renders it first.
- Local reasoning models that inline `<think>…</think>` (Qwen3, QwQ,
  DeepSeek-R1) now stream that as reasoning, not answer text; Codex
  `web_search` items are no longer dropped.
- `core/verse/trace.ts` normalizes every seat's events into one schema
  (`thinking`, `tool-call`, `tool-result`, `source`, `summary`) and lowers it
  back to the existing events, so a new seat can emit it directly. The one new
  persisted event, `source`, carries only what no tool call proves (injected
  context, a remote seat's report); older clients ignore it.

### Versioned playbooks for every lane

- Playbooks are reusable task templates with the sections Outcome, Procedure,
  Specifications, Advice, Forbidden actions and Required from user. Each has
  front-matter for its id, name, `!macro`, the repos, globs and task kinds it
  applies to, done-when checks and a default budget.
- Versions never change after they are written. They are stored under
  `~/.ashlr/playbooks/<id>/v<N>.md`, and an edit writes the next version.
- Seven starters ship built in: fix-failing-test, fix-issue, dependency-bump,
  add-tests-for-module, docs-sync, perf-regression and security-fix.
- A task gets a playbook in one of three ways:
  - it is named directly (id, `!macro` or `id@v3`);
  - its text contains a `!macro`;
  - it is auto-matched by task kind and repo. Auto-matching is off for every
    playbook until it is turned on.
- The playbook is added to fleet goal dispatch, cloud briefs, Devin prompts
  and the Leader's `work.dispatch`, which gains an optional `playbook`. Cloud
  and Devin briefs get it before the delivery contract. Tasks with no
  playbook get exactly the same prompt as before.
- Every run records `id@version`. Cloud and Devin tasks record it on the task.
  Fleet runs record it in a uses ledger that is matched to the proposal's
  runId. Retros carry the record, so merged, refused, reverted and failed
  outcomes are counted per version.
- In Verse, a **Playbooks** section in the gear tray lists playbooks and shows
  each one as an engine reads it, with outcomes per version. Editing saves a
  new version. The ⌘K palette adds "Open Playbooks" and "Run playbook…", and
  the composer's ⋯ sheet adds "Use playbook…".
- Typing `!` in the composer suggests playbook macros.
- CLI: `ashlr playbook list|show|new|edit|run`.

### Integrated browser for you and your agents

- A Verse **Browser** pane that the workbench pane registry mounts:
  - address bar, back, forward and reload;
  - tabs, device sizes and zoom;
  - open in your browser;
  - the chat's dev servers, one click away.
- In the desktop app each tab is a native webview, so any site loads. The
  pane also captures screenshots (macOS), console output, uncaught errors
  and failed requests, and has an element picker.
- In a browser tab, or with an older desktop shell, the pane falls back to
  an `<iframe>` for loopback pages and "Open in your browser" for other
  sites.
- **Send to chat** drafts the page, its logs, a picked element and an
  attached screenshot into the message box. It never sends.
- Per-chat **agent access** grants turn-scoped MCP tools for observing and
  navigating. Separate act and script scopes permit guarded native clicks,
  typing and page scripts. External origins need an explicit per-chat allow;
  local-only act grants cannot act on remote tabs. Access is off by default
  and forgotten when Verse restarts. See `docs/VERSE-BROWSER.md`.
- Native changes (`desktop/src-tauri`) reach an installed app only through
  `npm run ship:local -- --native`.

### Every model working together in chat

- **Auto seat.** While you type, the composer names the seat for this message
  and the one reason ("Qwen 27B (local) — quick explanation — free and private
  on this Mac.", "Staying on Claude Max — refactor, mid-conversation — moving
  would re-send the whole context"). It asks the seat router itself
  (interactive: fleet reserves are yours and never bind you), tilting its cost
  weight per difficulty, then re-orders close calls by what you taught it
  (thumbs, retries, switches, Compare picks, overrides, escalations) and by
  fleet ship rate. "Send to" overrides it for one message. A message bound for
  another seat continues the conversation there with the zero-spend handoff
  note. On send the message is labelled once — by the Jev decision layer
  (`task-class`) above its 75% confidence gate once it is installed, else by
  the rules, and which path decided is recorded — and a
  label that would move it somewhere not on screen is shown first, never sent.
- **Compare and review.** Send one prompt to 2–3 seats side by side (default:
  Claude + Codex + a local model) and continue with the answer you pick; ask a
  different model family to review the last answer in one click.
- **Cheap-first.** Local models draft; hard or large messages go straight to a
  frontier seat, and a weak draft (failed, hedging, looping, cut off, no code
  for a code request) escalates on its own with the draft quoted.
- **One-click handoff.** Seat chip ▸ Continue on ‹seat› builds the note,
  creates the chat and opens it with the note in the box (a plan in the last
  answer rides along). Nothing is spent until Send; the reviewed-note dialog
  is one item below.
- **Local models first-class.** Warm up (load now, keep resident) with measured
  tokens/s, context window and an "On this Mac · private" badge only for
  loopback runtimes. A local-only repo (global local-only, `foundry.wiki.localOnly`,
  `localOnlyRepos`, or the repo's `.ashlr/wiki.json`) is routed over local
  seats only and never sent to the decision layer.
- **Per-chat meter.** Tokens and API-list-price equivalents across every seat a
  conversation touched (handoffs, Compare answers, reviews, drafts), what
  cheap-first saved, each seat's window, and what the fleet may take from it.
- Every turn these flows cause goes through the ordinary session routes, so the
  spend chokepoint, readiness gate, local-only gate and mutation token apply
  unchanged. No routing file and no fleet caller changed.

### The workbench panel: terminal, browser, changes

- The chat's panel sits beside the conversation or under it and holds tabs and
  splits from one pane registry: Terminal (⌃`), Browser (⇧⌘B), Changes (⇧⌘D),
  Files (⇧⌘O), Sources (⇧⌘S), Reasoning (⇧⌘Y), Tasks and Context. Each chat
  remembers its layout (the 40 most recent). Focus mode (⇧⌘F) leaves only the
  conversation; a pane key leaves it and shows the pane. `?chat=<id>&pane=<id>`
  opens a chat with a pane. A panel sheet restored open on a narrow window now
  closes with Esc.
- **Terminal.** xterm on WebGL with command blocks from the shell's own marks
  in zsh, bash and fish (no dotfile edits): exit code, duration and output per
  block, ⌘↑/⌘↓ between commands, a Blocks view (⇧⌘K) with Send to chat and
  Explain and fix, two panes per tab (⌘D / ⌥⌘D), and a read-only **Agent** tab
  of every command the chat's agents ran. KILL refuses and hangs up agent tabs.
- **Checkpoints and Changes.** Every agent turn, on every seat, is bracketed by
  hidden `pre`/`post` commits under `refs/ashlr/checkpoints/`, never touching
  your index, stash, HEAD or branches. The Changes pane reviews This turn,
  Since turn or All turns with word-level diffs, Accept/Reject per file or
  hunk, and Undo, Rewind and Redo behind a preview with a three-way choice for
  files you edited since. `ASHLR_VERSE_CHECKPOINTS=0` turns it off.

### Devin: chat seats, a fleet producer and the two-judge rule

- **Devin as a resource.** `ashlr devin connect` stores a `cog_…` key in the
  macOS Keychain; an ACU budget with a per-session hard cap and a reserve; Run
  in Devin and `ashlr devin launch`; a Devin card in Resources; Devin PRs in
  Needs you and the standing intake. Off by default.
- **Chat seats.** **Devin (cloud)** runs one Devin session per chat (replies,
  status, PR cards, an ACU reading, Stop watching or terminate). **Devin
  (CLI)** drives the local `devin` agent over ACP. The CLI seat checks that the
  binary is installed and logged in before every turn (409 with "Run `devin
  auth login`…" or the install command). PR links a CLI turn prints reach
  Needs you with Dismiss only; CLI usage is not reported, so it is not counted.
- **Its own engine.** `devin` is a grant engine that may only produce. The
  fleet launcher can start Devin on bounded backlog work under a grant that
  names it (default 1 at a time, 3 a day; `--fleet-concurrent`,
  `--fleet-per-day`). Signing such a grant needs custody helper 1.1.0
  (`sudo scripts/install-custody.sh`).
- **Two judges.** Cloud Devin PRs need ships from judges of two different
  families at G6. An eligible local Devin CLI seat can follow the signed
  elite-direct path. Merges remain bounded by the live grant; otherwise the
  would-merge is recorded as shadow.
- Needs you gives Devin PRs the Clean/Held verdict, Land all clean and an
  Evidence timeline. Close on both lanes takes an optional reason.

### Playbooks in every chat, automations

- A `!macro` typed in any chat, on any seat, runs its playbook; the message
  shows a **Playbook: ‹name› · vN** chip. Chats never auto-match.
- **Automations** turn GitHub issues and PRs, a red default branch, RRULE
  schedules, a local webhook and Telegram `/task` into one task in one lane
  (fleet, cloud, Devin or leader-review), through that lane's own gates.
  Gear ▸ Automations, ⌘K and `ashlr automations`. Four templates, all
  disabled. `ASHLR_AUTOMATIONS_AUTO=0` stops the per-minute check.

### Retros, lessons and the Jev decision layer

- Every task end (fleet, cloud, Devin, Leader) becomes a retro; suggested
  knowledge is used only after you approve it in Growth ▸ Lessons. `ashlr
  verse` now sweeps hourly (first after 5 minutes);
  `ASHLR_RETRO_SWEEP_TIMER=0` turns that off.
- `src/core/decide` is one typed decision layer for Jev (TypeSafe AI) with a
  deterministic fallback, per-kind confidence gates, a cache, a daily paid-call
  budget and kill switches at every call site: engine errors, completion
  claims, task classes, judge/taste/red-team extraction, retro root causes,
  Needs-you order, interrupt-worthiness, lane choice, automation triage,
  operator intent and advisory action classes on Leader memos. `ashlr jev
  status|test`, a Resources card and a Usage panel.

### A founder-mode Leader

- One founder-operator voice across memos, Mind and Telegram, guarded against
  claiming to be a real person; Telegram replies cut to 6 lines with "more".
- The Leader line on Telegram: a morning brief and evening recap, an instant
  brief on "status" or `/status`/`/brief`, result and revert pings, quiet
  hours, a daily ping cap and one question at a time with Yes / No / Your call.
- "Go build X" becomes work at once in the cheapest lane that can do it. New
  actions (cloud and Devin launches, backlog items, its own notes, playbook
  and automation versions) are classed and vetoable like every other.
- A daily self-improvement drive picks up to 3 Ashlr Verse improvements (at
  most 1 paid); `foundry.leader.selfImprove: false` turns it off.

### 3.15 integration

- Lazy imports in the sidecar are literal, so the Bun binary bundles them (a
  test now forbids computed `import()` in `src/core` and `src/cli`, outside operator plugins).
- A deleted chat's Browser-pane grant is revoked; `ashlr verse` exits cleanly
  once the Fleet surface has loaded; the gate's build step also copies the web
  assets.

### Documentation and verse.ashlr.ai for 3.15

- New guides: `docs/LEADER.md` (Mind, Telegram commands, buttons and briefs,
  founder mode, the CLI, directives, approvals, check-ins; its Telegram
  `/directives` and `/settings`, Approve wording, directive counter and
  Claude-free replies describe the leader-conversation-gaps change) and
  `docs/DEVIN.md` (setup, the chat seats, the CLI, ACU budget, delivery, the
  fleet launcher, the two-judge rule, limits).
- `docs/VERSE.md` covers every surface and shortcut as of 3.15: the ladder and
  shadow decisions, Lessons, the Leader conversation, Resources readiness lines,
  the workbench panel, every seat together, the repo wiki and Ask, playbooks,
  automations, the Jev decision layer, Devin and the ⌘K catalog.
  `docs/CLOUD.md` compares the cloud and Devin lanes. `docs/AUTHORITY.md` and
  `docs/AUTONOMY-GAP.md` state the current activation (grant active, ladder at
  shadow) and what the operator must still do.
- The site describes the Leader, autonomy with custody (grant, ladder, gates),
  the multi-seat workbench and its panel, the wiki and lessons, and the cloud
  and Devin lanes, with the fleet's real status (stage 1 of 8, shadow, 0 repos
  merging).

### Private repo wiki and Ask

- `ashlr wiki build|status|show|ask` and a Verse **Repo wiki** section (gear
  tray, ⌘K "Open repo wiki…" / "Ask the codebase…") generate a per-repo
  architecture wiki — overview, module map with import graph, key flows, data
  stores, commands and "how to change X" pages — stored only under
  `~/.ashlr/knowledge/wiki/`.
- Every file:line citation is verified against the repo before it is stored;
  unverifiable ones are removed and counted. Pages and answers are
  secret-scrubbed when stored and again when served.
- Generation routes through the Leader's check-in seat plan: local models
  first, Grok only when the grant lists the seat and the repo is not
  local-only, never Claude. With no allowed model, pages are built from
  deterministic repo facts and Ask returns cited passages.
- Pages regenerate only when their inputs' git blob ids change, within a page
  and token budget per run. Existing wikis refresh in the Verse background.
  Steering comes from `.ashlr/wiki.json`, and `.devin/wiki.json` is also read.
- Ask retrieves over wiki pages, the knowledge index and genome notes. It
  answers "not found" when they do not cover the question.

### Autonomous coordinator lifecycle visibility

- Separates last-reported coordinator transitions, fixed failure reasons and
  report time from fresh journal samples and worker connection status.
- Keeps caught successor-loop faults visible without closing independent work;
  reports do not grant execution, refresh budgets or trigger automatic recovery.
- Adds a test-only preparation measurement prototype with incorrect-candidate
  controls. Its diagnostic output cannot serve as accepted evaluation evidence.

### Controller observation comparison

- Adds session-only before/after comparison for consecutive accepted controller
  observations, including recorded reasons, intent, controls and graph changes.
- Preserves historical comparisons after failed refreshes and resets them on
  identity changes, with registration and clock-order caveats.

### Mission graph navigation

- Adds campaign ID/reason search, recorded-state filters and paginated results
  without hiding graph nodes or changing selection and scheduling order.
- Reveals selected nodes within the diagram and prioritizes their real links in
  dense graphs, preserving complete evidence details and explicit stale states.

### Recorded controller mission topology

- Adds a selectable campaign dependency diagram and evidence panel to the scoped
  console, distinguishing direct ordering from inherited delivery prerequisites.
- Projects bounded public relationships from verified controller enrollment,
  preserving legacy observations, explicit refresh and existing execution rules.

### Proven unstarted controller dispatches

- Records a held `dispatch-not-started` settlement when the owning invocation
  stops after intent publication but before calling work, with unchanged evidence
  and retained ownership. Known skipped calls no longer strand an in-flight slot.
- Preserves intent accounting, deadlines and retry restrictions. Unknown crashes
  and uncertain calls remain unresolved; inspector wording distinguishes intent
  from actual worker execution.

### Controller admission revalidation

- Rechecks target campaign and prerequisite evidence inside the acquired intent
  transaction, including after short-lock contention, before dispatch is recorded.
- Refuses stale admission without starting the queued work, retaining original
  deadlines, drain ordering and fixed enrollment instead of granting a retry.

### Scoped controller inspector

- Adds on-demand controller observation to the authenticated, root-scoped
  Universe console: recorded outcomes, original deadline and separate drain
  request/acknowledgement evidence.
- Keeps controller reads independent of experiment overview polling, labels
  historical results after failed refresh, and omits private receipt digests.
  No controller discovery, browser mutation or worker-liveness claim is added.

### Durable controller drain and resume

- Adds persisted controller-wide drain requests, ordered atomically against
  dispatch intent. Admitted work and planned deliveries can finish while the
  pending queue remains untouched.
- Records drain acknowledgement only after all durable intents settle. Explicit
  sequence-matched resume reopens admission without starting workers, resetting
  deadlines or replaying held attempts.
- Adds CLI/SDK controls, status metadata and native subprocess acceptance for
  drain, active delivery, restart and preserved-queue continuation. Existing
  histories remain readable; older binaries reject new control records.

### Controller owner intervention

- Preserves verified campaign readiness reasons in non-completed controller
  settlements, distinguishing owner controls from resource holds without
  changing delivery gates, budgets or retry decisions.
- Adds native subprocess acceptance for campaign pause/stop and controller
  SIGINT/SIGTERM, including worker cleanup, dependency holds and restart without
  replay. Documents the distinction between campaign control and whole-controller
  cancellation. Controller-wide drain/resume is a separate admission control.

### Release preparation

- Reapplies the current fleet allocation ceiling to cached console plans, so
  lowering the ceiling cannot leave remote workers displayed as eligible.
  Shared account aliases are withheld together; local model capacity is unchanged.
- Updates Hono, js-yaml and Vitest to patched versions, including the separate
  Raycast dependency graph. Retains script-free dependency installation.
- Clarifies the local-only successor release path and separates pushed source,
  verified packages, registry publication and commissioned fleet operation.
- Restores runtime command discovery in shell completions, including the
  supported install, status, rollback and run subcommands.

### Autonomous feedback and recovery explanations

- Adds fixed generation-failure feedback for not-started, withheld, unresolved,
  timed-out and failed attempts. Preserves null measurements, retained elites,
  cancellation behavior and private error boundaries; no new automatic retries.
- Explains collector recovery refusals with sampled, browser-safe diagnoses and
  contextual guidance. Validates reason/version consistency and preserves legacy
  records without additional read-time process probes.
- Adds a primary-source autonomy engineering brief covering durable execution,
  measured engineering yield, resource policy and harness-improvement acceptance.

### Collector recovery and configured status

- Adds durable per-command phases and same-boot passive recovery for tracked
  collector crashes. Requires exact matching records, an absent owner and absent
  registered process groups. Unregistered spawn windows and legacy active
  uncertainty remain blocked; recovery never signals persisted groups.
- Requires explicit no-start or owned-process-group exit receipts from native
  metadata calls, including every Claude usage subcommand. Group-absence probes
  never restore signaling authority after leader exit.
- Treats unexpected native runner throws and missing collector results as cleanup
  uncertainty. Stops queued/repeated metadata reads before permit release and
  retains pending evidence, including one-shot quota captures.
- Keeps the resource desk available after clean metadata-ownership refusals,
  showing an explicit blocked reason while preserving configuration and withholding
  managed workers. No native probe or retry starts in this state.
- Adds macOS boot-bound metadata fences and receipt-first recovery after a verified
  reboot on the same machine. Legacy and unregistered same-boot uncertainty remains blocked;
  recovery never substitutes for fresh quota evidence.

### Universe evaluation feedback and discovery

- Adds on-demand recorded campaign readiness to scoped and general consoles,
  with bounded reads, fixed recovery reasons, runtime-binding visibility and
  historical-state handling. Removes unconditional resume suggestions.
- Adds fixed, privacy-safe evaluator phase diagnostics to subsequent campaign
  feedback without inventing measurements or promoting failed candidates.
- Refreshes visible idle experiment views every 15 seconds to discover externally
  started work; active views retain three-second refreshes. Hidden tabs skip
  periodic reads and refresh immediately on return.

### Universe control room and shared collector admission

- Adds explicit shared-collector quota evidence for Universe, allowing generation
  while the foreground account console remains open. Private short-lived owner
  witnesses are rechecked inside task admission; no fallback probe is launched.
- Adds durable, revision-checked fleet account pauses, independent of usage
  allocation. Paused workers and shared-capacity aliases cannot receive new
  tasks; account visibility and existing reservations are unchanged.
- Introduces locally bundled Space Grotesk and IBM Plex Sans typography, a
  navy/ice control-room theme, topology-first resource navigation, persistent
  wide-screen inspection, and distinct Universe evidence-graph node treatments.
- Shows saved pauses on fleet nodes and provides explicit account-access controls
  with draft, conflict, historical-data and token-authority states.

### Account connections and adjustable fleet allocation

- Adds an explicit native account monitor to the resource desk: Codex account
  quota windows, Claude authentication status, and Grok ACP billing metadata.
  Unknown usage stays unknown; metadata does not enroll or launch workers.
- Adds a saved 0–100% fleet usage ceiling with revision-checked controls and
  atomic admission enforcement, including Universe generation. Outside usage
  counts toward reported account limits; in-flight requests are not interrupted.
- Adds isolated Grok profile preparation. Grok task execution remains unsupported;
  native sign-in and metadata monitoring do not imply model execution readiness.
- Adds version-gated Claude native `/usage` reporting without inference, with
  before/after identity checks. Rounded, potentially cached reports remain
  display-only; they never become fresh quota admission evidence.
- Improves account quota tracks, saved-ceiling reference markers, readable native
  window names, responsive layout and actionable missing-data guidance.
- Shares a two-client metadata budget across connection and admission collectors.
  Uncertain cleanup cancels both collectors before another queued read can launch.
- Labels retained native quota statuses and schedules as historical after failed
  console reads, including pending retries; explains unavailable allocation evidence.
- Adds an account-level reference summary identifying the most-used quota windows
  and margin below the saved ceiling. Partial, stale and approximate reports remain
  unavailable; tiny positive margins do not display as an exhausted allowance.
- Adds foreground supervisor reinvocation coverage for completed, interrupted and
  newly enrolled campaigns, preserving prior histories and budgets.

### Isolated native account preparation

- Adds `resources profile prepare` to create a new private standalone launcher
  and state directories for Codex or Claude, without copying credentials,
  changing desktop authentication or executing native login.
- Preserves native process identity/stdin through execve, strips ambient native
  authentication overrides and keeps preparation distinct from authentication,
  quota readiness and pool enrollment. Existing profiles are never overwritten.

### Multi-account commissioning diagnostics

- Adds a read-only Universe resource runtime check for private configuration,
  refresh pins, sterile workspace, shared capacity groups and timestamped ledger
  exclusions, with fixed diagnostics and no provider contact or storage creation.
- Adds explicit native launcher help/version checks for required Codex/Claude
  flags, with bounded subprocess cleanup and redacted reports. Grok's advertised
  ACP capability is identified separately from its unimplemented Hub transport.
- Documents concurrent Codex account enrollment separately from desktop account
  switching. Help compatibility and valid configuration do not attest native
  authentication, billing, current quota or successful model execution.

### Foreground campaign supervision

- Adds bounded supervision of an explicit queue of registered campaigns, with
  up to four concurrent runners, immutable admission checkpoints, durable outcome
  readback, and cancellation that awaits owned cleanup.
- Explicit owner pause is now recorded for operationally paused campaigns;
  repeated owner pauses remain idempotent. Optional raw-record checkpoints bind
  execution admission to exact control history as well as projected state.
- Supervision launches eligible never-started campaigns once, without resetting
  budgets, automatically retrying resource refusals, or installing a daemon.

### Unattended campaign prerequisites

- Adds read-only scoped campaign checks that distinguish owner controls, recorded
  resource holds, recovery needs and exhausted budgets without inferring current
  provider readiness or automatically resuming work.
- Adds optional pinned local model inventory refresh before resource generation,
  so explicitly enrolled local workers can renew stale evidence within existing
  deadlines. No download, model load, inference, account discovery or fallback is
  performed by the inventory check; failed captures withhold managed capacity.

### Bounded contention recovery

- Adds private `capacityWaitMs` for foreground Universe generations to wait for
  verified collector contention and otherwise eligible reserved worker slots.
  One monotonic allowance stays inside the original generation deadline.
- Rechecks current evidence without repeated metadata probes or new reservations.
  Expiry, denial and uncertain occupancy cannot become permission through waiting;
  atomic admission, task identity and replay protection remain unchanged.
- Keeps omitted/zero waiting compatible and documents foreground state honestly:
  no durable queue, live queue-position claim, worker retry or resident activation.

### Bounded Universe quota refresh

- Adds an optional private `quotaConfigPath` so resource generation can capture
  pinned Codex account metadata before admission instead of relying only on a
  stale observation file. Legacy runtime files retain file-only behavior.
- Shares the console's exclusive collector lease and durable pending marker;
  awaits cleanup and preserves uncertainty rather than duplicating a collector.
  Metadata time counts against the existing generation deadline.
- Preserves explicit file denials, shared capacity, task identity and replay.
  No task retries, account switching, quota resets, resident activation or
  automatic observation-file rewriting are introduced.

### Resource-backed portfolio execution

- Adds an execution-only `--resource-runtime` option to `universe portfolio run`
  so explicitly enrolled campaigns can share the existing quota-aware worker pool.
  Read-only planning, portable definitions, and results do not retain the binding.
- Captures the runtime path once per invocation and preserves campaign identity checks,
  original budgets, dependency ordering, cancellation, and shared resource caps.
  Worker-capacity withholding pauses campaigns; it does not add an implicit queue.
- Documents sequential dispatch for a single available worker and distinguishes
  generation invocation reservations from unknown native provider request counts.

### Resource-backed Universe generation

- Connects explicitly enrolled Codex, Claude and local resource workers to the
  existing scoped candidate parser, frozen evaluator, feedback and niche archive.
  Portable manifests pin pool identity; private runtime paths are supplied only
  to foreground run/campaign execution.
- Links generation evidence to durable task receipts and separates resource
  handoffs from direct-local requests. Unknown usage and replayed output remain
  unavailable; process completion alone is never artifact acceptance.
- Pauses campaigns on unavailable resource work without refunding reservations,
  honors current quota refusals across aliases, and preserves successful
  generation evidence when the subsequent evaluator times out or is cancelled.
- Adds recorded resource provenance to the CLI and Universe inspector. No
  automatic account commissioning, quota collector activation, registry
  publication or resident-fleet activation is implied.

### Universe commissioning and usable operator documentation

- Keeps occupied task receipts ahead of completed history even when a separately
  sampled supervisor has already settled or cancelled the work. The fleet map
  and task desk now share the same occupancy predicate and stable ordering.
- Adds a canonical documentation map and current-source quickstart. Separates
  Universe evaluation, resource-pool execution, pinned installation and dormant
  resident operation; corrects dependency, browser-session and contribution
  guidance without treating the North Star as completed functionality.
- Bundles the operator index, quickstart and architecture with local packages.
  Adds a network-free documentation navigation check for source and installed
  artifacts, including heading anchors and explicit source-only references.

### Resource pool operations console

- Adds `ashlr resources pool console` and a scoped `/resources/` operations desk
  with shared-capacity lanes, all-window quota evidence, routing exclusions,
  task inspection and explicit missing token coverage.
- Opt-in `--execute --workspace` enables durable bounded task scheduling with
  pause/resume, cancellation of owned work, no ambiguous restart replay, and
  bounded session-local output. Read and control capabilities remain separate.
- Handles transient observation failures without abandoning admitted work;
  isolates conflicting task identities and reports unconfirmed owned shutdown.
- Preserves local-only verification and independent Universe/legacy daemon scope.
  No account commissioning, resident activation or registry publication is implied.

### Account-aware foreground resource pools

- Adds `ashlr resources pool status|observe|run` for explicit Codex, Claude Code,
  and numeric-loopback local-model workers without credential switching.
- Intersects quota observations with rolling task limits and shared-account
  concurrency. Persists reservations before dispatch and never automatically
  redispatches an ambiguous or replayed task.
- Normalizes native quota evidence, retains partial/stale denials and bounded
  inventory-overflow refusals, and records reported tokens separately from
  verified engineering acceptance.
- Documents native account enrollment, output privacy, billing distinctions,
  and recovery limitations in `docs/RESOURCE-POOLS.md`. This source increment
  does not activate accounts, publish a registry release, or start a resident
  scheduler; Universe's evaluation contract is unchanged.

### Ashlr Universe local experiment kernel

- Adds `ashlr universe demo|init|run|status|archive` and the
  `@ashlr/hub/universe` programmatic interface.
- Executes budgeted, network-denied local candidate commands on macOS, checks
  frozen artifacts with a pinned evaluator, and persists raw measurements.
- Retains per-niche winners, reuses their artifacts in later generations, and
  rotates small trial budgets so later variants are not permanently starved.
- Adds an authenticated Universe console with lineage, comparison, failure
  evidence, and explicit unmeasured token and cost fields.
- Keeps the console responsive during expensive global summaries with a bounded
  background read worker, and removes duplicate notification polling. Reader
  failures remain explicit and mutation attempts invalidate cached observations.
- Grounds strategy in verified engineering yield. The credential-free demo
  verifies experiment mechanics; model-driven mutation, portfolio acceptance,
  and resident operation remain separate integrations.

Verification for this feature runs locally without GitHub Actions. The existing
3.4.0 release candidate's receipt does not certify these new source changes.

The frozen 3.3.0 record below references `docs/RUNTIME-FLEET-ACTIVATION.md`,
which is absent from current source. That historical activation description is
superseded, not a setup procedure. Use [runtime activation authority](docs/RUNTIME_ACTIVATION_AUTHORITY.md)
and the [current architecture boundary](docs/ARCHITECTURE.md#legacy-fleet-activation-boundary).
Neither the historical record nor a successful test activates a resident fleet.

## [3.14.0] — 2026-09-27 UTC — talk to the Leader anywhere, and a fleet that actually runs

3.13.0 turned autonomy on: grant #1 signed, the switch Autonomous, the resident daemon under the grant. Running it
live exposed what 3.14 fixes: paid seats were invisible to the fleet, the first tick stalled on a hung install, and
there was no real way to talk to the Leader. Installing 3.14 changes authority code, so grant #1 pauses until
`ashlr authority re-approve` (Touch ID); then `ashlr authority resident stop` / `start` puts the daemon on this build.

### Talk to the Leader — Verse, Telegram and the CLI, one thread

- One Leader brain. The legacy "Elon mode" dialogue and the Director are retired into it; free text from Telegram now
  reaches the real Leader instead of a stateless side-brain reading a June briefing (#522).
- A durable conversation thread (`~/.ashlr/vision/leader/thread.jsonl`, scrubbed, rotated). Replies come through the
  Leader's own seat routing and budget (Grok, then local; no tools); when it can't think it says why, never silence.
- Operator directives ("focus: …", "stop: …", "priority: …") become standing guidance fed into every memo run.
  Questions in memos can be answered; answers feed the next run. Class-B actions can be approved early (same checks
  as their window closing), class-C asks are recorded.
- Mind (⌘4) is now the conversation: threaded messages with channel badges, memo cards with Approve/Veto and veto
  countdowns, inline answers, directive chips; ⌘K "Message the Leader…" / "Add Leader directive…"; Needs-you
  "Answer" jumps to the question (#519).
- Telegram is a real two-way line: replies thread into the conversation, memos arrive with [Approve] [Veto] [Details],
  `/leader`, `/directives`, `/status`, `/help`; informational messages never queue behind an unanswered question;
  all text HTML-escaped and split safely; digests are change-driven (silent when nothing changed); a one-time
  migration expires the stale legacy requests that had blocked the queue since June (#520).
- `ashlr leader say | thread | answer | approve | directives`.

### Leader reliability

- The "zero active goals" memos were a read bug: three goal files with 1970 timestamps made the store read
  incomplete and the Leader treated that as none. One shared definition of an open goal now; incomplete reads are
  reported as "at least N" (#521).
- Seat fallback: Grok → fast local (gpt-oss 20B) → the 27B → Claude only for the weekly deep run or by opt-in
  (`foundry.leader.claudeFallback`). Local calls stream (the 09-26 memo failed on a 300 s non-streamed fetch). Failed
  runs retry at 15 m / 45 m / 2 h. Health (healthy/degraded/down + why) in `GET /api/verse/leader`.
- Check-ins every 2 h during working hours when evidence changed materially (`foundry.leader.checkinHours`), capped;
  a cross-process lock and a stale-decision re-check stop double runs between the daemon and the comms poller.

### The fleet, live

- Accounts: the idle Verse sidecar kept the account-metadata lease and published an empty "fresh" snapshot, so the
  daemon saw every paid seat as unknown and only local was eligible. Idle Verse now releases the lease and stops
  publishing; the daemon reads its own or a live holder's evidence. The Resources drawer (⌘.) shows per account
  "Chat: ready / why" and "Fleet: ready · reserve kept / why" with the fixing command; one Local card spans Ollama,
  LM Studio and llama-server (#531).
- The first tick stalled ~15 min: a sibling `file:../` dependency made `bun install` hang, and the old timeout then
  deleted `node_modules` synchronously on the main thread. Installs now run in their own process group with a hard
  timeout, cleanup is async, per-repo and per-tick deadlines keep one bad repo from holding the rest, and
  `ashlr daemon status` shows "tick in progress: <phase> for <duration>" (#527).
- Repos with `file:../<sibling>` dependencies resolve siblings to pinned snapshots of their enrolled fleet mirrors;
  pins are part of the install key and the G3 digest, so a moved sibling invalidates the proof (#532).
- Private repos on GitHub's free plan can't have rulesets or branch protection: new grants use local enforcement with
  the fleet App's `ashlr/verify` there; status/setup explain the mismatch for an existing grant and re-approve
  switches it (low risk, 4/day) (#524).
- Command shows the rollout ladder while a grant is active (stage x of 8, progress to the next stage, grant countdown,
  what happened last); Fleet lists every shadow decision with G0–G7 chips and why (#525).

### A sidecar that can't freeze

- A macOS privacy (TCC) prompt on ~/Desktop or ~/Documents froze every route for ~3 minutes after an install: a
  synchronous folder read on the main thread waited on the dialog. The login-shell probe can no longer hang,
  the Apps warm-up runs after startup (#518), and every Verse request path now reaches project folders
  asynchronously with a bounded pool; `git` runs as `git -C <dir>` from `/`; routes that must start in a folder
  check access first and answer 503 while a prompt is pending. `scripts/check-verse-sync-io.mjs` fails any new
  `*Sync(` in a Verse API route. The Bun-only per-request usage rollup moved to the background worker (#523).

### Charts

- Monotone curves through every reading (no overshoot), per-series gradients, pixel-snapped hairlines, tabular
  numerals, exact-value tooltips with local-time titles, keyboard reading, one-time draw-in (reduced-motion aware),
  shape-matched skeletons, reserve bands on seat burn-downs, consistent provider colors (#528).

Released with `npm run gate -- --base v3.13.0` (959 backend files, 22,464/22,551 tests; 218 web files,
3,779/3,779) and a follow-up `--base a1a0b0ef` for #532 (GATE PASS). The one backend failure, a `verse-adapters`
`elapsedMs` 0-vs-1 timing assertion in a file unchanged since 3.10, passed 51/51 in three solo reruns.

## [3.13.0] — 2026-09-26 UTC — autonomy you can actually turn on

3.12.0 compiled in the operator's custody key. 3.13.0 closes the gaps that kept a signed grant from doing anything:
G7 could never pass on a repo without CI, cloud and self-improvement PRs never entered the merge gates, and the
resident daemon could not be installed at all. Autonomy still starts only when Mason signs a standing grant (Touch
ID), sets the switch, and runs `ashlr authority resident start` himself; `ashlr authority setup` walks every step.

### A host-verified `ashlr/verify` check (G7 can pass without CI)

- The ashlr-fleet App posts `ashlr/verify` on each fleet PR head from the G3 result: `success` only when G3 passed,
  commands ran, and GitHub's head carries exactly the verified tree on the verified base; anything else is `failure`
  (#511). The run lists the verify digest, tree, base and the commands that ran.
- G7 on local-enforcement repos requires the App's own green `ashlr/verify`; a deploy-only green (a Vercel preview)
  or a same-named run from any other App no longer passes. `ashlr authority protect` pins `ashlr/verify` to the App
  even when master has no check runs. The App manifest asks for Checks: write; setup links the settings page when an
  existing App lacks it.

### Cloud and self-improvement PRs land through the standing gates

- Each standing tick ingests `pr-open` cloud tasks whose repo is in the grant: identity-checked against the pinned PR
  (head `ashlr-cloud/<task>`, unchanged base, pinned head SHA), size-capped, filed as a pending proposal with the
  session report marked UNVERIFIED, and host-signed over the diff hash (#514). Correctness still comes from G3–G7;
  G6 needs a non-Claude judge. Once the fleet PR opens, the cloud PR is closed as superseded and the task follows the
  fleet PR to `merged`.
- Needs-you can Land, Close or Update a cloud PR, with an inline gate preview (G1/G1b/G2/G4 on the pinned diff,
  GitHub mergeability and checks), multi-select and "Land all clean" (#508).
- Self-improvement waits for review: at `selfImprove.maxOpenPrs` (default 3) open PRs it stops launching
  (`ashlr cloud budget --self-improve-max-open <n>`) (#508).
- Every cloud task has an evidence timeline — objective, session, worker, report (a claim), PR, diff, checks, gates,
  merge, release, health, cost (an estimate) — each step marked verified, claim or unknown (#507).

### Rerun-safe autonomy setup, and a live setup checklist in Verse

- `ashlr authority setup` is safe to rerun. The provenance key is rotated
  only once; the rotation is recorded, so a rerun with `--yes` no longer
  invalidates pending proposals. A ruleset GitHub already holds with the same
  content is reported `already` and is not applied again, and
  `protect --apply` skips it too. The GitHub App counts as done only once it
  is installed on the enrolled repos; until then setup prints the install
  page.
- A failure in the App flow, the Claude token prompt, key creation or the
  grant draft is recorded as a failed step, and the run still ends with its
  summary.
- The `--dry-run --json` checklist now gives each open step the command
  that moves it on, plus a `link` where there is one (the install page or the
  trust-root PR). Both fields are additive to `ashlr.authority-setup.v1`.
- New read-only route `GET /api/verse/authority/setup` serves the dry run's
  checklist, cached for 30 s. It never prompts, signs or opens a browser, and
  it runs only bounded `gh api` reads.
- Verse's "Autonomy is off" state and onboarding step 4 show that checklist:
  the next step with what it needs and the command to copy for it, plus
  every step. Verse no longer asks the server for a grant draft on load (a
  dormant fleet used to log a 409 there on every launch). It drafts only
  when you open the Touch ID sheet.

### Resident runtime under the standing grant

- Adds `ashlr authority resident start|stop|status`. `start` installs or
  restarts `ai.ashlr.daemon` only under an active Touch-ID-signed standing
  grant, from a clean compiled release, with Stop off. You run it yourself in a
  terminal: agent, daemon or swarm environments, a redirected HOME, no TTY and
  `--yes` are all refused. It claims a single-use capability before any launchd
  effect and records the start in the authority ledger.
- Regenerates the launchd plist (budget, interval, parallelism) from config on
  every start. `status` and setup report drift after a config change.
- `ashlr authority setup` now reports the resident step as already in place,
  waiting on you with the exact command, or blocked on a missing prerequisite,
  instead of a permanent build block.
- The legacy install, reinstall, repair and restart paths stay denied, and the
  permit-based compiled roots stay empty.
- See [docs/RESIDENT-RUNTIME.md](docs/RESIDENT-RUNTIME.md).

### Verse's own improvements

- A spent seat reports when it actually reopens (the latest reset among its spent windows) (#499).
- Budget, decisions, capacity, session-meta and activity read failures return a 503 with a plain sentence instead of
  defaults or empty lists, and the UI says so (#501).
- Lane and seat reasons are written in plain words on the server; older journal wording is still rewritten (#504).
- A regression test pins Pulse's local-day labels outside UTC (#505).

Released with `npm run gate -- --base v3.12.0`: GATE PASS in 43m29s (854 backend files, 19,846/19,924 tests with
known failures; 190 web files, 3,335/3,335).

## [3.12.0] — 2026-09-26 UTC — your key is the trust root, and Verse says one clear next step

**Your custody key is compiled in.** `src/core/authority/trust-roots.ts` now carries Mason's Secure Enclave key
`se-p256-9c1330e3bd72cf3e` (#506, opened by `ashlr authority setup`), so a Touch ID–signed standing grant verifies on
this build. Resident activation stays blocked in this release (see `ashlr authority setup`); the resident runtime,
the host-verified `ashlr/verify` check and cloud-PR intake are the 3.13 work.

The 3.11.5 package already contained the changes below; its notes described only the account-freshness repair. They
are recorded here. 3.11.4 shipped a crash — Command and Fleet failed to load in the browser because a shared secret
scrubber read `process.platform` at import time — fixed in #498 (and in 3.11.5). A new test walks everything the
web UI loads and fails on any Node-only global touched at import.

### Autonomy is off → one clear next step

- Command, Fleet, Growth and Mind no longer show grids of empty cards while the fleet is dormant. One shared
  "Autonomy is off" state says what is off and offers the single next action: **Approve grant** (opens the Touch ID
  sheet) or the exact setup command with Copy (#490).
- `ashlr authority setup --dry-run --json` prints the setup checklist for a UI: each step's status and what it
  needs from you (sudo, Touch ID, browser, GitHub, terminal) (#492).
- `ashlr authority setup` is safer to rerun: it finds a trust-root PR it already opened (or a key already merged),
  creates the canary repo before protecting it, and ends with the daemon service's real launchd state (#492).
- ⌘K gains the actions that matter: Autonomy Off / Propose / Autonomous, Approve grant…, Budget mode, Copy the
  setup command, Run in cloud… — all through the same guarded paths as the Command bar (#494).

### A calmer Command

- One compact **Seats** strip replaces the tall burn-down cards; the full charts moved to Usage → Seat windows.
  Seat status comes from the same model as the rail, and says "Status unknown" when sources disagree (#493).
- The grid no longer leaves half-empty rows at medium widths; card menus sit in the card header (#493).
- The first-run tour is a one-line "Getting started" chip, with a new "Turn on autonomy" step (#494).
- About 85 strings rewritten: plain facts instead of defensive "X, not Y" sentences; route paths moved out of error
  copy into a details disclosure; the double-period bug fixed (#489).

### Accurate numbers

- Charts keep their size at any window width: line, bar and burn-down charts measure their container and draw at a
  fixed pixel height with 12 px labels (the 1900 px tokens chart used to stand 573 px tall) (#497).
- Days are local: usage rollups, fleet history and "dark since" bucket by your local day, not UTC (#497).
- Claude usage is no longer double-counted (one transcript line per content block repeated the full usage); this
  also corrects the Claude capacity reader that feeds the budget gate (#498).
- Local Ollama `name:tag` models cost $0 (#498). One context-window unit everywhere (64k, not 66k) and clean model
  names ("gpt-oss 20B", "Qwen3.8 27B (64k)") (#500).
- The cloud lane says "Not set up · ~$250 credits (estimate)" instead of showing unspent credits as live headroom (#500).
- The rail tooltip says "resets" once (#495).

### Fleet engine

- The runtime probe no longer blocks the event loop: no `which llama-server` per poll, and `ps` output is parsed in
  yielding slices (#481).
- Adopted harness effort and sampling now reach every engine at dispatch (Claude `--effort` only on builds that accept
  it) (#484). The seat router uses its λ cost/headroom/latency weights; default weights reproduce the previous order
  exactly (#486).

### Operations

- Comms: requests older than 48 h (`comms.requestTtlHours`) expire, so one unanswered Telegram question no longer
  blocks every later message and fails the nightly oversight job (#492).
- `/api/verse/apps` is warmed at `ashlr verse` start; ⌘. during a running turn only stops the turn (#498, #500).
- Test flakes fixed: fleet-live "mergedToday" near midnight, m142 under parallel load (#500).

### Faster first paint

- Chat's first-paint JavaScript fell from 351.8 KB to 333.1 KB under the unchanged 352 KB budget: the shell's
  first-paint code ships as one chunk, and the ⌘K catalog, onboarding flow and delete dialog load on demand (#502).

Released with `npm run gate -- --base v3.11.5`: build, typechecks, eslint, real-io lane, docs, first-paint and web tests
passed; the backend run (757 files, 17,896/17,995 tests) failed 14 files on a machine at load ~200. Rerun alone with
longer timeouts, 12 pass; `universe-hub-marker-campaign` and `universe-capacity-wait-integration` fail the same way on
v3.11.5 and are pre-existing.

## [3.11.5] — 2026-09-26 UTC — keep account evidence honest through probe faults

- Keep a verified account's last observed usage visible only for its original
  freshness window when a native metadata probe fails. Show that the new check
  failed and withhold usable/autonomous status until a fresh probe succeeds.
- Expire retained readings at their original deadline and withdraw them on
  account identity changes, sign-out or uncertain native process cleanup.
- Treat individually expired shared readings and operator baselines as
  historical evidence. Account cards and seat summaries no longer turn saved
  credits or old percentages into a current access claim.
- Start each nonoverlapping account probe cycle from its previous start time,
  reducing false gaps in healthy Codex readings during slow provider checks.
- Expire Claude and Grok readings between probes as well. Label retained
  windows and credits as prior reports in the account card and detail view,
  including accessible meter descriptions.
- Honor local and shared collector denial signals while retaining unexpired
  quota flags for context. Unknown or denied account evidence cannot become
  autonomous routing headroom, even when a prior percentage is visible.

## [3.11.4] — 2026-09-26 UTC — verify cloud deliveries before showing them

- Cloud tracking binds a delivery to the requested repository, base, head and
  exact pull-request identity. Ambiguous, changed or unavailable GitHub evidence
  removes a previously shown PR from Needs you until it can be verified again.
  A verified closed PR is watched for a bounded period so reopening it restores
  Needs you. Bounded polling shares attention across tasks so old work is not starved.
- The latest tagged cloud report is authoritative. A newer malformed, oversized
  or unfinished revision withdraws the older report. Command and Needs you label
  session-authored summaries as unverified claims.
- Chat shortcut hints use the shared command catalog, displaying Ctrl on
  Windows/Linux and Command on macOS.
- The public site and guides distinguish the working cloud lane from the dormant
  resident fleet, and update the measured first-paint result to 349.7 KB.

## [3.11.3] — 2026-09-25 UTC — ship:local installs the app icon too

- `npm run ship:local -- --native` now also installs a newer `desktop/src-tauri/icons/icon.icns` into Ashlr.app. It
  backs up the old icon like every other file, then touches the bundle so the Dock and Finder pick up the new icon.
  Without `--native`, or when the icon hasn't changed, the step is skipped.
- Released with the new loop: `npm run gate` passed in 27.6s (88 web and 471 backend tests related to the change,
  plus the smoke set), then `npm run ship:local` installed it.

## [3.11.2] — 2026-09-25 UTC — the Ashlr.AI mark, a lighter first paint, and a release loop measured in minutes

3.11.1 was tagged but never published to npm. 3.11.2 includes everything in it.

### The Ashlr.AI mark

Verse now carries the Ashlr.AI keystone "A" in its rail, the macOS app icon, the menu-bar icon and on verse.ashlr.ai
(the header and the favicon). The mark was traced from the brand's own file, `ashlar-landing`
`public/logos/ashlar-mark.png`: navy `#1A2B3C` legs around an electric-blue `#2563EB` core. In the app, the legs take
the ink colour so the mark reads in light and dark themes. The menu-bar icon is a dedicated template image, so it
follows the macOS menu bar.

### Faster first paint, built by Verse itself

Chat's first-paint JavaScript fell from 369.9 KB to 349.7 KB, meeting the 350 KB target set in 3.10. The build now
fails above 352 KB. The work came from Verse's own cloud self-improvement (#478).

### A release loop measured in minutes

- **`npm run gate`** runs the static checks in parallel with caching, then only the tests your change can reach
  (backend and web), plus a smoke set that must always pass. Known environmental failures are listed with reasons
  and reported, never hidden. `npm run gate:full` runs everything.
- **`npm run ship:local`** builds, packs and installs the release as your CLI. It updates Ashlr.app with the
  sidecar and web assets (and the native shell with `--native`), keeping the previous build aside, never deleting
  it. It then re-signs the app, restarts the background services and waits for Verse to answer. `--dry-run` shows
  every step.
- See `docs/RELEASING-LOCALLY.md`.

### Also from self-improvement

- **#480:** the local production gate no longer fails on the `desktop/src-tauri/gen/` folder a Tauri build leaves
  behind, while a truly unexpected file still fails it.
- **#477:** fixes Dependabot alert #32. The vulnerable `rustls` in the desktop app is updated, and there's a
  regression test.

### Resource bar fix

The rail's resource bar now includes the budget view, as the drawer does. Claude and Grok batteries show their real
windows instead of an empty "—".

### Verification

Verified with the new gate itself. `npm run gate` against master took 5m24s for this 59-file change and passed: all
static checks, first paint at 349.7 KB, 3,170 related web tests and 4,756 related backend tests (the rest were
skipped). Separately, the full web suite (4,649 tests) and the Rust tests (173) pass.

On the way, the gate caught two things, both fixed. A backend test imported a function the first-paint work had
moved. And `compaction-point.ts`, split out of `context-math.ts`, joined the authority import closure; that
growth was reviewed and accepted.

## [3.11.1] — 2026-09-25 UTC — you can see who you're running on, all the time

### Provider logos

Every place Verse shows an engine now shows the provider's own mark: Anthropic's Claude, OpenAI, xAI's Grok and
Ollama. That covers account tiles in the drawer and Apps & Accounts, the composer's seat chip, the chat header,
⌘K, the tasks pane and chart lane labels. The account's name always sits beside the mark as text. The marks come
from @lobehub/icons (MIT) and are inlined, so they need no network. They load with their own small chunk, never on
chat's first paint.

### Always-on resource bar

The rail foot now carries a live bar with one battery per resource, showing what's left of each account's binding
window. It covers Claude, both Codex accounts, Grok, your local models and your cloud credits. Colour tells you
usable, low or spent. Hover or focus a row to see every window with its reset, the share kept for you, and when a
spent account comes back. Click to open the Resources drawer. With labels shown, each row reads the full account
name over a battery and value. With labels hidden, the rows become upright batteries under each logo. **Hide
resource bar** is in the drawer's footer and in ⌘K, and it brings back the single capacity ring.

### Verse keeps working in the background

The main window no longer lets macOS suspend the page when it's hidden (macOS 14+). Until now, opening Verse
behind another full-screen app could leave it on "Checking for an existing Verse session…" for minutes. Chats,
Needs-you banners and resource readings also froze until you looked at it again.

### Built by Verse, on its own

The cloud lane's first self-improvement pull requests are in this release:
- **#475** fixes the eight Universe campaign-recovery tests that had failed since 3.9.1. That includes a real bug:
  a campaign whose run hit its deadline before a winner was picked was recorded "failed" instead of "completed".
  The files that only run on macOS were verified on this Mac.
- **#476** brings the release-policy tests (m522, m440, m468, m454, m231, npm-cli-launch) up to the current manual
  release process. Their safety rules are kept as explicit checks, tested in both directions.

The estimated cloud spend is calibrated to the real balance: $210 of $250 left.

### Verification

Checked locally:
- Build, both type-checks, eslint, the real-I/O lane, docs and first paint (369.9 KB of 370) pass.
- 4,619 web tests pass.
- The backend suite passes 29,815 tests. The one failure is `m571`, which trips on the Tauri `gen/` folder a local
  desktop build leaves behind; fixing that is queued in the self-improvement backlog. Every other failure that had
  been open since 3.9.1 is fixed.
- 173 Rust tests pass.

## [3.11.0] — 2026-09-25 UTC — the cloud lane, and every resource one keystroke away

Verse can now spend Claude cloud credits. It launches Claude Code cloud sessions, which keep running on your
credits after the subscription window is spent. It tracks what each one delivers, and it uses them to improve
itself within limits you set. Every account, local model and credit balance now sits in one drawer on the right
of every page.

### Cloud lane

- **Launch from anywhere.** The chat composer's ⋯ sheet has **Run in cloud**. Command has **New cloud task** and
  **Improve Verse**. The CLI has `ashlr cloud launch "<task>"`.
- **How a launch works.** Verse starts each session through the Claude seat's own claude.ai login, from an isolated
  checkout under `~/.ashlr/cloud/checkouts`, never your working copies. It marks only those checkouts as trusted.
  The session works on `ashlr-cloud/<task>` and opens a **draft PR** with a machine-readable report. Verse follows
  the PR with `gh`: running, then PR open, then merged or closed. Nothing in the cloud lane merges; that stays with
  the custody gates or you.
- **Verse improves itself.** A built-in backlog of real gaps, plus suggestions from the Leader's memos, feeds
  self-improvement launches. The defaults are 4 a day, on `ashlrai/ashlr-hub`, pausing below $40. You can switch
  it off in the Cloud card, in Usage, or with `ashlr cloud budget --self-improve off`. Setting
  `ASHLR_CLOUD_AUTO=0` disables the scheduler.
- **Spend is an estimate, and says so.** Claude doesn't expose the credit balance, so Verse counts sessions at a
  per-session estimate you can adjust. It always links to your real balance on claude.ai.
- **Surfaces.** The Cloud card on Command, a Cloud credits panel in Usage, a "Cloud · N running" chip on Fleet,
  Needs-you items for ready PRs and failed launches, and `ashlr cloud list | refresh | improve | budget |
  backlog`. See `docs/CLOUD.md`.
- Verified end to end on this Mac: launch, session, draft PR, parsed report, closed.

### Resources drawer

- **On every page.** An edge tab, a rail button, **⌘.**, or "Show resources" in ⌘K opens a drawer on the right
  with every resource you run on. That's your Claude, Codex and Grok accounts, with window meters, the reserve
  kept for you, reset times and Reconnect / Check again. It also shows local models, with runtime state and
  verified context windows, and your cloud credits.
- **Overlay or pinned.** It opens as an overlay or pins as a column beside your work, and remembers which you
  chose. A dot on the edge tab says at a glance whether everything is usable, something is tight, or an account
  is spent or signed out.
- It loads after first paint, so chat still opens as fast as before.

### Website and docs

- verse.ashlr.ai, the README and `docs/VERSE.md` now describe 3.9–3.11: verified context windows, live reasoning,
  autonomy with custody, budget modes, the workbench, the four surfaces, burn-down history and the cloud lane.
  `docs/CLOUD.md` is new.

### Verification

Built as six Claude Code cloud sessions running on Claude credits, then integrated and checked locally (GitHub
Actions is off):
- **Static checks:** build, both type-checks, eslint, the real-I/O lane, docs, and first paint (369.3 KB of 370).
- **Web suite:** 4,615 tests pass.
- **Backend suite:** 29,772 tests pass. The only failures are files that already fail on 3.9.1.
- **Cloud lane:** 312 tests, plus a real launch on this Mac that ran from session to draft PR to parsed report.
- **Custody guards:** they flagged the cloud modules joining the authority import closure. That growth was
  reviewed and accepted, and those files are now owner-lane protected.

## [3.10.1] — 2026-09-24 UTC — the workbench reads cleanly, and the charts tell the truth

3.10.0 landed on Mason's screen. This release fixes what showed up in the live app: labels piled on top of each
other, raw timestamps and file paths where people expect words, the model named twice in the composer, and a Claude
burn-down chart that forgot everything on every reload.

### Charts

- Axis labels no longer collide. When the start, "Resets …" and end labels don't fit, they shorten together
  ("Fri 11:46 PM", then "Sep 18") before the lowest-priority label is dropped. Within one day, the axis shows clock
  time only.
- Ticks come from the step: a 0–1 axis reads 0, 0.2 … 1.0 rather than rounding 0.25 to "0.3", and count data gets
  whole-number ticks.
- Placeholder timestamps (epoch 0, anything before 2000) never set a chart's range, so the Growth harness chart no
  longer starts on "Dec 31". A burst of readings shows as a cluster, not three stacked labels.
- End-of-line labels move apart, or fall back to the legend. Heatmap digits are drawn without the halo that garbled
  them. An all-zero funnel shows empty tracks.

### Command

- **Burn-down history survives a reload.** Seat window readings are recorded to
  `~/.ashlr/routing/capacity-history.jsonl` (0600, at least 8 days kept, capped at 2 MiB, flat runs compressed) by
  the daemon and by the Verse server every minute, and served at `GET /api/verse/budget/history`. The weekly
  cards draw the whole window from it.
- The Claude card shows its full weekly window on a 0–100% axis, with the even-pace line, projection and the 40%
  reserve. The chart places Claude's reset, which Claude gives only in words ("Sep 25 at 6:59pm
  (America/New_York)"), on the axis. It does this only for that exact form and only when the time falls within
  one window of now; otherwise the words stay words.
- Needs-you rows read like sentences: "Patch · Claude run", a title that ends on a whole word, "2 files · +384 −0",
  "Test-and-repair loop" rather than "TITRR", and "38 days ago".

### Fleet

- "Why this seat" is one short sentence plus a held-back list. Reasons are structured on the server, so no more
  ".;" joins and no raw ISO times. "Eligible again" shows the actual reopening time: a reset, "when you switch
  autonomy on", or Claude's own words.
- Lane chips read "Local · off", with the shared reason shown once.
- "Fleet dark since" has one server definition: the last sign of fleet life, set only while the fleet is dark.
  Every surface uses it. Growth says "No fleet runs or proposals since …" when it means that.

### Chat

- **Composer:** a seat chip names the account and one picker names the model. Nothing truncates; at narrow widths
  the footer folds into icons and then into the ⋯ sheet. Effort shows only when the model supports it ("Effort:
  High"). The context ring matches the header's and its tooltip gives exact tokens and the compaction point.
- **Transcript:** a centred reading column. User turns are a quiet block on the right, and the assistant writes
  plain prose. Duration and failure links sit in a muted turn footer. File and tool rows show project-relative
  paths, with the full path on hover.
- **Chat list:** folder names as they are on disk, with an explained "!" badge and ↑/↓/Enter navigation. "Disconnect
  from hub" asks first, because it clears unsent drafts.

### Accounts, approvals and panels

- Every account row leads with its state ("Connected · usable now", "Spent · resets Sat 11:46 PM · usable again
  in 1d 7h", "Signed out · reconnect to use it"), orders usable accounts first, and has a zero-cost **Check again**.
- One rule for percentages and one prose tidier across the Usage, Budget, Health, Autonomy, Context, Dock and Git
  panels. Raw ISO times, absolute paths, ".;" joins, "1 repos", untruncatable pills and icon buttons with no
  tooltip are fixed throughout.

### Shell

- Only the current item in the left rail looks active. Each surface's data and code are warmed at idle after first
  paint, so first visits skip the skeleton.
- Keys pressed within a frame of opening the Settings menu no longer land on a different item from the highlighted
  one, and Escape returns focus to the gear.

### Hardening from review

Before release, an eight-lens review ran over the whole change, with skeptics verifying each finding. All confirmed
findings are fixed:

- **Capacity history:**
  - When it grows too large, compaction thins older readings per seat window instead of cutting every seat's first
    days, so each series keeps its full 8 days.
  - A Codex weekly-only window stays on its weekly line near its reset.
  - `ASHLR_CAPACITY_HISTORY=0` now stops every recorder.
  - The file is opened non-blocking, so a pipe at that path can't hang the server.
- **Composer:** focus stays put when you change a setting in the ⋯ sheet or when the footer folds, Esc still stops a
  turn, resizing never re-renders per pixel, and Send shows a sending state.
- **Warm-up:** it waits for a visible, idle window, steps aside while chat reads are in flight, and never refetches
  surfaces you haven't opened. Chat first paint stays at 367.1 KB, inside its 370 KB budget.
- **Charts:** a placeholder reset is shown as unknown, not as "Resets now" with a green verdict. Label widths follow
  the Display size setting. Heatmap digits and the funnel track meet contrast targets in both themes.
- **Dates:** day buckets on the Mind, Growth, Usage and Spend charts use your local calendar day. Time-dependent
  tests pass in every timezone and locale checked, and a test that would have failed on Sep 26 is fixed at the
  source.
- **Text:** the prose tidier no longer rewrites `..` inside paths or git ranges. Seat and model ids are shown by
  name. One percent rule ("<1%", never a rounded "100%") applies everywhere a used share is printed.
- **Accessibility:** the Disconnect warning, spoken diff stats, the header status chip and the icon-only mode picker
  are all announced or reachable by keyboard.

### Verification

Checked locally, since GitHub Actions is off:
- Build, both type-checks, eslint, the real-I/O lane, docs and the first-paint budget pass.
- 4,476 web tests pass. The Verse and chart suites also pass under America/Los_Angeles and Asia/Tokyo
  (2,382 tests each).
- The backend suite passes 29,454 tests. Its 22 failures are the files that already fail on 3.9.1, plus four
  load-timing flakes that pass when run on their own.
- Rust and Swift code are unchanged since 3.10.0.

## [3.10.0] — 2026-09-24 UTC — autonomy with custody, and a workbench you can live in

The fleet could propose but never finish: every change still waited on Mason, and the only way to let it merge
was a signing key an agent could read. 3.10 lets it merge on its own — inside a scope Mason signs with Touch
ID, on a budget that keeps his own usage his, with every merge remote, pinned, judged, watched and reversible.
Verse becomes the place to run that company and to work alongside it.

### Before you turn it on: the one-time `ashlr authority setup`

Autonomy ships **dormant**. Nothing merges, and no standing grant exists, until Mason runs the guided setup once.
`ashlr authority setup --dry-run` prints every step first; `setup` performs each one it can and **pauses only for
the steps marked ✋ below**, which no agent may do. It prints exactly what it did, and can be re-run safely.

1. ✋ **Install the custody helper:** `sudo scripts/install-custody.sh` (root-owned, in `/usr/local/libexec/`).
2. ✋ **Create the Secure Enclave key** (Touch ID). The private key never leaves this Mac's Secure Enclave.
3. ✋ **Compile the public key in.** Setup opens a PR adding it to `src/core/authority/trust-roots.ts`. Mason merges
   it, then `npm run build`, installs the release as usual, and kickstarts the daemon.
4. ✋ **Create the `ashlr-fleet` GitHub App** (one browser page) and **install it** on the enrolled repos (one more
   click). Its private key goes straight into the custody Keychain item; the PEM never touches disk.
5. ✋ **Store a Claude token:** run `claude setup-token` and paste it when asked. Only tool-less judge and Leader calls
   ever see it.
6. **Apply the rulesets** (`ashlr authority protect --print`, then `--apply`): required checks, no force-push or
   deletion, and bypass for Mason's admin role but never for the App.
7. **Create the canary** `ashlrai/fleet-canary` with its CI workflow, using Mason's own `gh` auth (the App cannot
   write workflows).
8. ✋ **Retire the old key.** Confirm moving `~/.ashlr/activation/` (the key agents could read since Aug 16) out of
   `~/.ashlr`; archive it offline, then delete it.
9. **Rotate the provenance HMAC key** (`ashlr authority rotate-provenance`); agents could read the old one.
10. ✋ **Sign the first grant** (Touch ID) and, optionally, set the switch to Autonomous. The grant starts on the
    shadow stage of its rollout ladder.

After that, the only recurring step is **one Touch ID every 30 days, or after a deploy that changes authority code**.

### Autonomy with custody

- **Only a signed grant raises authority.** A standing grant names the repos, engines, risk and size caps, spend
  ceiling and Leader classes; it is shown in full in the Touch ID prompt, bound to this Mac, and valid 30 days at
  most. Effective policy is the minimum of the grant, the config and compiled ceilings (medium risk, 10 files / 300
  lines, 24 merges per repo per day). Config and the Leader can only tighten it.
- **Lowering never asks.** Off / Propose / Autonomous goes down instantly; **Stop** writes `~/.ashlr/KILL`;
  **Revoke** requires a new grant to resume. Raising past the grant opens the Touch ID sheet.
- **One Touch ID starts the whole ramp.** The grant carries a rollout ladder (shadow → staged merge → full). The
  daemon advances a stage when the ledger shows its criteria met and drops back one stage on any breach; it can
  never pass the last stage Mason signed.
- **Every merge is remote and reversible.** The fleet works only in its own mirrors, never in Mason's checkouts.
  Changes pass the gates in order — authority, protected paths (to the owner lane, never auto-merged), tamper,
  scope, verify, claims, blast radius, a judge from a **different model family** than the producer, then GitHub's
  required checks — and merge on GitHub pinned to the head SHA with `Ashlr-Grant`, `Ashlr-Gates` and
  `Ashlr-Ledger-Head` trailers. For two hours after, CI and a fresh re-run watch the merge; a red one is reverted
  automatically and the repo quarantined.
- **Agents cannot touch authority.** While a grant is live, confinement is forced on: no keychain, launchctl, `open`
  or `osascript`, no reads of `~/.ashlr/authority`, read-only vendor homes, and daemon git with hooks and fsmonitor
  forced off. No confinement means no ticks.
- **One hash-chained ledger** records grants, switches, stops, gates, merges, reverts, holds and Leader actions. A
  broken chain halts everything until a new grant. `ashlr authority ledger verify` checks it.
- **Changed authority code pauses the grant** ("authority code changed — re-approve") until one Touch ID.

### Budget modes

- **all-in**, **balanced** (default) and **reserve**, with per-seat overrides in `~/.ashlr/budget.json`. Under
  balanced, Claude keeps 40 % of its weekly window for Mason and autonomy never touches it while the five-hour window
  is above 70 %; Grok keeps no reserve; local models are free and unlimited. Codex is off for autonomy until switched on.
- **Unknown usage is not headroom.** Autonomous Claude dispatch used to be allowed when its usage could not be read;
  it is now refused. Mason's own chats ignore reserves — the reserves exist for him.

### The Leader

- A planning agent that writes a daily memo — the bottleneck, one move with an expected result and a date, goals,
  standards, questions — from deterministic digests, never raw reasoning. It runs on Grok or a local model (Claude
  only for a weekly deep run inside the reserve), at most three times a day.
- **Class A** actions apply now and can be vetoed any time; **class B** after a 30-minute veto window (a
  spend-raising one never lands between 00:00 and 07:00 unless the mode is all-in); **class C** goes to Needs you.
  A veto runs the action's recorded inverse. Each move is graded after 7 days into a visible hit-rate.
- Harness changes are tested as paired experiments on held-out tasks with a confidence interval, adopted only through
  the gate, and rolled back automatically if a 48-hour canary falls below baseline.

### The workbench

- **Five surfaces:** ⌘1 Command, ⌘2 Fleet, ⌘3 Growth, ⌘4 Mind, ⌘5 Chat, plus a gear tray (Settings, Apps & Accounts,
  Usage, Shortcuts). Approvals became the **Needs-you drawer** (⌘J) with single-key triage. A **⌘K palette** reaches
  every chat, action, seat and project.
- **Chat:** activity groups fold tool calls; a chapter rail maps the session; the composer queues up to 3 turns while
  one runs, takes attachments, `@` files and `/` commands, and offers four permission modes (Plan, Accept edits,
  Auto, Bypass — red and confirmed per chat).
- **Dock:** a real **Terminal** (desktop app), a loopback **Preview** with sandboxed artifacts, and **Review** diffs
  with notes that draft into the composer. A **branch bar** commits, pushes, opens and merges pull requests.
- **Apps & Accounts** replaces the MCP section: accounts with health and reserves, desktop apps, ten terminal agents
  with their launch commands, local runtimes and MCP servers — one description of each seat instead of four.
- **Charts** for Command, Fleet, Growth and Mind: each has a table twin, a designed "Fleet dark since …" state and a
  hatched fill for unmeasured values.

### Live reasoning

Claude, Codex and Grok stream their reasoning into the chat as it happens, then collapse it to "Thought 12s, ~1.8k
tok". A live status line shows the current step, elapsed time and measured tokens per second. Reasoning is also
kept as data — scrubbed, local-only, 0600, text for 30 days and derived features for 180, never replayed into a
prompt — and mined into insights that feed Mind and the Leader.

### Health

A background sweep checks every seat every 10 minutes with status commands only and catches signed-out, exhausted
and expiring sessions and a CLI build that drifted from its pin. A seat that cannot run refuses the turn up front
(409 `seat-not-ready`, with the reason) instead of failing mid-turn; **Reconnect** opens the seat's own login.
Codex's `limitReached` flag now survives the evidence path, so an exhausted Codex seat reads as exhausted.

### Performance

| Path | Before | After |
|---|---|---|
| `/api/verse/control`, warm | 5.2–6.1 s | 2.9–4.1 ms |
| `/api/verse/usage-series`, warm | 1.3–3.4 s | 0.3–0.5 ms |
| Seat telemetry on every `/seats` and `/bootstrap` | 27–31 ms | 1.1–2.3 ms |
| Replay 5k / 10k chat events | 2.45 s / 17 s | 0.6–2.1 ms / 0.9–2.4 ms |
| Render per streamed delta at 5k events | 50 ms | 1.0–1.3 ms |
| Fonts at first paint | 658 KB | 98 KB |
| Static assets | 2.4 MB unencoded | 702 KB brotli, immutable |

First-chat-paint JavaScript fell from 615 KB to 366 KB, and `npm run check:first-paint` now fails the build above
370 KB. Not yet met: the 350 KB target, and the runtime probe still stalls the event loop 53–78 ms against a 20 ms
budget.

### Reliability

Streamed text is folded at turn end and chats resume from a sequence index; a lost or locked vendor conversation is
retried once on a fresh one seeded with the handoff note; a watchdog says so after 3 minutes of silence; crash
handlers interrupt running turns and reap their process groups; orphaned processes are killed only when their start
time and command line match what was recorded; a storage error stops the turn instead of the server.

### Desktop

The tray lists running chats, **Needs you…**, **New chat** and **Stop running chats…** — it may stop chats, never the
fleet. Banners for finished and failed chats, Needs-you items and seat health while the window is unfocused; a Dock
badge; and an opt-in ⌃⌥Space hotkey that summons Verse with the composer focused.

### Still to come (3.11)

Claude as a fleet producer (it judges and leads in 3.10, with no tools), per-tool "Ask" permission prompts, side
chats, split sessions, hunk staging and multi-seat compare.

### Verification

Run locally on this Mac (GitHub Actions is off): build, both type-checks, eslint (0 errors), the real-I/O lane,
docs, the first-paint budget, 4,011 web tests, 173 Rust tests and 32 Swift tests pass. The backend suite passes
except files that already fail on 3.9.1: release-policy pins, the north-star probe, `npm-cli-launch`, a leftover
Tauri build folder, and four Universe campaign-recovery files (8 tests).

## [3.9.1] — 2026-09-24 UTC — Claude usage stays visible after a re-pin

- **The Claude usage meter went blind on any seat re-pinned to Claude Code
  2.1.280** — the seat Opus 5.5 needs. The usage probe accepted exactly one
  build (2.1.257) and failed closed on every other, so the one seat nearest
  its weekly limit showed no percentages at all. It now accepts a list of
  VERIFIED builds (`CLAUDE_USAGE_VERIFIED_VERSIONS`: 2.1.257, 2.1.280). 2.1.280
  was verified the same two ways the original pin was: the binary defines
  `/usage` as a local, non-interactive command, and a live `-p /usage` run
  reported `num_turns: 0`, `total_cost_usd: 0` and parsed to the five-hour,
  weekly and weekly-Fable windows. Any other build still fails closed — an
  unverified build could route the slash command to a model.

## [3.9.0] — 2026-09-24 UTC — the context meter tells the truth, and long sessions have somewhere to go

The Verse context meter was wrong on every engine, in a different way each time,
and a session that was filling up had nowhere to go but a cold new chat. The
numbers below were read from the pinned CLI binaries, each seat's own model
catalog and every September Codex rollout on this machine; no paid model was
prompted to produce them. `docs/VERSE-CONTEXT.md` is the new authority for all of it.

### Behaviour change: new Claude chats compact at ≈367k, existing ones keep ≈967k

- **New Claude chats on a 1M model start in Standard** and compact at ≈367k
  (`--autocompact 400000`), not near 967k as every Claude chat did before.
  Expansive — the old full window — is one click away, and can be a seat's default.
- **Chats created before 3.9 keep the window they ran with.** A Claude chat with
  no recorded mode is marked **Expansive** the first time 3.9 loads it and runs
  with `--autocompact auto`, exactly as before, so upgrading compacts nothing and
  spends nothing. Codex, Grok, local and 200k-Claude chats from before 3.9 stay
  Standard, which is what they already ran at.
- **Switching a chat to Standard above ≈367k compacts it on the next turn.** The
  CLI then summarizes the whole context — on a paid seat that spends usage — and
  early turns survive only as that summary. The same holds for a Codex chat
  switched back from Expansive above 244.8k. Switching to Expansive is always
  free. The mode menu warns before you switch.

### Windows read from the CLIs, not assumed

- **Claude.** Six of the eight models run a **1M** window and compact near
  967k; Verse showed 200k for all of them, so a Fable session went red at 180k
  and then sat at 100 % while it grew to 967k — hiding exactly the range where
  every turn is most expensive. Each model now carries its real window, and the
  window the CLI reports at runtime (`result.modelUsage`) wins, which also
  catches the CLI dropping a session to 200k when long-context credit runs out.
- **"Opus 5.5" was running Opus 5.** Verse offered `claude-opus-5.5`; Claude
  Code's id parser rejects the dotted suffix and falls back to a substring match
  on `claude-opus-5`. The real id is `claude-opus-5-5`, which needs Claude Code
  2.1.280 — and the claude-a seat is pinned to 2.1.257. Opus 5.5 is now listed on
  that seat **disabled, with the reason** and the fix
  (`ashlr resources profile repin`, new in this release — below), rather than
  silently running a different model. Old sessions keep their recorded id, but
  their turns now ask for the real model, so on a seat that cannot run it the
  turn is refused up front (409 `VERSE_MODEL_UNAVAILABLE`, with the reason)
  instead of starting a CLI that would reject the id. A client that still sends
  `claude-opus-5.5` when creating a chat gets `claude-opus-5-5`.
- **Codex.** The CLI measures against 95 % of the window — 258,400, reported by
  every one of 151,715 rollout readings — and compacts near 244,800. Occupancy was
  the turn's *summed* input — a median 28.8× the real last-call prompt across 260
  recent turns — so the meter sat red on almost every turn. It now comes from the
  seat's own rollout — the last call's `last_token_usage.total_tokens`, the
  figure Codex itself compacts against, and the window the rollout reports —
  read every 2 s during a turn; until that is readable the figure is marked `≤`. The rollout also fixes per-turn usage: on `exec resume`,
  Codex's reported usage is the whole thread's running total, which Verse would
  have added again every turn (no Verse codex chat had run yet, so no stored
  total is wrong). Models come from each seat's own catalog, so hidden slugs are
  no longer offered.
- **Grok** is 500k compacting at 400k, not 256k — the meter read twice the real
  fill. Labels come from the catalog ("Grok 4.7 Fast"), and only its `.info`
  entries are read: the same file carries a per-model `api_key` field. Like
  Claude, the window Grok reports at runtime wins.
- **Local.** Claude Code assumes 200k for a model it does not know, so a local
  seat never compacted before a 64k runner overflowed. Verse now tells it the
  real window (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`), resolves that window from what
  the runner actually serves (llama-server's per-slot window on that lane,
  Ollama's own server default for unpinned tags — preferred over whatever
  context a resident runner was loaded with, since another app may have loaded
  it at 8k), and parses `-ctx64k` tags, which the old suffix pattern missed.
  Before every local turn the chat's stored window is refreshed from live
  discovery, so the window the CLI is told and the one the meter shows are the
  same, current number. Tags under a 56k window are listed disabled with the
  reason: after Claude Code's 33k reserve and its ~15k base prompt they would
  compact on every turn. The fleet's model catalog no longer
  tags the 64k local coder `long-context` (a capability defined as ≥ 100k), which
  had routed long-context work to a model that would overflow.
- Readings are stored **unclamped**: an overflow is information, and the old
  clamp erased it on disk.

### Compaction you can see

Native compactions become persisted `compaction` events — Claude and Grok from
`compact_boundary`, Codex from its rollout, sized from the readings just before
and after it — with a transcript divider ("Auto-compacted 967k → 19k in 1m 58s")
and a per-session count. The meter draws the whole window with a tick at the
compaction point and warns at 80 % / 95 % of **that point**. The old fixed
70 / 90 % of the window turned red only after Grok and Codex had already
compacted.

**Compact now** — in the chip beside the meter on every Claude and local session
(a "Context" chip where the model has no second mode), and in the handoff banner — sends `/compact` as an ordinary turn,
through the same gate as every turn, and the divider reads "Compacted on
request". It was verified headless on a local seat, where it is free but slow
(about 2½ minutes for a 15k context on a 27B model). **On a paid seat it spends
usage**: the CLI reads the whole context to write its summary.

### Standard and expansive context

A new chat on any Claude 1M model now compacts at ≈367k by default
(`--autocompact 400000`) instead of ≈967k (chats from before 3.9 keep ≈967k —
above). Each turn re-sends the whole conversation, and long-context
recall degrades with length on every published benchmark, so a session held
near 900k re-reads about 2.3× what one held under 400k does. **Expansive** mode
restores the full window — and on GPT-6 / GPT-5.6 raises Codex to its 872k
catalog maximum, passing `model_context_window` and
`model_auto_compact_token_limit` together (one without the other breaks Codex's
compaction). The mode is per session, applies from the next turn, can be a
seat's default, and exists only where it is real. Verse may suggest it; it never
switches it on. The menu's cost note is the ratio of the two compaction points
(≈2.6× on Claude, ≈3.2× on Codex). On Codex every Expansive surface also says
that GPT-5.6 requests above 272k reportedly count about 2× against plan limits
(one secondary source; GPT-6 Astra reportedly exempt) — if that holds, a turn
near the expansive limit counts nearer 6× a standard one.

### Continue in a fresh chat

A banner appears when a session nears its compaction point, has compacted twice,
or has sat idle past the prompt cache's lifetime with a large context. It builds
a handoff note from the session's own log — goal, latest asks, state, files,
commands, errors, `git diff --stat` per root — with no model call, lets you edit
it and pick any seat (a Claude chat can continue on Codex), creates the new
session for free and leaves the note in its composer. Nothing is sent until you
press send.

### Shared memory, fit, search, efficiency

- **Project memory:** one private directory per project under
  `~/.ashlr/verse/memory/`, shared by every seat, with a fixed instruction block
  that stays byte-identical across turns so the prompt cache survives. On by
  default, per-project opt-out, editable from the Resources panel. Claude and
  local seats get the directory with `--add-dir` and the block with
  `--append-system-prompt`; Codex through `-c` overrides (a writable root and
  `developer_instructions`), since `exec resume` takes no `--add-dir`. Grok, whose
  CLI can be granted nothing beyond its working directory, gets a read-only
  snapshot through `--rules`. **It is not free on a paid seat:** the block (up
  to 6 KB) rides in the system prompt of every turn of every new session —
  cached after the first turn, but cached tokens still count — and it asks the
  agent to read and update `MEMORY.md`, which is extra tool calls and output.
  Turn it off per project, or for every project, in the Resources panel.
  The editor shows the sanitized copy the API serves and says so; a save that
  would write `[REDACTED]` placeholders over real values is refused.
- **Context fit:** per-model verdicts — fits, tight, needs expansive, or split —
  for a folder or workspace, from `git ls-files` sizes, plus each engine's base
  prompt (local 15k, measured; Claude 25k, Codex 15k, Grok 20k, estimated), so
  a handoff note fits the 64k local seat while a whole repository shows split.
- **Session search** across past chats from the sidebar: a bounded keyword scan
  of Verse's own session store (newest 200 sessions, 20 MB of message text), with
  no index and no embeddings.
- **Efficiency:** cache-hit ratio, context per turn, compactions and an
  idle-cache warning, computed in the browser.

Memory aside, all of it is deterministic and spends nothing: the handoff
preview, context fit, search and the efficiency stats make no model call. The
only model calls remain the turns you send, through the same local-only-gated
chokepoint as before.

### Re-pin a seat to a newer CLI

`ashlr resources profile repin --directory <profile> --executable <binary>`
points an existing prepared native profile at another CLI binary — the fix the
claude-a seat's note names for Opus 5.5. It changes only the pinned executable
(the launcher's one `const profile=` line and `profile.json`) and refuses a
profile that is not unmodified `prepare` output. `--dry-run` checks everything
and writes nothing. A real repin first saves `launcher.mjs`, `profile.json` and
`command.json` as `.prev` files — one rollback set; restoring all three restores
the old pin. Re-running an interrupted repin finishes it, repinning to the
current binary reports `unchanged`, and failures say whether the profile
changed. It does not check sign-in: run `ashlr resources launcher check`
afterwards. The command ships in the built CLI, so it needs `npm run build` in a
source checkout.

### For API clients

- New routes under `/api/verse`: `POST /sessions/:id/context-mode`,
  `POST /sessions/:id/handoff-preview`, `GET`/`POST /preferences`,
  `GET /context-fit`, `GET /search`, `GET`/`POST /memory`. None starts a model
  call. `handoff-preview` is a POST because it runs `git`, so like every POST it
  answers 404 on a read-only server.
- `POST /sessions` is now strict: an unknown key is a 400, and `workspaceName` is
  refused (the server fills it from `workspaceId`). New sessions always carry
  `memoryEnabled`, `false` when memory is off for the project.
- The new GETs reject unknown or duplicated query parameters; `context-fit`
  takes `extraRoots` repeated once per root, because a comma is legal in a path.
- `POST /memory` content is capped at 64 KiB; that route alone accepts a body
  of up to 2 × 64 KiB + 8 KiB so a full-size file survives JSON escaping. It
  answers 409 `VERSE_MEMORY_REDACTED` when the content holds more `[REDACTED]`
  placeholders than the file on disk, and `GET`/`POST /memory` responses carry
  `contentSanitized: true` whenever the content sent is not the file's bytes.
- New sessions always record `contextMode` (`'standard'` included); an absent
  key marks a pre-3.9 record (resolved as above).
- New persisted events `compaction` and `context`; `context` may carry
  `contextWindowSource` (absent = `runtime`), so a catalog budget written after
  a mode switch is not shown as a measurement. `VERSE_HANDOFF_SUMMARY_REQUEST`
  (`types.ts`) is the fixed "summarize first" turn. The full additive contract
  is in `docs/VERSE-CONTRACT-V1.md`.

### Hygiene

- `eslint.config.js` ignores `.claude/**`. Agent worktrees there produced about
  98k lint errors, which made `npm run lint` — and so `prepublishOnly` — fail on
  this machine.
- Two release-truth test pins that asserted superseded facts (npm provenance,
  removed on purpose in `e24a7dae`, and the pre-rewrite desktop README) now
  assert the current policy.

## [3.8.0] — 2026-09-23 UTC — local-only actually prevents spend

Two gates that make a promise the UI was already making. Both landed after the
3.7.0 tag, so 3.7.0 shipped with local-only leaking in two places.

### The Verse chat gate

The Local-only panel said *"Nothing can spend money while this is on"* and
*"cloud engines are unreachable"*. That was **false for Verse chat sessions**:
`session-engine.ts` spawned the seat CLI with raw `child_process.spawn` and
imported nothing from `policy/`, so an interactive Claude, Codex or Grok turn
still ran and still spent.

The daemon path was gated at seven chokepoints, and a structural test enumerated
them — which is exactly why this survived. The test listed every chokepoint
except this one, so the gap looked audited. Verse is now chokepoint 13, with a
test asserting the gate sits inside `startTurn` *before* the `spawn(`.

### Locality is not the same claim as spend

`local-only.ts` answered one question — local or cloud — that was used to decide
two: where inference runs, and whether something can bill you. Its purpose is the
second. For every subject except CLI agents the answers coincide. For `ashlrcode`
they did not: it is a local **process** whose inference is cloud by default, and
`sandboxed-engine.ts` hands every cli-agent spawn `CLAUDE_CODE_OAUTH_TOKEN` /
`ANTHROPIC_AUTH_TOKEN` plus the config dirs where subscription auth lives.

Measured before the change: `enginePermitted('ashlrcode')`, `binPermitted('ac')`
and `binPermitted('aw')` all **permitted** under local-only, and
`estCostUsd('ashlrcode', 1M, 1M)` was **$18**.

`Meteredness = 'free' | 'metered' | 'unknown'` now sits beside `EngineLocality`,
which is unchanged — local-fleet membership, pool tiering and local-context
injection all legitimately want "runs on this machine". **Local-only refuses
anything not provably free, including `unknown`**: a spend policy cannot treat
"I can't tell" as safe, which is how this survived. `estCostUsd` keys on
meteredness, never locality, and does not report $0 for a metered agent — zero
would be worse than wrong, because a wrong number invites scrutiny and a zero
ends it.

`ashlrcode` is `metered` by decision: its repo has not moved in three months and
Qwen3.8 now drives the local lane, so refusing it under local-only costs nothing.
`aw` is `unknown` rather than `metered` — its cloud fallback is opt-in, but that
opt-in lives in aw's own config which the hub never reads, and asserting
otherwise would be the same error mirrored.

Three assertions in `local-only-policy.test.ts` had been **defending the bug** as
expected behaviour. They were green on master.

### Known residual

`forceLocalOnly` — the autonomy director's cost-*pressure* switch — is a
different mechanism from `cfg.foundry.localOnly` and still allows `ashlrcode`.
Closing it is a decision about what the director should do when it is trying to
save money rather than forbid spending it. See `docs/LOCALITY-VS-SPEND.md`.

## [3.7.0] — 2026-09-23 UTC — The console you can actually navigate, and a fleet that can be bounded

### Verse

- **The rail expands** (⌘\), with labels and ⌘-digits. Hover used to show the
  *native browser tooltip* — unstyled, mouse-only, clipping against the sidebar.
  There is now a real portalled Tooltip primitive, and adopting it fixed a live
  accessibility defect: `aria-describedby` sat on a wrapper rather than the
  focusable child, so nothing was ever announced. A **disabled** trigger emits no
  pointer events, so its tooltip could never open — precisely the tooltip that
  matters, since it explains why the control is disabled.
- **The header earns its height.** It held one toggle floating at the right edge
  with nothing anchoring the left, because the sidebar toggle only rendered while
  the sidebar was collapsed.
- **Display size** — Default / Large / Extra large, scaling type *and* spacing as
  a multiplier rather than a second table of literals, because density and scale
  have identical CSS specificity and two literal tables would let file order
  decide what "Compact + Large" means. Rail width and strip height are pinned so
  the traffic-light clearance cannot regress.
- **Pane resizing** that survives a real drag: widths are a desired/effective
  pair, so a wide sidebar narrows on a small window and springs back. It also
  turned out the resize handle was eating 4px of the macOS window drag strip.
- **Saved projects and a native folder picker**, and the MCP section is mounted.

### Autonomy

- **A bounded run window** — until paused, at a wall-clock time, or after N
  iterations. The window is an absolute instant, never a countdown, so a host
  suspended at 01:00 and opened at 09:00 finds its 07:00 window expired.
- **The post-merge halt.** The pre-merge gate was already strict; *nothing re-ran
  the suite after a merge*, so a regression merged at 01:00 compounded all night.
  A dirty working tree halts too, as **unprovable** rather than *regressed* — a
  run that measured uncommitted edits has proven nothing. Ignored files are not
  dirt, or it would halt every night.

### Corrections

- A test guard was red, and a red guard protects nothing. The Anthropic shim is a
  request normaliser, not a transport — its one `/chat/completions` is in a doc
  comment recording a measurement.
- `VerseApp.test.tsx` had been passing by luck of file ordering; the first test to
  mount the shell paid ChatSection's cold transform cost inside its own 1000ms
  assertion window.

## [3.6.0] — 2026-09-23 UTC — Open any project, from a real picker

Verse could already drive any folder on the machine — the API accepted an
unenrolled path and both Grok and local seats ran in it. What it could not do was
let you *choose* one. The only way in was typing an absolute path into a text
box, and a folder you typed vanished from the list until a chat existed on it.
This release is the door.

### Any folder, from a native chooser

- **A real macOS directory picker.** "Choose folder…" opens `NSOpenPanel`
  through the Tauri dialog plugin. Detection is a call-time feature probe of the
  injected shell global, not a build flag, because the same bundle is served
  inside the desktop app and as a plain web UI — in a browser the button is
  absent and the absolute-path input remains, which is never removed.
- **Saved projects the console can actually create.** `createVerseWorkspace`,
  `updateVerseWorkspace`, `deleteVerseWorkspace`, `setVerseRootPriority` and
  `setVerseFocusSection` all existed with **zero callers**, so
  `~/.ashlr/verse/workspaces.json` could only be written by hand. There is now a
  Projects section in the sidebar: save, rename, add and remove folders, reorder
  (the first folder is the primary — its directory is the chat's working
  directory), and forget behind a two-step confirm that states existing chats
  are untouched.
- **Interactive and autonomous stay separate registries.** Saving a folder to
  work in never enrols it for unattended work. A saved project can be *offered*
  to the autonomous lane, but only by ticking that box.
- **The Grok caveat travels with a saved project.** Grok takes no extra roots,
  so a multi-root project picked with a Grok seat now says its extra folders are
  unreachable. That case previously had no warning at all.

### The MCP section exists again

`McpSection.tsx` was complete — query layer, tested contract, complete server
side — and unreachable: absent from `VERSE_SECTIONS`, no `'mcp'` member on
`VerseSectionId`, and outside the glob that mounts sections. It is now ⌘6.
⌘1–⌘5 keep their meanings.

It also discloses a footgun nothing named before: Codex and Grok inherit MCP
from their native profile config, so a turn on an unenrolled folder can reach an
`ashlr__*` write tool and be refused by the enrollment gate — the turn fails on
policy, not on the model. Claude and local seats are unaffected, because the
adapter passes an empty `--mcp-config` under `--strict-mcp-config`.

### One capability was widened, deliberately

`dialog:allow-open` is granted to the remote Verse origin in
`capabilities/verse-remote.json`, whose note said not to widen the list. It is
the narrowest dialog permission: it shows a chooser the user must confirm and
returns a path, reads no file contents, and no `fs:*` permission is granted
anywhere in the app. `allow-save`, `allow-message`, `allow-ask` and
`allow-confirm` stay ungranted so page code cannot forge a native prompt.

It had to go in that file rather than `main.json`: the Verse window loads a
remote origin, and a Tauri 2 capability without a `remote` block never reaches
one — the grant would have looked correct in review and failed silently at
runtime.

### Verified in the built app, not only in tests

The picker was driven end to end in a real build: the button renders inside the
shell, `NSOpenPanel` opens, the chosen path lands in the field, "Start chat"
enables, "Save as a project" persists and appears in the sidebar, and forget
removes it. Separately, `POST /api/verse/workspaces` was confirmed against a
live server to create a record on disk and list it back.

## [3.5.1] — 2026-09-23 UTC — The dependency backlog, landed rather than deferred

Four dependency PRs had been sitting open. None was a version bump; each needed
real work, and that is why they had not landed.

- **`marked` 17 → 18, and the audit policy digest moves with it.** marked 17
  read the two tildes in a line like ``~24 bits of `Math.random` …
  `~/.ashlr/swarms/<id>.json` `` as GFM strikethrough, which swallowed the
  backticks between them and left `<id>` exposed as an inline HTML token. The
  external-skill audit's raw-HTML gate then fired and the whole document lost
  section credit. One file in 120 of this repository's own docs flips, and it is
  a false positive being corrected — a code span outranks an emphasis run that
  would cross it. The parser is part of the signed policy, so the digest moves
  with it, and a test now pins the code-span behaviour directly rather than
  leaving it implied by a version string.
- **Four dev dependencies upgraded, three held with reasons.** `vite` 6 → 8,
  `@types/node` 22 → 26, `@vitejs/plugin-react` 4 → 6,
  `@testing-library/jest-dom` 6 → 7. TypeScript 7 is blocked upstream —
  `typescript-eslint` peers on `>=4.8.4 <6.1.0`, so npm cannot resolve the tree
  at all. ESLint 10 adds 173 errors from three newly-recommended rules, and
  jsdom 30 changes accessible role/name computation. Each hold is recorded in
  `dependabot.yml` with the condition that lifts it, so the group stops
  regenerating weekly in a state that cannot install or cannot pass.
- **Raycast: `@raycast/api` 2, and the flat-config migration it requires.**
  `@raycast/eslint-config` 2.x exports a flat config array; passing that through
  the existing `FlatCompat` wrapper throws *Converting circular structure to
  JSON*. `ray build` compiles all seven entry points again.

### Reasoning effort, settled on multi-step work

`config.ts` had asked for this battery explicitly: the earlier numbers came from
single tool calls, which say nothing about multi-step debugging. 5 agentic tasks
× 3 efforts × 3 trials, plus a long-horizon arm:

| arm | pass | mean decode | total wall |
|---|---|---|---|
| xhigh (ships today) | 15/15 | 1582 | 4208s |
| **medium** | 15/15 | **766 — 2.07× fewer** | **2545s** |
| low | 15/15 | 1061 — 1.49× fewer | 2657s |

The ladder is not monotonic: `medium` beats `low` on decode *and* wall-clock, on
5 of 6 tasks, because `low` under-thinks per turn and pays it back in extra
tool-calling round trips. The shipped default does not move — every arm went
15/15, so quality is *bounded*, not measured, and a sub-20-point regression
would have been invisible. Operators wanting the 2× set
`models.llamaServer.agentDefaults.reasoningEffort` to `"medium"`.

### Repository

62 open pull requests → 0.

## [3.5.0] — 2026-09-22 UTC — Ashlr Verse: the operator console, and a local model that keeps working

Verse becomes the surface you drive the fleet from, and the local lane becomes
usable rather than a demo. Published as 3.5.0 the same day as 3.4.0 because the
work below landed after that tag, not because 3.4.0 was wrong.

### Verse

- **Multi-folder workspaces** with sections and explicit priority, so one Verse
  window drives several repositories instead of one checkout.
- **MCP panel** — shows which MCP servers each seat would actually load, rather
  than what is configured somewhere and may or may not apply.
- **GitHub panel** that states what a PR approval will do before you click it,
  and no longer blocks the server on `gh` when it is missing.
- **Collapsible resources panel**, with a separate usage bar per limit instead
  of one bar averaging limits that reset on different clocks.
- **Titlebar inset** so the macOS traffic lights never sit on top of the UI.
- Model catalogs carry every model each provider currently serves — including
  Opus 5.5 and Fable 5.1 on the Claude seats.

### The local lane

- **The Anthropic-compatible proxy is a committed, supervised process** rather
  than a scratch script — the shim that normalizes Claude Code's requests for
  the local model's chat template now has an owner and a lifecycle.
- **Prefix caching actually works.** The shim used to fold per-turn counters
  ahead of the whole conversation, invalidating the cache every turn: 23,500
  prompt tokens reprocessed per turn became 34–556. Four parallel agents went
  from 1386s to 540s.
- **Reasoning effort is reachable**, and `/metrics` is on.
- **`local-eval`** — a 6-task harness that answers whether a harness change
  helped, with a number, against a recorded baseline.
- **A timed-out trial now says why it timed out.** The `api-migration`
  timeouts were not a hang: every traced trial ended `generating-at-cutoff`,
  still emitting tokens when the kill landed. Unbudgeted, the same task
  finishes correctly at 898s against a 900s limit.

### Corrections

Two published claims were wrong and are corrected in source, docs and on the
site rather than quietly dropped:

- The local model is **Q8_0, 27 GiB** — not four-bit, as was published.
- **Raising the context window is not free.** The measurement behind that claim
  compared a warm process to a cold one; at 64 KiB/token the real cost is about
  +8 GiB. Retracted where it was stated.

### Repository

- 406 remote branches → 179; 62 open PRs → 4. The 55 closed were unreviewed
  fleet drafts aged 35–64 days, closed as stale rather than rejected, with every
  branch kept and each one indexed in `docs/PR-TRIAGE-2026-09.md`.
- The README and the repository homepage point at
  [verse.ashlr.ai](https://verse.ashlr.ai), which they did not.

## [3.4.0] — 2026-09-22 UTC — Governed agent-native engineering OS

- Integrates the default-off Agent OS control plane, execution identity,
  observation sandbox, bounded stream custody, and operator-facing fleet
  surfaces as the next development line after 3.3.2.
- Keeps the dedicated 3.3.2 release and promotion workflows frozen to their
  immutable package, tag, and rollback identities. Those workflows are not a
  publication lane for 3.4.0; a separate reviewed successor release contract
  is required before this development line can be tagged or published.

## [3.3.2] — 2026-09-05 UTC — Safe successor after the failed immutable 3.3.1 release attempt

- Carries forward the reviewed fail-closed runtime and operator-console closure
  prepared for 3.3.1, plus the deterministic trajectory-fixture clock repair
  merged at protected revision
  `d6c1a5ec3626f715018a8ffb929906ac0f52f5c9`. That exact protected revision is
  the required first-parent rollback for the 3.3.2 release merge.
- Preserves the failed lightweight `v3.3.1` tag at
  `f2c9353db35fbf12889bddafd8acc2b7ca5ae67c` and its failed release workflow
  run `32396250683`, attempt 1. npm version 3.3.1 and its GitHub Release remain
  absent; the tag, version, run, and absence must never be rewritten, rerun,
  published, or reused.
- Published from protected merge
  `2971c9f767c934e12fd056bf8c6dca5164ffe7d2` through successful release run
  `33932333902`, while preserving the immutable public 3.3.0 predecessor as
  quarantined incident evidence at its exact package integrity and tag.
- After isolated acceptance and successful observation-only admission run
  `33933861238`, npm `latest` and `candidate` both resolve to 3.3.2. This
  distribution state does not install or activate a runtime, enable a resident
  service, configure providers or credentials, or authorize spend.

## [3.3.1] — 2026-08-18 — Fail-closed runtime boundaries and emergency neutralization of the quarantined 3.3.0 candidate

- Restores the hostile-reviewed, fail-closed authority and web-security tree
  after an unsafe 3.3.0 candidate was merged and published concurrently. The
  immutable 3.3.0 package and lightweight tag remain preserved for provenance,
  but 3.3.0 must never move to npm `latest` or be installed or activated as the
  production runtime. npm `latest` remains 3.0.1.
- Compiled daemon and conductor trust roots are empty; resident-start,
  service-install, and host-merge authority remain dormant. Post-merge credit
  and learning signals stay report-only. This restores exact
  session revocation and operator-truth safeguards; and breaks the cold-import
  post-merge-credit ESM cycle without widening the public API or operational
  learning authority.
- Restores the operator-console security boundary: session-bound and expiry-bound
  SSE with exact logout revocation, descriptor-bound static reads, strict
  CSP/security headers, and stable bounded public error responses.
- The source-neutralization merge itself was intentionally not a release. The
  protected lightweight `v3.3.1` tag remains fixed at
  `f2c9353db35fbf12889bddafd8acc2b7ca5ae67c`; release workflow run
  `32396250683`, attempt 1, failed during native verification. Every downstream
  release stage—the signed canary, prepare, npm publish, publication
  verification, and GitHub Release—was skipped. npm version 3.3.1 and its
  GitHub Release remain absent. The tag and reserved version must not be moved,
  reused, published, or promoted; 3.3.2 is the sole successor lane.

## [3.3.0] — 2026-08-17 — Fleet activation, autonomous merge, and the operator console

### 2026-08-16 — Fleet activation unblocked, autonomous merge wired, learning loop closed

Nine threads landed together: the daemon activation-authority system that had
been unconditionally denying itself was replaced with a real granted-scope
check, and the bug that made it self-invalidate every permit was fixed; the
previously dead-code autonomous-merge revocation protocol got its first
caller; the fleet's self-improvement loop went from recording zero lessons on
rejection to recording them from every rejection; a test-isolation escape that
had corrupted the operator's real `~/.ashlr/daemon.json` for 11 days was
closed fail-closed; and a new React operator console shipped alongside the
untouched legacy dashboard. Milestone-level detail and today's newly
discovered ID collision are in
[`docs/MILESTONE-INDEX.md`](docs/MILESTONE-INDEX.md); the mechanics of
turning any of this on — including four non-obvious gates that block
unattended activation even after a grant — are in
[`docs/RUNTIME-FLEET-ACTIVATION.md`](docs/RUNTIME-FLEET-ACTIVATION.md).

- **Daemon activation authority replaces its own denials (M470 — see
  collision note below).** Five hard-coded refusals — `DAEMON_ACTIVATION_TRUST_ROOTS`
  frozen empty, `liveConductorActivationAuthorized()` returning a literal
  `false`, `assertResidentServiceInstallAuthorized()` throwing
  unconditionally, and two more in the same family — are replaced by a real
  check against an operator-owned trust-root store (`~/.ashlr/activation/`,
  0700/0600, owner-checked, fail-closed on missing/malformed to the
  *identical* prior denial) and Ed25519-signed, expiring, revocable standing
  grants across nine scopes: `once`, `resident`, `residentStanding`,
  `conductor`, `automerge`, `repair`, `deploy`, `install`, `proposalOnly`
  (`src/core/daemon/activation-permit.ts:121-131`). `residentStanding` is
  new — the scope that lets the daemon restart unattended; it is not implied
  by `resident` and must be granted explicitly.

  Root-cause bug fixed in the same change: `daemonActivationAuthorityStateDigest()`
  folded `~/.ashlr`'s own directory mtime into the digest a permit is
  checked against, but `daemon start`'s `acquireDaemonLock()`
  (`src/core/daemon/state.ts`) creates `~/.ashlr/daemon.lock` — a new direct
  child of `~/.ashlr` — *before* the permit is ever consumed, bumping that
  same mtime. Every freshly minted permit self-invalidated, 100%
  reproducibly, before it could be used — the fleet could never have
  activated unattended even with a valid grant. Fixed to key the digest on
  the directory's `dev`+`ino` instead, which survive ordinary child churn
  (`src/core/daemon/activation-permit.ts:961-997`).

  **ID collision introduced today:** `test/m470.activation-authority.test.ts`
  reuses milestone number M470, which was already assigned to the
  already-shipped "proposal capture candidate identity"
  (`test/m470.proposal-capture-candidate-identity.test.ts`; see the M464–M503
  entry below). Recorded as a new row in `docs/MILESTONE-INDEX.md` §2.

- **Autonomous PR merge gets its first caller (M504, M505).** The durable
  merge-revocation protocol (`src/core/autonomy/host-merge-revocation-protocol.ts`)
  existed with zero callers before today; it is now invoked from
  `attemptHostAutoMerge()` (`src/core/merge.ts:2845-2901`), gated behind
  `foundry.autoMerge.hostAutoMerge`, which **defaults to `false`**
  (`src/core/merge.ts:2795`; `test/m505.host-auto-merge.test.ts` pins the
  default-off behavior). A `failureCategory`
  (`'code' | 'tool' | 'timeout' | 'infra' | 'cancelled' | 'invalid-command'`,
  `src/core/run/verify-commands.ts:86-92`) is now threaded through
  verify-commands, verify, run-tests, merge, the detached post-merge
  runner/verification, the regression sentinel, and self-heal — exit 127
  (missing binary) now classifies as `'tool'`, not a broken diff. `git apply
  --3way` is now used in both `verifyProposal` and `attemptHostAutoMerge`
  (`src/core/merge.ts:2313, 2984`) so a stale base no longer reads as a real
  conflict. The self-eval parity gate — previously a single flaky
  invariant-test failure was a GLOBAL merge blocker — now retries up to
  `SELF_EVAL_PARITY_RETRY_ATTEMPTS = 2` times with a 500ms delay before
  failing (`src/core/merge.ts:265-267`).

- **Learning loop closed; judge parse failures stop posing as verdicts.**
  `hasReleasedPostMergeCredit()` (`src/core/fleet/post-merge-credit.ts:137-150`)
  no longer hardcodes `false` — it verifies an HMAC-signed, timing-safe-compared
  token — unblocking consumers across `learned-router.ts`,
  `skill-attestation.ts`, `feedback.ts`, `quality-metrics.ts`,
  `judge-trace.ts`, and `post-merge-credit.ts` itself. `learnFromRejection`
  is no longer reachable only when auto-merge is on: a new
  `sweepRejectionLearning()` (`src/core/fleet/self-improve.ts`) reads the
  decisions ledger directly and learns from rejections regardless of the
  auto-merge flag. (The commit message cites 672 rejections the fleet had
  never learned from while auto-merge defaulted off; that figure is the
  author's estimate, not a value stored or checked anywhere in `src/` or
  `test/` — do not repeat it as a verified count.) `curateAntiPlaybooks()`
  (`src/core/fleet/self-improve.ts:284-322`), previously unreferenced, now
  has a caller in `src/core/fleet/orchestrator.ts:1338`. Separately, a July
  refactor had given every real judge verdict a reason code but not the
  parse-failure fallback — parse failures were structurally indistinguishable
  from considered reviews and incremented `judgeNonShipCount`, pushing good
  proposals toward auto-archive. Parse failures now get their own
  `'judge-parse-failure'` reason code (`src/core/fleet/judge-decision-metadata.ts:20`)
  and are excluded from `judgeNonShipCount` entirely
  (`src/core/fleet/automerge-pass.ts:335-337`).

- **Test isolation: HOME escape closed fail-closed.** On 2026-08-05 a vitest
  run escaped HOME isolation and wrote the operator's real
  `~/.ashlr/daemon.json`, leaving the daemon unstartable for 11 days. Cause:
  `test/setup/home.ts` fell back to the real `os.homedir()` whenever
  `process.env.HOME` was unset — fail-open. It now throws immediately if
  `HOME` is unset or resolves to the real developer home
  (`test/setup/home.ts:52-65`).

- **Fleet-status cache correction.** `GET /api/fleet` no longer performs
  API-side response recomposition (`src/core/web/api.ts`, pinned by
  `test/build-identity.test.ts`) — a response-shape fix, landed today. The
  shared TTL cache for `buildFleetStatus()`
  (`src/core/web/fleet-status-cache.ts`: 5s TTL, stale-while-refresh to 60s,
  in-flight dedup) landed with the new console earlier this week, not today.
  **The "32.5s cold → 4.0s cold / 0ms warm" figures reported for this work do
  not appear anywhere in the code, tests, or the cache module's own
  documentation and could not be verified — do not repeat them.** The cache
  module's comment instead cites a worse pre-fix baseline (`/api/snapshot`
  2.4s idle → 69.4s under load; `/api/control` similarly degraded). Call-site
  count is also imprecise across sources: the cache module's comment says
  six, a test comment says seven, a source grep finds eleven — the true
  count depends on what "independent call site" means and isn't settled.

- **New operator console (`src/web-ui/`).** React 19 + Vite 6, served at
  `/next/` alongside the untouched legacy vanilla-JS SPA at `/`
  (`vite.config.web.ts:11-26`, `src/core/web/static.ts:87-88`). **16 views**
  (not the 13 originally reported), a chart layer
  (`src/web-ui/components/charts/`), a work journal
  (`src/web-ui/routes/journal/`), live run streaming
  (`src/web-ui/components/stream/`, `useRunStream.ts`), and a notification
  centre (`src/web-ui/components/notifications/`). Backend changes were
  minimal and additive — query-param filtering on `src/core/web/api.ts` for
  the inbox history view — not a rewrite; `server.ts`/`static.ts` routing is
  unchanged.

- **Two activation designs now formally coexist; the guard protecting the
  boundary between them was strengthened, not weakened.**
  `conductor-permit` (`src/core/daemon/goal-conductor-permit-operator.ts`,
  offline cold-custody, used by the goal conductor — M516–M518) and
  `activation` (`src/core/daemon/activation-permit.ts`, on-machine standing
  grants, M470 above) are separate modules with non-overlapping imports. The
  test protecting this boundary used to check that a file
  (`src/cli/activation.ts`) did not exist by name — a check that would have
  broken the moment that file needed to exist for a legitimate, unrelated
  reason. It now asserts the real invariant: the daemon activation CLI's
  source text must not match any conductor-authority symbol name
  (`test/m518.goal-conductor-permit-operator.test.ts:924-926`) — conductor
  authority must be unreachable from the daemon surface, not merely absent
  from a filename.

### 2026-08-16 — Live-data web UI crash and TITRR proposal-quality fixes

- **`/work/swarms` crashed on real fleet data; a route error boundary now
  contains that class of bug.** `SwarmsView` and `SwarmDetailView` read
  `sw.plan.tasks.length` and `sw.usage.tokensIn` unguarded; two of eighty real
  swarm records (legacy smoke-test runs) carry neither field, so the view
  threw, React unmounted the root, and the screen went blank with no recovery
  short of a hard reload. Both reads are now guarded, and a new
  `RouteErrorBoundary` (`src/web-ui/components/primitives/RouteErrorBoundary.tsx`)
  wraps the route outlet so a failing view renders an inline error card with
  retry while the sidebar, topbar, and command palette stay alive — the
  durable fix; the optional chaining is the specific one.
- **Crushed tables got their column widths back.** The inbox proposal table
  had no fixed layout, so auto-layout divided space evenly across seven
  columns and crushed `Title` to roughly one word per line. The same pattern
  — traced to the Fleet Dashboard's Recent Runs panel, which `DESIGN.md`
  names as the reference other views copy — also affected Runs' goal column,
  where a single multi-paragraph prompt could balloon one row past the
  viewport. All three (`src/web-ui/routes/inbox/ProposalList.tsx`,
  `src/web-ui/routes/fleet-dashboard/RunsPanel.tsx`,
  `src/web-ui/routes/work/runs/RunsView.tsx`) now use fixed layout with
  explicit column widths and a shared two-line clamp utility. GenomeView's
  plain "Loading…" text was also swapped for the SkeletonRow convention used
  everywhere else, noticeable because that endpoint takes ~6s for 2014
  entries.
- **TITRR stopped filing proposals it already knew had failed verification.**
  `TITRR_MAX_ATTEMPTS` was hardcoded to 2 ("1 initial + 1 repair"); on
  exhausting it with tests still failing, the loop unconditionally filed the
  diff anyway via `captureTitrrProposal({isPartial:true,
  forceGateBlockReason})` — the root cause of `[partial]` proposals that
  could never pass verification, and, per the fix commit's own estimate (not
  a value stored or checked anywhere in `src/` or `test/` — do not repeat it
  as a verified count), a large share of the 672 proposals the fleet had
  never merged. `TITRR_MAX_ATTEMPTS` is raised to 4, and exhaustion now drops
  with no proposal at all rather than filing an unverifiable one; the
  annotation is kept on the run for audit but nothing reaches the inbox.

### M464–M503 — daemon durability, post-merge verification pipeline, Mission OS extensions

Forty milestones landed on `master` with no CHANGELOG entry; this backfills
them by theme. Full per-milestone detail, file:line citations, and the four
that warrant a standalone contract are indexed in
[`docs/MILESTONE-INDEX.md`](docs/MILESTONE-INDEX.md) §5. Gaps M474, M483,
M489, M499, M500 have no corresponding test file or milestone.

- **Daemon crash-safety and recovery (M486, M487, M490, M501, M488, M476).**
  Daemon accounting writes now cross an fsync power-loss barrier (temp write +
  fsync, rename, directory fsync) before being reported durable (M486). A new
  authorized quarantine flow hard-links crash-suspect daemon state into
  immutable evidence with a signed receipt and a 10-minute plan expiry (M487),
  and a paired resolution flow consumes that receipt to produce fresh state
  that conservatively carries forward same-day spend accounting when it can
  be verified (never silently resets a daily budget to zero), refusing while
  service activity or execution retries are in flight (M501). Both are wired into the CLI as explicit, authorization-gated
  subcommands (`recover-state` / `resolve-state`, M490). Runtime-release
  canary/rollback pairs get an observation-only signature and digest check
  with no deployment authority (M488). Release-tip observations are recorded
  in an immutable, HMAC-sealed, no-clobber sequence ledger — not a
  transparency log or release authority (M476).

- **Detached post-merge verification pipeline (M465, M466, M467, M468, M472,
  M478, M482).** Auto-merge canary promotion readiness is evaluated
  observation-only against verification coverage, release evidence, and
  post-merge cohorts — it never grants activation (M465). Diff scope for
  auto-merge is measured with fail-closed rejection of symlinks, gitlinks,
  and malformed patch headers, alongside a durable prepared→armed→revoked
  host-merge cancellation state machine (M466). Post-merge verification
  cohorts are recorded as signed, immutable, metadata-only records —
  explicitly excluding prompts, diffs, and command output — and can neither
  authorize merge nor rollback (M467). A runner checks out one exact commit
  into a scratch worktree, runs the repo's own verification profile, and
  records only bounded pass/fail metadata before cleanup (M468), scheduled by
  an observation-only orchestrator that emits at most one work ticket per
  invocation (M472). Root verification contracts are detected read-only from
  each repo's own manifests (`package.json`, `tsconfig.json`,
  `vitest.config.ts`, …) without ever spawning a package manager (M478).
  Release artifacts get a dependency-inventory + manifest-integrity contract
  with hard size caps (M482).

- **Proposal funnel + capture identity (M464, M469, M470, M471, M473,
  M475).** Agent work lifecycle transitions are now recorded as a
  metadata-only, cryptographically-chained audit trail with a closed
  vocabulary of phases/transitions/triggers — no raw prompts, diffs, or file
  paths (M464). Proposal-funnel metrics (attempts, capture errors, policy
  suppressions, gate blocks) are scrubbed before aggregation and withheld on
  unstable snapshots rather than guessed (M469). Proposal capture now binds a
  durable candidate identity from sandboxed execution (M470), settled through
  a transactional claim/settle/reconcile task store with compare-and-swap
  leases (M471). A new verifier-execution-authority layer admits signed,
  data-only capsule statements against caller-pinned trust policies (M473),
  gated by a separate crypto-only policy-approval observation that itself
  signs, persists, or executes nothing (M475).

- **Mission OS extensions (M485, M491, M492, M493, M494, M495, M496, M497,
  M502).** The mission compiler reconciles goals from briefings — respecting
  dependencies, active-goal caps, and human gates, rejecting cycles — behind
  a read-only operator briefing UI (M485). Ecosystem-wide mission graphs
  compile deterministically into one cycle-checked, digested structure bounded
  to 24 nodes (M491), projected through a fail-closed, mutation-free "outcome
  room" view (M492). Mission state can now be captured into a signed,
  durable observation receipt carrying no execution authority (M493), and a
  shadow reconciler suggests — but never creates — up to 16 candidate goals
  per preview, verified against that receipt (M494). External ecosystem
  inputs (Cortex mission candidates, Locus identity evidence) get bounded,
  fail-closed-on-expiry validation schemas that import no authority (M495).
  Mission observations are captured only from authenticated, realized-merge
  proposals (M496), and both the read-only shadow observer (M502) and its
  CLI entry point (`vision shadow`, M497) prove the whole planning loop can
  run end-to-end with zero effect.

- **Supply-chain and dashboard hardening (M477, M480, M481, M479, M498,
  M503, M484).** Public JSON payloads are scrubbed of secret-shaped strings
  and home-directory paths and de-recursed before they reach the dashboard or
  API (M477). The dashboard's mobile shell keeps navigation in one
  horizontally-scrollable row (M480). Every action in every CI workflow is
  now pinned to a reviewed immutable commit (M481), and the npm release
  workflow additionally validates the release tag's target commit is in
  protected `master` history before `npm publish --provenance` runs (M479).
  Best-of-N's `-n` CLI flag is validated before config or model loading —
  rejecting non-integers, floats, zero, negative, and unsafe-integer values
  with exit code 2 (M498). The dashboard gained a read-only auth mode that
  permits SSE and reads but blocks all mutating endpoints (M503). PR stack
  topology (linearity, dependency correctness, convergence declarations) is
  now shadow-observed read-only against GitHub with no mutation capability
  (M484).

## [3.2.7] — 2026-08-16 — Immutable candidate supersession

- Carries forward the immutable 3.2.6 candidate and all subsequently merged
  protected-source improvements. npm `latest` remains 3.0.1; this release is a
  candidate for isolated provenance and acceptance testing, not a production
  promotion or resident-runtime activation.
- Changes registry admission from first-candidate publication to an exact
  successor transition. Immediately before the sole OIDC publish command, the
  workflow requires `candidate=3.2.6`, `latest=3.0.1`, the published 3.2.6
  integrity `sha512-b8O5Nxfb9IfYsmgSW80CAYW+3ZPlet8u7NALOfG8XGFnAAEWxvLtbLKer3psNg7rxkDrAt+rhUjzRzri72PFkA==`,
  the unchanged lightweight `v3.2.6` tag at
  `80d49d718d893d0cb02f85a62cd9d2691f4f39c3`, and absence of 3.2.7.
- After publication, verification requires the new 3.2.7 SRI and provenance,
  the old 3.2.6 version and integrity to remain intact, `candidate=3.2.7`, and
  `latest=3.0.1`. It removes `candidate` from canonical before and after
  dist-tag maps and requires every other tag to match exactly.
- Preserves one script-disabled tarball publish, attempt-bound artifacts,
  signed-canary `NO_AUTHORITY`, protected-master/tag admission, explicit
  `npm-release` approval, provenance verification, and GitHub prerelease
  gates. The workflow contains no dist-tag editing, unpublish, deprecate,
  retagging, second publish, install-pointer, daemon, or activation effect.

## [3.2.6] — 2026-08-16 — Canonical publisher-path recovery

- For candidate evaluators upgrading from public npm `latest` 3.0.1, this
  remains the first package containing the unreleased 3.1.0 through 3.2.5
  series. Their detailed product, security, and authority notes remain in the
  corresponding changelog sections below.
- Carries forward the complete 3.2.5 candidate payload and adds only the
  publisher package-spec repair: the prepared artifact root is canonicalized
  and constrained to the job workspace, its manifest-selected tarball is
  exported as a canonical absolute filesystem path, and the sole privileged
  publish step revalidates that exact regular, non-symlink, single-link file
  before passing it to npm. A Linux regression executes the exact publisher
  shell against a fake npm binary and proves relative paths cannot reach npm.
- Keeps the artifact hashes, SRI, archive inventory, protected-master and tag
  admission, sole OIDC job, trusted-publisher environment approval,
  candidate-only dist-tag, provenance verification, preserved npm `latest`,
  and GitHub prerelease gates unchanged. Resident activation and automatic
  production effects remain unavailable.
- The protected `v3.2.5` tag remains immutable at
  `dd5d5f8fa25cbebd395a31971cf1e8d78c0195db`. Release run `31934899656`,
  attempt 1, passed all nine native verification jobs, the signed no-authority
  canary, unprivileged prepare, and privileged registry admission. After the
  exact npm-release deployment was approved, npm interpreted the unprefixed
  relative tarball operand as GitHub shorthand and its SSH lookup failed before
  a registry publication request. Publication verification and GitHub Release
  creation were skipped, and no 3.2.5 package was published.

## [3.2.5] — 2026-08-16 — Pack-report root recovery

- For candidate evaluators upgrading from public npm `latest` 3.0.1, this
  remains the first package containing the unreleased 3.1.0 through 3.2.4
  series. Their detailed product, security, and authority notes remain in the
  corresponding changelog sections below.
- Carries forward the complete 3.2.4 candidate payload and adds only the
  publisher artifact-verifier repair: the two pack-report aggregate predicates
  now address npm's required one-element JSON array through `.[0].files`, and a
  regression executes the extracted predicate against that real report shape.
- Keeps strict script-disabled preparation, exact build and artifact identity,
  signed-canary `NO_AUTHORITY`, explicit npm-release approval, candidate-only
  publication, preserved npm `latest`, provenance verification, and GitHub
  prerelease gates unchanged. Resident activation and automatic production
  effects remain unavailable.
- The protected `v3.2.4` tag remains immutable at
  `f29c116a7eab20bbf20bb77dbebebecbea2ba337`. Release run `31931284428`
  passed all nine native verification jobs, the signed no-authority canary, and
  unprivileged prepare. After the exact npm-release deployment was approved,
  the privileged artifact verifier failed because two aggregate predicates
  addressed npm's one-element pack-report array as an object. Registry
  admission and `npm publish` never ran; publication verification and GitHub
  Release creation were skipped, and no 3.2.4 package was published.

## [3.2.4] — 2026-08-16 — Bounded release-prepare recovery

- For candidate evaluators upgrading from public npm `latest` 3.0.1, this
  remains the first package containing the unreleased 3.1.0 through 3.2.3
  series. Their detailed product, security, and authority notes remain in the
  corresponding changelog sections below.
- Carries forward the complete 3.2.3 candidate payload and adds only the
  release-prepare policy repair: the exact-tag reusable verification gate's
  exhaustive three-shard suite is consumed as authoritative test evidence, and
  the redundant unsharded prepare-time suite invocation is removed. The
  package-level `prepublishOnly` guard remains intact for direct source-tree
  publication attempts.
- Keeps the explicit Node 24 build, exact build identity and clean-tree checks,
  strict script-disabled pack and artifact binding, signed-canary
  `NO_AUTHORITY`, npm-release approval, candidate-only publication, and npm
  `latest` baseline unchanged. Resident activation and automatic production
  effects remain unavailable.
- The protected `v3.2.3` tag remains immutable at its original commit. Release
  run `31926786319` passed all nine native verification jobs and the signed
  no-authority canary, then the unprivileged prepare job's duplicate unsharded
  test pass reached its bounded runtime cap before packing, artifact upload, or
  any deployment request. npm publication, publication verification, and
  GitHub Release creation were skipped, and no 3.2.3 package was published.

## [3.2.3] — 2026-08-16 — GitHub API admission compatibility recovery

- For candidate evaluators upgrading from public npm `latest` 3.0.1, this
  remains the first package containing the unreleased 3.1.0 through 3.2.2
  series. Their detailed product and authority notes remain in the corresponding
  changelog sections below.
- Carries forward the complete 3.2.2 candidate payload and adds only the release
  admission compatibility repair: seven unsupported `gh api --fail` flags are
  removed while shell-fatal API failures and all protected-branch, ancestry,
  tag-identity, and response-schema checks remain fail-closed.
- Keeps signed-canary `NO_AUTHORITY`, explicit environment approval, candidate-
  only publication, and the npm `latest` baseline unchanged. Resident activation
  and automatic production effects remain unavailable.
- The protected `v3.2.2` tag remains immutable at its original commit. Release
  run `31923285323` passed all nine native verification jobs and the signed
  no-authority canary, then stopped at the first unprivileged prepare admission
  because the runner rejected the unsupported flag. Dependency installation,
  build, packing, npm publication, verification, and GitHub Release creation did
  not run, and no 3.2.2 package was published.

## [3.2.2] — 2026-08-15 — Portable signed-canary recovery

- For candidate evaluators upgrading from public npm `latest` 3.0.1, this
  remains the first package containing the unreleased 3.1.0, 3.2.0, and 3.2.1
  series. Their detailed product and authority notes remain in the corresponding
  changelog sections below.
- Carries forward the complete 3.2.1 candidate payload and adds only the
  signed-canary archive-mode repair: Git archive headers are bound to portable
  0644/0755 modes, while the private 0700 observation pipeline temporarily uses
  umask 022 and always restores its caller's restrictive umask.
- Keeps the strict dependency-inventory verifier and all `NO_AUTHORITY` release
  boundaries unchanged. Resident activation, automatic production effects, and
  npm `latest` promotion remain unavailable.
- The protected `v3.2.1` tag remains immutable at its original commit. Release
  run `31920010042` passed all nine native verification jobs, then stopped at
  the signed no-authority canary because npm pack reported non-portable modes;
  preparation, npm publication, verification, and GitHub Release creation never
  ran, and no 3.2.1 package was published.

## [3.2.1] — 2026-08-15 — Verified candidate release recovery

- For candidate evaluators upgrading from public npm `latest` 3.0.1, this is
  the first package containing the unreleased 3.1.0 and 3.2.0 series. Their
  detailed notes remain in this repository's 3.1.0 and 3.2.0 changelog sections.
- Supersedes the unpublished `v3.2.0` release attempt, carries forward the 3.2.0
  release notes, and packages the protected-master changes that landed after
  that tag was prepared.
- Adds fail-closed daemon-state quarantine and recovery, stronger Locus fleet
  enrollment/session evidence, authenticated dashboard health boundaries, and
  bounded dispatch-production diagnostics.
- Adds preventive model-call token reservations, verified protected-PR handoff,
  signed no-authority release canaries, candidate-only trusted publication, and
  dormant native activation/handoff proofs. Resident activation, automatic
  production effects, and npm `latest` promotion remain unavailable.
- Updates dependency integrity enforcement and keeps the vulnerable Linux
  desktop release surface quarantined; the supported npm CLI and web surfaces
  remain cross-platform.
- Normalizes the pinned npm 11.19.0 toolchain used by the signed release canary
  and immutable candidate preparation so its runtime closure remains strictly
  symlink-free without weakening the dependency-inventory verifier.
- The protected `v3.2.0` tag remains immutable at its original commit. That run
  stopped at the signed no-authority canary before preparation, npm publication,
  or GitHub Release creation; no 3.2.0 package was published.

## [3.2.0] — 2026-08-09 — Mission OS and bounded agent efficiency

- **Best-of-N fan-out containment.** Configured and direct best-of-N candidate
  counts now fail closed for malformed values, clamp to a hard maximum of eight,
  and run producer and critic work through an order-preserving two-worker pool.
  One daemon slot can no longer expand into an unbounded `Promise.all` model
  burst because of a typo or hostile configuration value.

- **Mission OS planning and observation plane.** A bounded mission graph turns
  strategic briefings into dependency-ordered work for exact enrolled
  repositories plus explicit human gates. Read-only preview reports deterministic
  ready/held dispositions, while `vision approve` and `vision reconcile` remain
  separate, explicit planning mutations.
  - `vision shadow` captures complete briefing, enrollment, goal, and proposal
    source state in an immutable, host-HMAC-authenticated metadata receipt, then
    emits at most one deterministic zero-effect suggestion. Receipts and
    suggestions grant no dispatch, proposal, merge, release, deployment,
    publication, external-mutation, policy, learning, or budget authority.
  - Bounded Cortex mission-candidate and Locus evidence-envelope contracts
    validate future cross-system inputs without adding live connectors,
    credential handling, identity approval, business-outcome truth, or execution
    authority. `docs/MISSION-OS.md` documents the current operator workflow,
    privacy limits, source-quality holds, and production boundary.

- **Temporary resident-service authority restriction.** Production service
  install, reinstall, repair, restart, worker setup, and the service portion of
  first-run setup now fail closed at a shared deny-only boundary. Existing
  services retain status and uninstall. Compiled daemon and conductor trust
  roots are empty, so non-dry daemon/conductor execution remains dormant;
  owner-invoked `ashlr run`/`ashlr swarm` and daemon dry-run remain available.
  Both git and npm update channels block before code replacement
  for present, unknown, or running service state. Status now combines expected
  service-file and native-manager evidence into explicit `present`, `absent`, or
  `unknown` registration state; setup refusal occurs before all config/wizard
  mutation.

- **External-skill quarantine preview (M444/M446).** Audit reports now expose a
  version-2 portable tree digest, and a POSIX-only internal Git-object capture
  can bind that digest into inert, content-addressed private storage. The
  capture has no runtime consumer or execution/policy/promotion authority;
  Windows and authenticated custody remain explicitly withheld. Hostile bare
  repositories are byte-bounded before Git parsing; common-directory redirects,
  worktree-local/external config, and partial-clone/promisor settings are rejected.
- **External custody statement verification preview (M447).** A verifier-only
  Ed25519 protocol checks a retention-bounded statement against a caller-supplied
  policy over the exact M446 capture tuple. Hub owns no signing or policy-approval
  path, and successful verification authenticates neither custody nor live
  storage; every M446 blocker and all execution authority remain withheld.

- **v3 gate opened — Team Command Center spec.** `docs/SPEC-V3-TEAM.md`: the
  hand-written end-state spec for the team / multi-machine backbone (one team
  memory, shared approval inbox with owner-apply routing, coordinated
  daemons, team visibility) riding api.ashlr.ai under `/hub/v1/*`.
  Milestones M34–M40, thirteen new team safety invariants, registered as a
  living ashlr goal. ROADMAP and contracts README updated to point at it.

## [3.1.0] — 2026-07-06 — v5.1 Claude 5 Model Intelligence · v6 Verification-First (M320–M340)

The fleet routes by MEASURED per-model economics instead of static
Opus-everywhere heuristics, and shifts weight from generation to
verification. Every milestone flag-gated with byte-identical-off parity
suites; a 65-agent adversarial review loop ran until dry (19 confirmed
findings → 13 defects fixed pre-release).

- **Claude 5 routing (M320–M321):** Sonnet 5 (`claude-sonnet-5`) is the
  frontier generation workhorse; Fable 5 (`claude-fable-5`, Mythos-class) is
  the default judge + strategist with automatic per-call Opus 4.8 fallback on
  failure/refusal/empty — on every elite surface (judge, strategist,
  director, dialogue). `cfg.foundry.claude5 {enabled, fable}`; `enabled:false`
  is a byte-identical rollback. Merge-authority matching is
  spelling-variant-safe (`canonicalModelTag`).
- **Per-model ROI (M322):** judge calls record cost/tokens/latency + the
  ACTUAL answering model; `computeModelRoi` derives ship-rate, latency, and
  cost-per-merged-proposal with producer-attributed joins (a judged entry
  carries the judge's identity — attribution goes through the proposalId
  join).
- **Cost-aware learned routing (M323):** `cfg.foundry.modelGranularRouting`
  (default off) routes to the CHEAPEST model whose producer-attributed
  ship-rate clears the bar; never learns into a bad model; cold start is
  byte-identical static routing.
- **Verify-to-green (M331, completes M140):** the `run-tests` keystone
  best-of-N had imported since M170 now exists (activates tests-green
  candidate selection), plus a bounded same-worktree engine repair loop
  (`cfg.foundry.verifyToGreen`, re-captured + RE-SIGNED diff, repair spend
  booked).
- **Real-world outcomes (M332, completes M141):** the outcome watcher links
  `git revert`s and near-term follow-up fixes back onto judge traces
  (`reverted` / new `followed-up`), feeding judge calibration and learned
  routing with post-merge truth. Read-only on repos; 6h throttle.
- **Multi-model best-of-N (M333, completes M142):** race per-candidate
  engine/model specs (`bestOfNCandidates`) on one item; full-cost accounting
  (every candidate's billable spend counts — the old path booked only the
  winner); losers archived with provenance; per-candidate record stream.
- **Staged activation (M334):** gateway SHADOW mode (observe-only beside the
  legacy path; legacy always wins) + `divergenceStats()` exit criteria +
  `DaemonTick.durationMs` soak metric — the [CONTRACT-M334] program for
  flipping `fabric.gateway` / `concurrentDispatch` defaults.
- **Dashboard Models tab (M335):** `/api/models` — per-model ship rate,
  cost-per-merge, reverts/fixes, spend, latency, best-of-N win rates; live
  SSE refresh (quiet + throttled + stale-response guarded).
- **SWE-bench regression gate (M336, completes M143):**
  `ashlr eval swe-bench --gate [--baseline <report>]` exits 3 on a
  newly-broken task or resolve-rate drop; first run seeds the baseline —
  CI/cron-safe from day one.
- **Review-fleet hardening (M337–M339):** 13 defects found by the
  adversarial fleet and fixed pre-release — judge-telemetry staleness,
  outcome-watcher windowing + cross-day duplicates + same-day rewrite
  upgrade path, ROI double-counts, strategist Fable fallback, repair-spend
  booking, Models-tab race/flicker — each pinned by a regression test.
- **Config safety (M340):** unknown `foundry.*` keys now surface as
  effective-config warnings (a typo'd key silently disabled its feature);
  the JSON schema gained the missing v3/v4/v5 top-level blocks. Fixture
  time bombs in m26/m259 defused (relative dates / pinned clock).
- **Docs:** FOUNDRY-CONFIG.md sections for every new key; ROADMAP v5.1/v6
  entries; SPEC-V5 addendum; CONTRACT-M334.

## [3.0.1] — 2026-06-17 — presentation + polish

A patch release on top of 3.0.0 — no change to the engine, fleet, or safety
floor; refreshes the public face and hardens the release/test ergonomics.

- **docs:** README reworked as the ecosystem front door — npm badges, an "Ashlr
  ecosystem" table linking every sibling tool (phantom-secrets, ashlrcode,
  ashlr-stack, ashlr-plugin, binshield, ashlr-md, ashlr-workbench, ashlr-pulse)
  with how the hub leverages each, and an accurate v3/v4/v5 capability map (the
  prior copy still read "30 milestones").
- **cli:** `ashlr version` / `--version` / `-v` now print the package version
  (previously "Unknown command").
- **test/release:** deterministic publish gate — `prepublishOnly` runs the suite
  with `--no-file-parallelism` (new `test:serial` script); `h1`/`h8` assert the
  real `~/.ashlr` is byte-identical before/after (the actual isolation guarantee)
  rather than assuming it is empty; `m32` gets a realistic timeout. The full suite
  is now deterministically green on a developer machine with the daemon live.

## [3.0.0] — 2026-06-17 — v3-Weapon · v4-Foundry · v5-Open-Fleet (M41–M60)

A major leap: local models became an engineering weapon, then a fleet of
backends that builds and maintains the ecosystem autonomously — proposal-only,
trust-gated, contained. Same safety floor; zero new runtime deps.

### v3-Weapon (M41–M44)
- Adaptive, model-sized prompts; the sandboxed engineering tool surface
  (write/edit/bash confined to a worktree, diffs → inbox, never the live tree);
  the verify→repair loop; and `ashlr eval` proving the local uplift.

### v4-Foundry (M45–M49)
- `runEngineSandboxed`: run an external agent CLI inside a throwaway git
  worktree, sever git push, capture ONLY the scrubbed diff as a PENDING
  proposal, trust-tagged `{engineModel, engineTier}`.
- Backend router + rate/quota scheduler; the tiered-trust merge-to-`main` gate
  with HMAC-signed provenance (M47.1); the 24/7 fleet supervisor; the fleet
  control plane (`ashlr fleet status/pause/resume` + `#fleet` web view).

### v5-Open-Fleet (M50–M60)
- **M50** declarative engine registry (adding a backend is config-only) + a real
  OpenAI-compatible API client (Hermes, OpenCode, NVIDIA NIMs, Kimi K2.7 …);
  existing engines reproduce byte-identical argv.
- **M51** tri-tier trust (`local | mid | frontier`); authority never leaks
  upward (`frontier→main`, `mid→branch`, `local→proposal-only`).
- **M52** OS-level confinement (macOS `sandbox-exec` read-jail + egress gate)
  closing v4's read-residual.
- **M53** fleet intelligence — learned routing, budget-breach tier cascade,
  per-run cost-anomaly holds (all proposal-only).
- **M54** self-improving fleet — a never-weaken guard (refuses any diff that
  deletes/weakens a safety test) + a green-flag-off-AND-on self-eval harness.
- **M55** the conductor — `ashlr goal` + `ashlr loop` + Claude Code `/goal`
  `/loop`.
- **M56** `mid→branch` auto-apply (verified mid-tier opens a PR, never `main`),
  behind a separate default-off `midToBranch` flag.
- **M57** `cfg.foundry` example + `docs/FOUNDRY-CONFIG.md`.
- **M58/M60** two reference plugins (scanner + template) seeding the ecosystem.
- **M59** `ashlr fleet init` (config bootstrap) + typed `cfg.foundry.intelligence`.

### Safety
Everything can reach `main` — but only a frontier merge-authority model, fully
verified, with valid HMAC provenance. Auto-merge (main and mid→branch) is
DEFAULT OFF. Kill-switch (`~/.ashlr/KILL`) halts every backend.

---

## [2.2.0] — 2026-06-12 — v2.2 "Agent-Native Ecosystem" (M31–M33)

Makes ashlr's intelligence first-class INSIDE agent sessions — CLI-first, with
the MCP gateway as a second transport over the same capabilities. No safety
posture change: reads flow freely, writes stay append-only or proposal-only.

- **M31 — Agent-native surface.** The MCP gateway now serves 11 native
  `ashlr_*` tools (orient/ask/recall/learn/backlog/health/status/impact/
  pulse/inbox_list/inbox_propose) with structural safety classes
  (read / append / proposal), kill-switch gating on every write, secret
  scrubbing + 32KB caps on every result, and full `mcp:native-call` audit
  coverage. There is deliberately NO approve/apply tool — approval stays
  human-only via `ashlr inbox`. New `ashlr orient [--repo] [--json]`
  (composite session-start context), `ashlr docs --agent` (generated agent
  cheat sheet), `ashlr wire --claude-md` (CLAUDE.md snippet),
  `ashlr completions zsh|bash`, "did you mean" suggestions, and read-only
  `GET /api/orient|health|backlog|impact` web routes.
  `docs/contracts/CONTRACT-M31.md` · 6 new test files.

- **M32 — Living command center.** The web dashboard becomes a real control
  surface: `#inbox` view with approve/reject (gated identically to dispatch —
  routes 404 without `--allow-dispatch`, per-session token, applies only via
  `applyProposal`'s triple gate), `#daemon` view + live nav badge, and a
  dispatch panel with live cost preview. SSE gains `inbox`/`daemon` named
  events (metadata only — never diffs). New pre-flight cost estimator:
  `ashlr run|swarm "<goal>" --estimate` (p25/median/p75 tokens·cost·duration
  from history, confidence-tiered, budget-clamped; also a footer in swarm
  `--dry-run` and `GET /api/estimate`). Help reworked into topics:
  `ashlr help [<topic>] [--search <term>] [--all]`. Knowledge build shows a
  TTY progress line. Opt-in macOS desktop notification (+ webhook) when an
  unattended swarm files a PENDING proposal (`notify.desktop: true`;
  metadata only). `docs/contracts/CONTRACT-M32.md` · 5 new test files.

- **M33 — Ecosystem layer.** Plugins: third parties can contribute backlog
  scanners, project templates, model providers, and CLI commands from
  `~/.ashlr/plugins/<name>/` — DEFAULT-OFF (`plugins.enabled: []`),
  manifest-only discovery (no code executes until enabled), sha256 integrity
  pinning, capability declarations enforced, kill-switch gated, fully audited,
  with a least-privilege host API (frozen config projection, never secrets).
  `ashlr plugins list|info|enable|disable`, `ashlr x <name>`. Distribution:
  the package is now `@ashlr/hub` (public, npm provenance) with a tag-gated
  release pipeline (full CI verify → version/changelog gates → publish +
  GitHub release), a CI pack-smoke step keeping the exports map honest, and
  `ashlr update` channel awareness (git checkout vs npm install; npm installs
  only with `--yes`). Public API: curated `@ashlr/hub` / `./core` / `./types`
  / `./plugin` entry points (`applyProposal` deliberately unexported).
  `docs/contracts/CONTRACT-M33.md`, `docs/PLUGINS.md`, `docs/RELEASING.md`.

- **DX follow-ups.** `ashlr plugins init <name> [--capability k]` scaffolds a
  working plugin skeleton (every skeleton integration-proven to load and
  contribute); agent-contract conformance locks pin the OrientResult /
  RunEstimate shapes, the 11 native tool names + safety classes, and the
  AGENT_COMMANDS registry so shape drift fails a named test; public roadmap
  (`docs/ROADMAP.md`); CI made hermetic (doctor `which ashlr` shim,
  check-version argv precedence) — the suite is green on clean runners.

## [2.1.0] — 2026-06-11 — v2.1 "Harden & Prove" (H1–H8)

Takes v2 from *built + unit-tested* to **proven trustworthy**. Eight hardening
milestones, each a contracts-first agent workflow with a **test-validity**
adversarial lens (which repeatedly caught false-green stub tests and real bugs).
Every change is local-first and adds **no new outward capability** — v2.1 only
proves and hardens what v2 built. Disposable repos in isolated tmp HOMEs
throughout; the real portfolio was never touched. 40 commits · 3,374 tests.

- **H1 — End-to-end autonomous-chain harness (keystone).** A reusable
  disposable-repo / tmp-HOME testkit + an integration suite that drives the *real*
  chain (enroll → daemon tick → sandboxed swarm → pending proposal → approve →
  `applyProposal`) and proves the working tree stays byte-identical, the proposal
  is the only sink, and every gate holds. `test/helpers/h1-fixture.ts`.
- **H2 — Crash recovery & resumability.** Fault-injection: daemon-mid-tick and
  swarm-mid-run crashes recover with no double-spend, no orphaned sandboxes, no
  stuck proposals, clean resume, and a clean kill-switch race. Adds
  `sweepOrphanSandboxes`.
- **H3 — Concurrency & budget stress.** Proves the in-process caps hold under
  load; adds a monotonic `makeId` counter. **Honest finding:** under `parallel>1`
  the per-tick budget is a *bounded overshoot* (≤ (parallel-1)×per-item), not a
  hard cap — documented, not hidden.
- **H4 — Safety-invariant regression suite + `ashlr verify-safety`.** Turns all
  54 enumerated guards across 7 invariants into a permanent always-on suite
  (closing 12 previously-untested guards) plus a read-only self-check, so no
  future change can silently weaken a guarantee.
- **H5 — Sandbox lifecycle & leak hardening.** Wires the orphan sweep into daemon
  start (+ `ashlr sandbox gc`), adds a read-only daemon-state reconcile, env-gates
  the `allowAnyRepo` test hatch, and adds a sandbox disk cap. Found + fixed a
  live-worktree-removal bug.
- **H6 — Audit & observability completeness.** `enroll` / `unenroll` / `setKill`
  are now audited at the primitive; adds a read-only `ashlr audit` viewer; brings
  the two secret-scrub implementations to parity (+ a Stripe-token pattern).
- **H7 — Guided onboarding & preflight.** `ashlr preflight` (read-only readiness)
  + 5 new doctor probes, a guided `ashlr onboard` first-activation walkthrough,
  and one-command `ashlr onboard --rollback`. No new outward capability.
- **H8 — Reproducible demo + reliability docs + activation runbook.** `ashlr demo`
  runs the full chain on a disposable repo so you can watch it before trusting it
  (auto-cleans, never touches your portfolio, never applies); `docs/RELIABILITY.md`;
  the canonical README activation runbook; and a maintainability cleanup pass.

**Activation remains the operator's explicit gate** — enrollment ships empty and
nothing autonomous runs until you `ashlr enroll` a repo and approve proposals via
`ashlr inbox`. See `docs/RELIABILITY.md` and the README *Activation* section.

---

## [Unreleased] — M30: Cloud-Ready Seams v2 + Polish (CAPSTONE)

The Ashlr v2 capstone. Makes the team/multi-machine future a **drop-in** later
without a rewrite by defining clean **seam interfaces** for every v2 store — and
shipping **only the LOCAL side** now. Every seam has a working LOCAL impl (a thin
adapter over the existing module, zero behaviour change) and a GATED cloud stub
that THROWS a clear gated error if ever selected. **There is no config flag and
no code path that can activate a functional cloud backbone** — cloud/team is a
Mason gate (explicit opt-in, not implemented). Local-first, self-hostable,
nothing public. Generalises the M19 telemetry-sink seam pattern across the v2
stores without destabilising them.

### Added

- **`ashlr seams` / `ashlr seams status`** — read-only diagnostic that lists every
  v2 seam, its active implementation (`local`), and its cloud availability
  (`gated` for the seven v2 seams; `false` for the cited telemetry reference
  seam). `--json` emits the `SeamRegistry`; `--help` prints usage. Mutates
  nothing, makes no network connection, and instantiates no seam impl. Backed by
  `src/cli/seams.ts` (`cmdSeams`), mirroring `src/cli/health.ts`.

- **Seam layer** (`src/core/seams/`): one cohesive module per seam, each exposing
  the canonical four-part shape — INTERFACE, LOCAL impl (default, delegates 1:1 to
  the existing module), GATED cloud stub (every method throws before any I/O), and
  a `selectX(cfg)` selector (returns LOCAL by default; returns the throwing stub
  ONLY when a cloud endpoint is explicitly configured):
  - `RunSwarmStore` (`seams/run-swarm.ts`) — wraps `core/swarm/store.ts`
    (`listSwarms` / `loadSwarm` / `saveSwarm`).
  - `BacklogSource` (`seams/backlog.ts`) — wraps `core/portfolio/backlog.ts`
    (`loadBacklog` / `buildBacklog`).
  - `InboxStore` (`seams/inbox.ts`) — wraps `core/inbox/store.ts`
    (`listProposals` / `createProposal` / `loadProposal` / `setStatus` /
    `pendingCount`).
  - `DaemonCoordinator` (`seams/daemon-coordinator.ts`) — wraps
    `core/daemon/state.ts` (`loadDaemonState` / `saveDaemonState`); LOCAL is
    single-machine (lease is a no-op), cloud stub is a GATED multi-machine
    lease/lock.
  - `GenomeSync` (`seams/genome.ts`) — wraps `core/genome/store.ts`
    (`loadGenome` / `appendHubEntry` / `genomeHubHealth`).
  - `PortfolioSync` (`seams/portfolio.ts`) — wraps `core/quality/store.ts` +
    `core/dashboard.ts` (health snapshots + portfolio dashboard).
  - `IdentityProvider` (`seams/identity.ts`) — wraps
    `core/integrations/identity.ts` (`getIdentity`); LOCAL is the phantom probe,
    cloud stub is GATED team auth.
  - `TelemetrySink` (`core/observability/telemetry-sink.ts`, M19) — the CANONICAL
    reference seam. CITED via the registry, not duplicated. Its opt-in
    `OtlpHttpSink` is a real local-network sink, not a gated team backbone, so its
    `cloud` field is `false` (distinct from the seven `gated` v2 seams).

- **Seam types** (`src/core/seams/types.ts`, single-sourced): `SeamId`,
  `SeamImpl` (`'local' | 'gated'`), `SeamCloud` (`false | 'gated'` — NEVER `true`
  in M30), `SeamStatus`, `SeamRegistry`, and `SeamsConfig` (OPTIONAL per-seam
  `{ endpoint? }`). `CLOUD_GATED_MESSAGE` + `cloudGatedError(seam, method)` are the
  single canonical gated error, centralised so it is identical across seams and
  trivially assertable.

- **Seam registry** (`src/core/seams/registry.ts`, READ-ONLY): `buildSeamRegistry(cfg)`
  derives the full registry from the in-memory config + static descriptors —
  triggers NO I/O, instantiates NO seam impl, never touches disk/network, never
  throws. `seamsConfig(cfg)` reads the OPTIONAL `seams` block defensively via a cast
  over an optional property (so `AshlrConfig` is unmodified). `seamEndpoint(cfg, id)`
  returns the explicitly-configured endpoint for a gated seam, or `null` — a
  non-null result routes the selector to the GATED stub (which throws) and NEVER
  enables a functional backbone.

- **Barrel** (`src/core/seams/index.ts`) re-exporting the seam interfaces, selectors,
  registry, and types.

### Docs

- **`docs/SEAMS.md`** — documents the local-first + cloud-ready seam architecture,
  the canonical four-part seam pattern, each seam and the existing module it wraps,
  the Mason gate, the `ashlr seams` diagnostic, and the five hard safety invariants.

- **`README.md`** — adds the full v2 command surface (`ask`, `knowledge`,
  `reflect`, `health`, `goals`, `digest`, `daemon`, `inbox`, `backlog`, `enroll`,
  `seams`), a concise **"Ashlr v2 — Autonomous Engineering Organization"** section
  summarising M21–M30, and a clearly-marked **ACTIVATION RUNBOOK ("the human's
  gate")**: enroll real repos (`ashlr enroll add <repo>`) → run `ashlr daemon` →
  review and approve proposals via `ashlr inbox`. Emphasises that default
  enrollment is EMPTY and everything is proposal-only / sandboxed.

### Polish

- **CI** — `.github/workflows/ci.yml` extended to a Node `["20", "22"]` matrix,
  keeping typecheck / lint / build / test. Must stay green on both.

### Tests

- **`test/m30.seams.test.ts`** — hermetic invariant tests (in-memory config; never
  the real `~/.ashlr`, never the real portfolio, never a remote call): every cloud
  stub method throws `CLOUD_GATED_MESSAGE`; every selector returns the LOCAL impl on
  the default config; a configured endpoint routes to the throwing stub; the
  registry reports `allLocal` by default.

### Safety invariants (M30)

- **Interfaces + local only** — no functional cloud/team/remote implementation
  exists. Each cloud stub throws `cloudGatedError(...)` as the FIRST statement of
  every method, before any I/O; no `fetch`/http/socket/disk in any seam cloud stub.
- **No activation path** — selectors return LOCAL by default; a configured endpoint
  only routes to a throwing stub. There is no value of config that yields a
  functional cloud backbone, and no way for the autonomous loop/daemon to flip to
  cloud.
- **Non-regression** — zero edits to any wrapped store; local adapters delegate 1:1;
  the seam config is read via a cast over an OPTIONAL property so `AshlrConfig` is
  unmodified. All prior tests stay green.
- **Nothing public / self-hostable** — no outward action, no registration/telemetry/
  phone-home, no public flip. Docs state local-first + self-hostable + cloud-gated.
- **Bounded + no new deps** — `package.json` unchanged; only intra-repo imports; the
  registry maps a fixed 8-element descriptor list; read-only diagnostics.

---

## [Unreleased] — M25: Portfolio Intelligence (`ashlr knowledge` · `ashlr ask` · `ashlr impact`)

### Added

- **`ashlr knowledge build [--repo <path>]`** — build or incrementally refresh the local semantic knowledge index for all enrolled repos (or a single repo with `--repo`). Walks source files read-only, chunks them, embeds each chunk via local Ollama embeddings (keyword/TF-IDF fallback when no embedding model is available), and stores results to `~/.ashlr/knowledge/<repo-hash>/*.jsonl`. Incremental by mtime — only changed files are re-indexed.

- **`ashlr ask "<question>" [--repo <path>] [--allow-cloud]`** — local RAG Q&A across the indexed portfolio. Retrieves the top relevant chunks via embedding similarity or keyword scoring, synthesises a plain-language answer using the **local** model, and cites every source as `repo/file:line`. `--repo` scopes the search to a single enrolled repo. Cloud is structurally OFF by default — the local provider is used for both retrieval and synthesis; `--allow-cloud` is required to route synthesis to a cloud model AND only takes effect when a key is present.

- **`ashlr knowledge graph [--repo <path>]`** — build and print a lightweight cross-repo knowledge graph. Nodes are repos, modules, and key dependencies; edges are imports, depends-on, and shared-dep relationships. Cross-repo findings (same vulnerable/outdated dependency, duplicated patterns) are surfaced as `crossRepo` entries. Output is JSON-serialisable for downstream tooling.

- **`ashlr impact <file|symbol> [--repo <path>]`** — answer "what depends on this?" across the enrolled portfolio. Returns all references (repo, file, line) and a list of dependent repos/modules. Scoped to enrolled repos only; read-only analysis.

- **Knowledge index engine** (`src/core/knowledge/index.ts`):
  - `buildKnowledge(opts?)` — default `repos = listEnrolled()` (DEFAULT EMPTY → empty knowledge, no disk scan). Bounded: skips `node_modules/`, `.git/`, `dist/`, and binary files; enforces file-count and byte caps per repo; local embeddings via `getActiveClient()` from `core/genome/recall.ts`; keyword/TF-IDF fallback. Secret-scrubs chunks before storing (skips `.env`/key files; redacts secret-shaped tokens). Writes `~/.ashlr/knowledge/<repo-hash>/*.jsonl`.
  - `knowledgeDir()` — canonical store path (`~/.ashlr/knowledge/`).
  - `loadChunks(repo?)` — read stored chunks from disk; scoped to one repo when provided.

- **Ask engine** (`src/core/knowledge/ask.ts`):
  - `ask(question, { repo?, allowCloud })` — retrieve top chunks (embedding cosine or keyword TF-IDF), call local synthesis via `core/run/provider-client.ts` local provider, return `AskResult { question; answer; sources; method; local }`. `allowCloud` defaults to `false` at every call site; code-to-cloud on the default path is a guardrail violation.

- **Graph + impact engine** (`src/core/knowledge/graph.ts`):
  - `buildGraph(repos?)` — static import/dependency analysis; returns `KnowledgeGraph { nodes; edges; crossRepo }`. Cross-repo detection surfaces shared vulnerable/outdated deps and duplicated structural patterns.
  - `impact(target, repos?)` — file or symbol name → `ImpactResult { target; references; dependents }`. Read-only; enrollment-scoped.

- **CLI entry points**:
  - `src/cli/ask.ts` (`cmdAsk`) — backs `ashlr ask`; `--repo` and `--allow-cloud` flags; cloud OFF by default.
  - `src/cli/knowledge.ts` (`cmdKnowledge`) — backs `ashlr knowledge build | graph | impact`; delegates to core engines.

- **New types in `src/core/types.ts`** (all existing types unchanged):
  - `KnowledgeChunk { repo; file; startLine; endLine; text; vector?; summary? }`
  - `AskHit { chunk: KnowledgeChunk; score: number }`
  - `AskResult { question; answer; sources: {repo; file; line}[]; method: 'embedding'|'keyword'; local: boolean }`
  - `ImpactResult { target; references: {repo; file; line}[]; dependents: string[] }`
  - `KnowledgeGraph { nodes: {id; kind; label}[]; edges: {from; to; kind}[]; crossRepo: {kind; detail; repos}[] }`

### Guardrails (M25)

- **LOCAL-ONLY BY DEFAULT (privacy)**: indexing, ask synthesis, and embeddings all run on the local provider (Ollama via `getActiveClient()`). Repo code and chunks are **never sent to a cloud model** unless `--allow-cloud` is explicitly passed AND a cloud key is present. Both conditions must be true simultaneously. Sending code to cloud on the default path is a contract violation.
- **READ-ONLY**: `buildKnowledge`, `ask`, `buildGraph`, and `impact` never modify any enrolled repo. All writes are confined to `knowledgeDir()` (`~/.ashlr/knowledge/`). No `git` mutations, no installs, no project-script execution.
- **ENROLLMENT-SCOPED**: default repos = `listEnrolled()`. Default enrollment is empty — empty knowledge, no whole-portfolio disk scan. Only explicitly enrolled repos are ever indexed or queried.
- **BOUNDED**: file-count and byte caps per repo; skips `node_modules/`, `.git/`, `dist/`, and binary files; embedding calls subject to the same time/concurrency caps as genome recall.
- **NO SECRETS**: `.env` and key files are excluded from indexing. Secret-shaped tokens (high-entropy strings matching common key patterns) are redacted from chunks before storing, embedding, or citing. No secret values appear in `~/.ashlr/knowledge/` or in `ask` answers.
- All 2443 existing tests preserved. Typecheck passes clean (`tsc --noEmit`). No new runtime dependencies. Reuses `core/genome/recall.ts` (embeddings + `getActiveClient`), `core/sandbox/policy.ts` (`listEnrolled`, `isEnrolled`), `core/run/provider-client.ts` (local provider), `core/git.ts`, and `cli/ui.ts`.

---

## [Unreleased] — M24: The Autonomous Daemon (`ashlr daemon`)

### Added

- **`ashlr daemon` — the autonomous operator that makes the org continuous** (`src/core/daemon/state.ts`, `src/core/daemon/loop.ts`, `src/cli/daemon.ts`):
  - Pulls the highest-value backlog items for enrolled repos and dispatches sandboxed swarms whose output becomes PENDING proposals in the Approval Inbox. **It is proposal-only by construction — it has no path to apply, push, open a PR, or deploy.**
  - **`ashlr daemon start`** — begin the operator loop; ticks on an interval until stopped, daily budget is exhausted, or the kill switch is set.
  - **`ashlr daemon start --once`** — run exactly one tick and exit (ideal for cron or manual one-shot use).
  - **`ashlr daemon start --dry-run`** — plan only: shows which backlog items would be worked this tick; no swarm is dispatched, no proposal is created. Safe to run at any time.
  - **`ashlr daemon start --budget <usd>`** — override the daily budget cap for this session.
  - **`ashlr daemon start --interval <ms>`** — override the tick interval.
  - **`ashlr daemon start --parallel <n>`** — override the per-tick concurrency cap.
  - **`ashlr daemon stop`** — sets `~/.ashlr/KILL` and clears running state; all in-flight ticks halt at the next kill-switch check.
  - **`ashlr daemon status`** — running state, PID, last tick time, today's spend vs cap, items processed, pending proposals count.

- **Daemon state** (`src/core/daemon/state.ts`) — atomic, never-throws, day-reset-aware:
  - `daemonStatePath()` — `~/.ashlr/daemon.json`.
  - `loadDaemonState()` — returns a fresh zeroed `DaemonState` on missing or corrupt file; never throws.
  - `saveDaemonState(s)` — atomic write (temp file + rename), `mkdir -p` on first save.
  - `resetDayIfNeeded(s)` — zeroes `todaySpentUsd` and `itemsProcessed` when `todayDate` has rolled over; preserves all other state.

- **Daemon loop** (`src/core/daemon/loop.ts`) — ordered safety checks before any work is dispatched:
  - `tick(cfg, { dryRun })` — one operator cycle: kill-switch check → budget-exhausted check → enrolled-repos check → load/refresh backlog → select top-K items under per-tick + daily budget cap → (dry-run: log plan only; else: dispatch `runSwarm` with `opts.sandbox=true` + `opts.propose=true` at bounded concurrency) → record spend + audit + daemon state. Returns a `DaemonTick` summary.
  - `runDaemon(cfg, { once, dryRun })` — REFUSES (throws) if `ASHLR_IN_DAEMON` or `ASHLR_IN_SWARM` is set (fork-bomb guard); sets `ASHLR_IN_DAEMON=1` on child processes; `once=true` runs one tick; otherwise loops, re-checking kill switch and budget every iteration. No unbounded loop — exits cleanly on exhaustion or stop.
  - `stopDaemon()` — sets `~/.ashlr/KILL` + clears running state.

- **New types in `src/core/types.ts`** (all existing types unchanged):
  - `DaemonConfig { dailyBudgetUsd; perTickItems; parallel; intervalMs }` — caps only; grants no authority.
  - `DaemonTick { ts; itemsConsidered; proposalsCreated; spentUsd; reason }` — one tick summary record.
  - `DaemonState { running; pid; startedAt; lastTickAt; todayDate; todaySpentUsd; itemsProcessed; ticks }` — persisted daemon state.
  - `AshlrConfig.daemon?: Partial<DaemonConfig>` — optional per-installation caps override.
  - `DashboardSnapshot.daemon?: { running; todaySpentUsd; pendingProposals }` — optional; absent = not running.

- **Dashboard surface** (TUI + web) — `DashboardSnapshot.daemon` populated from `loadDaemonState()` + `pendingCount()`; read-only display of running state, today's spend, and pending proposal count.

### Guardrails (M24)

- **PROPOSAL-ONLY (grep-provable)**: the daemon code imports and calls ONLY `createProposal` (via `runSwarm opts.propose`) and `pendingCount` (read-only). It NEVER imports or calls `applyProposal`, `git push`, `gh pr create`, or any deploy/ship path. Every tick's output is a PENDING proposal in the Approval Inbox; applying it requires explicit human `ashlr inbox approve`.
- **ENROLLMENT-ONLY**: the daemon operates ONLY on `listEnrolled()` repos. Default enrollment is empty — if nothing is enrolled, the daemon idles and does nothing. It never scans or operates on the full 69-repo portfolio.
- **SANDBOXED**: all swarm work is dispatched with `opts.sandbox=true` (M21 git-worktree sandboxes). The user's working tree, current branch, index, and HEAD are never touched.
- **BOUNDED**: hard daily budget cap (default modest), per-tick item cap, and concurrency cap enforced on every tick. Budget resets per calendar day via `resetDayIfNeeded`. When exhausted the daemon idles or stops. No unbounded loop.
- **KILL SWITCH**: `~/.ashlr/KILL` is checked at the top of every tick. `ashlr daemon stop` sets it immediately. Cannot be bypassed.
- **RE-ENTRANCY GUARD**: `runDaemon` REFUSES to start if `ASHLR_IN_DAEMON=1` or `ASHLR_IN_SWARM=1` is set in the environment. Prevents daemon-inside-daemon and daemon-inside-swarm fork bombs. Respects the existing swarm recursion guard.
- All 2357 existing tests preserved. Typecheck passes clean (`tsc --noEmit`). No new runtime dependencies.

---

## [Unreleased] — M23: Approval Inbox (Single Outward Gate)

### Added
- **Approval Inbox — the single human control plane for all outward actions** (`src/core/inbox/store.ts`, `src/core/inbox/apply.ts`, `src/cli/inbox.ts`):
  - Every proposed outward action (patch, PR, deploy) is written as a `Proposal` to `~/.ashlr/inbox/<id>.json` before anything happens. Nothing outward occurs until you explicitly approve.
  - **`ashlr inbox`** — list all pending proposals with counts; shows id, kind, origin, title, and age.
  - **`ashlr inbox show <id>`** — full proposal detail including unified diff (for patch proposals) and summary.
  - **`ashlr inbox approve <id> [--yes]`** — the ONLY path that triggers outward action. Confirm-gated interactively (or bypass with `--yes`); marks the proposal `approved` then calls `applyProposal`. Nothing outward runs before this point.
  - **`ashlr inbox reject <id>`** — marks a proposal `rejected`; discards it. No outward action taken.
- **Proposal store** (`src/core/inbox/store.ts`) — atomic-write, never throws:
  - `createProposal(p)` — creates a fresh `Proposal` (status `'pending'`, timestamp, fresh id) and persists to `~/.ashlr/inbox/<id>.json`. **Does not apply anything.**
  - `listProposals(filter?)` — returns proposals newest-first; filter by status; read-only, never throws.
  - `loadProposal(id)` — returns a single proposal or `null`.
  - `setStatus(id, status, result?)` — persistence-only; sets `decidedAt` on approve/reject; **applies nothing**.
  - `pendingCount()` — count of pending proposals (used by dashboard snapshot and daily-digest).
- **Apply engine** (`src/core/inbox/apply.ts`) — the single outward funnel, heavily guarded:
  - `applyProposal(id, { confirmed })` — REFUSES (mutates nothing) unless proposal exists AND `status === 'approved'` AND `confirmed === true`. All three conditions are required simultaneously.
  - By kind: `'patch'` → applies the diff on a **NEW branch** (`BRANCH_PREFIX`) off HEAD in the target repo — **never touches the user's current branch, index, or working tree**; never force-pushes; never pushes at all (local only). `'pr'` → branch + commit then explicit M18 gated `createPr`. `'deploy'` → gated ship path. `'note'` → no-op record.
  - Enrollment-checked (`assertMayMutate`) and kill-switch-checked before any mutation. Every apply is audited. Status set to `'applied'` on success or `'failed'` on error.
  - Never throws — always returns `ApplyResult { ok, status, detail }`.
- **New types in `src/core/types.ts`** (all existing types unchanged):
  - `ProposalKind = 'patch' | 'pr' | 'deploy' | 'note'`
  - `ProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed'`
  - `Proposal { id; repo; origin: 'backlog'|'swarm'|'manual'; kind; title; summary; diff?; sandboxId?; status; createdAt; decidedAt?; result? }`
  - `ApplyResult { ok; status; detail }`
  - `DashboardSnapshot.inbox: { pending: number }` — pending count surfaced to dashboard and daily digest.
- **Surfaces**:
  - **TUI** — new Inbox tab (read-only view of pending proposals; approve via `ashlr inbox approve`). Pending count shown in Overview tab.
  - **Web dashboard** — Inbox section at `/inbox` (read-only list + detail); pending count in the snapshot header.
  - **Daily digest** — `inbox.pending` included in the dashboard snapshot for digest-ready consumption.

### Guardrails (M23)
- **PENDING NEVER AUTO-APPLIES.** `applyProposal` runs ONLY when `status === 'approved'` AND triggered by the explicit `inbox approve` command (confirm/`--yes`). Never on `createProposal`, never on list/show, never by any daemon or background process. This is structurally enforced — `applyProposal` checks all three conditions before touching anything.
- **Single outward funnel.** Every outward mutation in v2 (patch, PR, deploy) passes through `applyProposal`. There is no other path.
- **Patch on a new branch only.** `'patch'` kind applies to a new `ashlr/`-prefixed branch off HEAD via `git apply`. The user's working tree, current branch, and index are never touched. No `git reset --hard`, no checkout in the source repo, no push, no branch deletion of user branches.
- **PR via explicit gated path.** `'pr'` kind uses the M18 `createPr` which is itself confirm-gated and explicit — no auto-PR.
- **Enrollment + kill switch enforced on every apply.** `assertMayMutate` runs before any mutation; kill switch is checked first and cannot be bypassed.
- **No secrets in proposals.** `Proposal` fields and `~/.ashlr/inbox/` contain only metadata. No token values, env vars, prompt text, or secret names are ever written.
- No new runtime dependencies. All 2266 existing tests preserved. Typecheck passes clean (`tsc --noEmit`).

---

## [Unreleased] — M22: Work Discovery (`ashlr backlog`)

### Added
- **`ashlr backlog` — prioritized, scored work queue across enrolled repos** (`src/cli/backlog.ts`, `src/core/portfolio/backlog.ts`, `src/core/portfolio/scanners.ts`):
  - Aggregates open work items across all enrolled repos from six read-only sources: GitHub issues, TODO/FIXME/HACK/XXX code comments, CI/test state, outdated/vulnerable deps, docs health, and binshield security findings.
  - Each item is scored by `value / effort` heuristic (higher = do first) and persisted to `~/.ashlr/backlog.json`.
  - **`ashlr backlog`** — list the scored queue; flags: `--repo <path>` (single repo), `--source <issue|todo|test|dep|doc|security>` (filter by source), `--limit N` (top N), `--json` (machine-readable).
  - **`ashlr backlog refresh`** — re-scan all enrolled repos and rebuild the backlog.
- **Six read-only scanners** (`src/core/portfolio/scanners.ts`) — each returns `WorkItem[]`, bounded, never throws:
  - `scanIssues` — open GitHub issues via `gh` (M18 `listIssues`); skips repos without a GitHub remote.
  - `scanTodos` — TODO/FIXME/HACK/XXX comments in source via `rg`/`grep`; skips `node_modules/`, `.git/`, `dist/`; capped per-repo.
  - `scanTests` — CI state via `gh run list` (latest run); notes test-script presence heuristic; **never runs `npm test` or any project script**.
  - `scanDeps` — `npm outdated --json` (stale) + `npm audit --json` (vulnerability severity counts); bounded with timeouts; read-only metadata only.
  - `scanDocs` — heuristic checks: missing/thin README, missing LICENSE, missing CONTRIBUTING, low test-file presence.
  - `scanSecurity` — `binshield` findings if installed; skipped gracefully when absent.
- **Backlog engine** (`src/core/portfolio/backlog.ts`):
  - `buildBacklog(opts?)` — runs all scanners over `listEnrolled()` repos (default) or a provided subset; dedupes by id; sorts descending by score; persists to `~/.ashlr/backlog.json`.
  - `loadBacklog()` — reads the persisted backlog; returns `null` when absent.
  - `scoreItem(value, effort)` — pure `value/effort` heuristic, clamped, no side effects.
  - `backlogPath()` — `~/.ashlr/backlog.json`.
- **New types in `src/core/types.ts`** (all existing types unchanged):
  - `WorkSource = 'issue' | 'todo' | 'test' | 'dep' | 'doc' | 'security'`
  - `WorkItem { id; repo; source; title; detail; value(1-5); effort(1-5); score; tags; ts }` — one scored work item.
  - `Backlog { generatedAt; repos; items }` — persisted backlog shape.

### Guardrails (M22)
- **READ-ONLY**: scanners never modify any repo — no writes, no git mutations, no installs, no fixes. All subprocess calls use `execFile` with explicit arg arrays (no shell injection).
- **ENROLLMENT-SCOPED**: only repos returned by `listEnrolled()` are scanned. Default enrollment is empty → empty backlog. The scanner never walks the disk outside enrolled paths.
- **Bounded**: all scanners skip `node_modules/`, `.git/`, `dist/`; per-repo caps on file count and output size; `npm outdated`/`npm audit` run with timeouts. No project scripts (`npm test`, `npm run build`, etc.) are ever executed.
- **Never throws**: every scanner catches all errors and returns `[]`; a failing scanner never aborts the rest of the backlog build.
- **No secrets**: `WorkItem` fields and `~/.ashlr/backlog.json` contain only metadata (title, detail, score, tags). No token values, env vars, or secret names are written.
- No new runtime dependencies. All 2202 existing tests preserved. Typecheck passes clean (`tsc --noEmit`).

---

## [Unreleased] — M21: Safety Foundation (Sandboxed Execution, Audit Trail, Enrollment + Kill Switch)

### Added
- **Git-worktree sandbox** (`src/core/sandbox/worktree.ts`) — the isolation primitive all future autonomous work runs inside:
  - `createSandbox(sourceRepo, opts?)` — asserts enrollment + kill-switch gate, then runs `git worktree add -b ashlr/sandbox/<id>` under `~/.ashlr/sandboxes/<id>/` off the current HEAD. The source repo's working tree, index, HEAD, and user branches are **never touched**.
  - `sandboxDiff(sb)` — returns `SandboxDiff { sandboxId, files, insertions, deletions, patch }` via `git diff` against `baseHead`. Read-only; never mutates.
  - `removeSandbox(sb)` — `git worktree remove --force` + `git branch -D` on the scratch branch. Idempotent; never touches the source tree. All sandbox paths are forced under `~/.ashlr/sandboxes/`.
  - `sandboxesDir()` / `listSandboxes()` — path helper + persisted metadata listing; never throws on bad entries.
- **Append-only audit trail** (`src/core/sandbox/audit.ts`):
  - `audit(entry)` — sets `ts`, appends one JSONL line to `~/.ashlr/audit/<YYYY-MM-DD>.jsonl`. Never truncates, rewrites, or deletes. Malformed lines are skipped on read; never throws.
  - `readAudit(limit?)` — returns entries newest-first; `limit` caps count.
  - `auditDir()` — `~/.ashlr/audit`. **No secrets ever written** — summary is metadata only.
- **Enrollment registry + kill switch** (`src/core/sandbox/policy.ts`) — the gate every autonomous mutation passes through:
  - `isEnrolled(repo)` / `enroll(repo)` / `unenroll(repo)` / `listEnrolled()` — registry persisted in `cfg.autonomy` / `~/.ashlr/enrollment.json`. **Default empty — nothing enrolled means nothing autonomous can mutate.**
  - `killSwitchOn()` / `setKill(on)` — kill switch backed by `~/.ashlr/KILL` file / cfg flag. When set, ALL sandbox-mutating ops refuse regardless of enrollment.
  - `assertMayMutate(repo, opts?)` — throws (and records `result:'refused'` in audit) if kill switch is on OR repo is not enrolled. The `allowAnyRepo` test hatch never overrides the kill switch.
- **CLI surface** (`src/cli/sandbox.ts`):
  - `ashlr sandbox list` — list active sandboxes.
  - `ashlr sandbox diff <id>` — show the diff accumulated inside a sandbox.
  - `ashlr sandbox cleanup <id>` — remove a sandbox (worktree + scratch branch).
  - `ashlr audit [N]` — tail the audit trail, newest-first, optional limit.
  - `ashlr enroll list` — show enrolled repos.
  - `ashlr enroll add <repo>` — enroll a repo for autonomous work.
  - `ashlr enroll remove <repo>` — unenroll a repo.
  - `ashlr enroll kill on|off` — set or clear the global kill switch.
- **New types in `src/core/types.ts`** (all existing types unchanged):
  - `Sandbox { id; sourceRepo; worktreePath; branch; baseHead; createdAt }` — live sandbox descriptor.
  - `SandboxDiff { sandboxId; files; insertions; deletions; patch }` — diff of a sandbox vs its base HEAD.
  - `AuditEntry { ts; action; repo; sandboxId; summary; result:'ok'|'refused'|'error' }` — one audit record.
  - `Enrollment { repos }` — persisted enrollment registry shape.
  - `SwarmOptions.sandbox?:boolean` — seam for M24 daemon (OFF by default; swarm behavior today is unchanged).

### Guardrails (M21)
- **Isolation is absolute**: sandbox worktrees live ONLY under `~/.ashlr/sandboxes/`. Create and remove operations are structurally incapable of modifying the source repo's working tree, index, HEAD, or user branches. No `git reset --hard`, no checkout in source repo, no push, no user-branch deletion.
- **Enrollment default empty**: until you run `ashlr enroll add <repo>`, no real repo can be autonomously mutated — the gate throws before any worktree is created.
- **Kill switch**: `ashlr enroll kill on` sets `~/.ashlr/KILL`; every `assertMayMutate` call checks it first and refuses (audit `result:'refused'`). Cannot be bypassed by enrollment or the `allowAnyRepo` test hatch.
- **Audit is append-only**: no secret values, no prompt/completion content — metadata (action, repo, sandbox id, summary, result) only.
- **No new runtime deps**: node builtins + existing `core/git.ts` / `core/config.ts` / `cli/ui.ts` only.
- **Swarm seam is inert**: `SwarmOptions.sandbox` field plumbed; M12 swarm runner behaviour unchanged until M24 wires it.
- All 2110 existing tests preserved. Typecheck passes clean (`tsc --noEmit`).

---

## [Unreleased] — M20: One-Command Onboarding + Self-Healing (CAPSTONE)

### Added
- **`ashlr init` — complete, idempotent, NON-TTY-safe onboarding** (`src/core/onboard.ts`, updated `src/cli/doctor-init.ts`):
  - A single `ashlr init` (or `ashlr init --wire --yes`) takes a brand-new machine from zero to fully set-up. Re-runnable safely at any time — every step is idempotent.
  - Seven ordered steps: **config** (ensure `~/.ashlr/config.json` from defaults), **models** (detect Ollama / LM Studio and report — never auto-downloads), **editors** (detect Claude / Cursor / Codex; wire all when `--wire`), **symlink** (ensure `ashlr` → `~/.local/bin`), **genome** (seed empty genome dir), **phantom** (status report only), **doctor** (roll-up as final gate).
  - `--wire` — the only mutating optional step; wires every detected editor's MCP config (backup-first, idempotent, M18 pattern).
  - `--yes` (or non-TTY stdin) — accepts all defaults without interactive prompts; fully CI-safe.
  - `--json` — emits `OnboardResult { steps, ready, nextSteps }` for machine consumption.
  - Finishes with a crisp `you're set up — try: ashlr run / ashlr swarm / ashlr tui` next-steps summary.
  - **NEVER** auto-downloads models, modifies secrets, modifies shell profiles, or makes any network/outward call.
- **`ashlr doctor --fix` — self-healing doctor** (`src/core/doctor-fix.ts`, updated `src/cli/doctor-init.ts`):
  - Runs `runDoctor`, then applies one safe automated remediation per failing/warn check in the SAFE-FIXABLE set:
    - **`config`** — creates missing `~/.ashlr/config.json` from `defaultConfig()` + `saveConfig()`. Create-only; never overwrites an existing config.
    - **`index`** — rebuilds a stale/missing index via `buildIndex` + `writeIndex`. Non-destructive (regenerates derived data only).
    - **`local-bin`** — creates the `ashlr` → `~/.local/bin` symlink when missing and the source resolves. PATH is left as a `manual` action.
    - **`genome-memory`** — creates the genome directory when missing (mkdir-only; never seeds or edits entries).
    - **`mcp-plugin`** — registers the ashlr MCP gateway into a detected editor config via `wireEditor` (backup-first + idempotent, M18 pattern).
  - Every other failing check → `FixAction { applied:false, manual:true }` with a one-line guidance hint.
  - `--fix --json` emits `FixAction[]` for scripting; without `--json` prints a split **fixed** / **needs manual action** table.
  - Exits non-zero only when blocking failures remain after fixes.
  - **HARD GUARDRAILS**: NEVER deletes/overwrites user data, auto-downloads models, modifies secrets or shell profiles, or makes any outward/network call.
- **Bounded runtime self-heal** (`src/core/run/self-heal.ts`):
  - `withHeal<T>(fn, policy, onHeal)` — BOUNDED wrapper around any runtime operation (MCP downstream spawn, model call). Classifies failures and emits `HealEvent` via `onHeal` before a bounded retry:
    - `kind:'mcp-restart'` — restart a crashed MCP downstream; after `maxRestarts`, falls back to the existing M3 skip-on-failure behavior.
    - `kind:'model-downgrade'` — on local model OOM/error, downgrade to a SMALLER LOCAL model via `chooseRoute` (only when `policy.allowDowngrade`; NEVER escalates to cloud, NEVER increases cost).
    - `kind:'rate-backoff'` — exponential backoff on cloud rate-limit (ONLY when `allowCloud` is already set by the caller; never enables cloud on its own).
  - Reuses `withRetry` from `core/run/retry.ts` for the bounded loop and backoff — no reimplemented backoff logic.
  - Rethrows the last error on exhaustion or non-recoverable failure. Bounded by construction — `policy.maxRestarts` hard ceiling; no infinite loop.
  - `defaultHealPolicy()` — conservative default (`maxRestarts: 3, allowDowngrade: true`).
  - Opt-out: set `ASHLR_NO_HEAL=1` env var to bypass heal wrapping at any call site.
  - MCP gateway downstream spawn wrapped in `withHeal` (bounded restart → M3 skip-on-failure fallback).
  - Model call site wrapped in `withHeal` (local OOM → downgrade; cloud rate-limit → backoff — opt-out preserved).
- **New types in `src/core/types.ts`** (all existing types unchanged):
  - `FixAction { checkId; label; applied; detail; manual }` — result of one `fixDoctor` remediation attempt.
  - `OnboardStep { name; status:'ok'|'wired'|'detected'|'skipped'|'manual'; detail }` — one step of `onboard`.
  - `OnboardResult { steps; ready; nextSteps }` — full onboarding result; `--json` output shape of `ashlr init`.
  - `HealPolicy { maxRestarts; allowDowngrade }` — governs the self-heal loop; `allowDowngrade` enables local model downgrade only.
  - `HealEvent { kind:'mcp-restart'|'model-downgrade'|'rate-backoff'; detail; attempt }` — emitted by `withHeal` on each heal action.

### Changed
- `src/cli/doctor-init.ts` — `cmdInit` drives full onboarding via `onboard(cfg, {wire, yes})`; `cmdDoctor` accepts `--fix` → `fixDoctor` + split fixed/manual report. Existing flags and behavior preserved in all non-`--fix` paths.
- `src/core/mcp-gateway.ts` — downstream spawn/connect wrapped in `withHeal` (bounded restart, then M3 skip-on-failure). Opt-out via `ASHLR_NO_HEAL`.
- `src/core/run/router.ts` (model call site) — wrapped in `withHeal` for local OOM downgrade and cloud rate-limit backoff. M15 local-first + escalation gates unchanged.

### Guardrails (M20)
- **`ashlr init` is idempotent + NON-TTY-safe**: `--wire`/`--yes` gate the optional mutating steps; default is detect + report + safe ensures only.
- **`doctor --fix` is safe/local/non-destructive**: creates only (never overwrites), no auto-download, no secret access, no shell profile modification, no network calls. Editor-config writes are backup-first + idempotent (M18). Every fix is reversible-ish and logged.
- **Self-heal is BOUNDED**: hard `maxRestarts` ceiling; no infinite loop. Downgrade is always to a SMALLER LOCAL model; cloud backoff only when `allowCloud` already set by the caller.
- All 2026 existing tests preserved. No new runtime dependencies. M3/M11/M15/M18 semantics and tests unchanged.

---

## [Unreleased] — M19: Real Telemetry (OTLP) + Spend Governance

### Added
- **OTLP/HTTP-JSON trace emitter** (`src/core/observability/otlp.ts`):
  - `buildGenAiTrace(spans)` — builds a valid OTLP/HTTP-JSON payload (`resourceSpans → scopeSpans → spans`) with GenAI semantic-convention attributes only: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, a cost attribute, `ashlr.run.id`, `ashlr.provider`, `ashlr.tier`, span status, and `start/endTimeUnixNano`. **Metadata only — never prompts, completions, tool arguments, file contents, or secrets.**
  - `spansFromRun(run)` — produces one `GenAiSpan` per executed task from the `RunState` (usage, status, ids, provider, tier, duration). Pure, no I/O.
  - `spansFromSwarm(s)` — same, from a `SwarmRun`. Pure, no I/O.
- **TelemetrySink seam** (`src/core/observability/telemetry-sink.ts`) — the documented cloud-ready seam:
  - `TelemetrySink` interface: `emit(spans: GenAiSpan[]): Promise<TelemetryEmitResult>`.
  - `LocalFileSink` (default) — appends spans and run summaries as JSONL to `~/.ashlr/telemetry/*.jsonl`; this is what `ashlr pulse` already aggregates locally. Active whenever no OTLP endpoint + PAT are configured.
  - `OtlpHttpSink` — active only when `cfg.telemetry.pulse` is set **and** a PAT is available. Calls `buildGenAiTrace` → POSTs to the endpoint with `Authorization: Bearer <PAT>` and `Content-Type: application/json`. Bounded timeout, fire-and-forget, never throws or blocks the run. PAT is placed only in the Authorization header — never logged, printed, stored in span attributes, or returned.
  - `getSink(cfg)` — returns `OtlpHttpSink` iff `cfg.telemetry.pulse && patAvailable(cfg)`, else `LocalFileSink`. **Default is 100% local.**
  - `patAvailable(cfg)` — returns a `boolean` only; prefers Phantom, falls back to `ASHLR_PULSE_TOKEN` env var; never returns, logs, or exposes the value.
  - `localTelemetryDir()` — returns `~/.ashlr/telemetry`.
- **Spend governance** (`src/core/observability/governance.ts`):
  - `evalGovernance(cfg)` — reuses `buildForecast` / `buildRollup` to compute actual spend vs `cfg.telemetry.budgetUsd` over `cfg.telemetry.budgetWindow`. Returns a `GovernanceStatus`: `ok` (< 80% of cap), `warn` (≥ 80%), or `over` (> cap). `capUsd: null` + `ok` when no cap is configured. Never throws.
  - `ashlr pulse` shows a governance summary line: `Governance: ok | ⚠ warn (82% of $50.00) | ✗ over ($52.10 of $50.00 / 30d)`.
  - `ashlr doctor` gains a "Spend governance" check (degrades to warn when no cap is set).
- **`ashlr telemetry` command** (`src/cli/telemetry.ts`):
  - `ashlr telemetry status` — prints whether an endpoint is configured (boolean), whether a PAT is available (boolean), the active sink (`local` or `otlp`), and a governance summary. **Never prints the endpoint URL value or PAT value.**
  - `ashlr telemetry test` — emits a best-effort synthetic metadata-only span via the configured sink and reports the `TelemetryEmitResult` (sink type, ok/fail, non-secret detail). Useful for verifying the pipeline without a real run.
- **New types in `src/core/types.ts`** (all existing types preserved):
  - `GenAiSpan { name; runId; model; provider; tier; tokensIn; tokensOut; estCostUsd; status; startTs; endTs }` — metadata only; no prompts, completions, tool args, file contents, or secrets.
  - `TelemetryEmitResult { sink: 'local' | 'otlp'; ok: boolean; detail: string }` — `detail` never holds a PAT or content.
  - `GovernanceStatus { level: 'ok' | 'warn' | 'over'; spentUsd: number; capUsd: number | null; window: string; message: string }`.
  - `cfg.telemetry.govAction?: 'warn' | 'block'` (default `'warn'`); existing `pulse?`, `budgetUsd?`, `budgetTokens?`, `budgetWindow?` fields unchanged.

### Changed
- **`src/core/run/orchestrator.ts`** — `runGoal` replaces the M9 bespoke `reportToPulse()` with `getSink(cfg).emit(spansFromRun(run))`. Called post-completion, fire-and-forget, never blocks or throws. Governance check (`evalGovernance`) runs before execution: `warn` prints a prominent advisory; `over` + `govAction === 'block'` requires `--over-budget` to proceed (never silently blocks; per-run hard budget remains the only hard ceiling).
- **`src/core/swarm/runner.ts`** — `runSwarm` replaces any prior pulse reporting with `getSink(cfg).emit(spansFromSwarm(s))`. Same post-completion, opt-in, best-effort semantics. Governance check runs before swarm start.
- **`ashlr pulse`** — extended with a governance summary line (`ok` / `warn` / `over`) derived from `evalGovernance`.
- **`ashlr doctor`** — extended with a "Spend governance" check.

### Guardrails (M19)
- **Opt-in + best-effort**: OTLP emission happens ONLY when `cfg.telemetry.pulse` is set AND a PAT is available. It is fire-and-forget, bounded timeout, NEVER blocks, slows, or throws during a run or swarm. Failures log to stderr only.
- **Local-first default**: when no endpoint + PAT are configured (the default), the `LocalFileSink` is active and all telemetry stays 100% local under `~/.ashlr/telemetry/`.
- **Metadata-only**: span attributes and JSONL records contain model, token counts, cost estimate, run/swarm id, provider, tier, status, and duration — never prompt/response text, tool arguments, file contents, or secret values.
- **PAT safety**: the PAT lives only in the `Authorization` header. It is never logged, printed, put in span attributes, returned by any function, or committed. `patAvailable()` returns a boolean; `ashlr telemetry status` shows boolean flags — never values.
- **Governance is advisory, not a silent blocker**: `warn` prints a visible message; `over` + `block` requires `--over-budget` (which the user must pass explicitly). The per-run hard `RunBudget` ceiling remains the only hard ceiling and is unchanged.
- **No new runtime dependencies**: OTLP POST uses Node.js `fetch` builtin (Node 22+). No third-party packages added.
- All 1899 existing tests preserved.

---

## [Unreleased] — M18: Deep Integrations

### Added
- **`ashlr gh` — GitHub read + guarded mutations** (`src/cli/gh.ts`, `src/core/integrations/github.ts`):
  - `ashlr gh pr` — list open PRs for the current repo (number, title, URL, state, author).
  - `ashlr gh issue` — list open issues (same fields).
  - `ashlr gh ci` — latest CI/checks status for HEAD (`passing` / `failing` / `pending` / `none`).
  - All reads go through the **`gh` CLI** (which owns auth) — no raw tokens are ever handled by the hub.
  - `ashlr gh pr create` — the only mutation; prints a confirm prompt before any `gh pr create` call; never runs automatically.
  - `githubStatus(cwd)` — read-only, never throws; degrades gracefully when cwd is not a git repo or `gh` is unavailable.
- **`ashlr vercel` — Vercel read-only surface** (`src/cli/vercel.ts`, `src/core/integrations/vercel.ts`):
  - `ashlr vercel ls` — recent deployments (URL, state, createdAt, target) via the **`vercel` CLI**.
  - `ashlr vercel logs` — tail logs for the latest deployment.
  - `vercelStatus(cwd)` — read-only, never throws; degrades gracefully when no project is linked.
  - Deploy actions remain in `ashlr ship --deploy vercel --confirm` (already gated); no new deploy paths added.
- **`ashlr wire` — editor auto-wire** (`src/cli/wire.ts`, `src/core/integrations/editors.ts`):
  - `ashlr wire [claude|codex|cursor|all]` — wire the ashlr MCP gateway (and note genome) into each target editor's MCP config. Defaults to all detected editors.
  - Reuses the M3 `mcp install` pattern: backup-first, deep-merge of `mcpServers`, idempotent, never clobbers, local-only. Accepts `configPath` for temp-safe test operation.
  - `detectEditors()` — returns the subset of `claude`/`codex`/`cursor` whose config directories are present.
  - `wireEditor(target, opts)` — returns `{ok, detail}`; the only file writes are to editor config dirs (or `opts.configPath` in tests).
- **Phantom identity in status + doctor** (`src/core/integrations/identity.ts`):
  - `getIdentity()` — reads `phantom cloud status` and `phantom team` (via the installed **`phantom` CLI**); surfaces `{loggedIn, user, tier, team}`. Returns names/status only — secret values are never read, printed, or logged. Never throws; degrades to `loggedIn: false` when phantom is absent or logged out.
  - `ashlr status` gains a "You: `<user>` · tier `<t>` · team `<team>`" identity line (suppressed when not logged in).
  - `ashlr doctor` gains an identity check that degrades gracefully (warn, not fail) when phantom is not available.
- **`ashlr notify` — opt-in completion notifications** (`src/cli/notify.ts`, `src/core/integrations/notify.ts`):
  - `ashlr notify test` — sends a test ping to configured webhooks (Slack and/or Discord). Strict no-op when no webhook is configured — no network call, no error.
  - `notify(text, cfg)` — posts a concise, secret-free run/swarm completion summary. Returns `false` with zero side-effects when `cfg.notify.slackWebhook` and `cfg.notify.discordWebhook` are both unset. Never posts without an explicitly configured webhook.
  - Config: `cfg.notify.slackWebhook` and/or `cfg.notify.discordWebhook` in `~/.ashlr/config.json`; both are optional; both unset = feature is completely dormant.
- **GitHub + Vercel one-liners in `ashlr status`**:
  - When cwd is a GitHub repo and `gh` is available: `GitHub: N open PRs · CI passing/failing`.
  - When a Vercel project is linked and `vercel` is available: `Vercel: <latest deploy state> <url>`.
  - Both lines are omitted when the respective CLI is absent or the repo/project is not linked.
- **New types in `src/core/types.ts`** (all existing types preserved):
  - `GithubStatus { isRepo: boolean; openPrs: number; openIssues: number; ci: 'passing'|'failing'|'pending'|'none'; repo: string|null }`
  - `VercelStatus { linked: boolean; latestState: string|null; url: string|null }`
  - `Identity { loggedIn: boolean; user: string|null; tier: string|null; team: string|null }`
  - `NotifyTarget { slackWebhook?: string; discordWebhook?: string }`
  - `AshlrConfig.notify?: NotifyTarget`
  - Supporting read-model types: `PrSummary`, `IssueSummary`, `CreatePrOpts`, `CreatePrResult`, `DeploySummary`.

### Changed
- `ashlr status` output extended with GitHub, Vercel, and identity lines (each omitted when the source is unavailable).
- `ashlr doctor` extended with an identity check for phantom cloud login (degrades to warn, not fail).
- Architecture table in `src/core/` updated: new `integrations/` subdirectory (`github.ts`, `vercel.ts`, `editors.ts`, `identity.ts`, `notify.ts`).

### Guardrails (M18)
- **Read-first, always.** All status/list/identity reads (`githubStatus`, `vercelStatus`, `getIdentity`) are safe, read-only, and never throw. They delegate to the installed CLIs (`gh`, `vercel`, `phantom`) — the hub never handles raw tokens.
- **Mutations are explicit, confirm-gated, never automatic.** `ashlr gh pr create` requires an explicit subcommand + confirm prompt. Notifications require a configured webhook. Deploy stays in `ashlr ship --confirm`. No other write or outward action is introduced.
- **Identity = names/status only.** `getIdentity` never reads, stores, or prints secret values. Phantom vault contents are never accessed; only `phantom cloud status` and `phantom team` output is parsed.
- **Editor-wire is backup-first + idempotent + local.** `wireEditor` never overwrites a config unconditionally; it deep-merges `mcpServers` and backs up the target file before any write. Tests use `configPath` for temp-file safety.
- **Notify is strictly opt-in.** `notify()` returns `false` immediately with zero network calls when no webhook is configured. No webhook = feature is completely dormant.
- **No new runtime dependencies.** All new modules use Node builtins and the existing `gh`/`vercel`/`phantom` CLIs already installed on the system.
- All 1745 existing tests preserved.

---

## [Unreleased] — M17: Verified Orchestration

### Added
- **Tamper-evident task signing** (`src/core/swarm/sign.ts`):
  - `signOutput(content, cfg)` — HMAC-SHA256 signs a task result (content hash + HMAC). Key source: Phantom best-effort, else a local key auto-generated once at `~/.ashlr/keys/swarm.key` (0600, `crypto.randomBytes`). Signature stored on `SwarmTaskRun.signature` (`OutputSignature { alg, hash, sig, signer, ts }`). Signature contains only hashes — no payload secrets, never logged.
  - `verifyOutput(content, sig, cfg)` — verifies a stored signature using `timingSafeEqual`; returns `boolean`; never throws.
  - `ensureLocalKey()` — returns the key path, creating the file at 0600 with 32 random bytes if absent. Key is never printed, logged, or committed.
- **Downstream signature verification** (`src/core/swarm/runner.ts`):
  - Before a task consumes a dependency's output, `runner.ts` calls `verifyOutput` on that dependency's stored signature. A mismatch (tampered or corrupted result) skips consumption and triggers an escalation gate rather than silently proceeding.
- **Exception-driven escalation gates** (`src/core/swarm/gate.ts`):
  - `riskScan(text)` — case-insensitive heuristic scan for destructive/outward operations: `rm -rf`, `git push --force`, `deploy`, SQL `DROP`, and secret-exfiltration patterns. Returns `{ risky: boolean; reason: string }`; never throws.
  - `shouldEscalate(ctx)` — pure function; priority order `tamper > verify-failed > over-budget > risk > low-confidence`. Returns the `EscalationReasonKind` that applies, or `null`. Only decides — the caller persists the `EscalationEvent`, sets `status: 'needs-approval'`, and **stops**. Never auto-approves.
  - Gate trip conditions: downstream verify failure, over-budget, low-confidence / failed `verifyTask` on a critical task, or a RISK heuristic match on a task goal or result.
- **Swarm pause + `ashlr swarm approve <id>`** (`src/cli/swarm.ts`):
  - When a gate trips, `runSwarm` persists the `EscalationEvent` (task id, kind, detail, timestamp) to the `SwarmRun`, sets `status: 'needs-approval'`, and halts. No work continues automatically.
  - `ashlr swarm approve <id>` — explicit human action; resumes a `needs-approval` swarm from where it stopped. Only valid when status is `needs-approval`; errors otherwise.
- **`ashlr swarm verify <id>`** (`src/cli/swarm.ts`):
  - Verifies all stored task signatures in a completed or paused swarm. Exit code 0 when every signature is valid; exit code 1 on any failure or if the swarm is not found. Safe to run at any time.
- **Rollback-aware snapshots** (`src/core/swarm/rollback.ts`):
  - `snapshotProject(project)` — read-only; records the project's git `HEAD` commit ref and a stash ref (`stashRef`) for any dirty working tree into `RollbackSnapshot`. Non-git dirs or `null` project → `isRepo: false`; never throws.
  - `rollbackTo(snap, { force })` — **caller must confirm before invoking** (CLI prompts or `--yes`). Refuses if `isRepo: false`, if the snapshot has no `head`, or if the tree is dirty without `--force`. Restores `HEAD` via `git reset --hard` and re-applies the stash if `stashRef` is set. **Never runs `git push --force`, never deletes branches, never force-resets without `force: true`.**
  - `RollbackSnapshot` stored on `SwarmRun.rollback` at swarm start (before any tasks run).
- **`ashlr swarm rollback <id> [--yes] [--force]`** (`src/cli/swarm.ts`):
  - Prints exactly what it will restore (project path, HEAD ref, stash ref) before doing anything.
  - Requires `--yes` (or interactive confirmation) to proceed — never automatic.
  - `--force` required to restore over a dirty working tree (without it, refuses and explains).
  - Refuses on a non-git project or detached/ambiguous HEAD state, with guidance.
  - This is the **only potentially-destructive operation** in M17; all other new paths are read-only or additive.
- **New types in `src/core/types.ts`** (all existing types preserved):
  - `OutputSignature { alg: 'hmac-sha256' | 'phantom'; hash: string; sig: string; signer: string; ts: string }` — hashes only, no secrets.
  - `EscalationReasonKind = 'verify-failed' | 'over-budget' | 'tamper' | 'risk' | 'low-confidence'`
  - `EscalationEvent { taskId: string | null; kind: EscalationReasonKind; detail: string; ts: string }`
  - `RollbackSnapshot { project: string | null; isRepo: boolean; head: string | null; dirty: boolean; stashRef: string | null; ts: string }`
  - `SwarmTaskRun.signature?: OutputSignature`
  - `SwarmRun.escalations?: EscalationEvent[]`, `SwarmRun.rollback?: RollbackSnapshot`
  - `SwarmRun.status` union extended with `'needs-approval'`.

### Changed
- `src/core/swarm/runner.ts`: `runSwarm` snapshots project state at start (before any tasks), signs each task output on completion, verifies dependency signatures before consumption, calls `shouldEscalate` / `riskScan` at each gate point, persists `EscalationEvent` and halts on a positive gate, calls `captureFromSwarm` on normal completion.
- `src/cli/swarm.ts`: three new subcommands (`verify`, `approve`, `rollback`) wired and documented; rollback confirm-gate enforced at the CLI layer.

### Guardrails (M17)
- **Rollback is the only destructive operation.** It requires `ashlr swarm rollback <id>` + an explicit `--yes` confirm (or interactive prompt). It never runs automatically. `--force` is required to reset over a dirty tree. No `git push --force`; no branch deletion; refuses on non-git dirs and detached HEAD.
- **Keys: 0600, never logged.** `~/.ashlr/keys/swarm.key` is created with `crypto.randomBytes`, `chmod 0600`, and is never printed, logged, or captured in any run artifact. Phantom secrets never expose values — signatures contain only derived hashes.
- **Escalation gates pause, never auto-approve.** A gate trip sets `status: 'needs-approval'` and stops; `ashlr swarm approve <id>` is the only path forward.
- **Recursion guard + hard budget intact.** `ASHLR_IN_SWARM` env guard and the global `RunBudget` ceiling are unchanged.
- **Zero new runtime dependencies.** All signing and hashing use `node:crypto` (Node builtin). No third-party packages added.
- All 1619 existing tests preserved.

---

## [Unreleased] — M16: Compounding Genome

### Added
- **Auto-capture from runs and swarms** (`src/core/genome/capture.ts`):
  - `captureFromRun(run, cfg)` and `captureFromSwarm(s, cfg)` — fire-and-forget hooks called on run/swarm completion. Append a structured `GenomeEntry` (goal, concise approach/outcome summary, tags for project/status/tool/engine, and result gist) to `~/.ashlr/genome/hub.jsonl` via `appendHubEntry`.
  - `summarizeForGenome({goal, result, tasks})` — pure, deterministic helper that produces a secret-free, hard-capped (~800 chars) summary suitable for storage. Captures metadata/summary only — never raw prompts, completions, tool arguments, file contents, or secrets.
  - Opt-out: set `cfg.genome.autoCapture: false` (default `true`) or pass `--no-capture` on `ashlr run` / `ashlr swarm`. Auto-capture is **dedupe-aware** and **never throws or blocks** — it fires in the background after completion.
- **`ashlr genome consolidate`** (`src/core/genome/consolidate.ts`):
  - `consolidateGenome(cfg)` — merges near-duplicate entries (same goal/project with high text overlap) into one canonical entry. Preserves full provenance: merged `count`, `firstSeen`/`lastSeen` timestamps, and a union of all tags. Returns a `ConsolidationResult { before, after, merged, backupPath }`.
  - **Writes a timestamped backup of `hub.jsonl` before any mutation.** Nothing is silently deleted; all content is preserved in the merged entry. Bounded: only touches the hub store.
- **`ashlr genome playbook "<goal>"`** (`src/core/genome/playbook.ts`):
  - `buildPlaybook(goal, cfg, opts?)` — recalls similar past entries and synthesises a concise "how we approached this before — what worked / what failed / cost" playbook using the **local provider only**. Falls back to a concatenated recall summary when synthesis is unavailable or over budget. Never throws.
  - `playbookText(p, maxChars)` — pure, hard-capped serialiser for injecting into agent prompts.
  - Used by `orchestrator.runGoal`: when `cfg.genome.playbookOnRun !== false` (and `--no-memory` is not set), the M7 raw-recall injection is upgraded to a synthesised playbook injected (bounded by char cap) into the planning context.
- **`ashlr genome export <file>`** (`src/core/genome/export.ts`):
  - `exportGenome(cfg, dest, format)` — dumps the full genome to a portable JSON or Markdown file. Read-only, never throws, no lock-in. Returns `{ok, count, path}`.
  - `format: 'json'` — newline-delimited array of `GenomeEntry` objects.
  - `format: 'md'` — human-readable Markdown with one section per entry.
- **New CLI subcommands in `ashlr genome`** (`src/cli/genome.ts`):
  - `ashlr genome --teach "<note>" [--project p] [--tags a,b]` — append a high-value manual note (tagged `teach`).
  - `ashlr genome consolidate` — dedupe and merge near-duplicate entries (backup-first).
  - `ashlr genome export <file> [--format json|md]` — portable export of the full genome.
  - `ashlr genome playbook "<goal>"` — synthesise and print a playbook for the given goal.
  - All existing `cmdRecall` / `cmdLearn` / `cmdGenome` (health) commands preserved unchanged.
- **New types in `src/core/types.ts`** (all existing types preserved):
  - `GenomeCapture { goal: string; project: string|null; summary: string; tags: string[]; outcome: 'done'|'aborted'|'failed'; source: 'run'|'swarm'|'teach' }`
  - `Playbook { goal: string; entries: RecallHit[]; synthesis: string }`
  - `ConsolidationResult { before: number; after: number; merged: number; backupPath: string }`
  - `cfg.genome.autoCapture?: boolean` (default `true`) and `cfg.genome.playbookOnRun?: boolean` (default `true`).

### Changed
- `src/core/run/orchestrator.ts`: `runGoal` calls `captureFromRun` on completion and injects `playbookText` into planning context (upgrading M7 raw-recall); honours `--no-capture` flag and `cfg.genome.autoCapture`.
- `src/core/swarm/runner.ts`: `runSwarm` calls `captureFromSwarm` on completion; honours `--no-capture`.
- `src/cli/run.ts` and `src/cli/swarm.ts`: `--no-capture` flag added; sets `cfg.genome.autoCapture = false` for that invocation only.

### Guardrails (M16)
- **Privacy**: auto-capture stores metadata/summary only. Raw prompts, completions, tool call arguments, and file contents are never written to the genome. `summarizeForGenome` is hard-capped at ~800 chars and is deterministic with no I/O.
- **No data loss**: `consolidateGenome` writes a timestamped backup before any mutation; merged entries retain all key content; the genome is append-only everywhere else; `exportGenome` is strictly read-only.
- **Local-only**: playbook synthesis uses the local provider only (best-effort); falls back to concatenated recall on failure or budget exhaustion; no cloud calls. Auto-capture fires in the background and never throws.
- **Non-blocking**: capture is fire-and-forget — it never delays a run result or swarm completion.
- All 1504 existing tests preserved.

---

## [Unreleased] — M15: Cost-Optimal Local-First Routing

### Added
- **Per-task model routing** (`src/core/run/router.ts`): `chooseRoute(taskGoal, cfg, opts)` picks the best available local model (Ollama / LM Studio) for every task according to `cfg.models.providerChain`. Optional `cfg.models.routing[]` rules match task goals by pattern and override the default model. Returns a `RouteDecision` with `{provider, model, tier, reason}` so the caller always knows exactly what was chosen and why.
  - **Local-first, hard-enforced**: cloud provider is selected only when `opts.allowCloud === true` AND `opts.lastReason !== 'none'` (an escalation reason is present) AND a cloud API key is actually available (`cloudKeyAvailable(provider)`). Any other combination stays local. No silent cloud spend is ever possible.
  - `cloudKeyAvailable(provider)`: reads the standard API-key env var for a provider; returns a boolean — never logs or leaks the value.
  - `wouldBeCloudCost(tokensIn, tokensOut)`: returns a clearly-labeled estimate of what the same token counts would have cost on the default cloud provider, for savings comparison only. Never used as a billing figure.
- **Auto-escalation on failure/latency** (integrated into `src/core/run/orchestrator.ts`):
  - When a task result is empty/errored, or `verifyTask` returns `!ok` (M11 verify loop), the orchestrator calls `chooseRoute` with `lastReason: 'task-failed'` / `'verify-failed'` for the retry pass.
  - When a task exceeds `cfg.models.escalate.latencyMs` (optional), the next attempt is routed with `lastReason: 'latency'`.
  - **Cloud escalation requires both `--allow-cloud` AND a present key.** Without both, the retry stays local or marks the task `needs-attention`. There is no automatic cloud fallback.
  - Escalation is a single routed retry — it ties into the existing M11 `withRetry` / `verifyTask` path; the global `RunBudget` ceiling is never lifted.
- **Cost attribution per provider** (orchestrator + `src/core/observability/rollup.ts`):
  - Each `RunTask` now records `provider` and `tier` from its `RouteDecision`.
  - Local tasks (tier `'local'`) contribute `$0.00` actual cost; cloud tasks carry real `estCostUsd`.
  - `buildRollup` aggregates actual spend by provider and separately computes a "would-have-been-cloud" estimate (via `wouldBeCloudCost`) for every local task — giving a concrete savings figure.
- **Cost forecasting** (`src/core/observability/forecast.ts`): `buildForecast(window, cfg)` returns a `CostForecast` with:
  - `spentUsd` — actual cost in the window (local = $0, cloud = real estimate).
  - `localSavingsUsd` — cloud-equivalent cost for tokens handled locally, clearly labeled as an estimate.
  - `projectedMonthlyUsd` — simple linear projection from the window rate.
  - All numbers are **estimates, labeled as such**; no precision is fabricated.
- **`ashlr pulse` savings + forecast line**: `ashlr pulse` now shows a savings/forecast line beneath its summary output:
  ```
  Local savings (est):  $X.XX   |   Cloud would-have-been: $Y.YY   |   Projected 30d: $Z.ZZ
  ```
  The line is printed only when at least one local task has run in the window; suppressed on `--json` (the `CostForecast` is merged into the JSON rollup instead).
- **`ashlr models` — local model management** (`src/cli/models.ts`, `src/core/run/model-manager.ts`):
  - `ashlr models` — list all local models from Ollama (`/api/tags`) and LM Studio (`/api/models`). Shows name, provider, approximate size label, and whether it is the currently active/default model per config.
  - `ashlr models pull <name>` — explicit Ollama pull. Prints a size warning and requires interactive confirmation (`y/yes`) before downloading. **Never invoked automatically** during a run, route, or any other command.
  - `ashlr models start` — best-effort attempt to start a locally installed Ollama daemon when it is installed but not responding. **Never invoked automatically**; bounded to the local Ollama process; never installs or downloads anything.
  - `ollamaInstalled()`: checks `PATH` for the `ollama` binary — no network call, no side effects.
- **New types** in `src/core/types.ts` (all existing types preserved):
  - `ModelTier = 'local' | 'cloud'`
  - `RouteDecision { provider: string; model: string; tier: ModelTier; reason: string }`
  - `RoutingRule { match: string; model: string }`
  - `EscalationReason = 'task-failed' | 'verify-failed' | 'latency' | 'none'`
  - `LocalModelInfo { provider: 'ollama' | 'lmstudio'; name: string; sizeLabel?: string; active: boolean }`
  - `CostForecast { window: string; spentUsd: number; localSavingsUsd: number; projectedMonthlyUsd: number }`
  - `cfg.models.routing?: RoutingRule[]` and `cfg.models.escalate?: { onFailure: boolean; latencyMs?: number }` config fields.

### Guardrails (M15)
- **Local-first, no silent cloud**: cloud is reachable only via `--allow-cloud` + a present API key + a non-`'none'` escalation reason. The default path is 100% local. Every run and swarm is still bounded by the hard `RunBudget` ceiling.
- **No auto-download**: `ollama pull` runs only on the explicit `ashlr models pull <name>` command (with a confirmation prompt). It is never called during a run, route, or escalation.
- **No auto-start**: `ashlr models start` is the only path that attempts to start a local Ollama process. It is never called automatically.
- **Estimates clearly labeled**: all savings and forecast numbers are estimates; no precision is fabricated; every cost label includes `(est)`.
- **No secrets logged**: `cloudKeyAvailable` returns a boolean only; key values never appear in logs, run state, or rollup output.
- **Zero new runtime dependencies**: `router.ts`, `model-manager.ts`, `forecast.ts`, and `cli/models.ts` use only Node builtins and existing hub modules (`provider-client`, `budget`, `rollup`, `ui`).
- All 1396 existing tests preserved.

---

## [Unreleased] — M14: Surfaces II (Local Web Dashboard)

### Added
- **`ashlr serve [--port N] [--open] [--allow-dispatch]` — local web dashboard** (`src/core/web/server.ts`, `src/core/web/api.ts`, `src/core/web/static.ts`, `src/cli/serve.ts`):
  - Starts a localhost HTTP server (Node `http` builtin) serving a JSON API and a single-page dashboard (static assets bundled in the repo — **no CDN, fully offline**). Default port 7777; `--open` launches the browser automatically.
  - **Five dashboard views** (vanilla JS + inline SVG/Canvas, dark theme, brand aesthetic, live via EventSource):
    - **Overview** — aggregated snapshot of the local ecosystem (git health, tools, 7-day activity).
    - **Runs** — paginated list of recent agent runs with status, goal, and token/cost usage.
    - **Swarms** — swarm detail with an **SVG dependency-graph** (nodes per task colored by phase/status, edges for declared dependencies) and a live burndown chart updating in real time via SSE.
    - **Pulse** — SVG bar charts of cost/token usage by project, day, and model.
    - **Genome browser** — full genome list with a search box that hits `/api/genome?q=` for instant recall.
  - **Live updates via SSE** — `GET /api/events` uses Server-Sent Events to push run/swarm state changes (bounded poll interval) so the page live-streams burndown without a reload. Cleared on disconnect and on server close (no timer leaks).
- **JSON read-only API** (all endpoints metadata-only; no secrets served):
  - `GET /api/snapshot` — `buildSnapshot(cfg)` aggregate (M13 dashboard snapshot).
  - `GET /api/runs` / `GET /api/run/:id` — `listRuns` / `loadRun` (404 on unknown id).
  - `GET /api/swarms` / `GET /api/swarm/:id` — `listSwarms` / `loadSwarm` (404 on unknown id).
  - `GET /api/pulse[?window=1d|7d|30d]` — `buildRollup` (default 7d).
  - `GET /api/genome[?q=<query>]` — `recall(q, cfg)` when `q` supplied, else `loadGenome(cfg)`.
  - `GET /api/events` — SSE stream (see above).
- **Opt-in dispatch endpoint** (`POST /api/run`) — registered **only** when `--allow-dispatch` is passed. Protected by a per-session token (printed at server start, required in a header, compared constant-time) to defeat CSRF/drive-by POSTs. Body clamped to local-first budget caps; `allowCloud` never set. **Default server has zero mutating endpoints.**
- **New types** in `src/core/types.ts`: `WebServerOptions`, `WebServerHandle`.

### Security (non-negotiable, documented in CONTRACT-M14.md)
- **Binds `127.0.0.1` only** — never `0.0.0.0`; not externally reachable.
- **Host-header allowlist** (`localhost` / `127.0.0.1` / `::1` ± port) enforced as the first pipeline step — all other `Host` values → 403. Defeats DNS-rebinding attacks.
- **Read-only by default** — no mutating endpoints exist unless `--allow-dispatch` is explicitly passed.
- **Token-guarded dispatch** — constant-time comparison; token printed once at startup; never in logs or snapshot responses.
- **Path-traversal-safe static serving** — decode + join under assets dir, resolve, reject `..` / absolute / null-byte / symlink-escape → 404.
- **No outward/SSRF calls** from the server process.
- **No CDN / no external fonts or scripts** — all assets bundled in the repo and served locally; fully functional offline.
- **Ephemeral + clean close** — `Ctrl-C` stops the server; SSE poll timers cleared; no leaks.
- **Zero new runtime dependencies** (`http` / `crypto` / `fs` / `path` / `url` builtins only).

### Guardrails (M14)
- All 1314 existing tests preserved.
- Reuses `core/dashboard.ts buildSnapshot`, `core/run/orchestrator.ts listRuns/loadRun/runGoal`, `core/swarm/store.ts listSwarms/loadSwarm`, `core/observability/rollup.ts buildRollup`, `core/genome/store.ts loadGenome/genomeHealth`, `core/genome/recall.ts recall`, and `cli/ui.ts`.
- Zero new runtime dependencies in `core/` and `cli/`.

---

## [Unreleased] — M13: Surfaces I (Interactive TUI + Real-Time Raycast)

### Added
- **`ashlr tui` / `ashlr dash` — interactive live terminal dashboard** (`src/tui/app.ts`, `src/tui/render.ts`, `src/cli/tui.ts`):
  - Runs in an alt-screen buffer with raw-mode key handling and automatic resize awareness. Auto-refreshes every ~2 s by re-reading local data sources (bounded, never blocks the event loop).
  - **Five tabs** (switch with `Tab` / `Shift-Tab` or `1`–`5`):
    - **Overview** — repo health (dirty/stale counts), ecosystem tool availability, 7-day activity summary.
    - **Runs** — recent agent runs with live status, goal summary, and token usage.
    - **Swarms** — live phase/task burndown for active and recent swarms (done/total per phase).
    - **Pulse** — 7-day cost, tokens, and per-project activity from the local observability rollup.
    - **MCP** — discovered MCP server health (name, tool count, ok/fail).
  - **Key bindings**: `Tab` / `Shift-Tab` or `1`–`5` to switch tabs; `j` / `k` to move selection; `r` to force-refresh; `Enter` to show detail; `q` / `Ctrl-C` to quit.
  - **`--once` flag**: render one frame to stdout and exit — safe for headless use, scripting, and test assertions.
  - **Non-TTY graceful degradation**: when stdout is not a TTY (pipe, redirect, CI), automatically prints one frame without entering raw mode or alt-screen.
  - **Terminal safety guarantee**: alt-screen, cursor visibility, and raw mode are **always restored** on quit, signal (`SIGINT`, `SIGTERM`), or thrown exception — the terminal is never left corrupted.
  - **Zero new runtime dependencies**: built entirely on Node.js builtins and `src/cli/ui.ts` ANSI helpers.
- **`src/core/dashboard.ts`** — `buildSnapshot(cfg)`: aggregates index/git (dirty/stale), tools-registry, observability rollup, runs (orchestrator), swarm store, MCP registry, and genome health into a single `DashboardSnapshot`. Bounded and fault-tolerant — never throws; any failed data source degrades to zeroed/empty fields.
- **New types** in `src/core/types.ts`: `DashboardSnapshot`, `TuiTab`.
- **Raycast extension upgrades** (`src/raycast/`):
  - **Dispatch Run** command: form UI (goal, budget, parallel, engine flags) that invokes `ashlr run --json` and shows live output. Bounded and local-first, matching CLI guardrails.
  - **Swarms** command: lists active and recent swarms with live done/total task counts and per-phase progress; action to show full detail or open the target project.
  - **Auto-revalidation**: existing Pulse and Attention views now use `usePromise`/`useExec` with a short poll interval so they refresh without manual reloads.
  - All new commands registered in `src/raycast/package.json`.

### Guardrails (M13)
- TUI is **reads-only** — no destructive or outward actions from any tab.
- Raycast dispatch is the only outward action; it is bounded (budget ceiling), local-first by default (`--allow-cloud` required for cloud endpoints), and uses the same `ashlr run` path as the CLI.
- ZERO new runtime dependencies added to CLI/TUI (Node builtins + `src/cli/ui.ts` only); Raycast retains its existing `@raycast/api`.
- All 1184 existing tests preserved.

---

## [Unreleased] — M12: Spec-Driven Swarms

### Added
- **`ashlr spec` — end-state specs as first-class artifacts** (`src/core/spec/spec-store.ts`, `src/cli/spec.ts`):
  - `ashlr spec new "<goal>" [--project <path>]`: drafts a structured end-state spec with the local model (sections: Context, North Star, Operating Principles, Pillars, Roadmap/phases, Verification). Stored versioned at `<project>/.ashlr/specs/<slug>-v<N>.md` plus a sidecar `.json` (id, goal, version, createdAt, status). Never overwrites an existing version.
  - `ashlr spec list [--project <path>]`: table of all specs (id, version, status, goal).
  - `ashlr spec show <id>`: print the full markdown body + metadata.
  - `ashlr spec refine <id> "<note>"`: produce v+1 incorporating the note. Versioned and append-only — prior versions are always recoverable.
- **`ashlr swarm` — contracts-first agent-fleet orchestration** (`src/core/swarm/planner.ts`, `src/core/swarm/runner.ts`, `src/core/swarm/store.ts`, `src/cli/swarm.ts`):
  - `ashlr swarm "<goal>" | <specId> [--budget N] [--parallel N] [--background] [--resume <id>] [--dry-run] [--allow-cloud]`: decomposes a goal or spec into a `SwarmPlan` (phases: SCAFFOLD → BUILD → INTEGRATE → VERIFY → REVIEW) and executes a fleet of agents through it. Each task is an `orchestrator.runGoal` invocation, local-first by default. BUILD phase fans out in parallel (cap `--parallel`, default 3, max 8). Planner caps tasks per phase at 6.
  - `ashlr swarms [--json]`: list all past swarm runs (id, status, phase, cost).
  - `ashlr swarm show <id>`: full `SwarmRun` detail including per-task status, usage, and errors.
- **New types in `src/core/types.ts`**: `SpecArtifact`, `SwarmPhaseName`, `SwarmTaskSpec`, `SwarmTaskRun`, `SwarmPlan`, `SwarmRun`, `SwarmOptions`.
- **`--dry-run`**: planner runs, all tasks printed, no agents invoked — zero cost, safe to run anywhere.
- **`--background`**: launch a detached worker process that runs the swarm and writes progress to the swarm record; foreground returns the swarm id immediately. Total budget still bounds all background work.

### Guardrails
- **Hard total budget**: a single `RunBudget` ceiling spans the entire swarm (all tasks, all phases). Any task that would push usage over the limit is skipped; the swarm aborts cleanly with full partial state preserved.
- **Bounded concurrency**: `--parallel` (default 3, max 8); planner enforces ≤6 tasks per phase.
- **Local-first**: tasks run on local models (builtin/Ollama) by default. `--allow-cloud` required for cloud endpoints — no silent billing.
- **No recursion / no fork bomb**: swarm tasks set `ASHLR_IN_SWARM=1` in subprocess env. `ashlr swarm` refuses to start if that marker is already set, preventing nested swarms.
- **No outward/destructive actions by default**: tasks operate within the target project dir; push, deploy, repo creation, and destructive `tidy --apply` / `ship --confirm` are blocked unless explicitly opted in.
- **Resumable**: `SwarmRun` persisted to `~/.ashlr/swarms/<id>.json` after every step; `--resume <id>` restarts from the last completed checkpoint.
- **Streaming progress** (M11 `StreamSink`): phase start/done, per-task start/done, live burndown counts streamed to stderr in real time.

---

## [Unreleased] — M11: Watchable, Robust Runs

### Added
- **Hardened engine delegation** (`src/core/run/engines.ts`): replaced the guessed
  `['--goal', goal]` spawn with per-engine adapter functions that emit the real,
  confirmed CLI argv for each tool. `buildEngineCommand` returns `null` for
  `builtin` (local loop) or an `EngineCommand` with the exact invocation:
  - `claude` (Claude Code): `claude -p "<goal>" --model <M> --output-format json`
    (JSON carry usage + cost automatically).
  - `aw` (ashlr-workbench): `aw auto "<goal>" --cwd <dir>` plus `--model <M>` when
    a model is set.
  - `ashlrcode` (absent on this host): `ac --goal "<goal>"`; absence is detected via
    `engineInstalled` and routes to the builtin loop with a clear message.
  `spawnEngine` applies `withToolEnv(cfg)` to every spawn and wraps via
  `phantom exec --` when `cfg.phantom?.enabled` and `phantom` is on PATH.
  `phantomWrap` is exported for unit testing the exact argv without real delegation.
- **Streaming output** (`src/core/run/streaming.ts`): `RunStreamEvent` (with kinds
  `task-start`, `model-delta`, `tool-call`, `task-done`, `retry`, `verify`, `log`)
  flows from the agent loop to the CLI in real time. `makeCliSink` renders a live,
  human-readable stream to **stderr** (keeping stdout clean for `--json`);
  `nullSink` is a no-op for programmatic consumers. `StreamSink` type exported.
- **`--stream` / `--no-stream` flags** (`src/cli/run.ts`): streaming defaults on
  when stderr is a TTY; `--no-stream` suppresses live output. `--json` keeps stdout
  clean JSON while the event stream goes to stderr. All existing flags preserved.
- **Retry + verification loop** (`src/core/run/retry.ts`, `src/core/run/verify.ts`):
  `withRetry` wraps any async fn with bounded exponential back-off
  (`baseDelayMs × 2^(attempt-1)`, capped at `maxAttempts`; caller supplies
  `isRetryable`). `verifyTask` checks a completed task result with a cheap
  heuristic first; if the budget allows, it optionally asks the model for a
  verdict — but never exceeds the global budget ceiling. `VerifyVerdict` signals
  `ok`, `reason`, and `method` (`'heuristic'` or `'model'`).
- **Phantom-exec proxy** (`src/core/run/engines.ts` `phantomWrap`): when
  `cfg.phantom?.enabled` is true and `phantom` is installed, all engine spawns are
  wrapped as `phantom exec -- <bin> [...args]` so secrets are injected by Phantom
  rather than by the hub. Best-effort: absent or disabled Phantom falls back to
  direct spawn. Secret values are never logged or injected into the env allowlist.
- New types in `src/core/types.ts`: `RunStreamEvent`, `RetryPolicy`,
  `VerifyVerdict`, `EngineId`, `EngineCommand`.
- `ProviderClient` extended with optional `chatStream?(messages, tools, onDelta)`
  for Ollama (NDJSON `/api/chat stream:true`) and LM Studio (SSE
  `/v1/chat/completions stream:true`); both fall back to `chat()` when streaming
  is unavailable. Callers guard with `?.`.

### Changed
- `src/core/run/orchestrator.ts` updated to consume `StreamSink` and forward
  events from the agent loop to the CLI sink; engine delegation paths updated to
  use `buildEngineCommand` / `spawnEngine` from `engines.ts`.
- `src/cli/run.ts` wires `makeCliSink` (TTY) or `nullSink` (non-TTY / `--no-stream`)
  and passes it through to the orchestrator.

### Fixed
- Engine delegation previously passed a guessed argv to spawned sub-agents; the
  adapter layer now asserts exact argv in unit tests (no real delegated runs during
  build or CI).

---

## [Unreleased] — M10: Ecosystem Cohesion

### Added
- **Config → env bridge** (`src/core/env-bridge.ts`): `buildToolEnv` / `withToolEnv`
  project `~/.ashlr/config.json` into every spawned child's environment so all
  independently-shipped ecosystem tools (ashlrcode, aw, MCP downstreams, stack,
  vercel, gh, morphkit) honor one unified config without modification. Maps
  endpoints (`OLLAMA_HOST`, `OLLAMA_BASE_URL`, `LM_STUDIO_URL`, `OPENAI_BASE_URL`),
  provider identity (`ASHLR_LLM_PROVIDER`, `ASHLR_PROVIDER_CHAIN`, `ASHLR_MODEL`,
  `AC_MODEL`), paths (`ASHLR_CONFIG`, `ASHLR_GENOME_DIR`, `ASHLR_ROOTS`), and a
  local-first flag (`ASHLR_LOCAL_FIRST=1`). No secret values are ever injected —
  Phantom owns credentials; they flow to children only via normal `process.env`
  inheritance.
- `ToolEnv` type alias exported from `src/core/types.ts` (optional alias for
  `Record<string,string>` — the non-secret env map projected into spawned children).

### Fixed
- **Orchestrator resume-before-delegation reorder** (`src/core/run/orchestrator.ts`):
  the engine-delegation block previously ran before the `--resume` short-circuit,
  causing `ashlr run --engine x --resume <id>` to re-run an already-completed run
  instead of resuming it. The resume path now short-circuits first; env-bridge is
  applied to the delegation spawn after the reorder.
- **Genome recall TTY alignment** (`src/cli/genome.ts`): the recall table
  header/separator was misaligned in a TTY. Fixed column padding. Hits with
  `score <= 0` are now dropped from the display.
- **Doctor version awareness** (`src/core/tools-registry.ts`, `src/core/doctor.ts`):
  `ashlr doctor` now surfaces the installed version of each detected ecosystem tool
  (phantom, ashlrcode, aw, stack, morphkit, etc.) via lightweight `--version` probes,
  giving at-a-glance version awareness without requiring any new runtime dependencies.

### Changed
- `src/core/run/orchestrator.ts`, `src/core/mcp-gateway.ts`,
  `src/core/lifecycle/ship.ts` spawn sites updated to call `withToolEnv(cfg)` so
  every child inherits the unified config projection.
- MCP gateway downstream spawns merge `spec.env` AFTER `withToolEnv` base so
  per-server env overrides win over bridge defaults.

---

## [M9] — Hardening, CI, and Polish

_Commit: `71cb197` · `dfef853` · `b302e3e`_

### Added
- `ashlr update` command: self-update from the git remote + rebuild.
- CI workflow: typecheck, lint, build, and vitest on Node 22 for every push and PR.
- 932-test suite milestone reached.

### Fixed
- P0 bug fixes identified by internal audit: budget hard-ceiling enforcement,
  run-persistence atomicity, provider probe timeouts.

### Changed
- Shared CLI helpers extracted into `src/cli/ui.ts` and `src/cli/args.ts` (DRY
  refactor across 12 CLI files).
- Release polish: `CONTRIBUTING.md`, `ARCHITECTURE.md`, `install.sh` updated for
  public-repo presentation.

---

## [M7] — Shared Memory / Genome

_Commit: `26df2e0`_

### Added
- `ashlr learn "<note>"` — append a memory entry to `~/.ashlr/genome/hub.jsonl`
  (append-only; never overwrites).
- `ashlr recall "<query>"` — keyword/TF-IDF search across the aggregated genome
  (all indexed repos' `.ashlrcode/genome/` dirs + hub store). Optional
  embedding-rerank via local Ollama (`bge-m3` or similar); never calls a cloud API.
- `ashlr genome` — health status: entry count, projects covered, store size,
  staleness, embeddings availability.
- `src/core/genome/store.ts` — `loadGenome`, `appendHubEntry`, `genomeHealth`.
- `src/core/genome/recall.ts` — `recall`, `keywordScore`.
- `ashlr run` memory injection: top-k recall hits injected into sub-agent prompts
  (bounded by `cfg.genome.maxRecall`; disable per-run with `--no-memory`).
- `AshlrConfig.genome?: { maxRecall, injectOnRun }` config field.
- Types: `GenomeEntry`, `RecallHit`, `GenomeHealth`, `LearnInput`.

---

## [M6] — Project Lifecycle (`ashlr new` + `ashlr ship`)

_Commit: `febb800`_

### Added
- `ashlr new <name>` — scaffold an ecosystem-wired project (CLAUDE.md,
  `.mcp.json` gateway, genome stub, entry point) and register it in the index.
  Templates: `minimal`, `node-cli`, `mcp-server`, `next-app`.
- `ashlr ship [path]` — pre-ship gate (supply-chain + test/lint/build), then
  optional deploy. Read-only and dry-run by default; `--confirm` required for any
  outward action. Deploy targets: `vercel`, `stack`, `gh`, `morphkit`.
- `src/core/lifecycle/templates.ts` — `TEMPLATES`, `getTemplate`, `listTemplates`.
- `src/core/lifecycle/scaffold.ts` — `scaffoldProject`, `defaultCategory`,
  `targetDir`. Refuses to overwrite an existing directory.
- `src/core/lifecycle/ship.ts` — `runShipGate` (read-only), `deploy` (dry-run
  by default; real deploy requires `--confirm`).
- Types: `ProjectTemplate`, `ScaffoldSpec`, `ScaffoldResult`, `ShipCheck`,
  `ShipGate`, `ShipResult`.

---

## [M5] — Observability (`ashlr pulse`)

_Commit: `72a8714`_

### Added
- `ashlr pulse` — local usage dashboard: window summary (tokens/cost), by-project
  table, top models, budget status. Honors `--window 1d|7d|30d`, `--project`,
  `--json`. All numbers computed offline.
- `src/core/observability/usage-source.ts` — `collectUsageEvents`: streams
  metadata-only from `~/.claude/projects/**/*.jsonl` and `~/.ashlr/runs/*.json`.
  Never reads message content.
- `src/core/observability/rollup.ts` — `buildRollup`, `windowToMs`: aggregates
  by project, day, and model; joins with git commit counts.
- `src/core/observability/budget-alert.ts` — `evalBudget`: warn at >=80% of any
  cap; over when exceeded.
- `AshlrConfig.telemetry` extended with `budgetUsd`, `budgetTokens`, `budgetWindow`.
- Types: `UsageEvent`, `ProjectActivity`, `DailyUsage`, `ModelUsage`,
  `BudgetAlert`, `ActivityRollup`.

---

## [M4] — Agent Orchestrator (`ashlr run`)

_Commit: `56b1626`_

### Added
- `ashlr run "<goal>"` — plan → parallel DAG fan-out → synthesize. Resumable
  (`--resume <id>`); persisted to `~/.ashlr/runs/`. Hard budget and step ceilings
  (`--budget N`, `--max-steps N`). Local-first: refuses cloud unless `--allow-cloud`.
- `ashlr runs` — list past runs (id, status, tokens, cost).
- `ashlr run show <id>` — print full `RunState` for a past run.
- `src/core/run/provider-client.ts` — `getActiveClient`, `estimateTokens`.
  Supports Ollama (native `/api/chat`) and LM Studio (OpenAI-compatible). Enforces
  local-first: errors rather than silently billing when cloud is the only option.
- `src/core/run/budget.ts` — `newUsage`, `addUsage`, `overBudget`, `estCostUsd`.
- `src/core/run/agent-loop.ts` — `runTask`: bounded chat loop with tool-call
  support (degrades gracefully when unsupported). Hard-stops on budget.
- `src/core/run/orchestrator.ts` — `planGoal`, `runGoal`, `loadRun`, `listRuns`,
  `saveRun`. Parallel task fan-out (up to `--parallel N`). Engine delegation to
  `ashlrcode` / `aw` when installed.
- Types: `RunBudget`, `RunUsage`, `RunTask`, `RunStep`, `RunState`, `RunOptions`,
  `ChatMessage`, `ChatResult`, `ProviderClient`.

---

## [M3] — MCP Aggregation Gateway

_Commit: `aa59450`_

### Added
- `ashlr mcp` — run the single stdio MCP aggregation gateway. Discovers all
  configured MCP servers, starts each as a managed child, and proxies their tools
  namespaced as `<server>__<tool>`.
- `ashlr mcp list` — registry + per-server tool counts (env values redacted).
- `ashlr mcp doctor` — per-server health (starts? tool count?).
- `ashlr mcp install <claude|ashlrcode>` — idempotently register the gateway in a
  target agent config (backs up the file first; never clobbers).
- `src/core/mcp-registry.ts` — `discoverMcpServers`, `knownConfigPaths`: reads
  `~/.claude.json`, `~/.claude/settings.json`, `~/.mcp.json`,
  `~/.ashlrcode/settings.json`; deduped, env values redacted in display.
- `src/core/mcp-gateway.ts` — `startGateway`, `probeServer`. Per-downstream
  startup timeout 8s; failed downstreams skipped, gateway never crashes.
- `src/core/tools-registry.ts` — `getToolsRegistry`: detects installed ecosystem
  tools (phantom, ashlrcode, aw, stack, morphkit, …) via PATH.
- Runtime dependency: `@modelcontextprotocol/sdk` (gateway only; rest stays
  zero-dep).
- Types: `McpServerSpec`, `McpRegistry`, `AggregatedTool`, `McpServerHealth`,
  `ToolInfo`, `ToolsRegistry`.

---

## [M2] — Identity and Model Awareness

_Commit: `3a52826`_

### Added
- `ashlr doctor` — one-glance health check across runtime, config, index, Phantom,
  MCP plugin, and every provider endpoint. Exits non-zero on any `fail`.
- `ashlr init [--yes]` — idempotent onboarding: writes config defaults, detects
  local models, enables Phantom if present. Non-TTY safe (`--yes` accepts all
  defaults without prompting).
- `src/core/providers.ts` — `probeEndpoint`, `getProviderRegistry`,
  `resolveActiveProvider`: probes LM Studio (`:1234`) and Ollama (`:11434`);
  builds a registry; resolves the active provider via the configured chain.
  Probes never throw.
- `src/core/phantom.ts` — `phantomInstalled`, `getPhantomStatus`: read-only
  introspection of the `phantom` CLI. Returns names and status only — never secret
  values.
- `src/core/doctor.ts` — `runDoctor`: aggregates config, phantom, and provider
  health into a single `DoctorReport`. Never throws.
- `AshlrConfig` extended with `models.providerChain`, `phantom.enabled`.
- Types: `ProviderEndpoint`, `ProviderRegistry`, `PhantomStatus`, `DoctorCheck`,
  `DoctorReport`.

---

## [M1] — Foundation

_Commit: `814f3c3`_

### Added
- `ashlr index [--refresh]` — scan project tree, persist `~/.ashlr/index.json`.
- `ashlr status` — index summary: counts by kind/category, dirty/stale repos,
  7-day activity line.
- `ashlr go [query]` — fuzzy-jump to a project (`--open` / `--cd`).
- `ashlr ls [category]` — list indexed items.
- `ashlr open <query>` — resolve and open in configured editor.
- `ashlr tidy [--apply]` — plan or apply moves of loose top-level files.
- `ashlr config get|set|path` — read/write `~/.ashlr/config.json`.
- `ashlr help` — usage.
- `src/core/config.ts` — `loadConfig`, `saveConfig`, `defaultConfig`,
  `CONFIG_DIR`, `CONFIG_PATH`, `INDEX_PATH`.
- `src/core/git.ts` — `isRepo`, `getGitStatus`, `getRemoteOrg`. Tolerates
  worktrees, missing upstream, zero-commit repos.
- `src/core/classify.ts` — `categoryOf`, `describe`, `primaryLanguage`, `kindOf`.
- `src/core/index-engine.ts` — `buildIndex`, `loadIndex`, `writeIndex`. Detects
  symlinks; no double-counting.
- `src/core/tidy.ts` — `planTidy`, `applyTidy`.
- `src/cli/open.ts` — `openInEditor`, `openInFinder`, `openInTerminal`.
- `src/cli/picker.ts` — `pick`: uses `fzf` if present on PATH, else built-in
  readline numbered picker.
- `src/raycast/` — Raycast extension (own `package.json`): list view over
  `IndexedItem`, open in editor, reveal in Finder, copy path.
- `AshlrConfig`, `IndexedItem`, `AshlrIndex`, `GitStatus`, `TidyRule`,
  `TidyMove`, `TidyPlan` types established as THE canonical contract in
  `src/core/types.ts`.
- Zero runtime dependencies in `core/` and `cli/` (Node builtins only).
- `install.sh`: idempotent symlink of `bin/ashlr` into `~/.local/bin`.


---

## Milestone Roadmap — M1 through M20 (COMPLETE)

The full M1–M20 roadmap is now complete. Every milestone shipped, all 2026 tests green.

| Milestone | Theme | Status |
|---|---|---|
| M1 | Foundation — index, navigate, config, Raycast | COMPLETE |
| M2 | Identity and model awareness — `ashlr doctor`, `ashlr init`, provider probing | COMPLETE |
| M3 | MCP aggregation gateway — single stdio entry point, namespaced tools | COMPLETE |
| M4 | Agent orchestrator — `ashlr run`, parallel DAG, budget, local-first | COMPLETE |
| M5 | Observability — `ashlr pulse`, metadata-only usage rollup, budget alerts | COMPLETE |
| M6 | Project lifecycle — `ashlr new`, `ashlr ship`, templates, deploy gate | COMPLETE |
| M7 | Shared memory / genome — `ashlr learn`, `ashlr recall`, cross-project store | COMPLETE |
| M8 | _(internal polish / test infrastructure)_ | COMPLETE |
| M9 | Hardening, CI, and polish — self-update, 932-test milestone, P0 fixes | COMPLETE |
| M10 | Ecosystem cohesion — config→env bridge, unified config projection across all tools | COMPLETE |
| M11 | Watchable, robust runs — streaming, retry+verify loop, hardened engine delegation | COMPLETE |
| M12 | Spec-driven swarms — `ashlr spec`, `ashlr swarm`, phase fan-out, resumable | COMPLETE |
| M13 | Surfaces I — interactive TUI (`ashlr tui`), real-time Raycast extension | COMPLETE |
| M14 | Surfaces II — local web dashboard (`ashlr serve`), SSE live updates, security posture | COMPLETE |
| M15 | Cost-optimal local-first routing — per-task model routing, savings forecast, `ashlr models` | COMPLETE |
| M16 | Compounding genome — auto-capture, consolidation, playbook synthesis, export | COMPLETE |
| M17 | Verified orchestration — tamper-evident signing, escalation gates, safe rollback | COMPLETE |
| M18 | Deep integrations — GitHub, Vercel, editor auto-wire, Phantom identity, notifications | COMPLETE |
| M19 | Real telemetry (OTLP) + spend governance — GenAI semantic conventions, `TelemetrySink`, `ashlr telemetry` | COMPLETE |
| M20 | One-command onboarding + self-healing — `ashlr init` capstone, `doctor --fix`, bounded runtime heal | COMPLETE |

The command surface is complete. From M1 through M20, `ashlr` grew from a local project navigator into a full agentic engineering platform — local-first, private by construction, and now trivial to adopt and self-healing in production.
