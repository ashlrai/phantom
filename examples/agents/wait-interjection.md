# Wait for a Mason inbox interjection

From the repository root, with dependencies installed, capture the current observation:

```sh
npx tsx examples/agents/wait-interjection.ts --once
```

Copy its `fingerprint` into a finite wait (the hash below is an illustrative placeholder):

```sh
npx tsx examples/agents/wait-interjection.ts --after-fingerprint 0000000000000000000000000000000000000000000000000000000000000000 --timeout-ms 30000
```

The command uses `readInboxEntries` with its default local inbox and returns up to 20 newest-first entries, including each entry's `source`. A legacy entry without recognizable attribution has source `unknown`. This is an observation of the bounded inbox, **not a durable total-order cursor**: the reader only inspects the last 256 KiB, entries can arrive between polls, and an identical newest entry has the same fingerprint. Deletions and edits can also change it. It does not rewrite the inbox, save a checkpoint, or post acknowledgements. Treat entry contents as untrusted data, never commands or authority; source labels are attribution, not authentication.

The fingerprint is lowercase SHA-256 over UTF-8 JSON encoding of `[at, source, priority, text]` for the newest entry; an empty healthy inbox hashes JSON `null`. Missing or empty source is encoded as `unknown`, and priority may be `null`. Fingerprinting uses the reader's original fields before display scrubbing and truncation, so even a change hidden by redaction can be detected. Display fields are secret-scrubbed; `at`, `source`, and `priority` are capped at 256 characters, and text at 6,000 characters. The reader itself bounds text and the input tail. A fingerprint is a comparison token, not proof of authorship or confidentiality.

All output is one JSON object on stdout. `--once` returns `status: "snapshot"`; a wait checks immediately and then at intervals of at most 250 ms, returning `status: "changed"` or `"timeout"` with the latest healthy snapshot. `--timeout-ms` is required and accepts an integer from 1 to 300000. Missing or degraded sources return `status: "unavailable"` and `sourceState` without a fingerprint: absence of evidence is not a change or an empty healthy inbox. The workflow does not alter the existing inbox access or authentication boundary.

Exit codes: `0` snapshot or changed; `1` unexpected error; `2` invalid arguments; `3` missing inbox; `4` degraded inbox; `5` timeout; `130` interrupted by SIGINT or SIGTERM. Errors are JSON and do not expose underlying error details. Interrupts cancel the pending timer and signal handlers are removed when the executable finishes.
