# RQ-USAGE-READER-AUDIT-1 — codex used% 39 -> 21 (22:08 to 23:54 ET, Nov 15 2026)

Intended destination: `~/.ashlr-runs/bus/eo/usage-reader-audit.md`. This lane's
sandbox returns EPERM for the entire `~/.ashlr-runs` tree (read and write), so
the report is delivered here in the worktree; an unsandboxed worker should copy
it verbatim.

## Verdict

Reader artifact, not a real partial reset. No usage-reader code changed during
the window, and the durable per-window usage history shows the matching Codex
weekly window rising monotonically through both timestamps — it never fell.

## The numbers

- 22:08 ET Nov 15 = 2026-11-16T03:08Z. Reported usedPct 39.
- 23:54 ET Nov 15 = 2026-11-16T04:54Z. `queue/phm-usage-sensors.json` shows
  engine codex usedPct 21, windowLabel `1w`, resetsAt Sat Nov 21 15:30 ET
  (= 2026-11-21T20:30Z).

## Evidence

### 1. No reader code change in the window

`git log` on ashlrai/phantom master for 2026-11-16T03:08Z–04:54Z (22 commits,
#6189–#6211) touches nothing under `src/core/usage/`,
`src/core/fleet/codex-session-usage.ts`, `src/core/fleet/subscription-usage.ts`,
`src/core/fabric/readers/codex-usage.ts`, `src/core/observability/codex-source.ts`,
`src/cli/usage-sensors.ts`, or `contrib/mac/dispatchd.py`. The codex usage
readers are byte-identical to their Nov 14 state (`git diff 07a09550b5 master`
empty for all of them); the last semantic changes were Oct 27
(`f3bc230c5c`, codex-usage.ts) and Nov 4 (`86c641341a`, codex-session-usage.ts`)
on the pre-recut line, and `refreshStalePersonalUsage` dates to Nov 9
(`8a3594eef7`/`4fd6e85cc1`). The live `phm` on this Mac is 3.30.24; release
3.30.34 landed 04:57Z, after the window.

Reader selection logic (unchanged): `parseNativeUsage` in
`src/core/fabric/readers/codex-usage.ts` picks the window with the highest
`usedPercent` across primary/secondary; `_codexLocalUsage` in
`src/core/fleet/subscription-usage.ts` picks the max across every Codex
credential home and both windows. `minutesToLabel(10080)` -> `1w`.

### 2. The matching window never decreased

`~/.ashlr/fleet/fleet.json` `codexUsage.readings` (written by
`publishCodexFleetUsage` from Codex rollout rate-limit snapshots, keyed by
account + window + resetsAt) shows for `codex-personal` / `primary` — the
weekly window whose resetsAt is exactly 2026-11-21T20:30:2xZ, i.e. Sat Nov 21
15:30 ET, matching the sensors file:

- 2026-11-16T03:40–03:57Z: usedPct 40 (brackets the 22:08 ET reading of 39)
- 2026-11-16T04:25–04:50Z: usedPct 41 (brackets the 23:54 ET reading)
- 2026-11-16T05:05–05:55Z: usedPct 42–43, still rising

Within the current reset window (started 2026-11-14T20:22Z) the series is
monotonic non-decreasing; the only decreases in the whole file occur across
the Nov 14 weekly reset boundary. usedPct was <= 21 only during
2026-11-14T20:51Z – 2026-11-15T12:27Z — i.e. a value of 21 with this resetsAt
was last true roughly 16–18 hours before the 23:54 ET snapshot.

`codex-cmp` does not fit either: its last samples are 90–91% at
2026-11-15T08:05Z and its resource state is `unavailable` by 05:52Z Nov 16.

### 3. Interpretation

A real partial reset would show a decrease inside the same resetsAt window in
the durable samples; none exists. The 23:54 value of 21 is consistent with a
stale or alternate-source reading (the codex-personal lane's last-good value
from ~10:30–12:30Z Nov 15, or a different pool home / window selection), not
with the provider counter, which read ~41% at that moment and kept climbing.

Caveat: `queue/phm-usage-sensors.json` itself lives under `~/.ashlr-runs`,
which this lane's sandbox cannot read (EPERM on the whole tree). The
snapshot's own `observedAt`, `source`, and the 22:08 entry's
windowLabel/resetAt would confirm which artifact path fired; that check needs
an unsandboxed reader.

## Commands run

- `git fetch --unshallow origin master`; `git log` on master for the window
  and `git diff 07a09550b5..master` on all usage-reader paths
- `git log -S refreshStalePersonalUsage`
- Read `src/core/usage/sensor-{pull,refresh,reading}.ts`,
  `src/core/fabric/readers/codex-usage.ts`,
  `src/core/fleet/{subscription-usage,codex-session-usage}.ts`
- Parsed `~/.ashlr/fleet/fleet.json` `codexUsage.readings` (1119 samples)
- `phm --version` (3.30.24), `phm usage --help`
