# Implementation findings

No drive command, driver daemon, metrics command, restock implementation or publish.sh exists in this checkout. Use an explicit versioned local file contract until the driver lands. Reuse fleet CLI dispatch and fleet digest aggregation. Keep transport responsibility with Masbot. Protected paths were inspected read-only.

---

# Routing implementation notes

- Existing src/core/decide/decide.ts provides Jev confidence, accounting, budget and kill controls.
- src/cli/route.ts currently supports route explain only.
- docs/ROUTING.md does not yet exist.
- dispatchd.py writes dispatchd.admission.v2 at end of tick.
- No companion MCP tools called.
# Onboarding findings

- Existing `onboard` first-activation and `setup` authority flows must retain their contracts.
- `phantom status --json` is configuration metadata, not vault health. Names-only
  `phantom list --json` refuses a locked file vault; partial keychain inventories
  carry a warning. Never turn a failed inventory into empty.
- Secrets import requires a trusted-terminal challenge. Offer password-manager,
  provider and other-vault imports without accepting exports or credential values.
- Lexicon supports `lexicon add <term>`; Stack MCP registers its existing CLI,
  not service provisioning. Ashlr MD has no npm/Homebrew package.
- Use existing connector metadata validation and safe-path checks. Register local
  MCP executables only; never copy credential-bearing MCP commands or environments.
- Companion tools called: none. Phantom CLI bootstrap, docs, MCP/wire/authority
  inspections were run as required by docs/AGENT-MCP-CLI.md. No runtime activated.

---

# RQ-MUSE-WIRE-1 findings

- Existing node fleet queue supports owner scopes, capability requirements, slots, usage heartbeats, fenced leases and secret names only.
- SSH pool worker currently advertises provider lanes and budgets 4 GiB per slot; it is not a two-slot light-command worker.
- Production ready.tsv and node queue are distinct admission authorities. A light slice must never also enter ready.tsv.
- PR #5529 covers multi-Mac enrollment/runbook work; this change should document light routing specifically.
- No live muse completions observed; host node status is unavailable in this session.
- Added a fixed catalog and hourly IDs, with two outstanding jobs at most per normal restock pass; no ready.tsv migration or arbitrary queue command execution.
- A separate --light worker profile keeps the provider profile unchanged, retains all pressure/disk/lease gates, and reports busy-slot usage.
- Completion executor metadata is owner-scoped and excludes result bodies; private status snapshots live under metrics/muse-light/status.json.
- Shared pnpm package links were incomplete; dependency repair overlapped preliminary verification. Final runs must use the restored stable dependency tree.
- Isolated npm ci restored 403 packages. The bounded documentation recipe passed with 84,770,816-byte peak RSS on this host; this is not muse execution evidence.
- Final validation: 86 backend + 51 Python + 10 authority tests pass, along with full typecheck, docs and the final changed-file gate. Full-repository lint was interrupted without output; focused lint and both guards passed. Baseline archive was removed; all repository changes remain uncommitted.
