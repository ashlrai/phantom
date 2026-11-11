# Explain a Tier-1 import

From the repository root:

```sh
npx tsx scripts/tier1-why.ts src/core/mcp-native.ts
npx tsx scripts/tier1-why.ts src/core/fleet/apps-recovery-invocations.ts --json
```

The command prints a shortest runtime import chain from any Tier-1 root to the file, or reports it unreachable. JSON contains `file`, `reachable`, and `chain` (null when unreachable). Exit 0 includes unreachable files; invalid arguments exit 2.

The TypeScript AST walk is copied verbatim from the authority closure test and checked for parity by the ordinary boundary test. It follows runtime imports, re-exports and literal dynamic imports, excluding type-only edges. Breadth-first search chooses a shortest chain; sorted roots make ties deterministic. No application code executes.

Fleet convention subcommands enter through `src/cli/fleet-entry.ts`; the MCP CLI registers fleet apps definitions from `src/core/mcp-native-fleet.ts`. Authority code can use the core native registry without importing app implementations. The ordinary `test/tier1-apps-boundary.test.ts` checks the full closure for apps implementation paths.

Never disguise an import to escape this scan. Do not regenerate the protected closure snapshot: Security reviews membership changes and Mason owns snapshot regeneration.
