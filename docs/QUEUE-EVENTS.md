# Queue station events

`queue.v1` describes entry to and exit from a station. The closed property
schema is [schema/queue.v1.json](../schema/queue.v1.json); runtime validation
also rejects impossible dates and exits earlier than entry.

| Property | Meaning |
| --- | --- |
| `job_id` | Stable job identifier |
| `pr` | Positive PR number, or `null` before discovery |
| `station` | Producer's station identifier |
| `pool` | Producer's worker pool, such as `codex-cmp` |
| `tier` | Producer's job tier, such as `work` |
| `enter_ts` | Original visit entry, canonical UTC ISO timestamp with milliseconds |
| `exit_ts` | `null` on entry; canonical UTC ISO timestamp on exit |

Identifiers use 1–128 letters, digits, dots, underscores, colons or hyphens,
starting with a letter or digit. They are metadata identifiers, never prompts,
account names, credentials, paths or task descriptions. Unknown properties are
rejected. A known PR cannot change during a visit; an unknown PR may be filled
at exit. Reentry creates a new visit and timestamp.

## Producer API

`src/core/observability/queue-events.ts` owns validation and station pairing.
`enterQueueStation` returns a handle whose `exit()` attempts capture once,
including concurrent calls. `withQueueStation` emits exit in `finally`, preserving
the work's result or original error when analytics fails. Capture failures return
fixed, value-blind diagnostics. This is best-effort observation, not a durable
outbox or an execution/merge authority signal. Capture callbacks must settle;
the existing HTTP sink bounds requests to three seconds. Process termination
can leave an entry without an observed exit.

The callback has the shape `capture('queue.v1', properties)`, so an existing
analytics adapter can accept the event without new credentials. To use the
current telemetry route from source:

```ts
import { withQueueStation } from './queue-events.js';
import { getQueueSink } from './telemetry-sink.js';

const sink = getQueueSink(cfg, false);
await withQueueStation(async (_name, properties) => {
  const result = await sink.emit([properties]);
  if (!result.ok) throw new Error('Queue telemetry unavailable');
}, {
  job_id: 'RQ-QUEUE-1', pr: null,
  station: 'work', pool: 'codex-cmp', tier: 'work',
}, async station => {
  const pr = await runWork();
  await station.exit({ pr });
});
```

Station names and transitions come from the producer. This change does not map
existing claim leases or cloud task states to invented stations.

## Transport and replay

Without a telemetry endpoint, queue envelopes are written to
`~/.ashlr/telemetry/queue-YYYY-MM-DD.jsonl`, separately from usage spans. Each
envelope contains `event: "queue.v1"` and the seven `properties` above.

With `cfg.telemetry.pulse` configured, replay uses the existing OTLP HTTP route
and existing `ASHLR_PULSE_TOKEN`; missing credentials are an explicit failure.
Run credentialed processes through Phantom Secrets `phantom exec` using the
operator's existing secret mapping. Do not extract values, provision a token,
or put credentials in a fixture. No credential subprocess is launched by the
event library or sink.

OTLP represents each boundary as a point span named `queue.v1`, with
`event.name=queue.v1` and allowlisted schema attributes. Null `pr`/`exit_ts`
attributes are omitted because OTLP has no null scalar; consumers interpret
their absence as null. Exit retains the original `enter_ts`. No model usage,
tokens or cost are synthesized. HTTP errors never include response text or
exception messages, and redirects are refused.

From a checkout, replay the checked-in ten-event fixture:

```sh
queue_replay_home=$(mktemp -d)
HOME="$queue_replay_home" ASHLR_HOME="$queue_replay_home/.ashlr" npm run dev -- telemetry queue-replay test/fixtures/queue-events/replay.json --json
```

Replay validates the complete JSON array before sending anything. Input is
capped at 256 KiB and 1,000 events. It returns 0 for successful sink delivery,
1 for delivery/config/JSON-parse failures, and 2 for invalid arguments, schema,
unavailable files or input bounds.
Replaying again emits again; it is an acceptance fixture, not a deduplicating
job scheduler. Unit tests replay the exact ordered callback stream and the CLI
replay checks the actual local sink records.

## PostHog integration boundary

This checkout has no backend PostHog capture adapter or canonical producer with
job/station/pool/tier metadata. Its PostHog references only preserve website
public configuration under protected website code. The callback is compatible
with an existing capture adapter, but the implemented transport is local/OTLP.
PostHog delivery and automatic production station wiring remain blocked until
the intended existing adapter and producer are identified. Local fixture or
OTLP acceptance does not establish PostHog ingestion.
