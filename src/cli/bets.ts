/**
 * `phm bets list|launch|score|kill [--json]`: the bets lane ledger (RQ-BETS-LANE-1). Logic lives in core/metrics.
 * `phm bets suggest|explain`: read-only next-job suggestions; logic lives in core/fleet/next-bets.
 */
import { readFileSync } from 'node:fs';
import { checkGoal, GATE_EXIT, goalFromPrompt, goalTerms, helpItems, readApiRoutes, readDocHeadings, readPanes, type BetsCheckReport } from '../core/fleet/bets-check.js';
import { DEFAULT_PROPOSE_COUNT, gatherCandidates, MAX_PROPOSE_COUNT, proposeBets, proposeLines, readRepoName } from '../core/fleet/bets-propose.js';
import { explainBetLines, nextBetsLines, readNextBets, type BetReaders } from '../core/fleet/next-bets.js';
import { leaderBetsLines, LEADER_BETS_DEFAULT_HOURS, LEADER_BETS_MAX_HOURS, parseStaleAfter, readLeaderBets, type LeaderBetsReport } from '../core/fleet/leader-batches.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { BetInputError, type Bet, type BetDirection } from '../core/metrics/bets.js';
import { killBet, launchBet, readBets, scoreCycle } from '../core/metrics/bets-store.js';
import { defaultLoopReaders, type LoopReaders } from '../core/metrics/loop-collect.js';
import { LOOP_METRIC_KEYS } from '../core/metrics/loop.js';

export const BETS_USAGE = `Usage: phm bets [--since 24h] [--stale-after 3h] [--json]
       phm bets <check|propose|suggest|explain|list|launch|score|kill> [--json]
  phm bets check "<goal text>" [--json]
  phm bets check --from-prompt <file> [--gate] [--json]
  phm bets propose [--lane <lane>] [--count <n>] [--json]
  phm bets suggest [--json] [--limit N]
  phm bets explain <id> [--json]
  phm bets list [--json]
  phm bets launch --id RQ-BET-<slug> --hypothesis <text> --metric <key> --max-lane-hours <n> --max-cycles <n>
                  [--direction up|down] [--baseline <n>] [--min-delta <n>] [--kill <criterion>] [--json]
  phm bets score [--dry-run] [--json]
  phm bets kill <RQ-BET-id> --reason <text> [--json]
With no verb, phm bets shows what the leader decided: its jobs grouped by batch (ids ending in the same N<day><letter>Q8 suffix, src=leader),
each bet as queued, running, PR open, merged or empty (with the reason when known), and the batch hit rate: merged / (merged + empty).
Nothing judged yet reads "unknown", not 0%. A launched job with no finish row shows "ended, no result" when queue/run/<id>.rc holds an exit code, or when it ran longer than --stale-after (default 3h) with no live process; the line says which rule fired. Jobs are the leader's by the src=leader tag; the id suffix only decides when no tag is given. --since takes 1h to 365d (default 24h). JSON is fleet.leader-bets.v1. Read-only.
check looks the goal up in this checkout's CLI help, API routes, web-ui panes and docs headings and says new, partial or
exists with up to 10 matches and one suggested delta line (schema bets.check.v1). Read-only and offline: run it before queuing work.
--from-prompt reads a queue prompt file: the goal is the task after the closing parenthesis on the line after "verbatim:", up to "Acceptance:".
--gate turns the verdict into the exit code: 0 new (go), 2 partial (build only the gap), 3 exists (stop, finish with a note), 1 error; with --json the code also shows as "exitCode".
propose lets a lane ask for its own next work: it gathers candidates from this checkout's backlog (TODO/FIXME comments,
open roadmap items, skipped tests, commands no docs page names), runs each through check, drops what already exists and ranks
the rest: user-facing first, smallest size next. Each row has an id, repo, size, goal and an Acceptance line (schema bets.propose.v1;
defaults --lane claude --count ${DEFAULT_PROPOSE_COUNT}, at most ${MAX_PROPOSE_COUNT}). Read-only: it never writes a queue file.
Ledger: $ASHLR_RUNS_DIR or ~/.ashlr-runs, file metrics/bets.jsonl (append-only).
Metric keys: ${LOOP_METRIC_KEYS.join(', ')}.
score runs one kill-fast cycle: kept when a bet job merged and the metric moved, killed when over budget without
movement, hold otherwise; each decision is appended with the numbers used, and metrics/bets-share.json is refreshed.
suggest ranks the next jobs worth queuing from lane status, usage pace, launch yield, main health, releases and
the autonomy score; explain shows one suggestion's inputs and score. Both only read: nothing is queued.
Exit 0 ok, 1 read or write failure (or explain id not on the list), 2 bad usage or refused input.`;

export interface BetsCliDeps { root?: string; out?: (line: string) => void; err?: (line: string) => void; readers?: LoopReaders; now?: () => Date; betReaders?: BetReaders; leaderBets?: (opts: { hours: number; now: number; staleAfterHours?: number }) => Promise<LeaderBetsReport> }

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

