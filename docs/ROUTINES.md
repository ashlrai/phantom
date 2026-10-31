# Portable routine placement

`phantom routines import routines.json` merges a portable document, preserving
IDs and ledger state. Conflicting IDs refuse the entire import. Re-importing the
same document is safe. `phantom routines export > routines.json` exports it;
`phantom routines rebalance` re-places every saved routine and prints the document.

```json
{"schema":"phantom-routines.v1","routines":[{"id":"morning-summary","schedule":"FREQ=DAILY;BYHOUR=8;BYMINUTE=0","prompt":"Summarize engineering progress.","capabilities":["report"],"last_ledger_state":null}]}
```

The local registry lives in `<ashlr home>/routines/routines.json`. A credential-free
collector supplies `providers.json` in the same directory: an object keyed by
provider/account ID (`codex`, `claude`, `devin`, `grokbot`, `local`, or another
stable ID). Every entry follows the same probe contract, for example:

```json
{"grokbot":{"health":"ready","quota_state":"available","reset_at":"2026-11-01T00:00:00.000Z","observed_at":"2026-11-01T00:00:01.000Z","expires_at":"2026-11-01T00:05:01.000Z","cost":0,"capabilities":["report"]}}
```

`cost` is the collector's comparable estimated cost per firing. The adapter
interface also accepts live probe functions. Evidence expires within five minutes;
failed probes, unknown/low/exhausted quota, unhealthy providers, and missing
capabilities are ineligible. Eligible providers sort by cost then stable ID.
The Grok Bot reset is November 1, 2026 UTC; reset alone never manufactures quota.
A fresh post-reset available probe makes it eligible again. Exhaustion moves work
away on the next rebalance. The existing Verse automation timer rebalances every
minute while running. Run the explicit command when that timer is disabled.

This registry records placement, not provider-side schedule creation or task
execution. Existing automation dispatch and the Grok Bot transport retain their
own authority, spending, reservation, and deduplication checks. Imported ledger
state is historical metadata and grants no permission. No remote provider is
contacted by import/export/rebalance. Collectors must publish fresh evidence;
this command does not discover accounts or credentials. Keep prompts public and
credential-free; documents are limited to 16 KiB and 50 routines.
