import { sendOwnerPlanReply } from '../core/comms/owner-reply.js';
import type { OwnerThreadOptions } from '../core/comms/owner-thread.js';
import { ownerThreadOptions } from './comms-owner-thread.js';
const usage = 'Usage: phm owner reply [--dry-run] [--json] [--plan-log <path>]';
export async function cmdOwnerReply(args: string[], options?: OwnerThreadOptions, output = console.log): Promise<number> {
  let planLog: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { output(usage); return 0; }
    if (seen.has(arg) || !['--dry-run', '--json', '--plan-log'].includes(arg)) { output(usage); return 2; }
    seen.add(arg);
    if (arg === '--plan-log') { planLog = args[++i]; if (!planLog || planLog.startsWith('-')) { output(usage); return 2; } }
  }
  const report = await sendOwnerPlanReply(options ?? ownerThreadOptions(), { planLog, dryRun: seen.has('--dry-run') });
  output(seen.has('--json') ? JSON.stringify(report) : `${report.reason}${report.text ? `\n${report.text}` : ''}`);
  return report.status === 'blocked' ? 1 : 0;
}
