# Locus 0.5.1 producer fixtures

Captured from a local build of Locus commit
`cba5f65061003f60e34f27eeea6784d3294f9be7` (workspace version 0.5.1).
The binary/source association is caller supplied, not attested. Schemas are
copied from that commit. These fixtures add a version directory without changing
#727's capture script, tests or 0.5.0 fixtures.

From the Phantom repository root, reproduce with:

```sh
node test/fixtures/locus-contract/0.5.1/capture.mjs \
  --locus-bin /absolute/path/to/locus/target/debug/locus \
  --locus-src /absolute/path/to/locus \
  --source-commit cba5f65061003f60e34f27eeea6784d3294f9be7 \
  --out test/fixtures/locus-contract/0.5.1
```

The capture helper adapts #727's bounded, scrubbed-environment collector. It
creates disposable local sample identities, retains the shell supervisor until
all probes complete, checks for capability leakage, and removes the scratch
homes. No provider credentials are inherited or resolved. It never applies a
doctor repair. As in #727, the restricted PATH does not establish network
isolation or prove Phantom absent.

Each scenario captures `status`, `status --json`, `status --oneline`,
`doctor --fix --json`, `--ashlr-handshake`, `agent report --json`,
`verify session --json` and `watch --once --json`. The short-pin scenario
re-enters the sample `acme` identity with a ten-minute TTL. The manifest records
exit codes; report and verification failures are retained, not discarded.

Timestamps, seals, worker paths and session identifiers are placeholders;
`expires_in_secs` preserves its sign class. Human remaining-time text becomes
`<COUNTDOWN>`, preserving the presence of the renewal hint. Readiness, expiry,
verification and frozen booleans are unchanged. Other environment-dependent
producer findings are retained and may change when recaptured.

`locus-051-fixtures.test.ts` checks fixture integrity only. It does not establish
consumer compatibility or unknown-shape rejection. The existing consumer and its
integration tests are Tier-1 paths prohibited by this job's instructions; see
`BRIDGE_NOTES.md` for the remaining parser work. In particular, human status,
repair plans and handshake envelopes must not be treated as readiness evidence.
