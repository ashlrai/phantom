# Frictionless merge path

Status: proposed pipeline; only the pure path classifier is implemented. No
workflow, required check, publisher, release permission or host pin changes in
this change. Baseline: `e14dc05359895de0bad9bff3cf8c285c4545d635`, reviewed
2026-11-14 in the `RQ-CMP-FRICTIONLESS-1` worktree.

## What actually runs today

[CI](../../.github/workflows/ci.yml) already skips the full matrix on **every**
PR, merge group and master push, including Tier-1 changes. Its hard fast-event
requirements are `secret-shape`, `secret-scan` and `classify`; `quick` runs but
its result is advisory. `Merge Gate` waits for these dependencies and validates
the selected/excluded job inventory. The full matrix is scheduled every six
hours, also available manually/reusably. Master pushes do not run full CI.

Consequently this proposal cannot claim savings from removing a per-PR full
matrix. It strengthens pre-merge coverage for risky changes and removes
redundant work only from an explicitly narrow documentation lane.

There is no committed snapshot of the hosted merge-queue required-check rules.
The workflow emits `Merge Gate`; that alone does not prove it is required.
[host-merge.ts](../../src/core/fleet/host-merge.ts) reads effective rules through
`repos/ashlrai/phantom/rules/branches/master` and unions classic protection from
`repos/ashlrai/phantom/branches/master`. The
[release policy](../../.github/release-policies/release-path-v2.json) identifies
master and the CI app, but does not list required contexts. Live inspection
was unavailable because `gh` could not read its local configuration (EPERM).
Before rollout, capture both APIs, check identities and merge-queue requirements;
preserve their union. Unknown configuration must never be treated as no checks.

## Deterministic risk rules

[classifyCiRiskTier](../../src/core/ci/risk-tier.ts) accepts a complete array of
changed paths and returns `{ schema: 'ci-risk-tier.v1', tier, reasons }`.
Reasons are deduplicated by path and sorted in stable lexical order. Input order,
environment, current files and network state cannot affect its answer.
`blocked > full > smoke`; one higher-risk path raises the whole diff.

Read-only example from the repository root after installing dependencies:

```sh
npx --no-install tsx --eval 'import { classifyCiRiskTier } from "./src/core/ci/risk-tier.ts"; console.log(JSON.stringify(classifyCiRiskTier(["README.md"])));'
```

This is a CI workload recommendation, not permission to merge, publish, send,
install or spend. `blocked` means no automatic CI qualification; running more
tests cannot cure missing evidence or authorize secret material.

| Precedence / canonical rule | Tier | Exact interpretation |
| --- | --- | --- |
| `missing-diff`, `unsafe-path` | blocked | Missing/non-array/empty input, non-string entry, or noncanonical path. Reuse `normalizeRepoPath`; additionally reject normalization changes and colons (drive/ADS ambiguity). No absolute, traversal, control, empty segment, `.git`, backslash or `./` paths. Invalid input is not echoed. |
| `secrets` | blocked | Every pattern in `PROTECTED_PATH_RULES` with id `secrets`, even when another G1 rule matches first. Missing secret policy also blocks. |
| `case-collision` | blocked | Distinct names that differ only by case, including case-only renames, are ambiguous on supported case-folding macOS checkouts. |
| `ci-config`, `codeowners` | full | CI config across providers, `.github/**`, CODEOWNERS in every location covered by G1. |
| `manifest`, `verify-config`, `build-and-hooks` | full | All G1 package/lock/config/build/hook patterns at their canonical depths. |
| `release-tooling`, `authority-doc` | full | All G1 release/build/custody/plist/capability patterns and authority documentation. |
| `tier1-authority-code` | full | Every `TIER1_SOURCE_PATTERNS` entry, including future additions. Always `selfRepo: true` for Phantom. |
| `tier1-test-infra`, `comms-agent`, `tier1-test` | full | G1 setup/fixture/config/send-policy patterns and named/safety Tier-1 suites. |
| `test-path` | full | Every additional `isTestPath` match, so innocuously named tests importing authority code remain full without content scanning. |
| `agent-instructions` | full | Basename AGENTS, SKILL, CLAUDE or GEMINI followed by `.md`, case-insensitive, at any depth. |
| `runtime-input` | full | `docs/NORTH-STAR.md`, `docs/ECOSYSTEM-MAP.md`, `docs/IMPROVEMENT-BACKLOG.md` (case-insensitive), and any fixture(s), template(s) or script(s) directory segment. |
| `documentation` | smoke | Only exact `README.md`, `CHANGELOG.md`, or `docs/` plus a nonempty suffix ending `.md`; no dot-prefixed segment, and only after all preceding exclusions. This allowlist is case-sensitive. |
| `unclassified-path` | full | Everything else: application code, transitive Tier-1 dependencies, web/native code, scripts, new areas, images, MDX, config and unknown extensions. |

