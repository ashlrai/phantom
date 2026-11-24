/**
 * `phm fleet burn` and GET /api/usage/burn: who is spending the Claude plan and
 * when it runs out at this pace. One plain sentence first, the evidence under it.
 *
 * Reads what already exists and adds no ledger: usage samples from
 * `fable-usage.json` (`claude_weekly_frac` + `ts`), the reset time and the
 * dispatchd-reported pace from `queue/status.json` (`budget.claude.use_it_all`,
 * via spend.ts), and job starts from metrics/jobs.jsonl, the claude-loop logs and
 * dispatch-events.log. The slope is the same least-squares fit `phm pools` uses
 * (burn-rate.ts). Unknown stays unknown: nothing is guessed.
 *
 * The consumer split counts job STARTS, not tokens. It says who starts the most
 * work, which is a hint about who spends, not a measurement of it.
 */
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { burnRate, type BurnSample } from './burn-rate.js';
import { readDispatchStatus } from './spend.js';
import { localTimestamp, readSource } from '../fleet/runs-parked-queue.js';

export const BURN_WHO_SCHEMA = 'usage.burn.v1' as const;
export const BURN_POOL = 'claude';
const HOUR_MS = 3_600_000;
const WEEK_HOURS = 168;
const SHARE_WINDOW_HOURS = 6;
const MAX_BYTES = 8 * 1024 * 1024;
const LOOP_LOG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}\.log$/;

export interface BurnConsumer { name: string; kind: 'dispatchd' | 'loop' | 'leader'; starts: number; startsPerHour: number; sharePercent: number }
export interface BurnWho {
  schema: typeof BURN_WHO_SCHEMA; v: 1;
  pool: typeof BURN_POOL;
  /** One plain sentence: the same text on the CLI and the Leader card. */
  sentence: string;
  usedPercent: number | null;
  /** Points an hour over the last 1 h / 6 h from the samples; null when there are too few. */
  pace1h: number | null;
  pace6h: number | null;
  /** The pace the projection uses, and where it came from; null when no pace is known. */
  paceNow: number | null;
  paceBasis: '1h' | '6h' | 'reported' | null;
  resetAt: string | null;
  hoursToReset: number | null;
  /** Share of the week that has passed, 100 x (1 - hoursToReset/168): the used share an even spend would show. */
  evenPacePercent: number | null;
  emptyAt: string | null;
  /** Hours the plan sits empty before it resets; null when it lasts or is unknown. */
  idleHours: number | null;
  state: 'unknown' | 'idle' | 'on-pace' | 'ahead';
  reason: string | null;
  /** Start counts in the last 6 h; NOT tokens. */
  consumers: BurnConsumer[];
  startsNote: string;
}
export interface BurnWhoInputs {
  /** Raw fable-usage.json text, or null when missing. */
  usageJson: string | null;
  /** Parsed queue/status.json, or null. */
  status: unknown;
  /** Raw metrics/jobs.jsonl tail. */
  jobsText?: string;
  /** Loop name to its raw log text. */
  loopLogs?: ReadonlyMap<string, string>;
  /** Raw dispatch-events.log tail. */
  eventsText?: string;
  now?: number;
  /** Time zone for the "empty about" wording; the local one by default. */
  timeZone?: string;
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round1 = (n: number): number => Math.round(n * 10) / 10;

function stamp(v: unknown): number {
  if (typeof v === 'string') return Date.parse(v);
  // Epoch seconds or milliseconds.
  return num(v) ? (v < 1e11 ? v * 1000 : v) : NaN;
}

/** Pure: every sample `{ts, claude_weekly_frac}` in an array, `{samples|history: []}` or a single object. Fractions are 0-1. */
export function parseUsageSamples(text: string | null): BurnSample[] {
  let raw: unknown;
  try { raw = JSON.parse(text ?? 'null'); } catch { return []; }
  const list = Array.isArray(raw) ? raw : object(raw) ? (Array.isArray(raw.samples) ? raw.samples : Array.isArray(raw.history) ? raw.history : [raw]) : [];
  const out: BurnSample[] = [];
  for (const item of list) {
    if (!object(item) || !num(item.claude_weekly_frac) || item.claude_weekly_frac < 0 || item.claude_weekly_frac > 10) continue;
    const ms = stamp(item.ts);
    if (Number.isFinite(ms)) out.push({ at: new Date(ms).toISOString(), used_pct: item.claude_weekly_frac * 100 });
  }
  return out;
}

const ISO_OR_LOCAL = /^\[?(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d(?:\.\d+)?)(Z|[+-]\d\d:?\d\d)?\]?\s*(.*)$/;
function lineTime(line: string): { ms: number; rest: string } | null {
  const m = ISO_OR_LOCAL.exec(line);
  if (!m) return null;
  const ms = m[3] ? Date.parse(`${m[1]}T${m[2]}${m[3]}`) : localTimestamp(`${m[1]} ${m[2]!.slice(0, 8)}`).ms;
  return Number.isFinite(ms) ? { ms, rest: m[4] ?? '' } : null;
}

const inWindow = (ms: number, now: number): boolean => ms <= now && ms >= now - SHARE_WINDOW_HOURS * HOUR_MS;

/** Pure: start counts per consumer over the last 6 h, most starts first. */
export function countStarts(input: Pick<BurnWhoInputs, 'jobsText' | 'loopLogs' | 'eventsText'>, now: number): BurnConsumer[] {
  const raw: Array<{ name: string; kind: BurnConsumer['kind']; starts: number }> = [];
  let dispatchd = 0;
  const seen = new Set<string>();
  for (const line of (input.jobsText ?? '').split('\n')) {
    if (!line.includes('"launch"')) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!object(row) || row.event !== 'launch' || row.lane !== BURN_POOL || typeof row.ts !== 'string') continue;
    const ms = Date.parse(row.ts);
    const job = String(row.job ?? row.job_id ?? row.id ?? '');
    // claude-loop jobs (RQ-CL-*) are counted from their own logs; a relaunch of one job counts once.
    if (!Number.isFinite(ms) || !inWindow(ms, now) || /^RQ-CL-/.test(job) || (job && seen.has(`${job}@${row.ts}`))) continue;
    seen.add(`${job}@${row.ts}`);
    dispatchd++;
  }
  raw.push({ name: 'dispatchd claude lane', kind: 'dispatchd', starts: dispatchd });
  for (const [name, text] of input.loopLogs ?? []) {
    let starts = 0;
    for (const line of text.split('\n')) {
      const at = lineTime(line);
      if (at && inWindow(at.ms, now) && /\bstart(?:ed)?\b/i.test(at.rest)) starts++;
    }
    raw.push({ name: `${name} loop`, kind: 'loop', starts });
  }
  let passes = 0;
  for (const line of (input.eventsText ?? '').split('\n')) {
    const at = lineTime(line);
    if (at && inWindow(at.ms, now) && /^OPUS-LEADER rc=/.test(at.rest)) passes++;
  }
  raw.push({ name: 'leader passes', kind: 'leader', starts: passes });
  const total = raw.reduce((sum, row) => sum + row.starts, 0);
  return raw.map(row => ({ ...row, startsPerHour: round1(row.starts / SHARE_WINDOW_HOURS), sharePercent: total ? Math.round(row.starts / total * 100) : 0 }))
    .sort((a, b) => b.starts - a.starts || a.name.localeCompare(b.name));
}

