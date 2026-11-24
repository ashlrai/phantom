# SELF-APPROVALS-1: self-serve approvals (design, not live)

Status: DESIGN ONLY. Nothing here is wired, installed or enabled. Nothing goes
live before Security sign-off (see `SELF-APPROVALS-1-ready.md`).

Author: lane claude, job RQ-SELF-APPROVALS-1, 2026-11-16.
Base: ashlrai/phantom `master` at 5077327712a.

## 1. Goal

Routine merges and routine fleet actions stop waiting on a human. They are
approved automatically when they fall inside the hard limits and inside Mason's
signed standing grant. Anything at or past a hard limit is routed to Security or
to Mason, or refused outright. No action ever becomes approved because nobody
answered.

### What "self-serve" means here (and does not mean)

`docs/architecture/teams.md:199` already forbids agents from self-approving:
approvals apply only from a `kind: human` owner or admin, and there is no approve
tool over MCP. This design keeps that rule. No agent, model or Leader decides
anything. Self-serve approval means this:

- **Authority root.** The authority is Mason's Touch ID signed `StandingGrantV1`
  (`src/core/authority/types.ts:229`): host bound, valid for 30 days at most,
  per-repo `maxRisk` and `maxMergesPerDay`, and checked against
  `STANDING_GRANT_CEILINGS` (`types.ts:278`).
- **Who decides.** A deterministic, pure evaluator (proposed:
  `src/core/approvals/self-serve.ts`) answers one question: is this concrete
  action inside what the grant and the hard limits already allow? It has no
  model call and no network, and reads no secrets.
- **Unknown or ambiguous input** routes to Mason. The evaluator fails closed.

So "auto" means "pre-approved by Mason's signature, checked by code", not
"approved by an agent".

### Non-goals

- No change to hard limits, required checks, rulesets, CODEOWNERS or sandbox
  profiles.
- No new trust root, signing key, token or secret. The design reuses the grant
  trust roots, the authority ledger and the G1 one-shot pass.
- No spend path. `StandingGrantSpend.meteredUsdPerDay` must be 0 for this
  feature to activate (see rule H1).
- No change to pinned files (`bin/dispatchd.py` live sha256 prefix `d5acb03d`,
  `bin/launch.sh`, iMessage send scripts, release-autorun/sign scripts and their
  LaunchAgents). Section 9 lists the hunk Security would cut against those
  pins. This lane could not read them (see section 10).

## 2. Existing machinery this builds on

| Piece | Where | Used for |
| --- | --- | --- |
| Standing grant (Touch ID, 30 d max) | `src/core/authority/types.ts:229`, ceilings `:278` | the only source of auto authority |
| Hash-chained authority ledger | `~/.ashlr/authority/ledger.jsonl`, `src/core/authority/ledger.ts` (`appendLedger`, `withLedgerTransaction`, `ledger-head.json`, sticky `ledger.broken`) | audit log (section 6) |
| Kill switch | `~/.ashlr/KILL`, exact bytes `kill switch active\n` (`src/core/sandbox/policy.ts:287`); `killEpochDigest` bound into host-merge authority (`src/core/fleet/host-merge.ts`) | global stop |
| Runs switches | `src/core/fleet/runs-switches.ts`: `ORCH_OFF`, `PAUSE`, `PUBLISH_HOLD`, `HOLD`, `queue/DISABLE` | global and lane stops |
| Merge-queue cycle | `src/core/drive/merge-queue-loop.ts` (`classifyMergeQueuePr`); never merges directly, never `--admin`; enqueues with `expectedHeadOid`; budgets 1 per (action, PR) per 15 min, 3 per rolling 24 h, 20 per action per cycle | the only auto merge path |
| Security pinned paths | `securityPinnedPath` (`src/core/drive/refix-loop.ts:100`): `.github`, `publish.sh`, any segment matching `dispatchd`, `git-safe`/`git_safe`, `scrub`, `reap` | route to Security |
| Tier-1 paths | `TIER1_SOURCE_PATTERNS` (`src/core/authority/protected-paths.ts:80`); gate verdict `owner-lane` labels `ashlr:owner-lane`, never auto merged (`src/core/fleet/fleet-types.ts:145`) | route to Mason |
| Auto-merge size caps | `automerge-scope-policy.ts`: `DEFAULT_AUTOMERGE_MAX_FILES=4`, `DEFAULT_AUTOMERGE_MAX_LINES=150`; grant `localEnforcement` `{maxRisk:'low', maxFiles:4, maxLines:150, maxMergesPerDay:4}` | auto envelope |
| Publish guard | `contrib/mac/publish.sh`: 7-repo allowlist (`:41`), literal fork URL `https://github.com/masonwyatt23/$NAME.git` (`:42`), G1 one-shot pass `$R/g1-pass/$J.pass` pinned to tree + parent and written only from a Security PASS (`:155-163`), `gh pr merge --auto` (`:297`) | fork-only push; Security pass primitive |
| Leader action classes | `LeaderActionClass = 'A' \| 'B' \| 'C'` (`src/core/vision/leader-types.ts:64`); B has a veto window of 30 min to 24 h; C always escalates | maps onto the routes |
| Approval surfaces | `src/core/approvals/surface.ts`: `pins` reads `~/.ashlr-runs/staged` (Security), `teamApprovals` and `holds` (Mason) | where routed items appear |
| Consequential actions | `CONSEQUENTIAL_ACTIONS` (`src/core/teams/protocol.ts:66`): push-main, deploy, release, merge, rotate-secret, external-message, delete, spend | cross-check list |

