/** Local desktop update inspection. Never downloads, installs, or restarts. */
import {execFileSync} from 'node:child_process';
import {constants, lstatSync, openSync, fstatSync, readSync, closeSync} from 'node:fs';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import {createDesktopUpdateDependencies, inspectQualifiedDesktopUpdate, type DesktopUpdateResult} from './desktop/qualified-update.js';
import {getDesktopUpdateTrustForProfile} from './desktop/update-trust.js';

const INSTALLED_PLIST = '/Applications/Phantom.app/Contents/Info.plist';
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** True only when the staged release is a higher major.minor.patch than the installed app. */
export function versionNewer(candidate: string, installed: string): boolean {
  const left = RELEASE_VERSION.exec(candidate);
  const right = RELEASE_VERSION.exec(installed);
  if (!left || !right) return false;
  for (let part = 1; part <= 3; part++) {
    const difference = Number(left[part]) - Number(right[part]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** Installed bundle identity. A stage file is not the running app. */
export function bundleVersionFromPlist(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row.CFBundleIdentifier !== 'ai.ashlr.desktop' || typeof row.CFBundleShortVersionString !== 'string') return null;
  return RELEASE_VERSION.test(row.CFBundleShortVersionString) ? row.CFBundleShortVersionString : null;
}

export function readInstalledBundleVersion(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const stdout = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', INSTALLED_PLIST], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 128 * 1024,
    });
    if (Buffer.byteLength(stdout, 'utf8') > 128 * 1024) return null;
    return bundleVersionFromPlist(JSON.parse(stdout));
  } catch { return null; }
}

export interface AppUpdateStatus {
  current: string | null;
  available: string | null;
  deferredReason: string | null;
  runningJobs: null;
  runningJobCount: number | null;
  unknownJobs: number | null;
}
export interface AppUpdateStatusDependencies {
  home: string;
  inspect(stage: string): {result: DesktopUpdateResult; runningJobCount: number; unknownJobs: number};
  /** Installed Phantom.app version. Omitted only by tests that have no bundle. */
  installedVersion?: () => string | null;
}
function stagePointer(home: string): string | null {
  let at = home;
  for (const part of ['.ashlr', 'updates']) {
    at = join(at, part);
    let stat;
    try {stat = lstatSync(at);} catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('unsafe status');
  }
  let fd: number;
  try {fd = openSync(join(at, 'native-stage.json'), constants.O_RDONLY | constants.O_NOFOLLOW);}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;}
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 1024) throw new Error('unsafe status');
    const buffer = Buffer.alloc(1025);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 1024) throw new Error('unsafe status');
    const value: unknown = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || !('stageId' in value) || typeof value.stageId !== 'string' || !/^[a-f0-9]{32}$/.test(value.stageId)) throw new Error('unsafe status');
    return value.stageId;
  } finally {closeSync(fd);}
}
function installedVersion(deps: AppUpdateStatusDependencies): string | null {
  if (!deps.installedVersion) return null;
  try {
    const version = deps.installedVersion();
    return typeof version === 'string' && RELEASE_VERSION.test(version) ? version : null;
  } catch { return null; }
}

export function readAppUpdateStatus(deps: AppUpdateStatusDependencies): AppUpdateStatus {
  const current = installedVersion(deps);
  const status: AppUpdateStatus = {current, available: null, deferredReason: null, runningJobs: null, runningJobCount: null, unknownJobs: null};
  try {
    const stage = stagePointer(deps.home);
    if (!stage) return current ? status : {...status, deferredReason: 'native-status-unavailable'};
    const observed = deps.inspect(stage);
    const staged = observed.result.version;
    const counts = {runningJobCount: observed.runningJobCount, unknownJobs: observed.unknownJobs};
    if (current && (!staged || !versionNewer(staged, current))) return {...status, ...counts};
    return {...status, available: staged, deferredReason: observed.result.reason, ...counts};
  } catch {
    return current ? status : {...status, deferredReason: 'native-status-unavailable'};
  }
}
/** The live inspection cmdApp and the Verse route share: the operator's own stage, read-only. */
export function defaultAppUpdateStatusDeps(): AppUpdateStatusDependencies {
  return {
    home: userInfo().homedir,
    installedVersion: readInstalledBundleVersion,
    inspect(stage: string) {
      const host = createDesktopUpdateDependencies(getDesktopUpdateTrustForProfile('canonical-v2'));
      const result = inspectQualifiedDesktopUpdate(stage, host);
      const admission = host.admission();
      return {result, runningJobCount: admission.leaseCount, unknownJobs: admission.unknownLeases};
    },
  };
}
