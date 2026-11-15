/**
 * Why no job is launching, in one plain line (RQ-PHX-STALLWHY109).
 *
 * Read-only mirror of the launch blockers in contrib/mac/dispatchd.py: the disk guard (hard stop and reuse-only
 * mode), the load gate, the fleet cap and a dispatcher that stopped ticking. `explainLaunchBlock` is pure;
 * `readLaunchWhyInput` reads <runs>/queue/admission.json, counts <runs>/queue/run/*.diskguard markers and,
 * only when the snapshot cannot supply it, measures free space with statfs. Nothing here writes.
 *
 * `disabled: true` in the snapshot means LOADGATE_OFF (the load gate is switched off). It never means dispatch
 * is off and is never a block on its own.
 */
import { readdir, readFile, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { DAEMON_TICK_MAX_S } from '../queue/admission.js';

/** Keep in step with contrib/mac/dispatchd.py: DISK_REUSE_ONLY_GB (env, default 100). */
export const DISK_REUSE_ONLY_GB_ENV = 'DISK_REUSE_ONLY_GB';
export const DISK_REUSE_ONLY_GB_DEFAULT = 100;
/** Keep in step with contrib/mac/dispatchd.py: DISK_HARD_STOP_GB (env, default 30). */
export const DISK_HARD_STOP_GB_ENV = 'DISK_HARD_STOP_GB';
export const DISK_HARD_STOP_GB_DEFAULT = 30;

export type LaunchWhyCode = 'disk-hard-stop' | 'disk-reuse-only' | 'load-gate' | 'at-cap' | 'dispatcher-stale' | 'unknown' | 'none';
export interface LaunchWhy { code: LaunchWhyCode; line: string; detail: string[] }

/** The fields of a dispatchd.admission.v2 snapshot this explanation uses; anything missing stays null. */
export interface LaunchAdmissionSnapshot {
  ts: string | null; admit: boolean | null; reason: string | null; gateReason: string | null; disabled: boolean;
  cap: number | null; running: number | null; diskFreeGb: number | null; diskHardStopGb: number | null;
}

export interface LaunchWhyInput {
  /** null when admission.json is absent (no dispatcher snapshot on this host). */
  admission: LaunchAdmissionSnapshot | null;
  /** admission.json exists but could not be read or parsed. */
  admissionUnreadable?: boolean;
  /** Free GB on the runs volume, or null when unknown. */
  diskFreeGb: number | null;
  reuseOnlyGb: number; hardStopGb: number;
  /** Count of queue/run/*.diskguard markers, or null when unreadable. */
  diskguardMarkers: number | null;
  now: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** Floor, like dispatchd's own %dG: 99.6 GB must not read as "100 GB free, under the 100 GB guard". */
const gb = (v: number): string => `${Math.floor(v)} GB`;
const limit = (v: number): string => `${v} GB`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Snapshot age in seconds, or null when the timestamp is missing, unparseable or ahead of this clock. */
function ageSeconds(ts: string | null, now: number): number | null {
  const at = ts === null ? NaN : Date.parse(ts);
  const age = (now - at) / 1000;
  return Number.isFinite(age) && age >= -DAEMON_TICK_MAX_S ? Math.max(0, age) : null;
}

export function isSnapshotFresh(admission: LaunchAdmissionSnapshot, now: number): boolean {
  const age = ageSeconds(admission.ts, now);
  return age !== null && age <= DAEMON_TICK_MAX_S;
}

export function explainLaunchBlock(input: LaunchWhyInput): LaunchWhy {
  const { admission, diskFreeGb: free, reuseOnlyGb, hardStopGb, diskguardMarkers: markers, now } = input;
  const fresh = admission !== null && isSnapshotFresh(admission, now);
  const detail: string[] = [];
  if (fresh && admission.disabled) detail.push('Load gate is switched off (LOADGATE_OFF); launches are not blocked by load.');
  if (free === null) detail.push('Free space on the runs disk: unknown.');
  const waiting = markers === null ? 'Jobs waiting for disk: unknown.' : `${plural(markers, 'job is', 'jobs are')} waiting for disk.`;
  const out = (code: LaunchWhyCode, line: string): LaunchWhy => ({ code, line, detail });

  if (free !== null && free < hardStopGb) {
    return out('disk-hard-stop', `Nothing can start: ${gb(free)} free on the runs disk, under the ${limit(hardStopGb)} hard stop.`);
  }
  if (free !== null && free < reuseOnlyGb) {
    return out('disk-reuse-only', `Only repair jobs can start: ${gb(free)} free on the runs disk, under the ${limit(reuseOnlyGb)} guard. ${waiting}`);
  }
  if (fresh && admission.gateReason !== null) return out('load-gate', `The load gate stopped launches: ${admission.gateReason}.`);
  if (fresh && admission.cap !== null && admission.running !== null && admission.running >= admission.cap) {
    return out('at-cap', `All ${plural(admission.cap, 'slot is', 'slots are')} in use.`);
  }
  if (admission !== null && !fresh) {
    const age = ageSeconds(admission.ts, now);
    return out('dispatcher-stale', age === null
      ? 'The dispatcher has not ticked recently; its last tick time is unknown.'
      : `The dispatcher has not ticked for ${Math.round(age / 60)} min.`);
  }
  if (fresh && admission.admit === false) return out('unknown', `The dispatcher is holding launches: ${admission.reason ?? 'reason unknown'}.`);
  if (input.admissionUnreadable) return out('unknown', "Phantom can't read the dispatcher's admission snapshot, so the reason is unknown.");
  if (free === null && markers !== null && markers > 0) {
    return out('unknown', `${plural(markers, 'job is', 'jobs are')} waiting for disk, but free space on the runs disk is unknown.`);
  }
  return out('none', 'Nothing is blocking launches.');
}

/** Pick the snapshot fields used here out of raw admission.json; wrong-typed fields become null, never zero. */
export function parseAdmissionSnapshot(raw: unknown): LaunchAdmissionSnapshot | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (a.schema !== 'dispatchd.admission.v2') return null;
  return {
    ts: str(a.ts), admit: typeof a.admit === 'boolean' ? a.admit : null, reason: str(a.reason), gateReason: str(a.gate_reason),
    disabled: a.disabled === true, cap: count(a.cap) ? a.cap : null, running: count(a.running) ? a.running : null,
    diskFreeGb: finite(a.disk_free_gb) && a.disk_free_gb >= 0 ? a.disk_free_gb : null,
    diskHardStopGb: finite(a.disk_hard_stop_gb) && a.disk_hard_stop_gb >= 0 ? a.disk_hard_stop_gb : null,
  };
}

/** dispatchd's float(os.environ.get(NAME, default)) with its ValueError fallback. */
export function thresholdFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Free GB (1e9 bytes, like dispatchd) on the volume holding `path`; BigInt math so large volumes stay exact. */
export async function statfsFreeGb(path: string): Promise<number> {
  const s = await statfs(path, { bigint: true });
  return Number((s.bavail * s.bsize) / 1_000_000n) / 1000;
}

export interface LaunchWhyDeps {
  env?: NodeJS.ProcessEnv;
  now?: number;
  freeGb?: (path: string) => Promise<number>;
}

export async function readLaunchWhyInput(runsDir: string, deps: LaunchWhyDeps = {}): Promise<LaunchWhyInput> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now();
  let admission: LaunchAdmissionSnapshot | null = null;
  let admissionUnreadable = false;
  try {
    admission = parseAdmissionSnapshot(JSON.parse(await readFile(join(runsDir, 'queue', 'admission.json'), 'utf8')));
    if (admission === null) admissionUnreadable = true;
  } catch (error) {
    admissionUnreadable = (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  const fresh = admission !== null && isSnapshotFresh(admission, now);
  // dispatchd measures the same volume each tick; its number wins while the snapshot is fresh.
  let diskFreeGb = fresh ? admission!.diskFreeGb : null;
  if (diskFreeGb === null) {
    try { diskFreeGb = await (deps.freeGb ?? statfsFreeGb)(runsDir); } catch { diskFreeGb = null; }
    if (!finite(diskFreeGb) || diskFreeGb < 0) diskFreeGb = null;
  }
  let diskguardMarkers: number | null = null;
  try {
    diskguardMarkers = (await readdir(join(runsDir, 'queue', 'run'))).filter((name) => name.endsWith('.diskguard')).length;
  } catch { diskguardMarkers = null; }
  return {
    admission, admissionUnreadable, diskFreeGb, diskguardMarkers, now,
    reuseOnlyGb: thresholdFromEnv(env, DISK_REUSE_ONLY_GB_ENV, DISK_REUSE_ONLY_GB_DEFAULT),
    hardStopGb: (fresh ? admission!.diskHardStopGb : null) ?? thresholdFromEnv(env, DISK_HARD_STOP_GB_ENV, DISK_HARD_STOP_GB_DEFAULT),
  };
}
