# CI baseline analyzer

Run `phm ci baseline --json` to inspect open PRs in ashlrai/phantom. Use
`--repo owner/repo` for another repository with a master branch. Analysis is
read-only: it does not rerun jobs, change tests, merge PRs, or update branches.

The version 1 JSON report contains failure groups, per-PR freshness, master
evidence, unknown reasons, and proposed update-branch commands. Latest workflow
runs are checked against the current head and full checkout SHA in job logs.
A job proves its checkout one of three ways: echoing `git log -1
--format=%H` followed by the head SHA; printing the `Bound candidate <sha>
to event tree|merge ...` receipt `.github/scripts/ci-source-binding.mjs`
emits after verifying `git rev-parse HEAD` equals the candidate revision;
or, for gate jobs that never run the binding script (secret-shape, quick,
clean-tree, authority-drift, fast-gate, secret-scan and the whole
dependency-audit job), recording `actions/checkout` steps whose resolved
`with: ref:` input is the analyzed head in every checkout group of the log.
The bound revision or checkout ref must equal the analyzed head exactly; an
unpinned checkout (which falls back to the event's merge commit on pull
requests), a non-SHA ref or a second checkout of anything else leaves the
job unverifiable. Jobs that never check out the workspace (aggregators such
as Merge Gate) cannot emit any proof; their logs are dropped from evidence
only when they carry no parseable failure or per-test pass output. The
default reporter's green-module pass lines are expected from checkout jobs
that never bound a receipt, so they neither verify nor poison a run; any
other consumable evidence in an unverifiable log keeps the run unknown.
Unreadable, incomplete, capped, or unverified logs are unknown, never clean.
A job whose conclusion is not a verdict — `cancelled`, `timed_out`,
`action_required`, `startup_failure` or `stale` — is incomplete evidence
even when its log is absent or empty: the run cannot prove the ref's
checks, so the PR reads `unknown` rather than `fresh` — freshness reason
`incomplete-check`, distinct from `unreadable-log-or-unverified-checkout` —
and master's known state drops while the run's verified job logs still
feed failure parsing. If an incomplete job's log is unavailable, the
analyzer retains verified sibling logs. These same conclusions on the
workflow run itself mark it incomplete even when every listed job reached
a verdict. Verified master failures still contribute evidence. A missing log for a job that
reached a verdict still makes the run's logs unusable. `skipped` and `neutral` conclusions are
deliberate non-verdicts, not incomplete checks. A completed run that
instantiated no jobs at all reads the same way when its own conclusion is
not `success`/`neutral`/`skipped` — the jobless `startup_failure` case has
no job list to mark incomplete, so the run's conclusion carries it.
Vitest FAIL lines -- including named-project labels such as `|unit|` or `|console|` --
identify tests under `test/` and `src/web-ui/`; AssertionError summaries are scrubbed
and capped at 2,000 characters per failure, with at most 100 failures per log.
A suite that fails to load (transform, parse, or collection error) prints
`FAIL <file> [ <file> ]` with no test name; these group under the
`<file> > (suite)` identity, capture the suite's error line, and count as
passing on master when the file shows any pass evidence -- the file loading
and running is what resolves a suite failure.
The `ci` job's qualification lanes wrap the suite runs in
`.github/scripts/ci-qualification-lane.mjs`, which re-reads each Vitest
JSON report and refuses a case that passed only after a retry -- the
default reporter shows it green, so the step's only failure output is
`Test case passed only after a failed attempt (flaky): <file> > <name>`
on stderr. `<file>` is the report's repo-relative module path under
`test/` or `src/web-ui/` and `<name>` is the JSON reporter's space-joined
ancestor titles plus the case title, not the default reporter's ` > `
chain, so the group keys on the identity the evidence itself printed.
Because it names a real test, the usual dependency closure and pass
evidence apply: a green master module resolves a one-off flake on an
unaffected singleton to `probable-flake`/`rerun-failed`, while a flake
repeated across unaffected PRs -- or printed by master itself -- groups
`shared-baseline` for a stabilization fix. Verdicts naming paths outside
the suite roots, missing case names and near-miss wording stay unparsed,
so an unrecognized lane failure still reads unknown rather than guessed.
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

