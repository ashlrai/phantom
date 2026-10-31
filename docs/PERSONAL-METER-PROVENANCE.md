# Personal meter provenance

For an installed Phantom, inspect the personal Codex reading directly:

```sh
phm resources personal
phm resources personal --json
phm resources ledger --json
```

`personal` reads local Codex session evidence from `~/.codex-2` by default,
labels it `codex-personal`, and does not write usage history or contact a
provider. Use `--home <absolute-path>` only when the personal session home is
elsewhere. The path must be a non-root absolute path without `..` or a `.codex`
component; inherited `CODEX_HOME` and `CODEX_HOME_ALT` do not select the home
for this command. `personal` supports `--json`, `--home`, and `--help`/`-h`;
it has no watch option. Its exit code is 0 for a current reading, 1 for stale
or unavailable evidence, and 2 for invalid arguments.

Read **Session** and **Weekly** as separate windows, each with its own used
percentage and reset. For example, a weekly 46% can remain 46% after a small
amount of coding even as the session figure changes; the figures are not
interchangeable. In JSON, compare `resources[].session` with
`resources[].weekly`, including `usedPct` and `resetsAt`. An unavailable window
or unknown reset is unknown, not zero. The personal command has no stored
history for computing burn, so an unknown burn or projection is expected.

Check `resources[].observedAt` and `state` before relying on a reading; a
future timestamp is not trustworthy. The
observation is taken from the rate-limit event timestamp; if no usable event
timestamp is available, the collector falls back to the session file's
modification time. The latter is a weaker time indication. `generatedAt` is
when Phantom constructed the report, not when the provider supplied the
reading. A reading over 24 hours old is `stale`; a missing usable window is
`unavailable`. Even `current` is local evidence, not a guarantee of a newly
refreshed provider sample. A busy lane or recent code activity alone does not
prove that a new quota sample arrived. If the timestamp has not advanced, treat
the displayed percentage as the last observation, not proof of current usage.

The ledger supplies lane and status context. Its `generatedAt` is report time;
its top-level `asOf` is the status tick, and `sources.status` describes source
health, not the age of a provider reading. For `codex-personal`, compare the
ledger's **weekly** value with the personal command's weekly value only. In
JSON, when `source` is `codex-personal-sessions`, the lane's
`observation.asOf` identifies the personal observation; top-level `asOf` still
identifies the status tick. The text ledger shows the source but not this
per-lane observation time, so use JSON for provenance.

The ledger replaces an existing personal lane's status value with a valid
personal weekly sample only when its observation is not in the future and is
strictly newer than the status tick. If the tick is unknown, it uses the sample
only when the status weekly value is also unknown. Equal, older, missing, or
incomparable evidence leaves the status value in place. A missing lane is not
created from session evidence. This ordering does not impose a 24-hour age
limit on the replacement: check the observation time independently, including
when the source says `codex-personal-sessions`. A status value without a usable
tick cannot be ranked by freshness. Missing or degraded sources, unknown values,
and stale observations should remain unknown or historical in an agent's
assessment; do not infer a fresh percentage from lane activity.

`phm resources ledger` also supports `--watch`, optionally with
`--interval-ms <1000..60000>` (default 5000 ms); watch with `--json` emits one
JSON object per line. Watch rereads local evidence; it does not itself ensure a
new provider sample. The ledger CLI reads its default `~/.ashlr-runs` data and
the default personal home. It has no CLI home or runs-directory option and
its reader does not consult `ASHLR_RUNS_DIR`; other commands may implement their
own overrides. A custom `personal --home` reading therefore need not match the
ledger's default personal home.

The ledger's Claude lane is weekly; Claude has no five-hour quota represented
by this ledger. Do not substitute a Codex session window for Claude usage or
infer access to an unreported provider meter. Availability and command options
depend on the installed version; use each command's `--help` if needed.
