/**
 * `phm world` prints ashlr.world-model/v1. `phm world get <path>` reads one
 * node from the cached snapshot. Read-only. No gh and no credential files.
 */
import { readWorldModel } from '../core/world/read.js';
import { worldGet } from '../core/world/path.js';

const USAGE = `phm world [--json] [--refresh]
phm world get <path> [--json] [--refresh]

One ashlr.world-model/v1 snapshot. A warm cache is the tick read.
Unknown stays unknown. See docs/WORLD.md.`;

export async function cmdWorld(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const force = args.includes('--refresh');
  const rest = args.filter((arg) => arg !== '--json' && arg !== '--refresh');
  if (args.includes('--help') || args.includes('-h')) {
    console.log(json ? JSON.stringify({ usage: USAGE }) : USAGE);
    return 0;
  }
  if (rest.some((arg) => arg.startsWith('-'))) {
    console.error(USAGE);
    return 2;
  }
  const model = await readWorldModel({ force });
  if (rest[0] === 'get') {
    const path = rest[1];
    if (!path || rest.length !== 2) {
      console.error(USAGE);
      return 2;
    }
    const value = worldGet(model, path);
    console.log(JSON.stringify(value, null, json ? 2 : 0));
    return 0;
  }
  if (rest.length !== 0) {
    console.error(USAGE);
    return 2;
  }
  if (json) console.log(JSON.stringify(model, null, 2));
  else console.log(`World model ${model.schema}. ${model.blindSpots.length} blind spots. Cache ${model.cache.hit ? 'hit' : 'miss'} ${model.cache.ageMs}ms.`);
  return 0;
}
