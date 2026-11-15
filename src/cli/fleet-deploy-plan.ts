import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFleetDeployPlan } from '../core/fleet/deploy-plan.js';

const usage = 'Usage: phm fleet deploy-plan --since <sha> [--repo <path>] [--bin <path>] [--json]\nList changed fleet scripts without a matching live copy. Read-only; security-review files need a Security pin.';
export async function cmdFleetDeployPlan(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const options: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--since', '--repo', '--bin'].includes(arg) || options[arg] || !args[i + 1] || args[i + 1]!.startsWith('--')) { console.error(usage); return 2; }
    options[arg] = args[++i]!;
  }
  if (!options['--since']) { console.error(usage); return 2; }
  try {
    const report = await buildFleetDeployPlan(resolve(options['--repo'] ?? '.'), resolve(options['--bin'] ?? process.env.ASHLR_RUNS_BIN ?? join(homedir(), '.ashlr-runs/bin')), options['--since']);
    console.log(json ? JSON.stringify(report) : `${report.files.length} scripts need review; ${report.inSync} in sync.\n${report.files.map(file => `${file.repoPath} → ${file.livePath}: ${file.status}, ${file.action}`).join('\n')}`);
    return report.files.some(file => file.status === 'unreadable') ? 1 : 0;
  } catch {
    console.error(json ? JSON.stringify({ schema: 'fleet.deploy-plan.v1', error: 'Cannot build plan. Check the repository, manifest and ancestor commit SHA.' }) : 'Cannot build plan. Check the repository, manifest and ancestor commit SHA.');
    return 2;
  }
}