## 3. Routes

| Route | Meaning | Who can unblock |
| --- | --- | --- |
| `AUTO` | Inside the grant and the hard limits. The evaluator approves, appends to the ledger, then the existing executor acts. | nobody needs to |
| `SECURITY` | Touches a Security-pinned surface. It is staged as `~/.ashlr-runs/staged/<NAME>/` plus `~/.ashlr-runs/bus/security/<NAME>-ready.md`. It proceeds only on a Security PASS pinned to the exact tree (G1-style one-shot pass). | Security |
| `MASON` | Owner-reserved: authority raises, Tier-1, releases, non-fleet PRs, anything unclassified. It appears in `phm approvals` and is decided only by `localHumanActor` (agent env markers refuse). | Mason |
| `NEVER` | A hard limit. The fleet refuses, logs the refusal, and offers no approve button. Mason can still act by hand outside the fleet. | not the fleet |

A lowering action (pause, hold, kill on, lane down, revert of a red merge) is
always `AUTO`. This matches the ledger rule that anyone may lower authority and
only a grant raises it. A raising action needs a valid grant, no kill, and an
unbroken ledger.

## 4. Action taxonomy

Columns:
- **Route**: the route from section 3.
- **Auto conditions**: every condition must hold, or the row's fallback route applies.
- **Enforced today by**: the existing check that already holds the line. The evaluator adds a decision and a record; it never removes an existing check.

### 4.1 Fleet operations (F)

| ID | Action | Route | Auto conditions (else fallback) | Enforced today by |
| --- | --- | --- | --- | --- |
| F1 | Launch a queued job on a lane | AUTO | lane uses included usage only; `live < target`; no `PAUSE`, `queue/DISABLE`, KILL or lane `HOLD`; job repo in the 7-repo allowlist. Else MASON (metered lane) or wait (switch set) | dispatchd (pinned), runs switches |
| F2 | Raise a lane target | AUTO | new target <= the compiled ceiling and the roster target set by Mason; memguard and loadgate unchanged. Above the roster target: MASON | dispatchd memguard (pinned) |
| F3 | Lower a lane target, pause a lane, set `PAUSE`/`ORCH_OFF`/`PUBLISH_HOLD` | AUTO | always (lowering) | runs switches |
| F4 | Clear `PAUSE`, `ORCH_OFF`, `PUBLISH_HOLD`, `queue/DISABLE` or a lane hold | MASON | never auto: clearing a stop raises authority | `phm` switch writers |
| F5 | Requeue a failed job | AUTO | same job ID; at most 3 per rolling 24 h; cause not a hard-limit refusal. Else MASON | merge-queue and refix budgets (pattern) |
| F6 | Close a fleet-authored PR (superseded or stale) | AUTO | author is `FLEET_AUTHOR`; Leader class A `pr.close`. Non-fleet PR: MASON | Leader class A |
| F7 | Add a PR to `queue/hold-list.txt` | AUTO | lowering | merge-queue cycle fails closed on bad hold file |
| F8 | Remove a PR from the hold list | MASON | the hold list is Mason's (`AGENTS.md`) | none (convention) |
| F9 | Set KILL (`ashlr authority stop`) | AUTO | lowering; any actor | `clamp.ts` appends `kill:on` |
| F10 | Clear KILL, raise the autonomy switch, accept/renew/revoke a grant | MASON | Touch ID only | `authority` commands, trust roots |
| F11 | Leader class B action (goal.create, harness.adopt, ...) | AUTO after veto window | grant lists it; not spend-raising (rule H1); veto window not vetoed. Spend-raising B (cloud.launch, devin.launch, lanes.codex): NEVER under current limits | `vision/leader-powers.ts` |
| F12 | Leader class C | MASON | always | Leader |

