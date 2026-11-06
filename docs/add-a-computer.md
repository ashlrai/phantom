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

Check that `laptop` appears live with the intended caps and, for GitHub jobs,
that its auth is `ok`. A join does not start a worker or recurring heartbeat.
Repeat the heartbeat comfortably within 30 seconds to keep the session live;
if it expires, join again and use the new session number. Omit `--probe-auth`
if this node does not need GitHub authentication.

## Leave

```sh
phm node leave --node laptop --session 1 --json
```

Use the current session number and check for `"left":true`. An expired or
replaced session cannot leave a newer one.

The current router uses a private local state directory shared by processes on
one host; joining does not connect separate computers over a network. See the
[node router guide](NODE-ROUTER.md) for routing, leases, and this limit.
