# Fleet status JSON golden fixtures

Captured through `cmdFleet(['status', '--json'])` from the split
`src/core/fleet/status.ts` modules on current main, preserving the public
snapshot contract after the module extraction. The compact single-line writer
is main's current format; the `schema`, `memory`, and `budgets` fields are
main's additive `fleet.v1` observations.

The fixtures use a fixed clock and an isolated empty home, with variants for
an engaged kill switch and a corrupt daemon state. Host companion probing,
resource sensors, build identity, and config loading are deterministic test
inputs. Persisted status readers and the CLI JSON writer are real.

`<fixture-home>` is the only variable: the test expands it in expected bytes
to the isolated temporary directory using native path separators. Actual stdout
is compared untouched,
including field order, indentation, and the final newline. These files are
not regenerated as part of a test run.

Run from the repository root:

```sh
HOME=$(mktemp -d) npx vitest run test/fleet-status-json-snapshot.test.ts
```
