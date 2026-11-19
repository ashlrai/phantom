/** `phm plan check <file> [--min-bets N] [--drained a,b] [--json]`: catch a bad leader plan before anything is queued. Logic: core/plan/check. */
import { readFileSync } from 'node:fs';
import { checkPlan, DEFAULT_MIN_BETS, planProblemLine } from '../core/plan/check.js';

export const PLAN_USAGE = `Usage: phm plan check <file> [--min-bets ${DEFAULT_MIN_BETS}] [--drained <lane,...>] [--json]
check reads a plan file of "- READY <id> (P1, pool=<lane>, repo=<repo>, size<=200): task Acceptance: ..." lines and reports
too-few-bets, malformed-ready-line, missing-acceptance, duplicate-id and pool-drained (schema plan.check.v1). Read-only, offline.
Exit 0 plan is ok, 2 problems found or bad usage, 1 file cannot be read.`;

export interface PlanCliDeps { out?: (line: string) => void; err?: (line: string) => void }

export async function cmdPlan(argv: string[], deps: PlanCliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log, err = deps.err ?? console.error;
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') { out(PLAN_USAGE); return 0; }
  const [verb, ...rest] = argv;
  const usage = (): number => { err(PLAN_USAGE); return 2; };
  if (verb !== 'check') return usage();
  let file: string | undefined, json = false, minBets = DEFAULT_MIN_BETS, drained: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--json') json = true;
    else if (a === '--min-bets') {
      const v = rest[++i];
      if (v === undefined || !/^\d+$/.test(v)) return usage();
      minBets = Number(v);
    } else if (a === '--drained') {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) return usage();
      drained = v.split(',');
    } else if (a.startsWith('--') || file !== undefined) return usage();
    else file = a;
  }
  if (!file) return usage();
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { err(`Cannot read the plan file ${JSON.stringify(file)}.`); return 1; }
  const report = checkPlan(text, { minBets, drained });
  out(json ? JSON.stringify(report, null, 2) : report.ok ? `Plan ok: ${report.bets.length} bets.` : report.problems.map(planProblemLine).join('\n'));
  return report.ok ? 0 : 2;
}
