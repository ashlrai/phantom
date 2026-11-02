# CLI agent readiness

Scores for every top-level `phm` command (the `ashlr` binary dispatches the same commands). 0 is missing, 1 is partial, 2 is met. This file records the static scan from this change and the rows the change moves.

The repository default branch is `master`. There is no `main` branch.

## How a cell was scored

The scan read `TOP_LEVEL_COMMANDS` in `src/cli/completions.ts` (104 commands) and the handler each `case` in `src/cli/index.ts` loads. Commands implemented in `src/cli/index.ts` were scored from that function's text. `doctor` and `init` were scored from `cmdDoctor` and `cmdInit`. Every other command was scored from its module.

| Column | 2 | 1 | 0 |
| --- | --- | --- | --- |
| 1 Non-interactive | No `question(` or `setRawMode(`, or the handler checks `stdin.isTTY` |  | A prompt call with no `stdin.isTTY` check |
| 2 JSON | `--json` appears and the handler has an exit 2 path | `--json` appears and no exit 2 path was seen | No `--json` |
| 3 Help | A usage or `--help` string and a `phm` or `ashlr` example | Usage or `--help` only | Neither |
| 4 Errors | An exit 2 path and a usage or example string | An `error:` or `die(` and no exit 2 path | Neither |
| 5 Idempotent | The text contains `already`, or no direct write call was seen | A direct write call and no `already` |  |
| 6 Dry-run | `--dry-run` appears, or no direct write call was seen |  | A direct write call and no `--dry-run` |

A direct write call is `saveConfig(`, `writeFileSync(`, `mkdirSync(`, `applyTidy(`, `unlinkSync(`, or `rmSync(`. A 2 on columns 5 or 6 can mean the scan did not see one of those calls. A callee can still write. The corrections below are cells changed after reading the handler.

Prompt sites were read in addition to the scan. Under `src/cli`, every `question(` and `setRawMode(` returns before reading stdin when stdin is not a terminal, except `plugins enable` before this change. That command gated the prompt on stdout (`isTty()`), so a terminal stdout and a piped stdin could block in `readline`.

Raw scan totals, max 208 per column: non-interactive 204, JSON 178, help 196, errors 190, idempotent 203, dry-run 192.

## Corrections applied to the raw scan

These cells are the ones in the tables. The raw scan number is in parentheses when it differed.

| Command | Cell | Published | Why |
| --- | --- | --- | --- |
| plugins | help, errors, idempotent | 1, 1, 1 (raw 2, 2, 2) | Short help omitted `--json` on `info`. Non-terminal enable exited 1 and did not print the full command. `init` says the manifest already exists and exits 1. |
| x | all six | 2, 0, 1, 1, 1, 0 | `cmdX` does not prompt. The raw 0 on non-interactive came from sharing `plugins.ts`. `x` has no `--json` and no `--dry-run`. Help is the short block in `cmdX`. An unknown command exits 1 and names `plugins list`. |
| website | JSON, dry-run | 2, 0 (raw 0, 2) | `cmdWebsite` prints one `JSON.stringify` value on stdout for `status`, `auto`, `pause`, `off`, `request`, `run`, `prepare`, and `commission`. There is no `--json` flag. `auto`, `pause`, `off`, `prepare`, and `commission` change state and have no `--dry-run`. |
| index, go, status, ls, open | dry-run | 0 (raw 2) | `requireIndex` and `cmdIndex` write `index.json` when the index is missing. The handler slices do not contain the write calls above. |
| config | dry-run | 0 (raw 2) | `config set` calls `persistConfigSet`, which calls `saveConfig`. There is no `--dry-run`. |

Published totals before this change, max 208: non-interactive 206, JSON 178, help 194, errors 188, idempotent 201, dry-run 178.

## Scores before this change

| Column key | Meaning |
| --- | --- |
| 1 | Non-interactive |
| 2 | JSON |
| 3 | Help |
| 4 | Errors |
| 5 | Idempotent |
| 6 | Dry-run |

