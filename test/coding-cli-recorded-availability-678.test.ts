import { describe, expect, it } from 'vitest';
import {
  projectRecordedAvailability as project,
  RECORDED_AVAILABILITY_PROVENANCE,
  UNPROVEN_AVAILABILITY_CLAIMS,
  type RecordedAvailabilityAdapter,
  type RecordedAvailabilityEvidence,
  type RecordedCommandResult,
  type RecordedLoginClassification,
} from '../src/core/providers/coding-cli/recorded-availability.js';

// Plainly synthetic fixtures. No real credentials, URLs or machine paths.
const codex: RecordedAvailabilityAdapter = { id: 'codex', bin: 'synthetic-codex', versionArgs: ['--version'], statusArgs: ['login', 'status'], billing: 'synthetic-billing-a' };
const cursor: RecordedAvailabilityAdapter = { ...codex, id: 'cursor', statusArgs: null, billing: 'synthetic-billing-b' };
const grok: RecordedAvailabilityAdapter = { ...codex, id: 'grok', statusArgs: ['models'], billing: 'synthetic-billing-c' };
const devin: RecordedAvailabilityAdapter = { id: 'devin', bin: null, versionArgs: [], statusArgs: null, billing: null };

const versionOk: RecordedCommandResult = { code: 0, stdout: 'synthetic 1.0.0', stderr: '' };
const statusOk: RecordedCommandResult = { code: 0, stdout: 'synthetic status ready', stderr: '' };
const statusFail: RecordedCommandResult = { code: 1, stdout: '', stderr: 'synthetic status failure' };
const meteredStatus: RecordedCommandResult = { code: 0, stdout: 'synthetic models', stderr: 'note: XAI_API_KEY billing' };

/** Verbatim copy of PR #5952 probe.ts staging for well-formed inputs. Differential oracle. */
function sourceStaging(adapter: RecordedAvailabilityAdapter, version: RecordedCommandResult | null, status: RecordedCommandResult | null) {
  if (!adapter.bin || adapter.versionArgs.length === 0) return { binaryPresent: false, metered: false };
  if (!version || version.code !== 0 || version.stdout.trim() === '') return { binaryPresent: false, metered: false };
  if (!adapter.statusArgs || !status) return { binaryPresent: true, metered: false };
  return { binaryPresent: true, metered: adapter.id === 'grok' && /XAI_API_KEY/i.test(`${status.stdout}\n${status.stderr}`) };
}

/** Verbatim copy of PR #5952 interpretLogin, to check the non-Grok login path. */
function sourceInterpretLogin(text: string, code: number): RecordedLoginClassification {
  if (/not logged in|login expired|please run .*login|sign in/i.test(text)) return 'out';
  if (code === 0 && /logged in|signed in/i.test(text)) return 'in';
  return 'unknown';
}

