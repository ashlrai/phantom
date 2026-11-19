/**
 * Runs queue autofill in-process: the one-lane fill behind `phm queue autofill`, the hourly-capped tick that
 * self-tick runs for every starved lane, the run events, and the status read.
 *
 * Every run that did or refused something is one line in queue/dispatch-events.log (the existing event stream):
 * `<clock> AUTOFILL {"schema":"queue.autofill.event.v1",...} src=autofill`. The hourly cap is counted from those
 * lines, so there is no second state file. The kill switch is the live config key `autofill.off` (1 = off), set
 * with `phm fleet config set autofill.off 1 --reason "..."`.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { appendGuarded, eventClock } from '../queue/supersede.js';
import { QueueStore } from '../queue/store.js';
import { createConfigReader } from './dynconfig.js';
import { planAutofill, type QueueAutofillReport } from './queue-autofill.js';

export const AUTOFILL_EVENT_SCHEMA = 'queue.autofill.event.v1' as const;
export const AUTOFILL_STATUS_SCHEMA = 'queue.autofill.status.v1' as const;
export const AUTOFILL_TICK_SCHEMA = 'queue.autofill.tick.v1' as const;
/** At most this many bets applied per lane, and across all lanes, in any rolling hour. */
export const AUTOFILL_LANE_CAP = 4;
export const AUTOFILL_TOTAL_CAP = 12;
export const AUTOFILL_OFF_KEY = 'autofill.off';
export const LANE_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const HOUR_MS = 3_600_000;
const LAST_RUNS = 10;
const TAIL_BYTES = 1024 * 1024;

export interface LaneCounts { running: number | null; target: number | null; queued: number | null }

export interface AutofillEvent {
  schema: typeof AUTOFILL_EVENT_SCHEMA;
  ts: string;
  lane: string;
  drafted: number;
  applied: number;
  skipped: number;
  reason: string;
}

export interface RunAutofillOptions {
  lane: string;
  counts: LaneCounts;
  /** Wanted ready jobs; defaults to the lane's slot target. */
  min?: number;
  apply?: boolean;
  /** Drafts beyond this many are dropped with the reason "hourly cap". */
  limit?: number;
  /** Checkout the bets are read from. */
  root: string;
  /** Queue directory for the store; the store default when unset. */
  dir?: string;
  /** Command list the bets check compares against (the CLI help entries). */
  entries: readonly { cmd: string; desc: string }[];
}

/** Draft (and with `apply`, queue) the bets that fill one lane. Throws only on a real read or write failure. */
export async function runQueueAutofill(o: RunAutofillOptions): Promise<QueueAutofillReport | { error: 'no-target' }> {
  const want = o.min ?? o.counts.target;
  if (want === null || want === undefined) return { error: 'no-target' };
  const store = new QueueStore(o.dir);
  const existing = (await store.read().catch(() => ({ jobs: [] }))).jobs;
  const { gatherCandidates, MAX_PROPOSE_COUNT, proposeBets, readRepoName } = await import('./bets-propose.js');
  const { helpItems, readApiRoutes, readDocHeadings, readPanes } = await import('./bets-check.js');
  const entries = o.entries.map(e => ({ cmd: e.cmd, desc: e.desc }));
  // Ask for the most proposals; the plan takes only the gap after dropping duplicates.
  const proposed = o.counts.queued !== null && want > o.counts.queued
    ? proposeBets(gatherCandidates(o.root, entries), { cli: helpItems(entries), api: readApiRoutes(o.root), pane: readPanes(o.root), doc: readDocHeadings(o.root) }, { lane: o.lane, repo: readRepoName(o.root), count: MAX_PROPOSE_COUNT })
    : { proposals: [], droppedGoals: [] };
  let report = planAutofill({ lane: o.lane, min: want, ...o.counts, existing, proposed });
  if (o.limit !== undefined && report.drafted.length > o.limit) {
    const over = report.drafted.slice(o.limit);
    report = {
      ...report,
      drafted: report.drafted.slice(0, o.limit),
      skipped: [...report.skipped, ...over.map(d => ({ goal: d.goal.slice(0, 100), reason: 'hourly cap' }))],
    };
  }
  if (o.apply && report.drafted.length) {
    for (const d of report.drafted) {
      await store.add({ id: d.id, status: 'READY', priority: 'P1', pool: o.lane, tier: d.tier, repo: d.repo, scope: d.goal, acceptance: d.acceptance, deps: [], claims: [] });
    }
    report = { ...report, applied: true };
  }
  return report;
}

