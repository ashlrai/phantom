import { appendFileSync, chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readHostLoadReport, type HostLoadDeps, type HostLoadReport } from './host-load.js';
import { parseAdmissionCtl } from './load-owners.js';
import { readStableRegularFile } from '../util/stable-file-read.js';

/**
 * Why launches were blocked, kept after the moment has passed. When the dispatcher says "over_host" the self-tick takes one
 * host-load attribution snapshot (at most one per 10 minutes) and appends it here; `phm host load --history`, the pulse and
 * the digest read it back. Read-only toward processes: it only reads ps, never stops, pauses or renices anything.
 */
export const LOAD_HISTORY_SCHEMA = 'host.load.history.v1';
/** Beside queue/admission-ctl.json and the other fleet writers' files in the runs dir. */
export const LOAD_HISTORY_FILE = join('queue', 'host-load-history.jsonl');
export const SNAPSHOT_MIN_GAP_MS = 10 * 60_000;
export const HISTORY_KEEP_MS = 7 * 86_400_000;
export const HISTORY_MAX_ROWS = 2_000;
/** Blocked time in the last hour that is worth saying out loud in the digest and the pulse. */
export const BLOCKED_LINE_OVER_MINUTES = 10;
const HOUR = 3_600_000;
const SHARE_ROWS = 5;

export interface LoadContributor { name: string; sharePercent: number }
/** One snapshot taken while launches were blocked. */
export interface LoadSnapshotRow {
  at: number;
  load1: number | null;
  /** The dispatcher's host limit as it reported it; null when it did not say. */
  hostMax: number | null;
  /** Busiest first; whole points of CPU use. Empty when the process list could not be read. */
  contributors: LoadContributor[];
}

const plainLabel = (text: string): string => text.replace(/[^\w .()+-]/g, '').trim().slice(0, 40) || 'unnamed';

/** Pure: who is using the CPU, in plain labels. Fleet jobs and the model server are one entry each; apps are named. */
export function contributorsOf(report: HostLoadReport): LoadContributor[] {
  const cpu = new Map<string, number>();
  const add = (name: string, value: number) => cpu.set(name, (cpu.get(name) ?? 0) + value);
  for (const group of report.groups) {
    if (group.id === 'fleet-workers') add('fleet jobs', group.cpuPercent);
    else if (group.id === 'local-models') add('local model server', group.cpuPercent);
    else {
      let counted = 0;
      for (const item of group.items) { add(plainLabel(item.name), item.cpuPercent); counted += item.cpuPercent; }
      add(group.id === 'desktop-apps' ? 'other apps' : group.id === 'system' ? 'system' : 'other', Math.max(0, group.cpuPercent - counted));
    }
  }
  const total = [...cpu.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0) return [];
  return [...cpu].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, SHARE_ROWS)
    .map(([name, value]) => ({ name, sharePercent: Math.round((100 * value) / total) }));
}

/** The limit the dispatcher gave in its own words ("over_host load1=75 host_max=36 owned=0.0"). */
export function parseBlock(why: string | null, load1: number | null): { blocked: boolean; hostMax: number | null; load1: number | null } {
  const max = /\bhost_max=(\d+(?:\.\d+)?)/.exec(why ?? '');
  const seen = /\bload1=(\d+(?:\.\d+)?)/.exec(why ?? '');
  const hostMax = max ? Number(max[1]) : null;
  const load = load1 ?? (seen ? Number(seen[1]) : null);
  return { blocked: /\bover_host\b/.test(why ?? '') || (hostMax !== null && load !== null && load > hostMax), hostMax, load1: load };
}

const validRow = (value: unknown): value is LoadSnapshotRow => {
  const row = value as Partial<LoadSnapshotRow> | null;
  return !!row && typeof row === 'object' && Number.isFinite(row.at) && Array.isArray(row.contributors) &&
    (row.load1 === null || Number.isFinite(row.load1)) && (row.hostMax === null || Number.isFinite(row.hostMax)) &&
    row.contributors.every(c => c && typeof c.name === 'string' && Number.isFinite(c.sharePercent));
};

/** Pure: the rows of a history file, oldest first; damaged lines are skipped. */
export function parseHistory(text: string | null): LoadSnapshotRow[] {
  const rows: LoadSnapshotRow[] = [];
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try { const row: unknown = JSON.parse(line); if (validRow(row)) rows.push(row); } catch { /* A damaged line is skipped. */ }
  }
  return rows.sort((a, b) => a.at - b.at);
}

