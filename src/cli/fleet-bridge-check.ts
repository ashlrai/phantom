import { readFleetBridgeCheck, type FleetBridgeCheckDeps } from '../mcp/fleet-bridge-check.js';

export async function cmdFleetBridgeCheck(args: string[], deps: FleetBridgeCheckDeps = {}): Promise<number> {
  const usage = 'Usage: ashlr fleet bridge-check [--json] [--help|-h]\nExit codes: 0 READY/help, 3 BLOCKED, 2 bad arguments.';
  const seen = new Set<string>();
  for (const arg of args) {
    if (seen.has(arg) || !['--json', '--help', '-h'].includes(arg)) {
      console.error(usage);
      return 2;
    }
    seen.add(arg);
  }
  if (seen.has('--help') || seen.has('-h')) { console.log(usage); return 0; }
  try {
    const result = await readFleetBridgeCheck(deps);
    if (seen.has('--json')) console.log(JSON.stringify(result));
    else console.log([
      result.verdict === 'READY' ? 'Bridge: READY' : `Bridge: BLOCKED (missing: ${result.missing.join(', ')})`,
      `as of ${result.asOf}`,
      `runtime: ${result.runtime.status}${result.runtime.reason ? ` (${result.runtime.reason})` : ''}`,
      `claims: ${result.claims.live ?? 'unknown'} live, newest ${result.claims.newestAgeSec ?? 'unknown'}s`,
      `peers: ${result.peers.status}`,
      'Reachability only; grants no claim, dispatch or merge authority.',
    ].join('\n'));
    return result.verdict === 'READY' ? 0 : 3;
  } catch {
    console.error('Bridge: BLOCKED (missing: bridge-check)');
    return 3;
  }
}
