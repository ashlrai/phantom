# Join this computer to Phantom

One command adds this machine to your Phantom fleet. It reuses the `gh` login
you already have; there are no tokens to copy and no setup steps.

```bash
phm node join      # register, advertise capabilities, start the heartbeat
phm node status    # am I live? who else is registered? who leads?
phm node leave     # leave cleanly (safe to run twice)
```

Copy-paste example (add `--json` for machine output):

```bash
$ phm node join
Joined: my-mac.local (owner person:octocat, gh octocat), leader my-mac.local, 1 node(s) registered.
$ phm node leave
Left the fleet as my-mac.local.
```

## What happens

- **Identity**: the machine's own `gh` session supplies your login
  (`gh api user`). Phantom never reads, copies, stores or sends the token;
  nothing secret appears in logs, the registry or `--json` output.
- **Owner**: every node record carries `owner {kind: person|team|org, id}`. The
  default is `person:<your gh login>` with no prompts. To run a node for a team
  or org: `phm node join --owner team:platform` (or `org:<id>`).
- **Capabilities**: OS, architecture, CPUs, memory (GiB), Node version and which
  of `claude codex docker gh git node npm` are on `PATH`, in sorted order.
- **Registry and heartbeat**: the node joins the existing drive lease store
  (`src/core/drive/nodes`) under `~/.ashlr/nodes`, then a background process
  renews the 30 s lease every 10 s. Leadership fails over automatically.
- **Name**: defaults to the hostname; override with `--name <id>`.

`join` is idempotent: running it again on a live node changes nothing. After a
reboot the heartbeat is gone; `status` says `expired` and `join` rejoins.
`leave` revokes the lease immediately and the heartbeat process exits on its
next tick.

## Errors say how to fix themselves

Errors print `error:` and `fix:` (or `{"error","fix"}` with `--json`), for
example no `gh` login: run `gh auth login`, then `phm node join`.

## Limits

The registry is the local drive lease store: it coordinates all nodes sharing
one `~/.ashlr/nodes` directory (one host). It is not a multi-host consensus
protocol; a remote registry must supply serializable transactions and a single
clock (see `src/core/drive/nodes/README.md`). The node record schema (owner,
caps) is what a remote registry will carry.
