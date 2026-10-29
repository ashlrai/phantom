/**
 * Scheduled steward: a per-user launchd agent (macOS) or systemd user timer
 * (Linux) that runs `phm steward disk` daily. Report-only by default; `--apply`
 * must be chosen explicitly at install time (vendor sessions are archived, not
 * deleted). Nothing here runs as root or touches system paths.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const STEWARD_LABEL = 'ai.ashlr.phm.steward';

export interface ScheduleUnit { path: string; contents: string; activate: string[] }

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function stewardSchedule(opts: { phmPath: string; nodePath?: string; apply: boolean; hour?: number; platform?: NodeJS.Platform; home?: string }): ScheduleUnit[] {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') throw new Error('Steward scheduling supports macOS and Linux only.');
  const hour = opts.hour ?? 3;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('hour must be an integer from 0 to 23.');
  const nodePath = opts.nodePath ?? process.execPath;
  for (const path of [home, opts.phmPath, nodePath]) {
    if (!isAbsolute(path) || [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
      throw new Error('Schedule paths must be absolute and contain no control characters.');
    }
  }
  // OS service managers do not inherit the interactive shell's Node PATH.
  const args = [nodePath, opts.phmPath, 'steward', 'disk', ...(opts.apply ? ['--apply'] : []), '--json'];
  const log = join(home, '.ashlr', 'logs', 'steward.jsonl');
  if (platform === 'darwin') {
    const path = join(home, 'Library', 'LaunchAgents', `${STEWARD_LABEL}.plist`);
    const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${STEWARD_LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>17</integer></dict>
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
    { path: join(dir, 'phm-steward.service'), contents: `[Unit]\nDescription=Phantom steward (agent log disk guardrails)\n\n[Service]\nType=oneshot\nNice=10\nIOSchedulingClass=idle\nExecStart=${args.map(q).join(' ')}\nStandardOutput=${output}\nStandardError=${output}\n`, activate: ['systemctl', '--user', 'daemon-reload'] },
    { path: join(dir, 'phm-steward.timer'), contents: `[Unit]\nDescription=Daily Phantom steward\n\n[Timer]\nOnCalendar=*-*-* ${String(hour).padStart(2, '0')}:17:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`, activate: ['systemctl', '--user', 'enable', '--now', 'phm-steward.timer'] },
  ];
}
