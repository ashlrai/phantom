# Recent dispatch evidence

From the repository root, run:

```sh
npx tsx examples/agents/dispatch-recent.ts
npx tsx examples/agents/dispatch-recent.ts --kind LAUNCH
```

`--kind` accepts exactly one of `LAUNCH`, `PUBLISHED`, `PUBLISH_START`,
`PUBLISH_ABORT`, `INCIDENT`, or `LANE_HOLD`. `--help` prints usage. With no
filter, all six kinds are included. The reader uses the standard `~/.ashlr-runs`
directory; this tool does not accept a path or modify dispatch.

Success prints one compact JSON object on stdout: `generatedAt`,
`runsDirPresent`, `sourceState`, `sources`, `lastTick`, and `events`. The
per-source health values and aggregate state come directly from the reader.
`lastTick` is the status source's timestamp or `null` when unknown, not a
freshness assertion. Events come from `dispatch-events.log`, retain the reader's
newest-first ordering and `{at, kind, text}` fields, and are bounded by its
40-event limit before filtering. An empty array does not prove nothing happened,
especially when the events source is missing or degraded. A publish event is
not evidence of a merge.

Exit status is 0 for a report or help, including missing/degraded sources; check
`runsDirPresent` and `sources` before interpreting absence. Invalid arguments
exit 2. An unexpected reader failure exits 1 with a generic error on stderr.
