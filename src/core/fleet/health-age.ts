/** Read-only guardian freshness; never substitutes the file modification time. */
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { MAIN_HEALTH_STALE_MS } from './main-health.js';
import { localTimestamp, readSource } from './runs-parked-queue.js';

export interface FleetHealthAge {
  v: 1;
  readOnly: true;
  status: 'fresh' | 'stale' | 'missing file' | 'unreadable file' | 'missing timestamp' | 'malformed timestamp' | 'future timestamp';
  statusAt: string | null;
  ageSeconds: number | null;
  maxAgeSeconds: number;
}

export interface GuardianServiceHealth {
  state: 'loaded' | 'not-loaded' | 'unknown';
  lastExitCode: number | null;
  diagnostic: string;
}

/** Read launchd state without exposing its output or changing the service. */
export async function readGuardianServiceHealth(opts: {
  platform?: NodeJS.Platform; uid?: number;
  probe?: (target: string) => Promise<{ ok: boolean; output: string }>;
} = {}): Promise<GuardianServiceHealth> {
  if ((opts.platform ?? process.platform) !== 'darwin' || (opts.uid ?? process.getuid?.()) === undefined) {
    return { state: 'unknown', lastExitCode: null, diagnostic: 'Service check requires a macOS user session.' };
  }
  const target = `gui/${opts.uid ?? process.getuid!()}/ai.ashlr.main-guardian`;
  const probe = opts.probe ?? ((value: string) => new Promise<{ ok: boolean; output: string }>((resolve) => {
    execFile('/bin/launchctl', ['print', value], { timeout: 5000, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}\n${stderr}` });
    });
  }));
  let result: { ok: boolean; output: string };
  try { result = await probe(target); } catch { result = { ok: false, output: '' }; }
  if (!result.ok) {
    const absent = /(?:could not find (?:specified )?service|service .* not found|no such process|not loaded)/i.test(result.output);
    return absent
      ? { state: 'not-loaded', lastExitCode: null, diagnostic: 'Guardian service is not loaded. Check its launchd installation and user session.' }
      : { state: 'unknown', lastExitCode: null, diagnostic: 'Could not inspect the guardian service. Check launchctl and the user session.' };
  }
  // launchd can report a negative status when a process was killed by a signal.
  // Treat malformed or unrepresentable values as unknown, never as success.
  const match = /^\s*last exit code = (-?\d+)\s*$/m.exec(result.output);
  const parsedExitCode = match ? Number(match[1]) : null;
  const lastExitCode = parsedExitCode !== null && Number.isSafeInteger(parsedExitCode) ? parsedExitCode : null;
  return { state: 'loaded', lastExitCode, diagnostic: lastExitCode !== null && lastExitCode !== 0
    ? 'Guardian last exited with an error. Inspect the guardian logs and service configuration.'
    : lastExitCode === null ? 'Guardian is loaded; launchd did not report a last exit code.' : 'Guardian is loaded; last exit was successful.' };
}

export async function readFleetHealthAge(opts: { runsDir?: string; now?: () => number } = {}): Promise<FleetHealthAge> {
  const source = await readSource(join(opts.runsDir ?? join(homedir(), '.ashlr-runs'),
    'supervisor', 'status-main-guardian.md'), 256 * 1024, false);
  const report: FleetHealthAge = {
    v: 1, readOnly: true, status: 'missing timestamp', statusAt: null,
    ageSeconds: null, maxAgeSeconds: MAIN_HEALTH_STALE_MS / 1000,
  };
  if (source.state !== 'healthy') {
    report.status = source.state === 'missing' ? 'missing file' : 'unreadable file';
    return report;
  }
  const heading = source.text.split('\n').find(line => line.startsWith('# Main guardian status'));
  if (!heading) return report;
  const match = /^# Main guardian status \((\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?: [A-Za-z]{1,5})?\)\s*$/.exec(heading);
  const stamp = match ? localTimestamp(match[1]!) : null;
  if (!stamp || !Number.isFinite(stamp.ms)) {
    report.status = 'malformed timestamp';
    return report;
  }
  const ageMs = (opts.now ?? Date.now)() - stamp.ms;
  report.statusAt = stamp.at;
  report.ageSeconds = ageMs / 1000;
  report.status = ageMs < 0 ? 'future timestamp' : ageMs > MAIN_HEALTH_STALE_MS ? 'stale' : 'fresh';
  return report;
}

/** Counts timestamped error lines in the bounded log tail without exposing log contents. */
export async function readGuardianLogHealth(opts: { runsDir?: string; now?: () => number } = {}): Promise<{
  source: 'healthy' | 'missing' | 'degraded'; windowSeconds: number; recentErrors: number | null; unparseableErrors: number | null;
}> {
  const source = await readSource(join(opts.runsDir ?? join(homedir(), '.ashlr-runs'), 'guardian', 'guardian.log'), 256 * 1024, true);
  const result = { source: source.state, windowSeconds: 86400, recentErrors: null as number | null, unparseableErrors: null as number | null };
  if (source.state !== 'healthy') return result;
  result.recentErrors = 0;
  result.unparseableErrors = 0;
  const now = (opts.now ?? Date.now)();
  for (const line of source.text.split('\n')) {
    if (!/\b(?:error|failed|failure|exception)\b/i.test(line)) continue;
    const match = /^(?:\[)?(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?)/.exec(line);
    const raw = match?.[1];
    const time = raw && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw) ? localTimestamp(raw).ms : raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(time) || time > now) result.unparseableErrors++;
    else if (time >= now - result.windowSeconds * 1000) result.recentErrors++;
  }
  return result;
}

export type GuardianLogHealth = Awaited<ReturnType<typeof readGuardianLogHealth>>;

export interface GuardianProblem { kind: 'status' | 'service' | 'log'; problem: string; repair: string }
export interface GuardianDiagnosis { healthy: boolean; problems: GuardianProblem[] }

/**
 * Pure verdict over the three read-only checks. Repairs are instructions for a
 * human or agent; nothing here starts, stops or enqueues anything, so it never
 * duplicates the guardian's own FIXUP-MAIN repairs. Absent evidence is a problem.
 */
export function diagnoseGuardianHealth(input: {
  age: FleetHealthAge; service: GuardianServiceHealth | null; log: GuardianLogHealth | null;
}): GuardianDiagnosis {
  const problems: GuardianProblem[] = [];
  const { age, service, log } = input;
  if (age.status !== 'fresh') {
    problems.push({ kind: 'status', problem: `Status is ${age.status}.`, repair: age.status === 'future timestamp'
      ? 'Check the system clock, then re-run this check.'
      : 'Confirm the guardian service is loaded and running; its next pass rewrites supervisor/status-main-guardian.md.' });
  }
  if (service && service.state !== 'loaded') {
    problems.push({ kind: 'service', problem: service.state === 'not-loaded' ? 'Service is not loaded.' : 'Service state is unknown.',
      repair: service.state === 'not-loaded'
        ? 'Reinstall or bootstrap the ai.ashlr.main-guardian LaunchAgent from your macOS user session.'
        : service.diagnostic });
  } else if (service && service.lastExitCode !== 0) {
    problems.push({ kind: 'service', problem: service.lastExitCode === null ? 'Last exit code was not reported.'
      : `Last exit code was ${service.lastExitCode}.`, repair: 'Read the tail of guardian/guardian.log for the failure; run `phm fleet health-age --log`.' });
  }
  if (log) {
    if (log.source !== 'healthy') problems.push({ kind: 'log', problem: `Guardian log is ${log.source}.`,
      repair: 'Check that guardian/guardian.log exists under the runs directory and is readable.' });
    else if (log.recentErrors) problems.push({ kind: 'log', problem: `${log.recentErrors} error lines in the last 24 hours.`,
      repair: 'Open guardian/guardian.log and fix the newest error; `phm fleet main-repair-time` shows whether repairs are slow.' });
    if (log.source === 'healthy' && log.unparseableErrors) problems.push({ kind: 'log', problem: `${log.unparseableErrors} error lines have no usable timestamp.`,
      repair: 'Inspect those lines in guardian/guardian.log; undated errors cannot be ruled out.' });
  }
  return { healthy: problems.length === 0, problems };
}
