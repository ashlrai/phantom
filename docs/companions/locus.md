# Locus with Phantom

Locus is the identity plane: it decides which GitHub / Vercel / Supabase /
Cloudflare account a CLI command or MCP session may act as. MCP and CLI
account auth belongs here; Phantom Secrets only stores the token values.

- Repo: https://github.com/ashlrai/locus (latest release: see COMPANIONS.md)
- Detected by: `phm companions` (`--locus-bin` to select a binary)
- Full guide: [locus/docs/phantom-enrolled-repos.md](https://github.com/ashlrai/locus/blob/main/docs/phantom-enrolled-repos.md)

## How it plugs into an enrolled repo

1. One Locus binding per owner scope (`personal`, `company`, `client:<name>`)
   with `phm:NAME` credential refs.
2. The enrolled repo carries `.locus.toml` (`locus workspace --default <alias>
   --allow <alias> --require-pin`) so agents cannot pin another tenant.
3. Agents run inside the binding: `locus run -b <alias> -- <cmd>`, `locus pin`,
   or `locus-mcp` wired with `locus setup --client codex|claude|cursor|grok`.
4. Before dispatching provider work, Phantom can gate on
   `locus agent report --json` (`unsafe` = do not dispatch) and
   `locus doctor --json` (exit 2 = UNSAFE).

Locus does not rotate keys or mint deploy tokens.
