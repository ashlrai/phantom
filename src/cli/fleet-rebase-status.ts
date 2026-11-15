import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readRebaseStatus } from '../core/fleet/rebase-status.js';

const usage = 'Usage: phm fleet rebase-status --repo <owner/name> [--repo <owner/name> ...] [--root <abs>] [--json]';
export async function cmdFleetRebaseStatus(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const repos: string[] = [];
  let root = join(homedir(), '.ashlr-runs'), json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args[i + 1] ?? '')) repos.push(args[++i]!);
    else if (args[i] === '--root' && isAbsolute(args[i + 1] ?? '')) root = args[++i]!;
    else if (args[i] === '--json' && !json) json = true;
    else { console.error(usage); return 2; }
  }
  if (!repos.length || new Set(repos.map(r => r.split('/')[1]!.toLowerCase())).size !== repos.length) { console.error(usage); return 2; }
  const report = await readRebaseStatus(repos, root);
  if (json) console.log(JSON.stringify(report));
  else { console.log(`Queue: ${report.queueSource}`); for (const r of report.repos) console.log(`${r.repo}: ${r.source} ${JSON.stringify(r.summary)}`); }
  return report.queueSource === 'healthy' && report.repos.every(r => r.source === 'ok') ? 0 : 1;
}
