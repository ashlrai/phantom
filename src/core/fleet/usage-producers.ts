/**
 * `phm usage producers`: who is spending each plan (RQ-PRODUCERSN20CQ8).
 *
 * Jobs reach a plan from more than the dispatcher. This reads two records and puts them side by side:
 *  - the dispatcher's job metrics file (`metrics/jobs.jsonl`: launch, finish, publish and outcome rows, read by
 *    the same `ledgerRows` as `phm fleet launches`), one producer per lane;
 *  - each outside loop's log (`<loop>.log` in the runs dir, lines `<date> <time> start <job> repo=.. model=.. base=..`
 *    and `<date> <time> publish <job> .. RESULT PR <url>`), one producer per loop, found by its log or its
 *    `<loop>-ledger.tsv`. The ledger is only used to find the loop; its columns are not read.
 * Leader passes have no per-job record, so they are listed under `gaps` unless a lane named leader launched jobs.
 *
 * Anything no record says is the string "unknown", never 0. Pure `buildUsageProducers`; `readUsageProducers`
 * does the reading. Read-only, never throws.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ledgerRows, readText } from './empty-cause.js';

export const USAGE_PRODUCERS_SCHEMA = 'fleet.usage-producers.v1';
export const USAGE_PRODUCERS_DEFAULT_HOURS = 6;
export const USAGE_PRODUCERS_MAX_HOURS = 168;
const HOUR = 3_600_000;
/** Outcome rows this far back still say whether a PR published inside the window merged. */
const OUTCOME_LOOKBACK_HOURS = 72;
const TAIL_BYTES = 32 * 1024 * 1024;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/i;
const LOOP_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;
const LOG_LINE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s+(start|publish)\s+(\S+)(.*)$/;
const MODEL = /\bmodel=([\w.:/@-]{1,80})/;
const RESULT_PR = /\bRESULT PR\s+(https:\/\/\S+)/;

export type Unknown = 'unknown';
export type ProducerKind = 'dispatcher-lane' | 'loop';

export interface UsageProducer {
  producer: string;
  kind: ProducerKind;
  jobs_started: number | Unknown;
  /** Distinct models its jobs started with; "unknown" when no start row names one. */
  models: string[] | Unknown;
  /** Minutes of wall time over the jobs whose start and end are both on record. */
  wall_minutes: number | Unknown;
  prs_published: number | Unknown;
  /** PRs with an outcome record that says merged; "unknown" when no outcome record covers this producer. */
  prs_merged: number | Unknown;
}

export interface UsageProducerGap { producer: string; reason: string }

export interface UsageProducersReport {
  schema: typeof USAGE_PRODUCERS_SCHEMA;
  as_of: string;
  hours: number;
  metrics: 'ok' | 'unreadable';
  /** Most jobs started first. */
  producers: UsageProducer[];
  gaps: UsageProducerGap[];
  headline: string;
}

/** One outside loop's log text, or null when it could not be read. */
export interface LoopRecord { name: string; log: string | null; hasLedger: boolean }

export interface UsageProducersInput {
  /** Contents of metrics/jobs.jsonl, or null when unreadable. */
  ledger: string | null;
  loops: readonly LoopRecord[];
  now: number;
  hours: number;
}

const label = (value: unknown): string | null => typeof value === 'string' && /^[\w][\w.:@/-]{0,79}$/.test(value.trim()) ? value.trim() : null;
const round1 = (value: number): number => Math.round(value * 10) / 10;
const prKey = (url: string): string | null => { const m = PR_URL.exec(url); return m ? `${m[1]}#${m[2]}`.toLowerCase() : null; };

/** Pure: validate `--since` ("6h", "90m", "2d", or bare hours). Hours (may be fractional) or null when invalid. */
export function usageProducersHours(value?: string | null): number | null {
  if (value == null) return USAGE_PRODUCERS_DEFAULT_HOURS;
  const m = /^(\d{1,4})([mhd]?)$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const hours = m[2] === 'm' ? n / 60 : m[2] === 'd' ? n * 24 : n;
  return hours > 0 && hours <= USAGE_PRODUCERS_MAX_HOURS ? hours : null;
}

interface Tally {
  jobs: Set<string>;
  starts: number;
  models: Set<string>;
  wallSeconds: number;
  wallJobs: number;
  prs: Set<string>;
}
const tally = (): Tally => ({ jobs: new Set(), starts: 0, models: new Set(), wallSeconds: 0, wallJobs: 0, prs: new Set() });

