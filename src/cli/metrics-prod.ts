import { collectProduction, productionReads, type ProductionReads } from '../core/metrics/production.js';

const USAGE = `Usage: phm metrics prod [--repo OWNER/REPO ...] [--lane NAME] [--bridge-label LABEL] [--json]
Read bridge PR merge, pinned release ancestry and exact npm or crates.io publication evidence.
Unknown evidence stays in the denominator. Exit 0 includes partial evidence, 1 unavailable PR population, 2 usage.
`;

interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export async function cmdMetricsProd(
  args: string[],
  overrides: Partial<ProductionReads> = {},
  io?: CliIo,
): Promise<number> {
  const out = (text: string): void => {
    if (io) io.out(text);
    else process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  };
  const err = (text: string): void => {
    if (io) io.err(text);
    else process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  };
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { out(USAGE); return 0; }
  const repos: string[] = [];
  let lane: string | undefined;
  let label = 'bridge';
  let json = false;
  if (args[0] !== 'prod') { err(USAGE); return 2; }
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json' && !json) { json = true; continue; }
    if (!['--repo', '--lane', '--bridge-label'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('-')) { err(USAGE); return 2; }
    const value = args[++i];
    if (flag === '--repo') repos.push(value);
    else if (flag === '--lane') lane = value;
    else label = value;
  }
  if (repos.some(repo => !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repo))) { err(USAGE); return 2; }
  try {
    const reads = { ...productionReads, ...overrides };
    if (!repos.length) {
      const current = await reads.github('repos/{owner}/{repo}');
      if (!current || typeof current !== 'object' || !('full_name' in current)
        || typeof current.full_name !== 'string'
        || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(current.full_name)) throw new Error('Repository unavailable');
      repos.push(current.full_name);
    }
    const reports = [];
    for (const repo of [...new Set(repos)].sort()) reports.push(await collectProduction(repo, reads, label, lane));
    const report = { schemaVersion: 1, denominator: 'all bridge PRs', bridgeLabel: label, reports };
    out(json ? JSON.stringify(report, null, 2) : reports.flatMap(report => report.groups.map(group =>
      `${group.repo} lane=${group.lane} total=${group.total} merged=${group.merged} released=${group.released} published=${group.published} productionShare=${group.productionShare} unknown=${group.publicationUnknown}`)).join('\n') || 'No bridge PRs found.');
    return 0;
  } catch { err('Production metrics unavailable; GitHub evidence could not be read.'); return 1; }
}
