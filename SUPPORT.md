# Support

Thank you for using Phantom. This page covers where to start, how to diagnose, and where to report problems.

Phantom is an open-source, agent-run software factory chasing open-source RSI
(recursive self-improvement). Agents do most of the work on this repository and
the human owner acts as a passive board member. See the [README](README.md) for
the full picture.

## Getting Started

Read [docs/QUICKSTART.md](docs/QUICKSTART.md) for installation, onboarding, and your first `phm` run.

## Diagnosing Problems

Run the commands listed in [docs/CLI-REFERENCE.md](docs/CLI-REFERENCE.md):

- `phm doctor` — one-glance health check (config, phantom, providers, ecosystem).
- `phm status` — attention board: dirty, off-sync, and stale repos, plus an ecosystem summary.
- `phm pulse` — local observability dashboard: tokens, cost, sessions, and commits.
- `phm verify-safety` — read-only self-check of the hard safety invariants; it changes nothing.

`ashlr` is a compatible alias for `phm`. If a command fails, paste the full error output when filing an issue.

## Reporting Issues

Open a **public issue** on [ashlrai/phantom](https://github.com/ashlrai/phantom/issues) for bugs and feature requests. Include:

1. `phm --version` and your OS.
2. Steps to reproduce and the complete error output.
3. Any relevant logs from `phm status` or `phm pulse`.

Remove secret values, tokens and personal paths from anything you paste.

## Security Reports

Do **not** open a public issue for security-sensitive reports. See [SECURITY.md](SECURITY.md) for how to report vulnerabilities privately.

## Community

- [Contribute with an agent](docs/CONTRIBUTE-WITH-AN-AGENT.md) — your first pull request from a fork: the checks to run once, `Merge Gate` and auto-merge.
- [Contributing guide](CONTRIBUTING.md) — source development guidelines.
- [AGENTS.md](AGENTS.md) — the rules coding agents follow in this repository.
- [Documentation map](docs/README.md) — runtime and operator guides.
