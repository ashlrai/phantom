import { formatAge, readHostTop, type HostGroup, type HostReportV1, type HostTopReader } from '../core/fleet/host-top.js';

const usage = `Usage: phm host [--top N] [--json]
What is using this machine: load, memory, the busiest program groups (fleet or not) and orphaned job processes.
Read-only. --top N sets rows per list (1-50, default 5). Unknown readings print as unknown.`;

const num = (value: number | null, unit = ''): string => value === null ? 'unknown' : `${value}${unit}`;
const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const cores = (percent: number | null): string => percent === null ? 'unknown' : `${(percent / 100).toFixed(1)} cores`;

function table(title: string, rows: HostGroup[]): string[] {
  return [title, ...rows.map(g => `  ${g.label.padEnd(14)} ${(g.fleet ? 'fleet' : 'not fleet').padEnd(9)} ${String(g.processes).padStart(5)} procs  ${cores(g.cpuPercent).padStart(11)}  ${gb(g.rssBytes).padStart(8)}`)];
}

export function formatHostReport(r: HostReportV1): string {
  const { load, memory, processes: p } = r;
  const perCpu = load.load1 !== null && load.cpuCount ? ` (${(load.load1 / load.cpuCount).toFixed(1)} per CPU)` : '';
  const lines = [
    `Load ${num(load.load1)} / ${num(load.load5)} / ${num(load.load15)} on ${num(load.cpuCount)} CPUs${perCpu}`,
    `Memory ${num(memory.freePercent, '%')} free · swap ${num(memory.swapGb, ' GB')}`,
  ];
  if (p.state === 'unknown') {
    lines.push(`Processes: unknown (${p.reason === 'ps-denied' ? 'ps is not permitted here' : 'ps could not be read'})`);
    return lines.join('\n');
  }
  const share = p.fleetShare === null ? '' : ` (${Math.round(p.fleetShare * 100)}%)`;
  lines.push(`CPU in use ${cores(p.cpuPercent)} by ${p.count} processes · fleet ${cores(p.fleetCpuPercent)}${share} · not fleet ${cores(p.otherCpuPercent)}`);
  // Load counts runnable and disk-waiting threads, so it can sit far above the CPU actually burned.
  if (load.load1 !== null && p.cpuPercent !== null && load.load1 - p.cpuPercent / 100 >= 1) {
    lines.push(`Load is ${(load.load1 - p.cpuPercent / 100).toFixed(1)} above the CPU in use: threads are waiting to run or on disk.`);
  }
  if (p.cwd === 'unavailable') lines.push('Working folders are not readable here; fleet ownership uses dispatchd ancestry and fleet paths on the command line.');
  lines.push(...table('Top by CPU', r.topCpu ?? []), ...table('Top by memory', r.topRss ?? []));
  lines.push(r.orphanCount ? `Orphans: ${r.orphanCount}` : 'Orphans: none');
  for (const o of r.orphans ?? []) {
    lines.push(`  pid ${o.pid} ${o.name} ${o.job} · ${o.reason === 'worktree-gone' ? 'worktree gone' : 'parent is launchd'} · ${formatAge(o.ageSeconds)}`);
  }
  return lines.join('\n');
}

/** `phm host [--top N] [--json]`: read-only; exits 0, or 2 on a bad flag. */
export async function cmdHost(args: string[], deps: { reader?: HostTopReader } = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  let json = false, top = 5;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = arg === '--top' ? args[++i] : arg.startsWith('--top=') ? arg.slice(6) : undefined;
    if (arg === '--json') json = true;
    else if (value !== undefined && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 50) top = Number(value);
    else { console.error(usage.split('\n')[0]); return 2; }
  }
  const report = await readHostTop({ top, reader: deps.reader });
  console.log(json ? JSON.stringify(report, null, 2) : formatHostReport(report));
  return 0;
}
