import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localTimestamp } from '../core/fleet/runs-parked-queue.js';

const usage = `Usage: phm fleet idle-slots [--hours N] [--json]
Per lane, over the last N hours (default 2) of dispatchd.log ticks: average running,
target from queue/slots.json, and idle slot-hours (target minus running, summed over tick gaps).
Gaps over 15 minutes are skipped as dispatcher downtime. ASHLR_RUNS_DIR overrides the root.`;
const MAX_GAP_MS = 15 * 60_000;

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
  lanes: FleetIdleSlotsLane[];
  totalIdleSlotHours: number | null;
}
export interface FleetIdleSlotsOptions {
  runsDir?: string;
  hours?: number;
  now?: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

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
  let log: string;
  try { log = await readFile(join(root, 'dispatchd.log'), 'utf8'); } catch { return null; }
  let targets = new Map<string, number>();
  try { targets = parseTargets(JSON.parse(await readFile(join(root, 'queue', 'slots.json'), 'utf8'))); } catch { /* targets unknown */ }

  const ticks: { ms: number; run: Record<string, number> }[] = [];
  for (const line of log.split(/\r?\n/)) {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) tick run=(\{.*?\}) q=\d+ launched=\d+/.exec(line);
    if (!m) continue;
    const ms = localTimestamp(m[1]!).ms;
    if (!Number.isFinite(ms) || ms < since || ms > now) continue;
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
  return { schema: 'fleet.idle-slots.v1', hours, windowStart: new Date(since).toISOString(), windowEnd: new Date(now).toISOString(),
    ticks: ticks.length, skippedGaps, lanes,
    totalIdleSlotHours: known.length ? round(known.reduce((s, l) => s + l.idleSlotHours!, 0)) : null };
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
  console.log([`Idle slots over the last ${hours} hours (${report.ticks} ticks):`,
    ...report.lanes.map(l => `${l.lane}: average running ${cell(l.averageRunning)}, target ${cell(l.target)}, idle ${cell(l.idleSlotHours)} slot-hours`),
    `Total idle: ${cell(report.totalIdleSlotHours)} slot-hours`].join('\n'));
  return 0;
}
