import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runCodingEvidenceCli } from '../src/core/providers/coding-cli/evidence-cli.js';
import {
  CODING_CLI_BILLING_CLASSES,
  CODING_CLI_ULTRA_CONSUMERS,
  assertFiniteNumber,
  clamp01,
  isExitCode,
  isFiniteNumber,
  isNonEmptyString,
  isRecord,
  requireNullableNulFreeIdentifier,
  requireNulFreeIdentifier,
  round6,
  validatePosteriorArmState,
  type PosteriorArmFields,
} from '../src/core/providers/coding-cli/validation.js';

const baseArm = (patch: Partial<PosteriorArmFields> = {}): PosteriorArmFields => ({
  alpha: 2,
  beta: 1,
  qualityMean: 0.9,
  qualityM2: 0.05,
  latencyMean: 1200,
  latencyM2: 400,
  tokenMean: 500,
  tokenM2: 100,
  tokenObservations: 2,
  observations: 3,
  ...patch,
});

describe('coding-cli shared validation primitives', () => {
  it('exposes the shared billing class and Grok Ultra consumer enums', () => {
    expect(CODING_CLI_BILLING_CLASSES).toEqual(['subscription', 'metered', 'local', 'loopback']);
    expect(CODING_CLI_ULTRA_CONSUMERS).toEqual(['orchestrator', 'cloud-agent']);
  });

  it('classifies plain records, finite numbers, non-empty strings, and uint32 exit codes', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('x')).toBe(false);

    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-1.5)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteNumber('1')).toBe(false);

    expect(isNonEmptyString('ok')).toBe(true);
    expect(isNonEmptyString('  ')).toBe(false);
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString(42)).toBe(false);

    expect(isExitCode(0)).toBe(true);
    expect(isExitCode(0xffff_ffff)).toBe(true);
    expect(isExitCode(-1)).toBe(false);
    expect(isExitCode(0x1_0000_0000)).toBe(false);
    expect(isExitCode(1.5)).toBe(false);
    expect(isExitCode('0')).toBe(false);
  });

  it('clamps to [0, 1] and rounds to 6 decimals without emitting -0', () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(1.5)).toBe(1);

    expect(round6(0.1234567)).toBe(0.123457);
    expect(round6(-0.1234567)).toBe(-0.123457);
    expect(Object.is(round6(-1e-9), 0)).toBe(true);
    expect(Number.isFinite(round6(1e303))).toBe(false);
  });

  it('validates NUL-free identifiers, finite numbers, non-negative integers, and posterior arm states', () => {
    expect(requireNulFreeIdentifier('pool-a', 'poolId')).toBe('pool-a');
    expect(() => requireNulFreeIdentifier('', 'poolId')).toThrow(TypeError);
    expect(() => requireNulFreeIdentifier('a\u0000b', 'poolId')).toThrow(TypeError);
    expect(requireNullableNulFreeIdentifier(null, 'consumer')).toBeNull();
    expect(requireNullableNulFreeIdentifier('orchestrator', 'consumer')).toBe('orchestrator');

    expect(assertFiniteNumber(3.5, 'x')).toBe(3.5);
    expect(() => assertFiniteNumber(Number.NaN, 'x')).toThrow(RangeError);

    expect(() => validatePosteriorArmState(baseArm())).not.toThrow();
    expect(() => validatePosteriorArmState(baseArm({ alpha: 0 }))).toThrow(RangeError);
    expect(() => validatePosteriorArmState(baseArm({ observations: -1 }))).toThrow(RangeError);
    expect(() => validatePosteriorArmState(baseArm({ observations: 1.2 }))).toThrow(RangeError);
    expect(() => validatePosteriorArmState(baseArm({ tokenObservations: 4, observations: 3 }))).toThrow(RangeError);

    const zeroTokensNonZeroMean = baseArm({ tokenObservations: 0, tokenMean: 10, tokenM2: 0 });
    expect(() => validatePosteriorArmState(zeroTokensNonZeroMean)).not.toThrow();
    class CustomError extends Error {}
    expect(() =>
      validatePosteriorArmState(zeroTokensNonZeroMean, (m) => new CustomError(m), {
        requireZeroTokensWhenUnobserved: true,
      }),
    ).toThrow(CustomError);
  });
});

describe('runCodingEvidenceCli', () => {
  const dirs: string[] = [];
  const makeDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-cli-evidence-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  class EvidenceDomainError extends Error {}
  const USAGE = 'Usage: test --evidence <file>';

  const invoke = (args: string[], evaluate: (raw: unknown) => unknown = (raw) => raw, maxBytes = 64) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runCodingEvidenceCli({
      args,
      usage: USAGE,
      maxBytes,
      errorClass: EvidenceDomainError,
      evaluate,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('prints usage for help flags and exits 2 on invalid CLI arguments', () => {
    expect(invoke(['--help'])).toEqual({ code: 0, out: USAGE, err: '' });
    expect(invoke([])).toMatchObject({ code: 2, out: '' });
    expect(invoke(['--evidence'])).toMatchObject({ code: 2, out: '' });
    expect(invoke(['--evidence', 'a.json', '--evidence', 'b.json'])).toMatchObject({ code: 2, out: '' });
    expect(invoke(['--unknown'])).toMatchObject({ code: 2, out: '' });
    expect(invoke(['positional'])).toMatchObject({ code: 2, out: '' });
  });

  it('refuses directories, oversized files, malformed JSON, and domain errors without leaking content', () => {
    const dir = makeDir();
    const sub = join(dir, 'subdir');
    mkdirSync(sub);
    expect(invoke(['--evidence', sub])).toMatchObject({ code: 1, err: 'error: evidence path is not a regular file' });

    const big = join(dir, 'big.json');
    writeFileSync(big, ' '.repeat(65));
    expect(invoke(['--evidence', big], (r) => r, 64)).toMatchObject({ code: 1, err: 'error: evidence file exceeds 64 bytes' });

    const badJson = join(dir, 'bad.json');
    writeFileSync(badJson, '{"secret_token": ');
    const badRes = invoke(['--evidence', badJson]);
    expect(badRes.code).toBe(1);
    expect(badRes.err).toBe('error: evidence file is not valid JSON');
    expect(badRes.err).not.toContain('secret_token');

    const okFile = join(dir, 'ok.json');
    writeFileSync(okFile, JSON.stringify({ value: 7 }));
    const domainRes = invoke(['--evidence', okFile], () => {
      throw new EvidenceDomainError('bad shape');
    });
    expect(domainRes).toEqual({ code: 1, out: '', err: 'error: bad shape' });

    expect(() =>
      invoke(['--evidence', okFile], () => {
        throw new RangeError('unexpected');
      }),
    ).toThrow(RangeError);

    const goodRes = invoke(['--evidence', okFile], (raw) => ({ parsed: raw }));
    expect(goodRes.code).toBe(0);
    expect(JSON.parse(goodRes.out)).toEqual({ parsed: { value: 7 } });
  });
});
