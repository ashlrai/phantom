/** Local desktop update inspection. Never downloads, installs, or restarts. */
import {constants, lstatSync, openSync, fstatSync, readSync, closeSync} from 'node:fs';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import {createDesktopUpdateDependencies, inspectQualifiedDesktopUpdate, type DesktopUpdateResult} from '../core/desktop/qualified-update.js';
import {getDesktopUpdateTrustForProfile} from '../core/desktop/update-trust.js';

const USAGE = 'usage: phm app update status [--json]';
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
export function readAppUpdateStatus(deps: AppUpdateStatusDependencies): AppUpdateStatus {
  const status: AppUpdateStatus = {current: null, available: null, deferredReason: null, runningJobs: null, runningJobCount: null, unknownJobs: null};
  try {
    const stage = stagePointer(deps.home);
    if (!stage) return {...status, deferredReason: 'native-status-unavailable'};
    const observed = deps.inspect(stage);
    return {...status, available: observed.result.version, deferredReason: observed.result.reason,
      runningJobCount: observed.runningJobCount, unknownJobs: observed.unknownJobs};
  } catch {return {...status, deferredReason: 'native-status-unavailable'};}
}
export async function cmdApp(args: string[], dependencies?: AppUpdateStatusDependencies): Promise<number> {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)) {console.log(USAGE); return 0;}
  if (args[0] !== 'update' || args[1] !== 'status' || args.length > 3 || args.length === 3 && args[2] !== '--json') {console.error(USAGE); return 2;}
  const deps = dependencies ?? {
    home: userInfo().homedir,
    inspect(stage: string) {
      const host = createDesktopUpdateDependencies(getDesktopUpdateTrustForProfile('canonical-v2'));
      const result = inspectQualifiedDesktopUpdate(stage, host);
      const admission = host.admission();
      return {result, runningJobCount: admission.leaseCount, unknownJobs: admission.unknownLeases};
    },
  };
  const status = readAppUpdateStatus(deps);
  console.log(args.includes('--json') ? JSON.stringify(status) :
    `Current app: ${status.current ?? 'unknown'}\nStaged version: ${status.available ?? 'unknown'}\nDeferred: ${status.deferredReason ?? 'none'}\nBlocking leases: ${status.runningJobCount ?? 'unknown'}\nUnknown leases: ${status.unknownJobs ?? 'unknown'}`);
  return status.deferredReason === 'native-status-unavailable' ? 1 : 0;
}
