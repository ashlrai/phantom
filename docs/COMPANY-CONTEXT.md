# Company context

Save a sourced note, then read the current digest:

```sh
phm context write --section decisions --text 'Keep the rollout small' --source 'planning meeting' --json
phm context read --json
phm context read --section decisions --max-tokens 512 --json
```

Sections are `decisions`, `priorities`, `clients`, `people`, and `fleet-state`.
Notes stay on this computer in `~/.ashlr-runs/context/company.context.v1.jsonl`
with schema `company.context.v1`. Writes use a cross-process lock. Repeating the
same section, text, and source produces the same ID and adds nothing. Use
`--id ID` for an upstream event ID; the first note with an ID wins.

Use `--expires 2027-01-01T00:00:00Z` for temporary context. Expired notes remain
in the append-only file but leave the digest. Reads default to a 1024 token
budget (maximum 16000), conservatively counting each UTF-8 byte as one unit.
The budget covers the digest, including section and source labels; JSON
metadata is outside that budget. `truncated` reports omitted digest text.
An empty store returns an empty digest. Keys and credential-like text are
refused in text, sources, and IDs; use Phantom Secrets references instead.

The typed API is `writeCompanyContext` / `readCompanyContext` in
`src/core/context/company-context-store.ts`. Both CLI paths support `--json`.
Acceptance: as simple and intuitive as possible, fewer steps, plain words,
one obvious path, and each human surface backed by this typed API and CLI.
