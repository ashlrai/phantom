# PR #4280 status reply — preservation reconciliation (RQ-PHX-STATUS4280RECONCILE312S)

As-of: 2026-11-13 (UTC). Evidence source: local git object store after
`git fetch origin master` and `git fetch origin pull/4280/head`, plus reads of
the bound trees below. This is SOURCE qualification: it is not
installed-runtime verification — nothing here asserts a live Slack socket, a
real Slack delivery, host connectivity, or any live claim/assignment. No
credentials touched, no network mutations, no Slack/iMessage traffic.

## Bound revisions

| Item | Value |
| --- | --- |
| Original PR | ashlrai/phantom #4280 `bridge: RQ-PHX-SLACKSTATUSREPLY09` (owner branch `codex-bridge/RQ-PHX-SLACKSTATUSREPLY09`; the branch ref is not on origin — only the PR refs are) |
| Observed head (fetched this session) | `be021041ba7d2f6e2eb77cb9928afa022fc3cd5f` — matches the fleet-context observed head |
| origin/master at fetch | `d7340604f517cc72e65739e223e682656a68b815` (re-fetched before finish; the named contract/test paths were re-diffed `bb53ef18..d7340604` — IDENTICAL, no drift) |
| Live claims / successor | Fleet context lists 0 live claims. `test/slack-status-original-preservation-259s.test.ts` on master is a named successor that already proves the socket-level original scenario for #4280 (pinned source `f886dd8f`); this job adds the request-matcher table and this report, not a competing implementation. No open PR in the roster covers #4280 reconciliation. |

## What the original PR added (head `be02104`, inspected paths only)

- `src/core/agents/leader-status-reply.ts` — `isStatusRequest` (exact-phrase
  set, ≤100 chars), `composeStatusReply` (≤8 plain lines, `unknown` for null
  facts, `update pending` when installed ≠ latest), `readStatusFacts`
  (runs-dir readers with per-field `attempt` → null).
- `src/core/agents/slack-leader.ts` — imported the composer directly and
  auto-answered status asks inside the adapter at flush time.
- `test/leader-status-reply.test.ts` — the assertion source tabulated below.

## What master has instead (deliberate evolution, not byte-equivalence)

- `src/core/agents/owner-status-reply.ts` — `isOwnerStatusRequest` delegates
  to the shared `isStatusAsk` matcher (`src/core/fleet/status-ask.ts`, ≤40
  chars, strips ALL trailing `[?.!]`, wider phrase set shared with desktop
  and operator surfaces); `composeOwnerStatusReply` builds a five-line digest
  (`leader/status-digest.ts` + `status-digest-sources.ts`) headed
  `Phantom status, HH:MM ET`, capped at 1500 chars, returning
  `OWNER_STATUS_FALLBACK` on failure; `ownerStatusReply()` is the injected
  `{ ask, compose, fallback }` seam.
- `src/core/agents/slack-leader.ts` — no longer imports the composer (it is
  inside the Tier-1 closure); `SlackLeaderOptions.statusReply` is injected by
  `src/cli/channels-slack.ts` (`ownerStatusReply()`), and the answer goes
  through the journaled `deliverSlackLeaderMessage` path with duplicate
  fencing and inbox recording.

Semantic differences to name explicitly (none are byte-equivalence claims):

1. **Version semantics**: original compared *installed vs staged* update
   (`installedVersion`/`latestVersion`, `installed !== latest` → pending).
   Master compares *installed vs newest published release carrying the
   desktop asset* (`publishedVersion`), and pending requires
   `versionNewer(published, installed)` — equal or ahead reads `up to date`.
2. **Needs-you semantics**: original `needsYouCount` counted every
   NEEDS-MASON item. Master `needsMason` counts hard-limit asks only
   (secrets, money, outside sends, data destruction — `isHardLimitAsk`).
3. **Matcher**: original accepted 6 exact phrases; master accepts that set
   plus the shared operator phrases (`/status`, `glance`, `what's up`, …) and
   strips repeated trailing punctuation (`status??` now matches).
4. **Bound**: original rejected asks >100 chars; master rejects >40. Every
   original phrase is <40 chars, so no originally-accepted input changes.
