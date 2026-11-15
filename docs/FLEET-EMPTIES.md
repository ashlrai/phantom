# Empty job reasons

Run `phm fleet empties --since 24h --json` to group recorded empty outcomes by lane, repository and reason. The report also ranks the five most frequent reasons and suggests a filler rule for each. Omit `--json` for a readable report; `--since` accepts a positive number of hours such as `24h` and defaults to 24 hours. The command only reads the local metrics ledger and does not change filler or dispatch rules.

The report counts matching ledger rows, including outcome rows with `empty: true` and rows explicitly marked `EMPTY_DONE`. It reads the row's `lane`, `repo` and `reason` fields; missing or blank fields are `unknown`. It does not infer reasons or inspect job logs, join launch metadata, or deduplicate multiple outcome rows for one attempt. An unreadable or oversized ledger returns `known: false` and `total: null`; a readable ledger with no matching rows returns zero. Suggested rules are prompts for review, not automatic changes.
