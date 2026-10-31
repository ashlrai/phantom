# Support

Thank you for using Phantom. This page covers where to start, how to diagnose, and where to report problems.

## Getting Started

Read [docs/QUICKSTART.md](docs/QUICKSTART.md) for installation, onboarding, and your first `phm` run.

## Diagnosing Problems

Run the commands listed in [docs/CLI-REFERENCE.md](docs/CLI-REFERENCE.md):

- `phm doctor` — one-glance health check (config, phantom, providers, ecosystem).
- `phm status` — attention board: dirty, off-sync, and stale repos.
- `phm pulse` — cost, telemetry, and audit summary.
- `ashlr verify-safety` — structural safety invariant checks.

If a command fails, paste the full error output when filing an issue.

## Reporting Issues

Open a **public issue** on [ashlrai/phantom](https://github.com/ashlrai/phantom/issues) for bugs and feature requests. Include:

1. `phm --version` and your OS.
2. Steps to reproduce and the complete error output.
3. Any relevant logs from `phm status` or `phm pulse`.

## Security Reports

Do **not** open a public issue for security-sensitive reports. See [SECURITY.md](SECURITY.md) for how to report vulnerabilities privately.

## Community

- [Contributing guide](CONTRIBUTING.md) — source development guidelines.
- [Documentation map](docs/README.md) — runtime and operator guides.
