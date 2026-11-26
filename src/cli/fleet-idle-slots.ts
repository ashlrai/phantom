import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localTimestamp } from '../core/fleet/runs-parked-queue.js';

const usage = `Usage: phm fleet idle-slots [--hours N] [--json]
Per lane, over the last N hours (default 2) of dispatchd.log ticks: average running,
target from queue/slots.json, and idle slot-hours (target minus running, summed over tick gaps).
Gaps over 15 minutes are skipped as dispatcher downtime. dispatchd.log is read as a bounded
tail sized to the window; --json reports logTruncated/windowTruncated/coveredFrom when the
tail cannot reach the window start. ASHLR_RUNS_DIR overrides the root.`;
const MAX_GAP_MS = 15 * 60_000;

/**
 * dispatchd.log is append-only and never rotated, so an unbounded read grows with uptime.
 * The tail is sized to the window — a tick line is a few hundred bytes and 512 KiB/hour
 * leaves an order of magnitude of headroom for event lines — clamped so --hours cannot
 * force a multi-hundred-megabyte read. When the cap cuts into the window the report says
 * so (logTruncated/windowTruncated) instead of silently shortening it.
 */
export const IDLE_SLOTS_LOG_TAIL_MIN_BYTES = 4 * 1024 * 1024;
export const IDLE_SLOTS_LOG_TAIL_MAX_BYTES = 64 * 1024 * 1024;
export const IDLE_SLOTS_LOG_TAIL_BYTES_PER_HOUR = 512 * 1024;

export interface FleetIdleSlotsLane {
  lane: string;
  averageRunning: number | null;
  target: number | null;
  idleSlotHours: number | null;
}
export interface FleetIdleSlots {
  schema: 'fleet.idle-slots.v1';
  hours: number;
  windowStart: string;
  windowEnd: string;
  ticks: number;
  skippedGaps: number;
  /** True when dispatchd.log exceeded the bounded tail read; older ticks were not read. */
  logTruncated: boolean;
  /** True when the retained tail cannot prove tick coverage back to windowStart. */
  windowTruncated: boolean;
  /** Earliest tick line retained in dispatchd.log (ISO), or null when none was read; may precede windowStart. */
  coveredFrom: string | null;
  lanes: FleetIdleSlotsLane[];
  totalIdleSlotHours: number | null;
}
export interface FleetIdleSlotsOptions {
  runsDir?: string;
  hours?: number;
  now?: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Bounded tail of a regular file (no symlink follow); null when absent or unreadable. */
async function readLogTail(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean } | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile()) return null;
    const length = Math.min(info.size, maxBytes);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await file.read(bytes, 0, length, info.size - length);
    let text = bytes.subarray(0, bytesRead).toString('utf8');
    if (info.size > maxBytes) text = text.slice(text.indexOf('\n') + 1);
    return { text, truncated: info.size > maxBytes };
  } catch { return null; } finally { await file?.close(); }
}

function parseTargets(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const map = (raw as { lanes?: unknown }).lanes && typeof (raw as { lanes?: unknown }).lanes === 'object'
    ? (raw as { lanes: Record<string, unknown> }).lanes : raw as Record<string, unknown>;
  for (const [lane, row] of Object.entries(map)) {
    const target = row && typeof row === 'object' ? (row as { target?: unknown }).target : undefined;
    if (typeof target === 'number' && Number.isFinite(target) && target >= 0) out.set(lane, target);
  }
  return out;
}

