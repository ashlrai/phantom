## 2026-11-16 — RQ-RESEARCH-MODELS-1: model routing for the lane fleet (which model class takes which job class)

This section is staged here because the job sandbox blocks all access to `~/.ashlr-runs/` (EPERM on read and write),
the same as RQ-RESEARCH-HOSTLOAD-1. A supervisor appends it verbatim to
`~/.ashlr-runs/coordination/phantom-productive-20261105/RESEARCH-DIGEST.md`.

The section is written in the research-loop grammar (`docs/RESEARCH-LOOP.md` in phantom):
- `## S<n> —` source records. They are numbered S701 and up so they cannot collide with S-ids already in the digest, which this job could not read.
- A `## Proposals` block of bullets that `phm fleet research-digest` scores, deduplicates, lints and renders as `- READY` router lines.

The proposal block was checked with `planResearchDigest` before staging (see BRIDGE_NOTES.md).

This is research only. No routing, gate, model or host setting was changed. `[R n]` marks a repository fact listed under
"Repository facts" at the end of this section. Vendor benchmark numbers are self-reported and come from different agent scaffolds.
Every web fact was checked on 2026-11-16. Anything not confirmed on a primary page is marked UNVERIFIED.

### Headline

1. **Effort is set on the Codex lanes and nowhere else, and xhigh rarely pays.** Measured by Anthropic on Opus 5.5 (SWE-bench Pro subset):
   - `high`: 95.3% at $0.29/task. `xhigh`: 96.7% at $0.74/task, so 2.5× the cost for +1.4 points [S701].
   - "low, then re-run failures at high": about 97% at about $0.17/task, which is 40% under all-`high` [S701].
   - An independent study of 25 hard SWE-bench Verified tasks found no significant `xhigh` gain over `high` on Opus 5 (p = 1.0). Every timeout and every empty patch happened at `high`/`xhigh` [S704].
   - OpenAI gives the same guidance for Codex models: use `xhigh` "only when your evals show a clear benefit" [S712].
   - Our launcher passes `model_reasoning_effort` only on codex-cmp and codex-personal, and only when `models.json` sets it [R1]. codex-cmp runs Astra at xhigh, the most expensive point on the curve.
2. **Open-pool frontier work goes to the weakest frontier-capable lane.** `restock.py` sends any open-pool `tier=frontier` line to devin by default [R2].
   - On Terminal-Bench 4.0, SWE-2 scores 27.3, against 65.8 for Opus 5.5, 60.9 for GPT-6.1 Sol and 64.5 for Gemini 4 Carbon [S709, S713].
   - Our only outcome baseline shows devin at 60% merge and 82 min mean wall time, against codex-cmp at 66.7% and 25 min [R3].
   - devin is also held right now (target 0), so these jobs wait.
3. **GPT-6.1 Sol matches Astra at a fifth of the price, with about 3× the 5-hour quota.**
   - Terminal-Bench 4.0: Sol (max) 60.9, Astra (max) 60.3 [S709].
   - Price per MTok: Astra $10/$50, Sol $2/$10 [S710].
   - Plus-plan local messages per 5 hours: Astra 5–45, Sol 15–160, Terra 35–285, Luna 350–3,000 [S711].
   - Astra should be the frontier exception, not the codex-cmp default.
4. **The dispatcher paces weekly quotas but not the 5-hour windows that actually throttle Claude, Codex Plus, Z.ai and Antigravity** [R4, S705, S711, S716, S715].
   - `policy.ts` already defines 5-hour ceilings (70% when balanced), but nothing enforces them at claim time [R4].
5. **We can't tune any of this yet, because launches don't record model, effort or verb** [R3, R5].
   - Every proposal below is a prior. P1, launch provenance, is what turns them into measurements.

### Resource matrix and proposed per-lane routing table

Cost class is `included` (subscription), `metered` (pay per token) or `local`. Job tiers are those in `contrib/mac/work_market.py` [R6].
In the "Should take" column, (→) means a change from today.

