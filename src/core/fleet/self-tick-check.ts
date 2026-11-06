/**
 * self-tick-check.ts — the read-only verdict behind `fleet self-tick-check`:
 * is the per-user self-tick timer installed AND confirmed active by this
 * user's service manager? An agent gets a machine-readable exit verdict so it
 * can invoke the existing installer when the timer is absent instead of
 * trusting queued state (Nov 1 restart-continuity / actually-running orders).
 * Only this timer's canonical unit paths (from the selfTickSchedule model so
 * names cannot drift) and argv-only bounded probes are consulted — launchctl
 * print gui/<uid>/<label> on macOS, systemctl --user is-enabled/is-active
 * phm-self-tick.timer on Linux. Nothing is bootstrapped, enabled, unloaded,
 * spawned or written; raw manager output is never surfaced, and --runs-dir
 * history freshness stays separate from activation.
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { selfTickSchedule, SELF_TICK_LABEL, SELF_TICK_MAX_INTERVAL_SECONDS } from './self-tick-schedule.js';
import { readSelfTickLast } from './self-tick-last.js';

/** Fixed installer argv reported for a missing/inactive timer; never executed. */
export const SELF_TICK_INSTALL_ARGV = ['ashlr', 'fleet', 'self-tick-schedule', '--write', '--load'] as const;

/** A recorded run older than the slowest legal tick interval is stale for any install. */
export const SELF_TICK_LAST_STALE_SECONDS = SELF_TICK_MAX_INTERVAL_SECONDS;

export interface SelfTickCheckProbeResult { ok: boolean; stdout?: string; stderr?: string }
/** argv-only probe seam; tests fake it, never a shell string. */
export type SelfTickCheckProbe = (argv: readonly string[]) => SelfTickCheckProbeResult;

export interface SelfTickCheckOptions {
  platform?: NodeJS.Platform; home?: string;
  uid?: number;      // for gui/<uid>/<label>; defaults to getuid
  now?: number;      // ms epoch for lastRun age
  runsDir?: string;  // when set, also read queue/self-tick-last.json under it
  probe: SelfTickCheckProbe;
}

export type SelfTickCheckVerdict = 'active' | 'missing' | 'inactive' | 'unknown';
export interface SelfTickUnitCheck { path: string; state: 'present' | 'absent' | 'unreadable' }
export type SelfTickManagerState =
  | 'loaded' | 'not-loaded' | 'enabled-active' | 'enabled-inactive' | 'disabled' | 'not-found' | 'probe-failed';
export interface SelfTickManagerCheck {
  tool: 'launchctl' | 'systemctl';
  target: string; // gui/<uid>/<label> on macOS; the timer unit name on Linux
  state: SelfTickManagerState;
  detail?: string; // classified reason for probe-failed; never raw output
}
export type SelfTickLastRunCheck =
  | { state: 'missing' | 'unreadable' }
  | { state: 'fresh' | 'stale'; at: string; ageSeconds: number; mode: 'apply' | 'dry-run'; ranState: 'ran' | 'busy'; failedSteps: string[]; staleAfterSeconds: number };
export interface SelfTickCheckReport {
  v: 1; platform: NodeJS.Platform; supported: boolean; installed: boolean;
  units: SelfTickUnitCheck[]; manager: SelfTickManagerCheck | null;
  lastRun: SelfTickLastRunCheck | null; verdict: SelfTickCheckVerdict;
  exitCode: 0 | 1 | 3; // 0 installed+confirmed active; 1 missing/inactive; 3 unknown/unreadable/unsupported
  suggestedInstall: readonly string[] | null; // set only for missing/inactive — never executed
}

