# Research topics

The offline restock source reads bullets in the form `- STABLE-ID | question`.
Keep IDs stable: they become part of daily queue IDs. Other Markdown is ignored.
Use one question per line. Hold-list entries are case-insensitive literal phrases
or IDs; matching candidates are excluded. Unsafe topics are ignored.

- SOURCE-FRESHNESS | How should an engineering agent measure source freshness and preserve provenance?
- RETRIEVAL-QUALITY | Which reproducible evaluations best measure retrieval quality for repository research?
- LOCAL-RESEARCH | Which local retrieval approaches support useful offline engineering research?
- RESEARCH-HANDOFF | How can research findings become small testable engineering proposals?
- EVIDENCE-CONFLICTS | How should an agent report conflicting primary evidence and uncertainty?
- RESEARCH-COST | Which measurements reveal research usefulness per unit of compute?

## Restock contract

`src/core/driver/restock.ts` is the DRIVER-3 integration seam. Pass the topic
file contents, full queue contents, explicit hold list and current time to
`restockQueue` under the queue writer's existing lock, then persist its returned
queue. DRIVER-3 is absent in this checkout; this module does not install a timer
or dispatch jobs. The driver should invoke it on each restock tick.

The default target is three lines per UTC day, configurable to two through four.
IDs have the form `RQ-RESEARCH-YYYYMMDD-TOPIC-ID`. Existing daily IDs count toward
the quota, including completed jobs. Retain IDs in the input queue or its history
when pruning completed work. Repeated ticks fill only the remaining quota.
Topics rotate daily; later days may revisit a question with fresh evidence.
If holds or invalid topics leave too few candidates, return fewer lines instead
of bypassing exclusions. Hold input is required; pass an empty list explicitly
when no items are held. Callers must not persist a stale snapshot concurrently.

Each line uses `ID (P2, pool=codex-personal, tier=work, repo=phantom): Research
question. Acceptance: ...` and includes the exported research acceptance tail.
The tail requires dated primary sources, alternatives, recommendations and
limitations, with findings confined to this directory and no code changes.
No provider, token, network access or Grok Bot is needed to generate lines.
