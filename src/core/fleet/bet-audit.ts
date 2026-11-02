/**
 * Read-only audit of leader BET/FIXUP orders against queue and metrics
 * evidence. Detects orders the leader issued that never became work: the
 * events log counted them as written, but nothing noticed they vanished.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDropJobRoot } from './drop-job-writer.js';
import { readSource } from './runs-parked-queue.js';

export type BetAuditStatus = 'lost' | 'queued' | 'claimed' | 'launched' | 'published' | 'merged';
export interface BetAuditRow {
  id: string;
  repo: string;
  lane: string | null;
  issuedAt: string;
  status: BetAuditStatus;
  url: string | null;
}
export interface BetAuditOutputFile { name: string; text: string }
export interface BetAuditInput {
  /** supervisor/out.<YYYYMMDDTHHMM>.txt file names with their contents. */
  outputs: readonly BetAuditOutputFile[];
  /** queue/router-queue.md contents, null when absent or unreadable. */
  queue: string | null;
  /** metrics/jobs.jsonl contents, null when absent or unreadable. */
  metrics: string | null;
  /** Audit window in hours, measured by out-file name timestamp. Default 24. */
  hours?: number;
  /** Observation time in epoch ms. Default Date.now(). */
  now?: number;
}
export interface BetAuditOptions { hours?: number; now?: () => number }
export interface BetAuditReport {
  schema: 'fleet.bet-audit.v1';
  generatedAt: string;
  hours: number;
  sources: Record<'supervisor' | 'queue' | 'metrics', 'healthy' | 'missing' | 'degraded'>;
  rows: BetAuditRow[];
  summary: Record<BetAuditStatus, number> & { issued: number };
}

export const BET_AUDIT_STATUSES: readonly BetAuditStatus[] =
  ['lost', 'queued', 'claimed', 'launched', 'published', 'merged'];
export const BET_AUDIT_DEFAULT_HOURS = 24;
const HOUR_MS = 3_600_000;
const MAX_OUT_FILE = 256 * 1024;
const MAX_QUEUE = 2 * 1024 * 1024;
const MAX_METRICS = 8 * 1024 * 1024;

/** `out.<YYYYMMDDTHHMM>.txt` name timestamp in UTC ms; null for other names. */
export function betAuditOutStamp(name: string): number | null {
  const match = /^out\.(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})\.txt$/.exec(name);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  const d = new Date(ms);
  return d.getUTCFullYear() === Number(match[1]) && d.getUTCMonth() === Number(match[2]) - 1 &&
    d.getUTCDate() === Number(match[3]) && d.getUTCHours() === Number(match[4]) &&
    d.getUTCMinutes() === Number(match[5]) ? ms : null;
}

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const BET_LINE = /^BET\s+(\S+)\s+(\S+)\s+(\S+)\s+([A-Za-z0-9_-]+)\s+\S/;
const FIXUP_LINE = /^FIXUP\s+(\S+)\s+([A-Za-z0-9_-]+)\s+\S/;
const QUEUE_LINE = /^- (READY|CLAIMED)\b/;
// Whole-token matching: RQ-XQ8-RETRY must not stand as evidence for RQ-XQ8.
const JOB_TOKEN = /\bRQ-[A-Za-z0-9][A-Za-z0-9_-]*\b/g;
const RANK: Record<BetAuditStatus, number> =
  { lost: 0, queued: 1, claimed: 2, launched: 3, published: 4, merged: 5 };

function metricsEvidence(line: string): { id: string; status: BetAuditStatus; url: string | null } | null {
  let row: Record<string, unknown>;
  try { row = object(JSON.parse(line)); } catch { return null; }
  const id = row.job ?? row.job_id ?? row.id;
  if (typeof id !== 'string' || !id.startsWith('RQ-')) return null;
  const event = String(row.event ?? '');
  const url = typeof row.url === 'string' ? row.url
    : typeof row.pr_url === 'string' ? row.pr_url : null;
  const merged = /merged/i.test(String(row.state ?? '')) || /merged/i.test(String(row.outcome ?? ''))
    || typeof row.merged_at === 'string';
  const status: BetAuditStatus = merged ? 'merged'
    : event === 'publish' || event === 'outcome' || (event === 'finish' && url !== null) ? 'published'
    : 'launched';
  return { id, status, url };
}

