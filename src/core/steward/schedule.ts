/**
 * Scheduled per-user maintenance jobs: a launchd agent (macOS) or systemd
 * user timer (Linux) that runs a `phm` verb daily. Report-only by default;
 * `--apply` must be chosen explicitly at install time (vendor sessions are
 * archived, not deleted). Nothing here runs as root or touches system paths.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const STEWARD_LABEL = 'ai.ashlr.phm.steward';

export interface ScheduleUnit { path: string; contents: string; activate: string[] }

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface DailyJobSpec {
  /** launchd label and plist filename stem, e.g. ai.ashlr.phm.steward. */
  label: string;
  /** systemd unit filename stem, e.g. phm-steward → phm-steward.service. */
  fileStem: string;
  /** Words after `[nodePath, phmPath]` in the job argv. */
  command: string[];
  /** systemd [Unit] Description and the launchd-adjacent human name. */
  description: string;
  /** Minute inside the chosen hour; staggers jobs sharing an hour. */
  minute: number;
  /** Stdout/stderr sink, a file path under the user's own state dir. */
  log: string;
}

export function dailyUserSchedule(spec: DailyJobSpec, opts: { phmPath: string; nodePath?: string; hour?: number; platform?: NodeJS.Platform; home?: string }): ScheduleUnit[] {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') throw new Error('Scheduling supports macOS and Linux only.');
  const hour = opts.hour ?? 3;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('hour must be an integer from 0 to 23.');
  if (!Number.isInteger(spec.minute) || spec.minute < 0 || spec.minute > 59) throw new Error('minute must be an integer from 0 to 59.');
  const nodePath = opts.nodePath ?? process.execPath;
  for (const path of [home, opts.phmPath, nodePath]) {
    if (!isAbsolute(path) || [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
      throw new Error('Schedule paths must be absolute and contain no control characters.');
    }
  }
  // OS service managers do not inherit the interactive shell's Node PATH.
  const args = [nodePath, opts.phmPath, ...spec.command];
  const log = spec.log;
  if (platform === 'darwin') {
    const path = join(home, 'Library', 'LaunchAgents', `${spec.label}.plist`);
    const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${spec.label}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${spec.minute}</integer></dict>
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
    { path: join(dir, `${spec.fileStem}.service`), contents: `[Unit]\nDescription=${spec.description}\n\n[Service]\nType=oneshot\nNice=10\nIOSchedulingClass=idle\nExecStart=${args.map(q).join(' ')}\nStandardOutput=${output}\nStandardError=${output}\n`, activate: ['systemctl', '--user', 'daemon-reload'] },
    { path: join(dir, `${spec.fileStem}.timer`), contents: `[Unit]\nDescription=Daily ${spec.description}\n\n[Timer]\nOnCalendar=*-*-* ${String(hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`, activate: ['systemctl', '--user', 'enable', '--now', `${spec.fileStem}.timer`] },
  ];
}

export function stewardSchedule(opts: { phmPath: string; nodePath?: string; apply: boolean; hour?: number; platform?: NodeJS.Platform; home?: string }): ScheduleUnit[] {
  const home = opts.home ?? homedir();
  return dailyUserSchedule({
    label: STEWARD_LABEL,
    fileStem: 'phm-steward',
    command: ['steward', 'disk', ...(opts.apply ? ['--apply'] : []), '--json'],
    description: 'Phantom steward (agent log disk guardrails)',
    minute: 17,
    log: join(home, '.ashlr', 'logs', 'steward.jsonl'),
  }, opts);
}
