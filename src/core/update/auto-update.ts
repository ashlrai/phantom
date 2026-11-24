/**
 * Self-driving release updates (PCEB-10, AUTO-UPDATER-LA-1).
 *
 * `ashlr update --auto` runs from the per-user launch agent ai.ashlr.updater.
 * Each due tick installs the newest published @ashlr/phantom into the
 * immutable release layout (~/.local/share/ashlr/releases/<sha256> plus the
 * `current` symlink) through updateReleaseDirectory: registry sha512
 * integrity, GitHub attestation (required whenever gh is installed), archive
 * safety, a smoke run, an atomic `current` swap and rollback on any failure.
 *
 * RESIDENT DAEMON. `ashlr authority resident start` is the only command that
 * restarts ai.ashlr.daemon, and it needs the operator. The updater therefore
 * NEVER relaunches the daemon: it pauses it for the link swap and resumes the
 * same process (SIGCONT), so an admitted start is never undone. It then asks
 * `ashlr authority resident status --json` of the NEW release whether a start
 * would be admitted, and writes ONE request for Mason:
 *   - admitted: `ashlr authority resident start` moves the daemon onto it.
 *   - grant-inactive (the authority-surface digest changed): re-approve first,
 *     then the same start.
 * The request clears itself once the daemon runs the release at `current`.
 * Nothing here signs, drafts or installs a grant.
 *
 * CADENCE. No fixed interval. The launch agent is only a heartbeat; a tick
 * runs when due. The delay starts at the minimum, doubles while nothing new
 * ships (up to the maximum), resets the moment a new release is seen, and is
 * capped by half the learned median gap between observed releases so a
 * release train that ships every few minutes is followed every few minutes.
 */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const UPDATER_LABEL = 'ai.ashlr.updater';
export const DAEMON_LABEL = 'ai.ashlr.daemon';
export const REAPPROVE_COMMAND = 'ashlr authority re-approve';
export const RESIDENT_START_COMMAND = 'ashlr authority resident start';
export const HEARTBEAT_SECONDS = 60;
export const MIN_DELAY_MS = 60_000;
export const MAX_DELAY_MS = 30 * 60_000;
const HISTORY = 20;

export const updateStateDir = (home = homedir()): string => join(home, '.ashlr-runs', 'update');
export const schedulePath = (home = homedir()): string => join(updateStateDir(home), 'schedule.json');
export const residentRequestPath = (home = homedir()): string => join(updateStateDir(home), 'resident-request.json');

function writePrivateJson(path: string, value: unknown): void {
  fs.mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, path);
}
function readJson<T>(path: string): T | null {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')) as T; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Learned cadence
// ---------------------------------------------------------------------------

export interface UpdateSchedule {
  schema: 'phantom.update.schedule.v1';
  /** Latest version this host has seen published. */
  lastVersion: string | null;
  /** Wall-clock ms when each newer version was first seen (oldest first, bounded). */
  seenAt: number[];
  delayMs: number;
  nextAt: number;
}

export function emptySchedule(): UpdateSchedule {
  return { schema: 'phantom.update.schedule.v1', lastVersion: null, seenAt: [], delayMs: MIN_DELAY_MS, nextAt: 0 };
}

/** Median gap between observed releases, or null with fewer than two observations. */
export function learnedGapMs(seenAt: readonly number[]): number | null {
  if (seenAt.length < 2) return null;
  const gaps = seenAt.slice(1).map((at, i) => at - seenAt[i]!).filter((gap) => gap > 0).sort((a, b) => a - b);
  if (gaps.length === 0) return null;
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid]! : Math.round((gaps[mid - 1]! + gaps[mid]!) / 2);
}

/** PURE: the schedule after a check that saw `latest` (null = check failed). */
export function nextSchedule(prev: UpdateSchedule, latest: string | null, nowMs: number): UpdateSchedule {
  const fresh = latest !== null && latest !== prev.lastVersion;
  const seenAt = fresh && prev.lastVersion !== null ? [...prev.seenAt, nowMs].slice(-HISTORY) : prev.seenAt;
  let delayMs = fresh ? MIN_DELAY_MS : Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, prev.delayMs * 2));
  const gap = learnedGapMs(seenAt);
  if (gap !== null) delayMs = Math.max(MIN_DELAY_MS, Math.min(delayMs, Math.round(gap / 2)));
  return { schema: 'phantom.update.schedule.v1', lastVersion: latest ?? prev.lastVersion, seenAt, delayMs, nextAt: nowMs + delayMs };
}

