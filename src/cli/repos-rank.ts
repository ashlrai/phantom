import { basename, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { loadConfigReadOnly } from '../core/config.js';
import { localMerges, readRank, updateRank } from '../core/fleet/repo-rank.js';

export function cmdReposRank(args: string[]): number {
  if (args[0] !== 'rank' || args.slice(1).some(a => !['proposals', '--json', '--recompute'].includes(a))) {
    console.error('Usage: phm repos rank [proposals] [--json] [--recompute]');
    return 2;
  }
  const proposals = args.includes('proposals');
  const state = proposals ? readRank() : updateRank(() => {
    const repositories = loadConfigReadOnly().roots.flatMap(root => {
      try { return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => ({ repo: basename(e.name), path: join(root, e.name) })); } catch { return []; }
    });
    return localMerges(repositories);
  }, { recompute: args.includes('--recompute') });
  const result = proposals ? state?.proposals ?? [] : state;
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else if (proposals) console.log(JSON.stringify(result, null, 2));
  else console.log(state?.rankings.map((r, i) => `${i + 1}. ${r.repo} ${(100 * r.weight).toFixed(1)}%`).join('\n'));
  return 0;
}
