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

# PR #4122 findings

GitHub connector confirms open, unmerged PR, head masonwyatt23/phantom:codex-bridge/RQ-DRAIN3-PH-09 at 2ad3ea745771ed0d3f270fabe1933117c7c1b7be. Original base 65d714ece34d2dcd48f50e283835d4cae41699c4. Current local master e14dc05359895de0bad9bff3cf8c285c4545d635.

Changes introduce merge cockpit and advisory fleet autopilot across 20 files. Prior PR notes report 57 passing focused tests but unfinished typecheck/lint. No new PR will be created.

Phantom 3.30.24 command registry, help, MCP list and wire status read. Wire status reports inaccessible Codex/Cursor config. Global installation failed; isolated /tmp installation in progress.

The task requires updating/enqueueing but final RULES forbid commits/pushes. Asked for clarification asynchronously; independent local preparation continues.

Hosted CI run 42536109229: Quick typecheck core compile passed; authority checks failed (CODEOWNERS missing cockpit test; closure grew by src/core/fleet/merge-cockpit.ts and src/core/verse/merge-cockpit-api.ts). Merge Gate failed as a consequence. Added owner entry; did not regenerate the Mason-only snapshot.

Backend retained feature tests passed 45/45. Initial UI check failed during conflict resolution; subsequent check encountered incomplete shared packages. Worktree installer returned successfully but its wt-deps healing failed; a clean npm ci is in progress.