| Lane / surface | Model and proposed effort | Cost class, price per MTok in/out | Quota window | Latency | Quality signal | Should take |
|---|---|---|---|---|---|---|
| codex-cmp (persona) | **frontier:** gpt-6-astra `high`, with `xhigh` only for `horizon=long`. **work:** gpt-6.1-sol `high` | included. API list: Astra $10/$50, Sol $2/$10 [S710] | 5-hour + weekly. Plus: Astra 5–45/5h. Pro: no 5-hour limit [S711] | Astra slow; Sol medium | TB4: Astra 60.3, Sol 60.9 [S709] | frontier, work (→ Astra only for frontier) |
| codex-personal | **work:** gpt-6.1-sol `high`. **mid:** gpt-6.1-terra `medium`. **fast:** gpt-6-luna `low` | included. Terra $1/$5, Luna $0.10/$0.50 [S710] | 5-hour + weekly. Terra 35–285/5h, Luna 350–3,000/5h [S711] | Terra over 3× faster than Sol (UNVERIFIED) | TB4: Terra 53.3; Luna 16.4 (UNVERIFIED) | work, mid, fast (LAND, FIXUP, DRAIN, DAILYFIX) |
| claude (subscription) | **frontier:** Opus 5.5 `high`; Fable 5.2 `high` only on retry or `horizon=long`. **work:** Opus 5.5 `medium`. **mid:** Sonnet 5.5 `medium` | included. API list: Fable $8/$40, Opus $4/$20, Sonnet $2/$10 [S703] | Max: 5-hour + weekly. Ultra: weekly only (verified accounts). Fable capped at half the weekly limit. Chat, Code and the desktop apps share one pool [S705] | Sonnet fastest; Fable runs long turns | TB4: Opus 5.5 65.8, Fable 5.2 65.8, Sonnet 5.5 63.9. SWE-bench Pro subset: Opus `medium` 92.8%, Sonnet `high` 87.6% [S709, S701] | frontier, work, mid |
| claude-api | **fast:** Haiku 5.5 `low`/`medium`. **overflow frontier:** Opus 5.5 `medium` when subscription windows are exhausted | metered. Haiku $0.10/$0.50, 5× the whole request above 100K tokens. Batch is 50% off [S703] | Token bucket per organization (RPM, ITPM, OTPM). Cache reads don't count toward ITPM. Has a ramp limit [S706] | Haiku fastest | Haiku 5.5: 93% pass on a 79-task agent set at about $0.011 per passed attempt [S701] | fast (→ triage, classification, commit/PR text), plus paid overflow |
| devin | SWE-2 (the Medium/High/Max are effort variants, not separate models) | free on self-serve Desktop/CLI until Nov 30; list $3/$15 [S713] | Devin plan quota; ACU price UNVERIFIED | about 60 tok/s; mean wall time 82 min [R3] | TB4 27.3; FrontierCode 1.1 50.0 [S713] | mid, work when well specified (→ no default frontier) |
| devin-flash | SWE-2 Flash, Max variant (forced) [R1] | free until Dec 4; list $0.10/$0.50 [S713] | Devin plan quota; not in Devin cloud | about 200 tok/s ("simulated") | TB4 20.0 [S713] | fast, mid |
| codex-local / omlx (primary, 128 GB) | `strong` alias. A candidate model is Qwen3-Coder-Next at 6–8 bit, or Devstral 2 | local; $0 but costs memory: the omlx server held 45–68 GB (HOSTLOAD) | none | prefill-bound. An 8K prompt took 49 s cold and 1.7 s with the prefix cache [S720] | SWE-bench Verified: Qwen3-Coder-Next 70.6, Devstral 2 72.2 (vendor numbers) [S718] | fast, mid only, capped at 32K context (already fast/mid only [R6]) |
| codex-local (Air 16 GB, muse 8 GB) | Qwen2.5-Coder-7B or Qwen3-4B at 4-bit [R7] | local | none | about 200 tok/s prefill on M2/M4-class [S720] | 4-bit loses 12–23 points on code benchmarks [S718] | fast only, with prompts of 4K tokens or less |
| gemini | Gemini 4 Hydrogen or Carbon. The launcher default `gemini-2.5-pro` is stale [R1] | metered: Carbon $2/$10, rising to $4/$20 on Dec 1; Hydrogen $1.50/$7.50 [S715] | unpaid CLI key: 250 requests/day, Flash only. The Google-account tiers moved to Antigravity on Jun 18 [S715] | medium | TB4: Carbon 64.5, Hydrogen 56.4 [S709] | mid, work (→ or fold into agy) |
| agy (Antigravity) | **frontier/work:** Gemini 4 Carbon. The default `claude-opus-4-6-thinking` is stale [R1] | included | 5-hour + weekly, metered by agent work. Gemini and Claude/GPT models have separate meters; numbers UNVERIFIED [S715] | medium | TB4: Carbon 64.5 [S709] | work, frontier (as a second frontier lane) |
| grok (usage-limited now) | grok-4.7 for work; grok-build-0.1 for fast | included (SuperGrok, quota UNVERIFIED). API: grok-4.7 $2/$6, grok-build $1/$2, 2× the whole request at 200K tokens or more [S714] | subscription window, UNVERIFIED | build model is fast | not in the TB4 top 12 [S709] | mid, fast after reset; never frontier |
| zai | GLM-5.3 for mid/work; GLM-5.3-flash for fast [R1] | included, credit plan: Lite 2,000 credits/5h and 10,000/week. Off-peak costs 0.5× [S716] | rolling 5-hour + weekly, both applied [S716] | unknown | benchmarks UNVERIFIED | mid (work only once lane fit shows yield), preferably launched off-peak |
| cursor | Composer 2.5. The launcher default `auto` can choose third-party models billed at API list price [R1, S717] | included weekly pool. Composer 2.5 $0.50/$2.50; Composer Fast $3/$15 [S717] | weekly pool [S717] | Fast variant available | UNVERIFIED | mid, fast |
| Desktop apps (Claude, Codex, Devin, Cursor, Grok Bot) | The same models as the lane behind each app | draw on the same subscription pool as that lane [S705, S711] | the same windows as that lane | interactive | — | operator-driven planning and review only; count their usage against the lane's 5-hour budget |

