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
Results use existing start/status/collect shapes; send-prompt returns
`{ok,handle}`. Result text is scrubbed. A provider failure never triggers a
second submission, because an ambiguous response might already have run.

The library's optional `AppPorts.desk` accepts the existing per-chat DESK
`ToolCall`, preserving access grants, secure-field refusal, confirmation and
KILL for embedders that already hold a live turn's call channel. It falls back
only when discovery succeeds with no matching seat, never on
authentication/network errors; desktop handles are prefixed `desk-TARGET:`.
The CLI does not wire a DESK credential yet: `phm drive` fails closed when no
seat matches, and Phantom never drives its own GUI. Binding the live-turn
bearer into the CLI is a new loopback client and waits for the Security pin
the original change called out; nothing here mints a grant or approves access.
