# RQ-PH-AUTHDRIFT-ROOT-1 notes (intended path ~/.ashlr-runs/RQ-PH-AUTHDRIFT-ROOT-1.notes.md; that dir is not writable from this sandbox)

## What could NOT be done
No run ids or CI log counts: this worker has no GitHub auth. The 35/110 figure is from the task text, not verified here.

## Verified locally (clean master 281d2139d6, HOME=$(mktemp -d), test:ci)
Both drift suites fail on master itself (3 failed, 7 passed):
- CODEOWNERS block stale: test/merge-queue-loop.test.ts (tier1-test by import) unowned (2 assertions).
- Tier-1 closure grew by 5 files: src/api/bot-templates.ts, src/core/agents/agent-profile.ts,
  src/core/agents/bot-templates.ts, src/core/drive/nodes/capacity.ts, src/core/drive/nodes/profiles.ts.
Counts: 2 CODEOWNERS (one file), 1 closure, 0 hermetic HOME/env, 0 flake.

## Root cause (inferred from the above, not from CI logs)
Advisory check lets drift land; master stays red until repaired, so every merge group is red. verify-changed
only tested the PR head against its merge-base and skipped scripts/ (the closure walks scripts/).

## Fix
CODEOWNERS +1 line (official regen). verify-changed: scripts/ selected; drift also run on origin/master+branch
overlay when master moved. Tests added. Closure snapshot untouched: #6238 and #6229 repair those 5 files.
