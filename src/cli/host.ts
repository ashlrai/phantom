/** `phm host load` and `phm host top`: what is loading and using this computer. Thin: the grouping lives in core/fleet/host-load and host-top. */
import { readHostLoadReport, type HostLoadDeps, type HostLoadReport, type HostLoadTrees } from '../core/fleet/host-load.js';
import { describeHostTop, hostTopMemory, readHostTopReport, type HostTopDeps, type HostTopReport } from '../core/fleet/host-top.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = `Usage: phm host top [--json] [--groups]
       phm host load [--json] [--by-tree]
top   What is using this Mac: fleet workers, the local model server, Docker, each desktop app, Phantom, indexing and other,
      with load, memory pressure, swap used and one suggestion. --groups adds the busiest processes in each bucket.
load  What is loading this computer, with fleet workers listed per job. --by-tree counts every job's builds, typechecks and tests
      with it and says what share of CPU the fleet's own jobs use.
Read-only: nothing is ever stopped or quit. Exits 0 with a report, 1 when the process list cannot be read, 2 on bad usage.`;

export function formatHostTop(report: HostTopReport, groups = false): string {
  const row = (name: string, cpu: number, mb: number, count: number) =>
    `${name.slice(0, 30).padEnd(30)} ${cpu.toFixed(1).padStart(7)} ${hostTopMemory(mb).padStart(9)} ${String(count).padStart(9)}`;
  const lines = [describeHostTop(report.host), report.suggestion.line];
  if (report.frontApp) lines.push(`App in front: ${report.frontApp}`);
  if (report.state !== 'unknown') lines.push('', `${'Bucket'.padEnd(30)}    CPU%    Memory Processes`);
  for (const bucket of report.buckets.filter(bucket => bucket.processes > 0)) {
    lines.push(row(bucket.name, bucket.cpuPercent, bucket.rssMb, bucket.processes));
    if (groups) for (const item of bucket.items) lines.push(row(`  ${item.name}`, item.cpuPercent, item.rssMb, item.processes));
  }
  if (report.state !== 'unknown') lines.push(row('Total', report.totals.cpuPercent, report.totals.rssMb, report.totals.processes));
  return [...lines, ...report.gaps.map(gap => `Note: ${gap}`)].join('\n');
}

export function formatHostTrees(trees: HostLoadTrees): string {
  const row = (name: string, cpu: number, mb: number, count: number) =>
    `${name.slice(0, 34).padEnd(34)} ${cpu.toFixed(1).padStart(7)} ${`${mb} MB`.padStart(10)} ${String(count).padStart(9)}`;
  const lines = [trees.summary, '', `${'Tree'.padEnd(34)}    CPU%     Memory Children`];
  for (const root of trees.roots) {
    lines.push(row(root.name, root.cpuPercent, root.memoryMb, root.descendants));
    for (const top of root.topCommands) lines.push(`  ${top.command.slice(0, 60)} ${top.cpuPercent.toFixed(1)}`);
  }
  return lines.join('\n');
}

export function formatHostLoad(report: HostLoadReport): string {
  const row = (name: string, load: number | null, cpu: number, mb: number, count: number) =>
    `${name.padEnd(34)} ${String(load ?? '-').padStart(4)} ${cpu.toFixed(1).padStart(7)} ${`${mb} MB`.padStart(10)} ${String(count).padStart(9)}`;
  const lines = [report.summary];
  if (report.groups.length) lines.push(`${'Group'.padEnd(34)} Load    CPU%     Memory Processes`);
  for (const group of report.groups) {
    lines.push(row(group.name, group.loadPoints, group.cpuPercent, group.rssMb, group.processes));
    for (const item of group.items) lines.push(row(`  ${item.name}`.slice(0, 34), null, item.cpuPercent, item.rssMb, item.processes));
  }
  if (report.jobRoots !== null) lines.push(`Fleet job roots known: ${report.jobRoots}`);
  return [...lines, ...report.gaps.map(gap => `Note: ${gap}`)].join('\n');
}

export async function cmdHost(args: string[], deps: HostLoadDeps & HostTopDeps & { write?: (text: string) => void } = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { write(`${USAGE}\n`); return 0; }
  const [verb, ...flags] = args;
  if (verb === 'top') {
    if (new Set(flags).size !== flags.length || flags.some(flag => flag !== '--json' && flag !== '--groups')) { console.error(USAGE.split('\n')[0]); return 2; }
    const top = sanitizePublicJson(await readHostTopReport(deps)) as HostTopReport;
    write(`${flags.includes('--json') ? JSON.stringify(top) : formatHostTop(top, flags.includes('--groups'))}\n`);
    return top.state === 'unknown' ? 1 : 0;
  }
  if (verb !== 'load' || new Set(flags).size !== flags.length || flags.some(flag => flag !== '--json' && flag !== '--by-tree')) { console.error(USAGE.split('\n')[1]); return 2; }
  const report = sanitizePublicJson(await readHostLoadReport(deps, { byTree: flags.includes('--by-tree') })) as HostLoadReport;
  const human = report.trees ? `${formatHostTrees(report.trees)}\n\n${formatHostLoad(report)}` : formatHostLoad(report);
  write(`${flags.includes('--json') ? JSON.stringify(report) : human}\n`);
  return report.state === 'unknown' ? 1 : 0;
}
