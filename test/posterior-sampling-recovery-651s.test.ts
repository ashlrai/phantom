/** Offline posterior sampling recovery (PR #5952 scheduler/learn.ts sampleValue slice). Hermetic: temp files only. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CODING_SAMPLE_MAX_EVIDENCE_BYTES, cmdFleetCodingSample } from '../src/cli/fleet-coding-sample.js';
import {
  parsePosteriorSampleEvidence,
  type PosteriorSampleEvidence,
  PosteriorSamplingError,
  type PosteriorSamplingParams,
  reportPosteriorSample,
  samplePosteriorValue,
} from '../src/core/providers/coding-cli/posterior-sampling.js';
import { posteriorPrior, type PosteriorUpdateArm, updatePosteriorArm } from '../src/core/providers/coding-cli/posterior-update.js';

// ---------------------------------------------------------------------------
// Independent pinned-source reference. Copied from PR #5952 scheduler/learn.ts at
// 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886 (mulberry32, normal, gamma, beta, variance,
// sampleValue). SchedulerConfig fields are passed explicitly. Do not "fix" this copy:
// it is the oracle the recovered module must match float-for-float.
// ---------------------------------------------------------------------------
type SourceConfig = PosteriorSamplingParams;

function srcMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function srcClamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function srcNormal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function srcGamma(rng: () => number, shape: number): number {
  if (shape < 1) return srcGamma(rng, shape + 1) * Math.pow(rng(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    let x = 0;
    let v = 0;
    do {
      x = srcNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return shape;
}

function srcBeta(rng: () => number, alpha: number, betaParam: number): number {
  const x = srcGamma(rng, alpha);
  const y = srcGamma(rng, betaParam);
  const total = x + y;
  return total <= 0 ? 0.5 : x / total;
}

function srcVariance(m2: number, n: number): number {
  if (n < 2) return 0.25;
  return Math.max(m2 / (n - 1), 1e-6);
}

function srcSampleValue(arm: PosteriorUpdateArm, rng: () => number, config: SourceConfig): number {
  const success = srcClamp01(srcBeta(rng, arm.alpha, arm.beta));
  const quality = srcClamp01(arm.qualityMean + Math.sqrt(srcVariance(arm.qualityM2, arm.observations)) * srcNormal(rng));
  const latency = arm.observations === 0 ? 0 : Math.min(1, Math.max(0, arm.latencyMean) / config.latencyReferenceMs);
  const tokens = arm.tokenObservations === 0 ? 0 : Math.min(1, Math.max(0, arm.tokenMean) / config.tokenReference);
  return success * quality - config.latencyWeight * latency - config.tokenWeight * tokens;
}

// ---------------------------------------------------------------------------
// Fixtures (fake numbers only)
// ---------------------------------------------------------------------------
const PARAMS: PosteriorSamplingParams = { latencyWeight: 0.2, latencyReferenceMs: 1000, tokenWeight: 0.1, tokenReference: 200 };
const SEEDS = [0, 1, 42, 12345, 0x9e3779b9, 0xdeadbeef, 0xffffffff];

const OUTCOMES = [
  { merged: true, green: true, reverted: false, reviewRounds: 0, wallMs: 400, tokens: 120 },
  { merged: true, green: true, reverted: false, reviewRounds: 2, wallMs: 900, tokens: null },
  { merged: false, green: true, reverted: false, reviewRounds: 1, wallMs: 1500, tokens: 300 },
  { merged: true, green: true, reverted: true, reviewRounds: 0, wallMs: 700, tokens: 80 },
  { merged: true, green: true, reverted: false, reviewRounds: 1, wallMs: 250, tokens: 150 },
] as const;

/** A prior arm, a measured arm with known tokens, and one with every token unknown. */
const prior = (): PosteriorUpdateArm => posteriorPrior();
const measured = (): PosteriorUpdateArm => OUTCOMES.reduce((arm, o) => updatePosteriorArm(arm, { ...o }), prior());
const unknownTokens = (): PosteriorUpdateArm =>
  OUTCOMES.reduce((arm, o) => updatePosteriorArm(arm, { ...o, tokens: null }), prior());
