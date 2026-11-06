/** `phm select`: rank candidates, fund the top few as READY lines, record the picks. Logic lives in core/routing/selector. */
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { appendBusInbox, type BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { learnOutcomes } from '../core/routing/outcome-learning.js';
import {
  DEFAULT_FUND_COUNT, fundedIds, parseCandidates, pickRecords, rankCandidates, readyLine, type SelectorResult,
} from '../core/routing/selector.js';
import { selectorSchedule } from '../core/routing/selector-schedule.js';

const usage = `Usage: phm select [--json] [--dry-run] [--top <n>] [--candidates <file>] [--events <file>] [--runs-dir <abs>]
       phm select schedule [--write] [--phm-path <abs>]

Scores each candidate value x leverage / (minutes + usage), takes the top n (default ${DEFAULT_FUND_COUNT}),
prints them as READY lines, appends them with their predicted value to <runs-dir>/selector/picks.jsonl and
posts a summary to the local bus inbox. A candidate already in picks.jsonl is not funded twice.
--dry-run   Rank and print only; write and post nothing.
--candidates <file>  JSONL, one candidate per line: id (RQ-*), scope, repo, value, and optional acceptance,
             jobType, pool, tier, priority, leverage, estMinutes, estUsage.
             Default: <runs-dir>/selector/candidates.jsonl
--events <file>      Dispatch event log the minutes, usage and merge rate are learned from.
             Default: <runs-dir>/queue/dispatch-events.log
--runs-dir   Default: $ASHLR_RUNS_DIR or ~/.ashlr-runs
schedule     Preview the hourly launchd agent (macOS); --write installs the plist without loading it.`;

const MAX_BYTES = 8 * 1024 * 1024;

export interface SelectDeps {
  now?: () => Date;
  bus?: BusInboxOptions;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

async function readCapped(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size <= MAX_BYTES ? await readFile(path, 'utf8') : null;
  } catch { return null; }
}

interface Parsed { json: boolean; dryRun: boolean; top: number; candidates?: string; events?: string; runsDir?: string }

function parse(args: string[]): Parsed | null {
  const p: Parsed = { json: false, dryRun: false, top: DEFAULT_FUND_COUNT };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return null;
    seen.add(arg);
    if (arg === '--json') p.json = true;
    else if (arg === '--dry-run') p.dryRun = true;
    else if (arg === '--top' || arg === '--candidates' || arg === '--events' || arg === '--runs-dir') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) return null;
      if (arg === '--top') {
        if (!/^\d{1,3}$/.test(value)) return null;
        p.top = Number(value);
      } else if (arg === '--runs-dir') {
        if (!isAbsolute(value)) return null;
        p.runsDir = value;
      } else p[arg === '--candidates' ? 'candidates' : 'events'] = value;
    } else return null;
  }
  return p;
}

async function cmdSchedule(args: string[], io: Required<Pick<SelectDeps, 'out' | 'err'>>): Promise<number> {
  let write = false;
  let phmPath = process.argv[1] ?? '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--write' && !write) write = true;
    else if (args[i] === '--phm-path' && args[i + 1] !== undefined) phmPath = args[++i]!;
    else { io.err(usage); return 2; }
  }
  try {
    for (const unit of selectorSchedule({ phmPath })) {
      if (write) {
        await mkdir(dirname(unit.path), { recursive: true });
        await writeFile(unit.path, unit.contents, { mode: 0o644 });
        io.out(`wrote ${unit.path}\nload with: ${unit.activate.join(' ')}`);
      } else io.out(`${unit.path}\n${unit.contents}`);
    }
    return 0;
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

export async function cmdSelect(args: string[], deps: SelectDeps = {}): Promise<number> {
  const io = { out: deps.out ?? ((t: string) => console.log(t)), err: deps.err ?? ((t: string) => console.error(t)) };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { io.out(usage); return 0; }
  if (args[0] === 'schedule') return cmdSchedule(args.slice(1), io);
  const parsed = parse(args);
  if (!parsed) { io.err(usage); return 2; }

  const root = parsed.runsDir ?? (process.env['ASHLR_RUNS_DIR'] || join(homedir(), '.ashlr-runs'));
  const dir = join(root, 'selector');
  const picksPath = join(dir, 'picks.jsonl');
  const candidateText = await readCapped(parsed.candidates ?? join(dir, 'candidates.jsonl'));
  if (candidateText === null) { io.err('error: candidate file unavailable'); return 1; }
  // A missing log is a cold start, not a failure: defaults apply and every merge rate is the prior.
  const events = await readCapped(parsed.events ?? join(root, 'queue', 'dispatch-events.log')) ?? '';

  const { candidates, rejected } = parseCandidates(candidateText);
  const result: SelectorResult = rankCandidates(candidates, learnOutcomes(events), {
    count: parsed.top, rejected, exclude: fundedIds(await readCapped(picksPath) ?? ''),
  });
  const now = (deps.now ?? (() => new Date()))();
  let bus = 'skipped';
  if (!parsed.dryRun && result.picks.length > 0) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(picksPath, pickRecords(result, now).map((r) => `${JSON.stringify(r)}\n`).join(''), { mode: 0o600 });
    const post = appendBusInbox({
      id: `selector-${now.getTime()}`, from: 'selector', to: 'planner', priority: 'P2', ttl: 3_600_000,
      body: { kind: 'selector.picks', picks: result.picks.map((p) => ({ id: p.id, score: p.score, predictedValue: p.predictedValue })) },
    }, deps.bus);
    bus = post.status;
  }
  if (parsed.json) io.out(JSON.stringify({ ...result, dryRun: parsed.dryRun, bus, picks: result.picks.map((p) => ({ ...p, ready: readyLine(p) })) }));
  else {
    io.out(result.picks.length === 0 ? 'no candidates to fund' : result.picks.map(readyLine).join('\n'));
    io.err(`${result.picks.length} funded of ${result.considered} (${result.skipped} already funded, ${result.rejected} rejected)${parsed.dryRun ? ' [dry run]' : ''}`);
  }
  return 0;
}
