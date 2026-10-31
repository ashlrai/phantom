# Phantom console panes

Every tab in the desktop console's dock is a pane registered from a `*.pane.tsx` file under `src/web-ui/routes/verse/`; open one from the command palette ("Open pane: <title>"), the dock's "Add a pane" menu, or its keyboard chord where one is listed.

| Id | Title | Chord | Source file |
| --- | --- | --- | --- |
| `checks` | Checks | — | `src/web-ui/routes/verse/agents/checks.pane.tsx` |
| `computer` | Computer use | — | `src/web-ui/routes/verse/computer/computer.pane.tsx` |
| `fleet-brief` | Fleet brief | `mod+alt+f` | `src/web-ui/routes/verse/fleet-brief/fleet-brief.pane.tsx` |
| `fleet-bus` | Bus | `mod+alt+b` | `src/web-ui/routes/verse/fleet-bus/fleet-bus.pane.tsx` |
| `fleet-bus-map` | Bus map | — | `src/web-ui/routes/verse/fleet-bus-map/fleet-bus-map.pane.tsx` |
| `fleet-capacity` | Capacity | — | `src/web-ui/routes/verse/fleet-capacity/fleet-capacity.pane.tsx` |
| `fleet-channels` | Channels | — | `src/web-ui/routes/verse/fleet-channels/fleet-channels.pane.tsx` |
| `fleet-decisions` | Decisions | — | `src/web-ui/routes/verse/fleet-decisions/fleet-decisions.pane.tsx` |
| `fleet-dispatch` | Dispatch | — | `src/web-ui/routes/verse/fleet-dispatch/fleet-dispatch.pane.tsx` |
| `fleet-events` | Fleet events | `mod+alt+e` | `src/web-ui/routes/verse/fleet-events/fleet-events.pane.tsx` |
| `fleet-experiments` | Experiments | — | `src/web-ui/routes/verse/fleet-experiments/fleet-experiments.pane.tsx` |
| `fleet-graph` | Graph | — | `src/web-ui/routes/verse/fleet-graph/fleet-graph.pane.tsx` |
| `fleet-host` | Mac host | `mod+alt+h` | `src/web-ui/routes/verse/fleet-host/fleet-host.pane.tsx` |
| `fleet-hub` | Fleet | `mod+alt+g` | `src/web-ui/routes/verse/fleet-hub/fleet-hub.pane.tsx` |
| `fleet-inbox` | Leaders' inbox | `mod+alt+i` | `src/web-ui/routes/verse/fleet-inbox/fleet-inbox.pane.tsx` |
| `fleet-lanes` | Lanes | `mod+alt+n` | `src/web-ui/routes/verse/fleet-lanes/fleet-lanes.pane.tsx` |
| `fleet-merges` | Merges | `mod+alt+o` | `src/web-ui/routes/verse/fleet-merges/fleet-merges.pane.tsx` |
| `fleet-outcomes` | Outcomes | — | `src/web-ui/routes/verse/fleet-outcomes/fleet-outcomes.pane.tsx` |
| `fleet-queue` | Queue | `mod+alt+q` | `src/web-ui/routes/verse/fleet-queue/fleet-queue.pane.tsx` |
| `fleet-releases` | Releases | — | `src/web-ui/routes/verse/fleet-releases/fleet-releases.pane.tsx` |
| `fleet-steering` | Steering | — | `src/web-ui/routes/verse/fleet-steering/fleet-steering.pane.tsx` |
| `fleet-supply` | Supply | `mod+alt+u` | `src/web-ui/routes/verse/fleet-supply/fleet-supply.pane.tsx` |
| `fleet-timeline` | Worker timeline | `mod+alt+t` | `src/web-ui/routes/verse/fleet-timeline/fleet-timeline.pane.tsx` |
| `fleet-usage` | Usage | — | `src/web-ui/routes/verse/fleet-usage/fleet-usage.pane.tsx` |
| `leader-journal` | Leader journal | `mod+alt+j` | `src/web-ui/routes/verse/leader-journal/leader-journal.pane.tsx` |
| `leader-thread` | Leaders | `mod+alt+l` | `src/web-ui/routes/verse/leader-thread/leader-thread.pane.tsx` |
| `reasoning` | Reasoning | — | `src/web-ui/routes/verse/reasoning/reasoning.pane.tsx` |
| `sources` | Sources | — | `src/web-ui/routes/verse/reasoning/sources.pane.tsx` |
| `terminal` | Terminal | — | `src/web-ui/routes/verse/terminal/terminal.pane.tsx` |
| `worker-log` | Worker log | — | `src/web-ui/routes/verse/fleet-job-log/fleet-job-log.pane.tsx` |

## Adding a pane

See `src/web-ui/routes/verse/panes/README.md` for how to register a new pane without touching the layout.