describe('recorded coding-CLI availability projection (#5952 probeAvailability)', () => {
  it('stage 1: no configured binary or version command is not-configured, never present', () => {
    for (const adapter of [devin, { ...codex, bin: '   ' }, { ...codex, versionArgs: [] }]) {
      expect(project({ adapter, version: versionOk, status: statusOk, login: 'in' })).toMatchObject({ stage: 'no-binary-configured', versionCheck: 'not-configured', login: 'unknown' });
    }
    // A configured command shape alone is not evidence of a binary.
    expect(project({ adapter: codex }).versionCheck).not.toBe('responded');
  });

  it.each([undefined, null])('absent version recording (%s) is unrecorded, not failed', (version) => {
    expect(project({ adapter: codex, version, status: statusFail, login: 'out' })).toMatchObject({
      stage: 'version-unrecorded', versionCheck: 'unrecorded', statusCheck: 'not-reached', login: 'unknown', meteredStatusObservation: false,
    });
  });

  it.each([1, 2, 127, 4_294_967_295])('stage 2: nonzero version exit %i is failed even with stdout', (code) => {
    expect(project({ adapter: codex, version: { code, stdout: 'synthetic 1.0.0', stderr: '' }, status: statusOk, login: 'in' })).toMatchObject({
      stage: 'version-nonzero-exit', versionCheck: 'failed', statusCheck: 'not-reached', login: 'unknown',
    });
  });

  it.each(['', '   ', '\n\t\r\n'])('stage 2: exit 0 with blank stdout %j is failed; stderr is not version output', (stdout) => {
    expect(project({ adapter: codex, version: { code: 0, stdout, stderr: 'synthetic stderr only' } })).toMatchObject({ stage: 'version-blank-output', versionCheck: 'failed' });
  });

  it('stage 3: responded version with no status command leaves login unprobed, ignoring caller login', () => {
    expect(project({ adapter: cursor, version: versionOk, login: 'in' })).toMatchObject({
      stage: 'version-responded-no-status-command', versionCheck: 'responded', statusCheck: 'not-applicable', login: 'unknown', billingAsRecorded: 'synthetic-billing-b',
    });
  });

  it('missing status recording is unrecorded, distinct from a failed status', () => {
    expect(project({ adapter: codex, version: versionOk, login: 'in' })).toMatchObject({ stage: 'status-unrecorded', statusCheck: 'unrecorded', login: 'unknown' });
    expect(project({ adapter: codex, version: versionOk, status: statusFail }).statusCheck).toBe('failed');
  });

  it('stage 4: recorded status success takes the caller login; failure downgrades in to unknown', () => {
    expect(project({ adapter: codex, version: versionOk, status: statusOk, login: 'in' })).toMatchObject({ stage: 'status-recorded', statusCheck: 'succeeded', login: 'in', billingAsRecorded: 'synthetic-billing-a' });
    expect(project({ adapter: codex, version: versionOk, status: statusFail, login: 'out' })).toMatchObject({ statusCheck: 'failed', login: 'out' });
    expect(project({ adapter: codex, version: versionOk, status: statusFail, login: 'in' })).toMatchObject({ statusCheck: 'failed', login: 'unknown' });
    expect(project({ adapter: codex, version: versionOk, status: statusOk }).login).toBe('unknown');
  });

  it('matches source interpretLogin for non-Grok adapters when the caller supplies the source class', () => {
    const statuses: RecordedCommandResult[] = [
      { code: 0, stdout: 'synthetic signed in', stderr: '' },
      { code: 0, stdout: 'synthetic not logged in', stderr: '' },
      { code: 3, stdout: 'synthetic signed in', stderr: '' },
      { code: 0, stdout: 'synthetic plain', stderr: '' },
    ];
    for (const status of statuses) {
      const login = sourceInterpretLogin(`${status.stdout}\n${status.stderr}`, status.code);
      expect(project({ adapter: codex, version: versionOk, status, login }).login).toBe(login);
    }
  });

  it('Grok metered wording is an observation only: billing, login and eligibility are untouched', () => {
    expect(project({ adapter: grok, version: versionOk, status: meteredStatus, login: 'in' })).toMatchObject({
      stage: 'status-recorded', meteredStatusObservation: true, billingAsRecorded: 'synthetic-billing-c', login: 'in',
    });
    expect(project({ adapter: grok, version: versionOk, status: meteredStatus }).unprovenClaims).toContain('paid-eligibility');
    // Case-insensitive, and read regardless of exit code, as the source did.
    expect(project({ adapter: grok, version: versionOk, status: { code: 0, stdout: 'xai_api_key', stderr: '' } }).meteredStatusObservation).toBe(true);
    expect(project({ adapter: grok, version: versionOk, status: { code: 1, stdout: '', stderr: 'XAI_API_KEY' } })).toMatchObject({ meteredStatusObservation: true, statusCheck: 'failed' });
    // False without the wording, for non-Grok adapters, and when status is unrecorded.
    expect(project({ adapter: grok, version: versionOk, status: statusOk }).meteredStatusObservation).toBe(false);
    expect(project({ adapter: codex, version: versionOk, status: meteredStatus }).meteredStatusObservation).toBe(false);
    expect(project({ adapter: grok, version: versionOk }).meteredStatusObservation).toBe(false);
  });

  it('attaches fixed provenance and the full unproven-claims list on every outcome', () => {
    expect(RECORDED_AVAILABILITY_PROVENANCE).toMatchObject({
      sourcePr: 5952,
      sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
      sourceFunction: 'probeAvailability',
      meteredSource: 'src/core/providers/coding-cli/adapters.ts grokOutputIsMetered',
      execution: 'none',
      liveEligibility: 'not-granted',
    });
    expect(Object.isFrozen(RECORDED_AVAILABILITY_PROVENANCE)).toBe(true);
    expect(UNPROVEN_AVAILABILITY_CLAIMS).toHaveLength(9);
    for (const r of [project({ adapter: devin }), project({ adapter: codex, version: versionOk, status: statusOk, login: 'in' })]) {
      expect(r.unprovenClaims).toEqual(UNPROVEN_AVAILABILITY_CLAIMS);
    }
  });

  it('never echoes stdout, stderr, binary paths, args or a rejected id', () => {
    const marker = 'SYNTHETIC-RAW-MARKER-678';
    const r = project({
      adapter: { ...grok, bin: '/synthetic/bin/grok-678', versionArgs: ['--synthetic-678'] },
      version: { code: 0, stdout: `${marker} v`, stderr: marker },
      status: { code: 0, stdout: `${marker} m`, stderr: `${marker} XAI_API_KEY` },
      login: 'in',
    });
    const serialized = JSON.stringify(r);
    for (const leak of [marker, '/synthetic/bin', '--synthetic-678']) expect(serialized).not.toContain(leak);
    expect(r.meteredStatusObservation).toBe(true);
    expect(project({ adapter: { ...codex, id: 'Has Spaces' } })).toMatchObject({ id: null, stage: 'invalid-evidence' });
  });

  describe('invalid evidence is unknown, not failed or unavailable', () => {
    const bad: Array<[string, RecordedAvailabilityEvidence]> = [
      ['fractional exit code', { adapter: codex, version: { code: 1.5, stdout: 'x', stderr: '' } }],
      ['NaN exit code', { adapter: codex, version: { code: Number.NaN, stdout: 'x', stderr: '' } }],
      ['negative exit code', { adapter: codex, version: { code: -1, stdout: 'x', stderr: '' } }],
      ['exit code above 2^32-1', { adapter: codex, version: { code: 4_294_967_296, stdout: 'x', stderr: '' } }],
      ['non-string stdout', { adapter: codex, version: { code: 0, stdout: 7 as unknown as string, stderr: '' } }],
      ['null stderr in status', { adapter: codex, version: versionOk, status: { code: 0, stdout: '', stderr: null as unknown as string } }],
      ['unknown login class', { adapter: codex, version: versionOk, status: statusOk, login: 'maybe' as RecordedLoginClassification }],
      ['numeric billing', { adapter: { ...codex, billing: 3 as unknown as string } }],
      ['missing statusArgs', { adapter: { ...codex, statusArgs: undefined as unknown as null } }],
      ['non-string versionArgs', { adapter: { ...codex, versionArgs: [1] as unknown as string[] } }],
      ['non-string binary', { adapter: { ...codex, bin: 9 as unknown as string } }],
      ['missing adapter', { adapter: undefined as unknown as RecordedAvailabilityAdapter }],
    ];
    it.each(bad)('rejects %s', (_label, evidence) => {
      expect(project(evidence)).toMatchObject({ stage: 'invalid-evidence', versionCheck: 'unknown', statusCheck: 'unknown', login: 'unknown', billingAsRecorded: null, meteredStatusObservation: false });
    });
    it('keeps a valid id on invalid evidence', () => {
      expect(project({ adapter: { ...codex, billing: 3 as unknown as string } }).id).toBe('codex');
    });
  });

  it('is pure and deterministic: input unchanged, repeated calls equal', () => {
    const cases: RecordedAvailabilityEvidence[] = [
      { adapter: devin },
      { adapter: codex },
      { adapter: codex, version: { code: 1, stdout: '', stderr: 'x' } },
      { adapter: cursor, version: versionOk, login: 'in' },
      { adapter: codex, version: versionOk, status: statusFail, login: 'in' },
      { adapter: grok, version: versionOk, status: meteredStatus, login: 'out' },
    ];
    for (const input of cases) {
      const before = structuredClone(input);
      expect(project(input)).toEqual(project(input));
      expect(input).toEqual(before);
    }
  });

  it('agrees with the source on binary evidence and Grok metered wording for every well-formed combination', () => {
    const versions: Array<RecordedCommandResult | null> = [
      null,
      { code: 0, stdout: 'synthetic 1.0.0', stderr: '' },
      { code: 0, stdout: '  ', stderr: 'synthetic stderr' },
      { code: 3, stdout: 'synthetic 1.0.0', stderr: '' },
    ];
    const statuses: Array<RecordedCommandResult | null> = [
      null,
      { code: 0, stdout: 'synthetic ok', stderr: '' },
      { code: 0, stdout: 'XAI_API_KEY', stderr: '' },
      { code: 1, stdout: '', stderr: 'XAI_API_KEY' },
    ];
    for (const adapter of [codex, cursor, grok, devin]) {
      for (const version of versions) {
        for (const status of statuses) {
          const source = sourceStaging(adapter, version, status);
          const r = project({ adapter, version, status });
          if (version === null && adapter.bin && adapter.versionArgs.length > 0) {
            // Absent is 'unrecorded' by design, so it is not compared against the source.
            expect(r.versionCheck).toBe('unrecorded');
            continue;
          }
          expect(r.versionCheck === 'responded').toBe(source.binaryPresent);
          expect(r.meteredStatusObservation).toBe(source.metered);
        }
      }
    }
  });
});
