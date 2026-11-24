import { describe, expect, it } from 'vitest';
import {
  classifyRecordedModelProbe,
  RECORDED_MODEL_PROBE_PROVENANCE,
  UNPROVEN_CLAIMS,
  type RecordedModelProbeEvidence,
} from '../src/core/providers/coding-cli/recorded-model-probe.js';

const ok = (over: Partial<RecordedModelProbeEvidence> = {}): RecordedModelProbeEvidence => ({
  observed: true,
  exitCode: 0,
  stdout: 'probe-ok',
  stderr: '',
  ...over,
});

/** Verbatim copy of the historical PR #5952 interpretModelProbe, used as a differential oracle. */
function historicalInterpret(text: string, code: number): 'accepted' | 'rejected' {
  const REJECTED = /not available|unknown model|does not exist|rejected|model .*not found|invalid model/i;
  if (code !== 0 || REJECTED.test(text)) return 'rejected';
  if (text.trim() === '') return 'rejected';
  return 'accepted';
}

describe('recorded model probe recovery (#5952 interpretModelProbe)', () => {
  it('accepts a recorded successful probe with nonempty output as historical-only acceptance', () => {
    const r = classifyRecordedModelProbe(ok());
    expect(r.outcome).toBe('accepted');
    expect(r.reason).toBe('probe-accepted');
    expect(r.acceptance).toBe('historical-probe-only');
    expect(r.unprovenClaims).toEqual([
      'present-model-access',
      'login',
      'quota',
      'subscription-inclusion',
      'dispatch-authority',
    ]);
  });

  it('accepts output that appears only on stderr when exit is 0 and nothing rejects it', () => {
    const r = classifyRecordedModelProbe(ok({ stdout: '', stderr: 'probe-ok' }));
    expect(r.outcome).toBe('accepted');
  });

  it.each([
    ['empty stdout and stderr', '', ''],
    ['spaces', '   ', ' '],
    ['newlines and tabs', '\n\t', '\r\n'],
  ])('rejects whitespace-only output (%s) as empty', (_label, stdout, stderr) => {
    const r = classifyRecordedModelProbe(ok({ stdout, stderr }));
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('probe-empty-output');
    expect(r.acceptance).toBeNull();
  });

  it.each([1, 2, 127, 255, 4_294_967_295])('rejects nonzero exit %i even with good output', (exitCode) => {
    const r = classifyRecordedModelProbe(ok({ exitCode }));
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('probe-nonzero-exit');
    expect(r.acceptance).toBeNull();
  });

  it.each([
    'not available',
    'unknown model',
    'does not exist',
    'rejected',
    'model gpt-x not found',
    'invalid model',
  ])('rejects the source rejection phrase "%s" on stdout', (phrase) => {
    const r = classifyRecordedModelProbe(ok({ stdout: `error: ${phrase}` }));
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('probe-rejection-phrase');
  });

  it('matches rejection phrases case-insensitively, as the source did', () => {
    expect(classifyRecordedModelProbe(ok({ stdout: 'UNKNOWN MODEL' })).reason).toBe('probe-rejection-phrase');
  });

  it('rejects rejection text on stderr even when exit is 0', () => {
    const r = classifyRecordedModelProbe(ok({ stdout: 'probe-ok', stderr: 'Model is not available for this account' }));
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('probe-rejection-phrase');
  });

  it('treats a cache-only success-looking text with no recorded execution as unknown, never accepted', () => {
    const r = classifyRecordedModelProbe({
      observed: false,
      stdout: 'claude-candidate-model available ok',
      stderr: '',
    });
    expect(r.outcome).toBe('unknown');
    expect(r.reason).toBe('no-recorded-execution');
    expect(r.acceptance).toBeNull();
  });

  it('ignores exit code and output when no execution was recorded', () => {
    const r = classifyRecordedModelProbe({ observed: false, exitCode: 1, stdout: 'not available', stderr: 'x' });
    expect(r.outcome).toBe('unknown');
    expect(r.reason).toBe('no-recorded-execution');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, 4_294_967_296, Number.MAX_SAFE_INTEGER + 2])(
    'reports invalid exit code %s as unknown instead of rejected',
    (exitCode) => {
      const r = classifyRecordedModelProbe(ok({ exitCode }));
      expect(r.outcome).toBe('unknown');
      expect(r.reason).toBe('invalid-evidence');
      expect(r.acceptance).toBeNull();
    },
  );

  it('reports malformed evidence shapes as invalid-evidence', () => {
    const malformed = [
      undefined,
      null,
      'observed',
      { observed: 'yes', exitCode: 0, stdout: 'ok', stderr: '' },
      { observed: true, stdout: 'ok', stderr: '' },
      { observed: true, exitCode: 0, stdout: 42, stderr: '' },
      { observed: true, exitCode: 0, stdout: 'ok' },
    ] as unknown as RecordedModelProbeEvidence[];
    for (const evidence of malformed) {
      const r = classifyRecordedModelProbe(evidence);
      expect(r.outcome).toBe('unknown');
      expect(r.reason).toBe('invalid-evidence');
    }
  });

  it('does not mutate a frozen or unfrozen input', () => {
    const input = ok({ stdout: 'probe-ok', stderr: 'warn' });
    const before = JSON.stringify(input);
    const frozen = Object.freeze({ ...input });
    expect(() => classifyRecordedModelProbe(frozen)).not.toThrow();
    expect(classifyRecordedModelProbe(input).outcome).toBe('accepted');
    expect(JSON.stringify(input)).toBe(before);
    expect(input).toEqual({ observed: true, exitCode: 0, stdout: 'probe-ok', stderr: 'warn' });
  });

  it('never echoes captured text in the result', () => {
    const secretLike = 'SENTINEL-OUTPUT-671S';
    const r = classifyRecordedModelProbe(ok({ stdout: secretLike, stderr: 'not available' }));
    expect(JSON.stringify(r)).not.toContain(secretLike);
    expect(JSON.stringify(r)).not.toContain('not available');
  });

  it('carries source PR and SHA provenance and returns a frozen result', () => {
    const r = classifyRecordedModelProbe(ok());
    expect(r.provenance).toEqual({
      sourcePr: 5952,
      sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
      sourceFunction: 'interpretModelProbe',
      basis: 'historical-offline',
    });
    expect(r.provenance).toBe(RECORDED_MODEL_PROBE_PROVENANCE);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(UNPROVEN_CLAIMS)).toBe(true);
  });

  it('agrees with the historical classifier on every valid exit-code and output combination', () => {
    const codes = [0, 1, 2];
    const streams = ['', ' ', 'probe-ok', 'not available', 'Invalid Model', 'model x not found', 'does not exist'];
    for (const code of codes) {
      for (const stdout of streams) {
        for (const stderr of streams) {
          const expected = historicalInterpret(`${stdout}\n${stderr}`, code);
          const actual = classifyRecordedModelProbe(ok({ exitCode: code, stdout, stderr })).outcome;
          expect(actual, `code=${code} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`).toBe(expected);
        }
      }
    }
  });
});
