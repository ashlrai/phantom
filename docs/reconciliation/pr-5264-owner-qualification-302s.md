# PR #5264 owner qualification — RQ-PHX-COCKPITOWNERQUALIFY302S

As-of: 2026-11-13T19:15Z (UTC). Evidence source: local git object store after
`git fetch origin master`, `git fetch origin pull/5264/head`,
`git fetch origin pull/5187/head`, plus unauthenticated GitHub REST reads of
`/repos/ashlrai/phantom/pulls/5264` and `/pulls/5187`. This is SOURCE
qualification of the bound trees below. It is not installed-runtime
verification: nothing here asserts the cockpit is wired into a live CLI,
reachable, or that any GitHub traffic occurred. No credentials touched, no
network mutations, no Slack/iMessage traffic.

## Bound revisions

| Item | Value |
| --- | --- |
| Original PR | ashlrai/phantom #5187 `bridge: RQ-PHX-MERGEPAGEEVIDENCERECOVER184` (branch head `7edfc6d8f37cce2a719916e151da620892c65775`) |
| Original state | CLOSED, not merged, `closed_at` 2026-11-13T18:37:24Z (two seconds after #5264 merged — superseded, not merged itself) |
| Owner PR (existing, not created by this job) | ashlrai/phantom #5264 `bridge: RQ-PHX-MERGECOCKPITEXACT206S`, branch `codex-bridge/RQ-PHX-MERGECOCKPITEXACT206S` |
| Owner head (rechecked this session) | `c7131b289d531cb95495d7e07b26b24a70439874` — matches the observed head in the fleet context |
| Owner merge state | **MERGED** 2026-11-13T18:37:22Z by `masonwyatt23`; merge commit `f4ccf5fab852f1e33d2ee7788f8c46e5699795dc`; `git merge-base --is-ancestor` confirms it is on `origin/master` |
| origin/master at fetch | `a4e2346a17d34fba1b21ef9cd1dfc1064b0e3fa6` (re-fetched before finish: `dbe58d2a93eedfc3a2bc78c0839bb85bc67cfb50`; named files re-diffed IDENTICAL on the newer head) |
| Owner/claim | Fleet context live claims at 2026-11-13T14:59 ET list no claim covering #5264 or this job; the PR body records pool `claude` on base `8a5b7ee39`. No competing claim found. |

Because #5264 is merged, executable evidence runs directly on this worktree
(`origin/master` content); no isolated owner checkout was needed.

## Path matrix — named files only

The PR's own diff is +87/−0 across two added files (the three-dot diff against
the merge-head parent is misleading; named contents were compared directly).

| Path | #5187 head `7edfc6d8` | #5264 head `c7131b28` | origin/master `a4e2346a` | Verdict |
| --- | --- | --- | --- | --- |
| `src/core/merge-cockpit.ts` | blob identical | blob identical | blob identical (`diff -q` clean, 40 lines) | **PRESERVED — byte-exact end to end** |
| `test/merge-cockpit-exact-206s.test.ts` (was `test/merge-cockpit-pagination-recovery-184.test.ts` in #5187) | content identical under old name | identical | identical (`diff -q` clean, 47 lines) | **PRESERVED — byte-exact, rename only** |

Genuinely missing behavior inside the PR's own scope: **none found**. Every
line the original added exists verbatim on master.

Out of scope / observations for the owner (not fixed here):

1. `src/core/merge-cockpit.ts` has **no production caller** — `grep -rn
   "merge-cockpit" src/` finds only the module itself; no CLI verb, MCP tool
   or web route imports `fetchRepo`/`summarize`. The cockpit is currently
   exercisable only from tests. If the Nov5 backlog reconciliation /
   Nov12 receipt-backed coordination orders need a live surface, that wiring
   is separate unmerged work, not a regression of #5264.
2. `HOLDS` (`src/core/merge-cockpit.ts:32`) is a hardcoded snapshot of the
   hold list as of the original PR; it does not track later hold changes.
   Read-only observation only — the module has no merge/close/write path
   (comment at line 31), which is correct and preserved.
3. Installed-runtime verification (real `gh`, real GitHub pagination against
   `ashlrai/phantom`) is out of scope by design; all evidence is
   injected-`Gh` source-level.

## New executable check added by this job

`test/merge-cockpit-owner-qualification-302s.test.ts` (uncommitted in this
worktree). It exercises the real exported `fetchRepo` and `summarize` with a
deterministic injected `Gh`, paginating two pages through to `summarize`, and
covers the preservation claims the owner suite does not isolate:

- read-only GraphQL arguments on every page call (`api graphql -f query=…
  -f owner=… -f name=…`, `query(` not `mutation`, `states:OPEN`, `rateLimit`,
  cursor forwarded only on page 2, no mutation/HTTP-method flags);
- deterministic `observedAt` from the injected `now`;
- rework-edge identity extracted from **title and body** (`Reworks #N`,
  case-insensitive, multi-space), duplicate `(rework, original)` pair
  elimination across title+body, and self-edge suppression (`Reworks #40` on
  PR 40);
- held-original propagation: edges to hold-listed originals (197, 725, 693,
  1228 for `ashlrai/phantom`) get `originalHeld: true`, `held` lists held
  open PRs, and a repo outside `HOLDS` reports none;
- null `checks` and nonstandard `mergeable` values (`UNKNOWN`, `BLOCKED`)
  stay counted as unknown rather than guessed.

It intentionally does not repeat the owner suite's pagination-rejection
cases (incomplete payload, rate limit, page bound, bad cursors).

## Authority / protected-path check

`origin/master:.github/CODEOWNERS` read this session: neither
`src/core/merge-cockpit.ts` nor either merge-cockpit test is listed;
`/src/core/autopilot/**` is owner-lane but is only imported transitively by
the module. **Correction to an earlier assumption:** the new test IS Tier-1 —
`isTier1TestPath` matches the `merge` stem token in the prescribed filename
`test/merge-cockpit-owner-qualification-302s.test.ts` (and the sibling
`merge-cockpit-exact-206s.test.ts` is likewise flagged), so
`test/authority-codeowners-310b.test.ts` reports it among the missing
CODEOWNERS entries. `.github/**` is a protected path this job may not edit;
the drift (36 pre-existing files plus this one) is reported to the owner in
`BRIDGE_NOTES.md` rather than fixed here. New files are
`test/merge-cockpit-owner-qualification-302s.test.ts`,
`docs/reconciliation/pr-5264-owner-qualification-302s.md`, `BRIDGE_NOTES.md`
only.

## Commands and exits (all with temporary `HOME=$(mktemp -d)`)

- `git fetch origin master pull/5264/head pull/5187/head` → exit 0.
- `diff -q` PR-head vs master vs #5187-head for both named files → all
  IDENTICAL (exit 0).
- `npm run test:ci -- test/merge-cockpit-owner-qualification-302s.test.ts`
  → exit 0, **4 passed**.
- `npm run test:ci -- test/merge-cockpit-exact-206s.test.ts` → exit 0,
  **3 passed**.
- Changed-file eslint and `npx --no-install tsgo --noEmit -p tsconfig.json`
  results are recorded in `BRIDGE_NOTES.md` (run after this doc was written).

## Disposition recommendation

#5264 is merged and its content is preserved byte-exact on master (rechecked
at `dbe58d2a`); original #5187 is closed-superseded. The remaining
original-PR relationship is fully accounted for: nothing in #5187's scope is
missing. The owner may treat the merge-cockpit recovery as complete; the only
open question is the out-of-scope absence of a production caller (item 1
above), which belongs to whoever owns the cockpit surface, not to this
preservation job.
