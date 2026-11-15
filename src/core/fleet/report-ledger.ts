/**
 * report-ledger.ts — deterministic 12-hour recorded-jobs report
 * (RQ-REPORTS-NO-GROK-1 ledger slice, recovered from PR #4284).
 *
 * `ashlr fleet report-ledger` answers "what did the fleet record in the last
 * 12 hours" from metrics/jobs.jsonl alone: no model, no network, no gh. The
 * file is the source of truth when every relay is down.
 *
 * Honesty rules carried from the original builder: a missing or unreadable
 * ledger is 'unavailable', a retained tail that does not reach the window
 * start is 'incomplete', and malformed rows are skipped — never crash, never
 * invent evidence. When the ledger is unavailable the counts are null, not a
 * claimed zero. Display text passes through scrubSecrets; no raw ledger
 * records, message bodies, account ids or private paths leave this module.
 * This is an observation only — it never authorizes dispatch or merges.
 */

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { scrubSecrets } from '../util/scrub.js';

export const REPORT_LEDGER_SCHEMA = 'ashlr.fleet-report-ledger/v1' as const;
/** Same trailing window as the leader brief and the 07:30/20:00 reports. */
export const REPORT_LEDGER_WINDOW_MS = 12 * 3_600_000;

const JOBS_TAIL_BYTES = 2 * 1024 * 1024;
const REPORT_MAX_ITEMS = 12;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const GH_PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/i;

export interface ReportLedgerRow {
  job: string;
  lane: string | null;
  url: string | null;
  at: string | null;
  ttmSeconds: number | null;
}

export interface ReportLedgerGrowth {
  windowHours: number;
  /** 'incomplete' when the retained ledger tail does not reach the window start. */
  ledger: 'available' | 'unavailable' | 'incomplete';
  launches: number;
  finishes: number;
  empty: number;
  publishes: number;
  merges: number;
  tokens: number;
  byLane: Array<{ lane: string; launches: number; finishes: number; merges: number }>;
  published: ReportLedgerRow[];
  merged: ReportLedgerRow[];
}

export interface ReportLedger {
  schema: typeof REPORT_LEDGER_SCHEMA;
  generatedAt: string;
  window: { hours: number; since: string; until: string };
  ledger: ReportLedgerGrowth['ledger'];
  /** Count fields are null when the ledger was unavailable — unknown, never a claimed zero. */
  counts: Record<'launches' | 'finishes' | 'empty' | 'publishes' | 'merges' | 'tokens', number | null>;
  /** True when counts cover only the retained tail, a lower bound on the window. */
  countsAreLowerBound: boolean;
  byLane: ReportLedgerGrowth['byLane'];
  evidence: { published: ReportLedgerRow[]; merged: ReportLedgerRow[] };
}

/**
 * One ledger row's event time (ms). dispatchd stamps ISO strings with `+0000`
 * offsets and `Z`; naive strings read as UTC. Unparseable → NaN.
 */
