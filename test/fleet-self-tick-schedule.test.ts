/**
 * RQ-PHX-SELFTICKSCHEDULE02 — `selfTickSchedule` builds the per-user launchd
 * agent / systemd timer that runs `fleet self-tick` on an interval and at
 * boot. Pure-builder tests: paths, escaping, interval bounds and platform
 * refusals, mirroring steward-schedule.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  SELF_TICK_LABEL,
  selfTickSchedule,
} from '../src/core/fleet/self-tick-schedule.js';

describe('self-tick schedule builder', () => {
  it('darwin: per-user LaunchAgent with StartInterval 900, RunAtLoad and a dry-run tick', () => {
    const [u] = selfTickSchedule({ ashlrPath: '/opt/ashlr/bin/ashlr', apply: false, platform: 'darwin', home: '/Users/m' });
    expect(u!.path).toBe(`/Users/m/Library/LaunchAgents/${SELF_TICK_LABEL}.plist`);
    expect(u!.contents).toContain(`<key>Label</key><string>${SELF_TICK_LABEL}</string>`);
    expect(u!.contents).toContain('<key>StartInterval</key><integer>900</integer>');
    expect(u!.contents).toContain('<key>RunAtLoad</key><true/>');
    expect(u!.contents).toContain('<string>fleet</string><string>self-tick</string><string>--json</string>');
    expect(u!.contents).not.toContain('--apply');
    expect(u!.contents).not.toContain('--runs-dir');
    expect(u!.contents).toContain('<key>LowPriorityIO</key><true/><key>Nice</key><integer>10</integer>');
    expect(u!.contents).toContain('<string>/Users/m/.ashlr/logs/self-tick.jsonl</string>');
    expect(u!.activate).toEqual(['launchctl', 'bootstrap', expect.stringMatching(/^gui\/\d+$/), u!.path]);
  });

  it('--apply reaches ProgramArguments only when apply is true', () => {
    const dry = selfTickSchedule({ ashlrPath: '/bin/ashlr', apply: false, platform: 'darwin', home: '/h' });
    expect(dry[0]!.contents).not.toContain('--apply');
    const on = selfTickSchedule({ ashlrPath: '/bin/ashlr', apply: true, platform: 'darwin', home: '/h' });
    expect(on[0]!.contents).toContain('<string>--apply</string>');
    const linux = selfTickSchedule({ ashlrPath: '/bin/ashlr', apply: true, platform: 'linux', home: '/h' });
    expect(linux[0]!.contents).toContain('"--apply"');
  });

  it('passes --runs-dir <abs> only when given', () => {
    const pinned = selfTickSchedule({ ashlrPath: '/bin/ashlr', apply: false, runsDir: '/var/ashlr-runs', platform: 'darwin', home: '/h' });
    expect(pinned[0]!.contents).toContain('<string>--runs-dir</string><string>/var/ashlr-runs</string>');
  });

  it('honours a custom interval in both backends', () => {
    const [u] = selfTickSchedule({ ashlrPath: '/bin/ashlr', apply: false, intervalSeconds: 600, platform: 'darwin', home: '/h' });
    expect(u!.contents).toContain('<key>StartInterval</key><integer>600</integer>');
    const linux = selfTickSchedule({ ashlrPath: '/bin/ashlr', apply: false, intervalSeconds: 3600, platform: 'linux', home: '/h' });
    expect(linux[1]!.contents).toContain('OnUnitActiveSec=3600s');
  });

  it('escapes XML special characters in paths', () => {
    const [u] = selfTickSchedule({ ashlrPath: '/path with & <tags>/ashlr', nodePath: '/node/bin/node', apply: false, platform: 'darwin', home: '/h' });
    expect(u!.contents).toContain('<string>/node/bin/node</string><string>/path with &amp; &lt;tags&gt;/ashlr</string>');
  });

  it('rejects relative paths and control characters in every path field', () => {
    expect(() => selfTickSchedule({ ashlrPath: 'ashlr', apply: false, platform: 'linux', home: '/h' })).toThrow(/paths/);
    expect(() => selfTickSchedule({ ashlrPath: '/bin/ashlr', apply: false, runsDir: 'rel/dir', platform: 'linux', home: '/h' })).toThrow(/paths/);
    for (const path of ['/path\rInjected', '/path\u007fbad', '/path\nExecStart=/bin/sh']) {
      for (const field of ['ashlrPath', 'nodePath', 'home', 'runsDir'] as const) {
        expect(() => selfTickSchedule({ ashlrPath: '/bin/ashlr', apply: false, platform: 'linux', home: '/h', [field]: path })).toThrow(/paths/);
      }
    }
  });

  it.each([120, 299, 7200, 3601, 3.5, NaN, Infinity])('rejects interval %s', (intervalSeconds) => {
    expect(() => selfTickSchedule({ ashlrPath: '/bin/ashlr', apply: false, intervalSeconds, platform: 'linux', home: '/h' })).toThrow(/intervalSeconds/);
  });

  it('linux: oneshot service plus a boot-and-interval timer', () => {
    const units = selfTickSchedule({ ashlrPath: '/usr/local/bin/ashlr', apply: false, platform: 'linux', home: '/home/m' });
    expect(units.map((u) => u.path)).toEqual([
      '/home/m/.config/systemd/user/phm-self-tick.service',
      '/home/m/.config/systemd/user/phm-self-tick.timer',
    ]);
    expect(units[0]!.contents).toContain('Type=oneshot');
    expect(units[0]!.contents).toContain('"/usr/local/bin/ashlr" "fleet"');
    expect(units[0]!.contents).toContain('"fleet" "self-tick" "--json"');
    expect(units[0]!.contents).toContain('StandardOutput=append:/home/m/.ashlr/logs/self-tick.jsonl');
    expect(units[1]!.contents).toContain('OnBootSec=2min');
    expect(units[1]!.contents).toContain('OnUnitActiveSec=900s');
    expect(units[1]!.contents).toContain('WantedBy=timers.target');
    expect(units[0]!.activate).toEqual(['systemctl', '--user', 'daemon-reload']);
    expect(units[1]!.activate).toEqual(['systemctl', '--user', 'enable', '--now', 'phm-self-tick.timer']);
  });

  it('quotes systemd argv and neutralizes variable and specifier expansion', () => {
    const [unit] = selfTickSchedule({ ashlrPath: '/a b/"$HOME%h\\ashlr', nodePath: '/node $USER%h/bin/node', apply: false, platform: 'linux', home: '/home/a b%u' });
    expect(unit!.contents).toContain('ExecStart="/node $USER%%h/bin/node" "/a b/\\"$$HOME%%h\\\\ashlr" "fleet" "self-tick" "--json"');
    expect(unit!.contents).toContain('StandardOutput=append:/home/a b%%u/.ashlr/logs/self-tick.jsonl');
  });

  it('refuses unsupported platforms', () => {
    expect(() => selfTickSchedule({ ashlrPath: '/bin/ashlr', apply: false, platform: 'win32' })).toThrow(/macOS and Linux/);
  });
});
