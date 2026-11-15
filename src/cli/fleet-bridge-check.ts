import { stripVTControlCharacters } from 'node:util';
import { sanitizeIdentityText } from '../core/fleet/runtime-identity.js';
import { readFleetBridgeCheck, type FleetBridgeCheckDeps } from '../mcp/fleet-bridge-check.js';

/** One producer label for terminal output, sanitized like the Slack bridge
 * reply; missing or empty is 'unknown', never the CLI's own host. */
function safeLabel(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return 'unknown';
  return sanitizeIdentityText(stripVTControlCharacters(value)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\/(?:Users|home)\/[^/\s;,)]+/g, '~'), '').trim().slice(0, 64) || 'unknown';
}

/** Compact `[source asOf]` suffix when a section carries evidence beyond the
 * reader defaults; the producer timestamp survives a later caller clock. */
function evidenceSuffix(section: { source?: unknown; asOf?: unknown }, fallbackSource: string, checkAsOf: string): string {
  const source = typeof section.source === 'string' ? section.source : fallbackSource;
  const asOf = typeof section.asOf === 'string' ? section.asOf : checkAsOf;
  if (source === fallbackSource && asOf === checkAsOf) return '';
  return ` [${safeLabel(source)} ${safeLabel(asOf)}]`;
}

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
    else {
      const runtime = result.runtime;
      const identity = 'host' in runtime || 'stateRoot' in runtime
        ? ` · host ${safeLabel(runtime['host'])} · stateRoot ${safeLabel(runtime['stateRoot'])}` : '';
      console.log([
        result.verdict === 'READY' ? 'Bridge: READY' : `Bridge: BLOCKED (missing: ${result.missing.join(', ')})`,
        `as of ${result.asOf}`,
        `runtime: ${runtime.status}${runtime.reason ? ` (${runtime.reason})` : ''}${identity}${evidenceSuffix(runtime, 'fleet-runtime', result.asOf)}`,
        `claims: ${result.claims.live ?? 'unknown'} live, newest ${result.claims.newestAgeSec ?? 'unknown'}s${evidenceSuffix(result.claims, 'coordination-ledger', result.asOf)}`,
        `peers: ${result.peers.status}${evidenceSuffix(result.peers, 'peer-ledger', result.asOf)}`,
        'Reachability only; grants no claim, dispatch or merge authority.',
      ].join('\n'));
    }
    return result.verdict === 'READY' ? 0 : 3;
  } catch {
    console.error('Bridge: BLOCKED (missing: bridge-check)');
    return 3;
  }
}
