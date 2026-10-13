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
    console.log(`${r.overQuota ? '!' : ' '} ${r.id.padEnd(16)} ${mb(r.bytes).padStart(10)} / ${mb(r.quotaBytes)}  ${r.action} ${mb(r.reclaimable.bytes)} (${r.reclaimable.files} files)`);
    if (r.overQuota && r.nativeHint) console.log(`    hint: ${r.nativeHint}`);
  }
  console.log(report.applied ? `Deleted ${report.deleted.files} files (${mb(report.deleted.bytes)}); archived ${report.archived.files} cold sessions (${mb(report.archived.bytes)}) to ~/.ashlr/archive.` : `Dry run: ${mb(report.reclaimableBytes)} reclaimable. Re-run with --apply (logs are deleted; Codex/Claude sessions are gzip-archived, never hand-deleted; active sessions untouched).`);
  return 0;
}
