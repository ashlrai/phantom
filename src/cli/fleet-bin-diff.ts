import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fleetBinDiff } from '../core/fleet/bin-diff.js';

const usage = 'Usage: phm fleet bin-diff [--repo <checkout>] [--bin <directory>] [--pins <SHA256SUMS>] [--json]';

/** Compare shipped fleet scripts with the live bin directory, without writing. */
export async function cmdFleetBinDiff(args: string[]): Promise<number> {
  let repo = process.cwd();
  let bin = resolve(homedir(), '.ashlr-runs/bin');
  let pins: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json') json = true;
    else if (arg === '--repo' || arg === '--bin' || arg === '--pins') {
      const value = args[++i];
      if (!value || value.startsWith('--')) { console.error(usage); return 2; }
      if (arg === '--repo') repo = resolve(value);
      else if (arg === '--bin') bin = resolve(value);
      else pins = resolve(value);
    } else { console.error(usage); return 2; }
  }
  try {
    const report = await fleetBinDiff(repo, bin, pins ?? resolve(bin, 'SHA256SUMS'));
    const c = report.counts;
    console.log(json ? JSON.stringify(report) : `Fleet scripts: ${c['in-sync']} in sync, ${c.drifted} drifted, ${c.missing} missing, ${c.pinned} pinned.`);
    return 0;
  } catch (error) {
    console.error(`fleet bin-diff: ${error instanceof Error ? error.message : 'Could not read files'}`);
    return 1;
  }
}
