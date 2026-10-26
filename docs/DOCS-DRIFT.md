# Check documentation against source

Run the repository checker after installing the locked development dependencies:

```sh
node scripts/check-docs-drift.mjs > /tmp/docs-drift.json
```

It reads source files without importing the application, executing CLI help,
contacting providers, or reading runtime configuration. JSON contains identifier
names and locations, never environment values, command arguments, or source
snippets. Exit codes are 0 for no mismatches, 1 for drift, and 2 for invalid
inputs or a refused/failed publishing handoff. The full inventory includes the
source file and line that supplied each name.

## Coverage and interpretation

- Commands come from the main CLI dispatch switch. Literal Commander command
  declarations and reviewed help snapshots are supported for sibling repos.
- Flags come from source string literals, including argument definitions and
  help text. Membership is repository-wide. A known flag on the wrong command
  is outside this check's coverage; subcommand semantics still need CLI tests.
- Configuration paths come from the JSON schema, including local references
  and composition. Open maps and recursive descendants are reported for review.
- Environment names come from literal keys, environment property access and
  subprocess environment objects. Names used only in the documented test
  harness have an explicit source entry in the Phantom profile.
- MCP names come from objects declaring a name and input schema. Separately
  installed companions are not validated as Phantom native tools.
- Current-source version sentences and literal `APP_VERSION` / `ABOUT_VERSION`
  declarations are checked against the root package version. Comments,
  protocol versions and historical release numbers are not current versions.
  The existing UI imports its version from the package; no duplicate is needed.

Documents include root READMEs, AGENTS.md, CLAUDE.md, root llms text files and
Markdown/text files recursively under docs/. Markdown code spans and fenced
commands, plain llms commands, global flags and shell continuations are checked.
Explicit config get/set paths and code spans labelled `Config key:` under known
config roots are compared. Arbitrary dotted prose can name files or events, so
it is not inferred to be configuration. Arbitrary JSON/TOML samples, positional argument
semantics and dynamically assembled command/tool names are not fully parsed.

`mismatches` are unsupported current references or stale current versions.
`review` preserves unmatched historical/design references, companion names,
locally assigned shell variables and open schema keys. Explicit document status
banners and historical/planned section headings determine historical scope;
current contracts and implemented specs are checked. The internal chronological
journal is historical by profile. Review entries are unknown, not verified.
An empty mismatch list does not establish that every prose claim is true.

Missing inputs, empty inventories, malformed source, unresolved schema references
and symlinked inputs fail closed. No baseline of known failures is accepted.

## Corrections and the bridge publisher

Preview provable corrections without modifying the checkout or invoking tools:

```sh
node scripts/check-docs-drift.mjs --fix --dry-run --plan /tmp/docs-drift-plan.json
```

The plan file is created exclusively and contains only a summary. Automatic
corrections are deliberately limited to the canonical current-source version
sentences in README.md and docs/QUICKSTART.md. Command renames, config migration,
environment names and in-app changes require a reviewed manual correction.
Any unresolved mismatch blocks publishing; the checker never guesses a rename.

When publishing is explicitly authorized, first have the owner bridge prepare
a clean `codex-bridge/JOB` worktree and its `JOB.base` record. The checker uses
the existing bridge interface, `publish.sh JOB`:

```sh
node scripts/check-docs-drift.mjs --fix \
  --publisher /absolute/owner-installed/publish.sh \
  --job JOB --runs-dir /absolute/bridge-runs
```

The publisher must be a regular file without group/world write permission.
The bridge record must match the worktree, branch and base commit. Other edits
and untracked files block the handoff; BRIDGE_NOTES.md is excluded, matching the
bridge publisher. The checker validates all preimages before writing. It sends
only the job ID to the publisher, which owns its lock, protected-path checks,
commit, push and PR creation. There is no fallback to direct GitHub calls and
no token setup. The publisher's output stays in its private log. A successful
process handoff is reported as `publisher-completed`, not as verified merge or
release acceptance. A failed publisher leaves the small patch for inspection.

The publisher is external to this repository. A missing publisher or bridge
record refuses without modifying documents. Do not substitute a package-release
script with the same filename. No publisher is invoked by normal checks or
dry runs, and a clean report does not open an empty PR.

## Owner scheduler handoff

The owner G1 PR wires exactly two triggers: a merged pull request targeting the
default branch, and the nightly schedule. Use the accepted merged/default-branch
revision, install its locked dependencies, then run the checker with
`--event merge` or `--event nightly`. Do not add a per-push trigger. `--event push`
is rejected before scanning; `--event manual` is available for local checks.
The event option is an invocation guard, not proof of an event's authenticity.
The owner workflow must verify the actual event and retain the JSON artifact
even when drift exits 1. Security owns merging that workflow PR.

This change installs no scheduler and modifies no workflow or release config.
The existing documentation navigation and CLI registry tests remain required.

## Template for another repository

Copy the checker and its docs-drift module directory into the sibling repo.
Start with the [example profile](examples/docs-drift-profile.json), replace the
example names and paths, and use `--profile path/to/profile.json`.
The exported default profile in the checker illustrates the fields:
source roots, dispatch file (null for Commander/help-only), config schema,
binary names, owned environment/tool prefixes, explicit historical journals,
optional environment-only source files, and optional reviewed help snapshots.
No profile executes code. Help snapshots can represent clap CLIs; the owner
must refresh them from the same source revision. All six inventories must be
nonempty, so a missing adapter cannot produce a false clean result. Run known
drift fixtures against each repository before enabling its owner scheduler.
