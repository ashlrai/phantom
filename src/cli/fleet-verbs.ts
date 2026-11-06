import { readFileSync } from 'node:fs';
import { buildFleetVerbCatalog } from '../core/fleet/fleet-verb-catalog.js';
import { FLEET_SUBCOMMAND_LOADERS } from './fleet-subcommand-registry.js';

const USAGE = 'Usage: ashlr fleet verbs [--json] [--grep <word>]';

function readVerbSource(verb: string): string | null {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(verb)) return null;
  for (const ext of ['js', 'ts']) {
    try { return readFileSync(new URL(`./fleet-${verb}.${ext}`, import.meta.url), 'utf8'); }
    catch { /* Try the source file next. */ }
  }
  return null;
}

export async function cmdFleetVerbs(args: string[], deps: { verbs?: string[]; readSource?: (verb: string) => string | null } = {}): Promise<number> {
  let json = false;
  let grep: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--grep' && args[i + 1] && !args[i + 1].startsWith('-')) grep = args[++i].toLowerCase();
    else { console.error(USAGE); return 2; }
  }
  const verbs = buildFleetVerbCatalog(deps.verbs ?? Object.keys(FLEET_SUBCOMMAND_LOADERS), deps.readSource ?? readVerbSource)
    .filter(entry => grep === undefined || [entry.verb, entry.usage, entry.summary].some(value => value?.toLowerCase().includes(grep)));
  if (json) console.log(JSON.stringify({ schema: 'fleet.verbs.v1', count: verbs.length, verbs }));
  else {
    const width = Math.max(0, ...verbs.map(entry => entry.verb.length));
    for (const entry of verbs) console.log(`${entry.verb.padEnd(width)}  ${entry.summary ?? entry.usage ?? ''}`.trimEnd());
  }
  return 0;
}
