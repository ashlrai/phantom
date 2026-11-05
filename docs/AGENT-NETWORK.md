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

On another Mac, join the same owner scope, then run one worker attempt:

```sh
phm node join --node mac-secondary --owner mason --primary primary-mac --backup backup-mac --json
phm node worker --runner /absolute/path/to/reviewed-node-runner --json
phm node list --json
phm node status --json
```

Join probes `codex login status` and `claude auth status --json` locally, retaining
only exit status. Sign in with each CLI's normal device flow on that Mac. Never
copy auth directories. Each worker attempt rejoins with fresh lane observations;
repeat worker invocations from the host's existing supervisor for continuous work.
The node ID cannot have two live sessions. A worker exits after one claimed job.
The primary and backup can also run workers using their configured node IDs.

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

Workers renew every three seconds, hold on local `~/.ashlr-runs/PAUSE` or `KILL`,
and kill the runner process group on lease loss, transport failure, stop sentinel
or a 30-minute deadline. Missing control files mean open; unreadable files hold.
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
