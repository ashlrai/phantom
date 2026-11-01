# Console Notifications

Every notification the Phantom desktop console bell can raise, what it means,
and which pane it opens.  Id prefixes are listed so agents can distinguish
a warning from noise across the six derivation sources.

The bell icon opens a stacked attention queue.  Notifications are sorted
**worst-first** (critical > high > medium > low > info) and then by age.
They live until acknowledged, retired, or aged out of the recent window.
Multiple notifications with the same id prefix for the same runtime key
are deduplicated — a fresh incident gets a fresh entry, the same one
updates in place.  The notification centre (the full scrollable list)
provides detail; clicking a notification navigates to its target pane.

| # | Id prefix | Severity | When it fires | Opens |
|---|-----------|----------|---------------|-------|
| 1 | `daemon-health-degraded` | high / medium | Daemon source quality is degraded or missing. | Control ▸ Daemon |
| 2 | `next-action-*` | varies (action priority) | A fleet priority action is waiting. | Control ▸ Daemon / Fleet / Security |
| 3 | `proposal-backlog` | high / medium | Pending proposals exceed the age threshold. | Inbox |
| 4 | `readiness-blocked-*` | varies (blocker severity) | Autonomous readiness verdict is blocked. | Control ▸ Fleet |
| 5 | `readiness-unknown` | medium | Autonomous readiness verdict is unknown. | Control ▸ Fleet |
| 6 | `run-failed-*` | high | A run finished with status failed or aborted (recent). | Work ▸ Runs |
| 7 | `run-stalled-*` | medium | A running run has not updated in 3 minutes. | Work ▸ Runs |
| 8 | `security-critical` | critical | One or more critical security findings exist. | Control ▸ Security |
| 9 | `security-high` | high | No critical but high security findings exist. | Control ▸ Security |
| 10 | `budget-over-*` | high | A backend is over its usage limit. | Control ▸ Daemon |
| 11 | `budget-warn-*` | medium | A backend is approaching its usage limit. | Control ▸ Daemon |
| 12 | `fleet-stall` | critical | Fleet has not started or merged for 30 minutes. | Fleet ▸ Lanes |
| 13 | `fleet-switches-on` | high | A HOLD switch file is stopping dispatch. | Fleet ▸ Lanes |
| 14 | `fleet-runs-dir-missing` | critical | Fleet runs directory is missing. | Fleet ▸ Host |
| 15 | `fleet-host-pressure` | critical / high | Disk < 10 GB or memory < 5 % (critical). Otherwise high. | Fleet ▸ Host |
| 16 | `fleet-claude-lane-down` | high | Claude lane state is down / rejected / invalid. | Fleet ▸ Host |
| 17 | `fleet-lane-usage-*` | high | A lane is out of usage (quota / rate limit). | Fleet ▸ Lanes |
| 18 | `fleet-lane-held-*` | medium | A lane is held for a non-usage reason. | Fleet ▸ Lanes |
| 19 | `fleet-lane-idle-*` | low | A lane has queued jobs but nothing is running. | Fleet ▸ Lanes |
| 20 | `fleet-lane-dead-*` | high | A lane is producing empty results (dead signal). | Fleet ▸ Usage |
| 21 | `fleet-drop-pending` | info | Leader job files are waiting for ingest. | Fleet ▸ Leader Journal |
| 22 | `fleet-inbox-read:*` | critical | A message was read by the latest leader pass. | Fleet ▸ Inbox |
| 23 | `fleet-inbox-overdue:*` | medium | A message has waited for a leader pass. | Fleet ▸ Inbox |
| 24 | `fleet-release-blocked:*` | high / medium | A release PR is blocked (urgent → high, else medium). | Fleet ▸ Releases |
| 25 | `fleet-release:*` | high | A release PR merged (version bump). | Settings ▸ Updates |
| 26 | `fleet-merge:*` | info | An individual PR merged. | (PR link or Fleet ▸ Merges) |
| 27 | `fleet-merge:rollup:*` | info | More than 5 PRs merged in the last hour. | Fleet ▸ Merges |
| 28 | `update-ready:*` | high | A new update (native or server) is ready to install. | Settings ▸ Updates |
| 29 | `update-held:*` | high | An update is staged but held by policy. | Settings ▸ Updates |
| 30 | `update-failed:*` | critical | Applying an update failed or was refused. | Settings ▸ Updates |
| 31 | `update-applied:*` | info | An update was recently applied (within 24 h). | (Updates row) |
| 32 | `update-restart-needed:*` | high | Phantom was updated but needs a restart. | Settings ▸ Updates |
