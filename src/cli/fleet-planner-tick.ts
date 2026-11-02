/**
 * `ashlr fleet planner-tick` — one shot of the autorun decision
 * (RQ-PHX-PLANNERAUTORUN01). The shell timer that used to fire every planner
 * pass can call this verb instead: it runs decidePlannerAutorun over the
 * live runs dir, appends one observational PLANNER_TICK line to
 * queue/dispatch-events.log either way, and — only with --apply on a RUN
 * decision — fires one pass through runPlannerPass on the declared slate.
 * An agent or a later route can inject the reads via deps; tests inject a
 * fake spawn so nothing real is ever spawned.
 */
import { constants, type Stats } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  decidePlannerAutorun, readPlannerAutorunInput, type PlannerAutorunInput,
} from '../core/fleet/planner-autorun.js';
import { readPlannerCandidates, type PlannerCandidatesRead } from '../core/fleet/planner-candidates.js';
import { readPlannerPromptPath } from '../core/fleet/planner-prompt.js';
import { readPlannerPassOutput, summarizePlannerPassOutput } from '../core/fleet/planner-pass-output.js';
import { runPlannerPass, type SpawnLike } from '../core/fleet/planner-run.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet planner-tick [--json] [--runs-dir <abs>] [--apply] [--min-gap-minutes <n>] [--low-supply <n>]
One shot of the autorun decision: the queued Phantom-job supply fell under
--low-supply (default 24) while some lane still has free slots, and the last
pass is at least --min-gap-minutes (default 25) old. Without --apply this is
a dry-run: it prints the decision (RUN or SKIP) and appends one PLANNER_TICK
line to queue/dispatch-events.log. With --apply a RUN decision fires one
pass through runPlannerPass on the declared slate; a missing slate or an
undeclared prompt prints an honest outcome and still exits 0. An executed pass
exits successfully only when output evidence shows pending or ingested work.
Evidence is observational: concurrent planners may contribute within the run
window. Pending work has not necessarily been ingested or launched.`;

interface Dependencies {
  /** Input read seam; defaults to readPlannerAutorunInput. */
  readInput?: (runsDir: string, now: number) => Promise<PlannerAutorunInput>;
  /** Slate read seam; defaults to readPlannerCandidates. */
  runCandidates?: (runsDir: string) => Promise<PlannerCandidatesRead>;
  /** Spawn seam forwarded to runPlannerPass; tests fake it, never a shell. */
  spawn?: SpawnLike;
  /** Output read seam for unavailable evidence. */
  readOutput?: typeof readPlannerPassOutput;
  now?: number | (() => number);
  output?: (text: string) => void;
  error?: (text: string) => void;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** The dispatch-events.log clock: local wall time, `YYYY-MM-DD HH:MM:SS`. */
const eventClock = (d: Date): string =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const owned = (stat: Stats): boolean => typeof process.getuid !== 'function' || stat.uid === process.getuid();

/** The escaped, home-scrubbed spelling of one value for human output. */
const safe = (value: unknown): string => JSON.stringify(sanitizePublicJson(value))
  .replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * Append one observational row the same guarded way the audit lines are
 * written (O_APPEND|O_NOFOLLOW, regular owned file only). The caller ignores
 * failures — a tick must never crash on an unwritable log.
 */
async function appendTickLine(runsDir: string, line: string): Promise<void> {
  const queueDir = join(runsDir, 'queue');
  await mkdir(queueDir, { recursive: true, mode: 0o700 });
  const handle = await open(join(queueDir, 'dispatch-events.log'),
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw new Error('invalid sink');
    await handle.writeFile(line);
  } finally {
    await handle.close();
  }
}

export async function cmdFleetPlannerTick(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  let json = false, apply = false;
  let runsDir: string | undefined, minGap: number | undefined, lowSupply: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) return invalid();
      runsDir = value;
    } else if (arg === '--min-gap-minutes' && minGap === undefined) {
      const value = Number(args[++i]);
      if (!Number.isFinite(value)) return invalid();
      minGap = value;
    } else if (arg === '--low-supply' && lowSupply === undefined) {
      const value = Number(args[++i]);
      if (!Number.isFinite(value)) return invalid();
      lowSupply = value;
    } else return invalid();
  }
  const now = typeof deps.now === 'function' ? deps.now() : deps.now ?? Date.now();
  const root = runsDir ?? join(homedir(), '.ashlr-runs');
  let input: PlannerAutorunInput;
  try {
    input = await (deps.readInput ?? readPlannerAutorunInput)(root, now);
  } catch (err) {
    error(`fleet planner-tick failed: ${safe(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
  const decision = decidePlannerAutorun({
    ...input,
    ...(minGap === undefined ? {} : { minGapMinutes: minGap }),
    ...(lowSupply === undefined ? {} : { lowSupply }),
  });
  // Every tick is observed, apply or not; a log that will not take the line
  // never changes the verdict.
  await appendTickLine(root,
    `${eventClock(new Date(now))} PLANNER_TICK ${decision.run ? 'run' : 'skip'} reason=${decision.reason} phx=${decision.phxReady} free=${decision.freeSlots}\n`)
    .catch(() => undefined);
  const printDecision = (): void => {
    if (json) output(JSON.stringify(sanitizePublicJson(decision)));
    else output(`${decision.run ? 'RUN' : 'SKIP'} ${decision.reason}: ${decision.detail}`);
  };
  if (!apply || !decision.run) {
    printDecision();
    return 0;
  }
  let slate: PlannerCandidatesRead;
  try {
    slate = await (deps.runCandidates ?? readPlannerCandidates)(root);
  } catch (err) {
    error(`fleet planner-tick failed: ${safe(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
  // Honest about the missing pieces: this Mac may not have declared a slate
  // yet, and a slate that names no absolute promptPath declares no prompt.
  if (slate.source !== 'ok') {
    output(JSON.stringify(sanitizePublicJson({ outcome: 'no-slate', path: slate.path })));
    return 0;
  }
  const promptPath = await readPlannerPromptPath(root);
  if (promptPath === null) {
    output(JSON.stringify(sanitizePublicJson({ outcome: 'no-prompt-declared', path: slate.path })));
    return 0;
  }
  const result = await runPlannerPass({
    runsRoot: root,
    candidates: slate.candidates,
    lastProvider: slate.lastProvider ?? '',
    promptPath,
    spawn: deps.spawn,
    now,
  });
  if (result.outcome !== 'ran') {
    output(JSON.stringify(sanitizePublicJson({ ...result, verdict: 'failed', evidence: { state: 'not-collected' } })));
    return 1;
  }
  const start = Date.parse(result.startedAt), finish = Date.parse(result.finishedAt);
  let evidence: { state: 'productive' | 'unproductive' | 'unknown'; detail: string; window?: { since: string; until: string }; counts?: { ingested: number; pending: number; rejected: number }; sources?: Awaited<ReturnType<typeof readPlannerPassOutput>>['sources'] };
  if (!Number.isFinite(start) || !Number.isFinite(finish) || start > finish) {
    evidence = { state: 'unknown', detail: 'Invalid run bounds; output evidence cannot be observed.' };
  } else {
    const sinceMs = Math.floor(start / 1000) * 1000, untilMs = Math.ceil(finish / 1000) * 1000;
    try {
      const view = await (deps.readOutput ?? readPlannerPassOutput)({ runsRoot: root, sinceMs, untilMs });
      const degraded = view.sources.ledger === 'invalid' || view.sources.drops.some((drop) => drop.state === 'invalid') || view.sources.skipped > 0;
      const missing = view.sources.ledger === 'missing' && view.sources.drops.every((drop) => drop.state === 'missing');
      const state = degraded || missing ? 'unknown' : view.counts.ingested + view.counts.pending > 0 ? 'productive' : 'unproductive';
      evidence = { state, detail: state === 'unknown' ? 'Output evidence is missing or degraded.' : summarizePlannerPassOutput(view), window: view.window, counts: view.counts, sources: view.sources };
    } catch {
      evidence = { state: 'unknown', detail: 'Output evidence read failed.' };
    }
  }
  const verdict = result.exitCode === 0 ? evidence.state : 'failed';
  output(JSON.stringify(sanitizePublicJson({ ...result, verdict, evidence: { ...evidence, attribution: 'observational' } })));
  return verdict === 'productive' ? 0 : 1;
}
