/** Offline advisory only. Never changes a hold or grants dispatch authority. */
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LaneState {
  lane: string;
  target: number | null;
  running: number | null;
  queued: number | null;
  held: boolean | null;
  held_until?: string | null;
  held_reason?: string | null;
}
export interface MeterSample {
  provider: string;
  window: string;
  usedPercent: number | null;
  resetAt: string | null;
  sampledAt: string;
}
export interface LaneTruthReaders {
  lanes(): Promise<readonly LaneState[]>;
  meters(): Promise<readonly MeterSample[]>;
}
export type LaneVerdict = 'held_with_capacity' | 'reset_detected' | 'idle_with_work' | 'ok' | 'unknown';
/** Same conservative freshness boundary as routing headroom: fifteen minutes. */
export const LANE_TRUTH_MAX_AGE_MS = 15 * 60_000;
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const instant = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const fresh = (v: string, now: number): boolean => Number.isFinite(now) && Date.parse(v) <= now && now - Date.parse(v) <= LANE_TRUTH_MAX_AGE_MS;
const valid = (s: MeterSample): boolean => typeof s.usedPercent === 'number' && Number.isFinite(s.usedPercent) && s.usedPercent >= 0 && s.usedPercent <= 100 && !!s.window && instant(s.sampledAt) !== null && instant(s.resetAt) !== null;

export async function readLaneTruth(readers: LaneTruthReaders, now = Date.now()) {
  const [lanes, meters] = await Promise.all([readers.lanes(), readers.meters().catch(() => [] as MeterSample[])]);
  return { schema: 'fleet.lane-truth.v1', lanes: lanes.map(lane => {
    const groups = new Map<string, MeterSample[]>();
    for (const sample of meters.filter(s => s.provider === lane.lane)) {
      const group = groups.get(sample.window) ?? [];
      group.push(sample);
      groups.set(sample.window, group);
    }
    let verdict: LaneVerdict = 'unknown';
    const windows = [...groups.values()].map(samples => [...samples].sort((a, b) => Date.parse(b.sampledAt) - Date.parse(a.sampledAt)));
    const known = windows.length > 0 && windows.every(([s]) => s && valid(s) && fresh(s.sampledAt, now) && Date.parse(s.resetAt!) > now);
    if (known && typeof lane.held === 'boolean') {
      const reset = windows.some(samples => {
        const current = samples[0]!;
        const previous = samples.find(s => Date.parse(s.sampledAt) < Date.parse(current.sampledAt));
        return previous && valid(previous) && fresh(previous.sampledAt, now) &&
          (previous.usedPercent! - current.usedPercent! >= 20 || Date.parse(current.resetAt!) > Date.parse(previous.resetAt!));
      });
      // A contradictory hold is the actionable verdict even when a reset also occurred.
      if (lane.held && windows.every(samples => samples[0]!.usedPercent! < 95)) verdict = 'held_with_capacity';
      else if (reset) verdict = 'reset_detected';
      else if (count(lane.running) !== null && count(lane.queued) !== null && count(lane.target) !== null) {
        verdict = !lane.held && lane.running === 0 && lane.queued! > 0 ? 'idle_with_work' : 'ok';
      }
    }
    // Deliberately omit free-form hold reasons, transcripts and account metadata.
    return { lane: /^[a-z][a-z0-9-]{1,40}$/.test(lane.lane) ? lane.lane : 'unknown', target: count(lane.target), running: count(lane.running), queued: count(lane.queued), held: typeof lane.held === 'boolean' ? lane.held : null, verdict };
  }) };
}

async function boundedRead(path: string, limit: number): Promise<{ text: string; mtime: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('unavailable');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('unavailable');
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), mtime: stat.mtimeMs };
  } finally { await handle.close(); }
}