### Findings by research question

**(1) Anthropic ladder economics**
- **Prices per MTok:** Fable 5.2 $8/$40, Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50. All have 1M context. Cache reads cost 0.025× input on Fable and 0.05× on Opus and Sonnet [S703, S701].
- **Default model for agents:** Anthropic recommends Opus 5.5 at its default `medium` for most agent workloads. On its SWE-bench Pro subset, Opus `medium` matched Fable 5.1 "for about a fifth of the cost per solved task" [S701].
- **Opus vs Sonnet:** Opus `low` (87.4%) roughly equals Sonnet 5.5 `high` (87.6%), for about 7% more per solved task [S701].
- **Fable 5.2 vs Opus 5.5:**
  - Fable 5.2 `high` scores 96.3% at $1.39 per solved task. Opus 5.5 `xhigh` scores 96.5% at $0.75 [S701].
  - On DeepResearch Bench II, Fable 5.2 cost 2.9× as much as Opus for a score 1.9 points lower [S701].
  - Conclusion: Fable is a retry or long-horizon tool, not a default.
- **Delegating to subagents:**
  - Opus with Sonnet subagents cost about a third less than Opus alone, at about the same score [S701].
  - Haiku subagents under Opus cost 32% less per attempt but lowered the pass rate by about 4 points [S701].
  - Anthropic's rule: tune one model before you add a second [S701].
- **Output cap:** with `max_tokens` at 16K, 25% of Opus attempts and 85% of Fable attempts were cut off [S701]. Agent lanes need 64K or more.
- **Caching:** without caching, SWE-bench Pro cost 3.1–3.3× more. A healthy agent loop reads about 84% of its input from the cache [S701].

**(2) Local vs API**
- **Where local models are competitive:** the best local coders reach about 70–72 on SWE-bench Verified (Qwen3-Coder-Next, Devstral 2), but only 22–36 on Terminal-Bench 2 [S718]. They compete on single-file, test-verified edits, not on multi-step terminal work.
- **Tool calls fail often enough to matter:**
  - Parser bugs drop or mangle about 1 in 128 tool calls, sometimes silently as text with `finish_reason: stop` [S719].
  - At 1% per call, about 63% of 100-call sessions hit at least one failure.
- **Prefill, not decode, sets the wall time:**
  - Prompt processing runs about 200 tok/s on M2/M4 base chips and 900–1,500 on Max/Ultra (7B Q4) [S720].
  - An 8K agent prompt took 49 s on MLX without the prefix cache and 1.7 s with it [S720].
  - That matches our local-qwen baseline: 75% merge but 94 min mean wall time [R3].
- **Quantization:** 4-bit costs 12–23 points on code benchmarks for Qwen3 [S718]. Use 6–8 bit on the primary.
- **Verdict:** local wins on cost only for short-context, test-verified fast/mid jobs on the primary. On the Air and muse it should take triage and text jobs only. Haiku 5.5 at $0.10/$0.50 is a cheap, reliable alternative for fast-tier triage [S701, S703].

**(3) Concurrency**
- **API rate limits:** they are per organization, enforced as a token bucket. Cache reads are exempt from ITPM. Sharp ramps get a 429 `ramp_limit_exceeded` even under the caps. A spend-cap 429 has no `retry-after` and must not be retried [S706].
- **Subscription limits:** they publish no concurrency cap, only 5-hour and weekly windows [S705, S711].
- **Multi-agent token cost:** a multi-agent system used about 15× the tokens of chat. It wins on parallel research, but "most coding tasks involve fewer truly parallelizable tasks" [S707, S724].
- **Merge conflicts between parallel writers:**
  - PRs open at the same time conflicted 19.8% of the time when written by the same agent and 41.7% across different agents [S722].
  - Claiming files before writing raised integration from 33% to 96% [S722] (abstract only).
  - Our restock dedup works on semantic goal overlap, not on file sets [R8].