The `ci` job's "Lint" step on the ubuntu authority 3/3 shard runs
`npm run lint` (`eslint . && npm run lint:realio-lane && npm run
lint:verse-sync-io`). ESLint's stylish formatter prints each file with
messages as its absolute path followed by `line:col severity message
ruleId` rows and closes the run with a `✖ N problems (X errors, Y
warnings)` summary; a lint break prints no vitest, typecheck or TAP line,
so without this shape a red master marked every open PR unknown. Error
rows group per file under a `<file> > (lint)` identity -- warnings never
fail the step without `--max-warnings`, so warnings-only files emit
nothing -- and stylish's absolute `result.filePath` headers resolve
through the same `/<work>/<repo>/<repo>/` checkout marker as TAP
locations; runs without the summary line, paths outside the marker and
non-lintable paths stay unparsed. ESLint's rules are per-file, so the
dependency set is the failing file itself plus `eslint.config.js`,
`package.json` and `package-lock.json`: a file the failing source merely
imports does not count as touched, and the vitest harness ambient set
does not apply. Like `(typecheck)` it can never resolve through a vitest
pass line, so these groups classify `shared-baseline`, `pr-caused` or
`unknown` -- never `probable-flake`. The pass-line guard covers every
parenthesized gate identity, which also closes the hole where a
`(typecheck)` failure on a test path could read a green module line as a
master pass.

The same step's two trailing guards get the same per-file treatment.
`npm run lint:realio-lane`
(scripts/check-realio-lane-membership.mjs) prints
`[check-realio-lane-membership]` section headers followed by bare
test paths: unclassified real-io markers under a missing-members
header (each with its reason line), stale lane-manifest or
measured-fast-allowlist entries, and real-I/O/serial-CPU overlaps.
Each named path groups under `<file> > (realio-lane)`; the
soft-signal advisory section prints the same path shape but never
fails the step and stays unparsed, as do the ok line, non-test paths
and sections cut off by a `##[` step boundary. `npm run
lint:verse-sync-io` (scripts/check-verse-sync-io.mjs) prints a
`verse-sync-io: N synchronous call(s)` count header then
`<file>:<line>  <call>(…)  → <hint>` rows for synchronous fs or
child-process calls in `src/core/verse/*-api.ts` route files; each
route file groups under `<file> > (verse-sync-io)`, with rows accepted
only between the header and the next step boundary. Both guards grep
source text and never read a file's imports, so their dependency sets
are closed input lists -- the realio checker plus its two lane
manifests, the measured-fast allowlist and the lane-inventory helper;
the verse checker script alone -- and the vitest harness ambient set
does not apply to either. Like `(lint)` they can never resolve through
a vitest pass line: `shared-baseline`, `pr-caused` or `unknown` --
never `probable-flake`.

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

After `tsc`, `npm run build` runs five node helpers and `vite build`
(ci.yml's Build step, and the `npm ci && npm run build` preambles in
perf-budget.yml and companion-smoke.yml). Each helper's failure output
names itself and groups under `<file> > (build)`: authority-surface
prints `authority-surface: <error>` on stderr (its success summary and
`roots not built yet` note stay unparsed), copy-assets prints
`[copy-assets] source not found:`, an uncaught throw in any chain script
prints node's `file://<abs>:<line>` code-frame header naming the script
(only the six chain scripts -- authority-surface, copy-assets,
build-preparation-builtin, build-identity,
build-release-dependency-inventory and sync-candidate-version -- are
attributed), and the release-dependency-inventory catch prints
`release dependency inventory` messages. Vite 8 (rolldown) diagnostics
print `[UNRESOLVED_IMPORT] Could not resolve '<spec>' in <importer>`
and its commonjs-external throw prints `[vite]: Rolldown failed to
resolve import "<spec>" from "<importer>"`; the importer resolves
repo-relative or through the same `/<repo>/<repo>/` checkout marker as
TAP locations, so the group keys on the real source file whose import
closure decides touched. Helper groups seed their direct data inputs as
static inputs (authority-surface's toolchain manifests, copy-assets'
web public assets and toolgraph manifest, build-preparation-builtin's
evaluator entries and trusted preparation sources, build-identity's
package.json); the release-dependency-inventory script imports compiled
dist modules so its closure cannot resolve and it uses a closed input
list instead. Like the other non-test identities these groups can never
resolve through a vitest pass line and classify `shared-baseline`,
`pr-caused` or `unknown` -- never `probable-flake`. Passing builds,
vite's `built in` summary, rolldown diagnostics whose file lives only
inside the code frame (PARSE_ERROR), node_modules or virtual-module
importers, OOM kills and unrelated output stay unparsed.

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

