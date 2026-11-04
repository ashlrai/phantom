# Verify a worktree change

Run `phm verify change --worktree /path/to/trusted/repo` to run typecheck,
unit, lint and secrets checks. Select a subset with `--checks typecheck,unit`.
This executes repository code with your local toolchain and credentials; use
trusted repositories only. It does not install dependencies or publish anything.

The command emits one JSON verdict on stdout and exactly ten handoff lines on
stderr. Exit codes are 0 for pass, 1 for failure and 2 for invalid usage.
Child output is withheld, including on failure, so environment values and secret
matches cannot enter the verdict. `first_error` reports a safe failure category;
inspect the check locally for detailed diagnostics.

Node repositories use packageManager metadata, then Bun, pnpm or Yarn lockfiles,
then npm. Scripts prefer typecheck:ci/typecheck/check:types,
test:ci/test:unit/test and lint:ci/lint. Missing scripts fail closed.
Cargo defaults to check/test/clippy, Python to mypy/pytest/ruff through
`python -m`, and Go to build/test/vet. Native check invocations in
`.github/workflows/ci.yml` or `ci.yaml` override these defaults when they are
simple literal commands with no shell operators or working-directory override.
Complex CI wrappers and matrix expressions require a repository script; they
are not evaluated as configuration. The first detected root manifest wins
(package.json, Cargo.toml, pyproject.toml, go.mod); nested packages are not searched.

Secrets invokes the worktree's existing `.github/tests/secret-shape/scrub.pl`
with `--check --allow-fixtures`, unchanged. An absent gate fails closed.
The input includes staged and unstaged changes against HEAD and untracked file
diffs; filenames include deleted files. This verdict describes local changes
against HEAD, not all commits on a branch, and does not authorize publication.
Each subprocess has a ten-minute timeout and an eight-MiB output limit.
