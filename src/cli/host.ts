/** `phm host load`, `phm host top`, `phm host disk` and `phm host memory`: what is loading and using this computer. Thin: the grouping lives in core/fleet/host-load and host-top. */
import { readHostLoadReport, type HostLoadDeps, type HostLoadReport, type HostLoadTrees } from '../core/fleet/host-load.js';
import { describeHostTop, hostDiskWarningLine, hostTopMemory, readHostTopReport, HOST_DISK_FLOOR_GB, type HostTopDeps, type HostTopReport } from '../core/fleet/host-top.js';
import { formatHostDisk, readHostDisk, type HostDiskDeps, type HostDiskReport } from '../core/fleet/host-disk.js';
import { formatHostMemory, readHostMemory, type HostMemoryDeps, type HostMemoryReport } from '../core/fleet/host-memory.js';
import { defaultRunsDir } from '../core/fleet/landed-closes-read.js';
import { formatLoadHistory, readLoadHistory, summarizeLoadHistory } from '../core/fleet/load-history.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = `Usage: phm host top [--json] [--groups] [--floor GB]
       phm host load [--json] [--by-tree]
       phm host load --history [--since 6h] [--json]
       phm host disk [--json] [--history]
       phm host memory [--json]
top   What is using this Mac: fleet workers, the local model server, Docker, each desktop app, Phantom, indexing and other,
      with load, memory pressure, swap used, the free-disk trend (GB per hour and hours to the floor) and one suggestion.
      --groups adds the busiest processes in each bucket. --floor sets the GB floor the trend measures to (default ${HOST_DISK_FLOOR_GB});
      reaching it in under 12 hours is a warning.
load  What is loading this computer, with fleet workers listed per job. --by-tree counts every job's builds, typechecks and tests
      with it and says what share of CPU the fleet's own jobs use. --json has owners (schema host.load.owners.v1): load share by
      producer (fleet jobs, Claude loop, Devin cloud, local model, main guardian, other), the admission guard's state from
      queue/admission-ctl.json, jobs idle over 45 minutes that still use CPU, and one next step.
--history  Why launches were blocked, after the fact: per hour the peak load, minutes blocked and the top 3 contributors, and one line
      such as "Most blocked time today: Docker (41%), then local model server (22%)." The self-tick takes a snapshot when the
      dispatcher blocks for host load (at most one per 10 minutes; kept 7 days, 2,000 rows). --since takes 1h to 7d (default 6h).
      --json is schema host.load.history.v1; with no snapshot it says unknown.
disk  How fast free disk is falling and when the lanes freeze: free GB now, GB per hour over the last 6 hours, hours until the
      freeze line (compact.lanes.raise_freeze_below_gb), the 5 largest job folders with age and finished or running, and one
      line saying what to run. --history adds the samples. --json is host.disk.v1. Unknown is said as unknown.
memory  Is this Mac really short of memory? Free %, swap used, swap growth per minute, swapouts per minute, the 5 largest processes
      by memory and one verdict: real pressure (free memory under 35% or swapouts above 0), swap growing but memory is free
      (likely a false alarm), fine, or unknown. --json is host.memory.v1. Unknown is said as unknown.
