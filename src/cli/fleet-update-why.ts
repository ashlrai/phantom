import { updateFeedDiagnosis } from '../core/update-feed-diagnosis.js';

const USAGE = `Usage: phm fleet update-why [--json]
  Explain why the installed app sees no update, from the public update feed only.
  Read-only: never installs, downloads artifacts, alters the feed or a release,
  or sends messages. Only the fixed public latest.json and GitHub release
  metadata endpoints are contacted, each bounded by a timeout.
`;

interface FleetUpdateWhyDeps {
  diagnose?: typeof updateFeedDiagnosis;
}

export async function cmdFleetUpdateWhy(args: string[], deps: FleetUpdateWhyDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') { process.stdout.write(USAGE); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    process.stderr.write('usage: phm fleet update-why [--json]\n');
    return 2;
  }
  const result = await (deps.diagnose ?? updateFeedDiagnosis)();
  process.stdout.write((args.includes('--json') ? JSON.stringify(result) : result.message) + '\n');
  return 0;
}
