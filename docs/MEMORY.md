# Durable memory

`phm memory` keeps Mason's preferences, doctrine and facts so the chief of staff
(COS) intake can start every task with them. Each entry is one markdown file in
`~/.phantom/memory/`, written with owner-only permissions.

- `preference`: how Mason likes work done ("keep replies short").
- `doctrine`: rules that hold across projects ("never force-push").
- `fact`: stable background ("the release branch is master").

```sh
phm memory add "Keep replies short and direct" --kind preference --source chat --json
phm memory add "Outbound sends are draft then approve" --kind doctrine --json
phm memory list --kind doctrine --json
phm memory search outbound --json
phm memory forget pref-1a2b3c4d5e --json
```

`add` returns the entry id. Adding identical text again refreshes `updated`
instead of creating a duplicate. `search` matches every term, ignoring case,
across id, kind, source and text.

## File format

```markdown
---
id: pref-1a2b3c4d5e
kind: preference
source: chat
updated: 2026-11-04T12:00:00.000Z
---
Keep replies short and direct
```

Text is limited to 2000 characters. Files that are malformed, have an id that
does not match the file name, or contain a secret shape are ignored on read.

## Secrets

Entries are refused when they match the secret-shape scan used by connector
profiles (`scrubSecrets` plus the provider token shapes). The error never echoes
the rejected text. Store credentials in Phantom Secrets and refer to them by
binding name only, never by value.

## For the COS intake

`memoryContext({ home?, maxChars? })` in `src/core/cos/memory.ts` is read-only.
It returns a prompt block listing doctrine first, then preferences, then facts
(newest first within each kind), cut off at `maxChars` (default 4000). It returns
an empty string when nothing is stored or the directory is unreadable.
