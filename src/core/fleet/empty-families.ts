import { open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ledgerFinishes } from './empties.js';
import { jobFamily } from './slot-yield.js';
import { diagnoseEmptyJob, FLEET_EMPTY_WHY_LOG_LINES } from './empty-why-classify.js';
import type { EmptyJobsReader } from './empty-jobs.js';

export const EMPTY_FAMILIES_SCHEMA = 'jobs.empty.by-family.v1';
export const EMPTY_FAMILY_ACTIONS = ['stop', 'recut', 'reroute', 'keep'] as const;
export type EmptyFamilyAction = typeof EMPTY_FAMILY_ACTIONS[number];
/** Lane problems (sign-in, missing tool) come first: they fail whatever the family asks for. */
export type EmptyFamilyReason = 'auth_failed' | 'no_gh' | 'tool_missing' | string;

export interface EmptyFamilyRow {
  family: string; lane: string; launches: number; empty: number; empty_rate: number;
  top_reasons: Array<{ reason: string; count: number }>; action: EmptyFamilyAction;
}
export interface EmptyFamiliesReport { schema: typeof EMPTY_FAMILIES_SCHEMA; hours: number; total_empty: number; families: EmptyFamilyRow[] }

/** Stop a family once this share of at least STOP_MIN_LAUNCHES launches came back empty. */
export const STOP_RATE = 0.8;
export const STOP_MIN_LAUNCHES = 5;
/** Below this empty rate a family is healthy enough to keep. */
export const RECUT_RATE = 0.5;
const LANE_GAPS = new Set(['auth_failed', 'no_gh', 'tool_missing']);

// Checked in this order on the log tail: the first match names the lane gap.
const GAP_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['auth_failed', /\bauth(?:entication|orization)?[ _-]?failed\b|\bnot (?:logged|signed) in\b|\b(?:please |must )?(?:log|sign)[ -]?in (?:again|required|first)\b|\b(?:HTTP|status(?: code)?) 40[13]\b|invalid (?:api )?credentials|\bunauthorized\b/i],
  ['no_gh', /\bno gh\b|\bgh: command not found\b|\bgh(?: cli)? (?:is )?(?:missing|not installed|unavailable)\b/i],
  ['tool_missing', /command not found|\bspawn \S+ ENOENT\b|(?:tool|binary|executable|dependency)[^\n]{0,30}(?:missing|not found|unavailable)/i],
];

/** Pure: name why one empty job stopped. A gap in the lane wins; otherwise the shared diagnosis; otherwise `unknown`. */
export function emptyFamilyReason(log: string | null, publish: string | null): string {
  const text = [publish, log].map(part => (part ?? '').split(/\r?\n/).slice(-FLEET_EMPTY_WHY_LOG_LINES).join('\n')).join('\n');
  const gap = GAP_RULES.find(([, pattern]) => pattern.test(text))?.[0];
  return gap ?? diagnoseEmptyJob(log, publish);
}

export function emptyFamilyAction(row: Pick<EmptyFamilyRow, 'launches' | 'empty' | 'empty_rate' | 'top_reasons'>): EmptyFamilyAction {
  if (row.empty === 0) return 'keep';
  const gaps = row.top_reasons.filter(r => LANE_GAPS.has(r.reason)).reduce((sum, r) => sum + r.count, 0);
  if (gaps * 2 >= row.empty) return 'reroute';
  if (row.launches >= STOP_MIN_LAUNCHES && row.empty_rate >= STOP_RATE) return 'stop';
  return row.empty_rate >= RECUT_RATE ? 'recut' : 'keep';
}

const rank: Record<EmptyFamilyAction, number> = { stop: 0, reroute: 1, recut: 2, keep: 3 };

/** Pure: group launches by family and lane. Worst first: action, then empty rate, then size. */
export function summarizeEmptyFamilies(launches: ReadonlyArray<{ id: string; lane: string; empty: boolean; reason?: string }>, hours: number): EmptyFamiliesReport {
  const groups = new Map<string, typeof launches[number][]>();
  for (const job of launches) {
    const key = `${jobFamily(job.id)}\n${job.lane}`;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  const families = [...groups].map(([key, members]): EmptyFamilyRow => {
    const [family, lane] = key.split('\n') as [string, string];
    const empties = members.filter(job => job.empty);
    const counts = new Map<string, number>();
    for (const job of empties) counts.set(job.reason ?? 'unknown', (counts.get(job.reason ?? 'unknown') ?? 0) + 1);
    const top_reasons = [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 3);
    const empty_rate = Math.round(empties.length / members.length * 100) / 100;
    const row = { family, lane, launches: members.length, empty: empties.length, empty_rate, top_reasons };
    return { ...row, action: emptyFamilyAction(row) };
  }).filter(row => row.empty > 0)
    .sort((a, b) => rank[a.action] - rank[b.action] || b.empty_rate - a.empty_rate || b.empty - a.empty || a.family.localeCompare(b.family) || a.lane.localeCompare(b.lane));
  return { schema: EMPTY_FAMILIES_SCHEMA, hours, total_empty: families.reduce((n, r) => n + r.empty, 0), families };
}

export async function tail(path: string, size: number): Promise<string | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, size);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return null; } finally { await file?.close(); }
}

/** Read the jobs ledger and, for each empty job, its log tail. Null when the ledger is unreadable. */
export async function readEmptyFamilies(hours = 24, root = process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs'), now = Date.now(), options: { read?: EmptyJobsReader } = {}): Promise<EmptyFamiliesReport | null> {
  const reader: EmptyJobsReader = options.read ?? ((path, max) => max ? tail(path, max) : readFile(path, 'utf8'));
  const read: EmptyJobsReader = (path, max) => reader(path, max).catch(() => null);
  const ledger = await read(join(root, 'metrics/jobs.jsonl'));
  if (ledger === null) return null;
  const finishes = ledgerFinishes(ledger, now, hours).finishes;
  const launches: Array<{ id: string; lane: string; empty: boolean; reason?: string }> = [];
  for (let offset = 0; offset < finishes.length; offset += 16) {
    launches.push(...await Promise.all(finishes.slice(offset, offset + 16).map(async job => {
      if (!job.empty) return { id: job.id, lane: job.lane, empty: false };
      const [log, publish] = await Promise.all([read(join(root, `${job.id}.log`), 65536), read(join(root, `${job.id}.publish`), 65536)]);
      return { id: job.id, lane: job.lane, empty: true, reason: emptyFamilyReason(log, publish) };
    })));
  }
  return summarizeEmptyFamilies(launches, hours);
}

/** One plain line per family, worst first. */
export function formatEmptyFamilies(report: EmptyFamiliesReport): string[] {
  if (report.total_empty === 0) return ['No empty jobs.'];
  return report.families.map(r => `${r.action.toUpperCase()} ${r.family} (${r.lane}): ${r.empty} of ${r.launches} empty (${Math.round(r.empty_rate * 100)}%); ${r.top_reasons.map(t => `${t.reason} ${t.count}`).join(', ')}`);
}