The `Dependency Audit` workflow audits four npm graphs through
`scripts/npm-audit-with-osv-fallback.sh` -- root full, root production
(`--omit=dev`), Raycast full and Raycast production (`working-directory:
src/raycast`, invoked as `../../scripts/...`) -- and `cat`s npm's audit v2
JSON report into the job log on every attempt. Each vulnerable package
groups under `<lockfile> > (dependency-audit) <package>`: bumping the
dependency or adding a reviewed exception is the unit a master fix
restores. The step command echo before a report fixes its lockfile and
exception graph: non-omit audits consult
`.github/dependency-audit-exceptions.json` under graph `full`, the
Raycast production audit under `raycast-production`, and the root
production audit never consults exceptions at all. npm still lists
excepted advisories inside a failing report, so the parser replays the
gate script's exemption fixpoint -- a package stays exempt while every
`via` entry is an excepted advisory id or a still-exempt package name --
and emits only packages outside the exempt set; a report exempt end to
end passed its step and emits nothing. The analyzer reads the exception
file once from master: an absent file means no exceptions, while an
unreadable or malformed file leaves npm audit reports unparsed (unknown)
rather than risk a phantom group for an accepted advisory; exception
expiry is not re-checked because a completed run was governed by the
exceptions valid at run time. Each lockfile's dependency set is its
manifest, shrinkwrap, `.npmrc`, the lockfile itself, the shared exception
file and the audit script (seeded as static inputs), and the vitest
harness ambient set does not apply. Like the other non-test identities
these groups can never resolve through a vitest pass line and classify
`shared-baseline`, `pr-caused` or `unknown` -- never `probable-flake`.
Invalid reports (non-v2 schema, malformed severity counts), reports with
no preceding step echo, clean reports (`total: 0`) and unrelated JSON
stay unparsed, as does cargo-audit output.

When npm's transport fails all three bounded attempts the gate script
falls back to the pinned OSV-Scanner (`scan source --lockfile
<lockfile> --format table`), which prints a `Total N packages affected`
summary and a go-pretty table -- `| OSV URL | CVSS | Ecosystem | Package
| Version | Fixed Version | Source |` rows between `+`-ruled borders.
In the piped CI log the scanner renders its ASCII StyleDefault box (the
rounded unicode style only appears on a TTY and stays unparsed). Each
data row groups per package under the same `<lockfile> >
(dependency-audit) <package>` identity the npm reports use, since
bumping the dependency or adding a reviewed exception is the same unit
a master fix restores; a vuln group's alias ids continue onto
blank-cell rows and join the package's advisory list, ` (dev)` suffixes
come off to match the npm identity, and rows merge per package so one
group carries the printed advisory URLs (bounded). Rows are accepted only inside
a recognized step echo and only when the Source cell names the echoed
lockfile; the scanner's own `IgnoredVulns` config already filtered
excepted advisories, so these groups emit even when the exception file
is unreadable -- the npm fixpoint is the only audit shape that needs it.
Near-miss headers, other table shapes (license, deprecated, OS-package
summaries), wrong-arity rows, invalid package names and sources naming
another file stay unparsed, as do clean scans (the table only renders
when vulnerabilities exist).