const handArm = (): PosteriorUpdateArm => ({
  alpha: 3.5, beta: 0.5, qualityMean: 0.7, qualityM2: 0.02, latencyMean: 640, latencyM2: 900,
  tokenMean: 90, tokenM2: 40, tokenObservations: 4, observations: 6,
});

const evidenceJson = (over: Partial<PosteriorSampleEvidence> = {}): string =>
  JSON.stringify({ seed: 42, params: PARAMS, arm: measured(), ...over });

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'posterior-sample-651s-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe('reproduces the pinned source draw', () => {
  const arms: Array<[string, () => PosteriorUpdateArm]> = [
    ['prior', prior],
    ['measured', measured],
    ['unknown tokens', unknownTokens],
    ['hand-built', handArm],
  ];
  it.each(arms)('%s arm matches the source sampleValue for every known seed', (_name, make) => {
    const arm = make();
    for (const seed of SEEDS) {
      expect(samplePosteriorValue(arm, PARAMS, seed)).toBe(srcSampleValue(arm, srcMulberry32(seed), PARAMS));
    }
  });

  it('is deterministic for the same arm and seed, and draws the same sequence on repeat', () => {
    const arm = measured();
    const first = SEEDS.map((seed) => samplePosteriorValue(arm, PARAMS, seed));
    const second = SEEDS.map((seed) => samplePosteriorValue(arm, PARAMS, seed));
    expect(second).toEqual(first);
  });

  it('keeps every draw inside the analytic bounds [-(latencyWeight + tokenWeight), 1]', () => {
    for (const make of [prior, measured, handArm]) {
      for (let seed = 0; seed < 200; seed += 1) {
        const value = samplePosteriorValue(make(), PARAMS, seed);
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(-(PARAMS.latencyWeight + PARAMS.tokenWeight) - 1e-12);
        expect(value).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });
});

describe('penalties', () => {
  it('adds no token penalty when every token is unknown', () => {
    const arm = unknownTokens();
    expect(arm.tokenObservations).toBe(0);
    for (const seed of SEEDS) {
      const heavy = samplePosteriorValue(arm, { ...PARAMS, tokenWeight: 5 }, seed);
      const none = samplePosteriorValue(arm, { ...PARAMS, tokenWeight: 0 }, seed);
      expect(heavy).toBe(none);
    }
  });

  it('subtracts exactly tokenWeight times the clamped token mean ratio when tokens are observed', () => {
    const arm = measured();
    const expectedPenalty = 0.25 * Math.min(1, Math.max(0, arm.tokenMean) / PARAMS.tokenReference);
    for (const seed of SEEDS) {
      const with25 = samplePosteriorValue(arm, { ...PARAMS, tokenWeight: 0.25 }, seed);
      const with0 = samplePosteriorValue(arm, { ...PARAMS, tokenWeight: 0 }, seed);
      expect(with0 - with25).toBeCloseTo(expectedPenalty, 12);
    }
  });

  it('applies no latency penalty to a prior arm with no observations', () => {
    const arm = prior();
    for (const seed of SEEDS) {
      expect(samplePosteriorValue(arm, { ...PARAMS, latencyWeight: 9 }, seed))
        .toBe(samplePosteriorValue(arm, { ...PARAMS, latencyWeight: 0 }, seed));
    }
  });
});

describe('immutability', () => {
  it('reads frozen arm and params without mutating them', () => {
    const arm = Object.freeze(measured());
    const params = Object.freeze({ ...PARAMS });
    const snapshot = JSON.stringify({ arm, params });
    expect(() => samplePosteriorValue(arm, params, 7)).not.toThrow();
    expect(JSON.stringify({ arm, params })).toBe(snapshot);
  });
});

