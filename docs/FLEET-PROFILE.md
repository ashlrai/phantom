# Mac fleet profile

From a trusted checkout of the [fleet profile](../fleet/profile), with Homebrew
and Python 3.11+ on each Mac:

```sh
python3 fleet/profile/apply.py --json
python3 fleet/profile/apply.py --json --host primary-mac --host backup-mac
python3 fleet/profile/apply.py --apply
python3 fleet/profile/apply.py --apply --host backup-mac
npm run dev -- fleet profile --json
```

The `phm fleet profile` shortcut is read-only and needs checkout dependencies.
The Python tool defaults to JSON dry run. Repeat `--host` for a matrix.
SSH needs trusted host keys, passwordless access, and Homebrew/Python on the
remote PATH or in a standard Homebrew directory. Only the script and profile
are streamed; no remote checkout or agent forwarding is required.

- `Brewfile` lists formulae and casks as `brew "name"` or `cask "name"`.
- `npm-globals.txt` lists public npm package names, one per line.
- `agent-defaults.json` contains the owner's no-approval Devin, Claude, and
  Codex defaults for unattended lanes. These disable approval prompts and
  Codex sandboxing; use them only on trusted, dedicated machines. Outside
  contributors can edit or remove these keys before applying their profile.
  Removing a key stops managing it; it does not undo an earlier application.

Apply runs Homebrew Bundle, installs missing npm globals, and merges only the
listed agent keys. Changed configs get private, timestamped `.bak-fleet-*`
backups on their Mac. Keep credentials out of managed configs; recognized
inline credential keys and linked configs are refused.

## Sign in on each Mac

The `logins` list in `agent-defaults.json` selects providers to check. Each
native CLI checks its own sign-in, including `codex login status`. Dry run
reports sign-in state without starting login flows.
Run `python3 fleet/profile/apply.py --login --host backup-mac` (omit the host
for local use). For GitHub, open the reported device URL and enter its one-time
code. For manual rows, run the named command directly on the indicated Mac.
Codex is always manual. The profile itself never opens auth files, returns
raw status output, or transfers credentials.

For API keys, use [Phantom Secrets](https://github.com/ashlrai/phantom-secrets)
on each device. Set up that device's vault in a trusted terminal, unlock the
local macOS Keychain, and approve its Phantom Secrets access prompt if shown.
Do not copy credential files or paste API keys into the profile or an agent.
