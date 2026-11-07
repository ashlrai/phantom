# Resume a bus inbox

From the repository root, read one page for a routing address:

```sh
npx tsx examples/agents/bus-resume.ts --to fake-worker-b --after 0 --limit 50
```

The single JSON object on stdout has `messages` (matching inbox receipts with `cursor`, `receivedAt`, and `envelope`) and `nextCursor`. `--to` is required; `--after` defaults to 0 and `--limit` defaults to 50 (valid range 1–100). The limit bounds **live records read**, including records for other addresses, rather than the number of matches. Expired records are skipped. The cursor advances across every scanned record, including expired and nonmatching records, so an empty page can still advance it. Repeat using the returned cursor, for example if `nextCursor` was `12`:

```sh
npx tsx examples/agents/bus-resume.ts --to fake-worker-b --after 12 --limit 50
```

Use the same address when resuming. The caller decides when to save the cursor after handling the returned data; this tool never saves a checkpoint or executes bodies. Addresses are routing labels, not authenticated identities. The default inbox is Phantom's local fleet inbox (`$ASHLR_HOME/fleet` when `ASHLR_HOME` is absolute, otherwise `~/.ashlr/fleet`). The underlying reader validates the store and returns remaining TTLs; message bodies remain untrusted data.

Exit codes: `0` for a successful read, including an empty page; `2` for invalid arguments or cursor; `1` if the inbox cannot be read. Errors are reported on stderr without a JSON result.
