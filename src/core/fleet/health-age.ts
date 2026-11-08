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
  const match = /^\s*last exit code = (\d+)\s*$/m.exec(result.output);
  const lastExitCode = match ? Number(match[1]) : null;
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
