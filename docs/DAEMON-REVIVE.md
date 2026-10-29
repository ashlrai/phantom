# Daemon revival and Mac handoff

`ashlr daemon health --json` reports the daemon's proven process liveness,
last recorded tick, latest daemon log write, resolved planning adapters and a
restart recommendation. It performs no restart and no completion request.
A resolved adapter is not proof of account authentication, free capacity or a
successful model call. Local planning remains local, with no frontier merge
attestation.

This source change does not activate the Mac daemon. The owner-controlled
service renderer, manager resolver, launch admission and Codex native-profile
adapter are separate protected changes. Do not install a template manually to
work around a refused `authority resident start`.

## Read the health result

```sh
ashlr daemon health --json
```

The command exits `0` only when the process is alive, logs are fresh, pause and
Stop are clear, and at least one planning adapter resolves. An unhealthy result
exits `1`. Unknown observations remain `null` or `unknown`.

- `alive`: proven liveness, not `daemon.json`'s historical running claim.
- `lastTickAt`: last recorded tick, which can remain old during a long task.
- `lastLogWriteAt`, `logAgeMs`, `logState`: metadata from the latest stdout or
  stderr log on macOS. The command does not read log content.
- `frontierClientsResolved`: adapters resolved by the guarded planning resolver.
  This includes the local planning adapter when selected; it does not promote
  a local model's trust tier.
- `supervisor.restartRecommended`: true for a proven dead daemon or an alive
  daemon whose latest log write is more than 15 minutes old, provided pause,
  Stop and liveness observations permit a recommendation.

At exactly 15 minutes the log is still fresh. Missing logs are `missing`, not a
fabricated stale timestamp. Unreadable metadata, future timestamps and uncertain
process identity produce unknown observations. Pause, Stop or unknown control
state suppress the recommendation.

The owner supervisor should sample this JSON once a minute. After starting a
new process, apply a 15-minute startup backoff before acting on stale log
metadata inherited from the prior process; health still reports its observed age. A recommendation
is a recovery signal, not activation authority. Before any restart it must
revalidate the resident grant, current release, lifecycle fence, pause, Stop and
current admission, then use the existing authorized resident-service path.
Back off after a failed attempt; do not loop `launchctl kickstart` across an
admission refusal. This change supplies the recommendation and tests, not the
protected supervisor executor.

## Planning clients and remaining owner work

Invent and strategy planning now search the existing guarded Codex, Grok CLI
and Claude adapters instead of allowing missing Claude to strand Codex behind
an automatic local fallback. JEV advises only among resolved adapters; it does
not admit a seat, create capacity or authorize spend. A missing or invalid JEV
choice keeps the deterministic candidate order. The goal planner forwards the
engine it selected into `runGoal`, which retains execution admission.

The manager's direct `resolveFrontierJudgeClient` implementation remains
unchanged because it is Tier-1 protected. Autonomous Codex judging still refuses
without the selected pinned seat required by its confinement policy. Do not
replace that refusal with an unrestricted subprocess.

The requested two native Codex profiles, `~/.codex` and `~/.codex-2`, need an
owner-reviewed CLI-only adapter that selects `CODEX_HOME` per invocation and
preserves admission and confinement without reading or writing either profile's
`auth*` files. Do not call `codex logout`, copy credentials, mint tokens or infer
account readiness from a profile directory. This change neither changes
`CODEX_HOME` nor claims both profiles are operational.

The existing local adapter uses OpenAI-compatible chat completions. A loopback
oMLX service can use the existing `models.ollama` endpoint configuration, with
the exact model configured by the operator. Its base is extended with `/v1` by
the existing adapter. This is transport compatibility, not a completed oMLX
runtime qualification. Non-loopback local fallback is excluded from planning.

There is no memguard/#1014 admission contract in this checkout. Integrating that
contract remains owner work. Existing daemon count preferences accept `null`
for an inventory-derived ceiling, and local fleet concurrency already derives
from observed serving slots and admission. A future service renderer must stop
serializing fixed `--parallel 1` and `--budget 50` overrides. Preserve the
configured authorized daily budget; free slots never grant a larger dollar
budget. Unknown capacity or memory admission must hold work rather than infer
free slots.

