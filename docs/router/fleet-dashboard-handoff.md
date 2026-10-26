# Coding fleet dashboard handoff

The coding fleet dashboard, versioned snapshot collector and host-only
coordination ledger are implemented. Run `phm fleet status --coding --json` on
the host to refresh the shared snapshot; `phm fleet status --json` retains the
operational status and activation-readiness contract.

The dashboard consumes per-pool series and displays missing or stale evidence
explicitly. Assignment proposals never dispatch agents or grant merge authority.
The ledger compacts expired history while retaining active claims and lease fencing.

Phantom remote remains the phone path; no separate remote server is needed.
See [the fleet guide](fleet-v1.md) for setup, evidence limits and verification.