/** Local time, because the loops write `date` output; the same clock reads it back. */
const logTime = (date: string, time: string): number => Date.parse(`${date}T${time}`);

function toProducer(name: string, kind: ProducerKind, t: Tally, merged: ReadonlySet<string>, outcomesKnown: boolean, publishKnown: boolean): UsageProducer {
  const known = [...t.prs].filter(key => merged.has(key)).length;
  return {
    producer: name, kind,
    jobs_started: t.starts,
    models: t.models.size ? [...t.models].sort() : 'unknown',
    wall_minutes: t.wallJobs ? round1(t.wallSeconds / 60) : 'unknown',
    prs_published: publishKnown ? t.prs.size : 'unknown',
    prs_merged: outcomesKnown && publishKnown ? known : 'unknown',
  };
}

/** Pure: one report for the window. */
export function buildUsageProducers(input: UsageProducersInput): UsageProducersReport {
  const { now, hours } = input;
  const since = now - hours * HOUR;
  const report: UsageProducersReport = {
    schema: USAGE_PRODUCERS_SCHEMA, as_of: new Date(now).toISOString(), hours,
    metrics: input.ledger === null ? 'unreadable' : 'ok', producers: [], gaps: [], headline: '',
  };
  const merged = new Set<string>();
  let outcomesKnown = false, publishKnown = false;
  const lanes = new Map<string, Tally>();
  if (input.ledger !== null) {
    const { rows } = ledgerRows(input.ledger, now, hours + OUTCOME_LOOKBACK_HOURS, true);
    const launches = new Map<string, { lane: string; model: string | null; at: number }[]>();
    for (const { row, id, at } of rows) {
      const event = [row.event, row.type, row.kind].find((v): v is string => typeof v === 'string') ?? (row.source === 'metrics-outcomes-reconciler' ? 'outcome' : null);
      const url = prKey(String([row.url, row.prUrl, row.pr_url, row.pr, row.html_url].find((v): v is string => typeof v === 'string') ?? ''));
      if (event === 'outcome' || event === 'merged') {
        outcomesKnown = true;
        if (url && (event === 'merged' || (row.state ?? row.outcome ?? row.status ?? row.phase ?? row.result ?? row.conclusion) === 'MERGED')) merged.add(url);
      }
      if ((event === 'publish' || event === 'published') && url) publishKnown = true;
      if (event !== 'launch' || !id || at < since) continue;
      const lane = label(row.lane) ?? label(row.pool) ?? label(row.arm) ?? 'unknown';
      const list = launches.get(id) ?? [];
      list.push({ lane, model: label(row.model), at });
      launches.set(id, list);
    }
    const laneOf = new Map<string, string>();
    for (const [job, list] of launches) {
      for (const launch of list) {
        const t = lanes.get(launch.lane) ?? tally();
        lanes.set(launch.lane, t);
        t.jobs.add(job); t.starts++;
        if (launch.model) t.models.add(launch.model);
        laneOf.set(job, launch.lane);
      }
    }
    // Publishes and wall time belong to the lane that launched the job.
    for (const { row, id, at } of rows) {
      const lane = laneOf.get(id);
      if (!lane || at < since) continue;
      const t = lanes.get(lane)!;
      const event = [row.event, row.type, row.kind].find((v): v is string => typeof v === 'string');
      const url = prKey(String([row.url, row.prUrl, row.pr_url, row.pr, row.html_url].find((v): v is string => typeof v === 'string') ?? ''));
      if ((event === 'publish' || event === 'published') && url) t.prs.add(url);
      const wall = typeof row.wall_s === 'number' && Number.isFinite(row.wall_s) && row.wall_s >= 0 ? row.wall_s : null;
      if (event === 'finish' && wall !== null) { t.wallSeconds += wall; t.wallJobs++; }
    }
    for (const [name, t] of lanes) report.producers.push(toProducer(name, 'dispatcher-lane', t, merged, outcomesKnown, publishKnown));
  }
  for (const loop of input.loops) {
    const t = tally();
    const started = new Map<string, number>();
    let parsed = 0;
    for (const line of (loop.log ?? '').split(/\r?\n/)) {
      const m = LOG_LINE.exec(line.trim());
      if (!m) continue;
      parsed++;
      const at = logTime(m[1]!, m[2]!);
      if (!Number.isFinite(at)) continue;
      const [, , , verb, job, rest] = m;
      if (at < since || at > now) {
        // A job that started before the window may still publish inside it; only its wall time needs the start.
        if (verb === 'start') started.set(job!, at);
        continue;
      }
      if (verb === 'start') {
        started.set(job!, at);
        t.jobs.add(job!); t.starts++;
        const model = MODEL.exec(rest!)?.[1];
        if (model) t.models.add(model);
      } else {
        const url = RESULT_PR.exec(rest!)?.[1];
        const key = url ? prKey(url) : null;
        if (key) t.prs.add(key);
        const begin = started.get(job!);
        if (begin !== undefined && at >= begin) { t.wallSeconds += (at - begin) / 1000; t.wallJobs++; }
      }
    }
    if (parsed === 0) {
      // A ledger with no readable log is a loop we cannot count; a log with no loop lines is some other log.
      if (loop.hasLedger) report.gaps.push({ producer: loop.name, reason: loop.log === null ? `${loop.name}.log is missing or unreadable` : `${loop.name}.log has no start or publish lines` });
      continue;
    }
    // A readable loop log is the record: no publish lines in it means none published, not unknown.
    report.producers.push(toProducer(loop.name, 'loop', t, merged, outcomesKnown, true));
  }
  if (input.ledger === null) report.gaps.unshift({ producer: 'dispatcher', reason: 'metrics/jobs.jsonl cannot be read' });
  else if (!lanes.has('leader')) report.gaps.push({ producer: 'leader', reason: 'no per-pass record; leader jobs show only when they launch through a lane' });
  const count = (p: UsageProducer): number => typeof p.jobs_started === 'number' ? p.jobs_started : -1;
  report.producers.sort((a, b) => count(b) - count(a) || a.producer.localeCompare(b.producer));
  const total = report.producers.reduce((sum, p) => sum + Math.max(0, count(p)), 0);
  const top = report.producers[0];
  report.headline = top
    ? `${total} jobs started in the last ${windowText(hours)} across ${report.producers.length} producers; most from ${top.producer} (${top.jobs_started})`
    : `No producer started a job in the last ${windowText(hours)}${report.metrics === 'unreadable' ? ' (job metrics unreadable)' : ''}`;
  return report;
}

