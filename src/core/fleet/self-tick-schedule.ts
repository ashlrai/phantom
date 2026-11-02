/**
 * Scheduled self-tick: a per-user launchd agent (macOS) or systemd user timer
 * (Linux) that runs `ashlr fleet self-tick` on an interval and again at
 * boot/login — Mason's Oct 31 order that Phantom runs itself and the Nov 1
 * 18:06 order that everything restarts with no human after a reboot. The tick
 * is a dry run unless `--apply` was chosen at install time. Nothing here runs
 * as root or touches system paths.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ScheduleUnit } from '../steward/schedule.js';

export const SELF_TICK_LABEL = 'ai.ashlr.phantom.self-tick';
export const SELF_TICK_DEFAULT_INTERVAL_SECONDS = 900;
export const SELF_TICK_MIN_INTERVAL_SECONDS = 300;
export const SELF_TICK_MAX_INTERVAL_SECONDS = 3600;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function selfTickSchedule(opts: {
  ashlrPath: string;
  nodePath?: string;
  apply: boolean;
  intervalSeconds?: number;
  runsDir?: string;
  platform?: NodeJS.Platform;
  home?: string;
}): ScheduleUnit[] {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') throw new Error('Self-tick scheduling supports macOS and Linux only.');
  const interval = opts.intervalSeconds ?? SELF_TICK_DEFAULT_INTERVAL_SECONDS;
  if (!Number.isInteger(interval) || interval < SELF_TICK_MIN_INTERVAL_SECONDS || interval > SELF_TICK_MAX_INTERVAL_SECONDS) {
    throw new Error(`intervalSeconds must be an integer from ${SELF_TICK_MIN_INTERVAL_SECONDS} to ${SELF_TICK_MAX_INTERVAL_SECONDS}.`);
  }
  const nodePath = opts.nodePath ?? process.execPath;
  for (const path of [home, opts.ashlrPath, nodePath, ...(opts.runsDir === undefined ? [] : [opts.runsDir])]) {
    if (!isAbsolute(path) || [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
      throw new Error('Schedule paths must be absolute and contain no control characters.');
    }
  }
  // OS service managers do not inherit the interactive shell's Node PATH.
  const args = [
    nodePath, opts.ashlrPath, 'fleet', 'self-tick', '--json',
    ...(opts.apply ? ['--apply'] : []),
    ...(opts.runsDir === undefined ? [] : ['--runs-dir', opts.runsDir]),
  ];
  const log = join(home, '.ashlr', 'logs', 'self-tick.jsonl');
  if (platform === 'darwin') {
    const path = join(home, 'Library', 'LaunchAgents', `${SELF_TICK_LABEL}.plist`);
    const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SELF_TICK_LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
  <key>LowPriorityIO</key><true/><key>Nice</key><integer>10</integer>
</dict></plist>
`;
    return [{ path, contents, activate: ['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 501}`, path] }];
  }
  const dir = join(home, '.config', 'systemd', 'user');
  // systemd expands % specifiers and argv $ variables even inside quotes.
  // The executable path itself does not undergo environment substitution.
  const q = (a: string, index: number) => {
    const escaped = a.replace(/(["\\])/g, '\\$1').replace(/%/g, '%%');
    return `"${index === 0 ? escaped : escaped.replace(/\$/g, () => '$$')}"`;
  };
  // StandardOutput takes the entire RHS as a path, not a quoted argv word.
  const output = `append:${log.replace(/%/g, '%%')}`;
  return [
    { path: join(dir, 'phm-self-tick.service'), contents: `[Unit]\nDescription=Phantom self-tick (fleet self-management pass)\n\n[Service]\nType=oneshot\nNice=10\nIOSchedulingClass=idle\nExecStart=${args.map(q).join(' ')}\nStandardOutput=${output}\nStandardError=${output}\n`, activate: ['systemctl', '--user', 'daemon-reload'] },
    { path: join(dir, 'phm-self-tick.timer'), contents: `[Unit]\nDescription=Phantom self-tick interval timer\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=${interval}s\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`, activate: ['systemctl', '--user', 'enable', '--now', 'phm-self-tick.timer'] },
  ];
}