const eventsPath = (runsDir: string): string => join(runsDir, 'queue', 'dispatch-events.log');

/** The newest events, oldest first. Reads only the tail of the log; a missing or unreadable log is an empty list. */
export function readAutofillEvents(runsDir: string): AutofillEvent[] {
  let text = '';
  let fd: number | null = null;
  try {
    fd = openSync(eventsPath(runsDir), constants.O_RDONLY | constants.O_NOFOLLOW);
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    text = buf.toString('utf8');
  } catch { return []; } finally { if (fd !== null) closeSync(fd); }
  const events: AutofillEvent[] = [];
  for (const line of text.split('\n')) {
    const at = line.indexOf(' AUTOFILL {');
    if (at < 0) continue;
    const json = line.slice(at + ' AUTOFILL '.length).replace(/ src=autofill$/, '');
    try {
      const e = JSON.parse(json) as Partial<AutofillEvent>;
      if (e.schema === AUTOFILL_EVENT_SCHEMA && typeof e.ts === 'string' && Number.isFinite(Date.parse(e.ts)) && typeof e.lane === 'string' && LANE_NAME.test(e.lane)
        && [e.drafted, e.applied, e.skipped].every(n => Number.isSafeInteger(n) && (n as number) >= 0) && typeof e.reason === 'string') events.push(e as AutofillEvent);
    } catch { /* a torn or foreign line is not a run */ }
  }
  return events;
}

async function recordAutofillEvent(runsDir: string, event: AutofillEvent): Promise<void> {
  await appendGuarded(eventsPath(runsDir), `${eventClock(new Date(event.ts))} AUTOFILL ${JSON.stringify(event)} src=autofill\n`);
}

/** Kill switch: true when off, false when on, null when the live config cannot be read. */
export async function readAutofillOff(runsDir: string): Promise<boolean | null> {
  try {
    const resolved = await createConfigReader({ runsDir }).resolve();
    if (resolved.layers.live === 'degraded') return null;
    return resolved.values[AUTOFILL_OFF_KEY] === 1;
  } catch { return null; }
}

export interface HourlyUse { total: number; lanes: Record<string, number> }
export function hourlyUse(events: readonly AutofillEvent[], nowMs: number): HourlyUse {
  const use: HourlyUse = { total: 0, lanes: {} };
  for (const e of events) {
    const age = nowMs - Date.parse(e.ts);
    if (age < 0 || age >= HOUR_MS || e.applied === 0) continue;
    use.total += e.applied;
    use.lanes[e.lane] = (use.lanes[e.lane] ?? 0) + e.applied;
  }
  return use;
}

export interface AutofillStatus {
  schema: typeof AUTOFILL_STATUS_SCHEMA;
  ts: string;
  /** Kill switch: true = off, null = could not be read. */
  off: boolean | null;
  cap: { per_lane: number; total: number; used: number; remaining: number; lanes: Record<string, { used: number; remaining: number }> };
  /** The newest runs first. */
  last_runs: AutofillEvent[];
}

export async function autofillStatus(runsDir: string, nowMs: number, off?: boolean | null): Promise<AutofillStatus> {
  const events = readAutofillEvents(runsDir);
  const use = hourlyUse(events, nowMs);
  const lanes: AutofillStatus['cap']['lanes'] = {};
  for (const [lane, used] of Object.entries(use.lanes)) lanes[lane] = { used, remaining: Math.max(0, AUTOFILL_LANE_CAP - used) };
  return {
    schema: AUTOFILL_STATUS_SCHEMA,
    ts: new Date(nowMs).toISOString(),
    off: off === undefined ? await readAutofillOff(runsDir) : off,
    cap: { per_lane: AUTOFILL_LANE_CAP, total: AUTOFILL_TOTAL_CAP, used: use.total, remaining: Math.max(0, AUTOFILL_TOTAL_CAP - use.total), lanes },
    last_runs: events.slice(-LAST_RUNS).reverse(),
  };
}