const windowText = (hours: number): string => hours < 1 ? `${Math.round(hours * 60)} m` : `${round1(hours)} h`;

/** Plain lines for the CLI: headline, a table, then the gaps. */
export function usageProducersText(report: UsageProducersReport): string[] {
  const rows = report.producers.map(p => [
    p.producer, p.kind === 'loop' ? 'loop' : 'lane', String(p.jobs_started),
    Array.isArray(p.models) ? p.models.join(',') : p.models,
    p.wall_minutes === 'unknown' ? 'unknown' : `${p.wall_minutes} m`,
    String(p.prs_published), String(p.prs_merged),
  ]);
  const head = ['producer', 'kind', 'jobs', 'models', 'wall', 'published', 'merged'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [
    `${report.headline}.`,
    ...(rows.length ? [fmt(head), ...rows.map(fmt)] : []),
    ...(report.gaps.length ? ['No record for:', ...report.gaps.map(g => `  ${g.producer}: ${g.reason}`)] : []),
  ];
}

/** Names of outside loops found in the runs dir: every `<loop>-ledger.tsv` and every `<loop>.log`. */
export async function findLoops(runsDir: string): Promise<{ name: string; hasLedger: boolean }[]> {
  let names: string[];
  try { names = await readdir(runsDir); } catch { return []; }
  const found = new Map<string, boolean>();
  for (const file of names) {
    const ledger = /^(.+)-ledger\.tsv$/.exec(file)?.[1];
    const log = /^(.+)\.log$/.exec(file)?.[1];
    const name = ledger ?? log;
    if (!name || !LOOP_NAME.test(name)) continue;
    found.set(name, (found.get(name) ?? false) || ledger !== undefined);
  }
  return [...found].map(([name, hasLedger]) => ({ name, hasLedger })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Read the job metrics file and every outside loop's log. Read-only; never throws. */
export async function readUsageProducers(opts: { runsDir: string; metricsPath: string; hours: number; now: number }): Promise<UsageProducersReport> {
  const [ledger, found] = await Promise.all([readText(opts.metricsPath, TAIL_BYTES), findLoops(opts.runsDir)]);
  const loops = await Promise.all(found.map(async f => ({ ...f, log: await readText(join(opts.runsDir, `${f.name}.log`), TAIL_BYTES) })));
  return buildUsageProducers({ ledger, loops, now: opts.now, hours: opts.hours });
}