5. **Reply shape**: original ≤8 ad-hoc lines; master five fixed digest lines
   (adds Top P0, 24h merges) capped at 1500 chars.
6. **Failure mode**: original printed `unknown` per failed field and never
   threw; master keeps per-field `unknown (reason)` inside the digest and
   adds a whole-reply `OWNER_STATUS_FALLBACK` when composition itself fails.

## Assertion-by-assertion table — original `test/leader-status-reply.test.ts`

Current executable evidence column names real suites on `origin/master`;
`312s` is `test/slack-status-4280-preservation-312s.test.ts` (this job,
uncommitted). "Retained" = same observable contract; "evolved" = deliberate
contract change with equivalent executable coverage; "missing" = none found.

### `isStatusRequest` — accepts (original `it.each`, 7 rows)

| # | Original assertion | Current executable evidence | Outcome |
| --- | --- | --- | --- |
| 1 | accepts `'status'` | 312s; `test/owner-status-reply.test.ts`; `test/status-ask-101.test.ts` | retained |
| 2 | accepts `'Phantom status'` | 312s; `test/owner-status-ask-parity-134.test.ts` | retained |
| 3 | accepts `' fleet status '` (whitespace) | 312s | retained |
| 4 | accepts `'status?'` | 312s; `test/owner-status-reply.test.ts` (`'status?'`) | retained |
| 5 | accepts `"What's the status?"` | 312s; `test/status-ask-101.test.ts` | retained |
| 6 | accepts `'whats the status.'` (trailing period) | 312s | retained |
| 7 | accepts `'PHANTOM STATUS'` (case) | 312s; `test/owner-status-reply.test.ts` (`'  PHANTOM STATUS  '`) | retained |

### `isStatusRequest` — rejects (original `it.each`, 6 rows)

| # | Original assertion | Current executable evidence | Outcome |
| --- | --- | --- | --- |
| 8 | rejects `'status of PR 4245'` | 312s; `test/status-ask-101.test.ts` (`'status of the release pr #12'`) | retained |
| 9 | rejects `'phantom status and release plan'` | 312s | retained |
| 10 | rejects `''` | 312s; `test/owner-status-reply.test.ts` | retained |
| 11 | rejects `'x'.repeat(500)` | 312s (now via the 40-char bound) | retained |
| 12 | rejects `'status??'` | 312s asserts **`true`** — see below | **evolved (intentional)** |
| 13 | rejects `'please review PR 4245'` | 312s | retained |

Row 12 detail: the original stripped one trailing `[?.]` then required exact
set membership, so `'status??'` missed. `isStatusAsk` strips `/[?.!]+$/`, so
`'status??'` and `'status!?!'` now normalize to `'status'` and match. This is
the deliberate shared-matcher broadening (parity with desktop/operator
surfaces), pinned as accepted in 312s — not a regression of exact-match
after normalisation: `'status of PR 4245?'` still rejects.

### `composeStatusReply` (original `it`s, 4)

| # | Original assertion | Current executable evidence | Outcome |
| --- | --- | --- | --- |
| 14 | known facts print in ≤8 plain lines; `Lane claude: 14 running of 17`, `Lane grok: 0 running of 0 (held)`, `Merges in the last hour: 0`, `Needs you: 2`; no `update pending` when equal; no `\|` | `test/leader-status-digest.test.ts` (five lines from known values); `test/leader-status-original-reconcile-234s.test.ts` (exact digest text); `test/slack-status-original-preservation-259s.test.ts` (posted reply ≤8 lines, ≤1500 chars, no `\|`); 312s bounded-output test | **evolved** — labels/shape changed (`Lanes: claude 4/8`, `Needs Mason: N hard-limit asks`, Top P0 added); bounding moved from 8 lines to 1500 chars; plain-text/no-pipe property retained |
| 15 | every null fact prints `unknown`, never `0` | `test/leader-status-digest.test.ts` `says unknown with the reason for every unreadable input, never 0`; `leader-status-original-reconcile-234s.test.ts` dead-reader case; 259s `posts unknown, never a fabricated zero` | retained (per-field `unknown (reason)`; known zeros still print real `0`, as before) |
| 16 | `update pending` only when both versions known and differ | `test/slack-status-original-preservation-259s.test.ts` `the update-pending gate through the real gather -> build -> compose chain` (equal/ahead → `up to date`, missing → no verdict) | **evolved** — refined to strictly-newer published release |
| 17 | lanes capped so reply stays ≤8 lines | `test/owner-status-reply.test.ts` `caps the reply at 1500 characters`; 312s bounded test | **evolved** — 1500-char bound replaces line cap |