### 4.2 Work and publish (W, P)

| ID | Action | Route | Auto conditions (else fallback) | Enforced today by |
| --- | --- | --- | --- | --- |
| W1 | Edit, build and test inside the job's own worktree | AUTO | worktree under `~/Projects/ashlrai/<repo>`; temp HOME for tests | sandbox profiles |
| W2 | Local commit in the job worktree | AUTO | none beyond W1 | sandbox profiles |
| P1 | Push the job branch to the fork | AUTO | only via `publish.sh`: literal fork URL, fork check, repo allowlist, scrub, `.npmrc` deny, no G1 trigger | `contrib/mac/publish.sh` |
| P2 | Publish a diff touching `.github/` or `release*.yml` | SECURITY | G1 one-shot pass pinned to tree and parent | `publish.sh:155-163` |
| P3 | Push to `ashlrai/*` directly, to any remote name, or to a non-allowlisted repo | NEVER | | literal URL in `publish.sh` |
| P4 | Push to `hollen689/*` or `weyv` | NEVER | | not in allowlist |
| P5 | Force-push anywhere | NEVER | | `publish.sh`, rulesets |
| P6 | Open a PR from the fork | AUTO | follows P1 | `publish.sh` |

### 4.3 Merge (M)

| ID | Action | Route | Auto conditions (else fallback) | Enforced today by |
| --- | --- | --- | --- | --- |
| M1 | Enqueue a fleet-authored PR into the GitHub merge queue | AUTO | all of: author `FLEET_AUTHOR`; repo in `REFIX_REPOS`; not draft; base is default branch; all checks `SUCCESS`; no `CHANGES_REQUESTED` or `REVIEW_REQUIRED`; no file matches `securityPinnedPath`; file list not truncated; no Tier-1 match; no `ashlr:owner-lane` label; not on hold list; files <= grant `maxFiles` and lines <= `maxLines` (defaults 4 and 150); risk <= `low` in phase 1; merges today < grant repo `maxMergesPerDay`; head SHA equals the SHA the evaluator saw. Fallbacks: pinned path -> SECURITY; Tier-1, owner-lane, size, risk or daily cap -> MASON; red or pending checks -> wait | `classifyMergeQueuePr`, merge queue required checks |
| M2 | Merge without the merge queue, `--admin`, ruleset bypass, skip or re-run required checks to force green | NEVER | | merge-queue cycle (`merge-queue-loop.ts:19`), rulesets. Also covers the "local merge fallback" that `evaluateAutonomyPolicy` can return for `merge-main` (`policy.ts:177`): self-serve never approves it |
| M3 | Merge a non-fleet-authored PR | MASON | | `classifyMergeQueuePr` author filter |
| M4 | Merge a PR touching a Security-pinned path or pinned file | SECURITY | Security PASS pinned to head SHA, then the merge queue | `securityPinnedPath` |
| M5 | Merge a Tier-1 or CODEOWNERS-owned path | MASON | owner review in GitHub | `TIER1_SOURCE_PATTERNS`, CODEOWNERS |
| M6 | Revert a merge that went red after landing | AUTO | revert PR is fleet-authored and goes through M1 rules except the size cap; ledger `revert:landed` | post-merge watch |
| M7 | Enable `gh pr merge --auto` on a P1 PR | AUTO | same as M1. Merge queue and required checks still decide | `publish.sh:297` |

