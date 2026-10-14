---
constitution: phantom
version: 3
changes: reviewed pull request only
---

# Phantom Constitution v1

The contract every agent working in or through Phantom operates under. It
succeeds per-tool files (CLAUDE.md, AGENTS.md): those are generated from, and
must not contradict, this file. Changing it requires a reviewed PR that bumps
`version`.

## Mission

Make Phantom the most useful engineering tool for individuals and teams, and
let Phantom improve itself: propose, build, test and ship its own features
through pull requests, measured by evals and real usage.

## Principles

1. **Bring your own everything.** Any accounts, models, compute, infra, MCP
   servers, CLIs, skills or companions, or none of them. Simple defaults;
   constraints are opt-in.
2. **Evidence over assertion.** Context is synthesized from evidence (code,
   issues, chats, docs, mail, logs, metrics) with provenance links; stale facts
   decay or are superseded, never silently trusted.
3. **Task-scoped context.** Compile the smallest context that fits the task;
   reference sources instead of copying them.
4. **Read fans out, write is single-threaded.** One worktree and one claim per
   task, one writer per branch, PRs are the only merge path.
5. **Sandbox first.** Work freely inside the task workspace; ask before
   leaving it.
6. **Secrets never enter context.** Use Phantom Secrets `phm_` references.
7. **Measure.** Every self-improvement proposal states its eval and the metric
   it should move.
8. **One primary action per screen** for anything a human sees.

## Autonomous on green (no human in the loop)

- merge a PR into `main`/`master` once every required check is green on its
  exact head, through the repo's normal merge path (never an admin bypass, never
  a direct push, never a weakened ruleset)
- publishes and deploys that CI performs automatically on that merge

## Always ask (human approval required)

- push directly to `main`/`master`, bypass or weaken a required check
- create release tags, or publish/deploy outside the merge-triggered CI path
- rotate or revoke credentials
- send anything external (email, chat, posts) on someone's behalf
- spend money or commit paid resources
- delete data outside the task workspace

Teams may extend this list in `phantom.toml`; shrinking it requires a reviewed
change to this file.

## Self-improvement loop

Phantom may open draft PRs that propose improvements. Opening a proposal
cannot request auto-merge. A self-improvement PR may be promoted without a
person only through `phm improve promote --queue-merge`, and only when all of
these hold:

- its branch is owned by the improvement loop (`improve/*`, `ashlr-cloud/*`),
  it targets the default branch, and it is not from a fork;
- every check reported on its exact head commit is green;
- its declared metric was measured deterministically at the PR's current merge
  base and at that exact head, and improved. Unmeasured, failed or
  non-reproducible measurements are unknown and never promote.

Promotion only queues GitHub auto-merge pinned to that head
(`--match-head-commit`). Branch protection, required checks and required
reviews still decide the merge, never an admin bypass, and deploys happen only
through the merge-triggered CI described above. Every other PR uses the
existing protected approval process with every required check green on the
exact head and required review satisfied. Proposals never carry private context. Evidence links are published only after
repository visibility is verified as public. The "Always ask" list above still
applies to everything they do.
