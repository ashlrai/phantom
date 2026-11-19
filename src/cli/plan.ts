/** `phm plan check|dup`: catch a bad leader plan, or an already-shipped bet, before anything is queued. Logic: core/plan. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDup, fromBetsItems, readRecentChanges, type DupReport } from '../core/plan/dup.js';
import { goalTerms, helpItems, readDocHeadings } from '../core/fleet/bets-check.js';
import { checkPlan, DEFAULT_MIN_BETS, planProblemLine } from '../core/plan/check.js';

export const PLAN_USAGE = `Usage: phm plan check <file> [--min-bets ${DEFAULT_MIN_BETS}] [--drained <lane,...>] [--no-dup] [--json]
       phm plan dup "<bet text>" [--repo <name>] [--json]
dup asks "has this already shipped?": it matches the bet against CLI verbs, the last 30 days of merged PR titles and commit
subjects, and docs headings, then says new, partly-shipped or shipped with scored matches (schema plan.dup.v1). Keyword overlap
only, no model calls. Sources it cannot read are listed as unknown. Exit 0 new, 2 partly-shipped, 3 shipped, 1 error.
check reads a plan file of "- READY <id> (P1, pool=<lane>, repo=<repo>, size<=200): task Acceptance: ..." lines and reports
too-few-bets, malformed-ready-line, missing-acceptance, duplicate-id, pool-drained and already-shipped (schema plan.check.v1); it also runs dup on every READY line (skip with --no-dup). Read-only, offline.
Exit 0 plan is ok, 2 problems found or bad usage, 1 file cannot be read.`;

export interface PlanCliDeps { out?: (line: string) => void; err?: (line: string) => void; root?: string; dup?: ((bet: string, repo: string) => DupReport) | null }

const DUP_EXIT = { new: 0, 'partly-shipped': 2, shipped: 3 } as const;

/** Whether `name` ("phantom" or "ashlrai/phantom") is the repo this checkout holds. */
function isThisRepo(root: string, name: string): boolean {
  let pkg = ''; try { pkg = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string }).name ?? ''; } catch { /* unknown */ }
  const want = name.split('/').pop()!.toLowerCase();
  return want === pkg.split('/').pop()!.toLowerCase();
}

/** Real-source dup check for the checkout at `root`. */
export async function dupFor(root: string): Promise<(bet: string, repo: string) => DupReport> {
  const { searchHelpEntries } = await import('./help.js');
  const changes = readRecentChanges(root);
  const docs = fromBetsItems(readDocHeadings(root), 'doc');
  return (bet, repo) => {
    if (repo && !isThisRepo(root, repo)) return checkDup(bet, { verbs: [], changes: [], docs: [], unknown: ['verbs', 'changes', 'docs'] }, repo);
    const entries = new Map<string, { cmd: string; desc: string }>();
    for (const term of goalTerms(bet).terms) for (const e of searchHelpEntries(term)) entries.set(e.cmd, e);
    return checkDup(bet, { verbs: fromBetsItems(helpItems([...entries.values()]), 'verb'), changes: changes ?? [], docs, unknown: changes ? [] : ['changes'] }, repo || null);
  };
}

const dupLines = (r: DupReport): string[] => [
  r.verdict === 'new' ? 'new: nothing like it has shipped.' : `${r.verdict}: ${r.matches[0]!.title}`,
  ...r.matches.map(m => `  ${m.score.toFixed(2)} ${m.kind} ${m.ref === m.title ? m.ref : `${m.ref} ${m.title}`} (${m.why})`),
  ...(r.unknown.length ? [`unknown (not checked): ${r.unknown.join(', ')}`] : []),
];

export async function cmdPlan(argv: string[], deps: PlanCliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log, err = deps.err ?? console.error;
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') { out(PLAN_USAGE); return 0; }
  const [verb, ...rest] = argv;
  const usage = (): number => { err(PLAN_USAGE); return 2; };
  if (verb === 'dup') {
    let repo = '', json = false; const words: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === '--json') json = true;
      else if (a === '--repo') { const v = rest[++i]; if (!v || v.startsWith('--')) return usage(); repo = v; }
      else if (a.startsWith('--')) return usage();
      else words.push(a);
    }
    const bet = words.join(' ').trim();
    if (!bet) return usage();
    const report = (deps.dup ?? await dupFor(deps.root ?? process.cwd()))(bet, repo);
    out(json ? JSON.stringify(report, null, 2) : dupLines(report).join('\n'));
    return DUP_EXIT[report.verdict];
  }
  if (verb !== 'check') return usage();
  let noDup = false;
  let file: string | undefined, json = false, minBets = DEFAULT_MIN_BETS, drained: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--json') json = true;
    else if (a === '--no-dup') noDup = true;
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
  const dup = noDup || deps.dup === null ? undefined : (deps.dup ?? await dupFor(deps.root ?? process.cwd()));
  const report = checkPlan(text, { minBets, drained, dup });
  out(json ? JSON.stringify(report, null, 2) : report.ok ? `Plan ok: ${report.bets.length} bets.` : report.problems.map(planProblemLine).join('\n'));
  return report.ok ? 0 : 2;
}