function when(ms: number, now: number, timeZone?: string): string {
  const opts = { timeZone } as const;
  const day = (t: number) => new Date(t).toLocaleDateString('en-CA', opts);
  const time = new Date(ms).toLocaleTimeString('en-US', { ...opts, hour: 'numeric', minute: '2-digit' }).replace(':00', '');
  const d = day(ms);
  const part = d === day(now) ? 'today' : d === day(now + 24 * HOUR_MS) ? 'tomorrow' : new Date(ms).toLocaleDateString('en-US', { ...opts, weekday: 'long' });
  return `${time} ${part}`;
}
const span = (hours: number): string => hours >= 36 ? `${Math.round(hours / 24)} days` : hours >= 1.5 ? `${Math.round(hours)} hours` : 'under 2 hours';
const points = (n: number): string => `${n < 1 ? round1(n) : Math.round(n)} point${Math.round(n) === 1 && n >= 1 ? '' : 's'} an hour`;

/** Pure: the whole answer from the raw files. */
export function whoIsBurning(input: BurnWhoInputs): BurnWho {
  const now = input.now ?? Date.now();
  const samples = parseUsageSamples(input.usageJson).filter(s => Date.parse(s.at) <= now);
  const newest = [...samples].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const status = object(input.status) ? input.status : {};
  const budget = object(status.budget) ? status.budget : {};
  const lane = object(budget[BURN_POOL]) ? budget[BURN_POOL] as Record<string, unknown> : {};
  const pace = object(lane.use_it_all) && lane.use_it_all.known === true && lane.use_it_all.stale === false ? lane.use_it_all : {};

  const statusUsed = num(pace.used_pct) && pace.used_pct >= 0 && pace.used_pct <= 1000 ? pace.used_pct : null;
  const used = newest ? newest.used_pct : statusUsed;
  const resetMs = typeof pace.reset_at === 'string' ? Date.parse(pace.reset_at) : num(pace.reset_at) ? pace.reset_at * 1000 : NaN;
  const hoursToReset = Number.isFinite(resetMs) && resetMs > now ? (resetMs - now) / HOUR_MS : num(pace.hours_to_reset) && pace.hours_to_reset > 0 ? pace.hours_to_reset : null;

  const pace1h = burnRate(samples.filter(s => Date.parse(s.at) >= now - HOUR_MS), now).points_per_hour;
  const pace6h = burnRate(samples, now).points_per_hour;
  const reported = num(pace.burn_pct_per_hour) && pace.burn_pct_per_hour >= 0 ? pace.burn_pct_per_hour : null;
  const paceNow = pace1h ?? pace6h ?? reported;
  const paceBasis = pace1h !== null ? '1h' : pace6h !== null ? '6h' : reported !== null ? 'reported' : null;
  const even = hoursToReset === null ? null : round1(Math.min(100, Math.max(0, (1 - hoursToReset / WEEK_HOURS) * 100)));

  const consumers = countStarts(input, now);
  const startsTotal = consumers.reduce((sum, c) => sum + c.starts, 0);
  const top = consumers[0];
  const who = top && top.starts > 0 ? ` Most starts: ${top.name} (${top.startsPerHour}/h).` : startsTotal === 0 && paceNow ? ' No job starts found in the last 6 hours.' : '';

  const out: BurnWho = { schema: BURN_WHO_SCHEMA, v: 1, pool: BURN_POOL, sentence: '', usedPercent: used === null ? null : round1(used),
    pace1h: pace1h === null ? null : round1(pace1h), pace6h: pace6h === null ? null : round1(pace6h), paceNow: paceNow === null ? null : round1(paceNow), paceBasis,
    resetAt: hoursToReset === null ? null : new Date(now + hoursToReset * HOUR_MS).toISOString(), hoursToReset: hoursToReset === null ? null : round1(hoursToReset),
    evenPacePercent: even, emptyAt: null, idleHours: null, state: 'unknown', reason: null, consumers,
    startsNote: 'Shares count job starts in the last 6 hours, not tokens.' };

  const missing = used === null ? 'no usage reading' : hoursToReset === null ? 'reset time unknown' : paceNow === null ? 'not enough readings to measure the pace' : null;
  if (missing) {
    out.reason = missing;
    out.sentence = `Claude usage is unknown: ${missing}.${used !== null ? ` It was last read at ${round1(used)}%.` : ''}${who}`;
    return out;
  }
  const u = used as number; const h = hoursToReset as number; const p = paceNow as number;
  const head = `Claude is at ${Math.round(u)}%`;
  if (p <= 0) {
    out.state = 'idle';
    out.sentence = `${head} and nothing is spending it right now; it lasts to its reset.${who}`;
    return out;
  }
  const hoursToEmpty = Math.max(0, 100 - u) / p;
  if (hoursToEmpty < h) {
    const emptyMs = now + hoursToEmpty * HOUR_MS;
    out.state = 'ahead'; out.emptyAt = new Date(emptyMs).toISOString(); out.idleHours = round1(h - hoursToEmpty);
    out.sentence = `${head}, spending about ${points(p)}; empty about ${when(emptyMs, now, input.timeZone)}, ${span(h - hoursToEmpty)} before its reset.${who}`;
  } else {
    out.state = 'on-pace';
    out.sentence = `${head}, spending about ${points(p)}; that lasts to its reset.${who}`;
  }
  return out;
}

