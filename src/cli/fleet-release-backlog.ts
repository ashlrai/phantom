import { backlogLines, readReleaseBacklog } from '../core/release/backlog.js';
export async function cmdFleetReleaseBacklog(args: string[], read = readReleaseBacklog): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('phm fleet release-backlog [--json]\nUnshipped default-branch commits: due at 20 commits or 3 days; stale at 7 days. Read-only, cached for 10 minutes.'); return 0;
  }
  if (args.some(a => a !== '--json') || args.length > 1) { console.error('Usage: phm fleet release-backlog [--json]'); return 2; }
  const report = await read();
  console.log(args.includes('--json') ? JSON.stringify(report) : backlogLines(report).join('\n'));
  return 0;
}