/** Fixed homes; intentionally ignores CODEX_HOME and never visits ~/.codex. */
export function defaultLaneTruthReaders(home = homedir(), now = Date.now()): LaneTruthReaders {
  return {
    async lanes() {
      try {
        for (const path of [join(home, '.ashlr-runs'), join(home, '.ashlr-runs/queue')]) {
          if (!(await lstat(path)).isDirectory()) return [];
        }
        const file = await boundedRead(join(home, '.ashlr-runs/queue/slots.json'), 64 * 1024);
        const raw = object(JSON.parse(file.text));
        return Object.entries(object(raw.lanes ?? raw)).map(([lane, value]) => {
          const row = object(value);
          return { lane, target: count(row.target), running: count(row.running), queued: count(row.queued), held: fresh(new Date(file.mtime).toISOString(), now) && typeof row.held === 'boolean' ? row.held : null };
        });
      } catch { return []; }
    },
    async meters() {
      const files: { path: string; mtime: number }[] = [];
      let visited = 0;
      async function walk(path: string, depth: number): Promise<void> {
        if (++visited > 4096) throw new Error('scan limit');
        if (!(await lstat(path)).isDirectory()) return;
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const child = join(path, entry.name);
          if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name)) await walk(child, depth + 1);
          else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
            if (++visited > 4096) throw new Error('scan limit');
            files.push({ path: child, mtime: (await lstat(child)).mtimeMs });
          }
        }
      }
      try {
        if (!(await lstat(join(home, '.codex-2'))).isDirectory()) return [];
        await walk(join(home, '.codex-2/sessions'), 0);
        files.sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path));
        for (const file of files) {
          const samples: MeterSample[] = [];
          const { text } = await boundedRead(file.path, 16 * 1024 * 1024);
          for (const line of text.split('\n')) {
            let row: Record<string, unknown>;
            try { row = object(JSON.parse(line)); } catch { continue; }
            const payload = object(row.payload);
            if (row.type !== 'event_msg' || payload.type !== 'token_count') continue;
            const limits = object(payload.rate_limits);
            // An explicit other bucket is not the Codex account allowance.
            if (limits.limit_id !== undefined && limits.limit_id !== 'codex') continue;
            for (const name of ['primary', 'secondary']) {
              const window = object(limits[name]);
              if (!Object.keys(window).length) continue;
              const reset = typeof window.resets_at === 'number' && Number.isFinite(window.resets_at) ? instant(new Date(window.resets_at * 1000).toISOString()) : null;
              samples.push({ provider: 'codex-personal', window: count(window.window_minutes) !== null && Number(window.window_minutes) > 0 ? `${name}:${window.window_minutes}` : '', usedPercent: typeof window.used_percent === 'number' ? window.used_percent : null, resetAt: reset, sampledAt: instant(row.timestamp) ?? '' });
            }
          }
          if (samples.length) return samples;
        }
      } catch { /* No raw file data or filesystem error reaches output. */ }
      return [];
    },
  };
}

const laneName = /^[a-z][a-z0-9-]{1,40}$/;
const checkReasons = {
  held_with_capacity: 'held despite available capacity; investigate the hold',
  idle_with_work: 'queued work with no running workers; investigate the stall',
  unknown: 'evidence is missing or stale; refresh lane and meter evidence',
  missing_lane: 'requested lane is missing; verify lane evidence',
  empty_evidence: 'no lane evidence; verify the evidence source',
  evidence_unavailable: 'lane evidence unavailable; verify the evidence source',
  too_many_lanes: 'too many lane entries to check; narrow the selection',
} as const;
type CheckReason = keyof typeof checkReasons;
type CheckEntry = { lane: string | null; reason: CheckReason };
const MAX_CHECK_ENTRIES = 256;

export async function cmdFleetLaneTruth(args: string[], readers = defaultLaneTruthReaders()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('ashlr fleet lane-truth [--lane NAME]... [--json] [--check]\n' +
      'Read-only; stale or missing evidence is unknown. reset_detected is advisory.\n' +
      'Checking never releases holds or grants dispatch authority.');
    return 0;
  }
  let json = false;
  let checking = false;
  const requested = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--check' && !checking) checking = true;
    else if (arg === '--lane' && args[i + 1] && laneName.test(args[i + 1]!)) {
      requested.add(args[++i]!);
      if (requested.size > MAX_CHECK_ENTRIES) return 2;
    }
    else return 2;
  }
  try {
    const result = await readLaneTruth(readers);
    const lanes = requested.size ? result.lanes.filter(row => requested.has(row.lane)) : result.lanes;
    if (!checking) {
      console.log(json ? JSON.stringify({ ...result, lanes }) : lanes.map(row => `${row.lane}: ${row.verdict}`).join('\n'));
      return 0;
    }
    const entries: CheckEntry[] = [];
    let total = 0;
    const add = (entry: CheckEntry) => { total++; if (entries.length < MAX_CHECK_ENTRIES) entries.push(entry); };
    const present = new Set(lanes.map(row => row.lane));
    for (const lane of requested) if (!present.has(lane)) add({ lane, reason: 'missing_lane' });
    for (const row of lanes) {
      if (row.verdict !== 'ok' && row.verdict !== 'reset_detected') add({ lane: row.lane, reason: row.verdict });
    }
    if (!lanes.length && !requested.size) add({ lane: null, reason: 'empty_evidence' });
    if (total > MAX_CHECK_ENTRIES) entries.push({ lane: null, reason: 'too_many_lanes' });
    const check = { passed: total === 0, entries };
    console.log(json ? JSON.stringify({ ...result, lanes, check }) :
      [...lanes.map(row => `${row.lane}: ${row.verdict}`), ...entries.map(entry => `${entry.lane ?? 'fleet'}: ${checkReasons[entry.reason]}`)].join('\n'));
    return check.passed ? 0 : 1;
  } catch {
    if (checking && json) console.log(JSON.stringify({ schema: 'fleet.lane-truth.v1', lanes: [], check: { passed: false, entries: requested.size ? [...requested].map(lane => ({ lane, reason: 'evidence_unavailable' })) : [{ lane: null, reason: 'evidence_unavailable' }] } }));
    else console.error('fleet lane-truth: lane evidence unavailable');
    return 1;
  }
}
