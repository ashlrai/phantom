# Local bus task roundtrip

From the repository root, preview a task without touching the inbox:

```sh
npx tsx examples/agents/bus-task-roundtrip.ts --dry-run --from fake-worker-a --to fake-worker-b --id fake-task-1 --text 'Review the fixture'
```

To append it and read its receipt back, replace `--dry-run` with `--post`:

```sh
npx tsx examples/agents/bus-task-roundtrip.ts --post --from fake-worker-a --to fake-worker-b --id fake-task-1 --text 'Review the fixture'
```

The default is Phantom's local fleet inbox (`$ASHLR_HOME/fleet` when an absolute
`ASHLR_HOME` is set, otherwise `~/.ashlr/fleet`). For an isolated experiment,
add `--root /absolute/path/to/private-directory`; the inbox creates its private
store there. `--root` must be absolute. Exactly one mode and each of the four
message flags are required. The envelope uses `P2`, a 60,000 ms TTL, and
`{ "text": ... }` as its body. Use the same ID and exact fields on retry.

Each invocation prints one JSON object on stdout. Dry-run prints the validated
six-field envelope. A successful post prints `{status, receipt, nextCursor}`;
status is `posted` or `duplicate`, and the receipt has `cursor`, `receivedAt`,
and the read envelope. The read starts at the receipt cursor minus one; the
returned TTL is reduced by elapsed time. A duplicate can have expired, in
which case the post was accepted earlier but the read fails. Read failure
includes the original `post` result so an accepted write is not mistaken for a
failed write.

Exit codes: `0` success, `2` invalid arguments or envelope (`invalid-arguments`
or `invalid-envelope` with validation `issues`), `3` post failure (the inbox
status, such as `conflict`, `full`, `retryable`, `invalid`, or `unavailable`),
and `4` read failure (`read-failed` and a `reason`). Full stores retain expired
records; expiry alone does not free capacity. A read is not an acknowledgement.

The inbox stores and displays body text as data, without scrubbing. Do not put
secrets in it. Routing labels are not authenticated identities; an embedding
host must handle identity and admission independently. This example does not
execute message bodies or contact providers.
