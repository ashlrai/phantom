# Human-parity capability audit

`phm fleet capability-audit` prints a ranked matrix of what a human can do on
this Mac versus what fleet agents can do today through Phantom — apps control,
desktopctl / computer-use, browser, files, shell, GUI grants, comms and the
tool mesh.

```sh
phm fleet capability-audit --json
phm fleet capability-audit
```

Read-only: the command starts no process and grants no authority. Each surface
carries a status (`parity`, `partial`, `gap`, `deferred`, `gates-held`) and,
when it is a gap to close, a leverage rank (10 = close first among safe work).

## What “implementable now” means

Gaps marked implementable are GATES-safe: they do not automate TCC, widen
workflow permissions, touch `~/.codex` auth, print secrets, or open a new
outbound send / `connectors run` path. Those stay `deferred` or `gates-held`
until a Security-reviewed change lands.

## Top leverage (current)

| Leverage | Id | Domain | Notes |
| --- | --- | --- | --- |
| 10 | `apps-open-focus` | apps | Host `/usr/bin/open -b` launcher on macOS for allowlisted open/focus |
| 8 | `desktopctl-browser-run` | browser | Act via Phantom Browser pane, not `desktopctl run browser` |
| 7 | `comms-drafts-send` | comms | Deferred: approve ≠ send |
| 6 | `comms-imessage-ack` | comms | Deferred: RQ-IMSG-REPLY-1 |
| 5 | `tool-mesh-run` | tool-mesh | Deferred: connectors run Security review |
| 4 | `browser-task-apply` | browser | Inbox apply when a desktop chat is connected |

The schema is `capability-audit.v1` in
`src/core/fleet/capability-audit.ts`. Update that catalog when a surface
gains or loses agent reach; the CLI is a projection of the same data.
