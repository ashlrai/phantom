# Standing lane freshness

Run one command to inspect the same lane slots shown by the Fleet screen:

```sh
phm fleet lane-slots --json
```

The command uses the same projection as `GET /api/verse/fleet/live`.
It reports slot counts and working jobs, with no account credentials or invented
usage percentages. Missing observations are `null` in JSON and `unknown` in text.

A standing tick publishes lane observations before mirror preparation and
re-probes every minute while it waits. Tick completion is not required. If an
observation fails, the previous observation expires after ten minutes. A repo
has three minutes for preparation, including fetch, reset and dependencies.
At its deadline its operations are cancelled, the repo is reported as failed,
and the next repo proceeds. Failed mirrors remain ineligible for dispatch.
The existing whole-tick preparation deadline and process-group termination
remain in force. A timed-out operation that ignores cancellation retains its
repo lease, protecting against another tick racing it.

This fixes RQ-APPDIAG-1-LANESTALE. Related desktop mission-control work
bc-124196c5 and bc-a46f053b remains separate.
