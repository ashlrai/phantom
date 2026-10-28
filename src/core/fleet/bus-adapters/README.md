# Codex bus adapter

`runCodexBusAdapter(ports, options)` drains a host-owned inbox until `receive()`
returns `null`. The host supplies Locus peer registration, inbox/outbox transport,
and router accounting capabilities; importing the module performs no I/O.
Registration must succeed before any message is consumed. Messages run serially,
and presence is removed on completion or failure.

The inbox shape is `{ id, from, body }`. Replies carry `{ inReplyTo, to, from,
status, body }`. The router receives the message and peer IDs, `codex-personal`
pool, `work` tier, completion status, and native token counts. Missing or invalid
counts are `null`, not zero. Only a successful native turn with an agent reply
produces a completed outbox message. Native diagnostics are not sent to peers.

The host must supply durable inbox acknowledgement and idempotent accounting and
outbox writes keyed by message ID. Accounting precedes delivery so a transport
failure cannot hide engine spend. A rejected transport operation rejects the
worker; the host decides retry policy. This adapter does not promise exactly-once
engine execution across crashes.

`executable` defaults to `codex`; `launcherArgs` supports a trusted, provisioned
launcher (for example a Phantom Secrets `phantom exec` wrapper). Credentials must
be provisioned through that broker, never by copying the user's auth file or
forwarding ambient tokens. Each invocation gets a private temporary HOME and
CODEX_HOME, deleted after the child closes. The adapter does not discover, read,
copy, or write the user's Codex auth. Without provisioned broker access, the CLI
fails closed. No live provider is invoked by the test suite.

The host owns the trusted working directory and launch configuration. Inbox data
cannot select either, set environment variables, supply CLI flags, or grant tool
access. Tool provisioning belongs to Locus. The CLI runs with a read-only sandbox;
JSON framing and developer instructions mark inbox fields as untrusted data, but
prompt framing itself is not an execution security boundary.

RQ-BUS-3A is not present in this checkout. The exported structural port types are
the explicit integration boundary; wire compatibility with an external RQ-BUS-3A
implementation must be checked when that contract is available.

CLI reference: https://learn.chatgpt.com/docs/non-interactive-mode