### 4.4 Release, pinned files and host (R, S, H)

| ID | Action | Route | Notes |
| --- | --- | --- | --- |
| R1 | Create a release tag | MASON | `docs/RELEASE-AUTONOMY.md:21`: gates do not authorize tag creation |
| R2 | Sign, notarize, or touch signing identities | NEVER | hard limit |
| R3 | Change release-autorun, release-sign, standing-authority or their LaunchAgents | SECURITY | Security pin only |
| R4 | Deploy (preview or prod) | MASON | `evaluateAutonomyPolicy` refuses deploy proposals and production targets (`src/core/autonomy/policy.ts:89`, `:184`) but can allow a preview target at T5 (`:181`). Self-serve never auto-approves either |
| S1 | Change `bin/dispatchd.py`, `bin/launch.sh`, iMessage send scripts, sandbox `*.sb`, leader wrappers or plists | SECURITY | staged package plus `bus/security/<NAME>-ready.md` |
| S2 | Install a repo copy (`contrib/mac/*`) over a live host file | NEVER | the operator lane never does this; Security installs |
| S3 | Install the Phantom wallet plugin | NEVER | hard limit |
| H1 | Any metered spend, buying credits, raising `meteredUsdPerDay` above 0, paid cloud sessions | NEVER | hard limit: included usage only. Evaluator refuses to activate if the grant's `meteredUsdPerDay > 0` |
| H2 | Read keychain, `chat.db`, TCC DBs, app internal DBs or `~/.codex*` | NEVER | hard limit |
| H3 | Read, print or move secrets, tokens or cookies | NEVER | scrub, `assertNoSecrets` |
| H4 | Rotate a secret | MASON | `CONSEQUENTIAL_ACTIONS` `rotate-secret` |
| H5 | Outbound message to anyone (iMessage, Slack, Telegram, email, webhooks) | NEVER for the fleet | hard limit "no external sends". Writing to the local bus (`~/.ashlr-runs/bus/*`) is AUTO |
| H6 | Delete a repo, make anything private public | NEVER | `AGENTS.md` |
| H7 | Delete a fleet branch on the fork after its PR merged or closed | AUTO | fork only |
| H8 | Change rulesets, branch protection, required checks, CODEOWNERS ownership rules | MASON | CODEOWNERS regeneration of an existing mapping stays a normal PR under M1/M5 |
| X0 | Anything not in this table | MASON | fail closed |

## 5. Evaluation order

The evaluator is a pure function: `decide(action, snapshot) -> Decision`.
`snapshot` is gathered by the caller and frozen before the call. It contains:
grant verification result, KILL state, runs switches, ledger health, hold list,
PR facts, and today's counters from the ledger.

1. **Classify.** Map the action to one taxonomy ID. If none matches, return
   `MASON` with rule `X0`.
2. **Hard limits.** If the row's route is `NEVER`, return `NEVER`. This runs
   before any grant check, so a grant can never lift a hard limit.
3. **Lowering.** A lowering action returns `AUTO` and stops here.
4. **Global stops for raising actions.** Each of these returns `MASON`, with a
   reason naming the stop: KILL on; `ledger.broken` present; ledger head
   mismatch; grant missing, expired, paused or revoked; `authoritySurfaceDigest`
   mismatch; host binding mismatch; grant `meteredUsdPerDay > 0`.
5. **Routes.** If the row's route is `SECURITY` or `MASON`, return it.
6. **Auto conditions.** Check every auto condition of the row. The first
   failing condition picks the row's fallback route and is recorded as the
   reason.
7. **Approve.** Return `AUTO`, bound to the concrete inputs: head and base SHA,
   tree hash, file and line counts, `killEpoch`, grant ID and policy digest. The
   approval expires after 15 minutes. It is consumed on first use.

Ties go to the stricter route: `NEVER` > `SECURITY` > `MASON` > `AUTO`. If an
action touches both a Security-pinned path and a Tier-1 path, it needs both
sign-offs. It is staged for Security first, and Mason's review follows.

