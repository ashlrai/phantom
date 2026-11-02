import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ScheduleUnit } from '../steward/schedule.js';

export const SELECTOR_LABEL = 'ai.ashlr.phm.selector';
export const SELECTOR_INTERVAL_SECONDS = 3600;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Hourly per-user launchd agent that runs `phm select --json`. macOS only: the selector runs on the Mac. */
export function selectorSchedule(opts: { phmPath: string; nodePath?: string; home?: string; platform?: NodeJS.Platform }): ScheduleUnit[] {
  if ((opts.platform ?? process.platform) !== 'darwin') throw new Error('The hourly selector schedule is macOS only.');
  const home = opts.home ?? homedir();
  const nodePath = opts.nodePath ?? process.execPath;
  for (const path of [home, opts.phmPath, nodePath]) {
    if (!isAbsolute(path) || [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
      throw new Error('Schedule paths must be absolute and contain no control characters.');
    }
  }
  const path = join(home, 'Library', 'LaunchAgents', `${SELECTOR_LABEL}.plist`);
  const log = join(home, '.ashlr-runs', 'selector', 'selector.log');
  const args = [nodePath, opts.phmPath, 'select', '--json'];
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SELECTOR_LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>StartInterval</key><integer>${SELECTOR_INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
  <key>LowPriorityIO</key><true/><key>Nice</key><integer>10</integer>
</dict></plist>
`;
  return [{ path, contents, activate: ['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 501}`, path] }];
}