export function readSchedule(home = homedir()): UpdateSchedule {
  const value = readJson<UpdateSchedule>(schedulePath(home));
  return value?.schema === 'phantom.update.schedule.v1' && Array.isArray(value.seenAt) ? value : emptySchedule();
}
export function writeSchedule(schedule: UpdateSchedule, home = homedir()): void { writePrivateJson(schedulePath(home), schedule); }
export function tickDue(schedule: UpdateSchedule, nowMs: number): boolean { return nowMs >= schedule.nextAt; }

// ---------------------------------------------------------------------------
// Resident daemon: never relaunched here; one request for the operator
// ---------------------------------------------------------------------------

export interface ResidentStatusRead { code: string | null; grantSeq: number | null; reason: string | null }

/** Parse `ashlr authority resident status --json` (schema ashlr.resident-status.v1). */
export function parseResidentStatus(stdout: string | null | undefined): ResidentStatusRead {
  try {
    const value = JSON.parse(stdout ?? '') as { schema?: string; admission?: { code?: unknown; grantSeq?: unknown; reason?: unknown } };
    if (value.schema !== 'ashlr.resident-status.v1' || !value.admission) return { code: null, grantSeq: null, reason: 'unreadable resident status' };
    const a = value.admission;
    return { code: typeof a.code === 'string' ? a.code : null, grantSeq: typeof a.grantSeq === 'number' ? a.grantSeq : null, reason: typeof a.reason === 'string' ? a.reason : null };
  } catch { return { code: null, grantSeq: null, reason: 'unreadable resident status' }; }
}

export interface ResidentRequest {
  schema: 'phantom.update.resident-request.v1';
  version: string;
  releaseRoot: string;
  /** Resident admission code the NEW release reported. */
  admission: string | null;
  reason: string | null;
  /** Exact commands for Mason, in order. */
  commands: string[];
  createdAt: string;
}

/** PURE: the single ask for the operator after a new release installs while the daemon runs the old one. */
export function residentRequest(version: string, releaseRoot: string, status: ResidentStatusRead, nowMs: number): ResidentRequest {
  const commands = status.code === 'admitted' ? [RESIDENT_START_COMMAND]
    : status.code === 'grant-inactive' ? [REAPPROVE_COMMAND, RESIDENT_START_COMMAND]
      : [];
  return { schema: 'phantom.update.resident-request.v1', version, releaseRoot, admission: status.code, reason: status.reason, commands, createdAt: new Date(nowMs).toISOString() };
}

export function readResidentRequest(home = homedir()): ResidentRequest | null {
  const value = readJson<ResidentRequest>(residentRequestPath(home));
  return value?.schema === 'phantom.update.resident-request.v1' ? value : null;
}
export function writeResidentRequest(request: ResidentRequest, home = homedir()): void { writePrivateJson(residentRequestPath(home), request); }

/** Clears a request once the daemon runs the requested release. Keeps a dated record. */
export function settleResidentRequest(daemonRoot: string | null, home = homedir(), nowMs = Date.now()): boolean {
  const request = readResidentRequest(home);
  if (!request || !daemonRoot || daemonRoot !== request.releaseRoot) return false;
  fs.renameSync(residentRequestPath(home), join(updateStateDir(home), `resident-request.settled-${nowMs}.json`));
  return true;
}

/** PURE: the release root a daemon command line runs, from `ps -o command=`. */
export function releaseRootFromCommand(command: string, home = homedir()): string | null {
  const base = join(home, '.local/share/ashlr/releases/');
  const at = command.indexOf(base);
  if (at < 0) return null;
  const leaf = command.slice(at + base.length).split(/[/\s]/)[0];
  return leaf && /^[0-9a-f]{64}$/.test(leaf) ? join(base, leaf) : null;
}

// ---------------------------------------------------------------------------
// Launch agent
// ---------------------------------------------------------------------------

const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The per-user launch agent. It runs the release at `current` through its
 * real entry point (bin/ashlr: older release directories have no `phm`
 * link) with an explicit node, so it updates itself along with the CLI.
 * StartInterval is only the heartbeat; the learned schedule decides when a
 * tick actually checks. No credentials, no shell.
 */
export function updaterLaunchAgentPlist(home = homedir(), nodePath = process.execPath): string {
  const entry = join(home, '.local/share/ashlr/current/bin/ashlr');
  const log = join(updateStateDir(home), 'updater.log');
  const args = ['/usr/bin/nice', '-n', '10', nodePath, entry, 'update', '--auto', '--json'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${UPDATER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
  <key>StartInterval</key><integer>${HEARTBEAT_SECONDS}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}
