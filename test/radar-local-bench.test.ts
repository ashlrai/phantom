import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertLoopbackBaseUrl,
  buildReport,
  DEV_CYCLE_SAVINGS_METRIC,
  extractLabel,
  LOCAL_BENCH_SCHEMA,
  NonLoopbackEndpointError,
  parseBenchFixture,
  parseLocalBenchArgs,
  renderReport,
  runLocalBench,
  scoreSuite,
  summarizeArm,
  writeReportFile,
  type BenchSuiteFixture,
  type LocalBenchReport,
} from '../src/core/radar/local-bench.js';

const fixtureDir = new URL('./fixtures/radar-local-bench/', import.meta.url).pathname;
const loadFixture = (suite: string): BenchSuiteFixture =>
  parseBenchFixture(JSON.parse(readFileSync(join(fixtureDir, `${suite}.json`), 'utf8')));

const chatBody = (content: string, usage?: { prompt_tokens: number; completion_tokens: number }): Response =>
  new Response(JSON.stringify({
    choices: [{ message: { content } }],
    ...(usage ? { usage } : {}),
  }), { status: 200, headers: { 'content-type': 'application/json' } });

const tmp = (): string => mkdtempSync(join(tmpdir(), 'radar-local-bench-'));

afterEach(() => vi.unstubAllGlobals());

