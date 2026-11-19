/**
 * `phm bets list|launch|score|kill [--json]`: the bets lane ledger (RQ-BETS-LANE-1). Logic lives in core/metrics.
 * `phm bets suggest|explain`: read-only next-job suggestions; logic lives in core/fleet/next-bets.
 */
import { checkGoal, goalTerms, helpItems, readApiRoutes, readDocHeadings, readPanes, type BetsCheckReport } from '../core/fleet/bets-check.js';
import { explainBetLines, nextBetsLines, readNextBets, type BetReaders } from '../core/fleet/next-bets.js';
import { BetInputError, type Bet, type BetDirection } from '../core/metrics/bets.js';
import { killBet, launchBet, readBets, scoreCycle } from '../core/metrics/bets-store.js';
import { defaultLoopReaders, type LoopReaders } from '../core/metrics/loop-collect.js';
import { LOOP_METRIC_KEYS } from '../core/metrics/loop.js';

export const BETS_USAGE = `Usage: phm bets <check|suggest|explain|list|launch|score|kill> [--json]
  phm bets check "<goal text>" [--json]
  phm bets suggest [--json] [--limit N]
  phm bets explain <id> [--json]
  phm bets list [--json]
  phm bets launch --id RQ-BET-<slug> --hypothesis <text> --metric <key> --max-lane-hours <n> --max-cycles <n>
                  [--direction up|down] [--baseline <n>] [--min-delta <n>] [--kill <criterion>] [--json]
  phm bets score [--dry-run] [--json]
  phm bets kill <RQ-BET-id> --reason <text> [--json]
check looks the goal up in this checkout's CLI help, API routes, web-ui panes and docs headings and says new, partial or
exists with up to 10 matches and one suggested delta line (schema bets.check.v1). Read-only and offline: run it before queuing work.
Ledger: $ASHLR_RUNS_DIR or ~/.ashlr-runs, file metrics/bets.jsonl (append-only).
Metric keys: ${LOOP_METRIC_KEYS.join(', ')}.
score runs one kill-fast cycle: kept when a bet job merged and the metric moved, killed when over budget without
movement, hold otherwise; each decision is appended with the numbers used, and metrics/bets-share.json is refreshed.
suggest ranks the next jobs worth queuing from lane status, usage pace, launch yield, main health, releases and
the autonomy score; explain shows one suggestion's inputs and score. Both only read: nothing is queued.
Exit 0 ok, 1 read or write failure (or explain id not on the list), 2 bad usage or refused input.`;

export interface BetsCliDeps { root?: string; out?: (line: string) => void; err?: (line: string) => void; readers?: LoopReaders; now?: () => Date; betReaders?: BetReaders }

function flags(args: string[], allowed: readonly string[], booleans: readonly string[] = ['--json']): Map<string, string> | null {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (booleans.includes(a)) { if (out.has(a)) return null; out.set(a, 'true'); continue; }
    if (!allowed.includes(a) || out.has(a)) return null;
    const v = args[++i];
    if (v === undefined || v.startsWith('--')) return null;
    out.set(a, v);
  }
  return out;
}

const num = (v: string | undefined): number | undefined => v === undefined ? undefined : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;

function line(b: Bet): string {
  const measured = b.measured ? ` measured ${b.measured.value ?? 'unknown'} (delta ${b.measured.delta ?? 'unknown'})` : '';
  return `${b.id}  ${b.status}  ${b.metric} ${b.direction} from ${b.baseline ?? 'unknown'}  cycles ${b.cycles}/${b.budget.maxCycles}${measured}${b.reason ? `  ${b.reason}` : ''}`;
}

function checkLines(r: BetsCheckReport): string[] {
  const lines = [`${r.verdict}: ${r.goal}`];
  for (const m of r.matches) lines.push(`  ${m.kind.padEnd(4)} ${m.name}  (${m.path})`);
  if (r.suggestedDelta) lines.push(`suggested delta: ${r.suggestedDelta}`);
  return lines;
}