export function autofillStatusLines(s: AutofillStatus): string[] {
  const off = s.off === null ? 'unknown (the live config could not be read)' : s.off ? 'OFF' : 'on';
  const lines = [`Autofill is ${off}. This hour: ${s.cap.used} of ${s.cap.total} bets applied (${AUTOFILL_LANE_CAP} per lane), ${s.cap.remaining} left.`];
  for (const [lane, c] of Object.entries(s.cap.lanes).sort(([a], [b]) => a.localeCompare(b))) lines.push(`  ${lane}: ${c.used} used, ${c.remaining} left`);
  if (!s.last_runs.length) lines.push('No autofill runs recorded.');
  for (const e of s.last_runs) lines.push(`${e.ts} ${e.lane}: drafted ${e.drafted}, applied ${e.applied}, skipped ${e.skipped}. ${e.reason}`);
  lines.push(s.off === true ? 'Turn it on: phm fleet config unset autofill.off --reason "<why>"' : 'Turn it off: phm fleet config set autofill.off 1 --reason "<why>"');
  return lines;
}

/** What the tick needs to know about the lanes; null where the snapshot could not be read. */
export interface LaneSnapshotView { starved: readonly string[]; counts: Readonly<Record<string, LaneCounts>> }

export interface AutofillTickOptions {
  runsDir: string;
  apply: boolean;
  now: () => number;
  root: string;
  entries: readonly { cmd: string; desc: string }[];
  /** Lane read seam; null means the snapshot is unreadable. */
  readLanes: () => Promise<LaneSnapshotView | null>;
  /** Kill-switch seam; defaults to the live config. */
  readOff?: (runsDir: string) => Promise<boolean | null>;
  /** Fill seam; defaults to runQueueAutofill. */
  fill?: (o: RunAutofillOptions) => Promise<QueueAutofillReport | { error: 'no-target' }>;
}

export interface AutofillTickReport {
  schema: typeof AUTOFILL_TICK_SCHEMA;
  ts: string;
  mode: 'apply' | 'dry-run';
  /** Why no lane was looked at; null when the pass ran. */
  reason: string | null;
  runs: AutofillEvent[];
}

/** One pass: for each starved lane, fill it up to the hourly cap, unless autofill is off. */
export async function runAutofillTick(o: AutofillTickOptions): Promise<AutofillTickReport> {
  const nowMs = o.now();
  const report: AutofillTickReport = { schema: AUTOFILL_TICK_SCHEMA, ts: new Date(nowMs).toISOString(), mode: o.apply ? 'apply' : 'dry-run', reason: null, runs: [] };
  const view = await o.readLanes().catch(() => null);
  if (view === null) return { ...report, reason: 'Lane snapshot is unknown.' };
  const lanes = [...view.starved].filter(l => LANE_NAME.test(l)).sort();
  if (!lanes.length) return { ...report, reason: 'No lane is starved.' };

  const off = await (o.readOff ?? readAutofillOff)(o.runsDir);
  const history = readAutofillEvents(o.runsDir);
  const use = hourlyUse(history, nowMs);
  const fill = o.fill ?? runQueueAutofill;
  for (const lane of lanes) {
    const run = (drafted: number, applied: number, skipped: number, reason: string): AutofillEvent =>
      ({ schema: AUTOFILL_EVENT_SCHEMA, ts: new Date(nowMs).toISOString(), lane, drafted, applied, skipped, reason });
    const allowed = Math.min(AUTOFILL_LANE_CAP - (use.lanes[lane] ?? 0), AUTOFILL_TOTAL_CAP - use.total);
    let event: AutofillEvent;
    if (off !== false) event = run(0, 0, 0, off === true ? 'autofill off' : 'autofill state unknown');
    else if (allowed <= 0) event = run(0, 0, 0, 'hourly cap');
    else {
      try {
        const result = await fill({ lane, counts: view.counts[lane] ?? { running: null, target: null, queued: null }, apply: o.apply, limit: allowed, root: o.root, dir: join(o.runsDir, 'queue'), entries: o.entries });
        if ('error' in result) event = run(0, 0, 0, 'The lane has no slot target.');
        else {
          const applied = result.applied ? result.drafted.length : 0;
          event = run(result.drafted.length, applied, result.skipped.length, result.summary);
          use.total += applied;
          use.lanes[lane] = (use.lanes[lane] ?? 0) + applied;
        }
      } catch (error) {
        event = run(0, 0, 0, `autofill failed: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}`);
      }
    }
    report.runs.push(event);
    if (!o.apply) continue;
    // A refusal repeats every tick; record it once per hour per reason so the log (and the last runs) stay readable.
    const prior = history.filter(e => e.lane === lane).at(-1);
    const repeat = event.applied === 0 && event.drafted === 0 && prior !== undefined && prior.reason === event.reason && prior.applied === 0 && nowMs - Date.parse(prior.ts) < HOUR_MS;
    if (!repeat) await recordAutofillEvent(o.runsDir, event).catch(() => {});
  }
  return report;
}