The classifier imports the canonical matcher and secret patterns from
[protected-paths.ts](../../src/core/authority/protected-paths.ts); it does not
copy its glob engine or Tier-1 list. G1 matching stays case-insensitive and
first-match-wins except for the independent secret check. Future protected
rules automatically become full before the smoke allowlist is considered.
The current `comms-agent` pattern names a trailing-slash directory rather than
a subtree; its source descendants still get full through the default rule.
The G1 owner-lane descriptions are retained as existing policy; CI classification
does not reinterpret those descriptions as new approval requirements.

Security GATES v3 pins remain separate: secret scrub/gate/publish scripts,
sandbox profiles, leader wrappers/prompts/plists, MACCU/TCC and loopback auth
cannot bypass their pin review by passing full CI. Such non-doc paths are full
even when absent from G1. Workflow content that leaks secrets cannot be detected
from names; mandatory secret/diff controls still apply. The classifier itself
and its tests also default full. Before activation, protect the classifier and
its transitive policy inputs under the reviewed CI policy boundary.

## Target pipeline

1. **Self-verify before publication.** In an isolated checkout, run
   `node scripts/verify-changed.mjs`, `npm run check:docs`, affected tests via
   `npm run test:ci -- test/<affected>.test.ts`, and build/web/native checks when
   affected. Test execution uses a temporary HOME. Full-risk diffs run the
   applicable complete security/authority suites. Treat missing tools, skipped
   required commands, deferred checks and nonzero exits as failure. Capture exact
   base/head/tree, dependency lock digest, policy/checker versions, commands and
   results in a host-verified receipt. Dirty/untracked state or any edit after
   verification invalidates it. A rebased candidate needs a matching receipt.
2. **Classify from trusted policy.** Execute the reviewed base-policy classifier,
   never a PR's replacement classifier. Obtain a complete diff with
   `git diff --name-only --no-renames -z BASE HEAD --` using validated exact
   commit IDs. Check Git's exit status, decode without dropping records and strip
   only the terminal NUL. Include additions, deletions, both rename endpoints
   and every merge-group member; never apply an extension filter or truncate a
   paginated API result. PR comparison uses the merge base; queue comparison
   uses the event's exact base and synthetic head. Missing objects, truncated
   evidence or base/head mismatch blocks qualification.
3. **Check smoke eligibility beyond names.** For every changed path, inspect
   both trees: existing entries must be ordinary `100644` blobs, with bounded
   text content; absent entries are allowed only for proven adds/deletes. Mode
   changes, symlinks, submodules and binary content require full checks. Keep
   content-level secret and test-tampering guards. Documentation feeds command
   discovery, so run its reader contracts rather than assuming Markdown has no
   runtime effect. Start with the existing
   [Markdown test selector](../../.github/scripts/select-docs-markdown-tests.mjs)
   and `test/planner-real-supply.test.ts`; the selector omits built-dist readers,
   so check their coverage explicitly or promote the candidate to full.
   A path-only smoke answer is insufficient by itself.
