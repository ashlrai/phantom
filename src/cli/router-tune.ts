import { isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tuneRouterWeights, type RouterTuneReport } from '../core/router/tune.js';

export const ROUTER_TUNE_USAGE =
  'Usage: phm router tune [--root <runs-dir>] [--min-sample <n>] [--max-shift <0<f<=1>] [--apply] [--json]\n' +
  'Folds metrics/jobs.jsonl outcomes (enriched by work-market.v1 route_decision rows) into\n' +
  'per-(work_class, lane) cohorts and proposes bounded router.weights.v1 multipliers vs the\n' +
  'work-class pool merge rate. Advisory only: dry run writes nothing; --apply appends\n' +
  'deduplicated proposal rows to metrics/router-weights.jsonl, which no router consumes.\n' +
  'Cohorts below --min-sample resolved outcomes (default 5) or with an unmeasurable pool are\n' +
  'refused, never guessed. Unknown evidence stays null.';

interface Parsed {
  root?: string;
  minSample?: number;
  maxShift?: number;
  apply: boolean;
  json: boolean;
  help: boolean;
}

function parse(args: string[]): Parsed | null {
  const out: Parsed = { apply: false, json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { out.help = true; return out; }
    else if (arg === '--json' && !out.json) out.json = true;
    else if (arg === '--apply' && !out.apply) out.apply = true;
    else if (arg === '--root' && out.root === undefined && args[i + 1] && !args[i + 1]!.startsWith('--')) out.root = args[++i];
    else if (arg === '--min-sample' && out.minSample === undefined && args[i + 1] && /^\d+$/.test(args[i + 1]!)) out.minSample = Number(args[++i]);
    else if (arg === '--max-shift' && out.maxShift === undefined && args[i + 1] && /^0?\.\d+$|^1(\.0+)?$/.test(args[i + 1]!)) out.maxShift = Number(args[++i]);
    else return null;
  }
  return out;
}

function textReport(report: RouterTuneReport): string {
  const lines = report.weights.map((w) =>
    `${w.work_class ?? 'unclassified'}\t${w.lane}\t${w.weight}\t${w.evidence_n}`);
  const refused = report.cohorts.filter((c) => c.status !== 'proposed').length;
  return (lines.length ? lines.join('\n') : 'No weight proposals.') +
    `\n${report.cohorts.length} cohorts, ${refused} refused, ${report.unattributed_outcomes} unattributed outcomes` +
    (report.applied ? `; applied ${report.applied.appended} rows (${report.applied.deduplicated} deduplicated)` : '');
}

export async function cmdRouterTune(args: string[]): Promise<number> {
  const parsed = parse(args);
  if (!parsed) { console.error(ROUTER_TUNE_USAGE); return 2; }
  if (parsed.help) { console.log(ROUTER_TUNE_USAGE); return 0; }
  if (parsed.root !== undefined && !isAbsolute(parsed.root)) { console.error(ROUTER_TUNE_USAGE); return 2; }
  try {
    const report = await tuneRouterWeights({
      runsDir: parsed.root ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs'),
      minSample: parsed.minSample,
      maxShift: parsed.maxShift,
      apply: parsed.apply,
    });
    console.log(parsed.json ? JSON.stringify(report) : textReport(report));
    return 0;
  } catch (error) {
    if (error instanceof RangeError) { console.error(ROUTER_TUNE_USAGE); return 2; }
    console.error(`router tune unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