describe('validation refuses invalid state with PosteriorSamplingError', () => {
  const badArms: Array<[string, Partial<PosteriorUpdateArm>]> = [
    ['alpha zero', { alpha: 0 }],
    ['beta NaN', { beta: Number.NaN }],
    ['alpha infinite', { alpha: Number.POSITIVE_INFINITY }],
    ['negative qualityM2', { qualityM2: -1 }],
    ['NaN latencyMean', { latencyMean: Number.NaN }],
    ['fractional observations', { observations: 1.5 }],
    ['negative observations', { observations: -1 }],
    ['tokenObservations above observations', { observations: 1, tokenObservations: 2 }],
    ['token mean without observations', { tokenObservations: 0, tokenMean: 5 }],
  ];
  it.each(badArms)('arm: %s', (_name, over) => {
    expect(() => samplePosteriorValue({ ...handArm(), ...over }, PARAMS, 1)).toThrow(PosteriorSamplingError);
  });

  const badParams: Array<[string, Partial<PosteriorSamplingParams>]> = [
    ['latency reference zero', { latencyReferenceMs: 0 }],
    ['token reference negative', { tokenReference: -1 }],
    ['token reference NaN', { tokenReference: Number.NaN }],
    ['latency weight infinite', { latencyWeight: Number.POSITIVE_INFINITY }],
  ];
  it.each(badParams)('params: %s', (_name, over) => {
    expect(() => samplePosteriorValue(handArm(), { ...PARAMS, ...over }, 1)).toThrow(PosteriorSamplingError);
  });

  it.each([-1, 2 ** 32, 1.5, Number.NaN])('seed %s is refused rather than wrapped', (seed) => {
    expect(() => samplePosteriorValue(handArm(), PARAMS, seed)).toThrow(PosteriorSamplingError);
  });
});

describe('evidence parsing', () => {
  it('parses a valid one-arm file and reports the basis honestly', () => {
    const evidence = parsePosteriorSampleEvidence(JSON.parse(evidenceJson()));
    const report = reportPosteriorSample(evidence);
    expect(report).toMatchObject({
      seed: 42,
      armBasis: 'measured',
      tokenBasis: 'observed',
      basis: 'offline-modelled',
      observedPerformanceClaimed: false,
      grantsExecutionAuthority: false,
      eligibility: 'not-evaluated',
    });
    expect(report.sampledValue).toBe(samplePosteriorValue(evidence.arm, evidence.params, 42));
  });

  it('marks a prior arm and an unknown-token arm as such', () => {
    const prior0 = reportPosteriorSample({ seed: 3, params: PARAMS, arm: prior() });
    expect(prior0).toMatchObject({ armBasis: 'prior', tokenBasis: 'unknown' });
    const unknown = reportPosteriorSample({ seed: 3, params: PARAMS, arm: unknownTokens() });
    expect(unknown).toMatchObject({ armBasis: 'measured', tokenBasis: 'unknown' });
  });

  const malformed: Array<[string, unknown]> = [
    ['not an object', [1, 2, 3]],
    ['unknown top-level key', { ...JSON.parse(evidenceJson()), extra: 1 }],
    ['missing arm', { seed: 1, params: PARAMS }],
    ['string seed', { ...JSON.parse(evidenceJson()), seed: '42' }],
    ['unknown params key', { ...JSON.parse(evidenceJson()), params: { ...PARAMS, epsilon: 1e-6 } }],
    // JSON has no Infinity, but 1e999 parses to Infinity; the finite check must catch it.
    ['infinite alpha from JSON overflow', JSON.parse(evidenceJson().replace(/"alpha":[^,]+/, '"alpha":1e999'))],
  ];
  it.each(malformed)('refuses %s', (_name, raw) => {
    expect(() => parsePosteriorSampleEvidence(raw)).toThrow(PosteriorSamplingError);
  });
});

