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

To join and stay live in one step, add `--watch` to the join itself:
`phm node join --owner acme --caps build,gh --watch` prints the same join
answer, then holds the new session with the same beat watch described below
(`--every <seconds>` works too). It is refused on a pool-configured Mac —
there `phm node worker` holds the live sessions instead.

To keep the exercise fully separate from real Phantom state, point
`ASHLR_HOME` at a scratch directory first (`export ASHLR_HOME=$(mktemp -d)`);
every command then uses that home, and symlinks in the path are fine.

## Pick a role

Roles are expressed as capabilities, not a `--role` flag. A bare join — no
`--caps` — auto-detects the lanes this computer's own sign-ins support: it
probes the `codex` and `claude` CLIs' login status and the `gh` login exactly
the way a pool worker does (exit codes only; no credential is read or sent),
then advertises those lanes plus any local-model caps. The join reply names
the detected set under `autoCaps` in `--json` and in a plain-words line in
text mode; a probe that finds no sign-ins reports `autoCaps: []` and says so,
since the node then advertises no sign-in lanes. Sign in to a provider CLI
or `gh` and join again, or pass `--caps` to choose the advertisement
yourself — an explicit list replaces the sign-in detection entirely
(local-model and version caps still merge in), and a `--caps` that names no
capability is refused: omit the flag to auto-detect or name at least one.
The bare join also reports `installedClis` in `--json` (and names them in
text mode): the community agent CLIs whose binaries are installed on this
computer — `aider`, `gemini`, `copilot`, `goose`, `droid` and the other
measured harnesses — found by file presence at the usual install locations
only. No CLI is executed, no sign-in is checked and no credential is read,
so the list is `--caps` candidates, not advertised lanes: pass the names to
keep (plus the sign-in lanes, since `--caps` replaces the whole set) to
advertise them. An explicit `--caps` that names an agent CLI — `codex`,
`claude` or a community harness such as `aider` or `gemini` — is checked for
the CLI's binary at the usual install locations (file presence only; nothing
is executed and no sign-in is checked). The reply names any cap it cannot
find under `unverifiedCaps` in `--json` and in a plain-words line in text
mode: jobs requiring those caps will route here and cannot run until the CLI
is installed, so install it or rejoin without the cap. `phm node status` and
`phm node list` re-run the same file-presence check on every read and tag the
node's line `unverified-caps=<cap>` for any advertised agent CLI still missing
a binary — a cap installed (or removed) after the join reads correctly, and
the `--json` view stays the plain caps list.
Capability names are open, not a fixed list: a job's `--requires` is matched
against the caps a node advertises, so name the agent CLIs this computer can
run — `codex`, `claude`, `aider`, `gemini`, `copilot`, `goose`, `droid` and the
other measured harnesses — and a job that requires one routes here.
`phm node capacity` measures this machine per harness and reports how many
agent sessions each can start right now (unmeasured stays unknown).
Either way, advertise only
what this computer
can actually do: jobs select nodes that advertise all their required
capabilities and share their owner scope. For `gh` jobs, sign in locally
with `gh auth login`. Whenever the join advertises `gh` — detected or
passed explicitly — the join records this machine's login check on the
node and the reply names it under `ghAuth` (`ok`, `missing` or `unknown`,
the same exit-code-only check `--probe-auth` runs, paid once at join): an
`ok` routes GitHub jobs from the start, while anything but `ok` means gh
jobs cannot route here until `gh auth login` runs and a `--probe-auth`
beat reports ok — text mode says so at join instead of letting the first
unrouted plan discover it, and the keep-alive beat's `--probe-auth`
refreshes the verdict.

A computer serving a local model through oMLX needs no `--caps` entry: opt in
with `local-lanes.json` in the Phantom home — `~/.ashlr/local-lanes.json`, or
`$ASHLR_HOME/local-lanes.json` when `ASHLR_HOME` is set (the scratch-home
setup above reads the latter) — containing
`{"schemaVersion":1,"enabled":true}`. Check the plan with `phm node lanes`;
when the lane is held its reason names the exact file to write. `phm node
join` advertises the resulting `omlx` caps automatically — the same merge a
pool join or worker performs. A malformed `local-lanes.json` is named in the
standalone join reply (`localLanes` under `--json`) instead of being skipped
silently; `phm node lanes` prints the same parse error. See
[OMLX-SMALL-MACS.md](OMLX-SMALL-MACS.md).

## Verify and stay live

Replace `<nodeId>` with the `nodeId` join returned and `1` with its `session`:

```sh
phm node beat --node <nodeId> --session 1 --probe-auth --json
phm node status --owner acme --json
```

To report measured capacity, generate the sample on this computer and pass it to
each beat: `--capacity "$(phm node measure)"`. When `phm node measure` exits 1
the node is held; omit `--capacity` on that beat. See the
[node router guide](NODE-ROUTER.md). Memory headroom is measured on macOS and
Linux; on a platform with no reader the sample reports `memory-unmeasured`, so
the router keeps work away from that node until one exists.

Check that `<nodeId>` appears live with the intended caps and, for GitHub jobs,
that its auth is `ok`. A join does not start a worker or recurring heartbeat,
so keep one running in the foreground:

