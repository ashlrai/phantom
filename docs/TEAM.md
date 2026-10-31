# ashlr — Team Guide (2-person fleet)

This guide covers running ashlr as a two-person team. Each teammate runs an
independent fleet on their own machine. Shared visibility is provided by
ashlr-pulse: both teammates point at the same pulse instance and see each
other's fleet activity attributed by owner.

---

## Start here: role, context and next action

The setup below connects independent machines to Pulse. The shipped
`phm team` protocol is a separate **local-only** coordination log; using the
same team name on two machines does not sync members, messages or claims.
Ask the team owner which machine/log and team ID are authoritative before
joining an empty team. Pulse identity does not grant team or repository access.

| Your situation | Next action | Ready when |
|---|---|---|
| New member | Ask the owner for the team ID, your responsibility, repository access and a first task; inspect `phm team view --team <id>` on the agreed local log, then run `phm team join --team <id>` from your human terminal. | The view shows your expected role and you can open the task's source references. |
| Missing access or unclear readiness | Ask the owner/admin through an existing approved channel for the specific missing repo, connector or context scope; include the task reference, failing command and a redacted error. | The owner confirms access and the original read/check succeeds; until then, review accessible docs or report the blocker. |
| Returning member | Run `phm team view --team <id>` again; review recent messages, open handoffs, pending approvals and unexpired claims, then re-read the linked task sources. | Your assignment and scope are current, access still works and no claim conflicts with the next edit. |

Roles in the view are protocol permissions: the first joining human becomes
`owner`, subsequent humans are `member`, and agents have role `agent`.
Human owners/admins decide consequential handoff approvals. `join --role admin`
does not promote a member, and `--as` does not change join or approval identity.
Confirm your actual work responsibility with the owner; a role or online dot
alone does not establish readiness or authorize a release, spend or secret change.
Do not create a replacement team or disable a control to work around refusal.

For shared context, request the current objective, acceptance criteria, assigned
owner, repo/branch/path scope, source links and next checkpoint. Agents can use
`phm_team_context_get` with the agreed owner/project/person scope and token
budget; inspect its source, author and timestamp and re-read stale sources.
An empty pack can mean a scope mismatch or missing context; ask the context
owner to confirm the scope and add a cited entry using `phm_team_context_add`.
Never widen client scope to find missing data. These tools are available through
the MCP gateway, not `phm team context` subcommands. Use Phantom Secrets
references for credentials and Locus for scoped account access; never paste
credentials into a message, context entry or blocker report.

Once ready, claim the task scope before editing in a task worktree:

```bash
phm team claim <owner/repo> --branch <branch> --path <path> --reason "<task reference>" --team <id>
```

A conflict means coordinate with the displayed holder or wait for lease expiry;
returning members must reacquire expired claims. Claims coordinate the local
log only and do not grant GitHub permissions or enforce cross-machine exclusion.
See the [team architecture](architecture/teams.md) for handoffs and trust limits.

### Onboarding walkthrough checks

Repeat these checks after changing onboarding guidance:

1. **New member:** start with an empty local view. It should direct you to
   confirm the authoritative log before joining; after joining, verify the role
   rather than assuming admin access. Identify a named owner and first task.
2. **Missing access:** use an unavailable task source or an empty scoped context
   pack. Identify the owner/admin to contact, the redacted evidence to provide
   and the read/check to retry. Do not proceed with edits that need that context.
3. **Returning member:** inspect a view with messages, an open handoff and a
   conflicting claim. Follow source links, confirm the assignment and coordinate
   with the holder before claiming; pending approval stays with a human owner/admin.

---

## The team model

```
Mason's machine                     Cofounder's machine
──────────────────                  ──────────────────────
~/.ashlr/config.json                ~/.ashlr/config.json
~/.ashlr/inbox/          (local)    ~/.ashlr/inbox/         (local)
~/.ashlr/goals/          (local)    ~/.ashlr/goals/         (local)
~/.ashlr/enrollment.json (local)    ~/.ashlr/enrollment.json (local)
          │                                    │
          └──────────────┬────────────────────┘
                         ▼
               ashlr-pulse instance
               (shared OTLP endpoint)
               fleet activity, attributed
               by ashlr.fleet.owner per machine
```

Each fleet only writes to repos enrolled on that machine. Proposals stay in
the local inbox until the machine owner reviews and applies them. Pulse is the
read-only shared layer: it receives OTLP spans from both machines and groups
activity by owner so both teammates see whose fleet produced what.

