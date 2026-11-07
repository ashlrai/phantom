# Examples

Source-level examples for Phantom. Each entry is a self-contained recipe that
does not activate a resident, contact providers, or execute untrusted message
bodies.

| Entry | What it shows |
|---|---|
| [agent-bus](agent-bus) | Fake worker bus roundtrip using Phantom's durable inbox functions with cursor-based reads and fixed IDs for idempotent retry. |
| [agents](agents) | Agent lifecycle examples: inbox, job, queue, graph, and harness patterns. |
| [bus-consumer-restart.ts](bus-consumer-restart.ts) | One bounded, restartable pass over a private bus workspace with a durable checkpoint; crash-safe replay, no polling or timers. |
| [channel-context-roundtrip.ts](channel-context-roundtrip.ts) | Local-only channel context roundtrip simulation with fixed identity fixtures and transport-evidence rejection. |
| [channel-host.ts](channel-host.ts) | Channel receiver host wiring across desktop, telegram, and email transports. |
| [context-budget-selection.ts](context-budget-selection.ts) | Selects a context pack budget before dispatch and prints one JSON selection; never dispatches work. |
| [dispatch-manifest-evidence.ts](dispatch-manifest-evidence.ts) | Reads dispatch intent evidence from a private manifest-events directory with a bounded scan. |
| [harness-refresh](harness-refresh) | Offline harness refresh worklist: turns a local harness digest into a review queue. |
| [leader-model-tiers.json](leader-model-tiers.json) | Example `foundry` block of leader model tier preferences (elite, workhorse, fast, local). |
| [node-pool](node-pool) | Small-Mac join commands and credential-free shared Phantom connector metadata. |
| [plugins](plugins) | Plugins example: backlog-scanner and org-scaffold. |
| [quickstart.md](quickstart.md) | Quickstart — end-to-end walk-through (fresh clone to dry-run preview in five steps). |
| [skill-calibration-export.ts](skill-calibration-export.ts) | Exports a canonical skill-routing calibration snapshot keyed by a separately managed 32-byte key. |
| [universe-site](universe-site) | Universe site showcase: the source repository's offline replica site data. |
| [upgrade](upgrade) | Upgrade audit recipes: channel, graph, inbox, queue, and worker evidence patterns. |
| [usage-motion-incident.ts](usage-motion-incident.ts) | Correlates one usage audit with a local worker process snapshot into a JSON incident report. |
