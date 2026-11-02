import { homedir } from 'node:os';
import { join } from 'node:path';
import { readOperatorGlance } from '../core/fleet/operator-glance-read.js';
import { formatOperatorGlance } from '../core/fleet/operator-glance.js';

const usage = 'Usage: ashlr fleet glance [--json] [--root <dir>]';

export async function cmdFleetGlance(args: string[], opts: { runsDir?: string; now?: () => Date } = {}): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return 0; }
  let json = false;
  let root: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--root' && root === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) root = args[++i];
    else { console.error(usage); return 2; }
  }
  try {
    const now = (opts.now ?? (() => new Date()))();
    const glance = await readOperatorGlance({ runsDir: root ?? opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), now: () => now });
    console.log(json ? JSON.stringify(glance) : formatOperatorGlance(glance, now.getTime()));
    return 0;
  } catch {
    console.error('Unable to read fleet glance.');
    return 1;
  }
}