- **Context rot:** every model tested degraded as input grew, and a focused ~300-token input beat the full ~113K input [S721]. Compact well before the window fills.
- **Host capacity:** see RQ-RESEARCH-HOSTLOAD-1 (memory is the binding limit).

**(4) Effort calibration**
- **Opus 5.5:** low 87.4% ($0.11), medium 92.8% ($0.21), high 95.3% ($0.29), xhigh 96.7% ($0.74) [S701].
- **Sonnet 5.5:**
  - `high` → `medium` lost about 7 points on SWE-bench Pro and 15 points on internal agentic coding (77.8% → 62.7%) [S701].
  - At `max` it scored below `xhigh`, because of self-review timeouts [S726].
- **Fable 5.2:** "most of the gain is already present at high" [S702].
- **Independent study (arXiv 2608.01347):**
  - `xhigh` was dominated by `high` on both Opus 5 and Sonnet 5.
  - Easy tasks solved at every effort, and lower effort cut their cost about 75%.
  - Its simulated escalation rule did not beat the frontier [S704]. That disagrees with Anthropic's measured cascade [S701], so escalation confidence is medium.
- **Overthinking:** steering models away from overthinking added 4.8–5.8 points on SWE-bench Verified [S725].
- **Policy:** `medium` for well-specified work, `high` for hard multi-file work, `xhigh` only for long-horizon jobs (over 30 min per [S702]), never `max`. Escalate on failure instead of raising the default.

### Proposals

`phm fleet research-digest` computes score = impact × confidence weight (high 1.0, medium 0.6, low 0.3) − effort penalty (s 0, m 0.5, l 1.0).
Each line below is in the parser grammar; the score is shown at the end.

Expected scores (impact × confidence weight − effort penalty):

| Proposal | Score | Priority |
|---|---|---|
| LAUNCH-PROVENANCE | 5.0 | P1 |
| CODEX-EFFORT-LADDER | 5.0 | P1 |
| FRONTIER-NOT-DEVIN | 4.0 | P1 |
| CLAUDE-EFFORT-TIER | 4.0 | P1 |
| FIVEHOUR-GATE | 3.5 | P2 |
| RETRY-ESCALATE | 1.9 | P3 (below the default minimum score of 2) |
| STALE-MODEL-DEFAULTS | 1.8 | P3 |
| LOCAL-CONTEXT-CAP | 1.3 | P3 |
| HAIKU-FAST-TIER | 1.3 | P3 |
| WRITER-OVERLAP | 1.3 | P3 |
| PRICE-CLIFFS | 1.2 | P3 |
| ZAI-OFFPEAK | 1.2 | P3 |

The P3 lines stay below the default `minScore` of 2 on purpose. Each needs either P1 data or an operator decision first.

**Time-boxed note (operator decision, not a queue line):**
- SWE-2 is free on self-serve Desktop/CLI until Nov 30, and SWE-2 Flash until Dec 4 [S713].
- If devin and devin-flash are held for cost, lifting the devin-flash hold for fast/mid work until Dec 4 is free capacity. Re-apply the hold on Dec 4.
- Gemini 4 Carbon API prices double on Dec 1 [S715].

## Proposals

