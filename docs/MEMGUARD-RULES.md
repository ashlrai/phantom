# Mac memguard rules

The pressure policy is implemented in
[`contrib/mac/memguard/rules.ts`](../contrib/mac/memguard/rules.ts), with a
[Mac sysctl adapter](../contrib/mac/memguard/mac.ts). The configuration flag
`pressureRuleEnabled` defaults to `false`. Only the literal boolean `true`
enables the replacement rule; strings and numbers are rejected.

## Evidence and scope

- Queue request `RQ-MEMGUARD-PRESSURE-RULE` specifies the thresholds and records
  Security and Performance agreement at 14:11, following the 14:10 EO. This is
  the supplied decision record, not an independently retrieved approval or a
  benchmark. No workload measurements were supplied.
- At task start, checkout `a6f3c32339411eb2d57cb35d4c78c33127bbb8e7`
  contained neither `scripts/mac-bridge/` nor a memguard implementation. Local
  history had no merge of #1014. The requested pre-merge fallback is therefore
  `contrib/mac/memguard/`. Remote merge state was not independently verified.
- Apple's [XNU sysctl handler](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c)
  converts the internal pressure enum to a dispatch level before returning
  `kern.memorystatus_vm_pressure_level`. The adapter uses the raw sysctl number;
  it does not use the internal enum described in the
  [kernel notification guide](https://github.com/apple-oss-distributions/xnu/blob/main/doc/vm/memorystatus_notify.md).
- Swap occupancy alone does not demonstrate recent growth. The fixtures include
  24 GB of unchanged swap with 30% free memory and normal pressure: flag ON
  must allow dispatch. This is a policy regression fixture, not a claim about
  observed production performance.

## Rule table

All active conditions are ORed. The decision returns all applicable reasons.
Percentages and thresholds are strict where shown.

| Condition | Flag OFF (default) | Flag ON | Reason |
| --- | --- | --- | --- |
| Free memory <25% | Pause | Pause | `free-hard` |
| Existing disk rule requests pause | Pause | Pause | `disk` |
| Free memory <35% | Pause | Replaced by pressure/growth rule | `free-interim` |
| Raw pressure level >=2 | No new effect | Pause | `pressure` |
| Swap grows by >2 GB within 10 minutes | No new effect | Pause | `swap-growth` |
| High swap with no growth | No new effect | No swap pause | None |
| Invalid free-memory or missing disk decision | Hold | Hold | `telemetry-unavailable` |
| Missing/invalid new pressure or swap telemetry | No new effect | Hold | `telemetry-unavailable` |

The existing disk predicate is a **required boolean input**, `diskPause`.
Its threshold, sampled filesystem and equality semantics stay with the existing
bridge. No disk threshold was supplied in the request or found in this checkout,
so this change does not invent one. Fixtures verify that its result is preserved
in both modes. The existing free-memory percentage calculation likewise stays
with the bridge.

## Rolling swap definition

The threshold is 2,000,000,000 bytes (decimal GB), strictly greater than, over
an inclusive 600,000 millisecond window. The sysctl adapter converts the binary
K/M/G/T units in `vm.swapusage` to bytes before comparison. Exactly 2 GB does
not pause. Exactly ten minutes is included; older observations are excluded.

Each tick compares current swap used with the smallest previous reading still
inside the window. This catches growth after a dip as well as gradual growth.
A monotonic queue drops dominated readings while preserving the timestamps of
eligible low points. A decline is not growth. With no baseline, the first sample
cannot establish growth; hard, disk and pressure checks still apply immediately.

Keep one evaluator alive for the lifetime of the monitor and sample on the
existing bridge cadence. The adapter uses a monotonic clock. A clock rollback or
invalid swap/time sample discards history; a restart begins with empty history.
Do not persist history across boots or create a fresh evaluator for each tick.
The rule detects sampled growth, so changes entirely between samples cannot be
inferred. No interpolation or growth from an expired baseline is assumed.

## Integration and rollout

The fallback module is ready for the Mac bridge to import, but this checkout has
no bridge entry point to wire or install. This change does not start a monitor,
write pause markers, or change a running machine. A bridge integration should
construct the adapter once using its parsed local configuration:

```ts
import { createMacMemguard } from '../contrib/mac/memguard/mac.js';

const tick = createMacMemguard({ pressureRuleEnabled: false });
// Inside the existing polling loop, pass the existing measurements unchanged:
const decision = tick(freePercent, existingDiskPause);
if (decision.pause) {
  // Apply the bridge's existing pause operation and record decision.reasons.
}
```

The import path is illustrative and must be relative to the eventual bridge
entry point. TypeScript follows the repository's `.js` import convention and
can be run through its existing `tsx` tooling. The Mac adapter rejects other
platforms. With the flag OFF it performs no new sysctl reads. With it ON the
adapter uses fixed executable/argument arrays, bounded output and two-second
read timeouts. Failed reads retain the other triggers and hold dispatch; no
failed read is converted to zero. No new packages, credentials or tokens are
needed. A clear decision is not permission to clear other stop/pause controls.

Enabling the flag is a joint Security and Performance decision **after merge**.
This change does not make that decision. Rollback is setting the flag to false
and recreating the monitor, restoring the interim free<35% rule. Keep the hard
free<25% and disk rules in either mode.

## Verification

[`test/memguard-pressure-rule.test.ts`](../test/memguard-pressure-rule.test.ts)
contains deterministic fixtures for every requested trigger, default OFF, stale
swap, equality and expiry boundaries, rolling low points, clock rollback,
malformed telemetry and the Mac adapter. Fixture tests run on any platform;
they do not apply pressure to the host or pause live workers.

```sh
HOME=$(mktemp -d) npx vitest run test/memguard-pressure-rule.test.ts
npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck contrib/mac/memguard/rules.ts contrib/mac/memguard/mac.ts
npm run typecheck
npm run lint
npm run check:docs
```

The standalone type check covers the fallback directory, which is outside the
repository's `src` compilation root. Live bridge integration and production
rollout are not established by these fixtures.
