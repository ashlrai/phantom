/** Offline coding regret recovery (PR #5952 scheduler/regret.ts slice). Hermetic: temp files only. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  armExpectedValue,
  computeRegret,
  parseRegretEvidence,
  RegretEvidenceError,
  type RegretArmEvidence,
  type RegretEvidence,
} from '../src/core/providers/coding-cli/regret-report.js';
import { cmdFleetCodingRegret } from '../src/cli/fleet-coding-regret.js';

const CONFIG = { latencyWeight: 0.2, latencyReferenceMs: 1000, tokenWeight: 0.1, tokenReference: 200, epsilon: 1e-6 };

/** Unobserved by default: alpha 1, beta 1 is the prior, so observations 0 means unknown. */
function arm(over: Partial<RegretArmEvidence> & Pick<RegretArmEvidence, 'jobType' | 'poolId' | 'consumer'>): RegretArmEvidence {
  return { alpha: 1, beta: 1, qualityMean: 1, latencyMean: 0, tokenMean: 0, observations: 0, tokenObservations: 0, ...over };
}

/** Observed arm with success rate alpha/(alpha+beta) and no penalties. */
const seen = (
  poolId: RegretArmEvidence['poolId'],
  consumer: RegretArmEvidence['consumer'],
  alpha: number,
  beta: number,
  jobType: RegretArmEvidence['jobType'] = 'coding',
): RegretArmEvidence => arm({ jobType, poolId, consumer, alpha, beta, observations: 4 });

const outcome = (jobId: string, poolId: RegretArmEvidence['poolId'], consumer: RegretArmEvidence['consumer'] = null) => ({
  jobId,
  jobType: 'coding' as const,
  poolId,
  consumer,
});

const ev = (arms: RegretArmEvidence[], outcomes: ReturnType<typeof outcome>[], config = CONFIG): RegretEvidence => ({
  outcomes,
  arms,
  config,
});

describe('expected-value formula (source learn.ts semantics)', () => {
  it('scores a measured arm with latency and token penalties', () => {
    const measured = arm({
      alpha: 3, beta: 1, qualityMean: 0.8, latencyMean: 500, tokenMean: 100, observations: 4, tokenObservations: 4,
      jobType: 'coding', poolId: 'claude', consumer: null,
    });
    // 0.75 * 0.8 - 0.2 * 0.5 - 0.1 * 0.5
    expect(armExpectedValue(measured, CONFIG)).toBeCloseTo(0.45, 12);
  });

  it('clamps quality to [0, 1] and latency and token ratios to [0, 1]', () => {
    const over = arm({
      alpha: 1, beta: 1, qualityMean: 1.7, latencyMean: 5000, tokenMean: 900, observations: 2, tokenObservations: 2,
      jobType: 'coding', poolId: 'claude', consumer: null,
    });
    // 0.5 * 1 - 0.2 * 1 - 0.1 * 1
    expect(armExpectedValue(over, CONFIG)).toBeCloseTo(0.2, 12);
  });

  it('uses the prior only inside the formula; the report never treats it as evidence', () => {
    const prior = arm({ jobType: 'coding', poolId: 'claude', consumer: null });
    expect(armExpectedValue(prior, CONFIG)).toBeCloseTo(0.5, 12);
  });
});

