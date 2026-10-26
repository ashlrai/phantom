/**
 * Enrollment reads under ~/.ashlr directory churn.
 *
 * Any atomic write of an unrelated file directly in ~/.ashlr (backlog, locks)
 * moves the directory ctime. The registry read binds to the directory identity,
 * so a sibling write during the read must not turn into a spurious "repo not
 * enrolled" denial; it is re-read a bounded number of times. Persistent churn
 * and real identity changes still fail closed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  enrollmentPath,
  isEnrolled,
  readEnrollmentRegistry,
  setEnrollmentReadRaceHookForTest,
} from '../src/core/sandbox/policy.js';

const SLEEP = new Int32Array(new SharedArrayBuffer(4));

let root: string;
let home: string;
let repo: string;
let priorHome: string | undefined;
let priorProfile: string | undefined;

/** Atomically write a sibling of enrollment.json, as backlog.json writers do. */
function churnAuthorityDirectory(tag: string): void {
  // Outlast coarse filesystem timestamp granularity so the ctime really moves.
  Atomics.wait(SLEEP, 0, 0, 20);
  const authority = join(home, '.ashlr');
  const tmp = join(authority, `.backlog.${tag}.tmp`);
  writeFileSync(tmp, `{"tag":"${tag}"}\n`, { mode: 0o600 });
  renameSync(tmp, join(authority, 'backlog.json'));
}

beforeEach(() => {
  priorHome = process.env['HOME'];
  priorProfile = process.env['USERPROFILE'];
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-enroll-churn-')));
  home = join(root, 'home');
  repo = join(root, 'repo');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(repo, { mode: 0o700 });
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  mkdirSync(join(home, '.ashlr'), { mode: 0o700 });
  writeFileSync(enrollmentPath(), `${JSON.stringify({ repos: [repo] })}\n`, { mode: 0o600 });
});

afterEach(() => {
  setEnrollmentReadRaceHookForTest(undefined);
  if (priorHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = priorHome;
  if (priorProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = priorProfile;
  rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform !== 'win32')('enrollment registry read under ~/.ashlr churn', () => {
  it('re-reads after a sibling atomic write moves the directory ctime', () => {
    let calls = 0;
    setEnrollmentReadRaceHookForTest(() => {
      calls += 1;
      if (calls === 1) churnAuthorityDirectory('one-shot');
    });

    expect(readEnrollmentRegistry()).toEqual({ state: 'ready', repos: [repo], reason: 'healthy' });
    expect(calls).toBe(2);

    calls = 0;
    expect(isEnrolled(repo)).toBe(true);
    expect(calls).toBe(2);
  });

  it('still fails closed when the directory never stabilizes, after a bounded number of reads', () => {
    let calls = 0;
    setEnrollmentReadRaceHookForTest(() => {
      calls += 1;
      churnAuthorityDirectory(`persistent-${calls}`);
    });

    expect(readEnrollmentRegistry()).toEqual({ state: 'degraded', reason: 'registry-identity-changed' });
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(5);

    calls = 0;
    expect(isEnrolled(repo)).toBe(false);
  });

  it('does not retry a registry file replaced during the read', () => {
    let calls = 0;
    setEnrollmentReadRaceHookForTest(() => {
      calls += 1;
      const tmp = join(home, '.ashlr', '.enrollment.injected.tmp');
      writeFileSync(tmp, `${JSON.stringify({ repos: [repo, home] })}\n`, { mode: 0o600 });
      renameSync(tmp, enrollmentPath());
    });

    expect(readEnrollmentRegistry()).toEqual({ state: 'degraded', reason: 'registry-identity-changed' });
    expect(calls).toBe(1);
  });

  it('does not retry an authority directory swapped for a different object', () => {
    const authority = join(home, '.ashlr');
    const displaced = join(home, '.ashlr-displaced');
    let calls = 0;
    setEnrollmentReadRaceHookForTest(() => {
      calls += 1;
      renameSync(authority, displaced);
      mkdirSync(authority, { mode: 0o700 });
      writeFileSync(enrollmentPath(), `${JSON.stringify({ repos: [repo] })}\n`, { mode: 0o600 });
    });

    expect(readEnrollmentRegistry()).toEqual({ state: 'degraded', reason: 'registry-identity-changed' });
    expect(calls).toBe(1);
  });
});
