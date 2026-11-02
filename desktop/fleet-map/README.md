# Fleet node map fixture

From the repository root, run `npx vite desktop/fleet-map` and open the printed
local URL. The standalone custom element uses perspective projection of 3D
coordinates, depth-scaled spheres and a rotation slider; it needs no GPU or backend.

Import `fleet-node-map.ts` to register `<fleet-node-map>`. Set its `graph` property
to a `FleetGraphSeed` (`fleet.v1`), and `statuses` to a map keyed by `agent:<id>`
or `mcp:<id>`. Missing telemetry is unknown. The default data is synthetic.
Agent relationships and MCP bindings are drawn as lines. Clicking or activating
a node with the keyboard dispatches a bubbling, composed `select` CustomEvent
whose `detail` contains `{ id, label, type, status }`.

Verify with `npx tsc --noEmit -p desktop/tsconfig.json` and
`HOME=$(mktemp -d) npx vitest run --config desktop/vitest.config.mts`.