| Command | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| index | 2 | 0 | 2 | 0 | 2 | 0 |
| go | 2 | 0 | 0 | 1 | 2 | 0 |
| status | 2 | 2 | 2 | 2 | 2 | 0 |
| ls | 2 | 0 | 0 | 1 | 2 | 0 |
| open | 2 | 0 | 0 | 1 | 2 | 0 |
| tidy | 2 | 1 | 0 | 0 | 2 | 2 |
| config | 2 | 2 | 2 | 2 | 2 | 0 |
| doctor | 2 | 2 | 2 | 2 | 2 | 2 |
| companions | 2 | 2 | 2 | 2 | 2 | 2 |
| team | 2 | 2 | 2 | 2 | 2 | 2 |
| steward | 2 | 2 | 2 | 2 | 2 | 2 |
| improve | 2 | 2 | 2 | 2 | 2 | 2 |
| init | 2 | 2 | 2 | 2 | 2 | 2 |
| setup | 2 | 2 | 0 | 2 | 2 | 2 |
| mcp | 2 | 2 | 2 | 2 | 2 | 0 |
| run | 2 | 2 | 2 | 2 | 2 | 2 |
| runs | 2 | 2 | 2 | 2 | 2 | 2 |
| eval | 2 | 2 | 2 | 2 | 2 | 2 |
| pulse | 2 | 2 | 2 | 2 | 1 | 2 |
| pulse-export | 2 | 2 | 2 | 2 | 1 | 2 |
| pulse-test | 2 | 2 | 2 | 2 | 1 | 2 |
| new | 2 | 2 | 2 | 2 | 2 | 2 |
| ship | 2 | 2 | 2 | 2 | 2 | 2 |
| recall | 2 | 2 | 2 | 2 | 2 | 2 |
| learn | 2 | 2 | 2 | 2 | 2 | 2 |
| genome | 2 | 2 | 2 | 2 | 2 | 2 |
| update | 2 | 2 | 2 | 2 | 2 | 2 |
| upgrade | 2 | 2 | 2 | 2 | 2 | 2 |
| desktop | 2 | 0 | 2 | 2 | 2 | 2 |
| desktop-update | 2 | 2 | 2 | 2 | 2 | 2 |
| spec | 2 | 2 | 2 | 2 | 2 | 2 |
| swarm | 2 | 2 | 2 | 2 | 2 | 2 |
| swarms | 2 | 2 | 2 | 2 | 2 | 2 |
| tui | 2 | 0 | 2 | 1 | 2 | 2 |
| dash | 2 | 0 | 2 | 1 | 2 | 2 |
| dashboard | 2 | 2 | 2 | 2 | 2 | 0 |
| serve | 2 | 1 | 2 | 1 | 2 | 2 |
| models | 2 | 2 | 2 | 2 | 2 | 2 |
| gh | 2 | 2 | 2 | 2 | 2 | 2 |
| vercel | 2 | 2 | 2 | 2 | 2 | 2 |
| website | 2 | 2 | 2 | 2 | 2 | 0 |
| wire | 2 | 2 | 2 | 2 | 2 | 2 |
| notify | 2 | 2 | 2 | 2 | 2 | 2 |
| telemetry | 2 | 2 | 2 | 2 | 2 | 2 |
| sandbox | 2 | 2 | 2 | 2 | 2 | 2 |
| audit | 2 | 2 | 2 | 2 | 2 | 2 |
| enroll | 2 | 2 | 2 | 2 | 2 | 2 |
| backlog | 2 | 2 | 2 | 2 | 2 | 2 |
| inbox | 2 | 2 | 2 | 2 | 2 | 2 |
| daemon | 2 | 2 | 2 | 2 | 2 | 2 |
| worker | 2 | 0 | 2 | 1 | 2 | 0 |
| ask | 2 | 2 | 2 | 2 | 2 | 2 |
| knowledge | 2 | 2 | 2 | 2 | 2 | 2 |
| reflect | 2 | 2 | 2 | 2 | 2 | 2 |
| health | 2 | 2 | 2 | 2 | 2 | 2 |
| goals | 2 | 2 | 2 | 2 | 2 | 2 |
| fleet | 2 | 2 | 2 | 2 | 2 | 2 |
| recovery | 2 | 2 | 2 | 2 | 2 | 2 |
| manager | 2 | 2 | 2 | 2 | 2 | 2 |
| vision | 2 | 2 | 2 | 2 | 2 | 2 |
| goal | 2 | 2 | 2 | 2 | 2 | 2 |
| loop | 2 | 0 | 2 | 2 | 2 | 2 |
| roadmap | 2 | 2 | 2 | 2 | 2 | 2 |
| stack | 2 | 2 | 2 | 2 | 2 | 2 |
| ecosystem | 2 | 2 | 2 | 2 | 2 | 2 |
| digest | 2 | 2 | 2 | 2 | 2 | 2 |
| seams | 2 | 2 | 2 | 2 | 2 | 2 |
| verify-safety | 2 | 2 | 2 | 2 | 2 | 2 |
| verify-pr | 2 | 2 | 2 | 2 | 1 | 0 |
| release-articles | 2 | 2 | 2 | 2 | 2 | 2 |
| preflight | 2 | 2 | 2 | 2 | 2 | 2 |
| conductor-permit | 2 | 0 | 2 | 2 | 2 | 2 |
| onboard | 2 | 2 | 2 | 2 | 2 | 2 |
| demo | 2 | 2 | 2 | 2 | 2 | 2 |
| orient | 2 | 2 | 2 | 2 | 2 | 2 |
| docs | 2 | 2 | 2 | 2 | 2 | 2 |
| completions | 2 | 1 | 2 | 0 | 2 | 2 |
| plugins | 0 | 2 | 1 | 1 | 1 | 0 |
| x | 2 | 0 | 1 | 1 | 1 | 0 |
| comms | 2 | 2 | 2 | 2 | 2 | 2 |
| director | 2 | 0 | 2 | 0 | 2 | 2 |
| best-of-n | 2 | 2 | 2 | 2 | 2 | 2 |
| invent | 2 | 2 | 2 | 2 | 2 | 2 |
| resources | 2 | 2 | 2 | 2 | 2 | 2 |
| usage | 2 | 2 | 2 | 2 | 2 | 2 |
| version | 2 | 0 | 0 | 0 | 2 | 2 |
| help | 2 | 2 | 2 | 2 | 2 | 2 |
| skills | 2 | 2 | 2 | 2 | 2 | 2 |
| universe | 2 | 2 | 2 | 2 | 2 | 2 |
| runtime | 2 | 2 | 2 | 2 | 2 | 2 |
| verse | 2 | 1 | 2 | 1 | 2 | 2 |
| local-runtime | 2 | 2 | 2 | 2 | 2 | 2 |
| authority | 2 | 2 | 2 | 2 | 2 | 2 |
| leader | 2 | 2 | 2 | 2 | 2 | 0 |
| mirror | 2 | 2 | 2 | 2 | 2 | 2 |
| cloud | 2 | 2 | 2 | 2 | 2 | 2 |
| devin | 2 | 2 | 2 | 2 | 2 | 2 |
| openai-agents | 2 | 2 | 2 | 2 | 2 | 2 |
| benchmark | 2 | 2 | 2 | 2 | 2 | 2 |
| automations | 2 | 2 | 2 | 2 | 2 | 2 |
| jev | 2 | 2 | 2 | 2 | 2 | 2 |
| wiki | 2 | 2 | 2 | 2 | 2 | 2 |
| playbook | 2 | 2 | 2 | 2 | 1 | 0 |
| receipt | 2 | 2 | 2 | 2 | 2 | 2 |


