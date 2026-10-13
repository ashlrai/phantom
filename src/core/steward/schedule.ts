/**
 * Scheduled steward: a per-user launchd agent (macOS) or systemd user timer
 * (Linux) that runs `phm steward disk` daily. Report-only by default; `--apply`
 * must be chosen explicitly at install time (vendor sessions are archived, not
 * deleted). Nothing here runs as root or touches system paths.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STEWARD_LABEL = 'ai.ashlr.phm.steward';

export interface ScheduleUnit { path: string; contents: string; activate: string[] }

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function stewardSchedule(opts: { phmPath: string; apply: boolean; hour?: number; platform?: NodeJS.Platform; home?: string }): ScheduleUnit[] {
  const home = opts.home ?? homedir();
  const hour = Math.min(23, Math.max(0, Math.trunc(opts.hour ?? 3)));
  if (!/^\/[^\0\n]+$/.test(opts.phmPath)) throw new Error('phm path must be absolute.');
  const args = [opts.phmPath, 'steward', 'disk', ...(opts.apply ? ['--apply'] : []), '--json'];
  const log = join(home, '.ashlr', 'logs', 'steward.jsonl');
  if ((opts.platform ?? process.platform) === 'darwin') {
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
  const q = (a: string) => `"${a.replace(/(["\\$`])/g, '\\$1')}"`;
  return [
    { path: join(dir, 'phm-steward.service'), contents: `[Unit]\nDescription=Phantom steward (agent log disk guardrails)\n\n[Service]\nType=oneshot\nNice=10\nIOSchedulingClass=idle\nExecStart=${args.map(q).join(' ')}\nStandardOutput=append:${log}\nStandardError=append:${log}\n`, activate: [] },
    { path: join(dir, 'phm-steward.timer'), contents: `[Unit]\nDescription=Daily Phantom steward\n\n[Timer]\nOnCalendar=*-*-* ${String(hour).padStart(2, '0')}:17:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`, activate: ['systemctl', '--user', 'enable', '--now', 'phm-steward.timer'] },
  ];
}
