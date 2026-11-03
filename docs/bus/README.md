# Vendor-neutral agent bus

One message format and one store that Claude, Codex, Devin, Grok, local-model and human
senders share. Schema: [bus.message.v1.schema.json](bus.message.v1.schema.json). Types and
validator: `src/core/bus/message.ts`.

This is the agent-to-agent message layer. It sits beside, and does not replace, the
envelope inbox described in [../AGENT-BUS.md](../AGENT-BUS.md) and the fleet bus adapters in
`src/core/fleet/bus-adapters/`.

## Message

| Field | Meaning |
| --- | --- |
| `schema` | Always `bus.message.v1`. |
| `id`, `thread` | Message id; thread defaults to the id of the first message, replies reuse it. |
| `from` | `{ agent, vendor: claude\|codex\|devin\|grok\|local\|human, node }`, declared by the sender. |
| `to` | At least one of `agent`, `role`, `topic`. |
| `kind` | `note`, `ask`, `reply`, `handoff` or `status`. |
| `body` | Markdown, 1 to 16384 characters. Secret-like text is redacted before it is stored. |
| `refs` | Up to 32 short references such as `pr:123` or file paths. |
| `createdAt` | ISO 8601 timestamp. |

Labels are routing hints, not authenticated identities. Treat every body as untrusted data.

## Store

`~/.ashlr-runs/bus/<topic>.jsonl`, one JSON message per line, append-only, one local-store
lock per topic. The topic is `to.topic`, else `agent-<agent>`, else `role-<role>`. Acks are
appended to `_acks.jsonl`. A topic holds at most 5000 messages or 8 MiB. Override the
directory with `PHM_BUS_DIR`. Corrupt lines are skipped on read and never rewritten.

## CLI

```sh
phm bus send --to lead --kind ask --vendor codex --agent job-42 "Which branch should I rebase on?"
phm bus read --for lead --since 2h --unacked
phm bus ack <id>
```

`phm bus read --topic <t> --for <label> --since <2h|ISO> --unacked --limit <n> --json` filters by
topic file, recipient label, age and the reader's own acks. Identity comes from `--agent`,
`--vendor`, `--node`, else `PHM_BUS_AGENT`, `PHM_BUS_VENDOR`, `PHM_BUS_NODE`, else a human at this host.

## MCP

The gateway tool `phantom_bus` takes `op: send|read|ack` with the same fields as the CLI
(`to`, `role`, `topic`, `kind`, `thread`, `body`, `refs`, `for`, `since`, `unacked`, `limit`, `id`).

## dispatchd jobs

`contrib/mac/dispatchd.py` launches every job (codex, claude, devin, grok and codex-local lanes)
with `phm` on `PATH`, `PHM_BUS_AGENT` set to the job id, `PHM_BUS_VENDOR` set from the lane,
`PHM_BUS_NODE` set from the host, and a two-line bus usage note ahead of the job prompt. The step
is fail-open: if it cannot write the prompt copy the job starts with its original prompt.