## Scores after this change

Published totals, max 208: non-interactive 208, JSON 178, help 195, errors 191, idempotent 201, dry-run 180.

`go`, `open`, and `plugins` are the rows that move. Every other row matches the before table.

| Command | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| index | 2 | 0 | 2 | 0 | 2 | 0 |
| go | 2 | 0 | 0 | 2 | 2 | 0 |
| status | 2 | 2 | 2 | 2 | 2 | 0 |
| ls | 2 | 0 | 0 | 1 | 2 | 0 |
| open | 2 | 0 | 0 | 2 | 2 | 0 |
| tidy | 2 | 1 | 0 | 0 | 2 | 2 |
| config | 2 | 2 | 2 | 2 | 2 | 0 |
| doctor | 2 | 2 | 2 | 2 | 2 | 2 |
| companions | 2 | 2 | 2 | 2 | 2 | 2 |
| team | 2 | 2 | 2 | 2 | 2 | 2 |
| steward | 2 | 2 | 2 | 2 | 2 | 2 |
| improve | 2 | 2 | 2 | 2 | 2 | 2 |
| init | 2 | 2 | 2 | 2 | 2 | 2 |
| setup | 2 | 2 | 0 | 2 | 2 | 2 |
| mcp | 2 | 2 | 2 | 2 | 2 | 0 |
| run | 2 | 2 | 2 | 2 | 2 | 2 |
| runs | 2 | 2 | 2 | 2 | 2 | 2 |
| eval | 2 | 2 | 2 | 2 | 2 | 2 |
| pulse | 2 | 2 | 2 | 2 | 1 | 2 |
| pulse-export | 2 | 2 | 2 | 2 | 1 | 2 |
| pulse-test | 2 | 2 | 2 | 2 | 1 | 2 |
| new | 2 | 2 | 2 | 2 | 2 | 2 |
| ship | 2 | 2 | 2 | 2 | 2 | 2 |
| recall | 2 | 2 | 2 | 2 | 2 | 2 |
| learn | 2 | 2 | 2 | 2 | 2 | 2 |
| genome | 2 | 2 | 2 | 2 | 2 | 2 |
| update | 2 | 2 | 2 | 2 | 2 | 2 |
| upgrade | 2 | 2 | 2 | 2 | 2 | 2 |
| desktop | 2 | 0 | 2 | 2 | 2 | 2 |
| desktop-update | 2 | 2 | 2 | 2 | 2 | 2 |
| spec | 2 | 2 | 2 | 2 | 2 | 2 |
| swarm | 2 | 2 | 2 | 2 | 2 | 2 |
| swarms | 2 | 2 | 2 | 2 | 2 | 2 |
| tui | 2 | 0 | 2 | 1 | 2 | 2 |
| dash | 2 | 0 | 2 | 1 | 2 | 2 |
| dashboard | 2 | 2 | 2 | 2 | 2 | 0 |
| serve | 2 | 1 | 2 | 1 | 2 | 2 |
| models | 2 | 2 | 2 | 2 | 2 | 2 |
| gh | 2 | 2 | 2 | 2 | 2 | 2 |
| vercel | 2 | 2 | 2 | 2 | 2 | 2 |
| website | 2 | 2 | 2 | 2 | 2 | 0 |
| wire | 2 | 2 | 2 | 2 | 2 | 2 |
| notify | 2 | 2 | 2 | 2 | 2 | 2 |
| telemetry | 2 | 2 | 2 | 2 | 2 | 2 |
| sandbox | 2 | 2 | 2 | 2 | 2 | 2 |
| audit | 2 | 2 | 2 | 2 | 2 | 2 |
| enroll | 2 | 2 | 2 | 2 | 2 | 2 |
| backlog | 2 | 2 | 2 | 2 | 2 | 2 |
| inbox | 2 | 2 | 2 | 2 | 2 | 2 |
| daemon | 2 | 2 | 2 | 2 | 2 | 2 |
| worker | 2 | 0 | 2 | 1 | 2 | 0 |
| ask | 2 | 2 | 2 | 2 | 2 | 2 |
| knowledge | 2 | 2 | 2 | 2 | 2 | 2 |
| reflect | 2 | 2 | 2 | 2 | 2 | 2 |
| health | 2 | 2 | 2 | 2 | 2 | 2 |
| goals | 2 | 2 | 2 | 2 | 2 | 2 |
| fleet | 2 | 2 | 2 | 2 | 2 | 2 |
| recovery | 2 | 2 | 2 | 2 | 2 | 2 |
| manager | 2 | 2 | 2 | 2 | 2 | 2 |
| vision | 2 | 2 | 2 | 2 | 2 | 2 |
| goal | 2 | 2 | 2 | 2 | 2 | 2 |
| loop | 2 | 0 | 2 | 2 | 2 | 2 |
| roadmap | 2 | 2 | 2 | 2 | 2 | 2 |
| stack | 2 | 2 | 2 | 2 | 2 | 2 |
| ecosystem | 2 | 2 | 2 | 2 | 2 | 2 |
| digest | 2 | 2 | 2 | 2 | 2 | 2 |
| seams | 2 | 2 | 2 | 2 | 2 | 2 |
| verify-safety | 2 | 2 | 2 | 2 | 2 | 2 |
| verify-pr | 2 | 2 | 2 | 2 | 1 | 0 |
| release-articles | 2 | 2 | 2 | 2 | 2 | 2 |
| preflight | 2 | 2 | 2 | 2 | 2 | 2 |
| conductor-permit | 2 | 0 | 2 | 2 | 2 | 2 |
| onboard | 2 | 2 | 2 | 2 | 2 | 2 |
| demo | 2 | 2 | 2 | 2 | 2 | 2 |
| orient | 2 | 2 | 2 | 2 | 2 | 2 |
| docs | 2 | 2 | 2 | 2 | 2 | 2 |
| completions | 2 | 1 | 2 | 0 | 2 | 2 |
| plugins | 2 | 2 | 2 | 2 | 1 | 2 |
| x | 2 | 0 | 1 | 1 | 1 | 0 |
| comms | 2 | 2 | 2 | 2 | 2 | 2 |
| director | 2 | 0 | 2 | 0 | 2 | 2 |
| best-of-n | 2 | 2 | 2 | 2 | 2 | 2 |
| invent | 2 | 2 | 2 | 2 | 2 | 2 |
| resources | 2 | 2 | 2 | 2 | 2 | 2 |
| usage | 2 | 2 | 2 | 2 | 2 | 2 |
| version | 2 | 0 | 0 | 0 | 2 | 2 |
| help | 2 | 2 | 2 | 2 | 2 | 2 |
| skills | 2 | 2 | 2 | 2 | 2 | 2 |
| universe | 2 | 2 | 2 | 2 | 2 | 2 |
| runtime | 2 | 2 | 2 | 2 | 2 | 2 |
| verse | 2 | 1 | 2 | 1 | 2 | 2 |
| local-runtime | 2 | 2 | 2 | 2 | 2 | 2 |
| authority | 2 | 2 | 2 | 2 | 2 | 2 |
| leader | 2 | 2 | 2 | 2 | 2 | 0 |
| mirror | 2 | 2 | 2 | 2 | 2 | 2 |
| cloud | 2 | 2 | 2 | 2 | 2 | 2 |
| devin | 2 | 2 | 2 | 2 | 2 | 2 |
| openai-agents | 2 | 2 | 2 | 2 | 2 | 2 |
| benchmark | 2 | 2 | 2 | 2 | 2 | 2 |
| automations | 2 | 2 | 2 | 2 | 2 | 2 |
| jev | 2 | 2 | 2 | 2 | 2 | 2 |
| wiki | 2 | 2 | 2 | 2 | 2 | 2 |
| playbook | 2 | 2 | 2 | 2 | 1 | 0 |
| receipt | 2 | 2 | 2 | 2 | 2 | 2 |


