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

## Slack bridge

The Slack bridge joins explicitly mapped team channels and direct conversations to the existing Agent Bus over
Socket Mode, so no public inbound URL is ever opened. Bus topics map to Slack
channels and bus threads map to Slack threads through `[[slack.map]]` entries
in `~/.ashlr/agent-network.toml`; the file holds Slack ids and Phantom Secrets
`phm_` reference names only, never a token value.

```toml
[team]
identities = [
  { channel = "slack", id = "U0TEAMHUMAN" },   # allowlisted team members
  { channel = "slack", id = "B0TEMAGENT" },    # allowlisted team agents (bot ids)
]

[slack]
team_id = "T0WORKSPACE"          # every event and member must bind to this workspace
own_user_id = "U0BRIDGEBOT"      # the bridge bot's ids: its echoes are dropped (loop guard)
own_bot_id = "B0BRIDGEBOT"
bot_token_ref = "phm_SLACK_AGENTNET_BOT_TOKEN"   # reference names, not values
app_token_ref = "phm_SLACK_AGENTNET_APP_TOKEN"

[[slack.map]]
topic = "leaders"                # bus topic <-> Slack channel, both directions
channel = "C0AGENTNET"
```

Inbound: only `message` and `app_mention` events in a mapped channel from an
allowlisted team member or team agent become bus messages (`channel` = `slack`,
full channel metadata, `body.kind` = `note`). Everything else is ignored and
journaled by id and reason code alone; message text is never logged for ignored
traffic. Bridge-authored echoes are dropped by the loop guard before the
allowlist is consulted.

Outbound: a bus message addressed to a mapped topic posts to
the bound channel only when the channel audience is provably team-only. The
poster checks `conversations.info` (`is_shared`, `is_ext_shared`,
`is_pending_ext_shared`, `context_team_id`) and every page of
`conversations.members` (each member's workspace `team_id`, guest,
deleted and bot flags). Slack Connect, shared channels, guests, unknown
bots and any member who is not an allowlisted team identity refuse; anything
that cannot be proved stays a draft. Explicitly mapped DMs require the same authenticated membership proof. A durable intent precedes one post; uncertain outcomes are reconciled by client message ID through history, never blindly resent. Rate limits stop the bounded pass.

```sh
phm channels slack status --json
phm channels slack map --json
phm channels slack map --topic leaders --json
phm channels slack map --topic leaders --snapshot ./slack-audience.json --json
```

`status` reports the config parse, bridge and workspace ids, `phm_` reference
names (never values), journal counts and the next step. `map` prints the
topic/channel table, resolves one `--topic` to its channel, and evaluates a
saved `{conversation, members}` snapshot through the audience gates plus the
shared send policy. Both are read-only: no socket, no Slack API call, no
credential IO. `ready` describes configuration only; `transport.health` remains unknown until an authenticated probe. The actual host commands are:

```sh
phm channels slack probe --json
phm channels slack run --seconds 60 --json
```

`probe` authenticates the exact configured workspace and bot identity. `run` receives Socket Mode events into the existing durable bus and delivers authored bus results to mapped, freshly verified audiences. The host supplies `SLACK_AGENTNET_BOT_TOKEN` and `SLACK_AGENTNET_APP_TOKEN` to the process through its trusted secret injector. Token values never enter CLI arguments, config, observations or receipts. Socket URLs remain in memory. iMessage and email bodies are never mirrored to Slack.

The separately reconciled [signed peer ingress](SLACK-BUS-INGRESS.md) preserves dot's tested agent-to-agent protocol and is dormant until an owner configures its authenticated HTTP route. It does not create another bus or start a listener.

