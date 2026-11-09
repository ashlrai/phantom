# Fleet research digest — 2026-11-08

First input for the research loop ([docs/RESEARCH-LOOP.md](../RESEARCH-LOOP.md);
design synthesis in [docs/strategy/spawn-fleet-model.md](../strategy/spawn-fleet-model.md)).
Sources are untrusted research data; proposals below are scored and gated by
`phm fleet research-digest` before any queue sees them.

## S1 — Spawn's permanent agent fleet (founder account via Simon Willison)

- Checked: 2026-11-08.
- Source: [Simon Willison link post, 2026-10-29](https://simonwillison.net/2026/oct/29/how-i-built-the-most-ai-pilled-company-in-the-world/)
- Source: [Jacob Sansbury original post](https://twitter.com/jsnnsa/status/2115623382721126826)
- Takeaway: About 60% of Spawn's work starts from a production error, a
  Savi-filed bug, a log anomaly or a feature request; a triage agent routes
  each signal and a fix reaches the user in about an hour. The fleet works
  because the signal-to-work hop is short and owned.
- Takeaway: No pull requests; agents change the live product and coordinate
  through the code, with helper agents attacking changes they did not write
  and hard-coded gates for irreversible actions. Founder-reported figures:
  77k changes/30 days, ~0.9% reverted over a year, $3M+/month tokens.

## S2 — Spawn fleet mechanics detail (Shipping Skool writeup)

- Checked: 2026-11-08.
- Source: [Shipping Skool case study](https://www.shippingskool.com/use-cases/spawn-team-ships-code-permanent-ai-agent-fleet)
- Takeaway: Permanent named agents own areas (engine, finance, triage,
  deploys), keep memory of past work and spin up helper swarms. The full test
  suite runs every 15 minutes; an hour without a ship is a SEV-0; rollback is
  30 seconds and targeted.

## S3 — Anthropic: building effective agents

- Checked: 2026-11-08.
- Source: [Anthropic engineering post](https://www.anthropic.com/research/building-effective-agents)
- Takeaway: The durable patterns are composable workflows (prompt chaining,
  routing, parallelization, orchestrator-workers, evaluator-optimizer), not
  frameworks. Evaluator-optimizer is the published analog of Spawn's
  "helpers try to break it" pass: a second pass evaluates the first's output.

## S4 — SWE-bench family: the eval-method baseline

- Checked: 2026-11-08.
- Source: [SWE-bench leaderboards](https://www.swebench.com/)
- Takeaway: Resolved-rate over human-filtered subsets (Verified, Lite,
  Multilingual, Multimodal) is the field's canonical confidence vocabulary;
  "run performed or directly checked" provenance flags mirror what our
  eval-report calls a covering evidence channel.

## S5 — GitHub merge queue: merge-confidence as a shipped product

- Checked: 2026-11-08.
- Source: [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
- Takeaway: Merge confidence at scale is "speculative CI over the ordered
  merge line" — each PR is tested with the changes ahead of it, and only
  groups that pass land. The public shape of what our Merge Gate plus
  eval-report already approximate.

## Proposals

- RQ-RESEARCH-LOOP-SIGNAL-TRIAGE | S1,S2 | impact=4 effort=m confidence=high repo=phantom pool=codex-personal tier=work | Add a stuck-lane-to-proposal triage in src/core/fleet/lane-health.ts that writes flagged runs (past phase timeout, unmoving meter) into a dated digest with S-source provenance for research-digest scoring. | Acceptance: npx vitest run test/ covering the new triage mapping passes and phm lanes health output is unchanged.
- RQ-RESEARCH-LOOP-EVAL-PROVENANCE | S4 | impact=3 effort=s confidence=medium repo=phantom pool=codex-personal tier=work | Surface per-merge provenance flags (directly-checked vs inferred evidence) in the eval-report rollup in src/cli/fleet-eval-report.ts, mirroring SWE-bench's checked-run marking. | Acceptance: npx vitest run test/fleet-eval-report.test.ts passes and JSON shape gains a documented field.
- RQ-RESEARCH-LOOP-HELPER-REVIEW | S1,S3 | impact=4 effort=m confidence=high repo=phantom pool=codex-personal tier=work | Add an optional evaluator pass to src/cli/cross-review.ts that runs a second-lane review whose only job is to find ways the candidate breaks other queued work, before merge decision. | Acceptance: npx vitest run for the touched suite passes; review output stays advisory JSON.
- RQ-RESEARCH-LOOP-MERGEQ-CONFIDENCE | S5 | impact=3 effort=m confidence=medium repo=phantom pool=codex-personal tier=work | Record a merge-queue position confidence field in the signed post-merge observation ledger consumed by src/cli/fleet-eval-report.ts so speculative-order failures correlate with position, not just checks. | Acceptance: npx vitest run for the ledger/eval suites passes; no secret or credential fields added.