export async function cmdBets(argv: string[], deps: BetsCliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log, err = deps.err ?? console.error;
  const now = deps.now ?? (() => new Date());
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    (argv.length === 0 ? err : out)(BETS_USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  const readers = deps.readers ?? defaultLoopReaders();
  const runs = readers.runsDir;
  const [verb, ...rest] = argv;
  const usage = () => { err(BETS_USAGE); return 2; };
  try {
    switch (verb) {
      case 'check': {
        const json = rest.includes('--json');
        const goal = rest.filter(a => a !== '--json').join(' ').trim();
        if (!goal || rest.some(a => a.startsWith('--') && a !== '--json')) return usage();
        const { searchHelpEntries } = await import('./help.js');
        const entries = new Map<string, { cmd: string; desc: string }>();
        for (const term of goalTerms(goal).terms) for (const e of searchHelpEntries(term)) entries.set(e.cmd, e);
        const root = deps.root ?? process.cwd();
        const report = checkGoal(goal, { cli: helpItems([...entries.values()]), api: readApiRoutes(root), pane: readPanes(root), doc: readDocHeadings(root) });
        out(json ? JSON.stringify(report, null, 2) : checkLines(report).join('\n'));
        return 0;
      }
      case 'suggest': {
        const f = flags(rest, ['--limit']);
        const limit = f?.has('--limit') ? num(f.get('--limit')) : 10;
        if (!f || !Number.isInteger(limit) || limit! < 1 || limit! > 50) return usage();
        const report = await readNextBets({ readers: deps.betReaders, now: now().getTime(), limit });
        out(f.has('--json') ? JSON.stringify(report, null, 2) : nextBetsLines(report).join('\n'));
        return 0;
      }
      case 'explain': {
        const [id, ...more] = rest;
        const f = id && !id.startsWith('--') ? flags(more, []) : null;
        if (!f) return usage();
        const report = await readNextBets({ readers: deps.betReaders, now: now().getTime() });
        const suggestion = report.suggestions.find(bet => bet.id === id);
        if (!suggestion) { err(`No current suggestion has the id ${JSON.stringify(id)}. Run phm bets suggest for the list.`); return 1; }
        out(f.has('--json') ? JSON.stringify({ schema: 'fleet.next-bet.v1', generatedAt: report.generatedAt, readOnly: true, suggestion, weights: report.weights }, null, 2) : explainBetLines(suggestion).join('\n'));
        return 0;
      }
      case 'list': {
        const f = flags(rest, []);
        if (!f) return usage();
        const { bets, ignored } = await readBets(runs);
        if (f.has('--json')) out(JSON.stringify({ schema: 'bets.list.v1', bets, ignored }, null, 2));
        else out(bets.length ? bets.map(line).join('\n') : 'No bets launched.');
        return 0;
      }
      case 'launch': {
        const f = flags(rest, ['--id', '--hypothesis', '--metric', '--max-lane-hours', '--max-cycles', '--direction', '--baseline', '--min-delta', '--kill']);
        if (!f || !f.get('--id') || !f.get('--hypothesis') || !f.get('--metric') || !f.get('--max-lane-hours') || !f.get('--max-cycles')) return usage();
        const metric = f.get('--metric')!;
        if (!(LOOP_METRIC_KEYS as readonly string[]).includes(metric)) { err(`Unknown metric ${metric}. Use one of: ${LOOP_METRIC_KEYS.join(', ')}`); return 2; }
        const direction = f.get('--direction') ?? 'up';
        if (direction !== 'up' && direction !== 'down') return usage();
        const bet = await launchBet(runs, {
          id: f.get('--id')!, hypothesis: f.get('--hypothesis')!, metric, direction: direction as BetDirection,
          ...(f.has('--baseline') ? { baseline: num(f.get('--baseline')) } : {}),
          ...(f.has('--min-delta') ? { minDelta: num(f.get('--min-delta')) } : {}),
          ...(f.has('--kill') ? { killCriterion: f.get('--kill') } : {}),
          budget: { maxLaneHours: num(f.get('--max-lane-hours'))!, maxCycles: num(f.get('--max-cycles'))! },
        }, now());
        out(f.has('--json') ? JSON.stringify({ schema: 'bets.launch.v1', bet }, null, 2) : `Launched ${line(bet)}`);
        return 0;
      }
      case 'score': {
        const f = flags(rest, [], ['--json', '--dry-run']);
        if (!f) return usage();
        const cycle = await scoreCycle(readers, { dryRun: f.has('--dry-run') });
        if (f.has('--json')) out(JSON.stringify({ schema: 'bets.score.v1', ...cycle }, null, 2));
        else out(cycle.decisions.length ? cycle.decisions.map(d => `${d.id}  ${d.reason}`).join('\n') : 'No launched bets to score.');
        return 0;
      }
      case 'kill': {
        const [id, ...more] = rest;
        const f = id && !id.startsWith('--') ? flags(more, ['--reason']) : null;
        if (!f || !f.get('--reason')) return usage();
        const bet = await killBet(runs, id!, f.get('--reason')!, now());
        out(f.has('--json') ? JSON.stringify({ schema: 'bets.kill.v1', bet }, null, 2) : `Killed ${line(bet)}`);
        return 0;
      }
      default: return usage();
    }
  } catch (error) {
    if (error instanceof BetInputError) { err(error.message); return 2; }
    err(`bets: ${error instanceof Error ? error.message : 'failed'}`);
    return 1;
  }
}
