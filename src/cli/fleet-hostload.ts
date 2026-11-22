/** Show the top eight process families by CPU, including each job's children; arguments stay private. */
import { readHostFamilies } from '../core/fleet/host-families.js';

const USAGE = 'Usage: phm fleet hostload [--json]';

export async function cmdFleetHostload(args: string[], ps?: () => Promise<string | null>): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${USAGE}\nTop process families by CPU; children count with their parent. Read-only.`); return 0;
  }
  if (args.length > 1 || args.some(a => a !== '--json')) {
    console.error(USAGE); return 2;
  }
  const report = await readHostFamilies(ps);
  const lines = report.families.map(r => `${r.family}${r.job ? ` ${r.job}` : ''}: ${r.processes} processes, ${r.cpuPercent}% CPU, ${r.rssMb} MB RSS`);
  if (report.unknownCommands.length) lines.push(`Unknown commands: ${report.unknownCommands.map(r => `${r.name} (${r.processes} processes, ${r.cpuPercent}% CPU, ${r.rssMb} MB RSS)`).join('; ')}`);
  console.log(args.includes('--json') ? JSON.stringify(report) : lines.join('\n') || 'Host load: unknown');
  return report.state === 'known' ? 0 : 1;
}
