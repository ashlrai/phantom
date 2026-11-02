# Governance

Phantom operates as an open project under the authority of its maintainer.
This document describes how decisions are made, how changes reach
`origin/master`, and how external contributors participate.

## Decision authority

[Mason](https://github.com/masonwyatt23) is the project maintainer and sole
decision-maker on all policy matters. Autonomous agents may merge pull
requests into the default branch when every required CI check passes, but
they cannot alter this document, change the authority model, or override
the maintainer's "always ask" list in [CONSTITUTION.md](CONSTITUTION.md).

## Merging changes

1. **Open a PR** targeting `origin/master` from any fork or branch.
2. **All required CI checks** must report green on the exact PR head
   (status checks from GitHub Actions, lint, typecheck, and the full
   test suites).
3. **Merge queue** — once the above hold, a required-review review and
   GitHub's merge button (or `gh pr merge --auto` when enabled) applies
   the patch.  Agents do the bulk of this work: they open proposals,
   patch code, run tests, and push merge-ready PRs.  A human review
   remains required for any change to this file, the constitution,
   release policy, or Tier-1 [CODEOWNERS](.github/CODEOWNERS) paths.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development workflow.

## External contributions

Outsiders welcome pull requests via the normal GitHub fork-and-PR flow.
Large or security-sensitive changes should be discussed as an issue first.
Agents (phantom / steward) may propose, build, test, and ship their own
features through PRs under the rules above.

## Security reports

Do **not** open public issues for security-sensitive findings.  Use
GitHub's **private vulnerability reporting** (Security → *Report a
vulnerability*) on this repository, or email the maintainer at the
address in the repository profile.  See [SECURITY.md](SECURITY.md) for
details on the safety model and supported versions.