describe('computeRegret', () => {
  it('reports a source-labelled advantage when a measured alternative beats the chosen arm', () => {
    const report = computeRegret(ev(
      [seen('codex-primary', null, 1, 3), seen('claude', null, 3, 1)],
      [outcome('RQ-FAKE-JOB-1', 'codex-primary')],
    ));
    expect(report).toMatchObject({ schema: 'fleet.coding-regret.v1', source: 'posterior', postIssues: false });
    expect(report.items).toEqual([{
      jobId: 'RQ-FAKE-JOB-1',
      jobType: 'coding',
      chosenPool: 'codex-primary',
      chosenConsumer: null,
      betterPool: 'claude',
      betterConsumer: null,
      chosenValue: 0.25,
      betterValue: 0.75,
      regret: 0.5,
    }]);
    expect(report.summary).toEqual({ outcomes: 1, advantages: 1, noAdvantage: 0, chosenUnobserved: 0, noObservedAlternative: 0 });
  });

  it('breaks exact ties toward the earliest candidate in pool order', () => {
    const report = computeRegret(ev(
      [seen('local', null, 1, 3), seen('metered', null, 3, 1), seen('claude', null, 3, 1)],
      [outcome('RQ-FAKE-JOB-TIE', 'local')],
    ));
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ betterPool: 'claude', betterValue: 0.75 });
  });

  it('emits nothing for a tie with the chosen arm, a worse alternative, or a gap within epsilon', () => {
    const tie = computeRegret(ev([seen('claude', null, 3, 1), seen('codex-primary', null, 3, 1)], [outcome('RQ-FAKE-T', 'claude')]));
    expect(tie.items).toEqual([]);
    expect(tie.summary.noAdvantage).toBe(1);

    const worse = computeRegret(ev([seen('claude', null, 3, 1), seen('codex-primary', null, 1, 3)], [outcome('RQ-FAKE-W', 'claude')]));
    expect(worse.items).toEqual([]);
    expect(worse.summary.noAdvantage).toBe(1);

    const near = (qualityAlt: number, epsilon: number) => computeRegret(ev(
      [arm({ jobType: 'coding', poolId: 'claude', consumer: null, qualityMean: 0.5, observations: 4 }),
        arm({ jobType: 'coding', poolId: 'codex-primary', consumer: null, qualityMean: qualityAlt, observations: 4 })],
      [outcome('RQ-FAKE-E', 'claude')],
      { ...CONFIG, epsilon },
    ));
    // Gap is 0.5 * 5e-7 = 2.5e-7, inside the default 1e-6 epsilon, so no advantage.
    expect(near(0.5000005, 1e-6).items).toEqual([]);
    // Same gap is an advantage once epsilon is tightened.
    expect(near(0.5000005, 1e-9).items).toHaveLength(1);
  });

  it('never invents an advantage from an unobserved alternative or an unobserved chosen arm', () => {
    const unknownAlt = computeRegret(ev(
      [seen('devin', null, 1, 3), arm({ jobType: 'coding', poolId: 'claude', consumer: null, alpha: 9, beta: 1 })],
      [outcome('RQ-FAKE-U', 'devin')],
    ));
    expect(unknownAlt.items).toEqual([]);
    expect(unknownAlt.summary.noObservedAlternative).toBe(1);

    const unknownChosen = computeRegret(ev([seen('claude', null, 3, 1)], [outcome('RQ-FAKE-C', 'codex-primary')]));
    expect(unknownChosen.items).toEqual([]);
    expect(unknownChosen.summary.chosenUnobserved).toBe(1);
  });

  it('keeps grok-ultra consumers distinct and never compares an arm with itself', () => {
    const report = computeRegret(ev(
      [seen('grok-ultra-weekly', 'orchestrator', 1, 3), seen('grok-ultra-weekly', 'cloud-agent', 3, 1)],
      [outcome('RQ-FAKE-ULTRA-1', 'grok-ultra-weekly', 'orchestrator'), outcome('RQ-FAKE-ULTRA-2', 'grok-ultra-weekly', 'cloud-agent')],
    ));
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      jobId: 'RQ-FAKE-ULTRA-1',
      chosenConsumer: 'orchestrator',
      betterPool: 'grok-ultra-weekly',
      betterConsumer: 'cloud-agent',
    });
    expect(report.summary.noAdvantage).toBe(1);
  });

  it('returns an empty, valid report for empty evidence', () => {
    const report = computeRegret(parseRegretEvidence({ outcomes: [], arms: [], config: CONFIG }));
    expect(report.items).toEqual([]);
    expect(report.summary).toEqual({ outcomes: 0, advantages: 0, noAdvantage: 0, chosenUnobserved: 0, noObservedAlternative: 0 });
    expect(report.epsilon).toBe(CONFIG.epsilon);
  });
});

