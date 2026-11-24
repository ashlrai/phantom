# Run the fleet from Phantom

Open **Home**, find the work in **Map** or **Work log**, steer one job, then
check **Autonomy** in Fleet. This guide describes the source checkout; an older
installed app may differ. Use `phm help --all` to check available commands.

The JSON below contains **made-up values and selected fields**, not live fleet
readings. Missing evidence stays `unknown` or `null`, in the shape each command
returns. A missing source is not an empty fleet.

## 1. Open Phantom and read Home

Open the desktop app and select **Home**. If it restores another saved view,
select **Home** again to see the summary. For browser setup, follow the
[Quickstart](QUICKSTART.md#open-verse). Home answers: is work moving, is main
healthy, and what needs attention? Read the headline, merges in the last hour
and day, median time to merge, running jobs, allowance at risk of expiring,
recent work and unread Leader replies.

```sh
phm home --json
```

```json
{
  "schema": "home.v1",
  "health": "unknown",
  "mergedLastHour": { "state": "ok", "value": 3 },
  "main": { "state": "unknown", "reason": "The main guardian status could not be read." },
  "unreadLeaderReplies": { "state": "unknown", "reason": "No last-read time was given, so replies cannot be counted as unread." }
}
```

To count unread replies in the CLI, add `--leader-seen 2026-11-17T09:00:00Z`,
using the time you last read the thread. Without it, that count is unknown.

## 2. Find the job in Map or Work log

Press **⌘K**, type **Map** and choose **Open pane: Map** to see the Leader,
lanes, jobs, computers and resources together.
Select a job to open its **Worker log**. Lines show reporting, placement,
resource use and messages in the last 15 minutes; missing facts appear in notes.

```sh
phm map --json
```

```json
{
  "schema": "fleet.live-map.v1",
  "windowMinutes": 15,
  "counts": { "lanes": 2, "jobs": 1, "computers": 1, "resources": 2, "messages": null },
  "gaps": ["Messages unknown: the agent bus could not be read."]
}
```

For history, choose **Open Work log** on Home. Filter by kind, repository or
lane, then expand a row to read its detail. The CLI's `--hours` selects the time
window. Work log is read-only; use Map to open a running job's controls.

```sh
phm worklog --hours 6 --kind launched --json
```

```json
{
  "schema": "worklog.v3",
  "hours": 6,
  "rows": [{ "at": "2026-11-17T12:00:00.000Z", "kind": "launched", "job": "RQ-EXAMPLE", "lane": "claude", "repo": "sample-project", "text": "Launched", "url": null, "count": 1 }],
  "sources": { "jobs": { "state": "ok" }, "events": { "state": "ok" }, "leader": { "state": "unknown", "reason": "Leader replies unavailable." } }
}
```

If placement is unclear, select a computer on Map to open **Computers**.
Check reachability, Phantom status, free memory, available lanes and job claims.

```sh
phm nodes --can-take claude --json
```

```json
{
  "schemaVersion": 1,
  "canTake": "claude",
  "nodes": [{ "name": "computer-a", "phantom": "running", "freeSlots": 1, "stateCode": "ready" }]
}
```

Here `computer-a` is an invented name. Omit `--can-take` to see all known
computers and their reasons; unmeasured node fields use the string `"unknown"`.

## 3. Steer one job and read the receipt

In **Worker log**, use **Pause**, **Resume**, **Stop** or **Move to…** for the
selected job. Stop asks for confirmation. Move offers available target lanes;
held or full lanes are refused. Replace `RQ-EXAMPLE` with the job you selected.

| Action | CLI example |
| --- | --- |
| Pause | `phm job pause RQ-EXAMPLE --dry-run --json` |
| Resume after a pause request | `phm job resume RQ-EXAMPLE --dry-run --json` |
| Stop | `phm job stop RQ-EXAMPLE --dry-run --json` |
| Move to an available lane | `phm job move RQ-EXAMPLE --lane claude --dry-run --json` |

All four return the same receipt shape. For example, a pause preview:

```json
{
  "schema": "fleet.job.control.v1",
  "action": "pause", "job": "RQ-EXAMPLE", "lane": null,
  "status": "requested", "reason": null, "requestId": null,
  "at": "2026-11-17T12:00:00.000Z", "dryRun": true, "duplicate": false
}
```

`--dry-run` changes nothing, even if the predicted status is `applied`. Remove
it to submit. `requested` means recorded, `applied` means applied, `refused`
includes a reason, and `unknown` means no such job was found. Repeating a
request returns its original receipt with `duplicate: true`.

The source currently applies a running-job stop and a queued-job move directly.
Pause, resume, moving a running job and stopping a queued job record requests;
dispatcher consumption of those requests is not implemented in this checkout.
Do not read `requested` as proof that the worker changed state.

If a job is waiting to launch, inspect the proposed pacing interval:

```sh
phm admission explain --json
```

```json
{
  "schema": "phantom.admission-explain.v1",
  "readOnly": true, "enforced": false,
  "inputs": { "load1": null, "ncpu": null, "memoryFreePercent": null, "swapGrowthGb": null, "runningJobs": null, "launchesLast10Minutes": null },
  "enabled": true, "legacySeconds": 300, "settleSeconds": 300,
  "reason": "Telemetry is incomplete or stale; keep the legacy interval."
}
```

This report explains a recommendation; it does not change host pacing.


### Say something to a running job

Type into **Tell this job** under the Worker log header (or on the phone's
worker screen) and press **Send note**. From a terminal or an agent:

```bash
phm job say RQ-EXAMPLE "also update the docs" --json
phm job notes RQ-EXAMPLE --json
```

`say` returns `fleet.job.say.v1` with `status` `sent`, `refused` or `unknown`;
`notes` returns `fleet.job.notes.v1`. Each note is timestamped and appended to
`queue/job-notes.jsonl`. A worker whose runner supports steering reads new
notes between steps; every note also stays on the job and shows as **Notes
sent** in the job window. Whether a worker has read a note is not recorded.
A finished job refuses the note with a plain message.

## 4. Check Autonomy in Fleet

Open **Fleet** and read its **Autonomy** card. It measures the last 24 hours:
merges per hour, work completed without human intervention and improvements to
the fleet itself. The CLI also reports releases and main green share, which
describes current repository health, not uptime over that window. Missing actor
or file evidence stays unknown.

```sh
phm autonomy --hours 24 --json
```

```json
{
  "schema": "fleet.autonomy.v1", "windowHours": 24,
  "merged": 12, "mergedPerHour": 0.5,
  "withoutHumanShare": null, "selfImprovementShare": null,
  "releases": null, "mainGreenShare": 1
}
```

The card measures outcomes; it does not activate autonomous work. Setup is in
[Autonomy setup](AUTONOMY-SETUP.md). Return to Home for the next check.

For every command and option, see the generated [CLI reference](cli.md).
