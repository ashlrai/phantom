# PR #5354 owner qualification — RQ-PHX-CONFIRMOWNERQUALIFY283S

As-of: 2026-11-13T13:23Z (UTC). Evidence source: local git object store after
`git fetch origin master`, `git fetch origin pull/5354/head`,
`git fetch origin pull/4332/head` (all three refs re-fetched for this report).
This is SOURCE qualification of the bound trees below. It is not installed
runtime verification: nothing here asserts the route is live, reachable, or
that any message was or can be sent. No Slack/iMessage traffic, no runtime
changes, no credentials touched.

## Bound revisions

| Item | Value |
| --- | --- |
| Original PR | ashlrai/phantom #4332 (branch `codex-bridge/RQ-PHX-COMMSCONFIRMDESK09`) |
| Original head | `4362a36ce271b7e0132926fcd365c4b7aa902096` |
| Original merge-base vs master | `b26c03050a55090b9bb0dd30d8b703f39451bcbf` |
| Owner PR (existing, not created by this job) | ashlrai/phantom #5354 `bridge: RQ-PHX-COMMSCONFIRMORIGINAL264S` |
| Owner head (rechecked this session) | `4e14679113465df935a470b65ba1a345e7945def` — matches the observed head in the fleet context |
| Owner merge-base vs master | `c2f5f20ebc61b8956f6508400c6925a2344eb1a9` (the PR's parent: one commit on a recent master) |
| origin/master at fetch | `d5a42df76aa3957cb81c31973bac45195c504c53` |
| Merge state | #4332 NOT merged, #5354 NOT merged (`git merge-base --is-ancestor` both false) |

Because #5354 is unmerged, executable evidence was produced in an isolated
checkout of the owner head: `/tmp/owner-5354-checkout` (detached at
`4e14679113465df935a470b65ba1a345e7945def`, deps via
`npm run install:worktree`). Owner files were not modified there; the new
suite was copied in uncommitted for the run.

## Inspected paths (exact)

Owner five paths, compared between `4362a36c` (#4332) and `4e146791` (#5354):

- `src/core/comms/comms-confirm.ts`
- `src/core/web/comms-confirm-route.ts`
- `src/core/web/api.ts`
- `test/comms-confirm-original-264s.test.ts` (was `test/comms-confirm.test.ts` in #4332)
- `test/comms-confirm-http-original-264s.test.ts` (was `test/comms-confirm-route.test.ts` in #4332)

Context paths read: `.github/CODEOWNERS` @ `d5a42df7`,
`src/core/authority/protected-paths.ts` @ `d5a42df7`, `AGENTS.md`,
`CLAUDE.md`, `eslint.config.js`, `tsconfig.json`, `package.json`.

## Original requirement → current code/test mapping

| Original #4332 requirement (from its diff) | #5354 state | Evidence |
| --- | --- | --- |
| `readCommsLimits`/`confirmCommsLimits` core: digest over `[team].identities` + all comms.toml settings except the two confirmation keys; refuse on `missing`/`malformed`/`digest-mismatch`/`changed`/`io-error`; atomic write + `comms.toml.bak`; never creates the file; no CLI/MCP writer | `src/core/comms/comms-confirm.ts` blob `8c6a97484c21788b82de7219456ecfdd6fdbe58c` — **byte-identical** to #4332 | `test/comms-confirm-original-264s.test.ts` is byte-identical to #4332's `test/comms-confirm.test.ts` (`diff` empty) |
| Owner-gated `GET`/`POST /api/verse/comms/confirm`: mutation gate + no `Authorization` bearer + same-origin `Origin`/`Sec-Fetch-Site`; GET read-only | `src/core/web/comms-confirm-route.ts` blob `acc3e458b1751c066c1840afbfe761a2d98fb10e` — **byte-identical** to #4332 | `test/comms-confirm-http-original-264s.test.ts` = #4332's route test **plus** a new `mounted route through handleApi` describe exercising the real `api.ts` mount under the relocated test HOME |
| Mount in `handleApi` before the V1 `/api/verse/*` catch-all | `src/core/web/api.ts` +6 lines: same import and same mount hunk as #4332 (verified hunk-for-hunk against `b26c0305..4362a36c`) | covered by the mounted-route describe in the http test |
| Desktop UI caller (`CommsConfirmCard`) | **NOT carried over** — see remaining gaps | — |

## New executable check added by this job

`test/comms-confirm-owner-qualification-283s.test.ts` (this branch, uncommitted
here; run inside the owner checkout). It covers the one original behavior the
owner suites do not prove at byte level: after the `[team].identities`
snapshot in `agent-network.toml` changes, a `confirmCommsLimits` call carrying
the stale digest is refused `digest-mismatch` and leaves **every directory
entry and every file byte identical** (no `comms.toml.bak`, no `*.tmp`,
`agent-network.toml` itself untouched), and the refusal is not sticky — the
changed snapshot's own digest confirms normally afterwards. The suite
self-skips on trees without `src/core/comms/comms-confirm.ts` (e.g. master
pre-merge), so it is safe to land in either order.

Commands and exits (all with temporary `HOME=$(mktemp -d)`):

- Owner tree: `cd /tmp/owner-5354-checkout && ./node_modules/.bin/vitest run test/comms-confirm-owner-qualification-283s.test.ts` → exit 0, **2 passed**.
- Owner tree baseline: `vitest run test/comms-confirm-original-264s.test.ts test/comms-confirm-http-original-264s.test.ts` → exit 0, **19 passed**.
- This branch (master-based, module absent): same vitest command → exit 0, **2 skipped** (guard works).
- Focused eslint on the new file → exit 0, clean.
- `test/authority-codeowners-310b.test.ts` on this branch → 6 passed; the new
  test is not Tier-1 (imports only `channel-policy.js` + the guarded owner
  module; no Tier-1 stem/name match), so no CODEOWNERS entry is required and
  no authority/import-closure review is triggered. `.github/**` untouched.

## Remaining unique behavior / gaps for the owner

1. **`CommsConfirmCard` UI absent from #5354.** Original #4332 also added
   `src/web-ui/routes/verse/comms-confirm/CommsConfirmCard.tsx`,
   `.module.css`, and `CommsConfirmCard.test.tsx` — the only caller-facing
   surface for the new endpoint. #5354 carries none of it, and master has
   none either. If the desktop card is still wanted, the owner must recut
   those three files; the backend route is complete without them.
2. Owner head `4e14679` is one commit on `c2f5f20`; master has since moved to
   `d5a42df7`. `src/core/web/api.ts` on master is blob `880153a3` — the same
   blob #5354's parent had — so the +6 mount applies cleanly today, but a
   rebase recheck is cheap insurance.
3. Installed-runtime verification (real `~/.ashlr` config, real desktop
   server, live POST) is out of scope and unverified by design; all evidence
   above is source-level on temp dirs.
