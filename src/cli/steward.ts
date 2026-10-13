/** `phm steward` — disk/log guardrails for agent CLIs (dry run by default). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { defaultStewardPolicy, runSteward } from '../core/steward/disk.js';
import { stewardSchedule } from '../core/steward/schedule.js';

const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
export async function cmdSteward(argv: string[]): Promise<number> {
  const [sub = 'disk', ...rest] = argv;
  if (sub === 'schedule') {
    // phm steward schedule [--install] [--apply] [--hour n]: print (default) or install a daily per-user job.
    const i = rest.indexOf('--hour'); const hour = i >= 0 ? Number(rest[i + 1]) : undefined;
    const units = stewardSchedule({ phmPath: process.argv[1] ?? 'phm', apply: rest.includes('--apply'), hour });
    if (!rest.includes('--install')) { for (const u of units) console.log(`# ${u.path}\n${u.contents}`); console.log('Re-run with --install to enable (report-only unless --apply).'); return 0; }
    mkdirSync(join(homedir(), '.ashlr', 'logs'), { recursive: true });
    for (const u of units) { mkdirSync(dirname(u.path), { recursive: true }); writeFileSync(u.path, u.contents, { mode: 0o644 }); }
    for (const u of units) if (u.activate.length) { const r = spawnSync(u.activate[0]!, u.activate.slice(1), { stdio: 'inherit' }); if (r.status !== 0) console.error(`Activate manually: ${u.activate.join(' ')}`); }
    console.log(`Steward scheduled daily (${rest.includes('--apply') ? 'apply' : 'report-only'}).`);
    return 0;
  }
  if (sub !== 'disk') { console.error('Usage: phm steward disk [--apply] [--json] | phm steward schedule [--install] [--apply] [--hour n]'); return 2; }
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