function rowTs(row: Record<string, unknown>): number {
  const raw = row['ts'] ?? row['timestamp'] ?? row['at'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return Number.NaN;
  const trimmed = raw.trim();
  if (!trimmed) return Number.NaN;
  const withZone = trimmed.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const parsed = Date.parse(withZone);
  if (Number.isFinite(parsed)) return parsed;
  return Date.parse(`${trimmed}Z`);
}

function rowJob(row: Record<string, unknown>): string | null {
  const value = row['job'] ?? row['job_id'] ?? row['jobId'] ?? row['id'];
  return typeof value === 'string' && JOB_ID.test(value) ? value : null;
}

function rowUrl(row: Record<string, unknown>): string | null {
  const value = row['url'] ?? row['prUrl'] ?? row['pr_url'] ?? row['pr'];
  return typeof value === 'string' && GH_PR_URL.test(value.trim()) ? value.trim().replace(/\/$/, '') : null;
}

function pick(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Fold the bounded jobs-ledger tail into windowed growth. Never throws. */
export function summarizeJobsLedger(text: string, truncated: boolean, nowMs: number, windowMs = REPORT_LEDGER_WINDOW_MS): ReportLedgerGrowth {
  const growth: ReportLedgerGrowth = {
    windowHours: Math.round(windowMs / 3_600_000),
    ledger: 'available',
    launches: 0, finishes: 0, empty: 0, publishes: 0, merges: 0, tokens: 0,
    byLane: [], published: [], merged: [],
  };
  const since = nowMs - windowMs;
  const lanes = new Map<string, { launches: number; finishes: number; merges: number }>();
  const published = new Map<string, ReportLedgerRow>();
  const merged = new Map<string, ReportLedgerRow>();
  let sawAny = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch { continue; }
    const ts = rowTs(row);
    if (!Number.isFinite(ts) || ts < since || ts > nowMs + 86_400_000) continue;
    sawAny = true;
    const event = typeof row['event'] === 'string' ? row['event'] : typeof row['type'] === 'string' ? row['type'] : null;
    const job = rowJob(row) ?? 'unknown';
    const lane = pick(row, ['lane', 'actualLane', 'pool']);
    const at = pick(row, ['ts', 'timestamp', 'at']);
    const laneCounts = () => {
      const entry = lanes.get(lane ?? 'unknown') ?? { launches: 0, finishes: 0, merges: 0 };
      lanes.set(lane ?? 'unknown', entry);
      return entry;
    };
    if (event === 'launch') {
      growth.launches += 1;
      laneCounts().launches += 1;
    } else if (event === 'finish') {
      growth.finishes += 1;
      if (row['empty'] === true) growth.empty += 1;
      const tokens = row['tokens_total'] ?? row['tokens'];
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) growth.tokens += tokens;
      laneCounts().finishes += 1;
    } else if (event === 'publish') {
      growth.publishes += 1;
      const url = rowUrl(row);
      if (url && !published.has(url)) published.set(url, { job, lane, url, at, ttmSeconds: null });
    } else if (event === 'outcome' || event === 'pr-merge') {
      const state = pick(row, ['state', 'outcome', 'status'])?.toUpperCase();
      if (state !== 'MERGED') continue;
      growth.merges += 1;
      laneCounts().merges += 1;
      const url = rowUrl(row);
      const ttm = row['ttm_s'];
      const key = url ?? job;
      if (!merged.has(key)) {
        merged.set(key, {
          job, lane, url,
          at: pick(row, ['mergedAt', 'merged_at', 'ts', 'timestamp', 'at']),
          ttmSeconds: typeof ttm === 'number' && Number.isFinite(ttm) && ttm >= 0 ? ttm : null,
        });
      }
    }
  }
  if (!sawAny) growth.ledger = text.trim() ? 'incomplete' : 'unavailable';
  else if (truncated) growth.ledger = 'incomplete';
  growth.byLane = [...lanes.entries()].map(([lane, counts]) => ({ lane, ...counts }))
    .sort((a, b) => b.merges - a.merges || b.launches - a.launches || a.lane.localeCompare(b.lane));
  growth.published = [...published.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, REPORT_MAX_ITEMS);
  growth.merged = [...merged.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, REPORT_MAX_ITEMS);
  return growth;
}

/** Last JOBS_TAIL_BYTES of the ledger, first partial line dropped. */
export async function readJobsTail(path: string): Promise<{ text: string | null; truncated: boolean }> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile()) return { text: null, truncated: false };
      const start = Math.max(0, info.size - JOBS_TAIL_BYTES);
      const bytes = Buffer.alloc(info.size - start);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, start + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const text = bytes.subarray(0, offset).toString('utf8');
      return { text: start ? text.slice(text.indexOf('\n') < 0 ? text.length : text.indexOf('\n') + 1) : text, truncated: start > 0 };
    } finally { await file.close(); }
  } catch { return { text: null, truncated: false }; }
}

export interface BuildReportLedgerOptions {
  runsDir: string;
  now?: Date;
  /** Test seam; defaults to readJobsTail(<runsDir>/metrics/jobs.jsonl). */
  jobsText?: () => Promise<{ text: string | null; truncated: boolean }>;
}

