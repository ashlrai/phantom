/** Read-only guardian evidence shared by fleet status and doctor surfaces. */
import { diagnoseGuardianHealth, readFleetHealthAge, readGuardianLogHealth, readGuardianServiceHealth } from './health-age.js';
import type { FleetHealthAge, GuardianHealthState, GuardianLogHealth, GuardianServiceHealth } from './health-age.js';

export interface GuardianDoctorCheck {
  name: 'guardian';
  level: 'ok' | 'warn' | 'red';
  reason: string;
  nextStep: string;
}

export interface GuardianStatus extends GuardianDoctorCheck {
  readOnly: true;
  state: GuardianHealthState;
  age: FleetHealthAge;
  service: GuardianServiceHealth;
  log: GuardianLogHealth;
}

export async function readGuardianStatus(opts: {
  runsDir?: string; now?: () => number; service?: typeof readGuardianServiceHealth;
} = {}): Promise<GuardianStatus> {
  const now = (opts.now ?? Date.now)();
  const reads = { runsDir: opts.runsDir ?? process.env.ASHLR_RUNS_DIR, now: () => now };
  const [age, service, log] = await Promise.all([
    readFleetHealthAge(reads), (opts.service ?? readGuardianServiceHealth)(), readGuardianLogHealth(reads),
  ]);
  const diagnosis = diagnoseGuardianHealth({ age, service, log });
  const failed = ['stale', 'unloaded', 'error'].includes(diagnosis.state);
  // An unloaded service is the first repair even when status and logs also lag.
  const first = diagnosis.problems.find(p => p.kind === 'service' && service.state === 'not-loaded') ?? diagnosis.problems[0];
  return {
    readOnly: true, state: diagnosis.state, age, service, log,
    name: 'guardian', level: failed ? 'red' : diagnosis.healthy ? 'ok' : 'warn',
    reason: diagnosis.healthy ? 'Status is fresh; service is loaded; no error lines in the last 24 hours.'
      : diagnosis.problems.map(p => p.problem).join(' '),
    nextStep: first?.repair ?? 'No action needed.',
  };
}

export async function readGuardianDoctorCheck(opts: Parameters<typeof readGuardianStatus>[0] = {}): Promise<GuardianDoctorCheck> {
  return readGuardianStatus(opts);
}
