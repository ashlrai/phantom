# PR #4552 preservation evidence (RQ-IMSGLEADERN9SQ8 reconcile, RQ-PHX-IMSGLEADERRECONCILE223S)

Original PR #4552 ("iMessage two-way Leader channel") head fetched read-only via
`git fetch origin pull/4552/head` → `152c279b15c00419776fbdffa8a5da1220225ec8`.
The implementation commit named by the task is
`fbcac9e7e244773db7a92dfbe4db1dd9b95d23d6`; the six named paths are
byte-identical between that commit and the PR head (verified with
`git diff fbcac9e7 152c279b -- <path>` → empty for all six). Master audited:
`origin/master` = `0427b167f1aec975905a05203d54452a33dd70a9`.

"Preserved" below means the stated behavior is supported by current source and
the named tests on master, exercised through the real exported
`sendLeaderReplies` — not that the installed app, a live iMessage channel, or
the real osascript transport was tested. This document is bounded source
evidence; it does not by itself prove runtime deployment.

## Path-by-path mapping (original → master)

| Original path (at fbcac9e / PR head) | Role in #4552 | Current master state | Assessment |
| --- | --- | --- | --- |
| `src/core/comms/imessage-leader-replies.ts` (new, 134 lines) | `sendLeaderReplies(cfg, deps)`: reads leader replies, claims by hash in `leader-sent.jsonl`, dry-run default, first-live-pass baseline, Mason-only destination | Same module on master **plus** a newer private-directory lock: `leader-replies.lock` via `acquireLocalStoreLockWithOutcome`/`releaseLocalStoreLock`, `ensurePrivateDirectory`, new `busy` state, `finally` release ([src/core/comms/imessage-leader-replies.ts](../src/core/comms/imessage-leader-replies.ts)). `git diff fbcac9e7 origin/master` on this file is exactly that lock addition. | Preserved and hardened. The unlocked original must not be restored; master's lock is kept. |
| `src/core/types/config.ts` | Added `comms.leaderRepliesSend?: boolean` (default false = dry run) | `leaderRepliesSend?: boolean` present ([src/core/types/config.ts](../src/core/types/config.ts) ~line 1200); file is **byte-identical** to the original commit. | Preserved exactly. |
| `src/cli/imessage.ts` | Added `phm imessage replies [--json]` verb delegating to `sendLeaderReplies`, and a best-effort `await sendLeaderReplies(cfg)` after `ingestIMessages` in `poll --apply` | Both wirings still present verbatim in `cmdIMessage` ([src/cli/imessage.ts](../src/cli/imessage.ts)); the file additionally gained chunked patch-transfer reporting (`findings.announced`, `patches` counts) from later work. | Preserved; later unrelated additions coexist. |
| `src/core/comms/imessage-teammate-worker.ts` | Original added `await sendLeaderReplies(cfg, { runsDir: runs })` inside `tickTeammateMessages` so the sidecar also ran the pass | Master **removed** that call; the sidecar no longer sends leader replies. [docs/IMESSAGE.md](../docs/IMESSAGE.md) states this deliberately: "`phm imessage poll --apply` runs the same pass after intake; the sidecar worker does not send replies yet." The worker file evolved further (store eviction, teammate context builder). | Changed by later work, documented as intentional ("yet"). The reply path itself is unaffected — `poll --apply` and `replies` still invoke it. Recorded as a delta, not silently preserved. |
| `docs/IMESSAGE.md` | New "Leader replies by text" section documenting dry-run default, hash ledger, baseline, batch cap, both triggers | Section still present, updated for the sidecar change and the lock ("only one pass runs at a time"); a later "Chunked patch transfers" section was added above it. | Preserved and updated. |
| `test/imessage-leader-replies.test.ts` (new, 124 lines) | Original suite: dry run, baseline+dedupe, Mason-only target, disabled states, failed-send retry + batch cap, real journal read; plus inbound verified/unverified intake cases | File is **byte-identical** to the original commit on master and still exercises the same exported module. | Preserved exactly. |

## Inbound side

#4552's test file also covered inbound: texts from the configured
`comms.imessageHandle` become `[src:imessage]` `MASON-INBOX.md` lines and
unverified handles are dropped — via `ingestIMessages`
(`src/core/comms/imessage-inbox-bridge.ts`) gated by
`isVerifiedMasonHandle` (`src/core/integrations/imessage.ts`). Those intake
paths are unchanged by this reconcile and remain covered by the identical
original suite (`describe('inbound (fake bridge)')`).

## Behavior → test mapping on master

| Original promised behavior | Evidence on master |
| --- | --- |
| First live pass baselines history; old replies never texted | `test/imessage-leader-original-preservation-223s.test.ts` pass 1 (`baselined`, send unused, baseline rows); existing `imessage-leader-replies.test.ts` "first live pass baselines history"; `recut-nonphx-59.test.ts` CLI-level baseline |
| Restart survival: no replay of historical or already-sent replies | New test passes 3–4: fresh deps over the same runsDir resend nothing; ledger is the only durable state |
| Failed send frees the reply for retry; `pending` claim prevents double-send on crash | New test pass 2→3 (`failed` re-opens, retried once, statuses `pending,failed,pending,sent`); existing "a failed send is retried next pass; a batch is capped" |
| Receipt ledger stores hashes/statuses, never reply text (mode 0600) | New test asserts every row shape, exact status sequence, absence of plaintext, `replyTextHash` presence, mode `0o600`; existing suite asserts hash-only content |
| Only the verified Mason handle is ever a destination | New test asserts every fake-send `to` argument is `MASON` even with `imessageAllow` listing a second handle; existing "only ever targets Mason's verified handle"; `recut-nonphx-59.test.ts` proves it through the real osascript-guarded transport |
| Dry run is the default and writes nothing | New test on a separate root: `dry-run`, no send, no `imessage/` dir or ledger created; existing "is a dry run by default" |
| At most `LEADER_REPLY_BATCH` (3) per pass | Existing "a failed send is retried next pass; a batch is capped" |
| Concurrency: one live pass at a time | Master's newer lock: `busy` state + `finally` release in `sendLeaderReplies`; `recut-nonphx-59.test.ts` "a concurrent live pass is busy"; new test holds `leader-replies.lock` and asserts `busy`, no send, no ledger |
| CLI surface `phm imessage replies [--json]`, `poll --apply` trigger | `cmdIMessage` on master; `recut-nonphx-59.test.ts` drives the real CLI entry point |

## Explicitly unproven

- The installed/bundled app and any live iMessage channel were not exercised;
  all sends went through injected fakes or a mocked `osascript` in other
  suites. No real messages, handles, or phone numbers were used.
- The sidecar (`tickTeammateMessages`) no longer invokes the reply pass on
  master — a deliberate later change per `docs/IMESSAGE.md` ("does not send
  replies yet"), recorded above rather than treated as a defect.
- `sendLeaderReplies` "never throws" fail-closed paths (unreadable/oversized
  ledger) are covered by inspection, not by a dedicated new case here.

This is bounded preservation evidence for the named paths; it does not claim
the installed runtime was tested.
