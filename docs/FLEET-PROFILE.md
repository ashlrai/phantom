# Cross-platform fleet profile

From a trusted checkout of the [fleet profile](../fleet/profile), with Python
3.11+ on each machine (use `python` in place of `python3` on Windows):

```sh
python3 fleet/profile/apply.py --json
python3 fleet/profile/apply.py --json --host primary-mac --host linux-worker
python3 fleet/profile/apply.py --apply
python3 fleet/profile/apply.py --apply --host backup-mac
npm run dev -- fleet profile --json
```

The `phm fleet profile` shortcut is read-only and needs checkout dependencies.
The Python tool defaults to JSON dry run. Repeat `--host` for a matrix.
SSH needs trusted host keys, passwordless access, and Python 3.11+ on the
remote PATH. The script and profile are streamed; no remote checkout or
agent forwarding is required.

## Bring any agent

Use any coding agent, on any supported machine, to edit the trusted
`fleet/profile/profile.json` declaration. It uses schema `fleet.profile.v1`.
Give each entry a unique `id` and a `kind`: `cli`, `desktop-app`, `mcp`, `sdk`,
`api`, or `local-model`. `detect` takes a `command` to find on PATH or a
`path` to check for existence; either accepts a list of alternatives. For an
API or MCP integration, point detection at its local client or launcher, not
its credential file. See [Contribute with an agent](CONTRIBUTE-WITH-AN-AGENT.md)
for the contribution workflow.

- `install` selects Homebrew (`brew`/`brewCask`) or npm on macOS, WinGet on
  Windows, and apt, npm or pipx on Linux. Set keys to public package IDs.
  Install the relevant package managers first and run apply with enough
  permission to install the selected packages. An entry with no matching
  installer reports `unsupported-on-<os>`; it does not fail or block other entries.
- `install.script` maps an OS or OS-architecture to an argv array. Review
  scripts and status commands before applying any shared profile. For Phantom
  Desktop, the profile uses the [qualified first-install flow](QUICKSTART.md#desktop-app-on-apple-silicon-mac)
  on Apple silicon only. Follow its matching-release and Stop prerequisites
  before applying; the profile does not engage Stop or replace an existing app.
- `install.manual` gives a note for apps with no package. On Macs only, opt in
  by adding `"copyFromHost": {"host":"trusted-peer","path":"/Applications/Grok Bot.app"}`
  to a manual app entry. Apply uses SSH and rsync 3+ to stage just that bundle
  after verifying its Apple-anchored code signature on the peer, then verifies
  it again before installing. It does not replace apps or copy support data,
  preferences, or Keychains.
- `models` on a local-model entry lists models for planning only. Apply may
  install the runtime, but it never pulls models.
- `agentDefaults` contains the owner's no-approval Devin, Claude, and
  Codex defaults for unattended lanes. These disable approval prompts and
  Codex sandboxing; use them only on trusted, dedicated machines. Outside
  contributors can edit or remove these keys before applying their profile.
  Removing a key stops managing it; it does not undo an earlier application.

Apply generates its Homebrew Bundle input from the profile and merges only the
listed agent keys. Changed configs get private, timestamped `.bak-fleet-*`
backups on their own machine. Keep credentials out of managed configs; recognized
inline credential keys and linked configs are refused.

## Sign in on each device

An entry's optional `login` defines `status` and `start` argv arrays. Each
native CLI checks its own sign-in, including `codex login status`. Dry run
reports sign-in state without starting login flows.
Run `python3 fleet/profile/apply.py --login --host backup-mac` (omit the host
for local use). For GitHub on macOS or Linux, open the reported device URL and
enter its one-time code. For manual rows, run the named command directly on
the indicated machine.
Codex is always manual. The profile itself never opens auth files, returns
raw status output, or transfers credentials.

For API keys, use [Phantom Secrets](https://github.com/ashlrai/phantom-secrets)
on each device. Set up that device's vault in a trusted terminal, unlock the
local macOS Keychain, and approve its Phantom Secrets access prompt if shown.
Do not copy credential files or paste API keys into the profile or an agent.