- RQ-ROUTE-LAUNCH-PROVENANCE | S701,S704 | impact=5 effort=s confidence=high repo=phantom pool=codex-personal tier=work | In contrib/mac/host-integration/launch.candidate.sh write resolved model, effort, tier and task verb into the job base.meta, and have phm lanes fit group yield, wall time and cost by model and effort, so effort and model priors become per-lane measurements instead of guesses. | Acceptance: a contrib/mac test asserts base.meta carries model, effort, tier and verb keys and npx vitest run for the lanes fit suite passes with a fixture grouped by model and effort.
- RQ-ROUTE-CODEX-EFFORT-LADDER | S709,S710,S711,S712,S701 | impact=5 effort=s confidence=high repo=phantom pool=codex-personal tier=work | Give codex lanes tier-aware defaults in launch.candidate.sh and the docs/ROUTING.md models.json example: frontier gpt-6-astra high, work gpt-6.1-sol high, mid gpt-6.1-terra medium, fast gpt-6-luna low; xhigh only for horizon=long lines. Sol scores level with Astra on Terminal-Bench 4 at a fifth of the price. | Acceptance: a contrib/mac test resolves model and effort for each codex tier with an empty models.json and gets the ladder above; an explicit models.json key still wins.
- RQ-ROUTE-FRONTIER-NOT-DEVIN | S709,S713 | impact=4 effort=s confidence=high repo=phantom pool=codex-personal tier=work | Stop devin_default in contrib/mac/restock.py from sending open-pool tier=frontier lines to devin; route them to the general lane with most need among claude, codex-cmp and agy. Keep the horizon=long marker for devin only on mid and work tiers. SWE-2 scores 27.3 on Terminal-Bench 4 against 60 to 66 for those lanes. | Acceptance: a contrib/mac restock test shows an open-pool tier=frontier line no longer gets pool devin and a horizon=long work line still does.
- RQ-ROUTE-CLAUDE-EFFORT-TIER | S701,S702,S704,S705 | impact=4 effort=s confidence=high repo=phantom pool=codex-personal tier=work | Pass a tier effort to the claude lane in launch.candidate.sh, which today sets effort only for codex lanes: work Opus 5.5 medium, frontier Opus 5.5 high, mid Sonnet 5.5 medium; allow Fable 5.2 high only for frontier retries or horizon=long, never max. Verify the Claude Code effort setting name before wiring it. | Acceptance: a contrib/mac test resolves claude model and effort per tier from an empty models.json and no claude launch line carries effort max.
- RQ-ROUTE-RETRY-ESCALATE | S701,S704,S723 | impact=4 effort=m confidence=medium repo=phantom pool=codex-personal tier=work | When a job ends with red tests or an empty patch, make the FIXUP or retry launch one effort step higher on the same lane (medium to high, high to xhigh), or one model up on claude (Opus to Fable), instead of repeating the first settings; record the step so lanes fit can compare. Anthropic measured low then retry at high at about 97 percent for 40 percent less. | Acceptance: a contrib/mac test shows a failed work job requeued with a higher effort than its first launch and a second failure goes to hold, not a third escalation.
- RQ-ROUTE-FIVEHOUR-GATE | S705,S711,S715,S716 | impact=4 effort=m confidence=high repo=phantom pool=codex-personal tier=work | Add a five-hour window gate to dispatchd.py claim admission using the existing claude usage and codex primary-window probes, enforcing the policy.ts balanced ceiling of 70 percent for routine work and 95 percent for P0. Today the dispatcher paces weekly usage only, so bursts hit the five-hour wall and trip six-hour auto-holds. | Acceptance: a contrib/mac test admits routine work at 60 percent of a five-hour window, defers it at 75 percent, and admits a P0 line at 90 percent.
- RQ-ROUTE-STALE-MODEL-DEFAULTS | S709,S715,S717 | impact=3 effort=s confidence=medium repo=phantom pool=codex-personal tier=work | Refresh stale launcher defaults: gemini lane gemini-2.5-pro to a current Gemini 4 model (or fold the lane into agy since the free CLI tier moved to Antigravity), agy frontier claude-opus-4-6-thinking to Gemini 4 Carbon, cursor auto to composer-2.5 so the weekly pool is not billed at third-party list price; align docs/model-registry.json with fable-5-2. | Acceptance: a contrib/mac test asserts the new default model per lane and npm run check:docs passes.
- RQ-ROUTE-LOCAL-CONTEXT-CAP | S718,S719,S720 | impact=3 effort=m confidence=medium repo=phantom pool=codex-personal tier=work | For codex-local, cap the prompt at about 32K tokens on the primary and 4K on the Air and muse, keep the omlx prefix cache on, count a stop response holding raw tool_call text as a failed job, and document which models back the fast and strong aliases with their bit width and context. | Acceptance: test_local_job.py covers the per-node prompt cap and the raw tool_call failure case and docs/LOCAL-FLEET.md names the alias models.
- RQ-ROUTE-HAIKU-FAST-TIER | S701,S703,S706 | impact=3 effort=m confidence=medium repo=phantom pool=codex-personal tier=work | Enable claude-api for fast-tier text jobs (triage, classification, commit and PR text) on Haiku 5.5 at low or medium, keep prompts under 100K tokens to avoid the 5x price band, ramp new workers at most one per minute, and never retry enforced_spend_limit_reached; use the Batch API for non-interactive review. | Acceptance: a contrib/mac test routes a fast-tier text line to claude-api with model haiku and a spend-limit 429 produces a hold, not a retry.
- RQ-ROUTE-WRITER-OVERLAP | S722,S724 | impact=3 effort=m confidence=medium repo=phantom pool=codex-personal tier=work | Extend restock dedup beyond semantic-goal overlap: when two admitted lines name overlapping files, launch only the first and park the second until it merges. Agent PRs open at the same time conflict 20 to 42 percent of the time without a pre-write claim. | Acceptance: a contrib/mac restock test parks the second of two lines naming the same file and admits two lines naming disjoint files.
- RQ-ROUTE-PRICE-CLIFFS | S703,S710,S714,S721 | impact=2 effort=s confidence=medium repo=phantom pool=codex-personal tier=work | Add per-lane prompt-size ceilings to the work market: Haiku 100K, OpenAI models 272K, Grok 200K, where the whole request reprices; compact or split prompts above about 100K on every lane because long inputs degrade all models. | Acceptance: a contrib/mac work_market test rejects a 250K-token line for grok and admits it for claude.
- RQ-ROUTE-ZAI-OFFPEAK | S716 | impact=2 effort=s confidence=medium repo=phantom pool=codex-personal tier=mid | Bias zai launches toward the plan off-peak hours, where credits cost half, and keep zai on mid tier until lanes fit shows its yield. | Acceptance: a contrib/mac test shows zai admission weight is higher in an off-peak hour than a peak hour for the same line.