## 6. Audit log format

### Where

The existing hash-chained authority ledger, `~/.ashlr/authority/ledger.jsonl`,
written only through `appendLedger` / `withLedgerTransaction`. One chain, one
anchor (`ledger-head.json`), one tamper marker (`ledger.broken`).

The team event log (`$ASHLR_HOME/teams/<team>/events.jsonl`) is rejected as the
audit log because it is not hash-chained. Mason's human decisions on routed
items are still recorded there by `decideApproval`. The ledger then records the
outcome by the request ID, so the full trail lives in one chained file.

### New ledger kinds (contract change; `CONTRACT.md` updated in the implementing PR)

| Kind | Written when | Order |
| --- | --- | --- |
| `approval:decided` | every evaluator decision, any route | before acting (raising) |
| `approval:consumed` | the executor used an AUTO approval | after the executor returns |
| `approval:expired` | an AUTO approval passed `expiresAt` unused | lazily, on next read |
| `approval:resolved` | Security PASS/FAIL or Mason approve/deny on a routed request | when the human or Security decision is observed |

`approval:decided` is not a `LedgerEvidenceKind`. It must not advance or
regress the rollout ladder. Only real outcomes (`merge:landed`,
`revert:landed`, ...) do that.

### Line shape

The envelope is the existing `LedgerEntryBase` (`src/core/authority/types.ts:693`):
`v, seq, at, actor, grantId, repo, prevHash, hash`, plus `kind` and `data`.
`actor` stays a `FleetActor` (`'mason' | 'daemon' | 'leader' |
'post-merge-watch' | 'backpressure'`). The evaluator runs as `daemon`.

Example `approval:decided` line. It is shown pretty-printed; on disk it is one
canonical JSON line under `LEDGER_MAX_LINE_BYTES` (64 KiB). All hashes and IDs
in the example are placeholders.

```json
{
  "v": 1,
  "seq": 4182,
  "at": "2026-11-16T13:02:11.204Z",
  "actor": "daemon",
  "grantId": "<32 hex>",
  "repo": "ashlrai/phantom",
  "kind": "approval:decided",
  "data": {
    "requestId": "sa-<26 char ulid>",
    "taxonomyId": "M1",
    "route": "AUTO",
    "rule": "M1",
    "reasons": [],
    "subject": {
      "type": "pr",
      "number": 6312,
      "headSha": "<40 hex>",
      "baseSha": "<40 hex>",
      "files": 3,
      "lines": 88,
      "risk": "low"
    },
    "inputsDigest": "sha256:<64 hex>",
    "policyDigest": "sha256:<64 hex>",
    "evaluatorVersion": "self-serve-v1",
    "killEpoch": "<digest>",
    "expiresAt": "2026-11-16T13:17:11.204Z",
    "mode": "shadow"
  },
  "prevHash": "<64 hex>",
  "hash": "<64 hex>"
}
```

Field rules:

- `requestId`: unique, generated by the evaluator. `approval:consumed`,
  `approval:expired` and `approval:resolved` reference it.
- `reasons`: rule IDs and short fixed strings only, for example
  `["M1.size:lines>150"]`. Never free text from PR titles, bodies, logs or
  model output. That keeps the log free of secrets and of injected text.
- `inputsDigest`: sha256 over the canonical frozen snapshot fields used by
  the decision. Replay of the same snapshot must give the same decision
  (section 8, test T3).
- `policyDigest`: digest of the taxonomy table compiled into the build plus the
  resolved grant limits. A deploy that changes it is visible in the log.
- `mode`: `shadow` (decision logged, nothing acts on it) or `live`.
- No secrets, tokens, cookies, URLs with credentials, environment dumps, or
  message bodies. Writes pass the existing `assertNoSecrets` style check
  before append.

`approval:consumed` data: `{requestId, executor, result:
"queued"|"merged"|"published"|"launched"|"failed", headSha, detail}`. The
executor must re-check `headSha` and refuse on mismatch.

`approval:resolved` data: `{requestId, by: "security"|"mason", decision:
"pass"|"fail"|"approve"|"deny", evidence}`. `evidence` is a path or digest
only: the Security ready file path and PASS tree, or the team event ID.

