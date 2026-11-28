# Community feedback loop

AshlrAI's bet is that many people pointing their own coding agents at the same
open-source tools can out-build a company with far more money. That only works
if feedback from those people reaches the fleet quickly, gets ranked honestly,
and visibly turns into shipped work. This document is the design for that loop
across Phantom and its companions (Phantom Secrets, Locus, Lexicon, Ashlr MD,
Ashlr Stack, Ashlr Plugin).

## 1. Intake

| Channel | Use it for | Status |
|---------|-----------|--------|
| GitHub issues | Bugs, feature requests, structured feedback (templates in `.github/ISSUE_TEMPLATE/`) | Live |
| GitHub Discussions | Ideas, questions, show-and-tell, roadmap votes | Live on phantom, phantom-secrets, lexicon; being enabled on the rest |
| Discord ([The Dev Shack](https://discord.gg/jBQrSU6XeD)) | Real-time help and ideas. A bot will file a `feedback` issue (linking back to the message) when a maintainer or the poster reacts with a ticket emoji | Server live; feedback bot planned |
| Anonymous telemetry | Install and weekly-active counts per tool, version and OS ([TELEMETRY.md](TELEMETRY.md)) | Shipping |

Every template applies `needs-triage` plus a type label, so nothing is lost
between channels.

## 2. Triage (agents first, humans for judgment)

A fleet triage lane runs on every new issue and discussion and at least daily:

1. **Deduplicate.** Link duplicates to the canonical issue and add the
   reporter as a +1 there, so demand is counted once per person.
2. **Classify.** One type label (`bug`, `enhancement`, `feedback`, `docs`,
   `question`), one `area:*` label, and a size guess (`size:s|m|l`).
3. **Readiness.** `agent-ready` when the issue has a clear expected outcome and
   a way to verify it; `good first issue` when it is also small and local;
   `needs-info` with a specific question otherwise.
4. **Safety.** Security reports move to private reporting (SECURITY.md).
   Personal data, tokens and paths are redacted. Outside pull requests never
   trigger privileged workflows or auto-merge arming without the author check.
5. Remove `needs-triage`.

Target: first response within 24 hours, triage within 48 hours.

## 3. Ranking into a roadmap

Each triaged item gets a score, recomputed daily:

```
score = demand x severity x reach / effort
demand   = unique people (reporters + thumbs-up + discussion upvotes + linked duplicates),
           outside contributors weighted 1.5x, founders and fleet accounts 0.5x
severity = bug blocking install/usage 3, bug with workaround 2, enhancement 1.5, polish 1
reach    = 1 + log10(1 + weekly active installs of the affected tool)
effort   = size:s 1, size:m 2, size:l 4
```

Scores decay by half after 60 days without new demand. The ranked list is
published as the public roadmap on [ashlr.ai/open-source](https://ashlr.ai/open-source)
(generated, never hand-edited), and the fleet pulls the highest-scoring
`agent-ready` items first. Founders can pin or veto an item with a short public
reason; that override is recorded, not hidden.

## 4. Closing the loop

- The PR that fixes an item says `Fixes #N`; on merge, the issue (and any linked
  discussion or Discord thread) gets a comment naming the release it ships in.
- Release notes credit reporters and outside contributors by handle.
- A weekly digest (Discussions announcement, later mirrored to Discord) lists
  what shipped, the top of the roadmap, and new contributors.

## 5. Any agent can contribute

Every repo ships `AGENTS.md` (Codex and most agents), `CLAUDE.md`, `GEMINI.md`,
`.github/copilot-instructions.md`, Cursor rules and `llms.txt`, plus an
optional **Agent used** line in the PR template. Bring Codex, Claude Code,
Cursor, Copilot, Gemini CLI, Grok, Devin, Aider, Windsurf or a local model; the
path from issue to merged PR is the same. See
[CONTRIBUTE-WITH-AN-AGENT.md](CONTRIBUTE-WITH-AN-AGENT.md).

## 6. What we measure

Collected weekly and shown on the internal adoption dashboard; the public
subset appears on ashlr.ai/open-source.

- Real installs and weekly active installs per tool (telemetry, internal
  machines and CI excluded).
- PRs opened and merged per repo, human vs agent, and by agent.
- First-time and returning outside contributors; outside PR merge rate.
- Issues and discussions opened by outsiders.
- Median time to first response, to triage, to first review and to merge.
- Loop health: share of shipped work that started as outside feedback.

## 7. Status

- [x] Issue templates with triage labels (this change)
- [x] Any-agent instruction files and the Agent used PR field
- [x] Contributor metrics collector (internal)
- [ ] Anonymous install telemetry merged in phantom and phantom-secrets
- [ ] Discussions enabled on every core repo
- [ ] Fleet triage lane (dedupe, classify, readiness) running daily
- [ ] Generated ranked roadmap on ashlr.ai/open-source
- [x] Discord server and invite ([The Dev Shack](https://discord.gg/jBQrSU6XeD))
- [ ] Discord feedback bot (reaction to issue)
