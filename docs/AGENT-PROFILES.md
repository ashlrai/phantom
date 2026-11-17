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

These verbs are registered under `phm agents`. Versions lists current and archived revisions. Changed writes retain the previous
revision in a private `<id>.versions/` directory. `pinAgentProfile` resolves an exact
revision and refuses missing versions. [Agent sessions](SESSIONS.md) record a
profile id and version alongside queue turns, but do not load or validate the
profile. `checkSend` is a pure fail-closed
decision function: while `limitsTodo` is true (the default) it returns `draft`, and denied
recipients or unlisted channels return `deny`. The email outbox consults it for
outside sends (`sendEmailOutbox` `profile` option): a `deny` refuses the reply
in place and a `draft` — the only other outcome a portable profile yields —
keeps the owner approval path. The allowlist remains the trusted-recipient
binding: only allowlisted replies reach the transport. The
existing chief-of-staff approval path is unchanged.

Mapping reference: [Managed Agents setup](https://platform.claude.com/docs/en/managed-agents/agent-setup).
The local format keeps provider-neutral resource classes and connector references.

## Bot templates

A bot template (`src/core/agents/bot-templates.ts`) bundles an avatar, a role (the org
model's `leader`, `implementer`, `reviewer` or `researcher`), a doctrine, a memory seed,
starter tasks, crons and channel references. Three ship: `pr-reviewer`, `release-scribe`
and `ci-watchdog`. Creating a bot writes the profile above (drafts only, `limitsTodo`
true), a private folder `~/.phantom/bots/<id>/` (`bot.json`, `doctrine.md`,
`memory-seed.md`, mode 0600) and one disabled automation per cron. Creating a bot grants no
authority: starter tasks are recorded, never dispatched, and nothing is sent or enabled. A
taken id is refused (409), and a failure partway removes everything the call created.

The desktop flow is the Bots view (`/bots`). The HTTP API on the local web server:

- `GET /api/bots/templates` lists the templates.
- `GET /api/bots` lists bots created from templates.
- `POST /api/bots` with `{ templateId, id, name? }` creates one. It needs the mutation token
  and a server started with dispatch enabled, like the other mutating routes.
