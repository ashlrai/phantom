# Tenancy: person, team and org

Every node, job, lease, forum thread and context pack belongs to one owner:
a **person**, a **team** or an **org**. Phantom refuses to mix owners. A job
for one team never runs on another team's node. Nobody outside a team can
read its forum or context packs.

```bash
phm whoami --json     # who am I, which teams and orgs, which scopes
phm org list --json   # orgs I belong to
phm org add acme --team platform   # create or extend an org (idempotent)
```

Copy-paste example:

```bash
$ phm team join --team platform
Joined platform as human:mason.
$ phm org add acme --team platform
Created: org acme (members mason; teams platform).
$ phm whoami --json
{"schemaVersion":1,"person":"mason","actor":"human","teams":[{"id":"platform","role":"owner"}],"orgs":["acme"],"scopes":["org:acme","person:mason","team:platform"]}
```

## Where identity comes from

- **Person**: this machine's own local auth. That is the OS user, or the name
  pinned in `$ASHLR_HOME/teams/owner.json` (`{"human":"<name>"}`). Phantom
  reads no token and sends none, and no node borrows another node's login. An
  agent (Claude Code, Codex and others) acts for the person it runs under, and
  `whoami` reports `"actor":"agent"`.
- **Team**: a local team bus you joined from a human terminal
  (`phm team join`) or were invited to (`phm team invite`). Posting a message
  under a claimed `--as` name does not make you a member.
- **Org**: groups teams in `$ASHLR_HOME/tenancy/orgs.json`. You belong to an
  org if you are listed as a member or belong to one of its teams.
- **Scopes**: `person:<you>`, `team:<id>` and `org:<id>`, sorted. Output has
  no timestamps, so the same state always prints the same bytes.

## What is enforced

| Record | Owner field | Enforced by |
|---|---|---|
| Node, job, job lease | `owner {kind,id}` in the drive lease store | `claim` refuses a job whose owner differs from the worker node's (unowned matches only unowned) |
| Job result (log) | inherits the job | credential-shaped values are scrubbed before the result is stored |
| Forum thread (`message.posted`) | the team bus | `phm team view/say/claim/join` and every `phm_team_*` MCP tool refuse a team you are not in |
| Context pack (`phm_team_context_get`) | the team bus, then `personal`/`company`/`client:<x>` | team check first, then the existing scope filter |

A team that no human has joined yet is unclaimed and stays open. The first
human to join it becomes its owner. Forum posts and context entries that
contain credential-shaped values are refused. So are imported events.

## Errors say how to fix themselves

Errors print `error:` and `fix:`, or `{"error","fix"}` with `--json`. For
example, reading another tenant's team prints a `fix:` line with the exact
command a team owner runs: `phm team invite human:<you> --team <id>`.
Exit codes: 0 success, 1 tenancy error, 2 bad usage.

## Limits

Identity is local. The team bus and lease store live on one host under
`$ASHLR_HOME`. A future remote registry has to carry the same `owner` fields
and repeat these checks at its own authority.
