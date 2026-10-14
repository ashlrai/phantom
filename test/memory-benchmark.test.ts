/** Offline memory quality benchmark: fixture validity, determinism, gold self-consistency and governed floors. */
import { describe, expect, it } from 'vitest';
import { benchmarkMemoryCli, parseMemoryBenchmarkArgs } from '../scripts/benchmark-memory.js';
import { MEMORY_BENCHMARK_DIMENSIONS, benchEvent, benchQuery, benchSnapshot, memoryBenchmarkCases, runMemoryBenchmark,
  type MemoryBenchmarkBuilder } from '../src/core/local-eval/memory-benchmark.js';
import { buildMemoryContextPack } from '../src/core/memory/pack.js';
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
    expect(governed!.pendingDecisions).toEqual([]);
    expect(governed!.overall.receiptForeignEventIds).toBe(0);
  });
  it('holds the measured governed floors so ranking or pack changes cannot silently regress', () => {
    const governed = runMemoryBenchmark().arms[0]!;
    expect(governed.retrievalByDifficulty.lexical.passed).toBe(20);
    expect(governed.retrievalByDifficulty.inflected.passed).toBe(20);
    expect(governed.retrievalByDifficulty.absent.passed).toBeGreaterThanOrEqual(3);
    expect(governed.byDimension.task.passed).toBeGreaterThanOrEqual(7);
    expect(governed.overall.conflictsSurfaced).toBe(governed.overall.conflictsTotal);
    expect(governed.overall.payloadRatio).toBeGreaterThan(0.045);
  });
  it('names a contested slot the query touches without quoting either claim, and stays quiet for unrelated queries', () => {
    const a = 'Deployment target is the staging cluster.'; const b = 'Deployment target is the canary cluster.';
    const snapshot = benchSnapshot('notice', [benchEvent({ id: 'a', subject: 'deploy', slot: 'target', text: a }),
      benchEvent({ id: 'b', subject: 'deploy', slot: 'target', text: b }), benchEvent({ id: 'c', subject: 'lint', slot: 'rule', text: 'Lint must pass.' })]);
    const touched = buildMemoryContextPack(snapshot, benchQuery('what is the deployment target'));
    expect(touched.status).toBe('none');
    expect(touched.text).toContain('Unresolved conflict: subject deploy, slot target (2 withheld).');
    expect(touched.text).not.toContain('staging'); expect(touched.text).not.toContain('canary');
    expect(touched.bytes).toBe(Buffer.byteLength(touched.text));
    const unrelated = buildMemoryContextPack(snapshot, benchQuery('what does lint require'));
    expect(unrelated.status).toBe('ready'); expect(unrelated.text).not.toContain('conflict');
    const tight = buildMemoryContextPack(snapshot, benchQuery('deployment target', { maxBytes: 256 }));
    expect(tight.text).toBe(''); expect(tight.receipt.stopReasons).toContain('conflict-notice-budget');
  });
  it('ignores function words, folds simple suffixes, keeps other scripts exact and states the view once', () => {
    const snapshot = benchSnapshot('rank', [benchEvent({ id: 'a', subject: 'build', slot: 'command', text: 'Build the workspace with npm run build.' }),
      benchEvent({ id: 'b', subject: 'docs', slot: 'site', text: 'The docs are where the site is.' }),
      benchEvent({ id: 'c', subject: 'deploy', slot: 'note', text: '部署 は 金曜 に 停止 します。' })]);
    expect(buildMemoryContextPack(snapshot, benchQuery('how are builds produced')).receipt.selectedEventIds).toEqual(['a']);
    expect(buildMemoryContextPack(snapshot, benchQuery('what is the office parking')).status).toBe('none');
    expect(buildMemoryContextPack(snapshot, benchQuery('金曜')).receipt.selectedEventIds).toEqual(['c']);
    // A query of only function words still ranks by them rather than giving every fact equal score.
    expect(buildMemoryContextPack(snapshot, benchQuery('where is the')).receipt.selectedEventIds).toEqual(['b', 'a']);
    const pack = buildMemoryContextPack(snapshot, benchQuery('build', { knownAt: '2026-09-20T00:00:00.000Z' }));
    expect(pack.text.split('\n')[1]).toBe('<phantom-memory-evidence authority="false" review="caller-recorded-approval-not-truth-proof" '
      + 'time-mode="current" time-at="2026-09-30T00:00:00.000Z" known-at="2026-09-20T00:00:00.000Z">');
    expect(pack.text.match(/known-?at/gi)).toHaveLength(1);
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
