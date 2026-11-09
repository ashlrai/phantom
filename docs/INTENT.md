# Private intent ledger

The local `ashlr.intent-ledger/v1` ledger tracks directives and ideas, their RQ keys, pulls, evidence and provenance. It lives at `~/.ashlr-runs/intent/ledger.json`, or `$ASHLR_RUNS_DIR/intent/ledger.json` when that variable is set. The store creates a private directory and mode 0600 file. Keep the ledger and real seed files out of git; the repository is public. Secret-shaped text is refused.

Each item has an ID, title, source, owner, status, RQ keys, pulls, evidence, provenance, timestamps and a stale interval (default seven days). Statuses are `proposed`, `queued`, `in-progress`, `merged`, `shipped`, `verified`, `superseded`, `closed` and `unknown`. Provenance records source, date, whether a copy is verbatim and whether it is partial. A trailing ellipsis marks a partial title; treat it as incomplete evidence, not a full directive. Import deduplicates matching RQ keys or normalized titles and keeps provenance. An imported status is a source claim, not independent verification.

## Example: import and record evidence

These inputs are fictional. Use a disposable directory outside the checkout; substitute carefully reviewed private inputs for real work. `phm` and `ashlr` name the same CLI.

```sh
export ASHLR_RUNS_DIR="$(mktemp -d)"
cat > "$ASHLR_RUNS_DIR/seed.json" <<'JSON'
[{"id":"demo-1","title":"Example directive","source":"fake-seed","owner":"example","rq":"RQ-DEMO-1","status":"queued","date":"2026-11-05T21:46:00Z","verbatim":true}]
JSON
cat > "$ASHLR_RUNS_DIR/copies.jsonl" <<'JSONL'
{"title":"Example directive...","source":"fake-copy","rq_key":"RQ-DEMO-1","status":"queued"}
{"id":"demo-2","title":"Another example","source":"fake-copy","rq_key":"RQ-DEMO-2","status":"proposed"}
JSONL
phm fleet intent-import "$ASHLR_RUNS_DIR/seed.json" "$ASHLR_RUNS_DIR/copies.jsonl" --json
phm fleet intent-read list --json
phm fleet intent-read get demo-1 --json
```

The import result reports `imported`, `deduped` and total `items`. List returns `records`; get returns `item`. The RQ key connects the two copies and the following evidence to `demo-1`.

```sh
# Preview, then record a caller-supplied merge claim.
phm fleet intent-evidence merged --repo example/project --number 42 --title 'RQ-DEMO-1 example' --json
phm fleet intent-evidence merged --repo example/project --number 42 --title 'RQ-DEMO-1 example' --apply --json
phm fleet intent-read get demo-1 --json
# Preview, then record a caller-supplied release claim.
phm fleet intent-evidence shipped --release example-v1 --rq RQ-DEMO-1 --json
phm fleet intent-evidence shipped --release example-v1 --rq RQ-DEMO-1 --apply --json
phm fleet intent-read get demo-1 --json
phm fleet intent-summary --json
phm fleet intent-sweep --json
phm fleet intent-sweep --apply --json
```

Evidence previews report `dryRun: true`, `applied: false` and matching IDs with their proposed statuses, without writing. `--apply` records matches locally; `applied` is false when none match. Merge matching uses RQ keys in the title or branch. Release matching uses `--rq` or keys in `--notes`; a release ID alone does not link a directive. Existing terminal statuses are preserved. These commands do not check GitHub, verify a release, or inspect an installed desktop. A recorded `shipped` status is a caller-supplied claim, not proof of a verified release or installed state. Independently inspect the relevant release and installed application before making either claim. Automatic snapshot linking is unavailable.

Summary includes source and count quality, counts and stale items. A missing ledger is reported as missing; reads treat it as empty. A corrupt or unreadable ledger is an error or unavailable/unknown, never proof of zero directives; summary's numeric placeholders must be interpreted with `countQuality`. Sweep previews overdue nonterminal records. Applying it refreshes local tracking and queues stale `in-progress` records; it neither dispatches jobs nor closes directives. Merged records receive an await-verification recommendation. Use `--now <ISO timestamp>` for a reproducible sweep.

## MCP

The `phm mcp fleet` server registers read-only `fleet_intent_read`. Call it with `{"action":"list"}` (optional `status` and `limit`, default 25, maximum 100) or `{"action":"get","id":"demo-1"}`. List reports total and truncation; get reports `found: false` for a missing ID. The server resolves its own ledger path and accepts no caller path. Corrupt or unreadable state is a tool error. It has no mutation authority. Add/update verbs, automatic linking and the original proposed world integration are not available through this guide's current surfaces.