## Target launchd template

The canonical stable release pointer is
`~/.local/share/ashlr/current`. The approved launcher is `current/bin/ashlr`.
The renderer must retain that path instead of resolving it to a release SHA.
The `current` pointer itself is changed only by the qualified release lifecycle.

The following is a review template for the protected service renderer. Replace
`LOGIN_HOME` and `PINNED_NODE` with the owner-verified absolute paths and XML-escape
them. It is embedded here because `.plist` files are protected. It is not an
alternate installer and has not been installed by this change.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.ashlr.daemon</string>
  <key>ProcessType</key><string>Background</string>
  <key>ProgramArguments</key>
  <array>
    <string>PINNED_NODE</string>
    <string>LOGIN_HOME/.local/share/ashlr/current/bin/ashlr</string>
    <string>daemon</string><string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>LOGIN_HOME</string>
    <key>PATH</key><string>LOGIN_HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>LOGIN_HOME/.ashlr/daemon.launchd.out.log</string>
  <key>StandardErrorPath</key><string>LOGIN_HOME/.ashlr/daemon.launchd.err.log</string>
</dict>
</plist>
```

`KeepAlive` does not bypass the control-aware supervisor. A bare unconditional
launchd relaunch cannot inspect pause, Stop or admission. The owner supervisor
must handle clean exits as well as errors through its authorized recovery path.

## Exact Masbot Mac steps

These steps are for the owner-operated Mac after the protected follow-ups above
are reviewed and included in the qualified `current` release. They are not a
claim that this worktree can activate the current Mac safely.

1. In the owner's normal terminal, confirm the selected release contains the new
   command. These commands neither inspect Codex auth nor print environment values.

   ```sh
   test -L "$HOME/.local/share/ashlr/current"
   "$HOME/.local/share/ashlr/current/bin/ashlr" daemon health --help
   "$HOME/.local/share/ashlr/current/bin/ashlr" authority resident status
   "$HOME/.local/share/ashlr/current/bin/ashlr" daemon health --json
   ```

2. Install through the authorized resident path and its interactive confirmation.
   This path installs the launchd plist, verifies it and records the operation.
   A refusal is a blocker, not permission to write the plist directly.

   ```sh
   "$HOME/.local/share/ashlr/current/bin/ashlr" authority resident start
   /usr/bin/plutil -lint "$HOME/Library/LaunchAgents/ai.ashlr.daemon.plist"
   /usr/libexec/PlistBuddy -c 'Print :ProgramArguments' "$HOME/Library/LaunchAgents/ai.ashlr.daemon.plist"
   ```

   Verify the launcher argument is the absolute `current/bin/ashlr` path and
   neither fixed `--parallel 1` nor `--budget 50` is present. Stop this procedure
   if the installed renderer still emits a pinned release or fixed overrides.

3. For an owner-authorized maintenance kickstart of that already admitted service,
   the native command is below. The autonomous supervisor must use the protected
   resident recovery path instead of invoking this as an authority bypass.
   Do not run this across pause, Stop, unknown state or a failed admission.

   ```sh
   /bin/launchctl kickstart -k "gui/$(id -u)/ai.ashlr.daemon"
   ```

4. Verify with the selected binary immediately and again after a normal tick.

   ```sh
   "$HOME/.local/share/ashlr/current/bin/ashlr" daemon health --json
   "$HOME/.local/share/ashlr/current/bin/ashlr" daemon service-status --json
   ```

   Require `alive: true`, fresh log metadata, a progressing `lastTickAt`, no
   restart recommendation, and the expected resolved adapter identities. Also
   verify a real admitted planning call separately. Resolved metadata alone
   cannot prove successful Codex, Grok or oMLX inference.

See [resident runtime](RESIDENT-RUNTIME.md) for the existing installation and
activation contract. Preserve these steps and the protected follow-up blockers
in the eventual PR body. This job leaves source changes uncommitted; publishing
or running `publish.sh` is outside its authorization.