export interface ReadBurnOptions { runsDir?: string; now?: number; timeZone?: string }

/** Reads the files `phm fleet burn` explains. Any missing file is just an empty source. */
export async function readBurnWho(options: ReadBurnOptions = {}): Promise<BurnWho> {
  const runsDir = options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const text = async (path: string, tail: boolean): Promise<string> => (await readSource(path, MAX_BYTES, tail)).text;
  const loopDir = join(runsDir, 'devin-cloud-in', 'claude-loop');
  const names = (await readdir(loopDir).catch(() => [] as string[])).filter(n => LOOP_LOG.test(n)).sort();
  const [usageSource, status, jobsText, eventsText, logs] = await Promise.all([
    readSource(join(runsDir, 'fable-usage.json'), MAX_BYTES, false),
    readDispatchStatus(join(runsDir, 'queue', 'status.json')),
    text(join(runsDir, 'metrics', 'jobs.jsonl'), true),
    text(join(runsDir, 'queue', 'dispatch-events.log'), true),
    Promise.all(names.map(async n => [n.slice(0, -4), await text(join(loopDir, n), true)] as const)),
  ]);
  return whoIsBurning({ usageJson: usageSource.state === 'healthy' ? usageSource.text : null, status, jobsText, eventsText,
    loopLogs: new Map(logs), now: options.now, timeZone: options.timeZone });
}
