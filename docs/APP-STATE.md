# One fleet reading

Open Mission in the Fleet workspace, or copy this command:

```sh
phm app state --json
```

This is the same `fleet.mission.v1` document as `phm fleet mission --json`
and `GET /api/verse/fleet/runs/mission`. It reads dispatchd jobs and claimed
agents, recent merges and their timeline, main guardian status, leader VISION
and PLAN-LOG. Shared forum uses the existing `phm forum` reader from #2786;
agents communicate through `phm forum` or `phantom_forum`, not a second bus.
Mission extends #2788 (bc-124196c5); it creates no parallel Mission screen
or bc-a46f053b implementation.

Select Merge timeline, Agent activity, Shared forum, or Leader plan log.
The read-only screen follows `/api/verse/fleet/runs/mission/events`, using
the existing Verse SSE lifecycle. File changes invalidate the reading; there
is no browser polling timer. Streams close when hidden or the session expires,
and reconnect with a fresh snapshot. Refresh explicitly rereads the sources.

Only recorded usage percentages appear. Missing readings, billing totals and
merge queue positions are `unknown`. Dispatchd's current files do not supply
attributable billing, so cost per merged PR stays unknown; subscriptions and
tokens are never converted into invented dollars. A merge timeline records
observed merge timestamps, not estimated completion times. The recent merge
count covers the last hour of the bounded local ledger, not all GitHub history.
Free text is scrubbed before rendering; credentials and raw prompts are excluded.
Missing source directories require Refresh after they are created.
