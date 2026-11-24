import { backlogLines, readReleaseBacklog } from '../core/release/backlog.js';
const usage = 'Usage: phm fleet release-backlog [--json]';
export async function cmdFleetReleaseBacklog(args: string[], read = readReleaseBacklog): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('phm fleet release-backlog [--json]\nGitHub backlog: due at 20 commits or 3 days; stale at 7 days. Cached for 10 minutes.\nMissing GitHub data uses local tags: due over 20 commits or over 7 days. Shallow clones or missing local tags use public remote tags.\nPHANTOM_RELEASE_CLONES overrides clone paths with a JSON object of repo names to paths. Read-only.'); return 0;
  }
  if (args.some(a => a !== '--json') || args.length > 1) { console.error(usage); return 2; }
  const report = await read();
  console.log(args.includes('--json') ? JSON.stringify(report) : backlogLines(report).join('\n'));
  return 0;
}