export function auditBets(input: BetAuditInput): BetAuditRow[] {
  const now = input.now ?? Date.now();
  const hours = input.hours ?? BET_AUDIT_DEFAULT_HOURS;
  if (!Number.isFinite(now) || !Number.isFinite(hours) || hours <= 0) throw new Error('Invalid audit window');

  // Issued orders: first (earliest) issuedAt wins when an id repeats.
  const issued = new Map<string, BetAuditRow>();
  for (const output of [...input.outputs].sort((a, b) => a.name.localeCompare(b.name))) {
    const stamp = betAuditOutStamp(output.name);
    if (stamp === null || stamp > now || stamp < now - hours * HOUR_MS) continue;
    const issuedAt = new Date(stamp).toISOString();
    for (const line of output.text.split(/\r?\n/)) {
      const bet = BET_LINE.exec(line);
      const fix = bet ? null : FIXUP_LINE.exec(line);
      if (!bet && !fix) continue;
      const id = bet ? `RQ-${bet[4]}Q8` : `RQ-FIXUP-${fix![2]}Q8`;
      const existing = issued.get(id);
      if (existing && existing.issuedAt <= issuedAt) continue;
      issued.set(id, { id, repo: (bet ?? fix)![1]!, lane: bet ? bet[2]! : null, issuedAt, status: 'lost', url: null });
    }
  }

  // Queue evidence: only lines beginning "- READY"/"- CLAIMED" count.
  const queueStatus = new Map<string, BetAuditStatus>();
  for (const line of (input.queue ?? '').split(/\r?\n/)) {
    const mark = QUEUE_LINE.exec(line)?.[1];
    if (!mark) continue;
    const status: BetAuditStatus = mark === 'CLAIMED' ? 'claimed' : 'queued';
    for (const token of line.match(JOB_TOKEN) ?? []) {
      if (issued.has(token) && RANK[status] > RANK[queueStatus.get(token) ?? 'lost']) queueStatus.set(token, status);
    }
  }

  // Metrics evidence: any parseable row for the job means it was consumed —
  // never lost. Launch/finish rows floor at launched; publish/outcome rows at
  // published; any merged observation promotes to merged.
  const metric = new Map<string, { status: BetAuditStatus; url: string | null }>();
  for (const line of (input.metrics ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const evidence = metricsEvidence(line);
    if (!evidence || !issued.has(evidence.id)) continue;
    const prev = metric.get(evidence.id);
    const status = prev && RANK[prev.status] >= RANK[evidence.status] ? prev.status : evidence.status;
    metric.set(evidence.id, { status, url: evidence.url ?? prev?.url ?? null });
  }

  const rows: BetAuditRow[] = [];
  for (const row of issued.values()) {
    const evidence = metric.get(row.id);
    if (evidence) { row.status = evidence.status; row.url = evidence.url; }
    else row.status = queueStatus.get(row.id) ?? 'lost';
    rows.push(row);
  }
  return rows.sort((a, b) => a.issuedAt.localeCompare(b.issuedAt) || a.id.localeCompare(b.id));
}

/** Reads the three inputs under runsDir; every source fails independently. */
export async function readBetAudit(runsDir?: string, opts: BetAuditOptions = {}): Promise<BetAuditReport> {
  const root = resolveDropJobRoot(runsDir);
  const now = (opts.now ?? Date.now)();
  const hours = opts.hours ?? BET_AUDIT_DEFAULT_HOURS;
  const sources: BetAuditReport['sources'] = { supervisor: 'missing', queue: 'missing', metrics: 'missing' };
  const outputs: BetAuditOutputFile[] = [];
  let degradedSupervisor = false;
  let names: string[] = [];
  try { names = await readdir(join(root, 'supervisor')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') degradedSupervisor = true; }
  if (names.length) sources.supervisor = 'healthy';
  for (const name of names) {
    if (!/^out\..+\.txt$/.test(name)) continue;
    const source = await readSource(join(root, 'supervisor', name), MAX_OUT_FILE, false);
    if (source.state === 'healthy') outputs.push({ name, text: source.text });
    else if (source.state === 'degraded') degradedSupervisor = true;
  }
  if (degradedSupervisor) sources.supervisor = 'degraded';
  const [queue, metrics] = await Promise.all([
    readSource(join(root, 'queue', 'router-queue.md'), MAX_QUEUE, false),
    readSource(join(root, 'metrics', 'jobs.jsonl'), MAX_METRICS, true),
  ]);
  sources.queue = queue.state;
  sources.metrics = metrics.state;
  const rows = auditBets({
    outputs,
    queue: queue.state === 'healthy' ? queue.text : null,
    metrics: metrics.state === 'healthy' ? metrics.text : null,
    hours, now,
  });
  const summary = { issued: rows.length } as BetAuditReport['summary'];
  for (const status of BET_AUDIT_STATUSES) summary[status] = 0;
  for (const row of rows) summary[row.status] += 1;
  return { schema: 'fleet.bet-audit.v1', generatedAt: new Date(now).toISOString(), hours, sources, rows, summary };
}
