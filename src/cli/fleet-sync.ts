import { planFleetSync } from '../core/fleet/sync-plan.js';
import { loadDrift, parseDriftArgs } from './fleet-drift.js';

const usage = 'Usage: phm fleet sync --dry-run [--json] [--repo <checkout>] [--bin <runtime directory>]';

/** Print the exact copy plan. Dry run only: this command never writes to the runtime directory. */
export async function cmdFleetSync(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const a = parseDriftArgs(args, ['--dry-run']);
  if (!a) { console.error(usage); return 2; }
  if (!a.flags.includes('--dry-run')) {
    console.error(`fleet sync only plans for now; add --dry-run. Installing stays with the operator (python3 fleet/sync.py --apply).\n${usage}`);
    return 2;
  }
  const report = await loadDrift(a, 'fleet sync');
  if (!report) return 1;
  const plan = await planFleetSync(report);
  if (a.json) { console.log(JSON.stringify(plan)); return 0; }
  console.log(`Plan only, nothing written: ${plan.counts.copy} to copy, ${plan.counts.skip} skipped (backups end .bak-fleet-${plan.backupStamp}).`);
  for (const row of plan.rows) {
    console.log(`  ${row.action.padEnd(4)} ${row.file}: ${row.reason}`);
    row.steps.forEach((s, i) => console.log(`       ${i + 1}. ${s.step}: ${s.detail}`));
  }
  return 0;
}
