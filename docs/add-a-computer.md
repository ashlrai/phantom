# Add a computer in 60 seconds

On the computer to add, install Node.js 22.15.0 or newer, then install Phantom:

```sh
npm install -g @ashlr/phantom
```

Join with the owner scope used by the jobs you want to run; the node ID
defaults to this computer's hostname, so the shortest join is:

```sh
phm node join --owner acme --caps build,gh --json
```

Replace `acme` with your own owner scope, and pass `--node <id>` before
`--owner` if you want a different node ID than the hostname. Choose
capabilities for this computer's role (see below). Save the `nodeId` and
`session` numbers from the output; use them in the commands below (shown as
`<nodeId>` and `1`). The output's `next` field prints the keep-alive
`beat --watch` command — the only beat form that keeps this session live —
and adds `--probe-auth` when `gh` was advertised, so GitHub jobs can actually
route to this node once `gh auth login` has run here.

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

Replace `<nodeId>` with the `nodeId` join returned and `1` with its `session`:

```sh
phm node beat --node <nodeId> --session 1 --probe-auth --json
phm node status --owner acme --json
```

To report measured capacity, generate the sample on this computer and pass it to
each beat: `--capacity "$(phm node measure)"`. When `phm node measure` exits 1
the node is held; omit `--capacity` on that beat. See the
[node router guide](NODE-ROUTER.md).

Check that `<nodeId>` appears live with the intended caps and, for GitHub jobs,
that its auth is `ok`. A join does not start a worker or recurring heartbeat,
so keep one running in the foreground:

```sh
phm node beat --node <nodeId> --session 1 --probe-auth --watch
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

## Run a job on it

A live node takes jobs enqueued in its owner scope. This computer's standalone
registry is local, so `enqueue`, `plan`, `pull`, `renew` and `complete` all run
on this machine against the same state — a pool member's jobs instead arrive
from the pool primary (see [NODES.md](NODES.md)). Keep the `beat --watch`
above running in another terminal: `pull` and `renew` need the live session,
which expires 30 seconds after the last beat.

Queue one job and see where it routes:

```sh
phm node enqueue --job hello-1 --owner acme --json
phm node plan --owner acme
```

`plan` names the node each pending job routes to, or prints the fix when no
live node can take it. Then claim the job on this node — run `pull` without
`--json` to see the claim, the lease tokens and expiry, and the exact
`renew`/`complete` commands carrying this job's real numbers:

```sh
phm node pull --node <nodeId> --session 1
phm node renew --job hello-1 --node <nodeId> --session 1 --token <token> --leader-token <leaderToken> --watch
phm node complete --job hello-1 --node <nodeId> --session 1 --token <token> --leader-token <leaderToken> --result "done"
phm node result --job hello-1 --owner acme
```

Use the current session number (it changes on rejoin) and the token numbers
`pull` printed. A claim lapses 30 seconds after the last renew, so
`renew --watch` repeats it every 10 seconds (or `--every <seconds>`, at most
25) while the job runs; Ctrl-C stops the watch and the claim then expires on
its own, after which the job can be pulled again. `--result` is the text
`phm node result` reads back. A job's `--requires` caps must be ones the node
advertised at join — enqueue without it and any live node in the scope can
take the job. Jobs carry secret names only; each node resolves them from its
own custody, so no credential ever travels with the work.

## Leave

```sh
phm node leave --node <nodeId> --session 1 --json
```

Use the current session number and check for `"left":true`. An expired or
replaced session cannot leave a newer one; a refused leave answers
`"left":false` with `liveSession` naming the session that is live and a `next`
command that leaves it.

The current router uses a private local state directory shared by processes on
one host; joining does not connect separate computers over a network. See the
[node router guide](NODE-ROUTER.md) for routing, leases, and this limit.
