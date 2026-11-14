# Implementation findings

No drive command, driver daemon, metrics command, restock implementation or publish.sh exists in this checkout. Use an explicit versioned local file contract until the driver lands. Reuse fleet CLI dispatch and fleet digest aggregation. Keep transport responsibility with Masbot. Protected paths were inspected read-only.

---

# Routing implementation notes

- Existing src/core/decide/decide.ts provides Jev confidence, accounting, budget and kill controls.
- src/cli/route.ts currently supports route explain only.
- docs/ROUTING.md does not yet exist.
- dispatchd.py writes dispatchd.admission.v2 at end of tick.
- No companion MCP tools called.
