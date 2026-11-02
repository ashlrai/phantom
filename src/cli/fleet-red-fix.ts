import { isAbsolute } from 'node:path';
import { runRedPrFix, type RedFixOptions, type RedFixReport } from '../core/fleet/red-pr-fix-job.js';

const usage = 'Usage: ashlr fleet red-fix [--json] [--write] [--hours <1-168>] [--runs-dir <absolute>] [--repo ashlrai/phantom]';
export async function cmdFleetRedFix(args: string[], deps: { run?: (opts: RedFixOptions) => Promise<RedFixReport> } = {}): Promise<number> {
  let json = false, write = false, hours = 24, runsDir: string | undefined, repo = 'ashlrai/phantom';
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { console.error(usage); return 2; }
    seen.add(arg);
    if (arg === '--help' || arg === '-h') { if (args.length !== 1) { console.error(usage); return 2; } console.log(usage); return 0; }
    if (arg === '--json') json = true;
    else if (arg === '--write') write = true;
    else if (arg === '--hours' || arg === '--runs-dir' || arg === '--repo') {
      const value = args[++i];
      if (!value || value.startsWith('-') || value.includes('\0')) { console.error(usage); return 2; }
      if (arg === '--hours') { if (!/^[1-9]\d*$/.test(value)) { console.error(usage); return 2; } hours = Number(value); }
      else if (arg === '--runs-dir') runsDir = value;
      else repo = value;
    } else { console.error(usage); return 2; }
  }
  if (hours > 168 || (runsDir !== undefined && !isAbsolute(runsDir)) || repo.toLowerCase() !== 'ashlrai/phantom') { console.error(usage); return 2; }
  let report: RedFixReport;
  try { report = await (deps.run ?? runRedPrFix)({ repo, hours, write, runsDir }); }
  catch { console.error('fleet red-fix: collection failed'); return 1; }
  if (json) console.log(JSON.stringify(report));
  else {
    for (const c of report.candidates) console.log(`#${c.number} RQ-PHX-${c.fixId}: ${c.written ? 'written' : c.skipped ?? 'dry-run'}`);
    if (report.reason) console.error(`fleet red-fix: ${report.reason}`);
    else if (!report.candidates.length) console.log('no red fleet PRs');
  }
  return report.reason || report.candidates.some(c => c.skipped && c.skipped !== 'already-dropped') ? 1 : 0;
}
