import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { driveLoop, type DriveDependencies } from '../core/drive/supervisor.js';
import { checkDrivePublisher, ScriptDriveBridge } from '../core/drive/script-bridge.js';

const HELP = `Usage: phm drive [--once] [--dry-run] [--tick <seconds>]
                 [--bridge <absolute-path>] [--publisher <absolute-path/publish.sh>]
                 [--pause-file <absolute-path>]

Use phm drive report, phm drive levers, or phm drive jobs for local reporting.

Supervise the host queue through the phm-drive/v1 bridge. Default tick: 30s.
--once --dry-run reads and plans only. No reaping, launch, publishing or writes.
Live operation requires a host bridge implementing shared dispatchd ownership,
DRIVER-1 transitions and #1014 admission. See docs/DRIVE.md before cutover.
The command never installs a service or stops dispatchd.
`;

export interface DriveOptions {
  once: boolean; dryRun: boolean; tickMs: number; bridge: string; publisher: string; pauseFile: string;
}
export function parseDriveOptions(args: string[], home = homedir()): DriveOptions {
  const root = join(home, '.ashlr-runs', 'queue');
  const options: DriveOptions = { once: false, dryRun: false, tickMs: 30_000,
    bridge: join(root, 'drive-bridge'), publisher: join(root, 'publish.sh'), pauseFile: join(home, '.ashlr-runs', 'PAUSE') };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (seen.has(arg)) throw new Error('Duplicate drive option');
    seen.add(arg);
    if (arg === '--once') options.once = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (['--tick', '--bridge', '--publisher', '--pause-file'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('Missing drive option value');
      if (arg === '--tick') {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 86_400) throw new Error('Drive tick must be between 1 and 86400 seconds');
        options.tickMs = Number(value) * 1000;
      } else {
        if (!isAbsolute(value)) throw new Error('Drive paths must be absolute');
        if (arg === '--bridge') options.bridge = value;
        else if (arg === '--publisher') options.publisher = value;
        else options.pauseFile = value;
      }
    } else throw new Error('Unknown drive option');
  }
  return options;
}

/** Permission errors and dangling symlinks are holds, never an absent PAUSE. */
export async function driveControlPresent(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

export async function cmdDrive(args: string[], dependencies?: DriveDependencies): Promise<number> {
  if (args[0] === 'report' || args[0] === 'jobs' || args[0] === 'levers') {
    const { cmdDriveReport, cmdDriveLevers } = await import('./drive-routines.js');
    return args[0] === 'levers' ? cmdDriveLevers(args.slice(1)) :
      cmdDriveReport(args[0] === 'jobs' ? args : args.slice(1));
  }
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(HELP); return 0; }
  let options: DriveOptions;
  try { options = parseDriveOptions(args); }
  catch { console.error('Invalid drive arguments. Run phm drive --help.'); return 2; }
  const bridge = new ScriptDriveBridge(options.bridge);
  const deps = dependencies ?? {
    bridge,
    paused: async () => await driveControlPresent(options.pauseFile) || await driveControlPresent(join(homedir(), '.ashlr', 'KILL')),
    publish: (job: string, lease: string) => bridge.publish(options.publisher, job, lease),
  };
  const controller = new AbortController();
  const stop = (): void => { controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    // Configuration errors must not consume a durable publication reservation.
    if (!dependencies && !options.dryRun) await checkDrivePublisher(options.publisher);
    await driveLoop(deps, { ...options, signal: controller.signal,
      report: report => { console.log(JSON.stringify(report)); },
      error: () => { console.error('Drive tick failed; no further actions this tick. Check the private bridge logs.'); },
    });
    return 0;
  } catch {
    console.error('Drive failed. Verify the host bridge contract and private logs; dispatchd was not changed.');
    return 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
