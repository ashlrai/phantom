/** Offline memory quality benchmark: fixture validity, determinism, gold self-consistency and governed floors. */
import { describe, expect, it } from 'vitest';
import { benchmarkMemoryCli, parseMemoryBenchmarkArgs } from '../scripts/benchmark-memory.js';
import { MEMORY_BENCHMARK_DIMENSIONS, benchDay, benchEvent, benchQuery, benchSnapshot, memoryBenchmarkCases, runMemoryBenchmark,
  type MemoryBenchmarkBuilder } from '../src/core/local-eval/memory-benchmark.js';
import { memoryBenchmarkFloorViolations } from '../src/core/local-eval/memory-benchmark-floors.js';
import { buildFlatLatestMemoryDiagnostic } from '../src/core/local-eval/memory-evaluation-baseline.js';
import { buildMemoryContextPack } from '../src/core/memory/pack.js';
import { memoryContentUnchanged, validMemoryPackQuery, validMemorySnapshot } from '../src/core/memory/validate.js';
import type { MemoryContextPack } from '../src/core/memory/types.js';

const cases = memoryBenchmarkCases();
const emptyPack = (status: MemoryContextPack['status'] = 'none', text = ''): MemoryContextPack => ({ schemaVersion: 1,
  contentSafety: 'screened-with-shared-patterns', status, text, bytes: Buffer.byteLength(text), tokenEstimate: { method: 'utf8-bytes-divided-by-4', value: 0 },
  items: [], receipt: { policyVersion: 1, snapshotId: null, snapshotRevision: null, recordedThrough: null, scope: null, time: null, knownAt: null,
    selectedEventIds: [], exclusions: [], stopReasons: [] }, authority: false });