describe('assertLoopbackBaseUrl — the bench never leaves this machine', () => {
  it('accepts every loopback spelling', () => {
    for (const url of [
      'http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434',
      'https://127.0.0.1', 'http://127.5.3.9:8080',
    ]) {
      const origin = assertLoopbackBaseUrl(url);
      expect(origin.startsWith('http')).toBe(true);
      expect(origin.endsWith('/')).toBe(false);
    }
  });

  it('refuses remote, credentialed, and non-HTTP endpoints', () => {
    for (const url of [
      'https://api.openai.com', 'http://192.168.1.5:11434', 'http://ollama.internal:11434',
      'http://10.0.0.4:11434', 'http://fake:fake@127.0.0.1:11434', 'http://user@localhost',
      'file:///etc/passwd', 'ftp://127.0.0.1', 'gopher://127.0.0.1', 'not a url', '',
    ]) {
      expect(() => assertLoopbackBaseUrl(url), url).toThrow(NonLoopbackEndpointError);
    }
  });

  it('drops paths the caller appended — the bench owns the paths it calls', () => {
    expect(assertLoopbackBaseUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434');
  });
});

describe('parseLocalBenchArgs', () => {
  it('defaults to the named candidates and the incumbent local tier', () => {
    const args = parseLocalBenchArgs([]);
    expect(args.models).toEqual(['lfm3:1.7b', 'd1:2b']);
    expect(args.incumbent).toBe('qwen3.8:27b-ctx64k');
    expect(args.baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('parses overrides and rejects bad options', () => {
    const args = parseLocalBenchArgs([
      '--base-url', 'http://localhost:1234', '--models', 'a:1b,b:2b',
      '--incumbent', 'c:3b', '--timeout-ms', '5000', '--out', 'x.json',
    ]);
    expect(args).toMatchObject({ baseUrl: 'http://localhost:1234', models: ['a:1b', 'b:2b'], incumbent: 'c:3b', timeoutMs: 5000, out: 'x.json' });
    expect(() => parseLocalBenchArgs(['--models', ''])).toThrow();
    expect(() => parseLocalBenchArgs(['--timeout-ms', '0'])).toThrow();
    expect(() => parseLocalBenchArgs(['--timeout-ms', '999999999'])).toThrow();
    expect(() => parseLocalBenchArgs(['--bogus'])).toThrow();
    expect(() => parseLocalBenchArgs(['--models'])).toThrow();
    expect(() => parseLocalBenchArgs(['--base-url', 'x', '--base-url', 'y'])).toThrow();
  });
});

describe('parseBenchFixture — fail closed', () => {
  it('parses every checked-in suite', () => {
    for (const suite of ['triage', 'routing', 'ci-failure']) {
      const fixture = loadFixture(suite);
      expect(fixture.suite).toBe(suite);
      expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
      for (const c of fixture.cases) expect(fixture.labels).toContain(c.expected);
    }
  });

  it('rejects malformed fixtures instead of scoring ambiguity', () => {
    const valid = loadFixture('routing');
    const cases = [
      null,
      {},
      { schema: 'other' },
      { ...valid, suite: 'nope' },
      { ...valid, labels: ['only-one'] },
      { ...valid, labels: ['a', 'a', 'b'] },
      { ...valid, cases: [] },
      { ...valid, cases: [{ ...valid.cases[0]!, id: 'dup' }, { ...valid.cases[0]!, id: 'dup' }] },
      { ...valid, cases: [{ ...valid.cases[0]!, expected: 'not-a-label' }] },
      { ...valid, cases: [{ ...valid.cases[0]!, input: '' }] },
      { ...valid, cases: [{ ...valid.cases[0]!, tokensIn: -1 }] },
    ];
    for (const body of cases) expect(() => parseBenchFixture(body)).toThrow();
  });
});

describe('extractLabel — a model never grades a model', () => {
  const labels = ['work:fleet', 'work:cloud', 'work:devin', 'work:interactive', 'skip'];
  it('takes an exact label in any reasonable casing/punctuation', () => {
    expect(extractLabel('work:fleet', labels)).toBe('work:fleet');
    expect(extractLabel('WORK:FLEET', labels)).toBe('work:fleet');
    expect(extractLabel('  skip.\n', labels)).toBe('skip');
    expect(extractLabel('`work:devin`', labels)).toBe('work:devin');
    expect(extractLabel('answer: work:cloud', labels)).toBe('work:cloud');
  });
  it('rejects prose, multiple labels and non-labels', () => {
    expect(extractLabel('I would pick work:fleet or work:cloud', labels)).toBeNull();
    expect(extractLabel('work:fleet work:cloud', labels)).toBeNull();
    expect(extractLabel('banana', labels)).toBeNull();
    expect(extractLabel('', labels)).toBeNull();
    expect(extractLabel('the answer', labels)).toBeNull();
  });
});

describe('scoreSuite + summarizeArm', () => {
  it('scores exact matches and reports measured usage', async () => {
    const fixture = loadFixture('triage');
    const byInput = new Map(fixture.cases.map((c) => [c.input, c.expected]));
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const expected = byInput.get(body.messages[1]!.content) ?? 'skip';
      return chatBody(expected, { prompt_tokens: 200, completion_tokens: 3 });
    }) as unknown as typeof fetch;
    const scored = await scoreSuite(fetchImpl, 'http://127.0.0.1:11434', 'm:1b', fixture, 5_000);
    const arm = summarizeArm('m:1b', fixture, scored, null);
    expect(arm.correct).toBe(fixture.cases.length);
    expect(arm.accuracy).toBe(1);
    expect(arm.usageSource).toBe('measured');
    // 12 correct jobs: (200*3 + 3*15)/1e6 each → $0.000645 → ×100 = $0.0645
    expect(arm.dollarsSavedPer100Jobs).toBeCloseTo(0.0645, 6);
    expect(fetchImpl).toHaveBeenCalledTimes(fixture.cases.length);
  });

  it('marks wrong labels wrong and transport failures separate from wrong answers', async () => {
    const fixture = loadFixture('routing');
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      if (body.messages[1]!.content.includes('auth bypass')) throw new Error('refused');
      return chatBody('local'); // valid label, usually wrong
    }) as unknown as typeof fetch;
    const scored = await scoreSuite(fetchImpl, 'http://127.0.0.1:11434', 'm:1b', fixture, 5_000);
    const arm = summarizeArm('m:1b', fixture, scored, 0.5);
    expect(arm.transportErrors).toBe(1);
    expect(arm.accuracy).toBeNull(); // transport errors mean no trustworthy score
    expect(arm.dollarsSavedPer100Jobs).toBeNull();
    expect(arm.accuracyDeltaVsIncumbent).toBeNull();
    const authCase = scored.find((c) => c.id === 'auth-bypass')!;
    expect(authCase.error).toBe('transport');
    expect(authCase.correct).toBe(false);
  });

  it('falls back to fixture token hints when the endpoint reports no usage', async () => {
    const fixture = loadFixture('ci-failure');
    const byInput = new Map(fixture.cases.map((c) => [c.input, c.expected]));
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      return chatBody(byInput.get(body.messages[1]!.content) ?? 'unknown'); // no usage field
    }) as unknown as typeof fetch;
    const scored = await scoreSuite(fetchImpl, 'http://127.0.0.1:11434', 'm:1b', fixture, 5_000);
    const arm = summarizeArm('m:1b', fixture, scored, null);
    expect(arm.usageSource).toBe('fixture-hint');
    const expected = fixture.cases
      .map((c) => ((c.tokensIn! / 1e6) * 3 + (c.tokensOut! / 1e6) * 15))
      .reduce((a, b) => a + b, 0) / fixture.cases.length * 100;
    expect(arm.dollarsSavedPer100Jobs).toBeCloseTo(expected, 10);
  });
});

