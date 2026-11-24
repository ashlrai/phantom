/** `phm mobile`: thin handler. Parses argv and prints the report built in core/mobile/check.ts. */
import { spawnSync } from 'node:child_process';
import { MOBILE_CHECK_SCHEMA, mobileCheckText, runMobileSweep, type MobileCheckReport } from '../core/mobile/check.js';

const usage = `Usage: phm mobile check [--json]
Renders every registered desktop view 390 px wide in the web UI's test renderer and reports, per view:
content wider than the screen, tap targets under 44 px and text under 12 px. Worst view first.
Read-only. Needs a Phantom source checkout (npm ci); takes about a minute.
  --json   print the report as JSON (schema ${MOBILE_CHECK_SCHEMA}, version 1)
A size that no stylesheet rule states is counted as unknown, never as a pass.
Exit 0 every view passes, 1 a measured view fails, 2 usage, 3 a size is unknown or the views could not be rendered.`;

export interface MobileDeps { out?: (line: string) => void; err?: (line: string) => void; root?: string; run?: (root: string) => Promise<MobileCheckReport> }

function repoRoot(): string {
  const run = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return run.status === 0 && run.stdout.trim() ? run.stdout.trim() : process.cwd();
}

export async function cmdMobile(args: string[], deps: MobileDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  const [verb, ...flags] = args;
  const extra = flags.find(flag => flag !== '--json');
  if (verb !== 'check' || extra !== undefined) { err(`phm mobile: ${verb === 'check' ? `unknown option ${extra}` : 'the only verb is check'}\n${usage}`); return 2; }
  const report = await (deps.run ?? runMobileSweep)(deps.root ?? repoRoot());
  out(flags.includes('--json') ? JSON.stringify(report) : mobileCheckText(report).join('\n'));
  if (report.state === 'unknown' || (report.totals?.unknown ?? 0) > 0) return 3;
  return report.totals?.failing === 0 ? 0 : 1;
}