The `ci` job's "Memory benchmark regression gate" step on the ubuntu
authority 3/3 shard runs `npm run --silent bench:memory -- --check >
/dev/null`, so the script's pretty-printed JSON report never reaches the
job log; only its stderr verdict does. Each governed-arm measurement that
falls below its floor in `src/core/local-eval/memory-benchmark-floors.ts`
prints one line indented two spaces under a `memory benchmark below
floor:` header -- case counts, passed counts vs floor, leak/step/waste
ceilings and open pending decisions -- and the step exits non-zero while
any stands. Violations group under the entry script as
`scripts/benchmark-memory.ts > (memory-benchmark)`: the gate's verdict is
binary, so one identity covers the whole block. The script's import
closure (the benchmark, its floors and the whole `src/core/memory`
implementation) plus `package.json`, `package-lock.json` and
`tsconfig.json` -- the toolchain files that shape how tsx compiles and
resolves it, seeded as static inputs -- is the dependency set a master
fix restores, and the vitest harness ambient set does not apply. Like
the other non-test identities these groups can never resolve through a
vitest pass line and classify `shared-baseline`, `pr-caused` or
`unknown` -- never `probable-flake`. The measurement run without
`--check`, the discarded JSON report, `MEMORY_BENCH_ARGUMENTS` usage
errors (exit 2 with no stderr), passing runs, a bare header with no
violation lines, non-indented or deeper-indented followers and unrelated
output stay unparsed.