## S701 — Anthropic: optimizing for cost and intelligence (measured effort, model, cascade and caching data)

- Checked: 2026-11-16.
- Source: [Claude docs, cost and intelligence](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence)
- Takeaway: Opus 5.5 SWE-bench Pro subset low/medium/high/xhigh 87.4/92.8/95.3/96.7% at $0.11/0.21/0.29/0.74
  per task; low then retry failures at high about 97% at about $0.17; Sonnet 5.5 high 87.6% at $0.11 per solved task;
  Fable 5.2 high 96.3% at $1.39 per solved task; Haiku 5.5 93% at $0.011 per passed attempt; uncached runs 3.1–3.3x.

## S702 — Anthropic: effort parameter

- Checked: 2026-11-16.
- Source: [Claude docs, effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- Takeaway: Opus 5.5 and Haiku 5.5 default to medium; xhigh is for agentic work over 30 minutes; Fable 5.2 has most
  of its gain at high; max is for measuring ceilings. Per-message effort changes keep the prompt cache.

## S703 — Anthropic: API pricing

- Checked: 2026-11-16.
- Source: [Claude docs, pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- Takeaway: Fable 5.2 $8/$40, Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 (5x above 100K input);
  batch 50% off; fast mode 2x price.

## S704 — Effort on hard SWE-bench Verified tasks in Claude Code (arXiv 2608.01347, Appendix N)

- Checked: 2026-11-16.
- Source: [arXiv 2608.01347](https://arxiv.org/html/2608.01347)
- Takeaway: Opus 5 low/high/xhigh solved 17/18/16 of 25 at $0.75/$1.89/$3.62 per solve; xhigh no significant gain;
  all timeouts and empty patches at high or xhigh; simulated escalation did not improve the frontier.

## S705 — Anthropic: Claude Code on Pro, Max and Ultra plans

- Checked: 2026-11-16.
- Source: [Claude support article 11145838](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- Source: [Claude pricing](https://claude.com/pricing)
- Takeaway: 5-hour plus weekly limits shared across chat, Code and apps; verified Ultra has no 5-hour limit; Fable
  capped at half the weekly limit on Max and Ultra. No numeric caps published.

## S706 — Anthropic: API rate limits

- Checked: 2026-11-16.
- Source: [Claude docs, rate limits](https://platform.claude.com/docs/en/api/rate-limits)
- Takeaway: per-organization token buckets on RPM, ITPM and OTPM; cache reads do not count toward ITPM; ramp_limit_exceeded
  on sharp bursts; spend-limit 429 has no retry-after.

## S707 — Anthropic: how we built our multi-agent research system

- Checked: 2026-11-16.
- Source: [Anthropic engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Takeaway: multi-agent used about 15x chat tokens and won 90.2% on research; most coding tasks are less parallelizable.

## S708 — Anthropic: effective context engineering for AI agents

- Checked: 2026-11-16.
- Source: [Anthropic engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Takeaway: treat context as an attention budget; compaction and notes over ever-longer prompts.

## S709 — Terminal-Bench 4.0 official leaderboard

- Checked: 2026-11-16.
- Source: [tbench.ai leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/4.0)
- Takeaway: Opus 5.5 65.8, Fable 5.2 65.8, Gemini 4 Carbon 64.5, Sonnet 5.5 63.9, GPT-6.1 Sol 60.9, GPT-6 Astra 60.3,
  Gemini 4 Hydrogen 56.4, GPT-6.1 Terra 53.3.

## S710 — OpenAI: model pages for GPT-6 Astra, GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Luna

- Checked: 2026-11-16.
- Source: [OpenAI models](https://developers.openai.com/api/docs/models)
- Takeaway: Astra $10/$50, Sol $2/$10, Terra $1/$5, Luna $0.10/$0.50 per MTok; 1.05M context; above 272K input the
  whole request is 2x input and 1.5x output.

## S711 — OpenAI: Codex plan limits

- Checked: 2026-11-16.
- Source: [ChatGPT pricing and Codex limits](https://learn.chatgpt.com/docs/pricing)
- Takeaway: Plus local messages per 5 hours: Astra 5–45, Sol 15–160, Terra 35–285, Luna 350–3,000; weekly limits may
  apply; Pro tiers have no 5-hour limit.

## S712 — OpenAI: reasoning models guide

- Checked: 2026-11-16.
- Source: [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)
- Takeaway: medium is the default for agentic coding; use xhigh only when evals show a clear benefit.

## S713 — Cognition: SWE-2 and SWE-2 Flash

- Checked: 2026-11-16.
- Source: [Cognition SWE-2](https://cognition.com/blog/swe-2)
- Source: [Cognition SWE-2 Flash](https://cognition.com/blog/swe-2-flash)
- Source: [Devin desktop models](https://docs.devin.ai/desktop/models)
- Takeaway: SWE-2 $3/$15, free self-serve until Nov 30, TB4 27.3, about 60 tok/s; Flash $0.10/$0.50, free until Dec 4,
  TB4 20.0, about 200 tok/s; Medium, High and Max are effort variants.

## S714 — xAI: models and pricing

- Checked: 2026-11-16.
- Source: [xAI docs, models](https://docs.x.ai/docs/models)
- Takeaway: grok-4.7 $2/$6 with 500K context; grok-build-0.1 $1/$2; prompts of 200K or more are 2x on the whole request.

## S715 — Google: Gemini pricing, Gemini CLI quotas, Antigravity plans

- Checked: 2026-11-16.
- Source: [Gemini API pricing](https://aistudio.google.com/docs/pricing)
- Source: [Gemini CLI quota and pricing](https://geminicli.com/docs/resources/quota-and-pricing/)
- Source: [Antigravity plans](https://antigravity.google/docs/plans)
- Takeaway: Gemini 4 Carbon $2/$10 until Nov 30 then $4/$20; unpaid CLI key 250 requests per day Flash only after the
  Jun 18 move to Antigravity; Antigravity refreshes every 5 hours up to a weekly cap with separate meters per model family.

## S716 — Z.ai: GLM Coding Plan

- Checked: 2026-11-16.
- Source: [Z.ai devpack overview](https://docs.z.ai/devpack/overview)
- Source: [Z.ai subscribe](https://z.ai/subscribe)
- Takeaway: credit billing since Jul 30; Lite 2,000 credits per rolling 5 hours and 10,000 per week; off-peak 0.5x.

## S717 — Cursor: pricing and models

- Checked: 2026-11-16.
- Source: [Cursor pricing](https://cursor.com/pricing)
- Source: [Cursor models and pricing](https://cursor.com/docs/models-and-pricing)
- Takeaway: one weekly usage pool; third-party models billed at API list price; Composer 2.5 $0.50/$2.50.

## S718 — Local coding models: Qwen3-Coder-Next, Devstral 2, quantization loss

- Checked: 2026-11-16.
- Source: [Qwen3-Coder-Next model card](https://huggingface.co/Qwen/Qwen3-Coder-Next)
- Source: [Mistral Devstral 2](https://mistral.ai/fr/news/devstral-2-vibe-cli)
- Source: [arXiv 2604.20079, quantization on code](https://arxiv.org/abs/2604.20079)
- Takeaway: SWE-bench Verified 70.6 (Qwen3-Coder-Next) and 72.2 (Devstral 2) vendor-reported, Terminal-Bench 2 22.5–36.2;
  4-bit Qwen3 loses 12–23 points on code benchmarks.

## S719 — Local tool-call reliability reports

- Checked: 2026-11-16.
- Source: [llama.cpp issue 24807](https://github.com/ggml-org/llama.cpp/issues/24807)
- Source: [llama.cpp issue 30490](https://github.com/ggml-org/llama.cpp/issues/30490)
- Source: [Ollama issue 17276](https://github.com/ollama/ollama/issues/17276)
- Takeaway: about 1 in 128 malformed tool calls with Qwen3.6-35B-A3B; calls silently returned as text with
  finish_reason stop; random XML parse errors make multi-step runs unreliable.

## S720 — Apple silicon prefill and decode throughput

- Checked: 2026-11-16.
- Source: [llama.cpp Apple silicon performance discussion](https://github.com/ggml-org/llama.cpp/discussions/4167)
- Source: [famstack MLX vs GGUF on Apple silicon](https://famstack.dev/guides/mlx-vs-gguf-apple-silicon/)
- Takeaway: 7B Q4 prompt processing about 200 tok/s on M2 and M4 base and 886–1,471 on Max and Ultra; an 8K prompt took
  49 s on MLX without prefix cache and 1.7 s with it.

## S721 — Long-context degradation: Chroma context rot, NoLiMa, RULER

- Checked: 2026-11-16.
- Source: [Chroma context rot](https://www.trychroma.com/research/context-rot)
- Source: [NoLiMa, arXiv 2502.05167](https://arxiv.org/abs/2502.05167)
- Source: [RULER, arXiv 2404.06654](https://arxiv.org/abs/2404.06654)
- Takeaway: all 18 models degraded with input length; 11 of 13 models fell below half their short-context score at 32K.

## S722 — Merge conflicts among parallel agent PRs and pre-write claims

- Checked: 2026-11-16.
- Source: [arXiv 2607.04697](https://arxiv.org/abs/2607.04697)
- Source: [CooperBench, arXiv 2608.00947](https://arxiv.org/pdf/2608.00947)
- Takeaway: co-active agent PR pairs conflicted 19.8% within one agent and 41.7% across agents; claim locking raised
  integration from 33% to 96% (CooperBench abstract only, not fully read).

## S723 — Repeated sampling for coding (Large Language Monkeys)

- Checked: 2026-11-16.
- Source: [arXiv 2407.21787](https://arxiv.org/abs/2407.21787)
- Takeaway: SWE-bench Lite coverage rose from 15.9% to 56% with 250 samples, but only an automatic verifier turns coverage
  into results; retries pay where tests decide.

## S724 — Multi-agent failure modes: Cognition and MAST

- Checked: 2026-11-16.
- Source: [Cognition, don't build multi-agents](https://cognition.com/blog/dont-build-multi-agents)
- Source: [MAST, arXiv 2503.13657](https://arxiv.org/abs/2503.13657)
- Takeaway: parallel writers make conflicting implicit decisions; 14 failure modes across design, misalignment and verification.

## S725 — Overthinking in coding agents (TACT, arXiv 2605.05980)

- Checked: 2026-11-16.
- Source: [arXiv 2605.05980](https://arxiv.org/html/2605.05980)
- Takeaway: steering away from overthinking added 4.8–5.8 points on SWE-bench Verified and cut steps by up to 26%.

## S726 — Anthropic model pages: Sonnet 5.5 and Fable 5.2

- Checked: 2026-11-16.
- Source: [Claude Sonnet 5.5](https://www.anthropic.com/claude-sonnet-5-5)
- Source: [Claude Fable and Mythos 5.2](https://www.anthropic.com/claude-fable-and-mythos-5-2)
- Takeaway: Sonnet 5.5 70.6% and Opus 5.5 66.4% on Terminal-Bench 4.0 at xhigh (vendor); Fable 5.2 69.9% FrontierSWE v2;
  Sonnet 5.5 at max scored below xhigh on FrontierCode because self-review rounds caused timeouts.

### Repository facts (read at 76cd02783c)

- R1 `contrib/mac/host-integration/launch.candidate.sh:73-74,120-122`: per-lane default models (claude opus,
  claude-api sonnet, gemini gemini-2.5-pro, agy gemini-3.8-flash-high with claude-opus-4-6-thinking for frontier,
  cursor auto, devin-flash swe-2-flash-max). Effort is read from `models.json` and passed only to codex-cmp and codex-personal.
  The live launcher and `models.json` are outside the repo, so production values may differ.
- R2 `contrib/mac/restock.py:78-79,433`: `devin_default` sends open-pool `tier=frontier` or `horizon=long` lines to devin.
- R3 `benchmarks/router-eval/baseline.md`: 45 jobs on 2026-10-26. Merge rate and mean wall time: codex-cmp 66.7% and 25 min,
  devin 60% and 82 min, local-qwen 75% and 94 min. The data has no model or effort breakdown.
- R4 `contrib/mac/dispatchd.py:1746-1773` paces only `weekly_used_pct`. `src/core/routing/policy.ts:141-170` defines
  5-hour ceilings that claim admission does not enforce.
- R5 `docs/LANE-FIT.md`: launches don't record task verbs, so fit rows show an unknown verb.
- R6 `contrib/mac/work_market.py:89,109`: local lanes take only fast and mid; cost classes are included, metered and local.
- R7 `docs/OMLX-SMALL-MACS.md`, `docs/LOCAL-FLEET.md`: muse runs Qwen3-4B at 4-bit with 16K context; the 16 GB node runs
  Qwen2.5-Coder-7B at 4-bit; the primary runs Qwen3.8 27B at 64K context.
- R8 `contrib/mac/restock.py:35,357`: restock dedup is semantic-goal Jaccard overlap, not file overlap.

### Not verified from a primary source

Numeric Claude, Antigravity and SuperGrok window counts; the current Devin ACU price; GLM-5.3 and Composer 2.5 benchmarks;
the GPT-6.1 Sol announcement page (HTTP 403); GPT-6 Luna on Terminal-Bench 4.0 (read only from a vendor chart);
Haiku 5.5 Terminal-Bench 4.0 (search summary only). The CooperBench figure comes from the abstract only.
