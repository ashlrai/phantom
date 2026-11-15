# Research loop: digest to gated job proposals

The research loop turns external engineering research — agentic dev loops,
eval methods, merge-confidence systems — into scored, bounded job proposals
for the fleet. It is deterministic: no model call, no network access and no
queue mutation in the read path. Design rationale: [the Spawn fleet model vs
Phantom's architecture](strategy/spawn-fleet-model.md).

Pipeline:

```
research digest (markdown)  ->  parse + provenance check
                            ->  score (impact x confidence - effort)
                            ->  dedup vs queued and shipped work
                            ->  admission lint (same gate as restock/queuegen)
                            ->  plan for review
                            ->  --apply appends READY lines to a queue file
```

Nothing reaches a queue by default. `phm fleet research-digest` emits a plan;
`--apply --queue <file>` writes the reviewed subset.

## Digest format

A digest is a local Markdown file with two parts.

### Sources

`## S<n> — <title>` sections, read by the existing harness-digest reader
([HARNESS-DIGEST-FORMAT.md](HARNESS-DIGEST-FORMAT.md)). Each carries
`- Checked: YYYY-MM-DD.`, `- Source: [desc](https://…)` links and optional
`- Takeaway:` records. Issues (missing/invalid/future checked, missing URLs,
duplicate ids) surface in the plan; source text is untrusted data.

### Proposals

A `## Proposals` section holds one bullet per candidate job:

```
- <JOB-ID> | <S-refs> | <attrs> | <scope> | Acceptance: <verification>
```

- `JOB-ID` — starts `RQ-`, uppercase, `[A-Z0-9._-]{1,79}`. This becomes the
  queued job id; stable ids make dedup work.
- `S-refs` — `S1,S3` (or `sources=S1,S3`), the digest sources the proposal is
  derived from. Every reference must exist in the digest.
- `attrs` — space-separated `key=value` pairs:
  - `impact` = 1-5, required. Expected fleet value if shipped.
  - `effort` = `s|m|l`, required.
  - `confidence` = `high|medium|low`, required. Strength of the evidence.
  - `repo` = a fleet repo, default `phantom`.
  - `pool` = a dispatchd pool, default `codex-personal`.
  - `tier` = `frontier|work|mid|fast`, default `work`.
- `scope` — one line of task text naming at least one concrete file path.
  Control characters, `|`, em dashes and `.github/` are refused.
- `Acceptance:` — required; the verification a reviewer can check.

Example:

```markdown
## Proposals
- RQ-RESEARCH-LOOP-DEDUP-1 | S1,S2 | impact=4 effort=m confidence=high repo=phantom pool=codex-personal tier=work | Record proposal sha and source ids in src/core/research/proposals.ts so replays can prove provenance. | Acceptance: npx vitest run test/research-proposals.test.ts passes.
```

## Scoring

`score = impact x confidenceWeight - effortPenalty`, rounded to one decimal.

| confidence | weight | | effort | penalty |
|---|---|---|---|---|
| high | 1.0 | | s | 0 |
| medium | 0.6 | | m | 0.5 |
| low | 0.3 | | l | 1.0 |

Score maps to queue priority: `>= 4` -> P1, `>= 2` -> P2, otherwise P3.
P0 stays reserved for incident-class work; a digest can never mint it.
`--min-score` (default 2) and `--limit` (default 5, max 20) bound a run.

## Dedup

Before a proposal can enter the plan it is checked against the queue file
(`--queue`, when given) and a shipped-work evidence file (`--shipped`, one
landed id or title per line, e.g. `git log --oneline` output):

- `duplicate-id` — the job id already appears as a token in either corpus.
- `overlap` — 80% or more of the proposal's normalized scope tokens appear in
  one corpus line, or in an already-admitted proposal from the same digest.
  The drop record carries the matched line's sha256 prefix, never its text.

A dedup'd proposal is dropped, not queued: the reviewer sees it under
`drops`, so silence is impossible.

## Review gate and queueing

Default output is a plan: `{v, file, generated, candidates, proposals,
drops}`. Each proposal carries its rendered `- READY` line and its admission
lint verdict, so review sees exactly what queueing would write.

```sh
phm fleet research-digest --file docs/research/fleet-digest-2026-11-08.md --json
phm fleet research-digest --file <digest> --queue <ready-queue.md> --apply
phm fleet research-digest --file <digest> --queue <ready-queue.md> --apply --approve RQ-A,RQ-B
phm fleet research-digest --file <digest> --shipped landed.txt --repos-root ~/Projects/ashlrai --pools codex-personal,claude,devin
```

`--apply` requires `--queue`; it re-reads and re-lints the target file at write
time, holds an exclusive `<queue>.lock` (5 s, never stolen), and appends only
proposals that pass parse, dedup and lint — plus the `--approve` id list when
given. Writes are atomic (temp file, fsync, rename). A rejected proposal is
never appended; it stays in `drops` with reasons.

The queue file is the router-queue markdown shape consumed by the bridge's
ready/queuegen flow; this command writes `- READY` lines only where the
operator points it. It installs no timer and dispatches nothing: a scheduler
(the driver restock seam or a daemon tick outside this repo) invokes it on a
cadence, the same way [TOPICS.md](research/TOPICS.md) feeds DRIVER-3.

## Exit codes

`0` success (plan emitted, or apply wrote), `1` unreadable input or apply
failure, `2` bad usage.