describe('cmdFleetCodingSample entrypoint', () => {
  /** Runs the handler with captured writers. */
  async function run(args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await cmdFleetCodingSample(args, (line) => out.push(line), (line) => err.push(line));
    return { code, out, err };
  }
  const write = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, body, 'utf8');
    return path;
  };

  it('prints help with exit 0 and never opens the evidence path', async () => {
    const missing = join(dir, 'does-not-exist.json');
    for (const flag of ['--help', '-h']) {
      const result = await run([flag, '--evidence', missing]);
      expect(result.code).toBe(0);
      expect(result.out.join('\n')).toContain('phm fleet coding-sample --evidence <file>');
      expect(result.err).toEqual([]);
    }
  });

  it.each([
    ['no arguments', []],
    ['flag without value', ['--evidence']],
    ['value that looks like a flag', ['--evidence', '--json']],
    ['evidence given twice', ['--evidence', 'a.json', '--evidence', 'b.json']],
    ['unknown flag', ['--evidence', 'a.json', '--json']],
    ['unexpected positional argument', ['a.json']],
  ])('usage error (%s) exits 2 with no output', async (_name, args) => {
    const result = await run(args);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join('\n')).toContain('error:');
  });

  it('refuses a missing file, a directory and an oversized file with exit 1', async () => {
    expect((await run(['--evidence', join(dir, 'nope.json')])).code).toBe(1);
    expect((await run(['--evidence', dir])).code).toBe(1);
    const big = write('big.json', ' '.repeat(CODING_SAMPLE_MAX_EVIDENCE_BYTES + 1));
    const result = await run(['--evidence', big]);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('exceeds');
  });

  it('refuses malformed JSON without echoing file content', async () => {
    const path = write('bad.json', '{"secret-looking": "abc,');
    const result = await run(['--evidence', path]);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).not.toContain('secret-looking');
    expect(result.err.join('\n')).toContain('not valid JSON');
  });

  it('refuses invalid evidence values with exit 1', async () => {
    const path = write('invalid.json', evidenceJson({ arm: { ...measured(), observations: 2.5 } }));
    const result = await run(['--evidence', path]);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('observations');
  });

  it('round-trips a valid prior arm and a measured arm as JSON', async () => {
    for (const [name, arm] of [['prior.json', prior()], ['measured.json', measured()]] as const) {
      const body = JSON.stringify({ seed: 0xdeadbeef, params: PARAMS, arm });
      const path = write(name, body);
      const result = await run(['--evidence', path]);
      expect(result.code).toBe(0);
      expect(result.err).toEqual([]);
      const printed = JSON.parse(result.out.join('\n')) as ReturnType<typeof reportPosteriorSample>;
      expect(printed).toEqual(reportPosteriorSample(parsePosteriorSampleEvidence(JSON.parse(body))));
      expect(printed.sampledValue).toBe(srcSampleValue(arm, srcMulberry32(0xdeadbeef), PARAMS));
    }
  });

  it('writes nothing to the evidence directory', async () => {
    const before = readdirSync(dir).sort();
    const path = write('readonly.json', evidenceJson());
    await run(['--evidence', path]);
    expect(readdirSync(dir).sort()).toEqual([...before, 'readonly.json'].sort());
    expect(readFileSync(path, 'utf8')).toBe(evidenceJson());
  });
});

describe('command discovery by fleet convention', () => {
  it('exports cmdFleetCodingSample from fleet-coding-sample.ts, the name the registry generator derives', async () => {
    // scripts/gen-fleet-registry.mjs maps fleet-<verb>.ts to verb "<verb>" and export cmdFleet<PascalCase(verb)>.
    const verb = 'coding-sample';
    const derived = 'cmdFleet' + verb.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
    const mod = (await import('../src/cli/fleet-coding-sample.js')) as Record<string, unknown>;
    expect(derived).toBe('cmdFleetCodingSample');
    expect(typeof mod[derived]).toBe('function');
  });
});
