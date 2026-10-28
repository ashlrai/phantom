# CLI reference

Generated from the source CLI's `phm --help` and `phm help --all` output.
For command-specific options, run `phm help <topic>` or `phm <command> --help`.
This describes the checkout; an installed older binary may differ.

Regenerate from the repository root with:

```sh
node --import tsx scripts/generate-cli-reference.ts
```

Check without writing with the same command followed by `--check`.
Terminal colors and trailing whitespace are removed, and em dashes become hyphens.

## Overview

```text
Phantom - phm, the CLI for agentic engineers (ashlr remains compatible)

    core            Core - index, navigate, configure (index, go, status, …)
    run             Run - local-first agent runs (run, runs, …)
    swarm           Swarm - specs + multi-agent fleets (spec, …)
    memory          Memory - shared genome (recall, learn, genome, …)
    knowledge       Knowledge - portfolio RAG + graph (knowledge, ask, …)
    autonomy        Autonomy - enrollment, backlog, daemon, inbox, goals (enroll, …)
    observability   Observability - cost, telemetry, audit (pulse, …)
    integrations    Integrations - MCP, GitHub, Vercel, editors (mcp, …)
    safety          Safety - sandboxes, invariants, activation (daemon, sandbox, …)
    web             Surfaces - TUI + web dashboard (tui, dash, dashboard, …)
    scaffold        Scaffold - new projects + shipping (new, ship, …)

  phm init · phm doctor · phm verse  start here: onboard, health check, console
  phm help <topic>      full table for one topic
  phm help --search <t> find a command by keyword
  phm help --all        every command (the legacy full table)
  phm docs --agent      the agent contract cheat sheet
```

## All commands

