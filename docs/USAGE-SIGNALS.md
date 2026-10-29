# Event-driven operations usage readings

The operations bridge can invoke this one-shot entrypoint on `dispatch-start`,
`pr-merge`, `429`, `limit-message`, or `manual-reading`. It never starts a watcher,
interval, cron job or trailing debounce timer. Event producers must invoke it;
the daemon's protected dispatch and merge hooks are not changed by this feature.

From a source checkout:

```sh
npx tsx src/cli/usage-signal.ts --directory /absolute/private/ops \
  --event dispatch-start --readers /absolute/private/usage-readers.json
```

After compilation, use `node dist/cli/usage-signal.js` with the same options.
Without `--pool`, all five pools are selected. Repeat `--pool` to select a subset:
`grok-ultra`, `codex-cmp`, `codex-personal`, `claude-max`, `terra`.

The store must be an owned canonical directory with mode 0700. Existing
`fleet.json` and `usage-readings.log` files must be owned regular files with mode
0600 and one hard link. Symlinks are refused. Use a dedicated operations store,
separate from native provider profiles. Existing unrelated fleet fields are preserved.

## Reader contract

`--readers` names an owned 0600 JSON file mapping pool IDs to absolute paths of
operator-provisioned read-only reader executables. No shell strings, arguments,
keys, cookies or tokens belong in that file. Each selected, eligible reader runs
as `phantom exec -- /absolute/reader`, with only PATH, HOME, TMPDIR, LANG and LC_ALL
inherited. Phantom Secrets owns any credential resolution. Readers must inspect
only already-authorized usage surfaces, never sign in, copy browser credentials,
read Codex auth files, submit forms or change provider state.

The external Phantom Secrets `phantom` executable must already be on PATH. This
entrypoint does not install it or create credentials. Reader wrapper scripts
should replace themselves with their reader process so the deadline owns that
process, rather than spawning detached work.

Each executable returns one JSON object on stdout:

```json
{
  "pool": "grok-ultra",
  "pctUsed": 68,
  "resetAt": "2026-11-02T01:21:00.000Z",
  "source": "grok-reader",
  "fetchedAt": "2026-10-26T20:46:00.000Z"
}
```

This is a synthetic protocol example, not a live reading. Percentages must be
finite and between 0 and 100. Dates use canonical UTC ISO timestamps. Readings
must be less than 30 minutes old and cannot be future dated. Missing, malformed,
wrong-pool, failed or unavailable readers produce null usage, never zero capacity.
Sources are assigned by the writer; extra reader fields and error text are discarded.
Reader processes have a 15-second deadline and an 8 KiB output cap. No provider
reader is enabled by default. The Grok dependency's returned reading fits this
contract; its optional log append must be disabled so this writer owns journaling.
Its verified-page requirement still applies. CMP and personal Codex accounts
must have separate provisioned readers; Terra also needs an explicit reader.

## Persistence and signals

Debounce is a leading-edge rolling 30-minute window per pool, across event types,
process restarts and concurrent bridge invocations. Suppressed events do not run
readers or append readings. A cross-process lock protects the journal and snapshot.
Busy invocations fail closed with a nonzero exit; the bridge can retry the event.
There is no background retry loop. Backward clock changes stay suppressed until
the recorded window expires.

Each accepted reading appends one JSONL record to `usage-readings.log` before
updating `fleet.json.readings[pool]`. A later event repairs an interrupted snapshot
from the journal without rereading a debounced pool. Torn or malformed journals
fail closed. Store files are capped at 8 MiB; archive/rotate the store during a
controlled stop, retaining the latest record per pool to preserve debounce and
cut state. All writers of this dedicated store must use the same lock.

`burnRatePctPerHour` is the nonnegative percentage-point change per elapsed hour
between two numeric readings with the same known reset. A decreased counter,
changed/unknown reset or unknown reading gives null burn and projection. A
positive burn produces `projected100At` only if exhaustion precedes the reset.
Flat usage below 100% has zero burn and no projection. A comparable 100% reading
uses its observation time as the exhaustion time. These are linear estimates.

At Grok usage >=80%, stdout `signals` contains a `cut` transition and
`fleet.json.usageSignals["grok-ultra"]` persists the active signal. The bridge
must consume that signal to stop routing work to the pool. The writer does not
alter scheduling authority. Subsequent high readings do not emit duplicate
transitions. Unknown readings retain the active cut; a numeric reading below
80 clears it and rearms the next transition. After a crash, use the persistent
signal rather than relying solely on stdout delivery.