describe('parseRegretEvidence refusals', () => {
  type Raw = { config: Record<string, unknown>; arms: Record<string, unknown>[]; outcomes: Record<string, unknown>[] };
  const good = (): Raw => ({
    config: { latencyWeight: 0.2, latencyReferenceMs: 1000, tokenWeight: 0.1, tokenReference: 200 },
    arms: [{ jobType: 'coding', poolId: 'claude', consumer: null, alpha: 1, beta: 1, qualityMean: 1, latencyMean: 0, tokenMean: 0, observations: 0, tokenObservations: 0 }],
    outcomes: [{ jobId: 'RQ-FAKE-OK', jobType: 'coding', poolId: 'claude', consumer: null }],
  });
  const mutate = (fn: (raw: Raw) => void): Raw => {
    const raw = good();
    fn(raw);
    return raw;
  };
  const first = <T,>(xs: T[]): T => {
    const v = xs[0];
    if (v === undefined) throw new Error('fixture missing');
    return v;
  };

  it('defaults epsilon when omitted and accepts the minimal valid shape', () => {
    expect(parseRegretEvidence(good()).config.epsilon).toBe(1e-6);
  });

  const cases: Array<[string, unknown]> = [
    ['non-object root', []],
    ['missing config', mutate((r) => { delete (r as Partial<Raw>).config; })],
    ['zero latency reference', mutate((r) => { r.config['latencyReferenceMs'] = 0; })],
    ['negative token reference', mutate((r) => { r.config['tokenReference'] = -1; })],
    ['NaN weight', mutate((r) => { r.config['latencyWeight'] = Number.NaN; })],
    ['infinite epsilon', mutate((r) => { r.config['epsilon'] = Number.POSITIVE_INFINITY; })],
    ['negative weight', mutate((r) => { r.config['tokenWeight'] = -0.1; })],
    ['zero alpha', mutate((r) => { first(r.arms)['alpha'] = 0; })],
    ['infinite beta', mutate((r) => { first(r.arms)['beta'] = Number.POSITIVE_INFINITY; })],
    ['fractional observations', mutate((r) => { first(r.arms)['observations'] = 1.5; })],
    ['duplicate arm identity', mutate((r) => { r.arms.push({ ...first(r.arms) }); })],
    ['unknown pool', mutate((r) => { first(r.outcomes)['poolId'] = 'mystery-pool'; })],
    ['consumer on a single-arm pool', mutate((r) => { first(r.outcomes)['consumer'] = 'orchestrator'; })],
    ['ultra pool without a consumer', mutate((r) => { first(r.outcomes)['poolId'] = 'grok-ultra-weekly'; })],
    ['missing consumer', mutate((r) => { delete first(r.outcomes)['consumer']; })],
    ['empty job id', mutate((r) => { first(r.outcomes)['jobId'] = ''; })],
    ['job id with a URL and credential-shaped text', mutate((r) => { first(r.outcomes)['jobId'] = 'https://user:FAKE-PASS-XYZ@host.example'; })],
    ['outcomes not an array', mutate((r) => { (r as unknown as Record<string, unknown>)['outcomes'] = {}; })],
  ];

  it.each(cases)('refuses %s', (_name, raw) => {
    expect(() => parseRegretEvidence(raw)).toThrow(RegretEvidenceError);
  });

  it('names the field path but never echoes a raw value', () => {
    const raw = mutate((r) => { r.outcomes[0].jobId = 'FAKE-SECRET-VALUE-XYZ bad'; });
    let message = '';
    try {
      parseRegretEvidence(raw);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('outcomes[0].jobId');
    expect(message).not.toContain('FAKE-SECRET-VALUE');
  });
});

describe('cmdFleetCodingRegret', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'coding-regret-647s-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await cmdFleetCodingRegret(args, (l) => out.push(l), (l) => err.push(l));
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  const writeEvidence = (name: string, body: unknown): string => {
    const file = join(dir, name);
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    return file;
  };

  const fakeEvidence = {
    config: { latencyWeight: 0.2, latencyReferenceMs: 1000, tokenWeight: 0.1, tokenReference: 200 },
    arms: [
      { jobType: 'coding', poolId: 'claude', consumer: null, alpha: 1, beta: 3, qualityMean: 1, latencyMean: 0, tokenMean: 0, observations: 4, tokenObservations: 0 },
      { jobType: 'coding', poolId: 'codex-primary', consumer: null, alpha: 3, beta: 1, qualityMean: 1, latencyMean: 0, tokenMean: 0, observations: 4, tokenObservations: 0 },
    ],
    outcomes: [{ jobId: 'RQ-FAKE-CLI-1', jobType: 'coding', poolId: 'claude', consumer: null }],
  };

  it('prints parseable JSON from a temporary fake evidence file and touches no host state', async () => {
    const fakeHome = join(dir, 'fake-home');
    mkdirSync(fakeHome);
    const prev = { HOME: process.env['HOME'], ASHLR_HOME: process.env['ASHLR_HOME'] };
    process.env['HOME'] = fakeHome;
    process.env['ASHLR_HOME'] = join(fakeHome, 'ashlr-missing');
    try {
      const r = await run(['--evidence', writeEvidence('evidence.json', fakeEvidence)]);
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
      const report = JSON.parse(r.out);
      expect(report.source).toBe('posterior');
      expect(report.postIssues).toBe(false);
      expect(report.items).toHaveLength(1);
      expect(report.items[0]).toMatchObject({ jobId: 'RQ-FAKE-CLI-1', chosenPool: 'claude', betterPool: 'codex-primary' });
      expect(report.notice).toMatch(/not proof of current eligibility/);
      // The CLI must not create or read anything under the HOME it was given.
      expect(readdirSync(fakeHome)).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('accepts empty evidence and reports no items', async () => {
    const r = await run(['--evidence', writeEvidence('empty.json', { outcomes: [], arms: [], config: fakeEvidence.config })]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).items).toEqual([]);
  });

  it('refuses malformed JSON, invalid fields and oversize files without printing content', async () => {
    const malformed = await run(['--evidence', writeEvidence('bad.json', '{"FAKE-SECRET-VALUE-XYZ": ')]);
    expect(malformed.code).toBe(1);
    expect(malformed.err).not.toContain('FAKE-SECRET');
    expect(malformed.out).toBe('');

    const invalid = await run(['--evidence', writeEvidence('invalid.json', { ...fakeEvidence, config: { ...fakeEvidence.config, tokenReference: 0 } })]);
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain('config.tokenReference');
    expect(invalid.out).toBe('');

    const oversize = await run(['--evidence', writeEvidence('big.json', ' '.repeat(1024 * 1024 + 1))]);
    expect(oversize.code).toBe(1);
    expect(oversize.err).toContain('exceeds');
  });

  it('reports a missing file and a directory as read errors', async () => {
    const missing = await run(['--evidence', join(dir, 'does-not-exist.json')]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('ENOENT');
    const directory = await run(['--evidence', dir]);
    expect(directory.code).toBe(1);
    expect(directory.err).toContain('not a regular file');
  });

  it('uses exit code 2 for usage errors and prints usage on --help', async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(['--evidence'])).code).toBe(2);
    expect((await run(['--evidence', '--json'])).code).toBe(2);
    expect((await run(['--evidence', 'a.json', '--evidence', 'b.json'])).code).toBe(2);
    expect((await run(['--evidence', 'a.json', '--ledger', 'x'])).code).toBe(2);
    expect((await run(['--evidence', 'a.json', 'extra'])).code).toBe(2);
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: phm fleet coding-regret --evidence <file>');
  });

  it('keeps the CLI and core modules free of host, network, process and writer access', () => {
    const cli = readFileSync(join(__dirname, '..', 'src', 'cli', 'fleet-coding-regret.ts'), 'utf8');
    const core = readFileSync(join(__dirname, '..', 'src', 'core', 'providers', 'coding-cli', 'regret-report.ts'), 'utf8');
    const forbidden = /homedir|process\.env|child_process|node:(http|https|net|os)\b|\bfetch\(|writeFile|mkdirSync|appendFile|spawn|authority|routing/;
    expect(cli).not.toMatch(forbidden);
    expect(core).not.toMatch(forbidden);
    expect(core).not.toMatch(/^import /m);
  });
});
