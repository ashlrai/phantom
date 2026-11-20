# CI baseline analyzer

Run `phm ci baseline --json` to inspect open PRs in ashlrai/phantom. Use
`--repo owner/repo` for another repository with a master branch. Analysis is
read-only: it does not rerun jobs, change tests, merge PRs, or update branches.

The version 1 JSON report contains failure groups, per-PR freshness, master
evidence, unknown reasons, and proposed update-branch commands. Latest workflow
runs are checked against the current head and full checkout SHA in job logs.
Unreadable, incomplete, capped, or unverified logs are unknown, never clean.
Vitest FAIL lines -- including named-project labels such as `|unit|` or `|console|` --
identify tests under `test/` and `src/web-ui/`; AssertionError summaries are scrubbed
and capped at 2,000 characters per failure, with at most 100 failures per log.
A suite that fails to load (transform, parse, or collection error) prints
`FAIL <file> [ <file> ]` with no test name; these group under the
`<file> > (suite)` identity, capture the suite's error line, and count as
passing on master when the file shows any verbose pass -- the file loading
and running is what resolves a suite failure.
TypeScript diagnostics from `tsc`/`tsgo` non-pretty output
(`src/core/foo.ts(41,9): error TS2322: ...`) group per file under a
`<file> > (typecheck)` identity: a typecheck or build break prints no vitest
FAIL lines, so without this shape a red master marked every open PR unknown
and queued no fix. Diagnostics without a repo-relative file path (global
errors such as TS2688), escaping paths and absolute paths stay unparsed, and
every diagnostic line for one file merges into a single failure excerpt. A
`(typecheck)` identity can never be resolved by a vitest pass line, so these
groups classify as `shared-baseline`, `pr-caused` or `unknown` -- never
`probable-flake`.

The `.github/tests/*.test.mjs` contract suites run under `node --test`, which
prints TAP on the Node 22 CI image. `not ok N - name` results resolve their
file from the diagnostic block's absolute `location:` path through the
`/<work>/<repo>/<repo>/` Actions checkout marker, rebuild nested describe
paths as `suite > test > leaf`, skip derivative `cancelledByParent` and
`subtestsFailed` records, and group file-level load failures under the same
`<file> > (suite)` identity as Vitest suite loads, capturing the runner's `#`
comment diagnostic. Results with no resolvable checkout-scoped location, TAP
`ok` results (which carry no location), and runners on nonstandard work
directories stay unparsed. Because `ok` results carry no file attribution, a
node:test failure classifies as `shared-baseline`, `pr-caused` or `unknown`
only -- never `probable-flake` -- and `master` reads `fail` or `unknown`,
never `pass`.

`npm run check:docs` prints its verdict as one pretty-printed JSON document
(`{` and `}` at column 0) and exits 1 when `ok` is false; each `errors` entry
names the entrypoint file, the offending `href` (null for document-level
problems) and a reason. Errors group per file under a `<file> > (docs-check)`
identity with up to eight `href: reason` lines per excerpt. A broken doc link
on master fails the `ci` and `docs` jobs on every open PR, so without this
shape a red master marked every PR unknown; like `(typecheck)` it can never
resolve through a vitest pass line and classifies `shared-baseline`,
`pr-caused` or `unknown` -- never `probable-flake`. Passing reports
(`ok: true`, empty `errors`), malformed JSON blocks, escaping or absolute
paths, and unrelated JSON stay unparsed. Failure files that are not code
(`.md`, `.json`, assets) have no import closure: their dependency set is the
file itself, so import-looking prose in a document cannot fail the closure
closed.

The Merge Gate `clean-tree` job ("Check generated files") reruns the
tracked-file generators and fails on any dirty `git status --porcelain`
path, printing `generated files are stale; commit the regenerated tree:`
followed by porcelain rows; its `canonical-launcher-digests.mjs --check`
prints `current launcher digest <sha> is missing from the canonical
launcher digest list`, `canonical launcher digest list is invalid`, or the
`--check-history` differs line. Each stale path groups under a
`<file> > (generated)` identity and the digest failures under
`scripts/canonical-launcher-digests.json > (generated)`; rename rows resolve
to the new path and C-quoted paths are unescaped, while unparseable rows
stay unparsed. Generated artifacts have no import closure either, but their
staleness has a known input set: `docs/llms.txt` depends on
`docs/llms-source.txt`, `scripts/generate-docs-llms.mjs`,
`scripts/lib/docs-pages.mjs` and every public docs page (`docs/**/*.md`
minus `docs/internal/`, read once from the master tree listing -- an
unreadable or truncated listing fails the closure closed), and the digest
manifest depends on `bin/ashlr`. Like `(typecheck)` they can never resolve
through a vitest pass line, so they classify `shared-baseline`,
`pr-caused` or `unknown` -- never `probable-flake`.

