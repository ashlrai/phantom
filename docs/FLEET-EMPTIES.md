# Empty job reasons

Run `phm fleet empties` for JSON, or `phm fleet empties --human` for a short table and the top five families by empty launches. `--since 24h` selects a trailing window (default 24 hours, maximum 2160); `--jobs <jobs.jsonl>` selects a metrics file. `--runs-dir <directory>` sets the default ledger and result-notes root (default `~/.ashlr-runs`).

`fleet.empties.v2` includes every EMPTY finish, family/lane counts, `byCause`, and `topFamilies`. A family is the job ID without trailing digits. `--json` remains accepted. MCP `fleet_empties` returns the same report with optional `hours`, no paths. Its existing 64 KiB limit applies; use fewer hours or the CLI for large windows.

| Cause | Required evidence |
| --- | --- |
| `already-done-on-main` | An exact cause value or a full line such as `Already merged into main.` (also master) |
| `needed-gh-or-network` | An exact cause value or a full line such as `gh not logged in`, `gh: command not found`, or `Network unavailable.` |
| `refused-by-precheck` | An exact cause value or a full line such as `Precheck refused the job.` |
| `too-fast-to-have-worked` | A nonnegative measured duration under 60 seconds, with no conflicting or more specific cause |
| `scope-unclear` | An exact cause value or a full line such as `Scope was unclear.` |
| `unknown` | Missing, conflicting, or unsupported evidence; generic `no candidate` is insufficient |

Evidence comes from metrics `cause`/`reason` or an explicit `notes_path`/`notesPath` on the finish or its launch. Lines may start with `Cause:`, `Empty cause:`, or `Reason:`. Only complete lines within the first 2,999 characters of a regular file up to 12,000 bytes are considered. Paths resolve inside the runs directory; missing, oversized, symlinked or escaping paths are counted in `notesMissing`. Notes and paths are never emitted; logs and prompts are not read. Fleet vitals keeps its legacy log diagnostic.

Finishes are selected by timestamp; launches before the window can supply duration and lane. Repeated launches stay separate; exact duplicates are ignored. Outcome-only EMPTY records are used when no finish exists. A successful publish URL in the same attempt conflicts with EMPTY cause evidence and yields `unknown`. `wall_s` supplies duration, otherwise a unique launch/finish pair. The under-60 label describes timing, not a proven root cause.

`emptyRate` is EMPTY finishes divided by finishes with explicit empty/nonempty evidence (or a single finish with a recorded publish URL), also exposed as `measured`; no measurements means null. `launches` counts launches inside the window separately. `finished` includes unmeasured finishes. Malformed rows are counted and skipped, so counts cover observed valid evidence. Unreadable or oversized metrics (64 MiB maximum) return `known:false`, null totals and CLI exit 1; an empty readable window returns zero totals and exit 0. JSON keys and ranking ties have stable order. Invalid arguments exit 2.
