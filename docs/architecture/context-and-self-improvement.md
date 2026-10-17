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
  → ranked by realized leverage of their kind → draft PR from an isolated worktree
  → register hypothesis + deterministic metric → measure at exact merge base and head
  → promotion gate (green checks + measured improvement) → merge
  → outcomes feed the next ranking and the proposer-vs-baseline comparison
```

Signals: repeated declined handoffs, steward over-quota roots, and context
tagged `feedback` / `bug` / `feature-request`. `phm improve propose` prints
proposals, ordered by the realized leverage of their kind (proven kinds first,
unmeasured kinds next, kinds with a zero or negative record last).
`--open-pr --repo <dir>` opens each as a **draft** PR
(`workplans/proposals/<id>.md`) on an `improve/*` branch and never pushes to
the default branch. `--auto-merge` is refused on proposals. GitHub evidence
links require a fresh public-repository visibility check; private or unknown
links and local measurements remain withheld.

### Measured outcomes (`src/core/improve/outcomes.ts`, `measure.ts`, `promote.ts`)

A proposal earns credit only from a metric it declares up front:

```json
{ "id": "0123456789", "title": "...", "kind": "team-feedback", "predictedDelta": 0.05,
  "source": { "kind": "model", "engine": "claude", "model": "<exact model id>" },
  "metric": { "name": "eval-pass-rate", "direction": "increase",
              "runner": { "kind": "npm", "script": "eval:memory" } },
  "pr": { "repository": "ashlrai/phantom", "number": 123 } }
```

* `phm improve register <file>` appends it to the digest-chained ledger
  `$ASHLR_HOME/improve/outcomes.jsonl` (public fields only).
* `phm improve measure <id> --repo <dir>` runs the metric in private detached
  worktrees at the PR's exact merge base and head (twice each by default). The
  command's last stdout line must be `{"metric": "<name>", "value": <number>}`.
  It runs with a minimal environment (no tokens or API keys) and a private
  empty HOME, with git hooks and fsmonitor disabled. A failed run, a
  missing script, or two runs of one commit that disagree make the outcome
  **unknown**, never zero.
* `phm improve outcomes` lists outcomes and compares proposers. Proposals
  chosen by the deterministic rules are the baseline; each exact engine/model
  pair is a fixed-model group. A rate or comparison needs at least three
  measured outcomes on each side, otherwise it is reported as unknown.
* `phm improve promote <id> --repo <dir> [--queue-merge]` evaluates the promotion
  gate: the PR is on an improvement-owned branch (`improve/*`, `ashlr-cloud/*`),
  targets the default branch, is not from a fork, has every reported check
  green on its exact head (at least one actually passed, not only skipped), and
  its metric improved between the current merge base and that head. It also
  refuses when Stop or Pause is on; when the diff touches an owner-lane path
  (`src/core/authority/protected-paths.ts`: CI, manifests, test config, Tier-1
  code), the promotion gate itself, the autopilot, Stop/Pause or the governance
  documents; when it changes its own metric script; or when it weakens tests
  (G1b: deleted test files, removed `it`/`expect` calls, added `.skip`/`.only`).
  The ledger's numbers are claims, so the gate re-measures base and head itself
  and refuses unless its own run reproduces the recorded values and improves.
  The default branch comes from GitHub, the checkout's `origin` must be the PR's
  repository, and the PR is re-read after measuring. With `--queue-merge` and an admitted gate it queues GitHub auto-merge
  (`--squash --auto --match-head-commit <head>`) and then re-reads the PR,
  disabling auto-merge again if its head or base changed, so branch protection and
  required checks still decide the merge; it never uses `--admin`. Anything
  else is refused with reasons, and every decision is recorded in the ledger.
  Without `--queue-merge` it only reports the decision. CONSTITUTION.md v3's
  self-improvement section admits exactly this gate and nothing wider.

## 5. Roadmap

* Proposals implement code (agent run in the worktree) and register their own
  metric; cloud backlog items and goal-loop milestones register through the
  same ledger so all autonomous work shares one outcome record.
* Post-merge re-measurement and revert/regression observations
  (`src/core/fleet/post-merge-observations.ts`) subtract credit.
* Leverage per unit of cost once usage receipts can be joined to proposals.

## 6. Decisions for the operator

1. Initial evidence feeds to wire first (GitHub is the obvious first).
2. Which change classes should earn auto-merge first, and on what record.
