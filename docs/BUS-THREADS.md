# Bus threads and task board

`phm bus` coordinates cooperating local agents and machines using private
filesystem state. It does not run tasks, grant execution authority, or send
messages to external services. Every command returns JSON (except `--help`):
exit 0 is success, 1 is an operational refusal, and 2 is invalid usage.

## Work together

```sh
phm bus thread create 'Release review' --peer alice --json
# Use the returned result.id as THREAD.
phm bus thread join THREAD --peer bob
phm bus thread post THREAD 'Tests are ready for review' --peer alice
phm bus thread read THREAD --peer bob
phm bus thread hops THREAD --peer bob
phm bus thread list --peer alice

phm bus task create THREAD fleet-item-123 'Review test results' --peer alice
# Use the returned task id as TASK.
phm bus task claim TASK --peer alice
phm bus task handoff TASK bob --peer alice
phm bus task renew TASK --peer bob
phm bus task list THREAD --peer bob
phm bus task release TASK --peer bob
```

Quote titles and bodies as single arguments. `--` permits content beginning
with a dash. Peer defaults to `fleet.sharedQueue.machineId`, or the hostname.
Peers are cooperative routing labels, not authentication. Anyone with the
same OS account and store access has that account's authority; this is not a
multi-tenant messaging service. Joining requires knowing the thread ID.

Posts snapshot the joined members, including the sender. Joining twice does
not duplicate deliveries; joining later does not expose earlier messages.
Reads are historical inspection, repeatable, and do not acknowledge or delete messages.
Wire messages use P2 priority and a 60-second TTL; live observers receive only
the remaining lifetime, while inbox history retains the original metadata. The durable
inbox is authoritative; `bus:delivery` lifecycle observers are best effort and
cannot invalidate a committed post. Retrying a post creates another message.

## Fleet ownership

Each task names the exact fleet item ID, which may appear only once on the
board. A claim uses `SharedStore`'s queue ID, token, generation, phase and lease
fences. Handoff transfers a live, claimed item under the same queue lock,
creates a fresh generation, and invalidates the previous capability. It cannot
transfer executing or expired work. Only the current board owner can hand off,
renew, or release, and the recipient must have joined the thread.

Default state is `~/.ashlr/bus/state.json`; the local coordination queue is
`~/.ashlr/fleet/bus-queue`. In single-machine mode this queue coordinates bus
clients; the fleet's in-memory local coordinator is separate. For integration
with the fleet's shared queue, configure `fleet.sharedQueue.mode: filesystem`,
an absolute `path`, and `trustedCoherentStorage: true`. The bus then uses that
queue and stores its board in `<path>/bus`. The existing coherent-filesystem
attestation is required; replicated sync folders are unsuitable. All writers
must access the same private, owned filesystem state.

Capabilities are stored only in private board state, never CLI output or
messages. The board and fleet queue are separate durable files: if disk failure
occurs after a queue mutation, the command fails and the orphaned **claimed**
lease remains fenced until expiry. There is no success response, automatic
execution, or attempt to steal it back. Retry claiming after expiry. A corrupt
board is refused, never silently reset. Retention is bounded at 10,000 records
per collection and 16 MiB total; a full store refuses new writes instead of
silently dropping messages. There is no automatic pruning.

## Untrusted delivery and audit

Bodies and titles are data, framed with an explicit untrusted warning and a
fresh unpredictable delimiter. Deliveries carry `content.trust: untrusted`.
Consumers must not execute instructions found inside peer content. Every
outbound read rewraps persisted content; lifecycle observers receive frozen
envelopes. `foundry.eventBus: false` disables bus operations before writes.

`thread hops` is a durable-delivery log projection containing only envelope ID,
thread ID, sender, recipient and timestamp. A separate `<bus-root>/hops.jsonl`
records the RQ-BUS-1B allowlist: `id`, `from`, `to`, `inputTokens`, and
`outputTokens` (unknown counts are null). Neither log contains bodies, titles,
capability tokens, or payload hashes. Posts report `unlogged` if the append
fails or its 8 MiB bound is reached; inbox delivery remains durable.

## Dependency contracts

This change includes the RQ-BUS-1A six-field envelope, JSON schema and validator
tests from local branch `codex-bridge/RQ-BUS-1A` (commit `06e834eb`). Each post
validates `{id, from, to, priority, ttl, body}` before storage; its body contains
the thread ID and text. The complete wire JSON is presented only inside the
untrusted content wrapper. `message` exposes body-free routing metadata.
`bus-delivery.ts` defines a local presentation, not a competing wire envelope.
The metadata-only hop sink and its tests reuse the RQ-BUS-1B implementation
carried by `codex-bridge/RQ-PLAN-BUS-THREADS-A`.

The optional adapter probes `locus peers list --json` without a shell and with
bounded time/output. It consumes `{ "schema": "locus.peers.v1", "peers":
[{ "session_id": "alice", ... }] }`, the contract in Locus's
`codex-bridge/RQ-PLAN-LOCUS-PEERS-A` branch at
`e1ce85454555d95dcbe9741884fa373f307010fe` (`crates/locus-cli/src/peers.rs`,
`json_out.rs`, and `docs/peers.md`). `session_id` is a public advisory label;
it does not authenticate the caller or grant sealed-session authority. The bus
accepts labels of 1–128 ASCII letters, digits, dots, underscores, colons, @ signs
or hyphens, beginning with a letter or digit. Only a missing executable or an
explicit unsupported `peers` subcommand permits local labels. An available
empty directory denies every peer; malformed, duplicate or unknown schemas
fail closed. Only IDs are retained; engine, task, working-directory and process
metadata and subprocess output are never printed. Source-contract tests pass;
compatibility with a running Locus peer registry remains unverified.