/** Pure: the rows that survive the 7-day and 2,000-row limits. */
export const trimHistory = (rows: readonly LoadSnapshotRow[], now: number): LoadSnapshotRow[] =>
  rows.filter(row => row.at > now - HISTORY_KEEP_MS && row.at <= now + 60_000).slice(-HISTORY_MAX_ROWS);

export function readLoadHistory(runsDir: string): LoadSnapshotRow[] {
  const file = readStableRegularFile(join(runsDir, LOAD_HISTORY_FILE), { anchorPath: runsDir, maxFileBytes: 4 * 1024 * 1024, remainingBytes: 4 * 1024 * 1024 });
  return parseHistory(file.ok ? file.text : null);
}

export type SnapshotOutcome =
  | { state: 'taken'; row: LoadSnapshotRow }
  | { state: 'not-blocked' | 'too-soon' | 'unknown' };

export interface SnapshotDeps extends HostLoadDeps {
  now?: () => number;
  /** The dispatcher's admission-ctl.json text; null when absent. Tests inject it. */
  admission?: (runsDir: string) => string | null;
}

const readAdmissionText = (runsDir: string): string | null => {
  const file = readStableRegularFile(join(runsDir, 'queue', 'admission-ctl.json'), { anchorPath: runsDir, maxFileBytes: 64 * 1024, remainingBytes: 64 * 1024 });
  return file.ok ? file.text : null;
};

function writeRows(path: string, rows: readonly LoadSnapshotRow[]): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/**
 * The self-tick's one call. When the dispatcher is blocking launches for host load and the last snapshot is over 10
 * minutes old, reads the process list once and appends one row. The cheap checks come first, so an open dispatcher never runs ps.
 * Never throws; a failure is "unknown" and changes nothing.
 */
export async function takeLoadSnapshot(runsDir: string, deps: SnapshotDeps = {}): Promise<SnapshotOutcome> {
  try {
    const now = (deps.now ?? Date.now)();
    const admission = parseAdmissionCtl((deps.admission ?? readAdmissionText)(runsDir));
    if (admission.state === 'unknown') return { state: 'unknown' };
    const block = parseBlock(admission.why, admission.load1);
    if (!block.blocked) return { state: 'not-blocked' };
    const rows = readLoadHistory(runsDir);
    const last = rows.at(-1);
    if (last && now - last.at >= 0 && now - last.at < SNAPSHOT_MIN_GAP_MS) return { state: 'too-soon' };
    const report = await readHostLoadReport({ ...deps, now: () => now });
    const row: LoadSnapshotRow = { at: now, load1: block.load1 ?? report.load1, hostMax: block.hostMax, contributors: contributorsOf(report) };
    const path = join(runsDir, LOAD_HISTORY_FILE);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const kept = trimHistory([...rows, row], now);
    // Rewrite only when something aged out or the cap is hit; otherwise a plain append.
    if (kept.length === rows.length + 1) appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    else writeRows(path, kept);
    return { state: 'taken', row };
  } catch {
    return { state: 'unknown' };
  }
}

// ── The read side ──────────────────────────────────────────────────────────────────────────────────────────────

export interface HourRow {
  /** Start of the hour, ISO. */
  hour: string;
  snapshots: number;
  peakLoad1: number | null;
  /** Minutes launches were blocked, as far as snapshots show: each covers up to 10 minutes. */
  blockedMinutes: number;
  /** The three biggest contributors, by share of this hour's blocked time. */
  top: LoadContributor[];
}
export interface LoadHistoryReport {
  schema: typeof LOAD_HISTORY_SCHEMA; version: 1; generatedAt: string; sinceHours: number;
  /** known: at least one snapshot in the window. unknown: none, so nothing here is a measurement. */
  state: 'known' | 'unknown';
  snapshots: number;
  blockedMinutes: number | null;
  hours: HourRow[];
  /** The top three over the whole window, by share of blocked time. */
  top: LoadContributor[];
  /** One plain line, shared by the CLI, the pulse and the digest. */
  answer: string;
}

const minutes = (rows: readonly LoadSnapshotRow[], index: number, until: number): number =>
  Math.max(0, Math.min(SNAPSHOT_MIN_GAP_MS, (rows[index + 1]?.at ?? until) - rows[index]!.at)) / 60_000;

