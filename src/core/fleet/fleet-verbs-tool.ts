/**
 * phantom_fleet_verbs — the `ashlr fleet verbs` catalog over MCP.
 *
 * Observation only: builds the same fleet.verbs.v1 payload the CLI prints so
 * an MCP-only agent can discover which `ashlr fleet <verb>` commands exist.
 * It never spawns, never writes and never executes a verb.
 */
import { readFileSync } from 'node:fs';
import { buildFleetVerbCatalog, type FleetVerbEntry } from './fleet-verb-catalog.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../../cli/fleet-subcommand-registry.js';

/** Hard cap on the optional grep word (enforced as a wire contract). */
export const FLEET_VERBS_MAX_GREP_CHARS = 64;

export interface FleetVerbsCatalog {
  schema: 'fleet.verbs.v1';
  count: number;
  verbs: FleetVerbEntry[];
}

/** Same resolution the CLI uses: compiled dist file first, then the .ts source. */
function readVerbSource(verb: string): string | null {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(verb)) return null;
  for (const ext of ['js', 'ts']) {
    try { return readFileSync(new URL(`../../cli/fleet-${verb}.${ext}`, import.meta.url), 'utf8'); }
    catch { /* Try the source file next. */ }
  }
  return null;
}

export function fleetVerbsCatalog(
  grep?: string,
  deps: { verbs?: string[]; readSource?: (verb: string) => string | null } = {},
): FleetVerbsCatalog | { error: string } {
  const word = grep?.trim().toLowerCase();
  if (word !== undefined && [...word].length > FLEET_VERBS_MAX_GREP_CHARS) {
    return { error: `grep exceeds ${FLEET_VERBS_MAX_GREP_CHARS} characters` };
  }
  const verbs = buildFleetVerbCatalog(deps.verbs ?? Object.keys(FLEET_SUBCOMMAND_LOADERS), deps.readSource ?? readVerbSource)
    .filter(entry => word === undefined || word === '' ||
      [entry.verb, entry.usage, entry.summary].some(value => value?.toLowerCase().includes(word)));
  return { schema: 'fleet.verbs.v1', count: verbs.length, verbs };
}
