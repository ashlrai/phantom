# MCP registry schema fixture

`server.schema.json` is an unmodified copy of the published MCP registry
[2025-12-11 schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json),
retrieved on 2026-10-26. SHA-256:
`3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0`.
The manifest test validates offline using the existing MCP SDK's AJV provider.

Phantom ships a server, rather than only consuming the servers in `.mcp.json`:
`src/cli/mcp.ts` starts `startGateway` from `src/core/mcp-gateway.ts`, which
connects an MCP server to `StdioServerTransport`. The root `server.json`
describes `npx @ashlr/phantom@<version> mcp`; both package binaries share one
entrypoint. The version source of truth is root `package.json`. Update both
manifest versions with that source; the test rejects drift.

This is discovery metadata only. Registry submission requires Mason's approval.
No npm ownership metadata or publication configuration is changed here.