## What this change does

`plugins enable` returns immediately when stdin is not a terminal. Exit code 2. Stderr names the command to run. `--json` also writes one object on stdout: `ok` false, `enabled` false, `already` false, `dryRun` false, and `error` with the same command. Stdout being a terminal does not open the prompt.

`init`, `enable`, and `disable` accept `--dry-run`. The flag writes no plugin files and does not call `saveConfig`. `--json` shapes:

`plugins list --json` prints an array. Each item has `dir`, `name`, `ok`, `enabled`, `capabilities`, and, when present, `reason` and `version`.

`plugins info --json` prints the discovery record: `dir`, `ok`, optional `reason`, and `manifest` (`name`, `version`, `apiVersion`, `entry`, `capabilities`, optional `description` and `homepage`).

`plugins init --json` prints `created`, `dryRun`, `name`, `capability`, and `dir`. A real init has `created` true and `dryRun` false. `--dry-run` has `created` false and `dryRun` true and does not create the directory.

`plugins enable --json` on success prints `ok` true, `enabled` true, `name`, `integrity` (`sha256:` plus 64 hex digits), `already`, and `dryRun`. The same pin a second time sets `already` true and does not rewrite config. `--dry-run` sets `dryRun` true and does not write config.

`plugins disable --json` prints `ok` true, `enabled` false, `name`, `already`, and `dryRun`. A name that is not enabled sets `already` true, exits 0, and does not create config. `--dry-run` of an enabled name sets `dryRun` true and leaves config bytes unchanged.

