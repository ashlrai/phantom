# Main Health — is the default branch safe?

A **red main** means a PR landed, the main guardian ran post-merge
verification, and one or more CI checks **failed** on that merge commit.
The guardian writes `state: "red"` into `~/.ashlr-runs/guardian/state.json`
along with a `red_first` timestamp so every fleet member can see how long
each repo has been red. Red mains never auto-revert — they surface through
`main-health-needs-you` for an agent or human to act on.

## Check a repo in four seconds

```
ashlr fleet main-red-age
```
Reads `state.json` (or `--state <file>`) and prints each repo's state,
minutes red, attempt count and the current job driving repair. Exit `0`
when the state file is readable; `1` when it is missing or invalid.

## Read it over HTTP

`GET /api/verse/fleet/main-red-age` serves the same projection as
`main-red-age --json`: `{v, generatedAt, known, repos}` where each repo
carries `repo`, `state`, `redSince`, `redMinutes`, `attempts` and
`currentJob`. A missing or unreadable state file answers `200` with
`known: false` and no repos — unknown is never green. The Fleet surface
(⌘2) shows one compact row per repo under "Main health"; agents read the
typed route.

## How many merges rode red checks?

```
ashlr fleet red-merges [--hours 24] [--root <dir>] [--json]
```
Rolls up per-hour merge counts by red/green/other check state across
every lane from `metrics/jobs.jsonl`. Read-only — never dispatches or
mutates anything. Pass `--json` for machine-parseable output.

## Is the build clean right now?

```
npm run typecheck
```
Runs the full type-check suite; `0` means the tree compiles, `1` means
it does not. Pair with `ashlr fleet red-merges --hours 1` to spot
regressions the guardian has not yet caught.

## Guardian reference

Full guardian docs:
https://github.com/ashlrai/phantom/blob/master/docs/main-guardian.md

Source — `main-red-age`:
https://github.com/ashlrai/phantom/blob/master/src/cli/fleet-main-red-age.ts

Source — `red-merges`:
https://github.com/ashlrai/phantom/blob/master/src/cli/fleet-red-merges.ts