### Reading it

The implementing PR adds read-only views: `phm approvals --json` gains a
`selfServe` section with the last N decisions, pending routed requests and
today's counters, and `phm authority ledger --kind approval:*` gives a filtered
tail. Both are read-only. Neither decides anything.

## 7. Failure modes

| # | Failure | Effect without care | Design response |
| --- | --- | --- | --- |
| 1 | Ledger append fails (disk full, lock timeout, EPERM) | action runs without a record | Raising actions append first. If the append fails, nothing runs and the result is `MASON` with reason `ledger:append-failed`. Lowering actions run, then append (existing rule) |
| 2 | Ledger chain broken or head mismatch | forged or lost history | sticky `ledger.broken` means all raising actions route to MASON until `ledger:recovered`, which Mason performs |
| 3 | Grant expired, paused, revoked, or `authoritySurfaceDigest` changed by a deploy | stale authority keeps approving | step 4 global stops; everything raising routes to MASON |
| 4 | KILL set while an approval is outstanding | approved action runs after stop | approval binds `killEpoch`; executor re-reads KILL and epoch before acting and refuses on change |
| 5 | PR head moves after approval (TOCTOU) | unreviewed commit merges | approval binds `headSha`; merge-queue enqueue uses `expectedHeadOid`; executor refuses on mismatch |
| 6 | Approval replayed or reused | one approval, many actions | one-shot: `approval:consumed` is written once per `requestId`; a second consume is refused; 15 min expiry |
| 7 | Path classifier misses a pinned file (new name, rename, symlink) | pinned change auto-merges | `securityPinnedPath` is a broad token match. Truncated file lists route as pinned. Renames check both old and new paths. Unknown file states route to MASON. Security owns the pinned-path list and its tests |
| 8 | Taxonomy has no row for a new action | silent auto | `X0`: unknown routes to MASON. A test asserts every executor call site passes a taxonomy ID |
| 9 | Burst of auto approvals (loop, bad batch) | many merges before anyone looks | grant `maxMergesPerDay` (legacy default 4 per repo), merge-queue budgets (1 per 15 min, 3 per 24 h, 20 per cycle), F5 requeue cap. Over a cap routes to MASON, not wait-and-retry |
| 10 | Security or Mason does not answer | work stalls | it stalls by design. No timeout ever converts to AUTO. Pending routed items show in `phm approvals` with age, so they are visible |
| 11 | Agent forges a ledger line or a pass file | self-granted approval | job sandbox profiles deny `~/.ashlr-runs` (`publish.sh:156`). Whether they also deny writes to `~/.ashlr/authority/` is **unverified** (open question Q1). The hash chain plus anchor detects edits, and the evaluator runs only in the daemon, outside job sandboxes |
| 12 | Prompt injection in PR title, body or diff steers the decision | wrong route | the evaluator reads only structured facts (author login, SHAs, counts, paths, check states, labels). No text field reaches it. No model is in the loop |
| 13 | Clock skew | early or late expiry | `expiresAt` is checked against the daemon clock. A ledger `at` older than the previous line's `at` is treated as a broken chain |
| 14 | Merge queue or required checks removed or changed on GitHub | merges without checks | M1 requires that the repo has a merge queue (existing check). Ruleset or check edits are H8 (MASON). The evaluator never asks for bypass |
| 15 | GitHub API errors or partial data | wrong facts | any missing fact fails the auto condition that needs it. That routes to wait or MASON, never AUTO |
| 16 | Evaluator crash between `decided` and `consumed` | dangling approval | it expires after 15 min and `approval:expired` is written lazily. The executor never acts on an approval it did not get from the ledger |
| 17 | Grant sets `meteredUsdPerDay > 0` | spend path opens | evaluator refuses to run in live mode (H1); shadow mode logs `grant:spend-nonzero` |
| 18 | Shadow and live disagree after enable | regressions | shadow stage must show zero AUTO decisions on rows a human later denied before live (section 8) |
| 19 | Evaluator code changes without review | silent widening | `src/core/approvals/self-serve.ts` and its taxonomy join `TIER1_SOURCE_PATTERNS` (owner review), and its digest is part of `authoritySurfaceDigest`, so a change pauses the grant |