```sh
phm node beat --node <nodeId> --session 1 --probe-auth --watch
```

`--watch` repeats the ordinary beat every 10 seconds (or `--every <seconds>`,
between 1 and 25) and re-measures capacity and host stats on this computer each pass,
so do not also pass `--capacity` or `--host-stats` — an explicit flag wins and
would freeze a stale sample. Keep any other flags (`--probe-auth`, `--usage`,
`--json`) on the same command; they apply to every beat. Press Ctrl-C to stop;
the session then expires on its own within 30 seconds. If a beat fails — for
example the session expired — the watch stops and prints the beat's error.

If the session lapses anyway, join again and use the new session number — `beat`,
`pull` and the claim verbs (`renew`, `complete`, `release`) all answer
`session-expired` once it lapses, and the error's `fix`
prints the rejoin command with this node's last advertised owner and caps
(`phm nodes` and `phm node status` print the same hint ending in `--watch`, so
the suggested rejoin also keeps the session live). For `beat` and `pull`, if
the node already rejoined under a newer session the fix names that session and
the exact `leave` command instead, so you can resume without hunting for the
number; a claim verb names the live session for the re-pull instead, since its
tokens died with the old one. A re-join replaces the node's whole advertised
profile rather than merging into it, so the reply names what it drops:
`dropped` in `--json` lists the owner scopes, caps and `--slots` bound the
last join carried that this one does not, plus a `restore` command that
re-joins keeping both; text mode prints the same note and command. Pass every
flag you still want advertised. Omit `--probe-auth` if this node does not need
GitHub authentication.

## See it take a job

The same registry is the queue: a job enqueued on this computer under the
same owner scope is routed to a live node that advertises the job's
capabilities. Run the whole loop here — enqueue, plan, pull:

```sh
phm node enqueue --job hello-1 --owner acme --json
phm node plan --owner acme
phm node pull --node <nodeId> --session 1
```

`plan` shows `hello-1 -> <nodeId>` — or `nobody` with the reason and fix
when no node can take it — and `pull` (without `--json`) prints the claimed
job, its lease tokens and the paste-ready `renew`, `complete` and `release`
commands. Run the printed `complete` command with your result text before
the 30-second claim lapses; for work that takes longer, `phm node renew`
with the same lease flags under `--watch` keeps the claim — and this node's
session — alive on its own (see
[NODE-ROUTER.md](NODE-ROUTER.md)). If `plan` routed the job to a different
node, pull on that node instead. Read the outcome back with:

```sh
phm node result --job hello-1 --owner acme --json
phm node status --owner acme --json
```

Job ids are single-use: a repeat `enqueue` under an existing id changes
nothing, and its `--json` reply names the stored job's state and which spec
fields differ — pick a new id for different work.

A bare `enqueue` is a connectivity ping: the job carries no instructions.
To hand the node real work, embed the task text — the prompt `pull` prints
under `Task:` for the operator (or their agent) to run. `--task-part` carries
the text (repeat the flag, in order, for long prompts; 16 KiB joined at
most) and `--task-sha256` proves it arrived intact: `sha256:` plus the
lowercase hex digest of the exact joined text. `phm node task-digest` prints
that digest for the same `--task-part` values on every platform — no shell
hashing tool needed — and any sha256 tool (`sha256sum`, `shasum -a 256`,
`Get-FileHash`, Node's own crypto) produces the same hex. An embedded task
requires `--pack codex-file`, and `codex-file` requires the embedded task —
enqueue refuses the pair split either way:

```sh
TASK='Reply with exactly: phantom-node-ok'
phm node enqueue --job demo-1 --owner acme --pack codex-file --task-part "$TASK" --task-sha256 "$(phm node task-digest --task-part "$TASK")" --json
phm node pull --node <nodeId> --session 1
```

Every command above runs on this computer: the standalone registry is local,
so producer and node are the same machine and a job enqueued elsewhere never
reaches this node. To share one queue across computers you control — or to
join a team's pool — set up the SSH pool: [NODES.md](NODES.md) covers the
design and [AGENT-NETWORK.md](AGENT-NETWORK.md) the join commands.

## Read the same fleet as the leader

On an enrolled worker, use the existing approved SSH alias for your fleet
leader (replace `leader-mac` with that alias):

```sh
phm node replica sync --leader leader-mac --json
phm org --text
phm fleet lane-slots --json
```

Look for the leader's machine and observation time, and for "Governed by
leader grant #…" in the lane slots. This is a read-only view, not authority to
run the leader's lanes locally. See [One fleet across enrolled Macs](NODE-ROUTER.md#one-fleet-across-enrolled-macs) for automatic refresh and the offline behavior.

## Leave

```sh
phm node leave --node <nodeId> --session 1 --json
```

Use the current session number and check for `"left":true`. An expired or
replaced session cannot leave a newer one; a refused leave answers
`"left":false` with `liveSession` naming the session that is live and a `next`
command that leaves it.

The current router uses a private local state directory shared by processes on
one host; joining does not connect separate computers over a network. The
`join` reply says the same — `"registry":"local"` in `--json` and a plain-words
line in text — so a first-time node never mistakes this for a shared fleet.
See the [node router guide](NODE-ROUTER.md) for routing, leases, and this
limit.
