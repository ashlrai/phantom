# Documentation inventory and audit

Snapshot: 2026-11-07. This is a navigation and mechanical audit, not a claim
that every statement in the documentation has been verified against source.
The tree contained 365 files, including 333 Markdown files: 204 files at the
root and 161 under subdirectories (including 90 contract files and 20 images).
Use the [task index](README.md) for canonical guides and the
[knowledge map](ARCHITECTURE-KNOWLEDGE.md) for source entry points.

| Inventory | Contents and interpretation |
| --- | --- |
| Root guides | Installation, commands, operations, architecture and feature guides. `cli.md` is a generated reference; check source and the installed registry for current commands. |
| `contracts/` | Milestone and feature contracts; a contract is not proof of activation. |
| `research/`, `plans/`, `design/`, `architecture/`, `adr/`, `doctrine/` | Research, proposals and design decisions; distinguish targets from implemented behavior. |
| `archive/`, `internal/` | Historical or internal material; check dates and current implementation before relying on it. |
| `api/`, `fleet/`, `router/`, `lanes/`, `companions/`, `observability/`, `perf/`, `examples/` | Subject-specific reference and operational material. |
| `images/` and root JSON/text files | Illustrations, indexes and machine-readable reference data. |

## Findings and coverage

- The repository documentation checker passed for its selected entry points;
  it checked local and source links without making external requests.
- A separate scan of relative Markdown links across all 333 Markdown files
  produced one missing target: `M0-bootstrap.md` in `MILESTONE-CONTRACT.md`.
  It is a fictional roadmap example inside a code fence, not a broken link.
- `RELEASE-AUTONOMY.md` says the command is not wired at the top level. The
  handler exists in `src/cli/release-autonomy.ts`; existence of the handler
  alone does not establish dispatcher wiring, so this was not changed.
- `AGENT-OPERATIONS.md` documents `phm metrics levers --json`, which
  `src/cli/metrics.ts` dispatches, but shell completions omit `levers`.
  Consequently the doc-facts verb test fails. The documentation is correct;
  completion drift needs a code fix outside this documentation audit.
- `test/doc-facts.test.ts` checks a specified set of agent-facing documents,
  top-level commands, completion verbs and flags found anywhere in `src/`.
  It does not establish full command syntax or cover all guides. The code map
  has a separate directory drift test; neither proves semantic freshness.

No confirmed broken documentation lines were fixed in this pass. External
links, anchors, all individual command arguments, and semantic claims across
all 333 Markdown files were not exhaustively verified. Treat unreviewed claims
as unknown; compare the relevant guide with source and tests before use.