The `ci` job's pack-smoke steps on the ubuntu authority 1/3 shard verify
the same-job build before the suites run and again in `Pack smoke
(exports map)`: `Capture pack smoke build snapshot` runs
`npm run check:pack-contracts` (node:test TAP, parsed above),
`ci-pack-smoke.mjs capture`, `check:first-paint:built` and
`ci-pack-smoke.mjs prepare`; the exports-map step reuses, verifies and
captures the retained snapshot through the same script and
`scripts/hosted-build-artifact.mjs` (also invoked by the
`attest-ci-build` workflow's `qualify` verb). Both scripts funnel every
refusal -- stale or mutated build output, a missing artifact, a drifted
source tree, an unexpected tarball -- through one stderr prefix:
`pack smoke refused: <assert message>` and
`hosted artifact refused: <assert message>`. Each script groups under its
own `<script> > (pack-smoke)` / `<script> > (hosted-artifact)` identity;
the prefixed header line is the failure identity, so multiline assert
continuations (a drift list under `source changed after build:`) stay
excerpt-free rather than minting second groups. The gate script plus the
repository inputs it reads directly is the unit a master fix restores:
`package.json` for the pack smoke (it verifies the packed name/version
against the manifest) and `package.json` plus `package-lock.json` for
the artifact gate (it hashes the tracked lockfile set it admits), seeded
as static inputs since the measured dist/ graph has no enumerable
closure; the vitest harness ambient set does not apply. Like the other
non-test identities these groups can never resolve through a vitest pass
line and classify `shared-baseline`, `pr-caused` or `unknown` -- never
`probable-flake`. Release-only refusals (`release smoke refused:`,
`isolated release tree refused:`, `same-runner release input refused:`,
`Offline partition comparison refused:`), empty messages, non-prefixed
assert output and unrelated lines stay unparsed.

The same `Capture pack smoke build snapshot` step then runs
`npm run check:first-paint:built` --
`scripts/check-first-paint-budget.mjs --no-build --out-dir
dist/core/web/public/next --budget-kb 354 --mobile-budget-kb 250` --
which walks the Vite manifest's static-import closure of each
first-paint root (`index.html` -> `main.tsx` -> the Verse apps and
their chat or home screens), sums the chunk bytes and prints one
verdict per arm: `OVER BUDGET: chat first-paint critical JS <kb> KB
(budget <kb> KB)` and `OVER BUDGET: phone (/verse/m) first-paint
critical JS <kb> KB (budget <kb> KB)`. Each over-budget verdict groups
per arm under `scripts/check-first-paint-budget.mjs > (first-paint)
chat` / `> (first-paint) phone` -- the arms measure different closures
against different budgets, so a phone regression never merges into
the chat group -- and the script's own `check-first-paint-budget:
<message>` error path (a renamed first-paint root, a manifest import
with no entry, a missing manifest) groups under `> (first-paint)
gate`. The measured dist/ graph has no enumerable closure -- the
web-ui static closure alone runs to hundreds of modules, past the
import walk's bound -- so each identity's dependency set is a closed
input list: the checker script, `vite.config.web.ts` (which folds
the first-paint chunks and names the presentation-format group
members), `package.json`, `package-lock.json`,
`src/web-ui/tsconfig.json`, `src/web-ui/index.html`,
`src/web-ui/main.tsx` and the arm's named manifest roots; the gate
identity takes the union of both arms. The vitest harness ambient set
does not apply. Like the other non-test identities these groups can
never resolve through a vitest pass line and classify
`shared-baseline`, `pr-caused` or `unknown` -- never
`probable-flake`. OK verdicts, the per-file `N.N KB  <file>` listing,
`--json` reports, npm lifecycle noise and unrelated output stay
unparsed.

The PR-visible trust gates fail with no vitest, typecheck or TAP line
naming them, so each gets its own count-or-verdict identity. The
`secret-shape` job pipes the candidate diff through the pinned
`.github/tests/secret-shape/scrub.pl --check --allow-fixtures`, which
prints only `<blocked> allowed=<n>` and never a matched value; a nonzero
blocked count groups under `.github/tests/secret-shape/scrub.pl >
(secret-shape)` and the count line is the whole excerpt. The
`secret-scan` job runs the pinned gitleaks binary with `--redact` and no
`-v`, so finding detail never reaches the log -- only the scanner's own
`WRN leaks found: <n>` summary -- and a nonzero count groups under
`.github/workflows/ci.yml > (secret-scan)`, the workflow that pins the
version and owns the invocation. The `quick` job's pull-request-only
`Require release-please provenance for version bumps` step fails a
version bump outside a same-repository `release-please--*` branch with
`::error::<changed carriers>. Only the release-please PR may change the
release version; ...`, or reports a gate malfunction as `release
version provenance check failed: <message>`; both group under
`.github/scripts/release-version-provenance.mjs > (version-provenance)`.
The diff and commit-range scans have no enumerable repo input -- any
diff line or scanned commit can carry the shape -- so the scanner groups
key on the gate definition itself and a shape carried inside a PR's own
diff stays unattributed rather than guessed at a file; only a PR
touching the scanner or workflow counts as `pr-caused`. The provenance
check reads exactly its script plus `package.json` and
`.release-please-manifest.json`, seeded as static inputs so a PR bumping
either carrier is `pr-caused`. Like the other non-test identities these
groups can never resolve through a vitest pass line and classify
`shared-baseline`, `pr-caused` or `unknown` -- never `probable-flake`.
Clean scans (`0 allowed=<n>`, `no leaks found`, `leaks found: 0`), the
provenance pass lines, unrelated `::error::` annotations and unrelated
lines stay unparsed.

Either scanner step can also fail before it prints a verdict, which used
to leave every open PR unknown because no count or summary line exists.
The `secret-shape` step's pinned-hash check prints
`.github/tests/secret-shape/scrub.pl: FAILED` (or `FAILED open or read`)
when the workflow pin and the script disagree, `secret-shape base is
missing` when the candidate base cannot be resolved, and perl's own fatal
diagnostics (`syntax error`, `aborted due to compilation errors`,
`BEGIN failed`, `requires explicit package name`, `Undefined subroutine`,
`Can't call method`, `Search pattern not terminated`,
`Unrecognized character`) when the script dies -- all grouped under
`.github/workflows/ci.yml > (secret-shape-gate)`. The `secret-scan` job's
pinned-archive check prints `<path>/gitleaks.tar.gz: FAILED` on a hash
mismatch and the scan step prints `secret scan refused an incomplete
commit range` when the range cannot be resolved -- grouped under
`.github/workflows/ci.yml > (secret-scan-gate)`. sha256sum's WARNING
summary line alone, `: OK` check lines, archives other workflows pin
(`cargo-audit.tgz`, `osv-scanner-download`), non-fatal perl warnings and
partial refusal text stay unparsed. A gate-bootstrap group's dependency
set is the closed list of repo files its step executes -- the workflow
itself plus `scrub.pl` for secret-shape and `ci-fetch-range.mjs` for
secret-scan's merge-group/push scan-base path -- with no vitest harness
ambient set, so a PR touching any of them is `pr-caused` and the rest
classify `shared-baseline`, `pr-caused` or `unknown` -- never
`probable-flake`.