`phm plugins --help` lists each verb, the flags, and examples. `phm help plugins` includes the same flags in the command table.

`go` and `open`, when the picker returns null because stdin or stdout is not a terminal, keep the words `Nothing selected.` and add the reason plus a command. No query and a non-empty index exits 2. An empty index exits 1 and names `phm status`. A terminal cancel stays `Nothing selected.` and exits 1.

`plugins init` of an existing manifest still exits 1 and does not overwrite. `test/m33.plugin-init.test.ts` pins that exit code. The message now names `phm plugins enable <name> --yes`.

Examples:

```
phm plugins list --json
phm plugins info demo --json
phm plugins init my-scanner --capability scanner --dry-run
phm plugins enable my-scanner --dry-run
phm plugins enable my-scanner --yes --json
phm plugins disable my-scanner --dry-run
phm go <name> --cd
phm open <name>
phm status
```

## Follow-ups

These were read and left unchanged.

- `config get` prints a raw scalar, or `<redacted>` for a sensitive leaf. It has no `--json` object. `config set` has no `--dry-run`.
- `index`, `go`, `status`, `ls`, and `open` write a missing index. They have no `--dry-run`. `go`, `ls`, and `open` have no `--json`. `index`, `go`, `status`, `ls`, `open`, `tidy`, and `config` still run when given `--help`. The pinned list is `KNOWN_HELP_ACTS` in `test/cli-help-no-side-effects.test.ts`.
- `plugins init` exits 1 when the scaffold already exists, so the plugins idempotent score stays 1.
- A declined `plugins enable` prompt exits 0.
- `stack add` and `stack apply` exit 2 when stdout is not a terminal and `--yes` is absent. When stdout is a terminal and stdin is not, `promptConfirm` returns false without reading stdin and the command exits 0 with `Aborted`.
- `website` `auto`, `pause`, `off`, `prepare`, and `commission` change state and have no `--dry-run`. `commission` requires `--yes`.
- `x` runs an enabled plugin command. It has no `--json` and no `--dry-run`.
- `worker` has no `--json` and no `--dry-run` (scan scores 0, 0). `loop`, `conductor-permit`, and `director` have no `--json`. `leader` and `playbook` scored 0 on dry-run because the module text has a direct write and no `--dry-run`.
