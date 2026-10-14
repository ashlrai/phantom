# Memory and context research

Research reviewed October 14, 2026. This guide records design priorities and
evaluation criteria. It does not announce an activated active-memory service or
qualify an installed release. The onboarding source in this branch is described
in [Context import](https://github.com/ashlrai/phantom/blob/master/docs/CONTEXT-IMPORT.md).

## What users need

Useful memory should help an agent resume work, apply the latest project
decision, recognize a correction, and find the evidence behind an answer.
Remembering more text is insufficient if the agent uses an old decision, shares
private context with another project, or mistakes quoted instructions for
permission to act.

Phantom already has shared project memory, team context, approved lessons,
skills, outcomes, and genome recall. These stores have different contracts.
The next step is a small composition layer with explicit source and scope,
using existing stores rather than replacing them with another global database.
Shared project memory currently stores operator content in a private file;
reads, displayed output, and creation-time instruction snapshots scrub secrets.
Read-time redaction does not sanitize the private file at rest.
That file alone does not establish sentence-level provenance or temporal truth.

## Current research

Meta's October 12 [Muse Wonder research announcement](https://research.meta.ai/blog/muse-wonder)
uses **Active Memory** for carrying relevant context across conversations, and
**Active Focus** for sustained goal-directed work. Its
[model card](https://research.meta.ai/static/muse-wonder-model-card) describes an
internal conflict/update memory evaluation. The inspected material does not
provide a reproducible storage, consolidation, deletion, or permission design.
The exact recalled Alexandr Wang quotation and a controlled comparison against
OpenClaw were not verified.

Current [OpenClaw Active Memory documentation](https://docs.openclaw.ai/concepts/active-memory/how-it-works)
already describes scoped, bounded active recall with an explicit no-result
outcome. Its [memory architecture](https://docs.openclaw.ai/concepts/memory-architecture)
documents provenance, consolidation gates, revisions, and concurrency. These
are documented product behaviors, not evidence of comparative benchmark
quality. Phantom should evaluate against current implementations.

Seventeen primary studies were inspected, including methods, limitations, and
latest available versions. The following findings drive the proposed work:

| Study | Version inspected | Implication for Phantom |
| --- | --- | --- |
| [MemoryArena](https://arxiv.org/abs/2602.16313v2) | v2 | Evaluate interdependent multi-session tasks, where prior work actually matters. |
| [Agent memory systems characterization](https://arxiv.org/abs/2606.06448v2) | v2 | Measure construction, retrieval, and maintenance separately from model generation. |
| [Agent-native memory systems](https://arxiv.org/abs/2606.24775v1) | v1 | Include update and maintenance behavior when comparing systems. |
| [Authority collapse at consolidation](https://arxiv.org/abs/2608.01679v2) | v2 | Preserve the distinction between reference content, reviewed facts, and execution authority. |
| [Epistemics of agent memory](https://arxiv.org/abs/2609.33013v1) | v1 | Test whether consolidation improvements transfer to useful tasks. |
| [MemCalib](https://arxiv.org/abs/2609.24259v3) | v3, October 8 | Measure both overuse and underuse of memory. |
| [Agentic Memory / AgeMem](https://arxiv.org/abs/2601.01885v3) | v3, July 23 | Learned memory management is an experiment after a reproducible baseline. |
| [Active Context Compression](https://arxiv.org/abs/2601.07190v1) | v1 | Preserve actionable dependencies when reducing context. |
| [Sleeper memory poisoning](https://arxiv.org/abs/2605.15338v2) | v2, May 18 | Include delayed contamination and recall-trigger fixtures. |
| [Retention versus retrieval](https://arxiv.org/abs/2610.00366v1) | v1 | Measure what is stored separately from what is used. |
| [Forgetting versus use](https://arxiv.org/abs/2609.10263v1) | v1 | Excluding a fact from a context pack is distinct from deleting it. |
| [Experience consolidation and governance](https://arxiv.org/abs/2610.05176v1) | v1, October 4 | Scope reusable skills and measure their reliability before promotion. |
| [Persistent multi-agent memory](https://arxiv.org/abs/2610.07782v1) | v1, October 6 | A null result can expose an evaluation that gives recall no useful evidence. |
| [Memory depth and context width](https://arxiv.org/abs/2610.08300v1) | v1 | Compare retrieval changes under matched access and budgets. |
| [Test-Time Memory Construction](https://arxiv.org/abs/2610.13348v1) | v1, October 9 | Keep source backlinks; compare deferred construction with total query costs. |
| [Memory repair](https://arxiv.org/abs/2610.13267v1) | v1 | Evaluate repair and removal against independently defined contamination cases. |
| [Token-level evidence retrieval](https://arxiv.org/abs/2610.13277v1) | v1 | Candidate recall improvements need measured tail latency and fleet-scale costs. |

These are research inputs. Paper headlines, code availability, model judges,
and vendor benchmarks do not establish Phantom task success. Reduced memory
construction overhead does not necessarily reduce total tokens or latency.

## Proposed composition layer

The first foundation should validate project-scoped facts with source IDs,
review decisions, validity dates, revision lineage, and explicit uncertainty.
Conflicting current facts should remain disputed until resolved. A later import
of an old conversation must not replace a newer decision just because it was
imported more recently.

Build compact, cited context packs with deterministic local eligibility and
temporal filters before ranking. Record the included and excluded source IDs,
byte budget, and source revisions. Cross-project collections require explicit
admission. Personal memory needs a separate scope and consent policy because
current project memory instructions prohibit personal data.

An optional recall worker can later investigate missing evidence within fixed
time, token, and expansion limits. It should return evidence or an explicit
unavailable/no-result outcome. Recall must not grant permissions, promote facts,
or block a web request while constructing memory. Live health, release SHA,
account ownership, and effect authorization require current evidence outside
memory.

The onboarding source saves selected, normalized reference records, rather
than a complete original conversation archive. The original-source hash is a
client claim; the selected-content hash binds the saved selection. Reviewed
facts enter the existing memory editor as an editable draft with a separate
Save. A full archive, structured fact store, bounded recall worker, and
automatic consolidation remain proposed work.

## Evaluation before activation

Use frozen, paired coding tasks with equal models, available evidence, and
total budgets. Compare the existing Markdown baseline, deterministic scoped
selection, and any later enriched retrieval. Include fresh-session handoff,
corrected configuration, stale release facts, cross-project exclusion,
conflicting reviews, deletion, retries, and concurrent edits.

Report executable task success, stale-fact use, unsupported claims, relevant
evidence coverage, p50/p95 latency, and construction + retrieval + generation
cost. Timeouts, failures, and unavailable results stay in the denominator.
Publish negative results. Offline fixtures validate contracts; they do not
prove model-driven coding improvement. No paid model benchmark was run for
this research review.
