# Bridge session record and replay

`replay.ts` records an instrumented agent session to `fleet.json` and reruns the
same session function offline. It does not launch agents or execute instructions
from a recording. There is no bridge dispatcher or pre-existing `fleet.json`
schema in this checkout; the adapter is the integration boundary.

```ts
import {
  recordFleetSession, replayFleetSession,
  type ReplayAdapter, type ReplayRunner,
} from './replay.js';

const session: ReplayRunner = async ({ input, call }) => {
  const now = await call('clock.now', null);
  const reply = await call('model.complete', { task: input, now });
  return call('bridge.verify', reply);
};

// Supply the bridge's governed live operations here. Its existing authorization
// and sandbox checks still apply. Replay never receives this adapter.
declare const execute: ReplayAdapter;

const capture = { path: './fleet.json', jobId: 'RQ-REPLAY-1/attempt-1', input: 'task' };
const recorded = await recordFleetSession(capture, session, execute);
const replayed = await replayFleetSession(capture, session);
// replayed equals recorded, including a failed job's normalized error outcome.
```

All external reads and effects, model responses, clock reads, random choices and
IDs must pass through `call`. Await each call before issuing another. The harness
does not intercept ambient JavaScript APIs or sandbox arbitrary runner code.
Parallel calls, timers and process crashes cannot be reconstructed from this
serial format. A crash or harness failure leaves an incomplete capture, which
replay refuses. Captures cannot recover effects that were never recorded.

The versioned `phantom-fleet-replay/v1` file contains immutable job IDs, initial
inputs, ordered requests and outcomes, and the terminal outcome. Outcomes are
`{ status: 'returned', value }` or `{ status: 'threw', error: { name, message,
code } }`. Caught adapter failures can be replayed too. Errors have normalized
name, scrubbed message and optional string code; stacks, subclasses and extra
properties are intentionally excluded. Use JSON DTOs for requests and results;
use `null` for operations without a value. Dates, undefined, accessors, sparse
arrays, cyclic objects and non-finite numbers are refused.

Replay checks operation names, canonical inputs, call count/order and terminal
outcome. Mismatches remain failures even if session code catches them. Changed
runner code must still reproduce these observations; the capture does not pin
the runner's source revision. Use the original revision when reproducing a bug.

Inputs and results containing recognized credentials or sensitive field values
are refused before persistence. Pass Phantom Secrets `phm_` references instead;
the harness never reads credentials or environment variables. Do not place
private context or unrecognized credentials in DTOs. Error messages use the
repository's shared secret scrubber. Recordings are private local debugging
artifacts, not public logs.

Writes use private atomic files, with an exclusive writer lock held through all
outstanding effects. Each request is persisted before executing it. Retries use
new job IDs; existing attempts are never replaced. Limits are 100 sessions,
1,000 calls per session, 4 MiB per file, 32 payload levels and 50,000 nodes per
payload. Unsupported schemas, damaged checksums, incomplete captures and unsafe
file targets fail closed. The checksum detects accidental damage, not forgery,
and recordings never grant authority. No stale lock is stolen automatically;
only remove an abandoned `.replay-lock` after confirming its writer and effects
have stopped. Retain or archive the incomplete attempt separately.

Run the suites with an isolated home:

```sh
HOME=$(mktemp -d) ./node_modules/.bin/vitest run \
  test/fleet/replay.test.ts test/fleet/replay-codec.test.ts \
  --maxWorkers=1 --no-file-parallelism
```