Read-only: nothing is ever stopped, deleted or quit. Exits 0 with a report, 1 when the process list (or free disk, for disk; too few memory readings, for memory) cannot be read, 2 on bad usage.`;

export function formatHostTop(report: HostTopReport, groups = false): string {
  const row = (name: string, cpu: number, mb: number, count: number) =>
    `${name.slice(0, 30).padEnd(30)} ${cpu.toFixed(1).padStart(7)} ${hostTopMemory(mb).padStart(9)} ${String(count).padStart(9)}`;
  const warning = hostDiskWarningLine(report.host.disk);
  const lines = [describeHostTop(report.host), ...(warning ? [warning] : []), report.suggestion.line];
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
  if (report.owners) lines.push(`Who: ${report.owners.summary}`, `Next: ${report.owners.nextStep}`);
  if (report.groups.length) lines.push(`${'Group'.padEnd(34)} Load    CPU%     Memory Processes`);
  for (const group of report.groups) {
    lines.push(row(group.name, group.loadPoints, group.cpuPercent, group.rssMb, group.processes));
    for (const item of group.items) lines.push(row(`  ${item.name}`.slice(0, 34), null, item.cpuPercent, item.rssMb, item.processes));
  }
  if (report.jobRoots !== null) lines.push(`Fleet job roots known: ${report.jobRoots}`);
  return [...lines, ...report.gaps.map(gap => `Note: ${gap}`)].join('\n');
}

export async function cmdHost(args: string[], deps: HostLoadDeps & HostTopDeps & HostDiskDeps & HostMemoryDeps & { write?: (text: string) => void; runsDir?: string } = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { write(`${USAGE}\n`); return 0; }
  const [verb, ...flags] = args;
  if (verb === 'top') {
    let json = false, groups = false, floor = HOST_DISK_FLOOR_GB, floorGiven = false;
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i]!;
      if (flag === '--json' && !json) json = true;
      else if (flag === '--groups' && !groups) groups = true;
      else if (flag === '--floor' && !floorGiven) {
        floorGiven = true;
        const value = Number(flags[++i]);
        if (!Number.isFinite(value) || value < 0) { console.error(USAGE.split('\n')[0]); return 2; }
        floor = value;
      } else { console.error(USAGE.split('\n')[0]); return 2; }
    }
    const top = sanitizePublicJson(await readHostTopReport({ ...deps, floorGb: floor })) as HostTopReport;
    write(`${json ? JSON.stringify(top) : formatHostTop(top, groups)}\n`);
    return top.state === 'unknown' ? 1 : 0;
  }
  if (verb === 'memory') {
    if (new Set(flags).size !== flags.length || flags.some(flag => flag !== '--json')) { console.error('Usage: phm host memory [--json]'); return 2; }
    const memory = sanitizePublicJson(await readHostMemory(deps)) as HostMemoryReport;
    write(`${flags.includes('--json') ? JSON.stringify(memory) : formatHostMemory(memory)}\n`);
    return memory.verdict === 'unknown' ? 1 : 0;
  }
  if (verb === 'disk') {
    if (new Set(flags).size !== flags.length || flags.some(flag => flag !== '--json' && flag !== '--history')) { console.error('Usage: phm host disk [--json] [--history]'); return 2; }
    const disk = sanitizePublicJson(await readHostDisk(deps, flags.includes('--history'))) as HostDiskReport;
    write(`${flags.includes('--json') ? JSON.stringify(disk) : formatHostDisk(disk).join('\n')}\n`);
    return disk.freeGb === null ? 1 : 0;
  }
  if (verb === 'load' && flags.includes('--history')) {
    let json = false, since = '6h', sinceGiven = false;
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i]!;
      if (flag === '--history' && flags.indexOf(flag) === i) continue;
      if (flag === '--json' && !json) json = true;
      else if (flag === '--since' && !sinceGiven) { sinceGiven = true; since = flags[++i] ?? ''; }
      else { console.error('Usage: phm host load --history [--since 6h] [--json]'); return 2; }
    }
    const now = (deps.now ?? Date.now)();
    const from = parseSince(since, now);
    const hours = from === null ? NaN : (now - from) / 3_600_000;
    if (!/^[1-9]\d{0,6}[mhd]$/.test(since) || hours < 1 / 60 || hours > 24 * 7) { console.error('--since takes 1h to 7d, for example 6h.'); return 2; }
    let rows: ReturnType<typeof readLoadHistory> = [];
    try { rows = readLoadHistory(deps.runsDir ?? defaultRunsDir()); } catch { /* Unknown history. */ }
    const history = sanitizePublicJson(summarizeLoadHistory(rows, now, hours)) as ReturnType<typeof summarizeLoadHistory>;
    write(`${json ? JSON.stringify(history) : formatLoadHistory(history)}\n`);
    return 0;
  }
  if (verb !== 'load' || new Set(flags).size !== flags.length || flags.some(flag => flag !== '--json' && flag !== '--by-tree')) { console.error(USAGE.split('\n')[1]); return 2; }
  const report = sanitizePublicJson(await readHostLoadReport(deps, { byTree: flags.includes('--by-tree') })) as HostLoadReport;
  const human = report.trees ? `${formatHostTrees(report.trees)}\n\n${formatHostLoad(report)}` : formatHostLoad(report);
  write(`${flags.includes('--json') ? JSON.stringify(report) : human}\n`);
  return report.state === 'unknown' ? 1 : 0;
}
