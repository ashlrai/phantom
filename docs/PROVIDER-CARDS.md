# Provider capacity cards

One card per provider shows how much of each plan is used, when it resets, and
whether the current pace will run out first. Pools are grouped by vendor:

| Card | Pools |
|---|---|
| OpenAI | `codex-personal`, `terra` |
| Anthropic | `claude-max` |
| Cognition / Devin | `devin` |
| xAI | `grok-ultra` |
| Local | local model count, no quota |

Cards show usage numbers only. No keys, tokens or account identifiers are read
or rendered. A pool with no fresh reading shows `unknown`, never a guessed
percentage, and gets no chart. When a pool has a reading, burn rate and an
upcoming reset, its burn-down chart forecasts the remaining share to that reset
from the observed burn. The window start is not reported, so the even-pace line
starts one hour before the reading.

Logos are monograms because vendor logos are not licensed for this repository
(`desktop/PROVIDER-MARKS-LICENSE.txt`).

## See it

```bash
phm resource --cards          # plain text
phm resource --cards --json   # provider-cards.v1
phm serve                     # web console: Fleet dashboard and Resources routing board
```

Example (`--json`, shortened):

```json
{ "schema": "provider-cards.v1",
  "providers": [{ "provider": "anthropic", "label": "Anthropic", "status": "amber",
    "maxPctUsed": 62.5, "nextResetAt": "2026-11-02T18:00:00.000Z", "pools": [] }],
  "localModels": { "status": "unknown", "count": null, "fetchedAt": null } }
```

The web console reads the same `resource.v1` data (`GET /api/resource`) and
groups it with the same code (`src/core/fabric/provider-cards.ts`), so the CLI
and the UI always agree. The desktop mission-control view (bc-124196c5) is not
part of this change.

## Storage and isolation

`phm resource` reads and refreshes `$ASHLR_HOME/fleet.json` (default
`~/.ashlr/fleet.json`), or the directory passed with `--directory`. To try it
without touching real Phantom state, set `ASHLR_HOME=$(mktemp -d)` or
`HOME=$(mktemp -d)`:

```bash
ASHLR_HOME=$(mktemp -d) phm resource --cards --json
```

OS ancestor symlinks in a scratch home (such as `/var` on macOS) resolve safely,
while a symlinked leaf directory or a non-private directory mode is still
refused. With `--json`, usage errors (exit 2) and storage refusals (exit 1)
print one `{ "ok": false, "error": { "code", "message" } }` object on stdout.
