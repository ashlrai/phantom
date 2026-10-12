/** `phm steward` — disk/log guardrails for agent CLIs (dry run by default). */
import { defaultStewardPolicy, runSteward } from '../core/steward/disk.js';

const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
export async function cmdSteward(argv: string[]): Promise<number> {
  const [sub = 'disk', ...rest] = argv;
  if (sub !== 'disk') { console.error('Usage: phm steward disk [--apply] [--json]'); return 2; }
  const report = runSteward(defaultStewardPolicy(), { apply: rest.includes('--apply') });
  if (rest.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return 0; }
  for (const r of report.roots) {
    if (!r.exists) continue;
    console.log(`${r.overQuota ? '!' : ' '} ${r.id.padEnd(16)} ${mb(r.bytes).padStart(10)} / ${mb(r.quotaBytes)}  reclaimable ${mb(r.reclaimable.bytes)} (${r.reclaimable.files} files)`);
  }
  console.log(report.applied ? `Deleted ${report.deleted.files} files, freed ${mb(report.deleted.bytes)}.` : `Dry run: ${mb(report.reclaimableBytes)} reclaimable. Re-run with --apply to delete.`);
  return 0;
}