const unitFileState = (path: string): SelfTickUnitCheck['state'] => {
  try { statSync(path); return 'present'; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable'; }
};

/** launchd's "no such service" spellings — the same surface daemon/service.ts accepts. */
const LAUNCHD_ABSENT = /(?:could not find (?:specified )?service|service .* not found|no such process|not loaded)/i;

function probeLaunchd(probe: SelfTickCheckProbe, uid: number): SelfTickManagerCheck {
  const target = `gui/${uid}/${SELF_TICK_LABEL}`;
  const result = probe(['launchctl', 'print', target]);
  if (result.ok) return { tool: 'launchctl', target, state: 'loaded' };
  const state = LAUNCHD_ABSENT.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`) ? 'not-loaded' : 'probe-failed';
  return { tool: 'launchctl', target, state, ...(state === 'probe-failed' ? { detail: 'launchctl print failed' } : {}) };
}

function probeSystemd(probe: SelfTickCheckProbe, unit: string): SelfTickManagerCheck {
  const token = (r: SelfTickCheckProbeResult) => (r.stdout ?? '').trim();
  const en = probe(['systemctl', '--user', 'is-enabled', unit]);
  const enState =
    en.ok && token(en) === 'enabled' ? 'enabled'
    : !en.ok && (token(en) === 'disabled' || token(en) === 'masked') ? 'disabled'
    : !en.ok && token(en) === 'not-found' ? 'not-found' : 'failed';
  const act = probe(['systemctl', '--user', 'is-active', unit]);
  const actState =
    act.ok && token(act) === 'active' ? 'active'
    : !act.ok && (token(act) === 'inactive' || token(act) === 'failed') ? 'inactive' : 'failed';
  if (enState === 'failed' || actState === 'failed') {
    const which = enState === 'failed' ? 'is-enabled' : 'is-active';
    return { tool: 'systemctl', target: unit, state: 'probe-failed', detail: `${which} probe failed` };
  }
  const state: SelfTickManagerState = enState === 'not-found' ? 'not-found'
    : enState === 'disabled' ? 'disabled'
    : actState === 'active' ? 'enabled-active' : 'enabled-inactive';
  return { tool: 'systemctl', target: unit, state };
}

function readLastRun(runsDir: string | undefined, now: number): SelfTickLastRunCheck | null {
  if (runsDir === undefined) return null;
  const view = readSelfTickLast(runsDir, now);
  if (view === null || view.state === 'unreadable') return { state: view === null ? 'missing' : 'unreadable' };
  return {
    state: view.ageSeconds <= SELF_TICK_LAST_STALE_SECONDS ? 'fresh' : 'stale',
    at: view.at, ageSeconds: view.ageSeconds, mode: view.mode,
    ranState: view.ranState, failedSteps: view.failedSteps, staleAfterSeconds: SELF_TICK_LAST_STALE_SECONDS,
  };
}

export function checkSelfTickSchedule(options: SelfTickCheckOptions): SelfTickCheckReport {
  const platform = options.platform ?? process.platform;
  const lastRun = readLastRun(options.runsDir, options.now ?? Date.now());
  if (platform !== 'darwin' && platform !== 'linux') {
    return { v: 1, platform, supported: false, installed: false, units: [], manager: null,
      lastRun, verdict: 'unknown', exitCode: 3, suggestedInstall: null };
  }
  const home = options.home ?? homedir();
  // Canonical per-user unit paths come from the installer model so names can
  // never drift; the argv placeholders only satisfy its validation — the
  // rendered contents are never written or printed.
  const paths = selfTickSchedule({
    ashlrPath: '/self-tick-check/ashlr', nodePath: '/self-tick-check/node',
    apply: false, platform, home,
  }).map((unit) => unit.path);
  const units = paths.map((path) => ({ path, state: unitFileState(path) }));
  const installed = units.every((unit) => unit.state === 'present');
  const manager = platform === 'darwin'
    ? probeLaunchd(options.probe, options.uid ?? process.getuid?.() ?? 501)
    : probeSystemd(options.probe, basename(paths.find((p) => p.endsWith('.timer'))!));
  const confirmed = manager.state === 'loaded' || manager.state === 'enabled-active';
  const verdict: SelfTickCheckVerdict =
    units.some((unit) => unit.state === 'unreadable') || manager.state === 'probe-failed'
      ? 'unknown' : !installed ? 'missing' : confirmed ? 'active' : 'inactive';
  return {
    v: 1, platform, supported: true, installed, units, manager, lastRun, verdict,
    exitCode: verdict === 'active' ? 0 : verdict === 'unknown' ? 3 : 1,
    suggestedInstall: verdict === 'missing' || verdict === 'inactive' ? SELF_TICK_INSTALL_ARGV : null,
  };
}
