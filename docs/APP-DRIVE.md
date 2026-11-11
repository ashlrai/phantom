# Drive agent apps

`phm drive <devin|claude|codex|phantom> <action> --json` uses the running
Phantom console's existing session API. Its enrolled seats execute through
provider CLIs or APIs, preserving admission, budget and approval gates.
This does not launch a desktop application process. Start the console separately.

Supply the console's read and mutation tokens through `PHM_DRIVE_READ_TOKEN`
and `PHM_DRIVE_MUTATION_TOKEN` in your trusted launcher; never paste tokens into
commands or logs. `PHM_DRIVE_ORIGIN` defaults to `http://127.0.0.1:7777`.
Only HTTP numeric loopback is accepted; redirects are refused.

```sh
phm drive claude start --prompt 'Summarize this project' --json
phm drive codex start --prompt 'Review the tests' --json
phm drive devin start --prompt 'Review the tests' --json
# Phantom requires an explicit enrolled execution seat:
phm drive phantom start --seat codex-personal --prompt 'Summarize this project' --json
# Replace SESSION_ID with the handle returned by start, and use the same target:
phm drive claude status --handle SESSION_ID --json
phm drive claude send-prompt --handle SESSION_ID --prompt 'Focus on risks' --json
phm drive claude read-result --handle SESSION_ID --json
```

`--seat` selects an exact seat; `--project` selects the project directory.
Results use existing DESK start/status/collect shapes; send-prompt returns
`{ok,handle}`. Result text is scrubbed. Provider failures never trigger a second
submission through GUI, because an ambiguous response might already have run.

The library's optional `AppPorts.desk` accepts the existing per-chat DESK
`ToolCall`, preserving access grants, secure-field refusal, confirmation and
KILL. It falls back only when discovery succeeds with no matching seat, never
on authentication/network errors. Desktop handles are prefixed `desk-TARGET:`.
A trusted live chat launcher may supply `PHM_DRIVE_DESK_BEARER` to enable the
CLI fallback through the existing DESK MCP endpoint. This bearer must belong to
an active turn with computer grants; drive never mints it or approves access.
Without that bearer a missing seat fails closed. Phantom never drives its own GUI. No TCC helper or server binding is
modified. Security (606e84d2) must review and pin this new loopback client before
merge; these changes do not constitute that review.