`npm run build` opens with `npm run check:version`
(`scripts/sync-candidate-version.mjs --check`), the release-metadata gate:
a version bump that reached only some of the tracked files prints one
compact JSON drift report -- `{"version": ..., "changed": [...],
"matches": false, "check": true}` naming the stale files -- and exits 1,
while a structural break (missing file, renamed field, ambiguous URL)
prints `sync-candidate-version: <message>` instead. Both group under
`scripts/sync-candidate-version.mjs > (version-sync)`. The gate reads
exactly the script and the ten metadata files it rewrites, so the
dependency set is that closed input list (seeded as static inputs) and
the vitest harness ambient set does not apply; like the other non-test
identities it can never resolve through a vitest pass line and classifies
`shared-baseline`, `pr-caused` or `unknown` -- never `probable-flake`.
Passing reports (`matches: true`), write-mode results, empty or unknown
`changed` entries, non-semver versions, malformed or multi-line JSON, and
unrelated output stay unparsed.

The advisory `perf-budget` workflow times the cold paths in
`perf/budgets.json` and prints one pretty-printed
`ashlr.perf-budget-report.v1` JSON document before exiting non-zero.
Each `fail` result
(median over baseline + tolerance) and each `error` result (preflight
break, command timeout, measurement failure) groups per target under
`<budgets file> > (perf-budget) <target id>` -- per-target identities keep
unrelated targets from merging into one group, and `skip` (absent
optional tools) and `pass` results carry no failure. The budgets file is
the unit a master fix restores (re-baseline with `--update-baseline` or
speed the path up); its dependency set is the budgets file plus the
gate's direct inputs -- `bin/ashlr`, `scripts/perf-budget.mjs` and
`scripts/perf-mcp-tools-list.mjs` -- while the measured CLI graph
(`src/**` built to `dist/`) has no enumerable closure, so deeper source
changes stay unattributed. Dependency manifests and toolchain configs
still count through the harness ambient set. Like the other non-test
identities it can never resolve through a vitest pass line and classifies
`shared-baseline`, `pr-caused` or `unknown` -- never `probable-flake`.
Passing reports (`ok: true` or only pass/skip results), other schemas,
malformed or multi-line blocks, absolute or escaping `budgets` paths,
unknown statuses and unrelated JSON stay unparsed.

Two unaffected fresh PRs sharing a test produce `queue-master-fix` and a ready
brief. Test/import changes produce `pr-caused`; a singleton unaffected failure
with an explicit verbose test pass on master's current run produces
`rerun-failed`. Other evidence stays `unknown`. Relative imports are followed
transitively from master (100-file cap) with bundler resolution: `.js`/`.jsx`
specifiers map to `.ts`/`.tsx` sources, extensionless specifiers try file then
directory `index`, `?raw`/`?url`/`?inline` queries and non-code files (`.css`,
`.json`, assets) join the closure as leaves without recursion, and package
imports track dependency manifests. Independence also unions the runner
harness a test's own imports never see: each `vitest.config.*`/`vitest.workspace.*`
file whose literal `include` globs cover the suite (a config with none governs
every suite), that config's import closure, its `setupFiles`/`globalSetup`
entries and their closures, the nearest `tsconfig.json`/`jsconfig.json`
walking up from the test file, and the dependency manifests (which also cover
suites running without bare imports). An unreadable governing config, an
unresolvable or globbed setup entry, or a failed harness probe yields
`unknown`, never independence. A candidate that 404s tries the next
resolution; any other fetch failure, unresolvable spec, alias, or computed
import prevents independence claims. Nonverbose pass output does not
establish an individual test pass. The scan caps open PRs, runs, and jobs
at 100 each and reports unknown rather than drawing conclusions from truncated
run/job listings. Master reproduction remains an explicit step in the fix brief.

`phm ci baseline --queue --json` appends only master-fix briefs to
`~/.ashlr-runs/queue/router-queue.md`, at tier `work`, deduplicated by queue
state per repository and test id: an open row suppresses queueing, and when
every earlier fix generation for the same test reached DONE while the failure
is still observed on current evidence, the next `RQ-CIBASE-*-G<n>` generation
is queued (at most three attempts per test). `--queue-file /absolute/path`
overrides that file. Queueing is an explicit local write independent of
`--apply`; no other group is queued.