describe('memory quality benchmark', () => {
  it('assigns 539 uniquely named cases whose snapshots and queries pass the closed schema, except agent-write cases that trip content screening', () => {
    expect(cases).toHaveLength(539);
    expect(new Set(cases.map(entry => entry.id)).size).toBe(cases.length);
    for (const dimension of MEMORY_BENCHMARK_DIMENSIONS) expect(cases.some(entry => entry.dimension === dimension)).toBe(true);
    expect(cases.filter(entry => entry.screened).map(entry => entry.id)).toHaveLength(63);
    for (const entry of cases) for (const step of entry.steps) {
      expect(validMemorySnapshot(step.snapshot) && validMemoryPackQuery(step.query)).toBe(!entry.screened);
    }
  });
  it('never puts screened content into any governed pack, and serves the rest of a snapshot holding a credential-bearing write', () => {
    let partial = 0;
    for (const entry of cases) for (const step of entry.steps) {
      const pack = buildMemoryContextPack(step.snapshot, step.query, step.options ?? { changedSourceIds: [] });
      expect(memoryContentUnchanged(pack.text)).toBe(true);
      expect(pack.text).not.toContain('[screened]');
      if (entry.screened && pack.status === 'ready') partial++;
    }
    expect(partial).toBeGreaterThan(40);
  }, 60_000);
  it('is deterministic and leaves the scored arms no access to expectations', () => {
    const first = runMemoryBenchmark(); const second = runMemoryBenchmark();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.modelTaskSuccess).toBe('not-evaluated');
    const seen: string[] = [];
    const spy: MemoryBenchmarkBuilder = (snapshot, query) => { seen.push(JSON.stringify([snapshot, query])); return emptyPack(); };
    runMemoryBenchmark([{ arm: 'spy', builder: spy }]);
    expect(seen).toHaveLength(cases.flatMap(entry => entry.steps).length);
    for (const input of seen) expect(input).not.toMatch(/(?<!\\)"(required|forbidden|conflicts|pendingDecision|anyOf|duplicates|disagreement)":/);
  }, 60_000);
  it('gold is self-consistent: an oracle that emits exactly the required facts passes every scored case', () => {
    let index = 0; const steps = cases.flatMap(entry => entry.steps);
    const oracle: MemoryBenchmarkBuilder = () => {
      const step = steps[index++]!;
      const lines = [...step.expect.required, ...(step.expect.anyOf ?? []).flatMap(group => group.slice(0, 1))].map(text => JSON.stringify({ text }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e'));
      const notes = (step.expect.conflicts ?? []).map(slot => `conflict ${slot.subject} ${slot.slot}`);
      if (step.expect.disagreement) notes.push('Recorded facts disagree.');
      const text = [...lines, ...notes].join('\n');
      return emptyPack(step.expect.status ?? (lines.length ? 'ready' : 'none'), text);
    };
    const report = runMemoryBenchmark([{ arm: 'oracle', builder: oracle }]);
    expect(report.arms[0]!.overall.passRate).toBe(1);
    expect(report.arms[0]!.overall.conflictsSurfaced).toBe(report.arms[0]!.overall.conflictsTotal);
  }, 60_000);
  it('discriminates: the flat latest-record diagnostic leaks stale or contested text that governed memory never serves', () => {
    const [governed, flat] = runMemoryBenchmark().arms;
    expect(flat!.overall.forbiddenLeaks).toBeGreaterThan(0);
    for (const dimension of ['retrieval', 'contradiction', 'temporal', 'withdrawal', 'task'] as const) expect(governed!.byDimension[dimension].forbiddenLeaks).toBe(0);
    for (const dimension of ['contradiction', 'temporal', 'withdrawal'] as const) expect(governed!.byDimension[dimension].passRate).toBe(1);
    // Agent-written histories: governed serves fewer wrong, stale or duplicate facts and answers more questions than the flat diagnostic.
    expect(governed!.byDimension['agent-writes'].stepsWithForbidden).toBeLessThan(flat!.byDimension['agent-writes'].stepsWithForbidden);
    expect(governed!.byDimension['agent-writes'].passed).toBeGreaterThan(flat!.byDimension['agent-writes'].passed);
    expect(governed!.pendingDecisions).toEqual([]);
    expect(governed!.overall.receiptForeignEventIds).toBe(0);
  }, 60_000);
  it('holds the measured governed floors so ranking or pack changes cannot silently regress', () => {
    const governed = runMemoryBenchmark().arms[0]!;
    expect(governed.retrievalByDifficulty.lexical.passed).toBe(20);
    expect(governed.retrievalByDifficulty.inflected.passed).toBe(20);
    expect(governed.retrievalByDifficulty.absent.passed).toBeGreaterThanOrEqual(3);
    expect(governed.byDimension.task.passed).toBe(8);
    expect(governed.overall.conflictsSurfaced).toBe(governed.overall.conflictsTotal);
    expect(governed.overall.payloadRatio).toBeGreaterThan(0.05);
    expect(governed.retrievalByDifficulty.paraphrase.passed).toBeGreaterThanOrEqual(18);
    expect(governed.retrievalByDifficulty['held-out'].passed).toBeGreaterThanOrEqual(34);
    expect(governed.retrievalByDifficulty.unseen.passed).toBeGreaterThanOrEqual(27);
    expect(governed.retrievalByDifficulty.fresh.passed).toBeGreaterThanOrEqual(25);
    expect(governed.retrievalByDifficulty['second-fresh'].passed).toBeGreaterThanOrEqual(27);
    expect(governed.overall.forbiddenLeaks - governed.byDimension['agent-writes'].forbiddenLeaks).toBe(0);
  }, 60_000);
  it('cites sources by ID and digest in pack text, quoting only when the quote differs, with full records on items', () => {
    const same = benchEvent({ id: 'a', subject: 'build', slot: 'command', text: 'Build with npm run build.' });
    const different = { ...benchEvent({ id: 'b', subject: 'build', slot: 'cache', text: 'Build cache is safe to clear.' }) };
    different.sourceRefs = [{ ...different.sourceRefs[0]!, quote: 'You can always clear the build cache.' }];
    const pack = buildMemoryContextPack(benchSnapshot('cite', [same, different]), benchQuery('build', { maxFacts: 4 }));
    const rows = pack.text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as { eventId: string; sources: unknown; sourceRefs?: unknown });
    expect(rows.find(row => row.eventId === 'a')!.sources).toEqual([{ digest: same.sourceRefs[0]!.digest, id: 'a:source' }]);
    expect(rows.find(row => row.eventId === 'b')!.sources).toEqual([{ digest: different.sourceRefs[0]!.digest, id: 'b:source', quote: 'You can always clear the build cache.' }]);
    expect(rows.every(row => row.sourceRefs === undefined)).toBe(true);
    expect(pack.items.find(item => item.eventId === 'a')!.sourceRefs).toEqual(same.sourceRefs);
  });
  it('matches everyday synonyms from the fixed vocabulary, preferring exact words on ties', () => {
    const snapshot = benchSnapshot('vocab', [benchEvent({ id: 'a', subject: 'build', slot: 'command', text: 'Build the workspace with npm run build.' }),
      benchEvent({ id: 'b', subject: 'secrets', slot: 'storage', text: 'Secrets are stored in the OS keychain.' })]);
    expect(buildMemoryContextPack(snapshot, benchQuery('how do I compile everything')).receipt.selectedEventIds).toEqual(['a']);
    expect(buildMemoryContextPack(snapshot, benchQuery('where do credentials live')).receipt.selectedEventIds).toEqual(['b']);
    expect(buildMemoryContextPack(snapshot, benchQuery('what color is the logo')).status).toBe('none');
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
      + 'time-mode="current" time-at="2026-09-30T00:00:00.000Z" known-at="2026-09-20T00:00:00.000Z" omitted="observedAt=validFrom validUntil=null">');
    expect(pack.text.match(/known-?at/gi)).toHaveLength(1);
  });
  it('the regression gate passes the governed arm and names every floor a degraded builder breaks', () => {
    expect(memoryBenchmarkFloorViolations(runMemoryBenchmark())).toEqual([]);
    const degraded = runMemoryBenchmark([{ arm: 'governed', builder: (snapshot, query) => {
      const pack = buildMemoryContextPack(snapshot, query) as MemoryContextPack;
      // Over budget on every ready pack, and a paraphrase miss: both must be named.
      return pack.status === 'ready' ? { ...pack, bytes: (query as { maxBytes: number }).maxBytes + 1 } : pack;
    } }]);
    const violations = memoryBenchmarkFloorViolations(degraded);
    expect(violations.some(line => line.startsWith('over budget: '))).toBe(true);
    expect(violations.some(line => line.startsWith('retrieval paraphrase: '))).toBe(true);
    const flat = runMemoryBenchmark([{ arm: 'governed', builder: buildFlatLatestMemoryDiagnostic }]);
    expect(memoryBenchmarkFloorViolations(flat)).toEqual(expect.arrayContaining([expect.stringMatching(/^forbidden text leaked/), expect.stringMatching(/^overall: /)]));
  }, 60_000);
  it('withholds a fact whose cited source changed, and says so for the topic asked about', () => {
    const event = (id: string, text: string, locator: string, quote: string) => ({ ...benchEvent({ id, subject: 'config', slot: id, text }),
      sourceRefs: [{ id: id + ':source', digest: 'sha256_' + 'a'.repeat(64), locator, quote, observedAt: benchDay(1) }] });
    const port = event('port', 'The API listens on port 3000 by default.', 'file:src/config.ts:7', 'PORT ?? 3000');
    const tls = event('tls', 'The API terminates TLS at the ingress.', 'file:k8s/ingress.yaml:3', 'tls: true');
    const snapshot = benchSnapshot('stale', [port, tls]);
    const fresh = buildMemoryContextPack(snapshot, benchQuery('which port does the API listen on'), { changedSourceIds: [] });
    expect(fresh.receipt.selectedEventIds).toContain('port');
    const stale = buildMemoryContextPack(snapshot, benchQuery('which port does the API listen on'), { changedSourceIds: ['port:source'] });
    expect(stale.receipt.selectedEventIds).not.toContain('port');
    expect(stale.receipt.exclusions).toContainEqual({ eventId: 'port', reason: 'source-changed' });
    expect(stale.text).toMatch(/^Withheld 1 fact\(s\) on this topic: a cited source changed/m);
    for (const options of [{}, { changedSourceIds: 'port:source' }, { changedSourceIds: ['../x'] }, { changedSourceIds: [], extra: 1 }, null]) {
      expect(buildMemoryContextPack(snapshot, benchQuery('port'), options).receipt.stopReasons).toEqual(['invalid-options']);
    }
  });
  it('ranks checkable evidence first and drops uncited claims and restatements it outranks', () => {
    const event = (id: string, text: string, locator: string, quote: string) => ({ ...benchEvent({ id, subject: id, slot: 'format', text }),
      sourceRefs: [{ id: id + ':source', digest: 'sha256_' + (id === 'chat' ? 'c' : 'b').repeat(64), locator, quote, observedAt: benchDay(1) }] });
    const cited = event('cited', 'Invoice numbers use the format INV-year-sequence.', 'file:src/invoices/number.ts:6', 'return `INV-${year}-${seq}`;');
    const guess = event('guess', 'Invoice numbers are UUIDs.', 'inference:own reasoning', 'the table uses uuid keys so invoice numbers must be uuids');
    const chat = event('chat', 'Invoice numbers look like INV-2026-00042.', 'chat:agent:reviewer', 'they look like INV-2026-00042');
    const echo = event('echo', 'Invoice numbers use the format INV-year-sequence.', 'file:src/invoices/number.ts:6', 'return `INV-${year}-${seq}`;');
    const pack = buildMemoryContextPack(benchSnapshot('evidence', [guess, chat, cited, echo]), benchQuery('what is the invoice number format'));
    expect(pack.receipt.selectedEventIds).toEqual(['cited']);
    expect(pack.receipt.exclusions).toEqual(expect.arrayContaining([{ eventId: 'guess', reason: 'weaker-evidence' }, { eventId: 'chat', reason: 'weaker-evidence' },
      { eventId: 'echo', reason: 'duplicate' }]));
    // With nothing checkable on the topic, an unverified fact is still served.
    expect(buildMemoryContextPack(benchSnapshot('weak', [guess]), benchQuery('invoice numbers')).receipt.selectedEventIds).toEqual(['guess']);
  });
  it('leaves out only time fields equal to the default the boundary tag declares', () => {
    const plain = benchEvent({ id: 'a', subject: 'build', slot: 'command', text: 'Build with npm run build.' });
    const dated = benchEvent({ id: 'b', subject: 'build', slot: 'cache', text: 'Build cache is safe to clear.', recordedAt: benchDay(3), validFrom: benchDay(2),
      validUntil: benchDay(20) });
    const pack = buildMemoryContextPack(benchSnapshot('time', [plain, dated]), benchQuery('build', { at: benchDay(10) }));
    const rows = new Map(pack.text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>)
      .map(row => [row.eventId, row]));
    expect(rows.get('a')).toMatchObject({ validFrom: plain.validFrom }); expect(rows.get('a')).not.toHaveProperty('observedAt');
    expect(rows.get('a')).not.toHaveProperty('validUntil');
    expect(rows.get('b')).toMatchObject({ observedAt: dated.observedAt, validFrom: dated.validFrom, validUntil: dated.validUntil });
  });
  it('the CLI accepts only its three flags and gates only with --check', () => {
    expect(parseMemoryBenchmarkArgs([])).toEqual({ cases: false, check: false });
    expect(parseMemoryBenchmarkArgs(['--json', '--cases', '--check'])).toEqual({ cases: true, check: true });
    for (const args of [['--model', 'x'], ['--cases', '--cases'], ['/tmp/export.json']]) expect(benchmarkMemoryCli(args).exitCode).toBe(2);
    const gated = benchmarkMemoryCli(['--check']) as { exitCode: number; output: { gate: { pass: boolean; violations: string[] } } };
    expect(gated.output.gate).toEqual({ pass: true, violations: [] }); expect(gated.exitCode).toBe(0);
    const result = benchmarkMemoryCli(['--json']) as { exitCode: number; output: { protocol: string; source: { observation: string } } };
    expect(result.exitCode).toBe(0);
    expect(result.output.protocol).toBe('phantom-memory-benchmark-v2');
    expect(result.output.source.observation).toBe('source-checkout-not-installed-build');
  }, 60_000);
});