---

## What is shared vs. local

| Item | Where it lives | Shared? |
|------|---------------|---------|
| Enrolled repos | `~/.ashlr/enrollment.json` | No — per machine |
| Proposals / inbox | `~/.ashlr/inbox/*.json` | No — per machine |
| Goals | `~/.ashlr/goals/*.json` | No — per machine |
| Engine API keys | env / Phantom vault | No — per machine |
| `~/.ashlr/config.json` | local only | No |
| Fleet activity + attribution | ashlr-pulse (OTLP) | Yes — both see it |
| `ashlr.fleet.owner` label | carried in every OTLP span | Yes — identifies whose work |

---

## Onboard your cofounder

### 1. Install ashlr

```bash
npm i -g https://github.com/ashlrai/ashlr-hub/releases/download/v3.17.2/ashlr-hub-3.17.2.tgz
```

### 2. Run setup

```bash
ashlr setup
```

Resident service mutation is withheld in the current release, so `ashlr setup`
refuses before reading or changing setup state and exits nonzero. Run
owner-invoked work with `ashlr run "<goal>"` or `ashlr swarm "<goal>"`. The
compiled daemon and conductor trust roots are empty, so daemon use is limited
to `ashlr daemon start --once --dry-run` and status; existing services retain
status and uninstall support.

Current flag behavior remains fail-closed: every mode refuses before the wizard,
so `--yes` does not discover or enroll and `--wire` does not edit anything.
`--json` changes only the refusal output format. The intended, currently
unreachable wizard flags are:

- `--yes` — would accept defaults non-interactively if authority is restored
- `--wire` — would wire detected editors backup-first if authority is restored
- `--json` — emits the current refusal result as JSON for scripting

### 3. Set user identity for pulse attribution

`ashlr setup` syntactically accepts `--user` and `--user-id`, but the current
authority refusal occurs before either value is applied or persisted. Set
identity directly in `~/.ashlr/config.json`, or via `ashlr config set`:

```bash
ashlr config set user.id cofounder@example.com
ashlr config set user.name Alex
```

Or edit `~/.ashlr/config.json` directly:

```json
{
  "user": {
    "id": "cofounder@example.com",
    "name": "Alex"
  }
}
```

`user.id` should be the email that matches their pulse account (used as the
`ashlr.fleet.owner` attribute on all OTLP spans from that machine). Absent
`cfg.user`, owner stamps are omitted and pulse cannot attribute that machine's
activity — set this before connecting to pulse.

### 4. Enroll repos

```bash
ashlr enroll add /absolute/path/to/repo
```

`ashlr setup --yes` currently refuses before discovery or enrollment because
resident service authority is withheld. Enroll each intended repository
explicitly with `ashlr enroll add`; each person enrolls only repos on their
machine. The fleet will not touch unenrolled repos.

---

## Shared pulse setup

Both teammates must point at the same pulse instance.

### 1. Set the endpoint (both machines)

```bash
ashlr pulse connect https://pulse.ashlr.ai/api/otlp/v1/traces
```

Or for a self-hosted instance:

```bash
ashlr pulse connect https://your-pulse-host/api/otlp/v1/traces
```

This writes `cfg.pulse.endpoint` to `~/.ashlr/config.json`.

### 2. Enable the pulse export (both machines)

```bash
ashlr config set pulse.enabled true
```

### 3. Store your PAT (each person mints their own)

The PAT is never stored in `config.json`. It lives in Phantom or the
environment.

**Preferred — Phantom vault:**

```bash
ashlr pulse connect --token     # hidden prompt
# or, from a pipe:
printf %s "$PAT" | ashlr pulse connect --token-stdin
```

This stores the token as `ASHLR_PULSE_TOKEN` in your Phantom vault.

**Fallback — shell environment:**

```bash
export ASHLR_PULSE_PAT=<your-pulse-pat>
```

Add to `~/.zshrc` / `~/.bashrc` to persist.

### 4. Verify

```bash
ashlr pulse connect --status   # show config + sink state
ashlr pulse connect --test     # send one test span and confirm receipt
```

Once both machines pass `--test`, the Fleet/Team view in pulse will show both
teammates' activity grouped by `ashlr.fleet.owner`.

---

## Daily team flow

### Each person on their own machine