Update-branch commands are always plans by default. `--apply` executes them only
when the exact test explicitly passes on current master and a merged master PR
with the deterministic job id in its body has a merge commit reachable from
master. Missing provenance means skip. The API receives `expected_head_sha` so a
changed PR head is not silently updated. A passing master test alone is not proof
of a merged fix. Rerun proposals are never executed by this command.

## Resident reruns

Resident (not dry-run or once) daemon ticks can launch a single-flight
`ci-rerun` off-tick job with a five-minute deadline. Configure the top-level
`ciRerun` section in config.json, for example:

```json
{"ciRerun":{"enabled":true,"intervalMinutes":10,"repos":["ashlrai/phantom"],"maxPerHour":10}}
```

No configured repositories means no job. The default interval is ten minutes,
and the default global cap across repositories is ten attempts per hour.
Only `probable-flake` groups with action `rerun-failed` are rerun, using the
failed workflow run IDs and PR head SHAs in each group's `runs` evidence.
Other classifications are never rerun. Shared-baseline fixes use the existing
queue writer only while standing authority is effective and KILL is inactive;
unknown KILL state blocks queueing. These gates do not apply to flake reruns.

The append-only `ci-reruns/journal.jsonl` under ASHLR_HOME (default `~/.ashlr`)
records an attempt durably before calling GitHub, then records its outcome.
Attempt rows carry the failing test id (bounded to 400 characters), so the same
test flaking on unrelated commits is visible over time. A test that was
rerun-attempted on at least three distinct heads within the last seven days is
a recurring flake: maintenance appends one `RQ-CIFLAKE-*`
stabilization brief (tier `work`) per (repository, test) to the router queue,
capped at ten new rows per run, under the same standing-authority and KILL
gates as shared-baseline fixes. Deduplication is generation-aware like the
master fixes: an open row suppresses queueing, dropped or retired rows stay
suppressed, and a flake that keeps recurring after earlier stabilization
generations reached DONE re-queues as the next `RQ-CIFLAKE-*-G<n>` id (at
most three attempts per test) — a fix that did not hold becomes fresh work
instead of a permanently deduplicated row. The window keeps the signal honest — a fixed
flake stops producing attempts and ages out instead of being re-queued on stale
evidence, and journal rows written before the test field existed never count.
The repository, head SHA and run ID prevent repeated attempts even after a
crash or failed call; a new head is eligible. Reads tolerate malformed rows and
are bounded to the last 4 MiB, so deduplication, counts and recurrence cover
that retained read window. `phm ci reruns --json` shows the latest 100 entries,
counts in that window, the last-hour attempt count, the recurring flakes and
the rerun verdicts.

## Rerun verdicts

An `ok` journal row only proves the `gh run rerun` call succeeded, not that the
flake passed. On each maintenance pass, after queueing work, the loop resolves
pending reruns by reading `repos/<repo>/actions/runs/<runId>`: a completed run
with conclusion `success` journals a `pass` verdict, `failure` or `timed_out`
a `fail`, and any other completed conclusion (cancelled, skipped, neutral,
startup failure, stale) an `inconclusive` one. A run still in progress, a read
whose `updated_at` predates the rerun call, or a head SHA mismatch stays
pending for a later pass. Attempts younger than five minutes are not checked
yet so a stale pre-rerun read cannot be mistaken for the new attempt's result;
unresolved attempts older than 24 hours stop being polled. Each pass performs
at most eight verdict reads per repository inside the same five-minute
deadline, and transient read failures leave the rerun pending rather than
recording a guess.

`phm ci reruns --json` reports `verdicts` tallies over the retained journal
window: `pass`/`fail`/`inconclusive` counts, `pending` fired reruns still
awaiting an outcome inside 24 hours, and `resolutionRate` (pass over
pass+fail, null when nothing has resolved). Recurring-flake entries carry the
same per-test verdict tallies and the `RQ-CIFLAKE-*` brief names them, so a
test whose reruns keep failing reads differently from one that passes on
rerun. A `fail` verdict is evidence the classification may be wrong, not proof;
rerun firing rules are unchanged.
`ci-reruns/status.json` contains the last
maintenance time, per-repository counts (including `recurringFlakes` detected,
`flakeFixesQueued` appended, `verdictsPending` and `verdictsResolved`), errors
and queue-blocked reason;
`phm daemon status --json` exposes it as `ciReruns` (null before the first run).
Cancellation stops further GitHub calls and records status `aborted`.