Create or authorize the app in the intended workspace before injecting its credentials. An unrelated connected app is not a working route. The minimum grants, from
the [research doc](research/AGENT-NETWORK-RESEARCH.md#slack):

| Token | Scope | Purpose |
| --- | --- | --- |
| App-level (xapp) | `connections:write` | open the Socket Mode connection |
| Bot (xoxb) | `app_mentions:read` | receive explicitly addressed messages |
| Bot (xoxb) | `groups:history` | receive ordinary channel messages |
| Bot (xoxb) | `groups:read` | inspect the private channel and paginate membership |
| Bot (xoxb) | `users:read` | resolve member team bindings and flags |
| Bot (xoxb) | `chat:write` | the team reply path |

For direct messages add `im:read`, `im:history` and `message.im`; group DMs add `mpim:read`, `mpim:history` and `message.mpim`; public channels add `channels:read`, `channels:history` and `message.channels`. The base subscriptions are `message.groups` and `app_mention`. No `users:read.email`,
`chat:write.public`, admin scopes, file upload, channel creation or automatic
joins. Tokens go into Phantom Secrets under the names above; the bridge reads
`phm_` references only.

## Team org

`phm org` models co-founders joining with their own agents and pooled usage. The
declarative file is `~/.ashlr/org.toml` (example: `docs/examples/org.toml`): members,
their machines, agents, the lanes and the percent share of each lane they contribute,
roles (`leader`, `implementer`, `reviewer`, `researcher`) and `reports_to` lines. It
holds ids and numbers only, never tokens, mail or messages, and secret-shaped values
are refused. Spending stays with each member; nothing here changes billing.

- `phm org show --json` prints the org and which lanes each member has opted into.
- `phm org join --member <id> --machine <id> --lane <lane>[=<share>] --json` is run by
  each co-founder on their own machine. They sign in to their own provider CLIs there;
  join reads no auth and sends nothing. Contribution is opt-in per lane: a lane not
  named stays at zero, and a share can be lowered but never raised above the declared
  value. If the machine declares a `host`, join refuses to run anywhere else. The
  record lands in `~/.ashlr/org/joins/`; copy another machine's record there to count it.
- `phm org plan [--queue jobs.json] --json` proposes assignments of queue work
  (`[{"id": "RQ-1", "priority": 3, "costPct": 2, "lane": "claude"}]`) and agent roles to
  maximize merged output per unit of pooled usage. Jobs are ordered by priority per
  cost; each goes to the opted-in lane with the most urgent remaining budget, using the
  router's usage and reset data for the contribution's `pool`. A lane's budget is its
  headroom times the contributed share; a red pool gets none, and a lane with no
  telemetry is planned with a conservative 25 points of headroom. Leftover work is
  returned in `unassigned` with a reason.

The leader reads `phm org plan --json` each planning pass and applies it within each
member's contributed limits. Private data, mail and messages are never pooled.

### Assign responsibilities without expanding authority

The leader starts with `phm org show --json` to identify declared members,
machines, lane contributions, agent roles and reporting lines. Each co-founder
uses `phm org join` on their own machine to opt in only the lane share they
intend to contribute. Join records do not transfer provider sign-in or permit
another agent to enroll someone else's capacity.

The leader then reads `phm org plan --json`, or supplies an explicit queue
snapshot with `--queue`, and uses the returned assignments, roles and
`unassigned` reasons to allocate responsibility within existing contributions.
Planning is a proposal, not a queue write, reservation, credential grant or
permission to spend. Check model capability and [lane tool parity](AGENT-TOOLCHAIN.md#lane-tool-parity-audit-rq-delegate-scope-1)
before turning an assignment into a brief. Use a [tier-scaled scope](QUEUE.md#tier-scaled-session-scope)
and one mergeable PR per job; account for live claims and open PRs.

Agents may propose owners, role changes, related feature work, queue priorities,
lane choices and narrower contribution use. The leader can execute already
authorized work within the member's opted-in limits without a per-job Mason
approval. New member contributions require that member's own declaration and
opt-in; a planner cannot raise shares or borrow another member's auth. Team
access changes use the existing human owner/admin process described in
[Team](TEAM.md#invite-join-and-remove-a-teammate).

Mason is needed for passwords, 2FA, device approvals and payments, including
new spending. Security-pinned changes and hold-list work retain their existing
review requirements; private data cannot be made public. Org membership, a
plan or a larger session brief grants none of those exceptions. Do not add a
new approval step for routine responsibility assignment.

Read-only planning example using synthetic ids:

```sh
phm org show --json
printf '%s\n' '[{"id":"RQ-FEATURE","priority":1,"costPct":2,"lane":"devin"}]' > /tmp/org-scope-jobs.json
phm org plan --queue /tmp/org-scope-jobs.json --json
```

For opt-in on a member's own declared machine, substitute its declared ids:

```sh
phm org join --member <member-id> --machine <machine-id> --lane devin=20 --json
```

```bash
cp docs/examples/org.toml ~/.ashlr/org.toml
phm org join --member evan-deloria --machine evan-mac --lane claude=20 --json
echo '[{"id":"RQ-1","priority":3}]' > /tmp/jobs.json
phm org plan --queue /tmp/jobs.json --json
```
