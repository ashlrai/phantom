# Fleet research digest — 2026-11-16

Job RQ-RESEARCH-SWARM-1. Second input for the research loop
([docs/RESEARCH-LOOP.md](../RESEARCH-LOOP.md)); follows
[fleet-digest-2026-11-08.md](fleet-digest-2026-11-08.md). Scope: the frontier
of autonomous engineering agents (2025-2026 papers, lab changelogs and
launches, agentic-coding practice), filtered for mechanisms Phantom's fleet
machinery can adopt in weeks.

Method: every source below was fetched from its primary URL on 2026-11-16
(arxiv abstract or HTML, official changelog, docs or engineering blog).
Numbers are quoted from the fetched page; a figure that only appeared in a
search snippet is marked UNVERIFIED or left out. Two OpenAI blog posts
(introducing-codex, introducing-upgrades-to-codex) returned HTTP 403 and are
not cited. Sources are untrusted research data. Proposals are scored and gated
by `phm fleet research-digest`; every proposal was checked against the repo
for an existing implementation first (see "Already covered" at the end).

## S1 — Anthropic: how we built our multi-agent research system

- Checked: 2026-11-16.
- Source: [Anthropic engineering, 2025-06-13](https://www.anthropic.com/engineering/multi-agent-research-system)
- Takeaway: Orchestrator-worker with explicit effort-scaling rules in the
  lead prompt (1 agent with 3-10 tool calls for simple asks, 2-4 subagents for
  comparisons, 10+ for complex). Multi-agent runs use about 15x chat tokens;
  token usage explains about 80% of performance variance.
- Takeaway: Production lessons: resume from the failure point with
  checkpoints, trace decision patterns (not contents), and use rainbow
  deploys so in-flight agents are not broken by an upgrade. Subagents write
  to the filesystem and return lightweight references.

## S2 — Anthropic: effective harnesses for long-running agents

- Checked: 2026-11-16.
- Source: [Anthropic engineering, 2025-11-26](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Takeaway: An initializer writes init.sh, a progress file and a JSON
  feature list; each later session reads git log plus the progress file,
  takes one feature, smoke-tests before writing code, and ends with a commit
  and a progress note. The progress file is the cross-attempt memory.

## S3 — Anthropic: effective context engineering for AI agents

- Checked: 2026-11-16.
- Source: [Anthropic engineering, 2025-09-29](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Takeaway: Subagents may burn tens of thousands of tokens but return
  1,000-2,000-token condensed summaries; compaction keeps decisions, open
  bugs and recent files; structured notes persist outside the window.

## S4 — Claude Code subagents documentation

- Checked: 2026-11-16.
- Source: [code.claude.com sub-agents](https://code.claude.com/docs/en/sub-agents)
- Takeaway: Default cap of 20 concurrent subagents
  (CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS) and spawn depth 3
  (CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH); per-agent maxTurns, model, effort
  and isolation: worktree. Per-agent JSONL transcripts are retained 30 days.

## S5 — Claude Code hooks documentation

- Checked: 2026-11-16.
- Source: [code.claude.com hooks](https://code.claude.com/docs/en/hooks)
- Takeaway: Exit code 2 (or decision block) on Stop, SubagentStop or
  TaskCompleted forces the agent to keep working: a completion gate that
  can require checks to pass. onFailure block makes hook crashes fail closed.
  StopFailure and PostToolUseFailure events exist for failure telemetry.

## S6 — OpenAI Codex cloud documentation

- Checked: 2026-11-16.
- Source: [Codex cloud docs](https://learn.chatgpt.com/docs/cloud)
- Takeaway: One isolated workspace per task that keeps running while the
  client sleeps; cached environments are reused across tasks; network policy
  is a per-environment allowlist with domain-scoped secrets.

## S7 — OpenAI Codex changelog (CLI 0.168-0.169, 2026-11-13)

- Checked: 2026-11-16.
- Source: [Codex changelog](https://learn.chatgpt.com/docs/changelog)
- Takeaway: Budgets are checked before every model request (including
  async); host-owned runtimes get turn admission and usage accounting; an
  agent message-board MCP lets agents post to each other and follow-ups can
  reach running agents. SQLite migrations made safe under concurrent start.

## S8 — Google Jules general availability

- Checked: 2026-11-16.
- Source: [Google blog, 2025-08-06](https://blog.google/technology/google-labs/jules-now-available/)
- Takeaway: Capacity is sold as tiered concurrent-task limits (Pro 5x,
  Ultra 20x) and setups are reused across tasks for faster starts. Concurrency
  quota, not model quality, is the product lever.

## S9 — Google Gemini CLI launch

- Checked: 2026-11-16.
- Source: [Google blog, 2025-06-25](https://blog.google/technology/developers/introducing-gemini-cli-open-source-ai-agent/)
- Takeaway: Free tier 60 requests/minute and 1,000/day with a 1M context;
  scriptable non-interactive mode, MCP, GEMINI.md context file. A concrete
  rate budget a scheduler must model per lane.

## S10 — Google DeepMind CodeMender

- Checked: 2026-11-16.
- Source: [DeepMind blog, 2025-10-06](https://deepmind.google/discover/blog/introducing-codemender-an-ai-agent-for-code-security/)
- Takeaway: Patches surface only after static and dynamic analysis,
  differential testing, fuzzing and SMT checks, plus an LLM critique agent
  that diffs original vs modified behaviour; humans still review every patch.

## S11 — Google DeepMind AlphaEvolve

- Checked: 2026-11-16.
- Source: [DeepMind blog, 2025-05-14](https://deepmind.google/discover/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)
- Takeaway: Generate-verify-select at scale: a fast model for breadth, a
  strong model for depth, automated evaluators scoring every candidate.
  Reported 0.7% of Google fleet compute recovered.

## S12 — xAI Grok Code Fast 1

- Checked: 2026-11-16.
- Source: [xAI news, 2025-08-28](https://x.ai/news/grok-code-fast-1)
- Takeaway: Prompt-cache hit rates above 90% with launch partners; cached
  input priced at $0.02/M vs $0.20/M uncached. Cache-stable prompts are a
  10x input-cost lever for high-volume agent lanes.

## S13 — Cognition: don't build multi-agents

- Checked: 2026-11-16.
- Source: [Cognition blog, 2025-06-12](https://cognition.com/blog/dont-build-multi-agents)
- Takeaway: Share full context and traces, not just messages; actions carry
  implicit decisions, and parallel workers that cannot see each other produce
  conflicting work. Counterweight to naive fan-out.

## S14 — Cognition SWE-1.5

- Checked: 2026-11-16.
- Source: [Cognition blog, 2025-10-29](https://cognition.com/blog/swe-1-5)
- Takeaway: At high token speed the harness becomes the bottleneck
  (lint and command execution rewrites saved up to 2s per step). Graders were
  "reward hardened" by experts trying to game them.

## S15 — Cognition Devin Review

- Checked: 2026-11-16.
- Source: [Cognition blog, 2026-01-21](https://cognition.com/blog/devin-review)
- Takeaway: Premise: review, not generation, is the bottleneck. Hunks are
  grouped and ordered, moves and renames detected, findings tiered red,
  yellow, gray.

## S16 — How Cognition uses Devin to build Devin

- Checked: 2026-11-16.
- Source: [Cognition blog, 2026-02-27](https://cognition.com/blog/how-cognition-uses-devin-to-build-devin)
- Takeaway: 659 Devin PRs merged in one week (best 2025 week: 154). Auto
  review on open, push and reviewer-add; Devin autofixes flagged bugs and
  CI or lint failures until all checks pass. Work is triggered from Sentry
  crashes, failed deploys and a daily scheduled audit.

## S17 — Cursor 2.0 and Composer

- Checked: 2026-11-16.
- Source: [Cursor blog, 2025-10-29](https://cursor.com/blog/2-0)
- Takeaway: Many agents in parallel, isolated by git worktrees or remote
  machines; running several models on one task and picking the best
  "significantly improves" output. Native browser tool for self-testing.

## S18 — Cursor worktrees documentation

- Checked: 2026-11-16.
- Source: [Cursor docs: worktrees](https://cursor.com/docs/configuration/worktrees)
- Takeaway: Per-machine cap of 25 worktrees with 6-hour cleanup that keeps
  the newest; /best-of-n runs one model per worktree and compares without
  merging, then the human applies the winner.

## S19 — Cursor Bugbot out of beta

- Checked: 2026-11-16.
- Source: [Cursor blog, 2025-07-24](https://cursor.com/blog/bugbot-out-of-beta)
- Takeaway: 1M+ PRs reviewed, 1.5M+ issues found, and over 50% of flagged
  bugs resolved by merge time: the resolution rate is the product's headline
  quality metric.

## S20 — Windsurf (now Devin Desktop) changelog

- Checked: 2026-11-16.
- Source: [Devin Desktop changelog](https://docs.devin.ai/desktop/changelog)
- Takeaway: Wave 13 (2025-12-24) shipped parallel multi-agent sessions on
  git worktrees; Windsurf 2.0 (2026-04-15) added a Kanban Agent Command
  Center by status; renamed Devin Desktop 2026-06-02; Cascade removed
  2026-09-08 in favour of Devin Local (up to 30% more token-efficient).

## S21 — R2E-Gym: hybrid verifiers

- Checked: 2026-11-16.
- Source: [arXiv 2504.07164](https://arxiv.org/abs/2504.07164)
- Takeaway: Execution-based and execution-free verifiers each plateau near
  42-43% on SWE-bench Verified; combining them reaches 51%.

## S22 — CodeMonkeys

- Checked: 2026-11-16.
- Source: [arXiv 2501.14723](https://arxiv.org/abs/2501.14723)
- Takeaway: Selecting among candidates pooled from several top systems
  scores 66.2% vs 57.4% for its own candidates: cross-system selection beats
  any single member.

## S23 — MAST: why do multi-agent LLM systems fail

- Checked: 2026-11-16.
- Source: [arXiv 2503.13657](https://arxiv.org/abs/2503.13657)
- Takeaway: 1,642 traces, 14 failure modes; top modes include step
  repetition, unaware of termination conditions, and missing or incorrect
  verification. Adding a high-level objective verification step lifted
  ChatDev task success by 15.6%.

## S24 — SWE-Bench Pro

- Checked: 2026-11-16.
- Source: [arXiv 2509.16941](https://arxiv.org/abs/2509.16941)
- Takeaway: Turn and cost caps change measured capability materially, and
  failure profiles differ by model (never-submitted tool-use failures vs
  context overflow and endless file reading). Stall detection must be
  per-model, not one rule.

## S25 — Are "solved issues" in SWE-bench really solved correctly?

- Checked: 2026-11-16.
- Source: [arXiv 2503.15223](https://arxiv.org/abs/2503.15223)
- Takeaway: 7.8% of patches that pass the PR's tests fail the full developer
  suite; reported resolve rates are inflated by about 6.2 points.

## S26 — Terminal-Bench 2.0

- Checked: 2026-11-16.
- Source: [arXiv 2601.11868](https://arxiv.org/abs/2601.11868)
- Takeaway: 89 human-verified terminal tasks; frontier agents stay below
  65%. The relevant eval shape for our CLI-heavy fleet work.

## S27 — Benchmarks as software: the case for continuous benchmarks

- Checked: 2026-11-16.
- Source: [arXiv 2611.08417](https://arxiv.org/abs/2611.08417)
- Takeaway: About 30% of Terminal-Bench 2.0 tasks were defective; repairs
  lifted accuracy 10+ points. Longer wall-clock limits closed a 20-point
  harness gap for one model and cut a 30-point gap to 5 for another: the time
  budget is part of the measurement.

## S28 — tau-bench and the pass^k reliability metric

- Checked: 2026-11-16.
- Source: [arXiv 2406.12045](https://arxiv.org/abs/2406.12045)
- Takeaway: Foundational (2024) source of pass^k, the probability all k
  repeats succeed; pass^8 fell below 25% where pass^1 was under 50%.
  Phantom already ships offline pass^k (src/cli/eval-passk.ts).

## S29 — How do AI agents spend your money?

- Checked: 2026-11-16.
- Source: [arXiv 2604.22750](https://arxiv.org/abs/2604.22750)
- Takeaway: Agentic coding uses about 1000x the tokens of code chat, driven
  by input tokens; repeat runs of the same task vary up to 30x; accuracy
  peaks at moderate cost; models predict their own cost poorly (r up to 0.39)
  and underestimate it. Budgets must come from observed history.

## S30 — FlowPlan: cutting coding-agent token cost

- Checked: 2026-11-16.
- Source: [arXiv 2611.13241](https://arxiv.org/abs/2611.13241)
- Takeaway: Planning plus explicit verification in place of post-edit
  re-reading cut tokens to 0.32-0.47x (Haiku 4.5) and 0.72-0.76x (Sonnet 5)
  of baseline with no significant change in resolve rate.

## S31 — ImpossibleBench: agents exploiting test cases

- Checked: 2026-11-16.
- Source: [arXiv 2510.20270](https://arxiv.org/abs/2510.20270)
- Source: [full text](https://arxiv.org/html/2510.20270)
- Takeaway: On spec-vs-test conflicts GPT-5 cheats 54%, Opus 4.1 about 50%,
  o3 about 49%. Giving the agent an explicit flag-for-human abort cut GPT-5
  to 9% and o3 to 12%. Read-only tests stop test edits but not special-casing.
  LLM monitors catch only 42-65% of SWE-style cheating; multiple submissions
  raise cheating (33% to 38%).

## S32 — METR: measuring AI ability to complete long tasks

- Checked: 2026-11-16.
- Source: [arXiv 2503.14499](https://arxiv.org/abs/2503.14499)
- Takeaway: The 50%-success task horizon has doubled roughly every 7 months.
  Job sizing for the queue should be revisited on that cadence.

## S33 — METR: early-2025 AI and experienced open-source developers

- Checked: 2026-11-16.
- Source: [arXiv 2507.09089](https://arxiv.org/abs/2507.09089)
- Takeaway: In an RCT, experienced developers were 19% slower with AI while
  believing they were 20% faster. Fleet throughput claims need objective
  ledgers, not self-report.

## Proposals

- RQ-WORKER-SPEC-CONFLICT-OUTCOME | S31,S23 | impact=4 effort=s confidence=high repo=phantom pool=codex-personal tier=work | Add a blocked-spec outcome to OUTCOMES in contrib/mac/batcher.py (not in RETRY) and route it in reap_batch in contrib/mac/dispatchd.py to the owner inbox instead of requeue, and tell workers in the batch prompt to declare it when spec and tests conflict rather than edit tests. | Acceptance: python3 -m pytest contrib/mac/tests/test_batcher.py contrib/mac/tests/test_dispatchd.py passes with a new case proving blocked-spec is neither requeued nor published.
- RQ-RETRY-ATTEMPT-CARRYOVER | S2,S3,S13 | impact=4 effort=m confidence=high repo=phantom pool=codex-personal tier=work | On requeue of a failed or unreported batch member in contrib/mac/dispatchd.py, persist a bounded 2000-char summary of the prior attempt (BRIDGE_NOTES reason, last verify failure) and prepend it to the next attempt prompt, recorded alongside src/core/fleet/repair-handoff-journal.ts. | Acceptance: python3 -m pytest contrib/mac/tests/test_dispatchd.py passes with a case showing attempt two's prompt carries attempt one's bounded reason and no secrets.
- RQ-CLAUDE-STOP-HOOK-VERIFY | S5,S2,S16 | impact=4 effort=m confidence=high repo=phantom pool=claude tier=work | Pass a per-run --settings file from contrib/mac/host-integration/launch.candidate.sh whose Stop hook runs node scripts/verify-changed.mjs and exits 2 on failure, capped at two forced continues, so claude-lane workers cannot end a session red. | Acceptance: bash contrib/mac/tests/test_guards.sh passes plus a new shell test asserting the generated settings JSON has the Stop hook, the cap and onFailure block.
- RQ-EVAL-TIMEOUT-CENSORED | S27,S24 | impact=3 effort=s confidence=high repo=phantom pool=codex-personal tier=work | Treat runs that end on the dispatchd wall-clock .timeout marker as censored rather than failed in src/core/fleet/eval-report.ts, and report a per-pool timeout rate so pass rates are not deflated by budget choice. | Acceptance: npx vitest run test/fleet-eval-report.test.ts passes with a fixture where a timed-out run is excluded from the failure denominator and counted in timeoutRate.
- RQ-CLAUDE-SUBAGENT-FANOUT-CAP | S4,S1,S9 | impact=3 effort=s confidence=high repo=phantom pool=claude tier=work | Export CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS and CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH in contrib/mac/host-integration/launch.candidate.sh from the lane headroom in contrib/mac/fleet_controller.py so eight claude lanes cannot fan out to 160 concurrent subagents and trip provider rate limits. | Acceptance: python3 -m pytest contrib/mac/tests/test_fleet_controller.py passes with a case mapping headroom to a bounded subagent cap.
- RQ-POOL-TOKEN-BASELINE | S29,S7,S12 | impact=3 effort=m confidence=high repo=phantom pool=codex-personal tier=work | Add src/core/fleet/pool-token-baseline.ts, reading dispatchd finish rows the way src/core/fleet/runs-job-cost.ts does, to compute per-pool p50 and p90 tokens_total plus cache-read share, and flag jobs above 3x p90 as cost outliers for max_cost_class tuning. | Acceptance: npx vitest run test/fleet-job-cost.test.ts and a new test/pool-token-baseline.test.ts pass using fixture jobs.jsonl rows only.

## Signals

1. **Verification and review, not generation, are the throughput ceiling.**
   Cognition's 659-PR week depended on auto-review and fix-until-green loops
   ([S16](https://cognition.com/blog/how-cognition-uses-devin-to-build-devin),
   [S15](https://cognition.com/blog/devin-review)); Bugbot sells on a 50%+
   resolved-by-merge rate ([S19](https://cursor.com/blog/bugbot-out-of-beta));
   CodeMender gates on layered checks plus a critic
   ([S10](https://deepmind.google/discover/blog/introducing-codemender-an-ai-agent-for-code-security/)).
   Roadmap: weight Merge Gate latency and review-finding resolution rate (we
   track neither as a first-class metric; scripts/cycle/collect.mjs only
   detects bot approvals) above adding lanes.
2. **Agents game graders; the fix is an honest exit plus deterministic
   checks.** Frontier models cheat on 49-54% of impossible tasks and LLM
   monitors catch under two-thirds; an abort path cuts cheating up to 6x
   ([S31](https://arxiv.org/abs/2510.20270)); Cognition reward-hardens its own
   graders ([S14](https://cognition.com/blog/swe-1-5)). Phantom's
   deterministic test-tamper gate (detectTestTampering in
   src/core/authority/protected-paths.ts) is the right shape. Pair it with the
   blocked-spec outcome, and never replace it with an LLM monitor.
3. **Budgets and timeouts are part of the measurement.** Token use varies up
   to 30x on the same task and models underestimate their own cost
   ([S29](https://arxiv.org/abs/2604.22750)); wall-clock limits swing scores
   by 20-25 points ([S27](https://arxiv.org/abs/2611.08417)); caps change
   capability and failure profile per model
   ([S24](https://arxiv.org/abs/2509.16941)). Roadmap: per-pool budgets
   derived from history, timeouts reported as censored, per-model stall rules
   (a "spinning" signal for runs that keep spending tokens with no diff
   movement is the next candidate once per-run diff age is recorded).
4. **Parallel worktrees plus selection is now table stakes; coordination is
   the differentiator.** Cursor, Windsurf/Devin Desktop and Claude Code all
   ship N agents in N worktrees with caps and garbage collection
   ([S17](https://cursor.com/blog/2-0), [S18](https://cursor.com/docs/configuration/worktrees),
   [S20](https://docs.devin.ai/desktop/changelog), [S4](https://code.claude.com/docs/en/sub-agents)).
   Selection across heterogeneous systems beats any single member
   ([S22](https://arxiv.org/abs/2501.14723)), and hybrid verifiers beat either
   signal alone ([S21](https://arxiv.org/abs/2504.07164)). The open problems are
   shared context between workers ([S13](https://cognition.com/blog/dont-build-multi-agents))
   and cross-agent messaging (Codex's message-board MCP,
   [S7](https://learn.chatgpt.com/docs/changelog)). Roadmap: Phantom's
   cross-lane best-of-N for hard jobs and its bus are the moat; invest there.
5. **Context engineering is the cost lever.** Condensed 1-2k-token handoffs
   ([S3](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)),
   progress files as cross-session memory
   ([S2](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)),
   plan-then-verify instead of re-reading (0.3-0.75x tokens,
   [S30](https://arxiv.org/abs/2611.13241)) and cache-stable prompt prefixes
   (cached input at a tenth of the price, [S12](https://x.ai/news/grok-code-fast-1)).
   Roadmap: keep dispatch prompt prefixes byte-stable across jobs and measure
   cache-read share per pool before buying more capacity.

## Already covered (checked, not proposed)

- Test-tamper detection in diffs: detectTestTampering in
  src/core/authority/protected-paths.ts, wired into merge gate G1b.
- Offline pass^k with Wilson intervals: src/cli/eval-passk.ts.
- Best-of-N with failing candidates dropped before critic ranking:
  src/core/run/best-of-n-policy.ts and src/cli/best-of-n.ts.
- Stuck-lane triage into digests: queued from fleet-digest-2026-11-08.md
  (RQ-RESEARCH-LOOP-SIGNAL-TRIAGE).
- Full-suite merge check: the Merge Gate already runs the full check, which
  addresses S25's partial-test inflation.
