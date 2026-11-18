/** `phm host load [--json]`: what is loading this computer. Thin: the grouping lives in core/fleet/host-load. */
import { readHostLoadReport, type HostLoadDeps, type HostLoadReport } from '../core/fleet/host-load.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = `Usage: phm host load [--json]
Shows what is loading this computer: fleet workers (per job), local models, desktop apps, the system and other.
Read-only. Exits 0 with a report, 1 when the process list cannot be read, 2 on bad usage.`;

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

export async function cmdHost(args: string[], deps: HostLoadDeps & { write?: (text: string) => void } = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { write(`${USAGE}\n`); return 0; }
  const [verb, ...flags] = args;
  if (verb !== 'load' || flags.length > 1 || flags.some(flag => flag !== '--json')) { console.error(USAGE.split('\n')[0]); return 2; }
  const report = sanitizePublicJson(await readHostLoadReport(deps)) as HostLoadReport;
  write(`${flags.length ? JSON.stringify(report) : formatHostLoad(report)}\n`);
  return report.state === 'unknown' ? 1 : 0;
}
