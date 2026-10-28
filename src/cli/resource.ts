import { writeResourceView } from '../core/fabric/resource-view-store.js';

export async function cmdResource(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('phm resource [--json] [--directory <fleet-directory>]\nRefresh resource.v1 in fleet.json from recorded inputs. Unknown inputs remain unknown.\n');
    return 0;
  }
  let directory: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--json') continue;
    if (args[i] === '--directory' && args[i + 1] && !args[i + 1]!.startsWith('-')) { directory = args[++i]; continue; }
    process.stderr.write('Invalid resource arguments. Use phm resource --help.\n'); return 2;
  }
  try {
    const view = writeResourceView(directory);
    process.stdout.write(args.includes('--json') ? JSON.stringify(view, null, 2) + '\n'
      : view.pools.map(pool => `${pool.pool}: ${pool.status}, used ${pool.pctUsed === null ? 'unknown' : `${pool.pctUsed}%`}, pace ${pool.paceRatio === null ? 'unknown' : `${pool.paceRatio.toFixed(2)}x`}`).join('\n') + '\n');
    return 0;
  } catch {
    process.stderr.write('Resource view unavailable: fleet storage is busy, unsafe or invalid.\n'); return 1;
  }
}
