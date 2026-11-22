/** Read-only guardian check shared by both fleet doctor surfaces. */
import { diagnoseGuardianHealth, readFleetHealthAge, readGuardianLogHealth, readGuardianServiceHealth } from './health-age.js';

export interface GuardianDoctorCheck {
  name: 'guardian';
  level: 'ok' | 'warn' | 'red';
  reason: string;
  nextStep: string;
}

export async function readGuardianDoctorCheck(opts: {
  runsDir?: string; now?: () => number; service?: typeof readGuardianServiceHealth;
} = {}): Promise<GuardianDoctorCheck> {
  const reads = { runsDir: opts.runsDir ?? process.env.ASHLR_RUNS_DIR, now: opts.now };
  const [age, service, log] = await Promise.all([
    readFleetHealthAge(reads), (opts.service ?? readGuardianServiceHealth)(), readGuardianLogHealth(reads),
  ]);
  const diagnosis = diagnoseGuardianHealth({ age, service, log });
  const failed = age.status === 'stale' || service.state === 'not-loaded'
    || (service.lastExitCode !== null && service.lastExitCode !== 0) || (log.recentErrors ?? 0) > 0;
  // An unloaded service is the first repair even when status and logs also lag.
  const first = diagnosis.problems.find(p => p.kind === 'service' && service.state === 'not-loaded') ?? diagnosis.problems[0];
  return {
    name: 'guardian', level: failed ? 'red' : diagnosis.healthy ? 'ok' : 'warn',
    reason: diagnosis.healthy ? 'Status is fresh; service is loaded; no error lines in the last 24 hours.'
      : diagnosis.problems.map(p => p.problem).join(' '),
    nextStep: first?.repair ?? 'No action needed.',
  };
}
