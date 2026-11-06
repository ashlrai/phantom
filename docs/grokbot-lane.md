# Grok Bot resource lane

Phantom owns task selection. Grok Bot is reserved for `connector`, `browser`,
`desktop`, `message-mason`, and `approval` tasks. Coding, research, shell execution,
and inference are refused. A kind labels capability, not authority: existing
approval and sandbox rules still govern every action. In particular, an approval
result is an observation for Phantom's existing approval flow, never a grant.

The opt-in adapter is `src/core/resources/grokbot/lane.ts`. It exposes
`GrokbotLane.submit(task)` and `GrokbotLane.readResult(task)` for a future daemon
caller. No daemon hooks or dispatchd files change. Dispatchd stays the fallback
until an independently authorized cutover. No provider call or live routine was
enabled by this change.

## Exact request contract

```json
{
  "schema": "grokbot-task.v1",
  "id": "RQ-CONNECTOR-42",
  "kind": "connector",
  "goal": "Find the requested Gmail thread",
  "inputs": { "connector": "gmail", "thread_id": "thread-42" },
  "budget_cap": 1,
  "reply_to": "/absolute/private/grokbot/replies/RQ-CONNECTOR-42.json",
  "deadline": "2026-10-26T19:00:00.000Z"
}
```

All fields are mandatory and extra fields are refused. `id` is 1 to 96 ASCII
letters, digits, underscores or hyphens, starting with a letter or digit.
`goal` is nonempty and at most 4096 characters. `inputs` is a string map with
lowercase identifier keys and values up to 1024 characters. The full request is
limited to 16 KiB. Use public descriptions and opaque connector object IDs;
connector sessions stay inside Grok Bot. Never include mail contents, credential
files, environment dumps, secrets, tokens, or even `phm_` placeholders. The
validator rejects credential-shaped fields and common token formats, but pattern
matching cannot prove arbitrary prose is secret-free. Callers remain responsible
for supplying only public task metadata.

`budget_cap` is exactly **one routine task**, not dollars or model tokens. It
does not authorize paid connector actions or recursive routine spawning.
`deadline` is canonical UTC ISO time, in the future and no more than 24 hours
away. `reply_to` must equal `<stateRoot>/replies/<id>.json` exactly.

Requests use `POST`, `Content-Type: application/json`, and `Idempotency-Key: <id>`.
Only HTTP **202** means accepted, and acceptance is not task completion. No
redirects or automatic retries are allowed. Request timeout is the lesser of
15 seconds and time remaining to the deadline. HTTP errors, timeouts, process
failures, and uncertain delivery retain their task reservation.

## Secrets transport contract and activation dependency

The adapter always launches:

```text
phantom exec -- <node executable> <installed dist/core/resources/grokbot/worker.js>
```

It supplies the validated task on stdin, never a shell command. Child stdout and
stderr are discarded, and errors contain only fixed reason codes. The child
expects a Secrets-owned `GROKBOT_BASE_URL` of the form
`http://127.0.0.1:<port>/grokbot/_phantom/<session-capability>/`. That URL is used
only for transport and never inserted into the task. No plaintext endpoint or
credential environment fallback exists. Local inference configuration is untouched.

**Required upstream auth header: `Authorization: Bearer <existing routine credential>`.**
Phantom Secrets must own the upstream webhook URL in `GROKBOT_WEBHOOK_URL` and
the existing credential in `GROKBOT_WEBHOOK_AUTH`. Secrets must resolve the URL
and inject this header within its proxy; neither value may enter the child,
payload, logs, argv, or agent context. No new credential is created here.

**Current limitation:** the companion source inspected for this change supports
only exact built-in routes under `phantom exec`, refuses custom routes, and has
no built-in `grokbot` route or vault-backed webhook URL routing. Consequently this
transport contract is a dependency seam, not a claim of live support. The worker
fails closed when the route is unavailable. Do not configure a custom route,
extract the vault value, use `phantom start` as a bypass, or loosen a sandbox to
activate it. Secrets needs a reviewed implementation of this exact route and URL
custody contract before live commissioning. The stub tests qualify the HTTP
contract; they do not qualify the Secrets proxy or a real Masbot routine.

## Grok Ultra ledger seam