4. **Queue verifies the combined candidate.** Keep both independent secret scans,
   deterministic classification and one hard `Merge Gate` result. For smoke,
   run only a bounded Ubuntu smoke job: classifier tests, documentation checks
   and relevant Markdown-reader tests, generated ownership/import-closure drift
   checks and exact receipt validation. Reuse trusted base compiler/artifact
   evidence only when code/config/tree identity is proven. Target a five-minute
   job cap; retain the existing budget until cold-cache timing proves it fits.
   For full, require full static/build/test/security/platform lanes on the exact
   synthetic head. Blocked evidence fails the gate. Missing, cancelled, failed
   or unexpectedly skipped required jobs fail; advisory results cannot satisfy
   the chosen lane. Do not remove hosted required checks or bypass the queue.
5. **Run full CI after merge and on schedule.** Add complete post-merge coverage
   for every merged tree and retain the six-hour audit/complete Mac rotation.
   Deduplicate only identical immutable trees, not merely adjacent commits.
   If coalescing to a later master tip, record the earlier SHA as uncovered
   until explicit coverage/bisect evidence exists. Full CI failure routes to
   main-guardian fix-forward and suspends smoke qualification while main is red
   or the observer is unhealthy. Release/build/publication checks remain separate.
6. **Observe for 72 hours.** Feed verified failed-run, revert, deterministic
   bisect and overlapping-fix observations into the existing signed
   [post-merge ledger](../../src/core/fleet/post-merge-observations.ts). Use
   [eval-report](../../src/core/fleet/eval-report.ts) to distinguish pending,
   adverse, stable and unobserved merges. An elapsed window without a covering
   evidence channel stays unobserved. A failure alone is not proof which PR
   caused it; retain attribution basis/confidence. Stable is not proof that
   every platform passed. Observer coverage and exact-tree full-CI evidence
   must be recorded separately before expanding smoke eligibility.

The current [publisher](../../contrib/mac/publish.sh) has optional
`PUBLISH_FULL_TESTS` (off by default), logs that test command's status without
making it a mandatory publication gate, and has an opt-in judge command. It
does not invoke verify-changed. [scripts/bridge/publish.sh](../../scripts/bridge/publish.sh)
only runs the disk completion hook. The existing
[verify-changed](../../scripts/verify-changed.mjs) cache binds tree/base/checker
inputs, but missing ESLint is a skip, authority drift selection is conditional,
and affected tests/docs/build are separate. None is already the complete receipt
contract above. Publisher changes require their existing Security pin process.

Roll out in shadow first: compare classifier answers and cold-cache timings
against existing CI, verify the complete required-context inventory and reader
coverage, then land a separate Security-reviewed workflow/publisher integration.
Rollback means forcing full qualification for every candidate, retaining secret
gates, and repairing forward. This change activates none of those transitions.

## Workflow inventory and minute model

All 18 workflow definitions were reviewed. Values below are sums of configured
job timeout ceilings, **not measured runtime, elapsed latency or billed minutes**.
Matrix parallelism, cancellations, conditional jobs, warm caches and OS billing
multipliers prevent treating these caps as spend. No historical runtime data was
available; actual expected savings remain unmeasured.

