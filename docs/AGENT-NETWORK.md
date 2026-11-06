# Agent network

## Join Macs over SSH

Install the same reviewed Phantom build on each Mac and configure SSH aliases
`primary-mac` and `backup-mac` for team devices on their existing network. These
explicit aliases are the device allowlist. Never add a non-team host. No network
scanning, new service or DNS change is needed.

On the designated backup:

```sh
phm node pool --role backup --node backup --owner mason --primary primary-mac --backup backup-mac --json
phm node watch --json
```

On the primary, in separate terminals for configuration and the foreground watch:

```sh
phm node pool --role primary --node primary --owner mason --primary primary-mac --backup backup-mac --json
phm node watch --json
```

Mason approves SSH trust once per device. The commands print the exact host-check
step, `ssh -o ForwardAgent=no -o StrictHostKeyChecking=ask <alias> true`, and the
public-key enrollment step, `ssh-copy-id <alias>` (requires that utility locally).
Verify fingerprints through the existing trusted device channel. No command runs
key enrollment automatically. Enable the Mac's existing SSH access manually if
needed; this code does not change Remote Login or device permissions.

Install and join another Mac in one command after Node >=22.15.0, local provider
sign-in and the approved SSH aliases are ready:

```sh
npm install -g @ashlr/phantom && phm node join --owner mason --primary primary-mac --backup backup-mac --json
```

The first join requires the two explicit aliases and owner scope; `--node` defaults
to a sanitized hostname. It does not scan for devices, approve SSH fingerprints,
install a runner or start background execution. On a configured Mac, repeat
`phm node join --json` to recheck the route and local capacity using the saved
identity. A primary or backup retains its role; repeat join never resets its witness.

Then run one bounded worker batch:

```sh
phm node join --json
phm node worker --runner /absolute/path/to/reviewed-node-runner --json
phm node list --json
phm node status --json
```

Join probes `codex login status` and `claude auth status --json` locally, retaining
only exit status. Sign in with each CLI's normal device flow on that Mac. Never
copy auth directories. Each worker batch rejoins with fresh lane observations and
launches up to its RAM slot ceiling concurrently under one node session. It waits
for every started slot to finish, then leaves; it does not refill the batch or
install a permanent supervisor. Repeat worker invocations from the host's existing
supervisor for continuous work. The node ID cannot have two live sessions.
The primary and backup can also run workers using their configured node IDs.

## RAM, pressure and device roles

The MacBook Air (16 GiB) and MacBook Pro (8 GiB) use independent per-node provider
lanes in the same owner-scoped queue. Their RAM budgets are complementary, not
combined into a larger model. No measured benefit establishes distributed or
sharded inference, so join does not enable it. iPad Pro and phone remain mobile
control surfaces only; do not install workers or advertise them as compute nodes.

Reserve the larger of 4 GiB or 30% of RAM. A job slot budgets 4 GiB; the ceiling is
`floor((RAM - reserve) / 4 GiB)`, capped at 64 slots. This gives one slot on an
8 GiB Mac and two on a 16 GiB Mac. These are conservative admission ceilings,
not measured throughput or promises that a particular workload fits.

Admission holds when available memory is below 30%, swap is in use, free disk is
below 20 GB, or required telemetry is unavailable. Workers recheck capacity before
pulling and immediately before starting the runner, then during execution; pressure
stops the runner process groups. The disk sample covers the home filesystem;
the runner's existing DISKGUARD must also cover checkout and artifact volumes.
Retry after resources recover. Existing DISKGUARD, PAUSE, KILL, lease fencing and
runner sandbox requirements still apply.

## Share configuration through Phantom

Use the same reviewed repository revision on each Mac for project `.mcp.json` and
skill files. Keep credential-free connector and MCP definitions in Phantom's
`~/.phantom/connectors/profile.toml`; use vault binding names, never credential
values. See [connector profiles](CONNECTORS.md) and the
[node-pool example](../examples/node-pool/README.md). Install the same reviewed
metadata on each Mac using its own local credential custody and provider sign-in.
Join does not copy or synchronize arbitrary home directories, client settings,
connector profiles or skills. Changes to shared metadata need the same reviewed
revision on each node. Never copy Cursor credentials, `~/.codex`, `~/.claude` or
auth directories, and do not use client credential import as a join step.

## Queue and worker contract

Enqueue on the active primary using the existing node queue commands:

```sh
phm node enqueue --job example-1 --requires codex --pack reviewed-pack-1 --json
phm node plan --json
```

Configured pools inject their single owner scope. A request for a different owner
is refused. Unconfigured node commands retain their local-store behavior. Provider
lane caps must be `codex` or `claude`. The worker refuses jobs with secret requests
or unsupported caps. Secret resolution and credential injection are deliberately
outside this change; any such integration needs its separate security review.

The runner must be an absolute, owned executable with safe ancestors, checked by
the existing Drive executable validator. It is invoked as `<runner> run`, receives
one JSON object on stdin with `protocol: "phm-node-worker/v1"`, the existing node
`job` view and its `claim`, and must return exactly one bounded JSON object:

```json
{"resultRef":"branch:example-1"}
```

The result reference must satisfy the existing node identifier grammar. The runner
owns pack resolution, sandboxed execution on the requested locally signed-in lane,
and artifact storage accessible to the primary. Its stdout is limited to 4096
bytes and stderr is discarded. A successful process without a valid result
reference is not completion. The worker forwards only the reference, never raw
provider transcripts. The runner must not publish, resolve copied credentials or
perform unfenced external effects. It must pass the claim token to any effect sink
that accepts effects; a preflight lease check alone cannot fence external effects.
No runner executable is installed by this change.

Workers target a three-second renewal and pressure-check interval; bounded
synchronous telemetry probes and SSH operations can delay a check. They hold on local `~/.ashlr-runs/PAUSE` or `KILL`,
and kill the runner process group on lease loss, transport failure, stop sentinel
resource pressure or a 30-minute deadline. Missing control files mean open; unreadable files hold.
Lease loss may leave a job running until its claim expires; no failed run is
reported as completed. Only the primary's existing `publish.sh` path can publish.

## Backup, promotion and split-brain protection

The backup is a single durable witness for all admissions. The primary synchronously
records each node-router transition there over SSH. Its own private mirror cannot
be used to admit work. A primary unable to reach the witness fails closed. After
15 minutes without a primary heartbeat, backup promotion increments the shared
fencing epoch and clears the old leader. Old completions and renewals fail. The
returning primary stays demoted. No automatic failback or offline self-renewal is
provided. The backup witness is the deliberate availability boundary; do not copy,
reset or restore older witness state while work can execute.

```sh
phm node watch --once --json
phm node status --json
```

`watch --once` records one heartbeat or evaluates one promotion check; without it,
watch repeats every five seconds. `node pool`, `join`, `watch`, `worker`, `list` and
`status` all support `--json`, including errors. The fixed SSH endpoint is
`phm node rpc --json`; it accepts bounded JSON on stdin and never shell commands.
Primary and backup roles are configured locally, not taken from a remote caller.
SSH authenticates approved devices under the owner's local account. There is no
new public API, port, HTTP token, provider-auth transfer, outbound messaging or
log path. State lives privately under `$ASHLR_HOME/node-pool` (default
`~/.ashlr/node-pool`). Existing local node-router state remains separate.

The [node layout](NODES.md) describes custody and deployment limits. Agent Bus
claims, `/api/verse/agent-bus`, the desktop Durable bus tab and A2A schemas keep
providing coordination. Their local claims do not become multi-host execution
leases. The already shipped node router is reused for execution fencing instead.
