#!/usr/bin/env node
// queue.v1 fleet_hop emitter for the Mac bridge. Usage, at each station exit:
//   printf '%s' "$HOP_JSON" | phantom exec -- node scripts/fleet-hop.mjs
//   phantom exec -- node scripts/fleet-hop.mjs --replay
// Always exits 0 so the caller's exit code is unchanged. Requires `npm run build`.
try {
  const { runFleetHopCli } = await import('../dist/core/observability/fleet-hop.js');
  const chunks = [];
  if (!process.argv.includes('--replay')) for await (const c of process.stdin) chunks.push(c);
  await runFleetHopCli(process.argv.slice(2), Buffer.concat(chunks).toString('utf8'));
} catch {
  // telemetry never fails the caller
}
process.exit(0);
