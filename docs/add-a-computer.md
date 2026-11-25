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
`session` number from the output; use that number in the commands below. The
output's `next` field prints the exact `beat` command that keeps this session
live.

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
that its auth is `ok`. A join does not start a worker or recurring heartbeat,
so keep one running in the foreground:

```sh
phm node beat --node laptop --session 1 --probe-auth --watch
```

`--watch` repeats the ordinary beat every 10 seconds (or `--every <seconds>`,
at most 25) and re-measures capacity and host stats on this computer each pass,
so do not also pass `--capacity` or `--host-stats` — an explicit flag wins and
would freeze a stale sample. Keep any other flags (`--probe-auth`, `--usage`,
`--json`) on the same command; they apply to every beat. Press Ctrl-C to stop;
the session then expires on its own within 30 seconds. If a beat fails — for
example the session expired — the watch stops and prints the beat's error.

If the session lapses anyway, join again and use the new session number — `beat`
and `pull` both answer `session-expired` once it lapses, and the error's `fix`
prints the rejoin command with this node's last advertised owner and caps. If
the node already rejoined under a newer session, the fix names that session and
the exact `leave` command instead, so you can resume without hunting for the
number. Omit `--probe-auth` if this node does not need GitHub authentication.

## Leave

```sh
phm node leave --node laptop --session 1 --json
```

Use the current session number and check for `"left":true`. An expired or
replaced session cannot leave a newer one; a refused leave answers
`"left":false` with `liveSession` naming the session that is live and a `next`
command that leaves it.

The current router uses a private local state directory shared by processes on
one host; joining does not connect separate computers over a network. See the
[node router guide](NODE-ROUTER.md) for routing, leases, and this limit.
