/** `phm doctor supply`: thin handler. The logic lives in core/fleet/supply-doctor.ts. */
import { readSupplyDoctor, supplyDoctorLines, type SupplyDoctorReport } from '../core/fleet/supply-doctor.js';

const usage = 'Usage: phm doctor supply [--json]';
const help = `${usage}
Is self-supply landing jobs? Per source in the host ingest log: last ingest and jobs in 24 h; rejected drops by reason; whether the self-tick gap hook is on; then one verdict line.
Gap jobs show as source "gap" (their ids start RQ-PHX-GAP; the ingest itself records them under "claude").
Missing or unreadable files read as unknown, with the path. Exit 0 report, 2 bad usage. Reads only; never writes.`;

export async function cmdDoctorSupply(args: string[], read: () => Promise<SupplyDoctorReport> = () => readSupplyDoctor()): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(help); return 0; }
  if (args.some(a => a !== '--json')) { console.error(usage); return 2; }
  const report = await read();
  if (args.includes('--json')) console.log(JSON.stringify(report));
  else for (const line of supplyDoctorLines(report)) console.log(line);
  return 0;
}
