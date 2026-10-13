# Metrics and observability

Status: **Phase 1 shipped**: telemetry schema + local store
(`src/core/metrics/telemetry.ts`), PR significance/quality scoring, value
attribution, a UCB1 allocator (`scoring.ts`), and a first dashboard
(`phm metrics dashboard`). Feeds the self-improvement loop
([context-and-self-improvement.md](context-and-self-improvement.md)).

## 1. Primary metric

**Value-weighted PRs shipped to production per token**, also per second and
per dollar.

```
value(PR) = significance(PR) [0..10] × quality(PR) [0..1]
```

credited to the session that produced the merged, deployed PR. Secondary
metrics are tracked separately and never folded into the primary number:
session success rate, tool error rate, cache hit rate, wall time, disk/context
health.

## 2. Telemetry schema (v1)

Append-only JSONL at `$ASHLR_HOME/metrics/events.jsonl` (0600). JSONL keeps
Phase 1 dependency-free; Phase 2 adds a DuckDB/SQLite projection with the same
columns. Every event carries attribution:

| field | |
|---|---|
| `v, id, ts` | schema version, id, ISO time |
| `sessionId, agent, model, resource, strategy, process, taskType, repo, owner` | attribution dimensions |

| `kind` | extra fields |
|---|---|
| `session.started` | none |
| `session.ended` | `outcome` (success/failure/abandoned), `wallMs` |
| `usage` | `inputTokens, outputTokens, cachedTokens?, costUsd?, wallMs?` |
| `tool.called` | `tool, ok, ms?` |
| `pr.opened / pr.merged / pr.reverted` | `pr: {repo, number, additions, deletions, files, areas[], userFacing, risk, ciPassedFirstTry, reviewFindings, followUpFixes, coverageDelta, deployedToProduction}` |
| `pr.rated` | `pr, rater: human/llm-judge, rating 1..5, rubric?` |

Record with `phm metrics record '<json>'` (or `recordEvent()` in-process).

## 3. PR scoring (lightweight, non-constraining)

Grading never blocks or slows shipping. It runs after merge, asynchronously,
on a sample, using a local model by default. Risk tolerance is high:

* **Significance (0–10), upside-weighted:** log size (no penalty cap) +
  boldness (risk 0.3/1/2 is a *bonus*) + user-facing (0.5/2.5) + critical
  area (security, auth, secrets, release, billing, core, infra: 1.5, else 0.5).
* **Quality (0–1):** starts at 0.75; +0.1 CI green first try; up to +0.1 for
  coverage gains; **only real regressions subtract** (−0.15 per follow-up fix,
  max −0.5); a revert sets it to 0. CI retries and review comments are normal
  iteration and are not penalized. When sampled ratings exist, quality =
  0.7 × quantitative + 0.3 × mean rating.

**Scale:** built for hundreds of PRs a day per person and thousands or more
per team. Scoring is O(1) per PR from metadata. Ratings use deterministic
hash sampling (`sampled(pr, rate)`, so every machine picks the same PRs) and a
bounded-concurrency async queue (`gradeBatch`). Failures are dropped.

**Pluggable raters** (`src/core/metrics/raters.ts`): `Rater { id, rate() }`.
Ships with `localModelRater(complete)` (default, any local endpoint) and a
`jevRater(ask)` adapter for Jev / TypeSafe AI ([JEV-INTEGRATION](../JEV-INTEGRATION.md)).
The caller injects the client and resolves credentials through Phantom
Secrets. Phantom ships no key and makes no network call here.

## 4. Attribution and allocation

`rollup()` aggregates value, tokens, wall time and cost by agent, model and
strategy (leaderboards sorted by value per 1M tokens), plus per-day
throughput. `recommend(taskType, arms)` is a UCB1 bandit: unseen arms are
explored first, then the arm with the best normalized value per 1M tokens
plus its confidence bonus wins. Phase 2 adds an LP allocator that respects
subscription windows, local RAM/concurrency caps and budgets.

## 5. Dashboard

`phm metrics dashboard [--out file]` writes one self-contained HTML file (no
scripts, no network). It shows a hero number (value per 1M tokens), KPIs, value
per day, a quality trend, leaderboards by agent, strategy and model, cost per
day, and context/disk health from the steward. There is **one primary action**:
`phm steward disk --apply` when disk is over quota, otherwise
`phm improve propose`. Phase 2 moves this into the Verse UI.

## 6. Privacy

Local by default. Sharing (team sync or aggregate) is opt-in. Secret-shaped
values are refused, not redacted-and-stored. No prompt or response text is
recorded, only counts, ids and scores.

## 7. Roadmap

* Phase 2: auto-ingest from Phantom runs and `gh` (merged PRs, CI, reverts),
  LLM-judge rubric job, DuckDB projection, Verse dashboard, team sharing.
* Phase 3: LP allocator wired into dispatch; per-process A/B experiments.
