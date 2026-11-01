# Examples

Source-level examples for Phantom. Each entry is a self-contained recipe that
does not activate a resident, contact providers, or execute untrusted message
bodies.

| Entry | What it shows |
|---|---|
| [agent-bus](agent-bus) | Fake worker bus roundtrip using Phantom's durable inbox functions with cursor-based reads and fixed IDs for idempotent retry. |
| [agents](agents) | Agent lifecycle examples: inbox, job, queue, graph, and harness patterns. |
| [channel-host.ts](channel-host.ts) | Channel receiver host wiring across desktop, telegram, and email transports. |
| [harness-refresh](harness-refresh) | Offline harness refresh worklist: turns a local harness digest into a review queue. |
| [plugins](plugins) | Plugins example: backlog-scanner and org-scaffold. |
| [quickstart.md](quickstart.md) | Quickstart — end-to-end walk-through (fresh clone to dry-run preview in five steps). |
| [universe-site](universe-site) | Universe site showcase: the source repository's offline replica site data. |
| [upgrade](upgrade) | Upgrade audit recipes: channel, graph, inbox, queue, and worker evidence patterns. |