/** `phm bets [--since 24h] [--json]`: the leader's batches, each bet's stage and the hit rate. */
async function leaderBatchView(args: string[], deps: BetsCliDeps, out: (line: string) => void, err: (line: string) => void, now: () => Date): Promise<number> {
  const f = flags(args, ['--since', '--stale-after']);
  const since = f?.get('--since') ?? `${LEADER_BETS_DEFAULT_HOURS}h`;
  const m = /^(\d+(?:\.\d+)?)([hd])$/.exec(since);
  const hours = m ? Number(m[1]) * (m[2] === 'd' ? 24 : 1) : NaN;
  const staleText = f?.get('--stale-after');
  const staleAfterHours = staleText === undefined ? undefined : parseStaleAfter(staleText);
  if (!f || staleAfterHours === null || !(hours > 0 && hours <= LEADER_BETS_MAX_HOURS)) { err(BETS_USAGE); return 2; }
  try {
    const report = await (deps.leaderBets ?? (o => readLeaderBets(o)))({ hours, now: now().getTime(), staleAfterHours });
    out(f.has('--json') ? JSON.stringify(sanitizePublicJson(report)) : leaderBetsLines(report).join('\n'));
    return 0;
  } catch { err('Unable to read the leader queue or jobs ledger.'); return 1; }
}

export async function cmdBets(argv: string[], deps: BetsCliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log, err = deps.err ?? console.error;
  const now = deps.now ?? (() => new Date());
  const wantsHelp = argv.includes('--help') || argv.includes('-h') || argv[0] === 'help';
  if (!wantsHelp && (argv.length === 0 || argv[0]!.startsWith('--'))) return leaderBatchView(argv, deps, out, err, now);
  if (wantsHelp) { out(BETS_USAGE); return 0; }
  const readers = deps.readers ?? defaultLoopReaders();
  const runs = readers.runsDir;
  const [verb, ...rest] = argv;
  const usage = () => { err(BETS_USAGE); return 2; };
  try {
    switch (verb) {
      case 'check': {
        const gate = rest.includes('--gate'), json = rest.includes('--json');
        const fail = (msg: string): number => { err(msg); return gate ? 1 : 2; };
        const fromAt = rest.indexOf('--from-prompt');
        let goal: string | null;
        if (fromAt >= 0) {
          const file = rest[fromAt + 1];
          if (!file || file.startsWith('--') || rest.some((a, i) => i !== fromAt && i !== fromAt + 1 && a !== '--gate' && a !== '--json')) return fail(BETS_USAGE);
          let text: string;
          try { text = readFileSync(file, 'utf8'); } catch { return fail(`Cannot read the prompt file ${JSON.stringify(file)}.`); }
          goal = goalFromPrompt(text);
          if (!goal) return fail('No task found: the prompt needs a line after "verbatim:" like "<id> (<tags>): <task>".');
        } else {
          goal = rest.filter(a => a !== '--json' && a !== '--gate').join(' ').trim();
          if (!goal || rest.some(a => a.startsWith('--') && a !== '--json' && a !== '--gate')) return fail(BETS_USAGE);
        }
        const { searchHelpEntries } = await import('./help.js');
        const entries = new Map<string, { cmd: string; desc: string }>();
        for (const term of goalTerms(goal).terms) for (const e of searchHelpEntries(term)) entries.set(e.cmd, e);
        const root = deps.root ?? process.cwd();
        const report = checkGoal(goal, { cli: helpItems([...entries.values()]), api: readApiRoutes(root), pane: readPanes(root), doc: readDocHeadings(root) });
        const exitCode = GATE_EXIT[report.verdict];
        out(json ? JSON.stringify(gate ? { ...report, exitCode } : report, null, 2) : checkLines(report).join('\n'));
        return gate ? exitCode : 0;
      }
      case 'propose': {
        const f = flags(rest, ['--lane', '--count']);
        const count = f?.has('--count') ? num(f.get('--count')) : DEFAULT_PROPOSE_COUNT;
        const lane = f?.get('--lane') ?? 'claude';
        if (!f || !Number.isInteger(count) || count! < 1 || count! > MAX_PROPOSE_COUNT || !/^[a-z][a-z0-9-]{0,30}$/.test(lane)) return usage();
        const { HELP_ENTRIES } = await import('./help.js');
        const root = deps.root ?? process.cwd();
        const entries = HELP_ENTRIES.map(e => ({ cmd: e.cmd, desc: e.desc }));
        const report = proposeBets(gatherCandidates(root, entries), { cli: helpItems(entries), api: readApiRoutes(root), pane: readPanes(root), doc: readDocHeadings(root) }, { lane, repo: readRepoName(root), count: count! });
        out(f.has('--json') ? JSON.stringify(report, null, 2) : proposeLines(report).join('\n'));
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
