import { describe, expect, it } from 'vitest';
import { stewardSchedule } from '../src/core/steward/schedule.js';

describe('steward schedule', () => {
  it('macOS: per-user LaunchAgent, report-only by default', () => {
    const [u] = stewardSchedule({ phmPath: '/opt/phm/bin/phm', apply: false, platform: 'darwin', home: '/Users/m' });
    expect(u!.path).toBe('/Users/m/Library/LaunchAgents/ai.ashlr.phm.steward.plist');
    expect(u!.contents).toContain('<string>steward</string><string>disk</string><string>--json</string>');
    expect(u!.contents).not.toContain('--apply');
  });
  it('linux: user service + timer, apply only when chosen', () => {
    const units = stewardSchedule({ phmPath: '/usr/local/bin/phm', apply: true, hour: 4, platform: 'linux', home: '/home/m' });
    expect(units.map((u) => u.path)).toEqual(['/home/m/.config/systemd/user/phm-steward.service', '/home/m/.config/systemd/user/phm-steward.timer']);
    expect(units[0]!.contents).toContain('"--apply"');
    expect(units[1]!.contents).toContain('OnCalendar=*-*-* 04:17:00');
  });
  it('rejects relative or injected phm paths', () => {
    expect(() => stewardSchedule({ phmPath: 'phm', apply: false, platform: 'linux', home: '/h' })).toThrow();
    expect(() => stewardSchedule({ phmPath: '/x\nExecStart=/bin/sh', apply: false, platform: 'linux', home: '/h' })).toThrow();
  });
});