## 8. Rollout (after Security sign-off only)

1. **Stage 0, code lands dark.** The evaluator, taxonomy, ledger kinds and read
   views merge with `mode` forced to `shadow`. No executor reads decisions.
   Tests:
   - T1: every taxonomy row with each fallback.
   - T2: `NEVER` rows cannot be lifted by any grant.
   - T3: same snapshot gives the same decision.
   - T4: lowering is always AUTO.
   - T5: unknown action routes to MASON.
   - T6: a ledger append failure blocks raising actions.
   - T7: a moved `headSha` or a new `killEpoch` refuses consume.
   - T8: no free-text field is reachable from `decide`.
   - T9: `meteredUsdPerDay > 0` blocks live mode.
   Tests are hermetic, using `test/setup/home.ts`.
2. **Stage 1, shadow.** The daemon calls `decide` beside today's flow and
   writes `approval:decided` with `mode: "shadow"`. It runs for a period
   Security chooses. Exit criteria: no shadow `AUTO` on any item a human or
   Security later denied, and no `NEVER` row ever reached.
3. **Stage 2, live for M1 and F1/F3/F5 only.** Activation needs Mason's Touch ID
   grant renewal naming `selfServe: ["M1","F1","F3","F5"]` (a grant field
   added in the implementing PR, inside the signed payload). It also needs the
   dispatchd hunk applied by Security (section 9).
4. **Stage 3, more rows.** Each further row needs its own grant field entry.
   Rows routed SECURITY, MASON or NEVER in this document never become AUTO
   without a new design and a Security pass.

Rollback at any stage: set KILL, or lower the switch. Either takes effect at
the next decision because step 4 reads them every time.

## 9. Pinned-file touch points (for Security to cut)

This lane could not read the pinned files. No diff is proposed here. The
intended integration, for Security to cut against the pinned base, is:

- `bin/dispatchd.py` (live sha256 prefix `d5acb03d`). Before launching a job
  (F1) or raising a lane target (F2), call `phm approvals decide --json
  --action F1 ...` (a new read-plus-ledger-append command) and launch only on
  `route == "AUTO"`. In shadow mode, call it and ignore the result. PAUSE,
  memguard, loadgate, hard_cap and ceilings stay exactly where they are and
  run first.
- `contrib/mac/publish.sh` and its live copy. Before `gh pr merge --auto`
  (M7), require an `AUTO` decision for the head SHA. Otherwise leave
  auto-merge off and route. Security owns this change because `publish.sh` is
  itself a pinned path.
- No change to iMessage send scripts, `bin/launch.sh`, release-autorun,
  release-sign or standing-authority.

## 10. Open questions

- **Q1 (Security).** Do the job `*.sb` profiles deny writes to
  `~/.ashlr/authority/` and `~/.ashlr/KILL`? This lane could not read them.
  If they do not, failure mode 11 needs a profile change (Security pin) before
  stage 2.
- **Q2 (Security).** Should `approval:decided` lines be HMAC-signed like
  host-merge revocation receipts (`host-merge-revocation-protocol.ts`), or is
  the hash chain plus anchor enough?
- **Q3 (Mason).** Phase 1 caps risk at `low`, even though
  `STANDING_GRANT_CEILINGS.maxRisk` allows `medium`. Is `low` the right start?
  This design names the grant's per-repo `maxRisk`, clamped to `low` in phase
  1, as the one risk source. It does not use `foundry.autoMerge.maxRisk`.
- **Q4 (Mason).** F2 auto-raises a lane only up to the roster target that Mason
  sets. Should the roster target itself ever be auto-raised? This design says
  no.
- **Q5 (Security).** The 15 minute approval TTL matches the merge-queue
  per-(action, PR) retry window. Is it acceptable?

## 11. Why this sign-off order

Security signs first because three pieces are Security-owned. The evaluator
gates pinned executors (dispatchd, publish.sh). Its failure modes depend on
sandbox profiles (Q1). It adds a new ledger kind to the chain Security already
audits. Mason signs the grant renewal in stage 2 because only a Touch ID grant
raises authority (`docs/AUTHORITY.md`).
