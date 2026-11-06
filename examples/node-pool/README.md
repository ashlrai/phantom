# Join a small Mac to the Phantom pool

Use approved team SSH aliases `primary-mac` and `backup-mac`, sign in to provider
CLIs locally and install the same reviewed Phantom build on each Mac. Configure
the primary and backup first as documented in
[Agent network](../../docs/AGENT-NETWORK.md).

```sh
npm install -g @ashlr/phantom && phm node join --owner mason --primary primary-mac --backup backup-mac --json
phm node join --json
phm node worker --runner /absolute/path/to/reviewed-node-runner --json
```

The first join derives the node ID from the hostname; use `--node mac-air` when
an explicit ID is needed. Repeat join rechecks saved configuration. Worker runs
one bounded batch using a host-owned runner: up to two concurrent jobs on the
16 GiB Air or one on the 8 GiB Pro under one node session. It waits for all
started slots, then leaves. No runner or permanent supervisor is installed.
Pressure, swap, low disk or unknown telemetry holds admission. The disk sample
covers the home filesystem; the runner's DISKGUARD must cover checkout and
artifact volumes too. Pressure checks target three seconds, subject to bounded
synchronous telemetry and SSH delays. Keep iPad and phone as mobile controls.

## Reviewed configuration, local credentials

Keep project `.mcp.json` and skill files in the same reviewed checkout revision on
each Mac. Review [profile.toml](profile.toml) before placing that credential-free
metadata at `~/.phantom/connectors/profile.toml` on each node. It uses the existing
[connector profile schema](../../docs/CONNECTORS.md); adding metadata does not
execute or authorize a connector. Resolve any credential binding on each Mac
through its own local custody. This example needs none.

Join does not synchronize profiles or skills. Never copy Cursor credentials,
`~/.codex`, `~/.claude` or other auth directories. Use native local sign-in.
Independent per-node lanes share the owner-scoped queue; no inference sharding
is enabled or assumed to improve throughput. Existing DISKGUARD applies.