Construct `GrokbotLane` with an absolute, owned mode-0700 `stateRoot`, a
`secretsProject` working directory, explicit nonnegative integer `caps.day` and
`caps.week`, and `readBudget(): Promise<unknown>`. The latter is the clean
RQ-BUDGET-LEDGER integration point. The current repository has no named budget
ledger interface; the local dispatchd README was unreadable under macOS access
controls. No compatibility with an uninspected private schema is assumed.

`readBudget` must return this projection of the authoritative `grok-ultra` ledger:

```json
{
  "schema": "grok-ultra-budget.v1",
  "pool": "grok-ultra",
  "observed_at": "2026-10-26T18:00:00.000Z",
  "expires_at": "2026-10-26T18:05:00.000Z",
  "not_before": "2026-10-26T18:00:00.000Z",
  "day": {
    "start": "2026-10-26T00:00:00.000Z",
    "end": "2026-10-27T00:00:00.000Z",
    "cap": 5,
    "used": 1
  },
  "week": {
    "start": "2026-10-26T00:00:00.000Z",
    "end": "2026-11-02T00:00:00.000Z",
    "cap": 20,
    "used": 3
  }
}
```

These numbers are examples, not defaults or spend permission. Windows must
contain the current time and last exactly 24 hours and 7 days. The ledger owns
their stable boundaries. Observation freshness and expiry are capped at five
minutes; future observations, invalid data, missing data, and `not_before` in
the future refuse dispatch. Zero cap disables the lane. For each window,
admission requires ledger `used` plus all local reservations in that window to
be below the smaller of the configured and ledger cap. If the shared ledger
already counts local reservations, this deliberately double-counts them until
the window ends. It cannot increase allowance because of reconciliation lag.
The ledger must coordinate other consumers of the same shared allowance.

All adapter instances on a host must share one state root and cap policy.
Reservations are protected by an exclusive directory lock, written and synced
before transport, then atomically renamed and the directory synced. IDs are
retained to prevent replay, including failed sends. The store refuses admission
at 4096 entries rather than forgetting IDs. Missing initial state starts empty;
do not delete or replace initialized state to reset caps. Corrupt state, symlinks,
future reservation times, and a busy lock fail closed. After a crash, an operator
must establish no writer is alive and reconcile delivery before repairing a
leftover lock or `.next` file. No automatic lock stealing or refunds occur.

## Masbot webhook-triggered routine

1. Authenticate the request using the existing credential in the exact auth
   header above. Reject invalid schemas, kinds, credentials and expired tasks
   before starting any work. Persist the idempotency key before acknowledging
   with 202; repeat IDs must not launch a second run.
2. Run only the requested allowlisted capability with existing connector
   sessions and approval controls. `message-mason` targets Mason only. `approval`
   requests Mason's decision; it cannot grant approval to itself. Stop at the
   deadline and never exceed one routine invocation or fan out into child tasks.
3. Produce a bounded, secret-free result with exactly these fields:

   ```json
   {
     "schema": "grokbot-result.v1",
     "id": "RQ-CONNECTOR-42",
     "status": "succeeded",
     "summary": "Requested thread located"
   }
   ```

   `status` is `succeeded`, `failed`, or `needs-approval`; `summary` is at most
   4096 characters. No credential or private connector content belongs here.
4. On the same machine, write a mode-0600 temporary file in the private replies
   directory and atomically rename it to the exact prevalidated `reply_to` path.
   A remote routine requires an independently authenticated file-delivery bridge
   to that directory. This version exposes no callback listener. Do not interpret
   an arbitrary remote `reply_to` as permission to write any filesystem path.
5. The daemon polls `readResult(task)` on its existing tick. Missing files return
   null; malformed, oversized, mismatched-ID, linked or symlinked files refuse.
   Results remain advisory and are never executed. Callers handle deadline
   expiry as timed out, preserve the reservation, and keep dispatchd available.

## Verification and handoff

Run `HOME=$(mktemp -d) npx vitest run test/grokbot-lane.test.ts`, then
`npm run typecheck`, `npm run lint`, and `npm run check:docs`. The test webhook
binds exclusively to `127.0.0.1`; no real webhook, account, or credential is used.
The production child launcher is mocked to verify its fixed `phantom exec`
invocation and failed-delivery accounting.

Live activation requires Secrets route support, a fresh shared ledger projection,
the Masbot routine and an authorized daemon caller. None is silently enabled by
this adapter. Publication remains an operator handoff through `publish.sh` only;
this worktree contains uncommitted changes and creates no PR itself.
