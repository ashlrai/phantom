# Queue upgrade audit

From a Phantom source checkout matching the installed version, with its dependencies already available:

```sh
npx tsx examples/upgrade/queue-upgrade-audit.ts
npx tsx examples/upgrade/queue-upgrade-audit.ts --help
```

Run after an upgrade and repeat as upgrades proceed. The command reads the current user's `~/.ashlr-runs` through the public fleet queue and runs-directory readers. It does not change, wake, or reassign work. Except for help, stdout is one versioned JSON object. Errors are static and contain no paths or reader exception details.

The audit joins queue `byLane` with the status reader's actual lanes using exact names. `unknown` means a lane is absent from a healthy status projection; `held` means its status lane is held. Ready counts on either are mismatches. `unconfirmed` means the status source is missing or degraded, so absence is not evidence of removal. A known held lane can still establish a mismatch in partial status. `running`, `target`, `floor`, and `ceiling` are null when unknown, never inferred as zero. Queue counts are observed counts and may be partial when `sources.queue.ready` is degraded; missing queue totals are null. The unrelated skip-log and overall runs source health are retained for context but do not decide the verdict.

Only already-public parked-group IDs appear as `parkedSamples` (up to eight per lane); the queue reader does not expose READY IDs. At most 100 lanes are emitted, and omitted or unsafe lane names force insufficient evidence unless a mismatch is already established. Finding counts cover all safe observed lanes, including omitted ones. Other fields, titles, prompts, hold reasons and paths are not emitted.

Exit codes:

- `0`: both relevant sources are healthy and no ready work is on unknown or held lanes; also help.
- `1`: a confirmed mismatch, or a reader failure (a static JSON error).
- `2`: invalid arguments (a static JSON error).
- `3`: insufficient evidence, including missing or degraded relevant sources, unsafe names, or a truncated lane list, with no confirmed mismatch.

The two reads are separate snapshots, not an atomic transaction; repeat around active dispatch. A healthy status only reflects lanes accepted by the installed source reader: unrecognized status lane names make it degraded. The queue reader caps input and may stop at 50,000 parsed rows without indicating truncation, so verification is limited to that projection. This check does not establish capacity availability, freshness, or successful dispatch.
