# Agent profiles

Portable agent metadata lives at `~/.phantom/agents/<id>.toml`. A doctrine
is a Markdown path, never executed or expanded by the profile reader. Profiles
never grant project access, transport access, credentials or spending authority.

```toml
id = "helper"
version = 1
displayName = "Helper"
doctrine = "doctrine.md"
resourceClass = "any"
channels = []
tools = []
mcpServers = []
skills = []

[policy]
send = "drafts-only"
perMessageApproval = true
limitsTodo = true

[policy.recipients]
allow = []
deny = []
```

`resourceClass` accepts any, codex, claude, glm or local and expresses a router
preference only. `mcpServers` contains connector profile ids, never server
commands or credentials. The writer rejects ids absent from the local connector
profile. Unknown fields are rejected. Writes use a directory lock, atomic
replacement and mode 0600. Unchanged writes keep their version; changed writes
increment it. Stale versions are refused. Missing dailyCap means unlimited;
a nonnegative integer sets the cap. `limitsTodo = true` always means drafts only.

The pure send policy denies unlisted channels and denied recipients, then drafts
when limits are incomplete or a cap is reached. Portable allowlists cannot prove
a verified self identity, so this implementation never grants automatic send.
All recipients require approval until a trusted identity integration is reviewed.

Copy-paste command contract:

```sh
phm agents list --json
phm agents show helper --json
phm agents validate helper --json
phm agents versions helper --json
```

Integration status: the command implementation is provided in src/cli/agents.ts;
the existing top-level agents bus dispatcher is outside this change's named-file
scope, so these commands are not yet registered. Versions lists current and archived revisions. Changed writes retain the previous
revision in a private `<id>.versions/` directory. `pinAgentProfile` resolves an exact
revision and refuses missing versions. Session/job integration is not implemented. The email outbox calls a main-PR drafts-only stub and refuses transport execution
until the policy integration is reviewed. There is no iMessage outbox module in
this checkout. The existing chief-of-staff approval path is outside the named-file
scope and remains unchanged. Security must review send-policy.ts and its test in a separate PR.
The main metadata changes have no runtime dependency on that Security PR.

Mapping reference: [Managed Agents setup](https://platform.claude.com/docs/en/managed-agents/agent-setup).
The local format keeps provider-neutral resource classes and connector references.
