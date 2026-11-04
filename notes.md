# Findings
Masbot's operator-glance implementation is present. Email allowlist fallback and Telegram first-message pairing do not satisfy authenticated-only access. Phone already uses Cloudflare Access and pairing; loopback auth is out of scope. Preserve local commands and inbox text handling.

# Ownership audit notes

- `desktop/src-tauri/src/main.rs`: `reap_sidecar` terminates the sidecar tree.
- `desktop/src-tauri/src/sidecar_guard.rs`: quit/signal/crash cleanup is deliberate.
- `src/core/verse/terminal.ts`: PTY handles and live output belong to Verse.
- `src/core/verse/session-engine.ts`: interactive children and control state belong to Verse.
- `desktop/src-tauri/src/computer.rs`: computer-use workers are native threads.
- `contrib/mac/dispatchd.py`: queue jobs spawn independently of the app.
- `scripts/local-app-transaction.mjs`: full rollback archive; exclusive renames;
  live replacements prevent automatic rollback until quiescent.
- `src/core/desktop/qualified-update.ts`: Stop/drain admission remains required.

Bootstrap: global npm installation denied with EPERM; existing phm responds to
docs and mcp list, but rejects `wire status --json` with exit 2. No auth/config
changes attempted. No companion MCP tools called.