function topShares(rows: readonly LoadSnapshotRow[], weights: readonly number[]): LoadContributor[] {
  const sum = new Map<string, number>();
  let total = 0;
  rows.forEach((row, i) => {
    for (const c of row.contributors) sum.set(c.name, (sum.get(c.name) ?? 0) + c.sharePercent * weights[i]!);
    total += weights[i]! * 100;
  });
  if (total <= 0) return [];
  return [...sum].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([name, value]) => ({ name, sharePercent: Math.round((100 * value) / total) }));
}

export function answerLine(top: readonly LoadContributor[], windowWords: string): string {
  if (top.length === 0) return 'Unknown: no load snapshot has been taken yet, so what blocked launches is not known.';
  const [first, ...rest] = top;
  return `Most blocked time ${windowWords}: ${first!.name} (${first!.sharePercent}%)${rest.map((c, i) => `${i === 0 ? ', then ' : ', '}${c.name} (${c.sharePercent}%)`).join('')}.`;
}

/** Pure: hourly peak, blocked time and top three over the rows in the window. */
export function summarizeLoadHistory(allRows: readonly LoadSnapshotRow[], now: number, sinceHours = 6): LoadHistoryReport {
  const from = now - sinceHours * HOUR;
  const rows = allRows.filter(row => row.at >= from && row.at <= now);
  const mins = rows.map((_, i) => minutes(rows, i, now));
  const hours: HourRow[] = [];
  for (let start = Math.floor(from / HOUR) * HOUR; start <= now; start += HOUR) {
    const index = rows.flatMap((row, i) => (row.at >= start && row.at < start + HOUR ? [i] : []));
    if (!index.length) continue;
    const loads = index.map(i => rows[i]!.load1).filter((v): v is number => v !== null);
    hours.push({
      hour: new Date(start).toISOString(), snapshots: index.length, peakLoad1: loads.length ? Math.max(...loads) : null,
      blockedMinutes: Math.round(index.reduce((sum, i) => sum + mins[i]!, 0) * 10) / 10,
      top: topShares(index.map(i => rows[i]!), index.map(i => mins[i]!)),
    });
  }
  const top = topShares(rows, mins);
  const words = sinceHours === 24 ? 'today' : `in the last ${sinceHours === 1 ? 'hour' : `${Number.isInteger(sinceHours) ? sinceHours : sinceHours.toFixed(1)} hours`}`;
  return {
    schema: LOAD_HISTORY_SCHEMA, version: 1, generatedAt: new Date(now).toISOString(), sinceHours,
    state: rows.length ? 'known' : 'unknown', snapshots: rows.length,
    blockedMinutes: rows.length ? Math.round(mins.reduce((sum, v) => sum + v, 0) * 10) / 10 : null,
    hours, top, answer: answerLine(top, words),
  };
}

/** Human lines: one per hour, then the answer. */
export function formatLoadHistory(report: LoadHistoryReport): string {
  const lines = [report.answer];
  if (report.hours.length) lines.push('', 'Hour (UTC)         Peak load  Blocked  Top contributors');
  for (const h of report.hours) {
    lines.push(`${h.hour.slice(0, 16).replace('T', ' ')}  ${String(h.peakLoad1 ?? 'unknown').padStart(9)}  ${`${h.blockedMinutes} min`.padStart(7)}  ` +
      (h.top.map(c => `${c.name} ${c.sharePercent}%`).join(', ') || 'unknown'));
  }
  return lines.join('\n');
}

/**
 * The one line for the digest and the pulse: present only when launches were blocked for over 10 minutes in the last hour.
 * Null otherwise, including when no snapshot exists (nothing to say is not the same as nothing blocked, but a blocked hour
 * always leaves a snapshot once the self-tick runs).
 */
export function blockedHourLine(rows: readonly LoadSnapshotRow[], now: number): string | null {
  const hour = summarizeLoadHistory(rows, now, 1);
  return hour.state === 'known' && (hour.blockedMinutes ?? 0) > BLOCKED_LINE_OVER_MINUTES ? `Launches were blocked by machine load for ${Math.round(hour.blockedMinutes!)} minutes in the last hour. ${hour.answer}` : null;
}

/** Impure: reads the history; never throws. */
export function readBlockedHourLine(runsDir: string, now: number): string | null {
  try { return blockedHourLine(readLoadHistory(runsDir), now); } catch { return null; }
}