describe('runLocalBench — end to end', () => {
  /** The acceptance property: a non-loopback endpoint is refused before any fetch or file write. */
  it('refuses non-loopback endpoints before touching network or disk', async () => {
    const dir = tmp();
    const fetch = vi.fn(() => { throw new Error('Network forbidden'); });
    vi.stubGlobal('fetch', fetch);
    const err = vi.fn();
    const out = vi.fn();
    const code = await runLocalBench(
      ['--base-url', 'https://api.openai.com', '--fixtures', fixtureDir, '--out', join(dir, 'r.json')],
      { out, err },
    );
    expect(code).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(err.mock.calls.flat().join(' ')).toMatch(/loopback/i);
    expect(() => statSync(join(dir, 'r.json'))).toThrow();
  });

  it('scores the candidates against the incumbent and writes the results file', async () => {
    const dir = tmp();
    const fixtures = ['triage', 'routing', 'ci-failure'].map(loadFixture);
    const expectedByInput = new Map(fixtures.flatMap((f) => f.cases.map((c) => [c.input, c.expected])));
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
      const expected = expectedByInput.get(body.messages[1]!.content)!;
      // incumbent: always right; lfm3: right; d1: always 'skip'/first label — partially right.
      const answer = body.model === 'd1:2b' ? 'skip' : expected;
      return chatBody(answer, { prompt_tokens: 180, completion_tokens: 3 });
    }) as unknown as typeof fetch;

    const outFile = join(dir, 'r.json');
    const code = await runLocalBench(
      ['--base-url', 'http://127.0.0.1:11434', '--fixtures', fixtureDir, '--out', outFile],
      { fetchImpl, out: vi.fn(), err: vi.fn(), now: () => new Date('2026-10-28T12:00:00Z') },
    );
    expect(code).toBe(0);
    expect(statSync(outFile).mode & 0o777).toBe(0o600);
    const report = JSON.parse(readFileSync(outFile, 'utf8')) as LocalBenchReport;
    expect(report.schema).toBe(LOCAL_BENCH_SCHEMA);
    expect(report.generatedAt).toBe('2026-10-28T12:00:00.000Z');
    expect(report.endpoint).toEqual({ origin: 'http://127.0.0.1:11434', loopback: true });
    expect(report.incumbent).toBe('qwen3.8:27b-ctx64k');
    expect(report.suites.map((s) => s.suite)).toEqual(['triage', 'routing', 'ci-failure']);
    for (const suite of report.suites) {
      const incumbent = suite.results.find((r) => r.model === report.incumbent)!;
      const lfm = suite.results.find((r) => r.model === 'lfm3:1.7b')!;
      const d1 = suite.results.find((r) => r.model === 'd1:2b')!;
      expect(incumbent.accuracy).toBe(1);
      expect(lfm.accuracy).toBe(1);
      expect(d1.accuracy! <= 1).toBe(true);
      expect(d1.correct).toBeLessThan(d1.cases);
      expect(incumbent.accuracyDeltaVsIncumbent).toBeNull();
      expect(lfm.accuracyDeltaVsIncumbent).toBe(0);
    }
    // The dev-cycle dashboard record: one bounded-label sample per (suite, model).
    expect(report.devCycleDashboard.metric).toBe(DEV_CYCLE_SAVINGS_METRIC);
    expect(report.devCycleDashboard.labels).toEqual({ pool: 'local' });
    expect(report.devCycleDashboard.samples).toHaveLength(9); // 3 suites × 3 arms
    for (const s of report.devCycleDashboard.samples) {
      expect(s.value).toBeGreaterThanOrEqual(0);
      expect(s.cases).toBe(12);
    }
    const text = renderReport(report);
    expect(text).toContain('RADAR-LOCAL-BENCH');
    expect(text).toContain(DEV_CYCLE_SAVINGS_METRIC);
    expect(text).toContain('saved/100 jobs');
  });

  it('still writes the results file when a model is unreachable, and exits 1', async () => {
    const dir = tmp();
    const outFile = join(dir, 'r.json');
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      if (body.model === 'lfm3:1.7b') throw new Error('model not found');
      return chatBody('skip', { prompt_tokens: 10, completion_tokens: 1 });
    }) as unknown as typeof fetch;
    const code = await runLocalBench(
      ['--fixtures', fixtureDir, '--out', outFile, '--models', 'lfm3:1.7b,d1:2b'],
      { fetchImpl, out: vi.fn(), err: vi.fn() },
    );
    expect(code).toBe(1);
    const report = JSON.parse(readFileSync(outFile, 'utf8')) as LocalBenchReport;
    expect(report.transportErrors).toBe(36); // 3 suites × 12 cases
    const lfm = report.suites[0]!.results.find((r) => r.model === 'lfm3:1.7b')!;
    expect(lfm.accuracy).toBeNull();
    expect(lfm.dollarsSavedPer100Jobs).toBeNull();
    // Failed arms produce no dashboard samples; healthy arms still record.
    expect(report.devCycleDashboard.samples.some((s) => s.model === 'lfm3:1.7b')).toBe(false);
    expect(report.devCycleDashboard.samples.length).toBe(6);
  });

  it('fails without writing a results file when fixtures are unreadable', async () => {
    const dir = tmp();
    const code = await runLocalBench(
      ['--fixtures', join(dir, 'missing'), '--out', join(dir, 'r.json')],
      { fetchImpl: (() => { throw new Error('unreachable'); }) as unknown as typeof fetch, out: vi.fn(), err: vi.fn() },
    );
    expect(code).toBe(1);
    expect(() => statSync(join(dir, 'r.json'))).toThrow();
  });
});

describe('writeReportFile + buildReport', () => {
  it('writes mode-0600 JSON and chmods a pre-existing permissive file', () => {
    const dir = tmp();
    const target = join(dir, 'r.json');
    writeFileSync(target, 'old', { mode: 0o644 });
    const report = buildReport('http://127.0.0.1:11434', 'inc:1b', [], '2026-10-28T00:00:00Z');
    writeReportFile(target, report);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ schema: LOCAL_BENCH_SCHEMA, transportErrors: 0 });
  });
});
