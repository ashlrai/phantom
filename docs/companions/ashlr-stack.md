# Ashlr Stack with Phantom

Ashlr Stack provisions and wires development services (Supabase, Vercel,
Stripe, GitHub, ...) through a CLI and MCP server.

- Repo: https://github.com/ashlrai/ashlr-stack (npm `@ashlr/stack`, `ashlr-stack-mcp`)
- Guide: [ashlr-stack/docs/phantom-locus.md](https://github.com/ashlrai/ashlr-stack/blob/main/docs/phantom-locus.md)

## Layering

- **Phantom Secrets** holds every value Stack creates (`phantom add KEY`);
  generated MCP configs use `$(phantom reveal KEY)` and never embed values.
- **Locus** picks the account: run `locus run -b <scope-binding> -- stack add <provider>`
  so provisioning lands in the enrolled repo's personal / company / client tenant.
- **Phantom** dispatches the agent that calls Stack's MCP tools from inside a
  Locus-pinned session.

Stack does not enable automatic rotation; `--rotate` only runs when a human
asks for it.
