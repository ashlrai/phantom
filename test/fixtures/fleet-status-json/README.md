# Fleet status JSON golden fixtures

Captured through `cmdFleet(['status', '--json'])` from the original
`src/core/fleet/status.ts` at commit
`a6f3c32339411eb2d57cb35d4c78c33127bbb8e7`, before splitting its implementation.
They were updated for master's advisory pool-budget field and compact JSON output.

The fixtures use a fixed clock and an isolated empty home, with variants for
an engaged kill switch and a corrupt daemon state. Host companion probing,
resource sensors, build identity, and config loading are deterministic test
inputs. Persisted status readers and the CLI JSON writer are real.

`<fixture-home>` is the only variable: the test expands it in expected bytes
to the isolated temporary directory using native path separators. Actual stdout
is compared untouched,
including field order, formatting, and the final newline. These files are
not regenerated as part of a test run.

Run from the repository root:

```sh
HOME=$(mktemp -d) npx vitest run test/fleet-status-json-snapshot.test.ts
```
