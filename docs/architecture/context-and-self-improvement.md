# Synthesized context, the constitution, and the self-improvement loop

Status: **Phase 1 shipped**: [CONSTITUTION.md](../../CONSTITUTION.md), the
evidence-scored context compiler (`src/core/teams/context.ts`), and the
draft-PR-only proposal loop (`phm improve propose`, `src/core/improve/loop.ts`).
Companion to [teams.md](teams.md).

## 1. Connectors are evidence, not truth

GitHub, chats, docs, mail, calendars, logs and metrics are **evidence
indicators**. Phantom builds its own living context from them. Each context
entry is a claim with:

| field | meaning |
|---|---|
| `source` | provenance link back to the evidence (URL, `path@sha`, thread id) |
| `observedAt` | when the evidence was observed; drives decay |
| `importance` | 0..1 (0.5 neutral) |
| `supersedes[]` | ids of stale facts this replaces; superseded entries never surface |
| `scope` | personal / company / client:<x>, plus project and person |

Score = relevance (TF-IDF vs. the task) × recency (half-life 14 days, floor
25%) × importance. Connectors are BYO: anything that can produce a pointer and
a short summary (MCP server, CLI, API, local files, infra) is an evidence feed.
Nothing is copied wholesale; secrets are refused.

## 2. Constitution (successor to CLAUDE.md)

`CONSTITUTION.md` is versioned (`version:` front matter) and changes only via
a reviewed PR. It holds the mission (make Phantom the most useful engineering
tool; it improves itself), principles, the always-ask list (push/merge to
main, deploy, rotate credentials, external sends, spend, deletes outside the
workspace) and the self-improvement rules. Phase 2 generates AGENTS.md,
CLAUDE.md and Skills from it so per-tool files never drift.

## 3. Task-scoped context compilation

Context is compiled per task, not read from a static file:
`compileTaskContext(team, task, constitution)` returns a stable prefix (the
constitution version + always-ask list, which caches well) followed by the
evidence pack for this task's title/detail, fitted to the token budget with
provenance and dates on every line.

## 4. Self-improvement loop

```
evidence (team log, steward, tagged feedback) → proposals (why, evidence, eval, metric)
  → draft PR from an isolated worktree → CI + evals → human approves merge/deploy
  → usage/success metrics flow back as evidence
```

Phase 1 signals: repeated declined handoffs, steward over-quota roots, and
context tagged `feedback` / `bug` / `feature-request`. `phm improve propose`
prints proposals; `--open-pr --repo <dir>` opens each as a **draft** PR
(`workplans/proposals/<id>.md`) on an `improve/*` branch. It never merges,
never pushes to the default branch and never deploys.

## 5. Roadmap

* Phase 2: proposals implement code (agent run in the worktree), eval sets per
  proposal, metrics ingestion (usage, success rate, users) as evidence,
  hierarchical summaries with automatic supersession, generated AGENTS.md/CLAUDE.md.
* Phase 3: trust ledger: once a class of change has a clean record (e.g. docs
  fixes with green evals), a reviewed constitution amendment may let Phantom
  auto-merge that class. Deploys stay always-ask until the operator changes it.

## 6. Decisions for the operator

1. Initial evidence feeds to wire first (GitHub is the obvious first).
2. Which change classes should earn auto-merge first, and on what record.
