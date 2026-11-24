import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HEARTBEAT_SECONDS, MAX_DELAY_MS, MIN_DELAY_MS, emptySchedule, learnedGapMs, nextSchedule, parseResidentStatus,
  readResidentRequest, readSchedule, releaseRootFromCommand, residentRequest, residentRequestPath, settleResidentRequest,
  tickDue, updaterLaunchAgentPlist, writeResidentRequest, writeSchedule,
} from '../src/core/update/auto-update.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(join(tmpdir(), 'auto-update-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('learned cadence', () => {
  it('backs off while nothing ships and resets when a release appears', () => {
    let s = nextSchedule(emptySchedule(), '1.0.0', 0);
    expect(s.delayMs).toBe(MIN_DELAY_MS);
    s = nextSchedule(s, '1.0.0', 1); expect(s.delayMs).toBe(2 * MIN_DELAY_MS);
    s = nextSchedule(s, '1.0.0', 2); expect(s.delayMs).toBe(4 * MIN_DELAY_MS);
    for (let i = 0; i < 10; i++) s = nextSchedule(s, '1.0.0', 3 + i);
    expect(s.delayMs).toBe(MAX_DELAY_MS);
    s = nextSchedule(s, '1.0.1', 100); expect(s.delayMs).toBe(MIN_DELAY_MS); expect(s.nextAt).toBe(100 + MIN_DELAY_MS);
  });
  it('caps the delay by half the learned median release gap', () => {
    let s = nextSchedule(emptySchedule(), '1.0.0', 0);
    const gap = 8 * 60_000;
    for (let i = 1; i <= 4; i++) s = nextSchedule(s, `1.0.${i}`, i * gap);
    expect(learnedGapMs(s.seenAt)).toBe(gap);
    for (let i = 0; i < 8; i++) s = nextSchedule(s, '1.0.4', 4 * gap + i);
    expect(s.delayMs).toBe(gap / 2);
  });
  it('keeps backing off on a failed check without forgetting the version', () => {
    const s = nextSchedule(nextSchedule(emptySchedule(), '1.0.0', 0), null, 1);
    expect(s.lastVersion).toBe('1.0.0'); expect(s.delayMs).toBe(2 * MIN_DELAY_MS);
  });
  it('persists privately and gates ticks on nextAt', () => {
    const s = nextSchedule(emptySchedule(), '1.0.0', 1000);
    writeSchedule(s, home);
    expect(readSchedule(home)).toEqual(s);
    expect(tickDue(s, 1000)).toBe(false); expect(tickDue(s, 1000 + MIN_DELAY_MS)).toBe(true);
    expect(tickDue(readSchedule(join(home, 'missing')), 0)).toBe(true);
  });
});

describe('resident request', () => {
  const ok = JSON.stringify({ schema: 'ashlr.resident-status.v1', admission: { code: 'admitted', grantSeq: 25, reason: 'ok' } });
  const paused = JSON.stringify({ schema: 'ashlr.resident-status.v1', admission: { code: 'grant-inactive', grantSeq: 25, reason: 'authority code changed' } });
  it('asks only for the resident start when the new release is admitted', () => {
    expect(residentRequest('3.30.73', '/r', parseResidentStatus(ok), 0).commands).toEqual(['ashlr authority resident start']);
  });
  it('asks for re-approval first when the authority digest changed', () => {
    expect(residentRequest('3.30.73', '/r', parseResidentStatus(paused), 0).commands).toEqual(['ashlr authority re-approve', 'ashlr authority resident start']);
  });
  it('asks nothing when the status is unreadable', () => {
    expect(parseResidentStatus('nope')).toMatchObject({ code: null });
    expect(residentRequest('3.30.73', '/r', parseResidentStatus('nope'), 0).commands).toEqual([]);
  });
  it('settles only when the daemon runs the requested release', () => {
    const root = join(home, '.local/share/ashlr/releases', 'a'.repeat(64));
    writeResidentRequest(residentRequest('3.30.73', root, parseResidentStatus(ok), 0), home);
    expect(fs.statSync(residentRequestPath(home)).mode & 0o777).toBe(0o600);
    expect(settleResidentRequest(join(home, '.local/share/ashlr/releases', 'b'.repeat(64)), home, 1)).toBe(false);
    expect(settleResidentRequest(null, home, 1)).toBe(false);
    expect(settleResidentRequest(root, home, 7)).toBe(true);
    expect(readResidentRequest(home)).toBeNull();
    expect(fs.existsSync(join(home, '.ashlr-runs/update/resident-request.settled-7.json'))).toBe(true);
  });
  it('reads the release root from a daemon command line', () => {
    const leaf = 'f'.repeat(64);
    expect(releaseRootFromCommand(`/usr/bin/node ${home}/.local/share/ashlr/releases/${leaf}/bin/ashlr daemon start`, home))
      .toBe(join(home, '.local/share/ashlr/releases', leaf));
    expect(releaseRootFromCommand('/opt/homebrew/lib/node_modules/@ashlr/phantom/bin/ashlr daemon start', home)).toBeNull();
  });
});

describe('updater launch agent', () => {
  it('runs current/bin/ashlr with an explicit node under nice, as a heartbeat only', () => {
    const plist = updaterLaunchAgentPlist('/Users/example', '/opt/node/bin/node');
    expect(plist).toContain('<string>ai.ashlr.updater</string>');
    expect(plist).toContain('<string>/usr/bin/nice</string><string>-n</string><string>10</string><string>/opt/node/bin/node</string><string>/Users/example/.local/share/ashlr/current/bin/ashlr</string><string>update</string><string>--auto</string><string>--json</string>');
    expect(plist).not.toContain('current/phm');
    expect(plist).toContain(`<integer>${HEARTBEAT_SECONDS}</integer>`);
  });
});
