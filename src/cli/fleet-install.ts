import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { previewFleetInstall } from '../core/fleet/install.js';
const usage = 'Usage: phm fleet install --dry-run [--repo <checkout>] [--bin <directory>] [--json]\nWrite a local Security review bundle; never install or change live files or pins.';
export async function cmdFleetInstall(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const options: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (['--dry-run', '--json'].includes(arg) && !flags.has(arg)) { flags.add(arg); continue; }
    if (!['--repo', '--bin'].includes(arg) || options[arg] || !args[i + 1] || args[i + 1]!.startsWith('--')) { console.error(usage); return 2; }
    options[arg] = args[++i]!;
  }
  if (!flags.has('--dry-run')) { console.error(usage); return 2; }
  try {
    const report = await previewFleetInstall(resolve(options['--repo'] ?? '.'), resolve(options['--bin'] ?? join(homedir(), '.ashlr-runs/bin')));
    if (flags.has('--json')) { console.error(report.summary); console.log(JSON.stringify(report)); }
    else console.log(report.summary);
    return report.gaps.length ? 1 : 0;
  } catch {
    console.error(flags.has('--json') ? JSON.stringify({ schema: 'fleet.install.v1', error: 'Cannot prepare bundle; check origin/master, manifest and output directory.' }) : 'Cannot prepare bundle; check origin/master, manifest and output directory.');
    return 2;
  }
}