/** Read-only: never writes files. Returns null when dispatchd.log is unreadable. */
export async function readFleetIdleSlots(opts: FleetIdleSlotsOptions = {}): Promise<FleetIdleSlots | null> {
  const root = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const hours = opts.hours ?? 2;
  const now = opts.now ?? Date.now();
  const since = now - hours * 3_600_000;
  const tailBytes = Math.min(IDLE_SLOTS_LOG_TAIL_MAX_BYTES,
    Math.max(IDLE_SLOTS_LOG_TAIL_MIN_BYTES, Math.ceil(hours * IDLE_SLOTS_LOG_TAIL_BYTES_PER_HOUR)));
  const log = await readLogTail(join(root, 'dispatchd.log'), tailBytes);
  if (!log) return null;
  let targets = new Map<string, number>();
  try { targets = parseTargets(JSON.parse(await readFile(join(root, 'queue', 'slots.json'), 'utf8'))); } catch { /* targets unknown */ }

  const ticks: { ms: number; run: Record<string, number> }[] = [];
  let earliestTickMs: number | null = null;
  for (const line of log.text.split(/\r?\n/)) {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) tick run=(\{.*?\}) q=\d+ launched=\d+/.exec(line);
    if (!m) continue;
    const ms = localTimestamp(m[1]!).ms;
    if (!Number.isFinite(ms)) continue;
    if (earliestTickMs === null || ms < earliestTickMs) earliestTickMs = ms;
    if (ms < since || ms > now) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(m[2]!); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const run: Record<string, number> = {};
    for (const [lane, n] of Object.entries(parsed)) if (typeof n === 'number' && Number.isFinite(n) && n >= 0) run[lane] = n;
    ticks.push({ ms, run });
  }
  ticks.sort((a, b) => a.ms - b.ms);

  const names = new Set([...targets.keys(), ...ticks.flatMap(t => Object.keys(t.run))]);
  const acc = new Map<string, { runMs: number; idleMs: number; ms: number }>();
  let skippedGaps = 0;
  for (let i = 0; i + 1 < ticks.length; i++) {
    const gap = ticks[i + 1]!.ms - ticks[i]!.ms;
    if (gap <= 0) continue;
    if (gap > MAX_GAP_MS) { skippedGaps++; continue; }
    for (const lane of names) {
      const running = ticks[i]!.run[lane] ?? 0;
      const a = acc.get(lane) ?? { runMs: 0, idleMs: 0, ms: 0 };
      a.runMs += running * gap; a.ms += gap;
      a.idleMs += Math.max(0, (targets.get(lane) ?? 0) - running) * gap;
      acc.set(lane, a);
    }
  }
  const lanes = [...names].sort().map((lane): FleetIdleSlotsLane => {
    const a = acc.get(lane);
    const target = targets.get(lane) ?? null;
    return { lane, target, averageRunning: a ? round(a.runMs / a.ms) : null,
      idleSlotHours: a && target !== null ? round(a.idleMs / 3_600_000) : null };
  });
  const known = lanes.filter(l => l.idleSlotHours !== null);
  const logTruncated = log.truncated;
  const windowTruncated = logTruncated && !(earliestTickMs !== null && earliestTickMs <= since);
  return { schema: 'fleet.idle-slots.v1', hours, windowStart: new Date(since).toISOString(), windowEnd: new Date(now).toISOString(),
    ticks: ticks.length, skippedGaps, logTruncated, windowTruncated,
    coveredFrom: earliestTickMs === null ? null : new Date(earliestTickMs).toISOString(),
    lanes, totalIdleSlotHours: known.length ? round(known.reduce((s, l) => s + l.idleSlotHours!, 0)) : null };
}

export async function cmdFleetIdleSlots(args: string[], opts: FleetIdleSlotsOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let hours = 2, json = false, seenHours = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !seenHours && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(args[i + 1] ?? '') && Number(args[i + 1]) > 0) {
      hours = Number(args[++i]); seenHours = true;
    } else { console.error(usage); return 2; }
  }
  const report = await readFleetIdleSlots({ ...opts, hours });
  if (!report) { console.error('Unable to read dispatchd.log.'); return 1; }
  if (json) { console.log(JSON.stringify(report)); return 0; }
  const cell = (n: number | null) => n === null ? 'unknown' : String(n);
  const note = report.windowTruncated
    ? report.coveredFrom === null
      ? 'Note: dispatchd.log exceeded the read cap and the retained tail has no tick lines; coverage is unknown.'
      : `Note: dispatchd.log exceeded the read cap; tick coverage starts at ${report.coveredFrom}, inside the ${hours} hour window.`
    : null;
  console.log([`Idle slots over the last ${hours} hours (${report.ticks} ticks):`,
    ...report.lanes.map(l => `${l.lane}: average running ${cell(l.averageRunning)}, target ${cell(l.target)}, idle ${cell(l.idleSlotHours)} slot-hours`),
    `Total idle: ${cell(report.totalIdleSlotHours)} slot-hours`,
    ...(note ? [note] : [])].join('\n'));
  return 0;
}
