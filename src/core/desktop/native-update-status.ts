import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { parents } from './consumer-install.js';

const schema = 'desktop.native-update-status.v1';
const phases = new Set(['uncommissioned', 'disabled', 'checking', 'idle', 'available', 'downloading',
  'staged', 'waiting-for-idle', 'waiting-for-app-quit', 'adoption-held', 'installing', 'installed', 'current', 'failed']);
const remedies: Readonly<Record<string, string>> = {
  'stop-required': 'Engage Stop with phm authority stop, then let local work drain.',
  'work-active-or-unknown': 'Wait for local work and execution leases to finish.',
  'authority-reapproval-required': 'Review and approve the changed authority before resuming the fleet.',
  'grant-unavailable': 'Review the standing grant in Fleet.',
  'operator-restart-required': 'Resume the fleet when ready with phm authority resident start.',
  'host-unavailable': 'Inspect the managed installation with phm desktop install --upgrade --require-app.',
  'running-current-mismatch': 'Inspect the managed installation with phm desktop install --upgrade --require-app.',
  'disabled': 'Enable Automatic updates in Phantom Settings.',
  'applied': 'The verified update was installed.',
};
const reasons = new Set([...Object.keys(remedies),
  'app-inventory-mismatch', 'app-source-unverified', 'app-version-unverified', 'artifact-mismatch', 'artifact-size-refused',
  'authority-changed', 'candidate-identity-regression', 'candidate-not-newer', 'candidate-surface-unverified',
  'current-or-stage-changed', 'current-version-unverified', 'download-failed', 'download-origin-refused', 'download-size',
  'download-unavailable', 'host-status-unavailable', 'incomplete-app-archive', 'installation-recovery-required',
  'installed-app-unavailable', 'installed-app-unverified', 'installed-current-unverified', 'invalid-manifest', 'invalid-stage',
  'native-exit-acknowledged', 'native-parent-changed-or-unknown', 'native-parent-proof-timeout', 'native-parent-still-running',
  'native-parent-unverified', 'no-update', 'package-archive-refused', 'pointer-recovery-unknown', 'preference-save-failed',
  'resident-stop-failed', 'result-persistence-unknown', 'rollback-held', 'signed-release-conflict', 'signed-release-regression',
  'stage-changed', 'trust-not-commissioned', 'uncommissioned-key', 'unknown', 'unsafe-app-archive', 'unsafe-installation-path',
  'unsafe-stage', 'unsupported-installed-runtime', 'unsupported-platform', 'update-attempt-already-recorded',
  'update-result-unverified', 'update-unavailable', 'verification-failed', 'waiting-native-exit']);

function readStatusFile(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const identity = fstatSync(fd);
    if (!identity.isFile() || identity.nlink !== 1 || identity.uid !== process.getuid?.() ||
      (identity.mode & 0o077) !== 0 || identity.size < 1 || identity.size > 4096) throw new Error();
    const data = Buffer.alloc(identity.size + 1);
    let size = 0;
    while (size < data.length) {
      const count = readSync(fd, data, size, data.length - size, size);
      if (count === 0) break;
      size += count;
    }
    const after = fstatSync(fd);
    if (size !== identity.size || after.size !== size || after.mtimeMs !== identity.mtimeMs || after.ctimeMs !== identity.ctimeMs) throw new Error();
    return { data: data.subarray(0, size), identity };
  } finally { closeSync(fd); }
}

export function readNativeUpdateStatus(home = userInfo().homedir, now = Date.now()) {
  const unavailable = (reason: 'native-status-unavailable' | 'native-status-stale' | 'native-status-invalid') => ({
    schema, source: 'unavailable', phase: null, reason, version: null, enabled: null, observedAt: null,
    remedy: 'Open an up-to-date Phantom desktop app and check Desktop updates in Settings.',
  });
  try {
    const parent = join(home, '.ashlr', 'updates');
    parents(home, parent, false);
    const { data, identity } = readStatusFile(join(parent, 'native-status.json'));
    const observed = Math.floor(identity.mtimeMs);
    if (observed > now || now - observed > 20 * 60_000) return unavailable('native-status-stale');
    const value: unknown = JSON.parse(data.toString('utf8'));
    if (!value || typeof value !== 'object') return unavailable('native-status-invalid');
    const { schema: recordSchema, phase, reason, enabled, version } = value as Record<string, unknown>;
    if (recordSchema !== schema || typeof phase !== 'string' || !phases.has(phase) || typeof enabled !== 'boolean' ||
      (reason !== null && (typeof reason !== 'string' || !reasons.has(reason))) ||
      (version !== null && (typeof version !== 'string' || !/^\d{1,10}\.\d{1,10}\.\d{1,10}$/.test(version)))) {
      return unavailable('native-status-invalid');
    }
    return { schema, source: 'last-native-observation', phase, reason, version, enabled,
      observedAt: identity.mtime.toISOString(),
      remedy: phase === 'disabled' ? remedies.disabled! :
        reason === null ? null : Object.hasOwn(remedies, reason) ? remedies[reason]! : 'Check Desktop updates in Phantom Settings.' };
  } catch (error) {
    return unavailable((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'native-status-unavailable' : 'native-status-invalid');
  }
}
