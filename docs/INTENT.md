# Intent ledger

`phm intent` keeps a local ledger of owner directives and design ideas. The file is `~/.ashlr-runs/intent/ledger.json` (mode 0600). `ASHLR_RUNS_DIR` overrides the state directory. The ledger is not committed. Phantom is public, and the directives are not.

Schema: `ashlr.intent-ledger/v1`. Each item has an id, title, source, owner, RQ keys, linked pulls, status, verification evidence, provenance, `lastTouchedAt`, and a stale timer. Status is `proposed`, `queued`, `in-progress`, `merged`, `shipped`, `verified`, `superseded`, `closed`, or `unknown`. Provenance records the file or agent, a date, and whether that copy was verbatim or cut off mid-sentence.

```sh
phm intent list --json
phm intent get <id> --json
phm intent add --title "<text>" --source <label> --rq <RQ-KEY> --json
phm intent update <id> --status queued --json
phm intent import seed-ledger.json mac-seed.jsonl --json
phm intent stale --json
phm intent stale --apply --json
phm intent link --repo <owner/name> --number <n> --title "<title>" --branch <branch> --json
phm intent ship --release <id> --notes "<notes>" --json
```

`import` accepts several JSONL files and one JSON document. A mac-lane line is `{ "id", "title", "source", "date", "rq_key", "status" }`. Rows that share an RQ key, or the same title after lowercasing and stripping a trailing ellipsis, become one item. Each source is kept on `provenance`. A title that ends in `...` or `…` is `partial`. Secret-shaped text is refused.

`stale` is a dry run. `--apply` re-queues `in-progress` work, proposes superseded closure for a directive that was already re-queued or has no RQ key and no pull, and closes it on the next stale window. A merged item that is still not shipped gets an await-verification note, then a superseded proposal if it stays stale.

When the fleet runs snapshot includes a newly merged pull whose title or branch contains an RQ key, the matching item becomes `merged` if it was still open. `phm intent link` does the same for one pull. `phm intent ship` marks matching items `shipped` when a release id, its notes, or `--rq` names their key. Verified, superseded, and closed items are left as they are. A verification note on a merged or shipped item marks it `verified`.

`phm world --json` includes `intents` totals: items, tracked, merged, shipped, verified, and stale. A missing ledger is unknown, not zero. Each stale item is also a `blindSpots` row at `intents.stale.<id>`. The desktop Intent pane reads `GET /api/verse/intent`. MCP tools are `intent_list`, `intent_get`, `intent_add`, `intent_update`, `intent_import`, `intent_stale`, `intent_link`, and `intent_ship`.

```sh
HOME=$(mktemp -d) npm run test:ci -- test/intent-ledger.test.ts
```
