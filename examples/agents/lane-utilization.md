# Lane capacity report from runs history

From the repository root, query retained runs history for a time window and
report observed lane capacity as versioned JSON:

```sh
npx tsx examples/agents/lane-utilization.ts --hours 24 --lane "us-east-1a"
```

`--hours` is required (integer 1–168). `--lane` is optional: when omitted the
report emits one lane object per lane found in the history window.

The single JSON object on stdout has `schema` (`"phantom.lane-utilization.v1"`),
`from`, `to`, `generatedAt`, `hours`, `maxGapSeconds` (300), `sourceState`,
`dropped`, `sampleCount`, and a `lanes` array.  Each lane object lists
`coveredSeconds`, `unknownSeconds`, `occupiedSlotSeconds`, `targetSlotSeconds`,
`dispatchableSpareSlotSeconds`, `heldSeconds`, `pausedSeconds`, and
`pauseUnknownSeconds`.  Exit codes: `0` ok, `2` invalid arguments, `1`
unavailable history.