The ci.yml helper gates under `.github/scripts/` fail with only the
script's `console.error` line plus the runner's
`##[error]Process completed with exit code` step marker -- no vitest,
TAP, typecheck or report shape names them. GitHub wraps each `run:`
step in a `##[group]Run <script>` block, so the analyzer attributes the
marker to the step's script when every script line is a `node --test`
invocation or one whitelisted gate script, all gate lines naming the
same file: `ci-fetch-range`, `ci-source-binding`, `ci-site-lane`,
`ci-mac-rotation`, `ci-dep-graph`, `ci-fast-select`, `ci-fast-inputs`,
`ci-green-reuse` and `ci-mcp-selection` group under
`.github/scripts/<script> > (<gate>)`. Mixed bash, `uses:` actions,
non-whitelisted scripts and ambiguous multi-script steps stay
unattributed, and a `not ok` or vitest `FAIL` line in the step's own
output means the companion test runner owns the failure -- the gate
group is suppressed. Each gate's inputs are the script, its import
closure and `.github/workflows/ci.yml` (the step definition), with no
vitest harness ambient set; like the other non-test identities these
groups classify `shared-baseline`, `pr-caused` or `unknown` -- never
`probable-flake`. Scripts whose pure steps only appear in jobs the
analyzer's evidence never sees (macOS/Windows lanes, release
pipelines, merge-group-only attribution) are not listed.

The `Install dependencies` steps run a bare `npm ci` (with or without
`--ignore-scripts`/`--no-audit`/`--no-fund`), so a broken manifest or
lockfile on master fails every fresh PR before any test runs and npm's
own `npm error <detail>` block is the only evidence. The analyzer
tracks the same `##[group]Run` step boundaries, but a step qualifies
only when every script line is a pure `npm ci` invocation: `npm ci &&
npm run build` preambles, `npm install` toolchain fetches, `uses:`
actions, mixed bash, `npm run` script steps (whose `npm error Lifecycle
script` blocks must not be claimed) and steps that die without an
`npm error` line stay unattributed. Failures group under
`package-lock.json > (install)`; the dependency set is the closed input
list -- `package.json`, `package-lock.json`, `npm-shrinkwrap.json`,
`.npmrc` and `.github/workflows/ci.yml`, the only workflow whose root
install runs on analyzed refs with a verifiable checkout -- with no
vitest harness ambient set, so a PR touching any of them is
`pr-caused` and the rest classify `shared-baseline`, `pr-caused` or
`unknown` -- never `probable-flake`.

The install-smoke jobs' "Install this commit" and "Install the
published release" steps run `node
.github/scripts/ci-install-smoke.mjs <verb>` on the linux lane whenever
a pull request or merge group trips the `xplat_install` path filter (and
on the daily schedule and dispatch). The script funnels every refusal --
an npm pack/install exit, a missing packed tarball or `phm` shim, a
version mismatch, a bad published-release checksum or download -- through
one `console.error` line plus the runner's step-failure marker, so the
analyzer tracks the same `##[group]Run` step boundaries and attributes
the marker when every script line is the same install-smoke invocation.
The two verbs are different gates with different closed input lists:
`commit` builds, packs and installs this checkout, so `package.json`
(version, files, bin), `package-lock.json`, the packed `bin/ashlr` shim
and `.github/workflows/ci.yml` count as inputs and group under
`.github/scripts/ci-install-smoke.mjs > (install-smoke-commit)`;
`release` fetches and installs the published npm artifact, which no diff
can change, so only the script and the workflow step count and failures
group under `> (install-smoke-release)`. Build diagnostics the step's own
`npm run build`/`npm pack` prints still belong to the typecheck and
build-step parsers. Mixed bash, `uses:` actions, other scripts,
ambiguous multi-command steps and cancelled steps stay unattributed, and
like the other non-test identities these groups can never resolve
through a vitest pass line: `shared-baseline`, `pr-caused` or `unknown`
-- never `probable-flake`.