/**
 * Assemble the report. Every field degrades on its own; display strings are
 * scrubbed at this boundary so raw lane text cannot carry secrets outward.
 */
export async function buildReportLedger(opts: BuildReportLedgerOptions): Promise<ReportLedger> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const since = nowMs - REPORT_LEDGER_WINDOW_MS;
  const read = opts.jobsText ?? (() => readJobsTail(join(opts.runsDir, 'metrics', 'jobs.jsonl')));
  let jobs: { text: string | null; truncated: boolean };
  try { jobs = await read(); } catch { jobs = { text: null, truncated: false }; }

  const growth = jobs.text === null
    ? {
      windowHours: Math.round(REPORT_LEDGER_WINDOW_MS / 3_600_000), ledger: 'unavailable' as const,
      launches: 0, finishes: 0, empty: 0, publishes: 0, merges: 0, tokens: 0,
      byLane: [], published: [], merged: [],
    }
    : summarizeJobsLedger(jobs.text, jobs.truncated, nowMs);

  const scrubText = (value: string | null): string | null =>
    value === null ? null : scrubSecrets(value).slice(0, 80);
  const scrubRow = (row: ReportLedgerRow): ReportLedgerRow => ({ ...row, job: scrubText(row.job)!, lane: scrubText(row.lane) });
  const unavailable = growth.ledger === 'unavailable';
  return {
    schema: REPORT_LEDGER_SCHEMA,
    generatedAt: now.toISOString(),
    window: { hours: growth.windowHours, since: new Date(since).toISOString(), until: now.toISOString() },
    ledger: growth.ledger,
    counts: unavailable
      ? { launches: null, finishes: null, empty: null, publishes: null, merges: null, tokens: null }
      : {
        launches: growth.launches, finishes: growth.finishes, empty: growth.empty,
        publishes: growth.publishes, merges: growth.merges, tokens: growth.tokens,
      },
    countsAreLowerBound: growth.ledger === 'incomplete',
    byLane: growth.byLane.map((row) => ({ ...row, lane: scrubText(row.lane)! })),
    evidence: {
      published: growth.published.map(scrubRow),
      merged: growth.merged.map(scrubRow),
    },
  };
}

/** Plain-language summary: short, actionable, honest about gaps. */
export function renderReportLedgerText(report: ReportLedger): string {
  const lines: string[] = [
    `Recorded fleet activity — last ${report.window.hours}h (ledger ${report.ledger})`,
  ];
  const c = report.counts;
  if (c.launches === null) {
    lines.push('Jobs ledger unavailable: metrics/jobs.jsonl missing or unreadable; counts unknown.');
    return lines.join('\n');
  }
  lines.push(
    `launches ${c.launches} · finishes ${c.finishes} (empty ${c.empty}) · publishes ${c.publishes} · merges ${c.merges} · tokens ${c.tokens}`,
  );
  if (report.countsAreLowerBound) {
    lines.push('Coverage incomplete: retained ledger tail does not reach the window start; counts are a lower bound.');
  }
  for (const lane of report.byLane) {
    lines.push(`- ${lane.lane}: ${lane.launches} launched, ${lane.finishes} finished, ${lane.merges} merged`);
  }
  const prs = new Map<string, { url: string; kind: 'merged' | 'published'; job: string }>();
  for (const row of report.evidence.merged) if (row.url && !prs.has(row.url)) prs.set(row.url, { url: row.url, kind: 'merged', job: row.job });
  for (const row of report.evidence.published) if (row.url && !prs.has(row.url)) prs.set(row.url, { url: row.url, kind: 'published', job: row.job });
  if (prs.size === 0) {
    lines.push('PR evidence: none recorded in the window.');
  } else {
    lines.push(`PR evidence (${prs.size}, bounded at ${REPORT_MAX_ITEMS} per kind):`);
    for (const pr of [...prs.values()].slice(0, REPORT_MAX_ITEMS)) {
      lines.push(`- ${pr.url} — ${pr.kind} · ${pr.job}`);
    }
  }
  return lines.join('\n');
}