```bash
# Review proposals the fleet generated overnight
ashlr inbox

# Check daemon / fleet status
ashlr daemon status

# Check or add goals
ashlr goals list
ashlr goals add "harden error handling in auth module"

# Run one owner-invoked proposal path (not a resident or unattended loop)
ashlr goal "harden error handling in auth module" --project <enrolled-repo>

# Open Mission Control UI (localhost:7777)
ashlr serve
```

The Mission Control Goals tab shows goals local to that machine. Each person
manages their own fleet's goals independently.

### Shared visibility in pulse

Both teammates see the shared Fleet/Team view at the pulse endpoint. Activity
is attributed by `ashlr.fleet.owner` (the `cfg.user.id` set in step 3 above).
Neither person's proposals, inbox items, nor goals are visible to the other
directly — only the aggregated activity metrics and span data that the fleet
exports to pulse.

---

## Kill switch

Each machine has its own independent kill switch. It does not affect the other
person's fleet.

```bash
# Halt all autonomous fleet writes on this machine immediately
ashlr enroll kill on

# Resume
ashlr enroll kill off
```

Under the kill switch, read-only tools continue to work. All writes and
proposal creation are refused until it is cleared.

The kill switch is implemented as a sentinel file at `~/.ashlr/KILL`. You can
also create or remove it directly:

```bash
touch ~/.ashlr/KILL    # engage
rm ~/.ashlr/KILL       # clear
```

`ashlr daemon status` and `ashlr doctor` will warn when the kill switch is on.

---

## Daemon

The compiled daemon and conductor trust roots are empty in the current
production build. Live foreground, one-shot, and resident execution therefore
refuses before effects. Creating, repairing, reinstalling, or restarting a
background OS service is also withheld; an existing service may still be
inspected or explicitly uninstalled.

```bash
ashlr daemon start --once --dry-run  # preview a tick without proposals
ashlr daemon stop               # stop + engage kill switch
ashlr daemon status             # running?, last tick, spend, pending count
```

For live owner-invoked proposal work, use `ashlr run "<goal>"`,
`ashlr swarm "<goal>"`, or `ashlr goal "<objective>"`; none grants resident or
unattended authority.

The daemon is proposal-only. It can never apply a proposal, push to git, or
touch the live working tree. All mutations flow through the inbox.

---

## Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| Pulse not receiving spans | `ashlr pulse connect --status` | Verify `pulse.enabled true` + PAT set |
| Fleet activity not attributed in pulse | pulse Fleet/Team view shows no owner | Set `cfg.user.id` on that machine |
| Daemon not running | `ashlr daemon status` | Expected while compiled roots are empty; use `ashlr daemon start --once --dry-run` or owner-invoked `ashlr run`/`ashlr swarm` |
| Kill switch engaged | `ashlr doctor` shows WARN | `ashlr enroll kill off` |
| Repo not being worked | `ashlr enroll list` | `ashlr enroll add <path>` |
| PAT rejected (401) | `ashlr pulse connect --test` | Re-run `ashlr pulse connect --token` (hidden prompt) with a fresh PAT |

---

## Key paths

| Path | Purpose |
|------|---------|
| `~/.ashlr/config.json` | All config: user identity, pulse endpoint, enrolled repos, daemon settings |
| `~/.ashlr/enrollment.json` | Enrolled repo list (local) |
| `~/.ashlr/inbox/*.json` | Pending proposals (local) |
| `~/.ashlr/goals/*.json` | Goals (local) |
| `~/.ashlr/daemon-state.json` | Last tick, spend ledger |
| `~/.ashlr/KILL` | Kill switch sentinel |

---

## Reference: relevant source files

| File | What it does |
|------|-------------|
| `src/cli/setup.ts` | First-run wizard (`ashlr setup`) |
| `src/cli/pulse.ts` | `ashlr pulse connect` — bridge config + PAT storage |
| `src/cli/sandbox.ts` | `ashlr enroll` + kill switch |
| `src/cli/daemon.ts` | `ashlr daemon` subcommands |
| `src/cli/inbox.ts` | `ashlr inbox` — proposal review |
| `src/cli/goal.ts` | `ashlr goal` — goal management |
| `src/core/fleet/pulse-export.ts` | OTLP span export + `ashlr.fleet.owner` stamping |
| `src/core/types.ts:L240–268` | `cfg.pulse` and `cfg.user` type definitions |
| `docs/PULSE-BRIDGE.md` | Full `ashlr pulse connect` reference (M62) |
| `docs/SPEC-V3-TEAM.md` | Multi-machine architecture spec |