| Workflow | Events / purpose | Job-minute ceiling |
| --- | --- | ---: |
| `ci.yml` | PR / merge group / master push | 30 |
| `ci.yml` | Six-hour audit / complete manual audit | 405 / 675 |
| `ci.yml` | Half-hour release preparation | 115 |
| `perf-budget.yml` | Every PR, daily, manual; advisory | 30 |
| `pr-topology.yml` | PR-target observation, manual | 5 |
| `merge-queue-reaper.yml` | Merge group, half-hour, manual | 5 |
| `dependency-audit.yml` | Master push, selected PR paths, daily, manual | 20 |
| `custody.yml` | Daily / manual | 20 |
| `companion-smoke.yml` | Daily / manual | 30 |
| `ecosystem-stats.yml` | Daily / manual data publication | 10 |
| `attest-ci-build.yml` | Half-hour / manual attestation | 15 |
| `auto-tag.yml` | Selected push / CI completion / half-hour / manual | 15 |
| `release-please.yml` | Master push / half-hour / manual | 10 + conditional 10 |
| `release-train.yml` | Hourly / workflow completion / manual, variable-gated | 20 |
| `publish-canonical-npm.yml` | Manual | 60 |
| `finalize-github-release.yml` | Manual | 28 |
| `publish-phantom-registry.yml` | Manual, legacy identity condition | 10 |
| `promote.yml` | Manual historical promotion | 10 |
| `release.yml` | Frozen historical v3.3.2 tag | Reusable CI + 90 explicit; two jobs omit explicit caps |
| `release-desktop.yml` | desktop-v tag | Two platform jobs omit explicit caps |

Workflow files live under [.github/workflows](https://github.com/ashlrai/phantom/tree/master/.github/workflows).
Trigger definitions are source evidence, not proof of live workflow enablement.

Reproducible arithmetic from `ci.yml`:

- Fast: secret-shape 5 + secret-scan 5 + classify 5 + quick 10 + Merge Gate 5
  = **30** job-minutes per event.
- Full matrix: Ubuntu authority 1/3 has 60; the other six Ubuntu/Windows entries
  have 25 each = **210**. Additional jobs: shared Mac 15, general Mac 90 per
  selected shard, isolated Mac 30, native broker 20, Windows service 15.
  Common scans/classifier/aggregator = 20; scheduled/manual fixup queue = 5.
- Ordinary untagged audit: 210 + 15 + 90 + 30 + 20 + 15 + 20 + 5 = **405**.
  [Mac rotation](../../.github/scripts/ci-mac-rotation.mjs) selects one general
  shard. Complete manual `mac_shard=all` adds 3 × 90 = **675**. A tag at HEAD
  can force the complete set, so 405 is conditional. Four ordinary scheduled
  audits/day budget 1,620 job-minutes. Full Merge Gate currently omits Mac jobs
  from `needs`; the target aggregator must require all selected platform jobs.
- Release preparation: common 20 + fixup 5 + release-build 90 = **115**,
  up to 48 scheduled events/day. These release costs are outside smoke savings.

For an ordinary docs-only PR revision and one queue attempt, assume a measured
five-minute smoke replaces ten-minute quick, and the advisory perf workflow
defers these documentation diffs to its existing daily run:

| Scope | Current cap | Proposed cap | Reduction |
| --- | ---: | ---: | ---: |
| CI per event | 30 | 25 | 5 (16.7%) |
| PR including perf 30 and topology 5 | 65 | 30 | 35 |
| Merge group including reaper 5 | 35 | 30 | 5 |
| One PR + queue attempt | 100 | 60 | **40 (40%)** |

Without perf deferral the pair saves only 10 (10%). For 100 eligible pairs,
the illustrative reduction is 4,000 cap-minutes, or 1,000 without deferral.
`docs/DEPENDENCY-SECURITY.md` additionally triggers dependency audit; its 20
minutes remain unchanged and are excluded from this ordinary example.

Full checks for higher-risk events and new post-merge audits add costs. A complete
full run with all Mac shards, without the scheduled/manual-only fixup job,
budgets 670; replacing a current 30-minute fast event adds 640. Each new complete
post-merge run adds 670 (plus any explicitly retained quick/fixup work). Thus:

```text
net cap-minutes saved = 5 * smoke fast events + 30 * deferred docs perf runs
                     - 640 * upgraded full premerge events
                     - 670 * new complete postmerge runs
```

Existing schedules and release work cancel out of this comparison. Do not claim
positive repository-wide savings without observed tier frequencies, retries,
exact-tree reuse and actual per-job timings. Measure runner-duration sums by
event/tier and p50/p95 queue latency separately; report uncovered 72-hour windows
alongside regression rates so speed cannot hide lost evidence.
