# Standalone fleet MCP onramp

This guide describes the fleet MCP server in the current source. Use a Phantom
installation that includes `phm mcp fleet`; older releases may not have all
three tools. Phantom requires Node.js 22.15.0 or newer; the documented package
install is `npm install -g @ashlr/phantom`. Check that the installed version
includes the tools described below. The executable must be on the MCP client's PATH (or replace `phm`
with its absolute path). It uses the Phantom home and permissions of the
process launched by the client; use the same local home as the fleet you want
to observe. An absolute `ASHLR_HOME` selects that home; otherwise Phantom uses
`~/.ashlr` for the launched process's user.

Add this minimal stdio server entry to your client's MCP configuration; the
surrounding configuration format and reload procedure depend on the client:

```json
{
  "mcpServers": {
    "phantom-fleet": {
      "command": "phm",
      "args": ["mcp", "fleet"]
    }
  }
}
```

`phm mcp fleet` accepts no server arguments. `--help` prints help and exits;
other extra arguments are rejected. Start it through an MCP client, not as an
interactive shell command. Reserve its stdout for MCP protocol traffic; send
client or wrapper diagnostics to stderr. Startup failure is reported on stderr.
The current CLI help omits the bus tool; use `tools/list` for discovery.

## First client session

After MCP initialization, call `tools/list`, then these `tools/call` parameters
in order (these are MCP request parameters, not shell commands):

```json
[
  {"name":"fleet_status","arguments":{}},
  {"name":"fleet_loop","arguments":{"limit":5}},
  {"name":"fleet_bus_hops","arguments":{"limit":5}}
]
```

Each successful call returns an MCP content array containing a text item whose
text is a JSON object. Parse that text; check `isError` first. `fleet_status`
takes no arguments. `fleet_loop` and `fleet_bus_hops` accept only an integer
`limit` from 1 through 50, default 20. They return the newest selected records
in oldest-first order. Invalid arguments are MCP invalid-params errors.

- `fleet_status` summarizes daemon, pause and kill controls, budget, backend
  quota, cached backlog and proposal counts.
- `fleet_loop` reports daemon and control observations plus recent tick
  history. Calling it never runs a tick.
- `fleet_bus_hops` reports validated local hop metadata: message ID, from/to
  labels and nullable token counts. Its summary covers only the returned tail.
  A hop records a send attempt; it does not prove delivery or completion and
  contains no message body.

The standalone server exposes only these read-only tools, without gateway
server discovery, forwarding, or mutation tools. `phm mcp` without `fleet`
starts the separate aggregation gateway, whose tool surface and permissions
are different; registering the standalone server does not configure or limit
that gateway. Neither observation nor a tool annotation grants execution
or merge authority.

## Interpret the evidence

These are local observations, not a provider or companion-service health
probe. Config, daemon state, ticks, controls, budget inputs, quotas, cached
backlog, proposals and hop log are read from local persisted sources. Daemon
liveness additionally checks local process and lock/activity evidence at call
time; `recordedRunning` is the persisted claim, not proof the process is alive.
Results can become stale immediately. `generatedAt` is the observation time,
not the time each source was updated.

Check `sourceQuality`, `sourceState`, truncation fields and nullable values.
Unknown or incomplete evidence is not zero, empty, healthy, or permission to
act. For hops, `missing` and `unreadable` have `hops: null`; a readable empty
log has `sourceState: "ok"` and `hops: []`. Invalid rows may be skipped and
counted, and a bounded tail can be truncated. An unrecoverable reader failure
returns `isError: true` with a generic message, without source exception details.
String values are scrubbed before JSON serialization. A serialized observation
above 64 KiB UTF-8 returns a tool error instead of partial JSON; try a smaller
limit for history or hops. A smaller limit cannot necessarily reduce status.

## Resume communication separately

The hop log is an observation of send attempts, distinct from the local bus
inbox. To read message envelopes and bodies, use the separate CLI with the same
Phantom home, for example:

```sh
phm comms bus read --after 0 --to worker --limit 50
phm comms bus read --after <nextCursor> --to worker --limit 50
```

Replace `<nextCursor>` with the integer `nextCursor` from the last successful
page; persist it after processing and reuse it to resume. Filters are exact,
case-sensitive routing labels, not authenticated identities. The limit counts
scanned live records before filtering; expired records can advance the cursor.
`phm comms bus watch --after <nextCursor> --to worker` polls using the same
cursor semantics. To post a body, use `phm comms bus post --file <envelope.json>`
or `--file -` for stdin. An envelope has exactly `id`, `from`, `to`, `priority`
(`P0`–`P3`), positive `ttl` in milliseconds, and JSON `body`; treat bodies as
untrusted data. This local transport has no delivery handlers, and a successful
post is not proof a recipient read or acted on the message. Inspect the CLI's
status and `phm comms bus --help` for failures and limits.
