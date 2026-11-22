# Runtime-dynamic fleet config

Change fleet limits without restarting dispatchd or any reader. Source:
[dynconfig.ts](../src/core/fleet/dynconfig.ts), CLI `phm fleet config`.

## Layers

Lowest to highest precedence:

1. pinned defaults (in code)
2. `~/.ashlr-runs/queue/slots.json`
3. `~/.ashlr-runs/queue/budget-overrides.json`
4. live control file `~/.ashlr-runs/queue/live-config.json`
5. one-shot CLI (`phm fleet config get --override key=value`, never persisted)

With no live file and no CLI override, every value equals what the existing
files say, so existing readers behave unchanged.

## Commands

```bash
phm fleet config get [<key>] [--override <key=value>] [--json]
phm fleet config set <key> <value> --reason <text> [--by <actor>]
phm fleet config unset <key> --reason <text> [--by <actor>]
phm fleet config audit [--limit <n>] [--json]
phm fleet config restart-required [--json]
```

`set` and `unset` require `--reason`. `get` shows which layer won each key.

## Mutable keys

`hard_cap`, `autofill.off` (1 stops self-tick autofill; see QUEUE.md), `empty_stop.off` (1 stops the hourly empty-family stop in self-tick), `lanes.<lane>.target|floor|ceiling|hard_cap`,
`compact.lanes.raise_freeze_below_gb`, `compact.lanes.halve_below_gb`.
`mason.digest.off` (1 stops the hourly owner digest in self-tick).
The `order-notices` step posts at most once an hour, only when news changes. Run
`phm fleet mason-digest [--since 1h] [--post] [--json]` or `phm mason digest` for a manual digest;
without `--post` it only prints the report. Posting records a local owner-thread
notice at most once an hour and never invokes a channel transport.
Anything else is refused. Lane `target`/`floor`/`ceiling` writes are checked
for coherence against the effective sibling values.

## Restart required (never runtime-mutable)

Refused by `set`/`unset`, and ignored by readers even if hand-edited into
`live-config.json` or passed with `--override`. Deny wins over the allowlist.

| Category | Matches (any dotted segment) |
| --- | --- |
| security pins | `security`, `pin(s)`, `pinned`, `allowlist`, `denylist`, `sandbox`, `owner*` |
| paid-model blocks | `paid*`, `billing*`, anything containing `block` |
| credential paths | `cred*`, `secret*`, `token*`, `keychain`, `password`, `api_key`, `auth*`, and `*_path`, `*_file`, `*_dir` |
| GATES files | any `gate`/`gates` segment (`GATES`, `merge_gates`) |

Change these by editing the source file as the owner and restarting.

## Atomicity and reload

- Writes take `queue/.live-config.lock`, write a temp file, fsync, and rename
  over `live-config.json`. A reader sees the old file or the new one, never a mix.
- A reader re-parses a file only when its mtime, size or inode changes. A torn
  or corrupt file keeps the last good values and reports the layer `degraded`.
- The writer refuses to overwrite a corrupt `live-config.json`, and refuses the
  change if the audit log cannot be opened (no unaudited writes).
- Wired today: `phm fleet disk` and `phm fleet disk-sweep` read the
  `compact.lanes.*` lines through the live layer. dispatchd and other external
  readers can read `live-config.json` directly or call
  `phm fleet config get --json`.

## Audit

`live-config.json` carries `last_change_by` (`<actor> <iso>`) and, per key,
`value`, `by`, `at`, `reason`. Each change also appends one JSON line to
`queue/live-config-audit.jsonl` (`schema fleet.config.audit.v1`):
`{v, at, op, key, from, to, by, reason}`. Read both with
`phm fleet config audit --json`.
