## Problem and change

The original macOS admission gate blocked engine launches on stale absolute
swap and low free-page counts. This also caused 16 failures in the protected
Darwin engine suite.

Make host memory holds OFF by default. Only `ASHLR_HOST_MEMORY_HOLD=1`
enables telemetry and admission holds. Unset it or set it to `0` to disable
holds and discard sampled history. An already-running host must receive the
new environment on restart.

When enabled, hold a new `spawnEngine` launch only after observing more than
2 GiB of swap growth within ten minutes. Flat 19.35 GiB swap permits spawning,
including with low free-page counts. Use a bounded process-local monotonic
window, and resume as growth falls or observations expire. Missing or invalid
enabled telemetry still refuses that attempt. Denied launches now produce
no spawn custody write or callback.

The protected 310b tests are unchanged. Keep the implementation in the
unprotected run module because `src/core/routing/**` is Tier-1 protected.
Update operator documentation and retain bounded, value-free telemetry.

## Validation

Run locally on Darwin arm64, Node v22.22.3, with a fresh temporary HOME for
every test invocation:

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Protected `engines-stream-family-310b.test.ts` | 25 | 0 | 0 |
| `m11.engines.test.ts` | 71 | 0 | 0 |
| `engines-custody-record.test.ts` | 4 | 0 | 0 |
| `host-headroom.test.ts` | 44 | 0 | 0 |
| `host-headroom-spawn.test.ts` | 9 | 0 | 0 |
| Total | 153 | 0 | 0 |

```sh
HOME=$(mktemp -d) npx vitest run test/host-headroom.test.ts test/host-headroom-spawn.test.ts test/m11.engines.test.ts test/engines-custody-record.test.ts test/engines-stream-family-310b.test.ts --maxWorkers=1 --no-file-parallelism
```

The original head reproduced 16 failures and 9 passes in the protected suite.
Tests cover stale swap through the real gate, growth and expiry boundaries,
same-second growth, telemetry errors, default-off behavior, switch reset,
non-Darwin behavior, and absence of custody side effects on refusal.

- `npm run typecheck`: passed, backend and web.
- `npm run lint`: passed, zero errors, 206 repository warnings, none in fixup files; both lint guards passed.
- `npm run check:docs`: passed, zero errors.
- `git diff --check`: passed.

Repaired a pre-existing truncated dependency installation with lockfile-exact
`npm ci --ignore-scripts --no-audit --no-fund`. No manifest or lockfile edits.
No `.github/**`, CODEOWNERS, Tier-1 paths, release/publish configuration,
credentials, or protected tests changed. No added em dashes.

## Operational limits

Enabled probes retain synchronous collection, bounded to one second and
64 KiB per command; default-off admission performs no probes. Sampling is on
launch attempts, and a first sample or idle gap longer than ten minutes
establishes a fresh baseline. One-second minima bound history to 601 records;
a partially expired bucket can omit less than one second of history.

The hold does not interrupt running engines or cover separate API/resource
worker transports. It does not reserve RAM or coordinate host processes.
