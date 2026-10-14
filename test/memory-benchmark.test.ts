/** Offline memory quality benchmark: fixture validity, determinism, gold self-consistency and governed floors. */
import { describe, expect, it } from 'vitest';
import { benchmarkMemoryCli, parseMemoryBenchmarkArgs } from '../scripts/benchmark-memory.js';
import { MEMORY_BENCHMARK_DIMENSIONS, memoryBenchmarkCases, runMemoryBenchmark, type MemoryBenchmarkBuilder } from '../src/core/local-eval/memory-benchmark.js';
import { validMemoryPackQuery, validMemorySnapshot } from '../src/core/memory/validate.js';
import type { MemoryContextPack } from '../src/core/memory/types.js';

const cases = memoryBenchmarkCases();
const emptyPack = (status: MemoryContextPack['status'] = 'none', text = ''): MemoryContextPack => ({ schemaVersion: 1,
  contentSafety: 'screened-with-shared-patterns', status, text, bytes: Buffer.byteLength(text), tokenEstimate: { method: 'utf8-bytes-divided-by-4', value: 0 },
  items: [], receipt: { policyVersion: 1, snapshotId: null, snapshotRevision: null, recordedThrough: null, scope: null, time: null, knownAt: null,
    selectedEventIds: [], exclusions: [], stopReasons: [] }, authority: false });
describe('memory quality benchmark', () => {
  it('assigns 100 uniquely named cases whose snapshots and queries all pass the closed schema', () => {
    expect(cases).toHaveLength(100);
    expect(new Set(cases.map(entry => entry.id)).size).toBe(cases.length);
    for (const dimension of MEMORY_BENCHMARK_DIMENSIONS) expect(cases.some(entry => entry.dimension === dimension)).toBe(true);
    for (const step of cases.flatMap(entry => entry.steps)) {
      expect(validMemorySnapshot(step.snapshot)).toBe(true);
      expect(validMemoryPackQuery(step.query)).toBe(true);
    }
  });
  it('is deterministic and leaves the scored arms no access to expectations', () => {
    const first = runMemoryBenchmark(); const second = runMemoryBenchmark();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.modelTaskSuccess).toBe('not-evaluated');
    const seen: string[] = [];
    const spy: MemoryBenchmarkBuilder = (snapshot, query) => { seen.push(JSON.stringify([snapshot, query])); return emptyPack(); };
    runMemoryBenchmark([{ arm: 'spy', builder: spy }]);
    expect(seen).toHaveLength(cases.flatMap(entry => entry.steps).length);
    for (const input of seen) expect(input).not.toMatch(/"(required|forbidden|conflicts|pendingDecision)"/);
  });
  it('gold is self-consistent: an oracle that emits exactly the required facts passes every scored case', () => {
    let index = 0; const steps = cases.flatMap(entry => entry.steps);
    const oracle: MemoryBenchmarkBuilder = () => {
      const step = steps[index++]!;
      const lines = step.expect.required.map(text => JSON.stringify({ text }));
      const notes = (step.expect.conflicts ?? []).map(slot => `conflict ${slot.subject} ${slot.slot}`);
      const text = [...lines, ...notes].join('\n');
      return emptyPack(step.expect.status ?? (lines.length ? 'ready' : 'none'), text);
    };
    const report = runMemoryBenchmark([{ arm: 'oracle', builder: oracle }]);
    expect(report.arms[0]!.overall.passRate).toBe(1);
    expect(report.arms[0]!.overall.conflictsSurfaced).toBe(report.arms[0]!.overall.conflictsTotal);
  });
  it('discriminates: the flat latest-record diagnostic leaks stale or contested text that governed memory never serves', () => {
    const [governed, flat] = runMemoryBenchmark().arms;
    expect(flat!.overall.forbiddenLeaks).toBeGreaterThan(0);
    expect(governed!.overall.forbiddenLeaks).toBe(0);
    for (const dimension of ['contradiction', 'temporal', 'withdrawal'] as const) expect(governed!.byDimension[dimension].passRate).toBe(1);
    expect(governed!.pendingDecisions.map(entry => entry.id)).toEqual(['withdrawal:audience-mismatch']);
  });
  it('the CLI accepts only its two flags and reports source identity without gating', () => {
    expect(parseMemoryBenchmarkArgs([])).toEqual({ cases: false });
    expect(parseMemoryBenchmarkArgs(['--json', '--cases'])).toEqual({ cases: true });
    for (const args of [['--model', 'x'], ['--cases', '--cases'], ['/tmp/export.json']]) expect(benchmarkMemoryCli(args).exitCode).toBe(2);
    const result = benchmarkMemoryCli(['--json']) as { exitCode: number; output: { protocol: string; source: { observation: string } } };
    expect(result.exitCode).toBe(0);
    expect(result.output.protocol).toBe('phantom-memory-benchmark-v2');
    expect(result.output.source.observation).toBe('source-checkout-not-installed-build');
  });
});
