# Findings
Masbot's operator-glance implementation is present. Email allowlist fallback and Telegram first-message pairing do not satisfy authenticated-only access. Phone already uses Cloudflare Access and pairing; loopback auth is out of scope. Preserve local commands and inbox text handling.

## RQ-PARK-AUTOUNPARK-1

# Implementation notes

The Mac restocker is contrib/mac/restock.py. Existing PARKED-DEP rows in ready.tsv use metrics/jobs.jsonl and must remain compatible. No fixed per-repo merge-rate cap exists in this restocker. New parked.tsv behavior must use GitHub merged PR evidence and fail closed on query errors. Live install requires Security re-pin and is outside this task.

GitHub schema confirms mergeQueue defaults to the default branch when branch is omitted:
https://docs.github.com/en/graphql/reference/repos#repository
Runner status/busy fields: https://docs.github.com/en/rest/actions/self-hosted-runners
Queries stay outside ready.lock; parked snapshot and current ready counts are revalidated under lock.