```text
Phantom - every command (phm or ashlr)

  Core - index, navigate, configure
    index [--refresh]                                                                                              Build or refresh the desktop index; show counts by category.
    go [query] [--open|--cd]                                                                                       Find a repo or item; open in editor (--open) or print path for cd (--cd).
    status [--json]                                                                                                Attention board: dirty, off-sync, and stale repos; ecosystem summary.
    ls [category]                                                                                                  List all indexed items, optionally filtered by category.
    open [query]                                                                                                   Open the best match in your editor; no query opens an interactive picker.
    tidy [--apply]                                                                                                 Show (or apply) tidy moves for loose Desktop files.
    config [get <k>|set <k> <v>]                                                                                   Read/write a config value. No args prints a summary.
    config effective [--json]                                                                                      Read-only effective autonomy/daemon/foundry/backend settings.
    config set <k> --json <v>                                                                                      Set a structured (array/object) config value as JSON.
    config path                                                                                                    Print the path to config.json.
    doctor                                                                                                         One-glance health check: config, phantom, providers, ecosystem.
    init [--yes]                                                                                                   Idempotent onboarding: ensure config, detect phantom + models, set editor.
    desktop install [--apply]                                                                                      Inspect original signed app/CLI artifacts; explicitly install only on an empty macOS arm64 installation after Stop/drain. Does not resume authority.
    desktop-update inspect|apply --stage <32hex> --json                                                            Verify signed paired updates; apply after native exit, Stop/drain and unchanged active grant. Never resumes the resident.
    update [--check] [--json]                                                                                      Self-update; mutation requires service registration proven absent and not running. --check remains read-only.
    upgrade [--check] [--json]                                                                                     Same as update.
    runtime install --store <absolute> --artifact <absolute> --sha256 <hash> --revision <sha> --version <version>  Install exact offline candidate bytes into a private store; not production qualification or service activation.
    runtime status|rollback --store <absolute> [--json]                                                            Verify local candidate selection or explicitly restore the previous verified installation.
    runtime run --store <absolute> -- universe <args>                                                              Run Universe in the foreground using the verified installed candidate; operational commands require explicit absolute --root.
    orient [--repo <r>] [--json]                                                                                   Session-start context: genome hits, health, backlog, pending proposals, attention (read-only).
    docs --agent [--json]                                                                                          Agent cheat sheet: the CLI-first contract (commands, safety classes, JSON shapes).
    completions zsh|bash                                                                                           Print a shell completion script to stdout.
    plugins init|list|info|enable|disable                                                                          Scaffold + manage plugins (~/.ashlr/plugins/) - default-off, integrity-pinned, audited (see docs/PLUGINS.md).
    x <name> [args...]                                                                                             Run an enabled plugin's command.
    help [<topic>] [--all]                                                                                         Topic-grouped help; --all prints every command; --search <term> filters.
    version                                                                                                        Print the installed ashlr version (aliases: --version, -v).
    setup                                                                                                          Temporarily unavailable: refuses before config or wizard effects; use owner-invoked run/swarm or daemon dry-run while compiled runtime roots are empty.

  Run - local-first agent runs
    run "<goal>" [opts]                                                   Decompose goal into tasks; execute via local model (Ollama/LM Studio).
    run show <id>                                                         Print a past run in detail.
    runs [--json]                                                         List past runs (newest first).
    models [--json]                                                       List local models (Ollama/LM Studio); marks the active one.
    models pull <name> [--yes]                                            Explicitly pull an Ollama model (large download; confirm first).
    models start                                                          Best-effort start a locally-installed Ollama (never downloads).
    local-runtime <status|start|stop|restart|reshape|logs|resolve-model>  Supervise the loopback llama-server serving runtime (parallel local fleet engine); manual and attended.
    local-runtime install|uninstall                                       Add or remove the opt-in launch agent that keeps llama-server up across logout/crashes; install is refused while the kill switch is engaged.
    eval [--limit N]                                                      Local-agent eval harness: adaptive prompts OFF vs ON, steps/done/tokens (M44).
    eval attention [--window 1d|7d|30d]                                   Metadata-only fleet attention report: context pressure, retrieval, yield, routing, and traces.
    skills audit <pack-path> [--json]                                     Read-only quarantine audit for external skill structure, trigger routing, collisions, and behavioral fixtures.

  Swarm - specs + multi-agent fleets
    spec new "<goal>" [--project]  Author a versioned end-state spec artifact (local-first model).
    spec list [--project <path>]   List all spec artifacts, newest version per spec.
    spec show <id>                 Print a spec artifact in full.
    spec refine <id> "<note>"      Produce a new version of a spec incorporating the note.
    swarm "<goal>" [opts]          Decompose goal into a contracts-first DAG; run a fleet of agents.
    swarm <specId> [opts]          Run a swarm against an existing spec artifact.
    swarm show <id>                Print a past swarm run in detail.
    swarms [--json]                List past swarm runs (newest first).

  Memory - shared genome
    recall "<query>"       Search shared genome memory; return top relevant entries with scores.
    learn "<text>" [opts]  Append a note to shared genome memory (local-first, append-only).
    genome                 Genome status/health: entry count, projects covered, store size.

  Knowledge - portfolio RAG + graph
    knowledge build            Index enrolled repos locally (read-only, secret-scrubbed) for portfolio RAG.
    ask "<question>"           Local RAG across the indexed portfolio; cites repo/file:line. --allow-cloud opt-in.
    knowledge impact <target>  Show references + dependents of a file/symbol within and across enrolled repos.
    knowledge graph            Print the portfolio knowledge graph (repos/modules/deps + cross-repo findings).
    wiki build [repo] [--all]  Private architecture wiki per repo (local models; cited, verified file:line). Only stale pages rebuild.
    wiki ask "<question>"      Answer from the wiki + index + genome with verified file:line citations, or say "not found".
    wiki status [repo]         Wiki freshness: generated at <commit>, N pages stale.

  Autonomy - enrollment, backlog, daemon, inbox, goals
    enroll list                                                                                                                                                   List enrolled repos + kill switch state.
    enroll add <repo> [--locus-firm]                                                                                                                              Enroll a repo for autonomous work. First enroll soft-offers locus.firm when locus CLI is present; --locus-firm / ASHLR_LOCUS_FIRM=1 enable without prompt (default off).
    enroll remove <repo>                                                                                                                                          Remove a repo from the enrollment registry.
    enroll kill on|off                                                                                                                                            Toggle the global autonomous kill switch.
    backlog                                                                                                                                                       Scored work queue across enrolled repos (issues, TODOs, tests, deps, docs, security, plugins, goals, hygiene, invention).
    backlog refresh                                                                                                                                               Re-scan all enrolled repos and rebuild the backlog.
    release-articles status|enable|disable|import|sync [--json]                                                                                                   Configure release-backed article task handoffs; sync verifies public GitHub/npm evidence and never publishes directly.
    backlog --source <src>                                                                                                                                        Filter backlog by source: issue|todo|test|dep|doc|security|plugin|self|lint|goal|hygiene|invent.
    backlog --repo <path>                                                                                                                                         Filter backlog to a specific enrolled repo.
    backlog --limit <n>                                                                                                                                           Show only the top N items.
    backlog --json                                                                                                                                                Emit raw JSON backlog.
    inbox                                                                                                                                                         Approval inbox: list pending proposals (the outward-action gate).
    inbox show <id>                                                                                                                                               Full detail of a proposal incl. diff (read-only).
    inbox approve <id>                                                                                                                                            Confirm + apply an approved proposal to its dedicated local branch.
    inbox approve <id> --yes                                                                                                                                      Approve without interactive prompt (non-TTY safe).
    inbox submit <id>                                                                                                                                             Caller-confirm, freshly verify, and hand one signed frontier proposal to a protected PR; never merges main.
    inbox submit <id> --yes                                                                                                                                       Records non-interactive caller intent, not an authenticated human receipt; all verification and remote gates remain.
    inbox reject <id>                                                                                                                                             Discard a pending proposal; applies nothing.
    inbox --json                                                                                                                                                  Emit JSON for inbox list, show, approve, submit, or automerge results.
    daemon start --once                                                                                                                                           Currently refuses before effects because compiled daemon trust roots are empty; use owner-invoked run/swarm or the dry-run form.
    daemon start --once --dry-run                                                                                                                                 Plan only: which backlog items WOULD be worked (no swarm/proposal).
    daemon start --once --drain diagnostic-reslices --limit 3                                                                                                     Dormant non-dry diagnostic drain; compiled daemon trust roots are empty.
    daemon stop                                                                                                                                                   Halt the daemon: set kill switch + clear running state.
    daemon status                                                                                                                                                 Daemon roll-up: running?, today's spend vs cap, pending proposals.
    daemon service-status                                                                                                                                         Read-only OS service state; remains available during the resident-mutation restriction.
    daemon uninstall                                                                                                                                              Remove an existing OS service; remains available during the resident-mutation restriction.
    daemon install                                                                                                                                                Temporarily unavailable: install/reinstall/repair/restart authority is withheld.
    daemon recover-state --dry-run|--execute                                                                                                                      Preview or explicitly execute one exact quarantine of a malformed daemon state (the fix when `daemon status` shows a state issue).
    daemon resolve-state --dry-run|--execute                                                                                                                      Preview or explicitly resolve one exact quarantine, restoring daemon state after `daemon recover-state`.
    worker setup                                                                                                                                                  Temporarily unavailable and fail-closed before config, enrollment, queue, wizard, or service mutation.
    fleet status [--json]                                                                                                                                         Read-only fleet snapshot: daemon, per-backend dispatches+quota, queue, proposals, merges, paused state.
    fleet evidence doctor <source>                                                                                                                                Bounded read-only diagnosis for one decisions, judge, action, dispatch, manifest, or candidate ledger.
    fleet direction [--json]                                                                                                                                      Read-only autonomous direction report: mode, resource posture, guard blocks, and next actions.
    fleet automerge-canary status|prepare-shadow|activate-shadow|halt                                                                                             Prepare or operate the bounded observation-only shadow canary; enforce mode remains unsupported.
    fleet pause                                                                                                                                                   Pause the fleet: engage the global kill switch (idempotent).
    fleet resume                                                                                                                                                  Resume the fleet: release the global kill switch (idempotent).
    recovery list|inspect                                                                                                                                         Inspect bounded metadata-only prepared/committed tool-effect evidence.
    recovery attest|abandon                                                                                                                                       Record an exact interactive terminal no-replay disposition for one prepared effect.
    goals add <objective>                                                                                                                                         Register a high-level OBJECTIVE (goal); decomposed into ordered milestones (local, no LLM by default).
    goals plan <id>                                                                                                                                               Decompose a goal into ordered milestones + author/link each milestone spec (LOCAL-FIRST; --allow-cloud to use cloud).
    goals advance <id>                                                                                                                                            Advance the next actionable milestone via a SANDBOXED, proposal-only swarm (ENROLLED repos only; emits a PENDING proposal).
    goals status [id]                                                                                                                                             Read-only roll-up of goal/milestone progress + linked swarm/proposal state (mutates nothing).
    goals recover-stale                                                                                                                                           Reset stale proposal-less in-progress goal lanes back to pending so the fleet can advance them again.
    goals repair-timestamps                                                                                                                                       Linux/macOS-only dry-run or exact-plan repair for stale goal updatedAt values (offline, byte-surgical, backed up).
    roadmap <run|resume|status>                                                                                                                                   Goal Loop: run a roadmap of milestone files, one FRESH agent process per milestone; resumable from state.json (LOCAL-FIRST; --allow-cloud for API engines).
    goal "<objective>"                                                                                                                                            Live owner-invoked objective → plan → one sandboxed proposal-only advance; never resident or unattended authority.
    goal "<objective>" --direct                                                                                                                                   One owner-invoked proposal-only run with bounded --json output; no unattended authority or verification proof.
    loop                                                                                                                                                          Dormant non-dry conductor loop: compiled conductor trust roots are empty; use loop --dry-run.
    loop leases [clear <task-id>] [--dry-run]                                                                                                                     List simple-conductor leases needing reconciliation; clear one only when its owner is provably not running.
    conductor-permit request|mint|inspect|stage                                                                                                                   Dormant signed one-shot goal-conductor permit operator; fail-closed while source trust roots are empty.
    website status|auto|pause|off                                                                                                                                 Inspect or pause automatic phm.dev publication; Auto resumes within its existing signed website scope.
    website prepare --image <digest>                                                                                                                              Qualify the fixed website publisher and a real offline Linux x64 production build before one-time commissioning.
    authority status [--json]                                                                                                                                     Standing authority: grant state, autonomy switch, Stop, rollout stage, ledger chain and custody (read-only).
    authority switch <off|propose|autonomous>                                                                                                                     Lower autonomy instantly; raise it only up to what the signed grant allows (past it needs Touch ID).
    authority stop|clear-stop                                                                                                                                     Engage Stop (~/.ashlr/KILL: halts running agents, cancels armed merges) or clear it; stopping never asks, clearing is ledgered first.
    authority grant|re-approve [--yes]                                                                                                                            Sign a standing grant (or its continuation) with Touch ID via ashlr-custody and install it; fail-closed while compiled trust roots are empty.
    authority revoke [--reason <text>]                                                                                                                            Engage Stop, switch autonomy off and require a new signed grant (Touch ID) to resume.
    authority ledger verify|tail                                                                                                                                  Verify or read the hash-chained authority ledger (~/.ashlr/authority/ledger.jsonl).
    authority protect --print|--apply                                                                                                                             Print (or apply after confirmation) the GitHub rulesets for the grant's server-enforced repos.
    authority setup [--dry-run [--json]]                                                                                                                          Guided Phase 0: custody key, trust-root PR, GitHub App, Claude token, canary, rulesets, first grant, switch, daemon service - asks before every step; --dry-run --json prints the checklist as JSON.
    leader show|run|tick|veto                                                                                                                                     The Leader (Visionary): show the latest memo and actions, run it now, apply due class-B actions (tick), veto an action or a whole memo (--memo).
    leader say|thread|answer|approve|directives                                                                                                                   Talk to the Leader in the one thread Phantom and Telegram share: say something, read the thread, answer a memo question, approve a pending action (applied only if the grant allows), add or retire standing directives.
    leader oversight-plist --print                                                                                                                                Print (never install) the nightly ai.ashlr.oversight LaunchAgent that runs `ashlr leader tick --wait` instead of the legacy Strategist; install by hand per docs/AUTHORITY.md.
    cloud launch "<task>" [--repo o/n] [--base b]                                                                                                                 Start a Claude Code cloud session that delivers a draft PR (spends Claude credits; never merges). Repo defaults to this folder's GitHub origin.
    playbook list|show|new|edit|run <id>                                                                                                                          Versioned task templates every lane runs under (`!fix-bug` in any task text): list them, show one with per-version outcomes, write a new version in $EDITOR, or run one in the cloud / Devin lane (`--repo o/n --lane cloud|devin`).
    openai-agents sessions|inspect|turns [session-id] [--json]                                                                                                    Read bounded managed OpenAI Agents API metadata. API access is separate from subscriptions; no execution qualification or mutations.
    benchmark run|--compare-reports                                                                                                                               Explicit local-agent benchmark trials, or offline matched-receipt comparison; real checkers and private traces.
    devin connect [--org org-…]                                                                                                                                   Connect Devin (Cognition): paste the API key at a hidden prompt; it is verified and stored in the macOS Keychain, never in a file.
    devin launch "<task>" [--repo o/n] [--base b]                                                                                                                 Start a Devin session that delivers a PR on ashlr-devin/<id> through the standing gates (spends ACUs, hard-capped per session; never merges).
    automations list|templates|add|enable|disable|remove                                                                                                          Automations: labelled issues, a red default branch, RRULE schedules, a local webhook or Telegram /task become tasks for the fleet, cloud, Devin or review - with queue, per-day, concurrency and spend limits.
    automations fire <id> [--dry-run]                                                                                                                             Check one automation's trigger now and dispatch what it finds through the lane's own gates (grant, KILL, budgets); --dry-run shows what would happen and writes nothing.
    jev status [--json]                                                                                                                                           Jev (TypeSafe) typed decisions today: on/keyed, decisions by kind, avg confidence, fallback rate, est. cost, latency. Reads the local ledger only.
    jev test "<text>" [--kind intent|task-class|engine-error|lane|claim|triage]                                                                                   One live Jev decision on the text (one paid call when keyed): shows the label, confidence and whether Jev or the deterministic rule won.
    devin status|list|refresh|message|budget|fleet                                                                                                                Devin connection and readiness, tasks and their PRs, a status refresh, replies to waiting sessions, the ACU budget, and whether the fleet may launch sessions.
    cloud list|refresh|improve|budget|backlog                                                                                                                     Cloud tasks and their PRs, a GitHub refresh, self-improvement launches (--count N), the credit budget (an estimate; flags update it) and the backlog.
    mirror list|add|sync|path|remove|reconcile                                                                                                                    The fleet's own mirror clones under ~/.ashlr/fleet/mirrors (your checkouts are never touched); reconcile plans enrollment from the grant (--apply).
    vision <show|review|preview|shadow|approve|reconcile|set>                                                                                                     Mission OS: inspect strategy, preview a bounded DAG, record observation-only shadow evidence, or explicitly adopt planning state.
    manager [--apply-rejects]                                                                                                                                     Frontier judge scorecard over pending proposals (shadow mode by default; never merges).
    best-of-n [--repo --title -n]                                                                                                                                 Generate N candidate diffs (multi-model), critic-select, file the winner as a proposal (M142/M333).
    comms <status|cycle|digest>                                                                                                                                   Operator comms channel (Telegram/iMessage): digests, approve-by-text.
    director                                                                                                                                                      Retired - the Leader handles this (see `ashlr leader`). Still prints the read-only fleet god-view; sends nothing.
    invent                                                                                                                                                        Generative backlog invention - propose novel high-value work items.
    universe <demo|init|run|status|archive>                                                                                                                       Local experiment evolution: run competing code variants, measure them, and reuse winning artifacts.
    universe console --root <absolute> [--port N] [--json]                                                                                                        Foreground read-only Universe console on loopback; explicit root, ephemeral port by default, no service activation.
    universe graph <id> [--node <node-id>]                                                                                                                        Read-only experiment evidence graph: trace selected parents, feedback, campaigns, and local branch receipts.
    universe compare <baseline> <challenger>                                                                                                                      Compare explicit campaign outcomes and resource coverage; read-only local evidence, not production acceptance.
    universe portfolio <plan|run> --manifest <file.json>                                                                                                          Plan or run explicit campaign dependencies with foreground invocation bounds; completed campaigns are not accepted artifacts.
    universe integration plan --manifest <private-absolute.json>                                                                                                  Read-only composition of pinned local deliveries: inspect exact-path overlays and conflicts, without writing Git or claiming combined acceptance.
    universe integration evaluate --manifest <private-absolute.json>                                                                                              Evaluate one pinned combined candidate locally; durable private evidence and confirmed-settlement replay, no model generation or Git publication.
    universe integration inspect --manifest <private-absolute.json>                                                                                               Read and verify an existing evaluation receipt and digest; never starts missing work.
    universe integration deliver --manifest <private-absolute.json>                                                                                               Deliver an explicitly pinned passing combination to a new local branch, without rerunning its evaluator or advancing an existing branch.
    universe integration inspect-delivery --manifest <private-absolute.json>                                                                                      Verify a completed combined delivery and read its receipt digest without creating or reconciling branches.
    universe integration handoff --manifest <private-absolute.json>                                                                                               Register a new explicit downstream experiment from the verified combined commit, with source lineage and a fresh comparator; no execution.
    universe controller run --manifest <private-absolute.json>                                                                                                    Run an explicitly enrolled campaign DAG with a persisted deadline and dispatch checkpoints across restarts; never retry uncertain work.
    universe controller status <id>                                                                                                                               Read controller deadline, outcomes and unsettled dispatches without execution or recovery writes.
    universe campaign <init|status|run|resume|pause|stop>                                                                                                         Register, inspect, execute or request control of bounded campaigns; run/resume can pair --deliver-branch with --deliver-base for local-only delivery.
    universe campaign check <id> --root <absolute> [--json]                                                                                                       Read recorded recovery evidence only; exit 0 can include held or terminal snapshots and never grants permission to resume.
    universe resources check --resource-runtime <private-absolute.json> [--json]                                                                                  Check explicit local resource configuration without provider contact; validity is not authentication, quota or campaign admission.
    universe preparation-measurement --input <absolute-report.json> [--json]                                                                                      Read reported preparation checks and counts from one explicit file; diagnostic only, not a score or acceptance evidence. No store discovery, execution or provider calls.
    universe preparation-measurement-calibrate <id> --root <absolute> --capture <id1> --capture <id2> --capture <id3> --expected-source-digest <sha256> [--json]  Calibrate three retained diagnostic captures against their frozen seed; no execution or acceptance.
    universe preparation-measurement-compare <id> --root <absolute> --capture <id> --calibration <absolute-json> [--json]                                         Compare a captured candidate with full artifact scope and region regression checks; diagnostic only.
    universe campaign supervise <id> [id ...] --root <absolute> --max-duration-ms <N> [--delivery-plan <private-absolute.json>]                                   Bounded foreground supervision of a fixed queue; optional plan reconciles completed local branch deliveries without rerunning workers.
    universe deliver <id> --trial <elite-trial-id> --branch codex/<name>                                                                                          Explicitly write the exact current elite to a local branch; no checkout change, merge, push or deployment.
    universe deliveries <id> [--root <path>] [--json]                                                                                                             Read local delivery receipts; pending/degraded evidence is not completed or verified delivery.
    reflect [--since <Nd>]                                                                                                                                        Score your OWN past runs/swarms locally; report effectiveness/cost deltas (read-only).
    reflect playbooks [--persist]                                                                                                                                 Distill repeatable playbooks from past swarms (report-only; --persist writes them to the genome).
    reflect propose                                                                                                                                               Emit routing/policy/prompt tuning suggestions as PENDING inbox proposals (never auto-applies).
    health                                                                                                                                                        Score every ENROLLED repo on quality (tests/docs/deps/security/debt/CI/conventions); ranked, read-only.
    health <repo>                                                                                                                                                 Per-repo health detail with the per-dimension breakdown + worst offenders (ENROLLED only).
    health propose                                                                                                                                                Emit deterministic safe-fix advisories as PENDING inbox proposals (never auto-applies).
    digest                                                                                                                                                        Write an ORG-LEVEL portfolio digest (health, goals, costs, today) to ~/.ashlr/digests/ (LOCAL-FIRST; reads only).
    digest --notify                                                                                                                                               Also deliver the digest via a configured Slack/Discord webhook (OPT-IN; no-op when unconfigured).

  Observability - cost, telemetry, audit
    pulse [--window 1d|7d|30d]                                            Local observability dashboard: tokens, cost, sessions, commits.
    pulse --json                                                          Machine-readable ActivityRollup (+ additive .forecast field; Raycast Pulse view).
    pulse --project <name>                                                Restrict pulse rollup to a single project.
    pulse-export                                                          Fleet→pulse OTLP backfill/manual export.
    pulse-test                                                            Fleet→pulse connectivity + auth probe (read-only).
    resources [--json] [--watch]                                          Per-backend resource control plane: availability/used%/cap/resets-in (read-only god-view).
    usage                                                                 Frontier usage table: per-engine calls/tokens/cost + window state.
    telemetry [status]                                                    M19: endpoint+PAT configured (bool), sink mode, local JSONL count, governance.
    telemetry test                                                        Emit a synthetic metadata-only test span; report sink+ok.
    audit [N] [--json] [--action <verb>] [--result <r>] [--since <when>]  Tail the append-only audit trail (newest-first); filter by action/result/since (read-only).
    receipt list|status|show <run>|verify <run>|timeline <run> [--json]   Read and verify signed run receipts (same as fleet receipt); timeline lists custody spawns in the run window, value-free (read-only).

  Integrations - MCP, GitHub, Vercel, editors
    mcp                                                                              Run the MCP aggregation gateway on stdio (point any agent here; includes the native ashlr_* tools; list them with tools/list).
    mcp list                                                                         List native ashlr tools + discovered MCP servers with per-server tool counts.
    mcp doctor                                                                       Per-server MCP health: does it start? how many tools?
    improve propose [--open-pr --repo <dir>]                                         Self-improvement loop: evidence-backed proposals ranked by realized leverage; --open-pr opens DRAFT PRs from an isolated worktree.
    improve register|measure|outcomes|promote|sync-backlog|discover|observe|lessons  Record a proposal's deterministic metric, measure it at the PR's exact merge base and head, record merges and the reverts that cancel their credit, compare proposers against the deterministic baseline, register cloud backlog PRs that declare a metric, add backlog items from member issues, a red default branch and proposals, compare cloud runs served lessons against the holdout run without them, and queue auto-merge only when checks are green and the metric improved.
    steward disk [--apply] [--json]                                                  Measure Codex/Claude/Phantom log roots against retention + quota; dry run unless --apply (deletes oldest eligible files only).
    team <view|join|approve|claim|release|say>                                       Local-first team bus: presence, repo/branch/path claims, handoffs and human approval of consequential agent actions.
    companions [--json] [--root <dir>] [--bin-dir <dir>]                             Read-only Secrets/Locus/Lexicon executable identity and version inventory; no runtime readiness or activation.
    mcp install <claude|ashlrcode>                                                   Add the ashlr gateway to a target mcpServers config (backs up first).
    gh <pr|issue|ci>                                                                 Read GitHub open PRs, issues, or CI status for the current repo (read-only).
    gh pr create                                                                     Create a PR via gh CLI - explicit + confirm-gated (the only gh mutation).
    vercel <ls|logs>                                                                 Read recent Vercel deployments or latest build logs (read-only).
    wire [claude|codex|cursor|all]                                                   Wire ashlr MCP gateway into editor config(s); defaults to detected editors.
    wire status [claude|codex|cursor|all]                                            Read-only report of whether each editor is wired to the ashlr gateway.
    wire --claude-md                                                                 Print a CLAUDE.md snippet teaching agents the CLI-first ashlr usage (read-only).
    notify test                                                                      Send a test ping to the configured webhook(s); no-op if none are set.
    stack [status|list|providers|recommend|scan|doctor|add|apply]                    Ecosystem `stack` tool surface: read-only status/list/recommend, confirm-gated add/apply (real provisioning).
    ecosystem doctor [--json] [--deep]                                               Read-only sibling-repository health scan across the ecosystem.

  Safety - sandboxes, invariants, activation
    daemon activation-preflight --request <path> [--json]                              Read-only verification of operator-custodied signed candidate and rollback artifacts; grants no service authority.
    daemon activate --request <path> --authorize <digest> --confirm <digest> [--json]  Dormant permit-gated 3.2.7 selection; preserves loaded=false and the exact disabled bit, and never starts a service.
    sandbox list                                                                       List active git-worktree sandboxes (M21 safety foundation).
    sandbox diff <id>                                                                  Show diff of a sandbox vs its base HEAD.
    sandbox cleanup <id>                                                               Remove a sandbox worktree and scratch branch.
    sandbox gc                                                                         Reclaim STALE orphan sandboxes (crash leftovers); H5 explicit human repair surface for the orphan sweep.
    seams                                                                              Cloud-ready seam diagnostic: every v2 store, active=local, cloud=gated (read-only).
    seams status                                                                       Same as `seams`: list seams + active impl; proves local-first + cloud gated on Mason.
    verify-safety                                                                      Read-only self-check of the hard safety invariants (enrollment/kill-switch/daemon/scrub/cloud-gate); mutates nothing.
    verify-pr                                                                          Verify an explicitly reviewed maintainer PR through the host-owned App check; no merge or deploy.
    preflight [--json]                                                                 Read-only first-activation readiness check: ready=true|false + blockers/warnings (model/enrollment/kill/daemon/writeable/sandbox/git/phantom/locus); mutates nothing.
    onboard [--locus-firm]                                                             Guided first safe activation: preflight → enroll ONE repo → optional Locus firm soft-offer → dry-run PLAN → point at `ashlr inbox`. TTY-aware; --yes/non-TTY prints steps (firm only with --locus-firm or ASHLR_LOCUS_FIRM=1). NEVER auto-applies.
    onboard --rollback <repo>                                                          One-command undo of a first activation: unenroll + sweep orphan sandboxes + optional --kill. Inward cleanup only; H6-audited.
    demo [--no-cleanup] [--json]                                                       Watch the FULL autonomous chain run on a DISPOSABLE tmp repo (isolated tmp ~/.ashlr; proposal-only; auto-cleans). NEVER touches your portfolio or applies anything.

  Surfaces - TUI + web dashboard
    tui [--once]                  Interactive terminal dashboard (alias: dash). --once renders one frame and exits.
    dash [--once]                 Alias of `tui` - interactive terminal dashboard.
    dashboard [--stop|--status]   Open the persistent fleet dashboard service (ai.ashlr.serve); --status/--stop inspect or unload it (no install/repair - resident mutation is withheld).
    serve [--port N]              Start local web dashboard + JSON API on 127.0.0.1 (default port 7777).
    serve --open                  Start dashboard and open browser automatically.
    serve --allow-dispatch        Enable guarded POST /api/run + web inbox approve/reject (prints session token).
    verse [--port N] [--no-open]  Open the Phantom console at /verse/ for connected coding resources. Runs use account readiness and authority; prints read + mutation tokens.

  Scaffold - new projects + shipping
    new <name> [opts]   Scaffold a project from a template (next-app, node-cli, mcp-server, minimal).
    ship [path] [opts]  Pre-ship gate (lint/test/build) + optional confirm-gated deploy.

  run flags: --budget N  --max-steps N  --parallel N  --engine builtin|ashlrcode|aw|claude|codex  --allow-cloud  --no-tools  --no-memory  --resume <id>  --estimate  --json  --over-budget
  swarm flags: --budget N  --parallel N (positive safe integer; default 3)  --background  --resume <id>  --dry-run  --estimate  --allow-cloud  --project <path>  --over-budget
```
