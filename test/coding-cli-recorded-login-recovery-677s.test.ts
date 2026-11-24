import { describe, expect, it } from 'vitest';

import {
  classifyRecordedLogin,
  RECORDED_LOGIN_PROVENANCE,
  RECORDED_LOGIN_UNPROVEN_CLAIMS,
  type RecordedLoginEvidence,
} from '../src/core/providers/coding-cli/recorded-login.js';

// Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886) interpretLogin().
// Every string here is synthetic and inert.

const ev = (over: Partial<RecordedLoginEvidence> = {}): RecordedLoginEvidence => ({
  observed: true,
  exitCode: 0,
  stdout: '',
  stderr: '',
  ...over,
});
const malformed = (fields: Record<string, unknown>) => fields as unknown as RecordedLoginEvidence;
const SENTINEL = 'SYNTHETIC-SENTINEL-LINE';

describe('recorded login classifier', () => {
  it('names the source PR, SHA and function, frozen', () => {
    expect(RECORDED_LOGIN_PROVENANCE).toEqual({
      sourcePr: 5952,
      sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
      sourceFunction: 'interpretLogin',
      basis: 'historical-offline',
    });
    expect(Object.isFrozen(RECORDED_LOGIN_PROVENANCE)).toBe(true);
    expect(Object.isFrozen(RECORDED_LOGIN_UNPROVEN_CLAIMS)).toBe(true);
  });

  // Truth table: [case, exitCode, stdout, stderr, outcome, reason].
  it.each([
    ['logged in', 0, 'Logged in as synthetic-user', '', 'logged-in', 'logged-in-phrase'],
    ['signed in', 0, 'signed in (fake)', '', 'logged-in', 'logged-in-phrase'],
    ['stderr-only signed in', 0, '', 'signed in', 'logged-in', 'logged-in-phrase'],
    ['not logged in', 0, 'Not logged in', '', 'logged-out', 'logged-out-phrase'],
    ['login expired', 0, 'login expired for fake-user', '', 'logged-out', 'logged-out-phrase'],
    ['please run login', 0, 'Please run the fake login command', '', 'logged-out', 'logged-out-phrase'],
    ['sign in prompt', 0, 'sign in to continue', '', 'logged-out', 'logged-out-phrase'],
    ['stderr-only sign in', 0, '', 'sign in', 'logged-out', 'logged-out-phrase'],
    ['logged-out beats logged-in text', 0, 'logged in earlier; not logged in now', '', 'logged-out', 'logged-out-phrase'],
    ['exit 0 no phrase', 0, 'ready', '', 'unknown', 'insufficient-evidence'],
    ['whitespace only', 0, ' \n\t ', '  ', 'unknown', 'insufficient-evidence'],
    ['irregular spacing', 0, 'logged   in', '', 'unknown', 'insufficient-evidence'],
    ['nonzero with login text', 1, 'logged in', '', 'unknown', 'nonzero-exit'],
    ['nonzero with logged-out text', 2, 'not logged in', '', 'logged-out', 'logged-out-phrase'],
    ['max exit code with login text', 4294967295, 'logged in', '', 'unknown', 'nonzero-exit'],
    ['split across streams (limitation)', 0, 'logged', 'in', 'unknown', 'insufficient-evidence'],
  ])('source truth table: %s', (_name, exitCode, stdout, stderr, outcome, reason) => {
    expect(classifyRecordedLogin(ev({ exitCode, stdout, stderr }))).toMatchObject({ outcome, reason });
  });

  it('ignores cache-only or unobserved text, whatever its other fields hold', () => {
    expect(classifyRecordedLogin(ev({ observed: false, stdout: 'logged in' }))).toMatchObject({
      outcome: 'unknown',
      reason: 'no-recorded-execution',
    });
    const junk = malformed({ observed: false, exitCode: 'x', stdout: 1, stderr: null });
    expect(classifyRecordedLogin(junk).reason).toBe('no-recorded-execution');
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['string', 'logged in'],
    ['observed not boolean', { observed: 'true', exitCode: 0, stdout: 'logged in', stderr: '' }],
    ['exit 0.5', { observed: true, exitCode: 0.5, stdout: '', stderr: '' }],
    ['exit -1', { observed: true, exitCode: -1, stdout: '', stderr: '' }],
    ['exit 2^32', { observed: true, exitCode: 4294967296, stdout: '', stderr: '' }],
    ['exit NaN', { observed: true, exitCode: Number.NaN, stdout: '', stderr: '' }],
    ['exit string', { observed: true, exitCode: '0', stdout: '', stderr: '' }],
    ['stdout number', { observed: true, exitCode: 0, stdout: 1, stderr: '' }],
    ['stderr missing', { observed: true, exitCode: 0, stdout: 'logged in' }],
  ])('malformed evidence (%s) is invalid-evidence', (_name, input) => {
    const got = classifyRecordedLogin(input as RecordedLoginEvidence);
    expect(got).toMatchObject({ outcome: 'unknown', reason: 'invalid-evidence', live: false });
  });

  it('every result is live=false, lists every unproven claim and never echoes output', () => {
    const cases = [
      ev({ stdout: `logged in ${SENTINEL}` }),
      ev({ stdout: `not logged in ${SENTINEL}` }),
      ev({ exitCode: 3, stderr: SENTINEL }),
      ev({ observed: false, stdout: SENTINEL }),
      malformed({ observed: true, exitCode: -5, stdout: SENTINEL, stderr: '' }),
    ];
    for (const input of cases) {
      const got = classifyRecordedLogin(input);
      expect(got.live).toBe(false);
      expect(got.unprovenClaims).toEqual([
        'present-login',
        'quota',
        'billing-eligibility',
        'model-access',
        'dispatch-authority',
      ]);
      expect(JSON.stringify(got)).not.toContain(SENTINEL);
    }
  });

  it('does not mutate the caller evidence', () => {
    const input = ev({ stdout: 'logged in', stderr: 'note' });
    const before = JSON.stringify(input);
    classifyRecordedLogin(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