The test runners' own watchdog verdicts get the same treatment.
`scripts/test-ci.mjs` wraps every `npm run test:ci` invocation -- the
fast-gate affected-test shards (through `ci-fast-run.mjs`), the quick
job's selected contract test and the full lanes' hermetic steps --
with a private HOME, an inactivity watchdog and a hard runtime cap,
and `scripts/test-ci-sharded.mjs` plans the complete partitions from
the measured duration table before spawning the same wrapper per
shard. When the wrapper itself fails -- Vitest hangs past the idle
window or the hard cap, dies by signal, cannot spawn, the Node floor
is unmet, or the shard plan cannot be built -- the step prints only
its bracketed verdict (`[test-ci] idle-timeout ...`, `[test-ci]
hard-runtime-cap ...`, `[test-ci] received SIGINT|SIGTERM ...`,
`[test-ci] failed to start Vitest: ...`, `[test-ci] Vitest exited
via signal ...`, `[test-ci] Node >=22.15.0 ...`, `[test-ci:sharded]
cannot plan balanced shards: ...`, `[test-ci:sharded] <shard> failed
to start: ...`) with no vitest FAIL, TAP, typecheck or report shape
naming it, so a stalled or crashed runner used to leave every open PR
unknown. Verdicts group under `scripts/test-ci.mjs > (test-ci)` and
`scripts/test-ci-sharded.mjs > (test-ci-sharded)`; each identity's
dependency set is a closed input list -- the runner scripts, the
type-stripped memory-policy module the wrapper reads as text, the
reporter and vitest config surface the spawned run executes under,
the shard plan's duration table and the wrapper the orchestrator
spawns, plus the toolchain manifests -- since the wrapper's computed
`data:` import gives no enumerable closure and the vitest harness
ambient set does not apply. A hang is usually caused by test content
the runner cannot name, so test files never count as touched: a
master stall still groups `shared-baseline` for a fix brief. Like the
other non-test identities these groups can never resolve through a
vitest pass line and classify `shared-baseline`, `pr-caused` or
`unknown` -- never `probable-flake`. Heartbeat, capacity-observer,
job-memory, lifecycle (`started`/`exited`), aggregate
(`FAIL (...)`/`PASS (...)`), usage and report-summary lines stay
unparsed: `exited` lines fire on ordinary test failures and on the
stop-others SIGTERM cascade, so they can never be runner identities.

Two unaffected fresh PRs sharing a test produce `queue-master-fix` and a ready
brief. Test/import changes produce `pr-caused`; a singleton unaffected failure
with an explicit test pass on master's current run produces
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
import prevents independence claims. Pass evidence comes in two shapes: a
verbose per-test line (`✓ file > suite > test`) resolves only the named
test, while the default reporter's green-module line (`✓ file (N tests)`)
resolves any failure identity in that file because every test the module
contains passed on that run. Other pass output does not establish a test
pass. The scan caps open PRs, runs, and jobs
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
Attempt rows carry eligible failing test IDs that fit within 400 characters
and survive secret scrubbing unchanged. IDs that would need truncation or
redaction are omitted from recurrence evidence, and their presence on a run
withholds per-test attribution of its workflow verdict.
When multiple probable flakes share a workflow run, one attempt counts
toward each test's recurrence and consumes one slot in the hourly cap. A test that was
rerun-attempted on at least three distinct heads within the last seven days is
a recurring flake: maintenance appends one `RQ-CIFLAKE-*`
stabilization brief (tier `work`) per (repository, test) to the router queue,
capped at ten new rows per repository per maintenance pass, under the same
standing-authority and KILL gates as shared-baseline fixes. Suppressed
candidates do not consume the cap, so later eligible flakes can enter the
queue on subsequent passes. Deduplication is generation-aware like the
master fixes: an open row suppresses queueing, dropped or retired rows stay
suppressed, and a flake that keeps recurring after earlier stabilization
generations reached DONE re-queues as the next `RQ-CIFLAKE-*-G<n>` id (at
most three attempts per test) — a fix that did not hold becomes fresh work
instead of a permanently deduplicated row. The window keeps the signal honest — a fixed
flake stops producing attempts and ages out instead of being re-queued on stale
evidence, and journal rows written before the test field existed never count.
Both stabilization and `phm improve discover` use a seven-day recurrence
window that ends at the evaluation time. Future-dated rows contribute only
once their recorded time falls inside that window.
The repository, head SHA and run ID prevent repeated attempts even after a
crash or failed call; a new head is eligible. Reads tolerate malformed rows and
are bounded to the last 4 MiB, so deduplication, counts and recurrence cover
that retained read window. `phm ci reruns --json` shows the latest 100 entries,
counts in that window, the last-hour attempt count, the recurring flakes and
the rerun verdicts. Reports and the hourly cap count rows through the
evaluation time, inclusive. Future-dated receipts still prevent duplicate
reruns and duplicate verdict writes.
Attempt totals, the hourly cap, and flake recurrence use the earliest
observed attempt receipt for each repository, head SHA and run ID within
the retained journal. Ties use journal order. Replays leave the original
attempt time in effect, and recent entries still show each observed receipt.

