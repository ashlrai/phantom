# Add a computer in 60 seconds

On the computer to add, install Node.js 22.15.0 or newer, then install Phantom:

```sh
npm install -g @ashlr/phantom
```

Join with a unique node ID and the owner scope used by the jobs you want to
run. Choose capabilities for this computer's role (see below):

```sh
phm node join --node laptop --owner acme --caps build,gh --json
```

Replace `laptop` and `acme` with your own node ID and owner scope. Save the
`session` number from the output; use that number in the commands below.

To keep the exercise fully separate from real Phantom state, point
`ASHLR_HOME` at a scratch directory first (`export ASHLR_HOME=$(mktemp -d)`);
every command then uses that home, and symlinks in the path are fine.

## Pick a role

Roles are expressed as capabilities, not a `--role` flag. Advertise only what
this computer can actually do: use `--caps build` for build jobs, `--caps gh`
for GitHub jobs, or `--caps build,gh` for both. Jobs select nodes that advertise
all their required capabilities and share their owner scope. For `gh` jobs,
sign in locally with `gh auth login` and report that login with `--probe-auth`;
credentials stay on this computer.

## Verify and stay live

Replace `1` with the session returned by join:

```sh
phm node beat --node laptop --session 1 --probe-auth --json
phm node status --owner acme --json
```

To report measured capacity, generate the sample on this computer and pass it to
each beat: `--capacity "$(phm node measure)"`. When `phm node measure` exits 1
the node is held; omit `--capacity` on that beat. See the
[node router guide](NODE-ROUTER.md).

Check that `laptop` appears live with the intended caps and, for GitHub jobs,
that its auth is `ok`. A join does not start a worker or recurring heartbeat.
Repeat the heartbeat comfortably within 30 seconds to keep the session live;
if it expires, join again and use the new session number — `beat` and `pull`
both answer `session-expired` once it lapses. Omit `--probe-auth` if this node
does not need GitHub authentication.

## Run one job

Registration only proves the node exists. To watch the router hand work to
it, enqueue a harmless job and pull it. Jobs and nodes live in this
computer's private router state, so the smoke job is visible only to nodes
joined here:

```sh
phm node enqueue --job smoke-1 --owner acme --json
phm node plan --owner acme
phm node pull --node laptop --session 1 --json
```

`plan` prints `smoke-1 -> laptop` while the node is live and eligible. `pull`
returns the job and a `claim` carrying `token` and `leaderToken`; copy both
into `complete` (and `renew`, for real work — the lease lives 30 seconds, so
renew before it lapses or the job can be pulled again):

```sh
phm node complete --job smoke-1 --node laptop --session 1 --token <token> --leader-token <leader-token> --result done --json
phm node status --owner acme --json
```

`status` then reports `smoke-1` as `completed`. A job can require
capabilities (`--requires gh` also needs a `--probe-auth` heartbeat reporting
`ok`) and carries secret names, never values; a job no live node can take
stays pending and `plan` prints the fix. See the
[node router guide](NODE-ROUTER.md) for routing, leases and fencing.

## Leave

```sh
phm node leave --node laptop --session 1 --json
```

Use the current session number and check for `"left":true`. An expired or
replaced session cannot leave a newer one.

The current router uses a private local state directory shared by processes on
one host; joining does not connect separate computers over a network. See the
[node router guide](NODE-ROUTER.md) for routing, leases, and this limit.
