import { defaultAppUpdateStatusDeps, readAppUpdateStatus, type AppUpdateStatus } from '../app-update-status.js';

export function updatePhaseFromStatus(status: AppUpdateStatus): 'ok' | 'unknown' {
  return typeof status.current === 'string' ? 'ok' : 'unknown';
}

export function readUpdatePhase(
  read: () => AppUpdateStatus = () => readAppUpdateStatus(defaultAppUpdateStatusDeps()),
): 'ok' | 'unknown' {
  try {
    return updatePhaseFromStatus(read());
  } catch {
    return 'unknown';
  }
}
