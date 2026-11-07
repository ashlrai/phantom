/** Read-only correlation of recorded drop rows and sticky reinjections. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localTimestamp } from '../core/fleet/runs-parked-queue.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = `Usage: ashlr fleet sticky-loop [--hours N] [--json]
List sticky reinjections after recorded drop rows (default: 2 hours).
Times are local. Same-second events count as after; drop rows may be dry runs.`;
interface Drop { ms: number; time: string; reason: string }
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
// eslint-disable-next-line no-control-regex -- drop reasons must not carry control bytes.
const CONTROL_BYTES = /[\x00-\x1f\x7f]/;
export interface StickyLoopEntry { id: string; reinjectCount: number; lastDropTime: string; lastDropReason: string; inStickyFront: boolean }

export function correlateStickyLoop(events: string, drops: string, sticky: string, now: number, hours: number): StickyLoopEntry[] {
  const byId = new Map<string, Drop[]>();
  for (const line of drops.split(/\r?\n/)) {
    const [time, id, action, reason, ...extra] = line.split('\t');
    if (!time || !id || !idPattern.test(id) || action !== 'drop' || !reason || extra.length || reason.length > 400 || CONTROL_BYTES.test(reason)) continue;
    const ms = localTimestamp(time).ms;
    if (!Number.isFinite(ms) || ms > now) continue;
    const rows = byId.get(id) ?? [];
    rows.push({ ms, time, reason: scrubSecrets(reason) });
    byId.set(id, rows);
  }
  const front = new Set(sticky.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')));
  const result = new Map<string, StickyLoopEntry & { dropMs: number }>();
  for (const line of events.split(/\r?\n/)) {
    const match = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) READY_STICKY reinject ([A-Za-z0-9][A-Za-z0-9._-]{0,79})$/.exec(line);
    if (!match) continue;
    const ms = localTimestamp(match[1]!).ms;
    if (!Number.isFinite(ms) || ms < now - hours * 3_600_000 || ms > now) continue;
    const id = match[2]!;
    const drop = (byId.get(id) ?? []).reduce<Drop | undefined>(
      (best, row) => row.ms <= ms && (!best || row.ms >= best.ms) ? row : best, undefined);
    if (!drop) continue;
    const entry = result.get(id);
    if (entry) {
      entry.reinjectCount++;
      if (drop.ms >= entry.dropMs) { entry.dropMs = drop.ms; entry.lastDropTime = drop.time; entry.lastDropReason = drop.reason; }
    } else result.set(id, { id, reinjectCount: 1, lastDropTime: drop.time, lastDropReason: drop.reason, inStickyFront: front.has(id), dropMs: drop.ms });
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id)).map(({ dropMs: _dropMs, ...entry }) => entry);
}

export async function cmdFleetStickyLoop(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let hours = 2, json = false, seenHours = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !seenHours && /^(?:\d+\.?\d*|\.\d+)$/.test(args[i + 1] ?? '')) { hours = Number(args[++i]); seenHours = true; }
    else { console.error(usage); return 2; }
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 87600) { console.error(usage); return 2; }
  const root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  try {
    const [events, drops, sticky] = await Promise.all([readFile(join(root, 'dispatch-events.log'), 'utf8'), readFile(join(root, 'queue/skipped-empty.tsv'), 'utf8'), readFile(join(root, 'queue/STICKY_FRONT'), 'utf8')]);
    const entries = correlateStickyLoop(events, drops, sticky, Date.now(), hours);
    console.log(json ? JSON.stringify({ schema: 'fleet.sticky-loop.v1', hours, entries }) : [
      `Sticky reinjections after recorded drops in the last ${hours} hours: ${entries.length}`,
      'Drop rows may be dry runs; same-second events are included.',
      ...entries.map(e => `${e.id}: ${e.reinjectCount} reinjections; last drop ${e.lastDropTime} (${e.lastDropReason}); sticky front: ${e.inStickyFront ? 'yes' : 'no'}`),
    ].join('\n'));
    return 0;
  } catch { console.error('fleet sticky-loop: evidence unavailable'); return 1; }
}