## Rerun verdicts

An `ok` journal row only proves the `gh run rerun` call succeeded, not that the
flake passed. On each maintenance pass, after queueing work, the loop resolves
pending reruns by reading `repos/<repo>/actions/runs/<runId>`: a completed run
with conclusion `success` journals a `pass` verdict, `failure` or `timed_out`
a `fail`, and any other reported conclusion (cancelled, skipped, neutral,
startup failure, stale) an `inconclusive` one. Verdicts require a matching run
ID and head SHA, a nonempty conclusion, and a `run_attempt` of at least two.
The recorded `run_started_at` must be no earlier than one minute before the
successful rerun call was journaled, and `updated_at` must fall between
that start and the time Phantom observes the API response, inclusive.
This keeps an updated workflow record for an older attempt from
supplying a verdict. In-progress runs and incomplete, mismatched or stale
reads stay pending for a later pass. Attempts younger than five minutes are
given time to settle before polling;
unresolved attempts older than 24 hours stop being polled. Each pass performs
at most eight verdict reads per repository inside the same five-minute
deadline. Each repository resumes after its last checked rerun, wrapping
to the oldest eligible rerun when it reaches the end. The polling position
persists across restarts, so transient read failures leave reruns pending
for retry while later reruns still get checked.

`phm ci reruns --json` reports `verdicts` tallies over the retained journal
window: `pass`/`fail`/`inconclusive` counts, `pending` fired reruns still
awaiting an outcome inside 24 hours, and `resolutionRate` (pass over
pass+fail, null when nothing has resolved). Each repository and workflow run
ID contributes at most one verdict, using the earliest observed timestamp.
Disagreement on the head SHA or verdict withholds that run from the tallies.
Disagreement on the triggering test withholds only its per-test attribution.
The recent entries still show the raw receipts. Recurring-flake entries carry the
same per-test verdict tallies and the `RQ-CIFLAKE-*` brief names them. A
workflow verdict enters the per-test tally only when the baseline report
identifies a single triggering test and records no other failures for that
workflow run. Other recorded failures include groups ineligible for a rerun,
such as PR-caused failures. A `fail` verdict is evidence the classification may be wrong, not proof;
rerun firing rules are unchanged. In recurring-failure briefs from
`phm improve discover`, a shared attempt counts once for each recorded
triggering test. The shared workflow verdict does not count toward any
test's recurring-failure threshold.
Discovery counts at most one verdict per repository and workflow run ID
within the recurrence window. If records for a run disagree on its head,
test attribution, or verdict, that run provides no per-test evidence.
`ci-reruns/status.json` contains the last
maintenance time, per-repository counts (including `recurringFlakes` detected,
`flakeFixesQueued` appended, `verdictsPending` and `verdictsResolved`), errors
and queue-blocked reason;
`phm daemon status --json` exposes it as `ciReruns` (null before the first run).
Cancellation stops further GitHub calls and records status `aborted`.