### `readStatusFacts` (original `it`s, 2)

| # | Original assertion | Current executable evidence | Outcome |
| --- | --- | --- | --- |
| 18 | empty runs dir → all fields null, `observedAt` set, no throw | `test/leader-status-digest.test.ts` `gatherStatusDigestInput` describe (missing/degraded sources → unknown facts); `leader-status-original-reconcile-234s.test.ts` | **evolved** — `readStatusFacts`/`StatusFacts` replaced by `gatherStatusDigestInput` returning `Fact<T>` with reasons; `observedAt` is implicit (caller's `now`) |
| 19 | a throwing reader nulls only its field; lanes/merges still read | `test/leader-status-digest.test.ts` `turns throwing or self-declared unavailable readers into unknown facts` (per-source isolation through real `fact()` wrapper) | retained semantically, evolved shape |

### `flushSlackLeaderReplies` status replies (original `it`s, 3)

| # | Original assertion | Current executable evidence | Outcome |
| --- | --- | --- | --- |
| 20 | pending `'Phantom status'` answered in same thread exactly once, no model; duplicate fenced | `test/slack-leader-status-reply.test.ts` test 1 (same-thread post, second ingest + `tickLeaderNetwork` → `replies: 0`, one post); `test/owner-status-ask-parity-134.test.ts`; 259s pending-ask test (no `statusReply` seam → model-independent snapshot answer, once) | retained — mechanism evolved (injected `statusReply` at socket wiring + journaled delivery vs in-adapter flush composition) |
| 21 | `'please review PR 4245'` waits for the model, no auto post | `test/slack-leader-status-reply.test.ts` `leaves ordinary owner requests to the Leader`; 259s `leaves an ordinary ask for the model and posts its reply verbatim once` | retained |
| 22 | model reply text kept when a status-shaped row already has one | 259s `refuses a different second reply for the same request` (reply fingerprint refusal); `test/slack-leader.test.ts` uncertain-post recovery | **evolved** — invariant retained: a delivered reply is never displaced; mechanism differs because master auto-answers status asks at ingest and still records them for the Leader |

**Missing: none.** Every original assertion is retained or deliberately
evolved with named executable coverage. The three original filenames/exports
do not exist on master, but no unique original *functionality* is absent —
the differences above are the intended contract (Mason's Nov5
accumulated-unique-work order; Dot's Nov12 model-free receipt-backed status
contract).

## Scope notes

- This job authored no production edits. New files:
  `test/slack-status-4280-preservation-312s.test.ts`,
  `docs/reconciliation/pr-4280-status-preservation-312s.md`, `BRIDGE_NOTES.md`.
- CODEOWNERS check: `.github/CODEOWNERS` at `d7340604` lists neither new path;
  `slack-status-4280-preservation-312s` matches no `TIER1_TEST_STEMS` token
  and imports no Tier-1 source (`owner-status-reply.ts`, `status-ask.ts`,
  `status-digest*.ts` are outside `TIER1_SOURCE_PATTERNS`).
- Verification is synthetic only: fake ids, temp dirs, injected readers. It
  does not establish installed-host connectivity or actual Slack delivery,
  and no live claim or assignment is created by these tests.

## Disposition recommendation

All unique #4280 functionality is preserved or explicitly accounted for by
the evolved contract with executable evidence. Recommend the owner resolve
#4280 as **superseded**: close it with a comment pointing at this document
and the successor suites (`slack-status-original-preservation-259s.test.ts`,
`slack-leader-status-reply.test.ts`, `leader-status-original-reconcile-234s.test.ts`),
rather than merging the stale direct-import implementation. The remaining
differences (staged→published version, all-asks→hard-limit needs-you,
broadened matcher, 40-char bound) are intentional contract decisions already
on master — they are documented here, not gaps to fix.
