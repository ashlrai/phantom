# Phantom console panes

Every tab in the desktop console's dock is a pane registered from a `*.pane.tsx` file under `src/web-ui/routes/verse/`; open one from the command palette ("Open pane: <title>"), the dock's "Add a pane" menu, or its keyboard chord where one is listed.

| Id | Title | Chord | Source file |
| --- | --- | --- | --- |
| `channels` | Channels | none | `src/web-ui/routes/verse/channels/channels.pane.tsx` |
| `checks` | Checks | — | `src/web-ui/routes/verse/agents/checks.pane.tsx` |
| `company` | Company | none | `src/web-ui/routes/verse/company/company.pane.tsx` |
| `computer` | Computer use | — | `src/web-ui/routes/verse/computer/computer.pane.tsx` |
| `feed` | Feed | — | `src/web-ui/routes/verse/feed/feed.pane.tsx` |
| `fleet-board` | Board | none | `src/web-ui/routes/verse/fleet-board/fleet-board.pane.tsx` |
| `fleet-bus` | Bus | `mod+alt+b` | `src/web-ui/routes/verse/fleet-bus/fleet-bus.pane.tsx` |
| `fleet-capacity` | Capacity | — | `src/web-ui/routes/verse/fleet-capacity/fleet-capacity.pane.tsx` |
| `fleet-channels` | Channels | — | `src/web-ui/routes/verse/fleet-channels/fleet-channels.pane.tsx` |
| `fleet-compute` | Fleet compute | none | `src/web-ui/routes/verse/company/compute.pane.tsx` |
| `fleet-computers` | Computers | none | `src/web-ui/routes/verse/fleet-host/computers.pane.tsx` |
| `fleet-direct` | Direct | none | `src/web-ui/routes/verse/fleet-direct/fleet-direct.pane.tsx` |
| `fleet-dispatch` | Dispatch | — | `src/web-ui/routes/verse/fleet-dispatch/fleet-dispatch.pane.tsx` |
| `fleet-events` | Fleet events | `mod+alt+e` | `src/web-ui/routes/verse/fleet-events/fleet-events.pane.tsx` |
| `fleet-inventory` | Inventory | none | `src/web-ui/routes/verse/inventory/inventory.pane.tsx` |
| `fleet-forum` | Forum | none | `src/web-ui/routes/verse/fleet-forum/fleet-forum.pane.tsx` |
| `fleet-goals` | Goals | — | `src/web-ui/routes/verse/fleet-goals/fleet-goals.pane.tsx` |
| `fleet-graph` | Graph | — | `src/web-ui/routes/verse/fleet-graph/fleet-graph.pane.tsx` |
| `fleet-host` | Mac host | `mod+alt+h` | `src/web-ui/routes/verse/fleet-host/fleet-host.pane.tsx` |
| `fleet-hub` | Fleet | `mod+alt+g` | `src/web-ui/routes/verse/fleet-hub/fleet-hub.pane.tsx` |
| `fleet-inbox` | Leaders' inbox | `mod+alt+i` | `src/web-ui/routes/verse/fleet-inbox/fleet-inbox.pane.tsx` |
| `fleet-lanes` | Lanes | `mod+alt+n` | `src/web-ui/routes/verse/fleet-lanes/fleet-lanes.pane.tsx` |
| `fleet-map` | Map | none | `src/web-ui/routes/verse/fleet-map/fleet-map.pane.tsx` |
| `fleet-merges` | Merges | `mod+alt+o` | `src/web-ui/routes/verse/fleet-merges/fleet-merges.pane.tsx` |
| `fleet-messages` | Messages | none | `src/web-ui/routes/verse/fleet-messages/fleet-messages.pane.tsx` |
| `fleet-metrics` | Metrics | — | `src/web-ui/routes/verse/fleet-metrics/fleet-metrics.pane.tsx` |
| `fleet-mission` | Mission | `mod+alt+k` | `src/web-ui/routes/verse/fleet-mission/fleet-mission.pane.tsx` |
| `fleet-observe` | Observe | `mod+alt+v` | `src/web-ui/routes/verse/fleet-observe/fleet-observe.pane.tsx` |
| `fleet-org` | Org | none | `src/web-ui/routes/verse/fleet-org/fleet-org.pane.tsx` |
| `fleet-outcomes` | Outcomes | — | `src/web-ui/routes/verse/fleet-outcomes/fleet-outcomes.pane.tsx` |
| `fleet-plugins` | Plugins | none | `src/web-ui/routes/verse/fleet-installed/fleet-installed.pane.tsx` |
| `fleet-pools` | Pools | none | `src/web-ui/routes/verse/fleet-pools/fleet-pools.pane.tsx` |
| `fleet-queue` | Queue | `mod+alt+q` | `src/web-ui/routes/verse/fleet-queue/fleet-queue.pane.tsx` |
| `fleet-releases` | Releases | — | `src/web-ui/routes/verse/fleet-releases/fleet-releases.pane.tsx` |
| `fleet-sessions` | Sessions | none | `src/web-ui/routes/verse/fleet-sessions/fleet-sessions.pane.tsx` |
| `fleet-skills` | Skills | none | `src/web-ui/routes/verse/fleet-installed/fleet-installed.pane.tsx` |
| `fleet-steer` | Steer | none | `src/web-ui/routes/verse/fleet-steer/fleet-steer.pane.tsx` |
| `fleet-steering` | Steering | — | `src/web-ui/routes/verse/fleet-steering/fleet-steering.pane.tsx` |
| `fleet-supply` | Supply | `mod+alt+u` | `src/web-ui/routes/verse/fleet-supply/fleet-supply.pane.tsx` |
| `fleet-team` | Team | none | `src/web-ui/routes/verse/fleet-team/team.pane.tsx` |
| `fleet-throughput` | Throughput | — | `src/web-ui/routes/verse/fleet-throughput/fleet-throughput.pane.tsx` |
| `fleet-timeline` | Worker timeline | `mod+alt+t` | `src/web-ui/routes/verse/fleet-timeline/fleet-timeline.pane.tsx` |
| `fleet-tools` | Tools | none | `src/web-ui/routes/verse/fleet-tools/fleet-tools.pane.tsx` |
| `fleet-usage` | Usage | — | `src/web-ui/routes/verse/fleet-usage/fleet-usage.pane.tsx` |
| `fleet-worklog` | Work log | — | `src/web-ui/routes/verse/fleet-worklog/fleet-worklog.pane.tsx` |
| `goals` | Goals | — | `src/web-ui/routes/verse/goals-pane/goals.pane.tsx` |
| `home` | Home | none | `src/web-ui/routes/verse/home/home.pane.tsx` |
| `ideas` | Ideas | — | `src/web-ui/routes/verse/ideas/ideas.pane.tsx` |
| `leader-journal` | Leader journal | `mod+alt+j` | `src/web-ui/routes/verse/leader-journal/leader-journal.pane.tsx` |
| `leader-thread` | Leaders | `mod+alt+l` | `src/web-ui/routes/verse/leader-thread/leader-thread.pane.tsx` |
| `library` | Library | — | `src/web-ui/routes/verse/library/library.pane.tsx` |
| `mason-thread` | Mason | none | `src/web-ui/routes/verse/mason-thread/mason-thread.pane.tsx` |
| `models` | Models | none | `src/web-ui/routes/verse/models/models.pane.tsx` |
| `reasoning` | Reasoning | — | `src/web-ui/routes/verse/reasoning/reasoning.pane.tsx` |
| `session-wall` | Conversations | none | `src/web-ui/routes/verse/session-wall/session-wall.pane.tsx` |
| `sources` | Sources | — | `src/web-ui/routes/verse/reasoning/sources.pane.tsx` |
| `terminal` | Terminal | — | `src/web-ui/routes/verse/terminal/terminal.pane.tsx` |
| `worker-log` | Worker log | — | `src/web-ui/routes/verse/fleet-job-log/fleet-job-log.pane.tsx` |

## Adding a pane

See `src/web-ui/routes/verse/panes/README.md` for how to register a new pane without touching the layout.
