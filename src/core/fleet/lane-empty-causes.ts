/**
 * core/fleet/lane-empty-causes.ts: why one lane's runs end empty (RQ-CODEXP-EMPTY-1).
 *
 * Pure projection; the CLI (src/cli/fleet-empty-causes.ts) does the bounded reads.
 *
 *   rate     empties / ended over the lane's newest `rateWindow` ended launches in
 *            dispatch-events.log (same LAUNCH-to-terminal pairing as lane-streaks).
 *   jobs     the lane's newest `limit` empty runs, joined from dispatch-events.log
 *            empty terminals and metrics/jobs.jsonl `finish` rows with `empty: true`,
 *            each classified into one cause.
 *
 * Causes, first match wins:
 *   1. an `EMPTY_REASON: <code>` line the agent wrote (the launcher asks for it),
 *   2. timeout: the dispatcher's `<job>.timeout` marker or exit 124/137/143,
 *   3. launch-auth-error: a dispatcher `pool_error`, an anchored provider error line
 *      (auth, usage, rate or credit), or a nonzero exit with no token usage,
 *   4. the shared note/log rules in empty-jobs.ts, mapped onto these causes,
 *   5. prompt-unclear phrasing, else no-diff.
 * The job prompt is echoed into its log, and that echo contains words such as
 * "already done" or "timeout", so log lines that also occur in the prompt are
 * dropped before any rule runs. Rows carry ids, fixed reasons and fixed signal
 * names only: never log, note or prompt text.
 */
import { classifyEmpty, type EmptyClass } from './empty-jobs.js';
import { pairLaunchOutcomes } from './lane-empty-streak.js';

export const EMPTY_CAUSES = ['duplicate-landed', 'prompt-unclear', 'launch-auth-error', 'timeout', 'no-diff'] as const;
export type EmptyCause = typeof EMPTY_CAUSES[number];
export type EmptyFixArea = 'admission-dedupe' | 'prompt-composition' | 'lane-routing';

/** Where each cause is fixed: the dispatcher's three levers. */
export const EMPTY_CAUSE_FIX: Readonly<Record<EmptyCause, EmptyFixArea>> = {
  'duplicate-landed': 'admission-dedupe',
  'prompt-unclear': 'prompt-composition',
  'launch-auth-error': 'lane-routing',
  timeout: 'lane-routing',
  'no-diff': 'prompt-composition',
};

export const EMPTY_CAUSES_DEFAULT_LIMIT = 40;
export const EMPTY_CAUSES_DEFAULT_RATE_WINDOW = 20;
export const EMPTY_CAUSES_MAX = 500;

/** One finish row from metrics/jobs.jsonl, reduced to the fields used here. */
export interface EmptyFinish {
  job: string;
  lane: string;
  ms: number;
  exitCode: number | null;
  poolError: string | null;
  tokensTotal: number | null;
}

/** Per-job files the CLI read; null when absent or unreadable. */
export interface EmptyJobEvidence {
  log: string | null;
  notes: string | null;
  prompt: string | null;
  timedOut: boolean;
}

export interface ClassifiedEmpty {
  job: string;
  at: string;
  cause: EmptyCause;
  reason: string;
  signals: string[];
}

export interface LaneEmptyCausesV1 {
  schema: 'fleet.lane-empty-causes.v1';
  generatedAt: string;
  lane: string;
  sources: { events: 'ok' | 'unavailable'; jobs: 'ok' | 'unavailable' };
  rate: { window: number; ended: number; empties: number; published: number; rate: number | null };
  limit: number;
  total: number;
  counts: Record<EmptyCause, number>;
  causes: Array<{ cause: EmptyCause; fixArea: EmptyFixArea; count: number; share: number; exampleJobs: string[] }>;
  jobs: ClassifiedEmpty[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TIMEOUT_EXITS = new Set([124, 137, 143]);
const REASON_LINE = /^\s*(?:[-*>]\s*)?\**EMPTY_REASON\**:\s*`?(duplicate-landed|prompt-unclear|blocked|no-change-needed)\b/im;
const REASON_CODES: Readonly<Record<string, readonly [EmptyCause, string]>> = {
  'duplicate-landed': ['duplicate-landed', 'Agent reported the work already landed.'],
  'no-change-needed': ['duplicate-landed', 'Agent reported no change was needed.'],
  'prompt-unclear': ['prompt-unclear', 'Agent reported the prompt was unclear.'],
  blocked: ['launch-auth-error', 'Agent reported a tool, auth or environment block.'],
};
// Anchored provider lines, after dispatchd's AB_RX/AB_AUTH_RX: a codex `ERROR:` line,
// a Claude `API Error:` line or a devin `Error:` line that names auth, usage or rate.
const PROVIDER_ERROR = new RegExp(
  String.raw`^(?:\[[0-9T:.\-]+Z?\]\s*)?(?:ERROR|Error|API Error):.{0,200}?`
  + String.raw`(?:401\b|403\b|429\b|unauthori[sz]ed|authentication|invalid_grant|refresh token|re-?authenticate|`
  + String.raw`session expired|token (?:has )?expired|not logged in|log ?in again|invalid (?:x-)?api[-_ ]?key|`
  + String.raw`usage limit|rate[_ ]limit|credits?|quota|at capacity|overloaded)`,
  'im');
const LAUNCH_ERROR = /^(?:.*:\s)?(?:command not found|no such file or directory|exec format error|spawn \S+ ENOENT)\s*$/im;
const UNCLEAR = /\b(?:ambiguous|unclear|underspecified|under-specified|not enough (?:detail|context|information)|could not (?:find|locate|identify) (?:the )?(?:target|file|function|code|task))\b/i;
const FROM_SHARED: Readonly<Record<Exclude<EmptyClass, 'other'>, EmptyCause>> = {
  duplicate: 'duplicate-landed',
  'already-done': 'duplicate-landed',
  'too-broad': 'prompt-unclear',
  'missing-input': 'prompt-unclear',
  'scope-too-cautious': 'prompt-unclear',
  'tests-timeout': 'timeout',
  'blocked-by-env': 'launch-auth-error',
};

/** Drop log lines the prompt also contains: the echoed prompt is not evidence. */
export function withoutPromptEcho(log: string | null, prompt: string | null): string | null {
  if (!log || !prompt) return log;
  const echoed = new Set(prompt.split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 8));
  return log.split(/\r?\n/).filter(line => !echoed.has(line.trim())).join('\n');
}

/** The pool= attr of the `<job> (attrs):` task line, when present. */
export function promptPool(job: string, prompt: string | null): string | null {
  const line = prompt?.split(/\r?\n/).find(text => text.startsWith(`${job} (`));
  const end = line?.indexOf('):') ?? -1;
  const attrs = line && end > 0 ? line.slice(job.length + 2, end) : '';
  return /(?:^|[,\s])pool=([a-z][a-z0-9-]*)/.exec(attrs)?.[1] ?? null;
}

export function classifyEmptyCause(job: string, lane: string, finish: EmptyFinish | null, evidence: EmptyJobEvidence): Pick<ClassifiedEmpty, 'cause' | 'reason' | 'signals'> {
  const signals: string[] = [];
  const pool = promptPool(job, evidence.prompt);
  if (pool && pool !== 'any' && pool !== lane) signals.push(`rerouted-from-${pool}`);
  if (finish?.exitCode !== null && finish?.exitCode !== undefined) signals.push(`exit-${finish.exitCode}`);
  if (finish?.poolError) signals.push(`pool-error-${finish.poolError.replace(/[^a-z0-9_]/gi, '').slice(0, 40)}`);
  const log = withoutPromptEcho(evidence.log, evidence.prompt);
  const done = (cause: EmptyCause, reason: string, signal: string) => ({ cause, reason, signals: [...signals, signal] });

  for (const [source, text] of [['notes', evidence.notes], ['log', log]] as const) {
    const code = text ? REASON_LINE.exec(text)?.[1] : undefined;
    if (code) return done(REASON_CODES[code]![0], REASON_CODES[code]![1], `empty-reason-${source}`);
  }
  if (evidence.timedOut) return done('timeout', 'The dispatcher timed the run out.', 'timeout-marker');
  if (finish?.exitCode !== null && finish?.exitCode !== undefined && TIMEOUT_EXITS.has(finish.exitCode)) {
    return done('timeout', 'The run was killed or timed out.', 'timeout-exit');
  }
  if (finish?.poolError) return done('launch-auth-error', 'The provider reported a usage, rate or capacity error.', 'pool-error');
  if (log && PROVIDER_ERROR.test(log)) return done('launch-auth-error', 'A provider auth, usage or rate error line was logged.', 'provider-error-line');
  if (log && LAUNCH_ERROR.test(log)) return done('launch-auth-error', 'The agent command could not start.', 'launch-error-line');
  if (finish && finish.exitCode !== null && finish.exitCode !== 0 && finish.tokensTotal === null) {
    return done('launch-auth-error', 'The run exited nonzero without using tokens.', 'nonzero-no-tokens');
  }
  const shared = classifyEmpty(evidence.notes, log);
  if (shared.class !== 'other') return done(FROM_SHARED[shared.class], shared.reason, `shared-${shared.class}`);
  for (const [source, text] of [['notes', evidence.notes], ['log', log]] as const) {
    if (text && UNCLEAR.test(text)) return done('prompt-unclear', 'The agent could not pin down the task.', `unclear-${source}`);
  }
  return done('no-diff', evidence.notes || log ? 'The run ended with no diff and no stated reason.' : 'Notes and log were unavailable.', 'residual');
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** Pure: the lane's jobs whose newest finish row says `empty: true`. */
export function emptyFinishes(jobsText: string, lane: string): Map<string, EmptyFinish> {
  const newest = new Map<string, EmptyFinish & { empty: boolean }>();
  for (const line of jobsText.split('\n')) {
    if (!line.includes('"finish"')) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const f = row as Record<string, unknown>;
    if (f.event !== 'finish' || f.lane !== lane || typeof f.job !== 'string' || !SAFE_ID.test(f.job)) continue;
    const ms = typeof f.ts === 'string' ? Date.parse(f.ts.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN;
    if (!Number.isFinite(ms) || (newest.get(f.job)?.ms ?? -Infinity) > ms) continue;
    newest.set(f.job, {
      job: f.job, lane, ms, empty: f.empty === true,
      exitCode: int(f.exit_code),
      poolError: typeof f.pool_error === 'string' && f.pool_error ? f.pool_error : null,
      tokensTotal: int(f.tokens_total),
    });
  }
  const out = new Map<string, EmptyFinish>();
  for (const { empty, ...finish } of newest.values()) if (empty) out.set(finish.job, finish);
  return out;
}

export interface LaneEmptyCandidate { job: string; ms: number; finish: EmptyFinish | null }

/** Pure: the lane's newest `limit` empty runs from both sources, newest first, one per job. */
export function laneEmptyCandidates(eventsText: string | null, jobsText: string | null, lane: string, limit: number): LaneEmptyCandidate[] {
  const finishes = jobsText === null ? new Map<string, EmptyFinish>() : emptyFinishes(jobsText, lane);
  const newest = new Map<string, LaneEmptyCandidate>();
  const add = (job: string, ms: number) => {
    if (!SAFE_ID.test(job)) return;
    const prior = newest.get(job);
    if (!prior || prior.ms < ms) newest.set(job, { job, ms, finish: finishes.get(job) ?? null });
  };
  if (eventsText !== null) {
    for (const launch of pairLaunchOutcomes(eventsText, -Infinity, Infinity).launches) {
      if (launch.lane === lane && launch.empty === true && launch.endMs !== undefined) add(launch.job, launch.endMs);
    }
  }
  for (const finish of finishes.values()) add(finish.job, finish.ms);
  return [...newest.values()].sort((a, b) => b.ms - a.ms || a.job.localeCompare(b.job)).slice(0, limit);
}

/** Pure: empties / ended over the lane's newest `window` ended launches. */
export function laneEmptyRate(eventsText: string | null, lane: string, window: number): LaneEmptyCausesV1['rate'] {
  const ended = eventsText === null ? [] : pairLaunchOutcomes(eventsText, -Infinity, Infinity).launches
    .filter(launch => launch.lane === lane && launch.endMs !== undefined)
    .sort((a, b) => b.endMs! - a.endMs!)
    .slice(0, window);
  const empties = ended.filter(launch => launch.empty).length;
  return {
    window, ended: ended.length, empties, published: ended.length - empties,
    rate: ended.length ? Math.round((empties / ended.length) * 1000) / 1000 : null,
  };
}

export function buildLaneEmptyCauses(input: {
  lane: string;
  nowMs: number;
  limit: number;
  rateWindow: number;
  eventsText: string | null;
  jobsText: string | null;
  candidates: LaneEmptyCandidate[];
  evidence: ReadonlyMap<string, EmptyJobEvidence>;
}): LaneEmptyCausesV1 {
  const none: EmptyJobEvidence = { log: null, notes: null, prompt: null, timedOut: false };
  const jobs: ClassifiedEmpty[] = input.candidates.map(candidate => ({
    job: candidate.job,
    at: new Date(candidate.ms).toISOString(),
    ...classifyEmptyCause(candidate.job, input.lane, candidate.finish, input.evidence.get(candidate.job) ?? none),
  }));
  const counts = Object.fromEntries(EMPTY_CAUSES.map(cause => [cause, 0])) as Record<EmptyCause, number>;
  for (const job of jobs) counts[job.cause]++;
  const causes = EMPTY_CAUSES.filter(cause => counts[cause] > 0)
    .map(cause => ({
      cause,
      fixArea: EMPTY_CAUSE_FIX[cause],
      count: counts[cause],
      share: Math.round((counts[cause] / jobs.length) * 1000) / 1000,
      exampleJobs: jobs.filter(job => job.cause === cause).slice(0, 3).map(job => job.job),
    }))
    .sort((a, b) => b.count - a.count || EMPTY_CAUSES.indexOf(a.cause) - EMPTY_CAUSES.indexOf(b.cause));
  return {
    schema: 'fleet.lane-empty-causes.v1',
    generatedAt: new Date(input.nowMs).toISOString(),
    lane: input.lane,
    sources: { events: input.eventsText === null ? 'unavailable' : 'ok', jobs: input.jobsText === null ? 'unavailable' : 'ok' },
    rate: laneEmptyRate(input.eventsText, input.lane, input.rateWindow),
    limit: input.limit,
    total: jobs.length,
    counts,
    causes,
    jobs,
  };
}
