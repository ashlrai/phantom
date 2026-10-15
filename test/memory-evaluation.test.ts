/** Frozen synthetic oracle, no native/provider/state effects. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMemoryContextPack } from '../src/core/memory/pack.js';
import { immutableMemorySnapshot } from '../src/core/memory/validate.js';
import { MEMORY_EVAL_FAMILIES } from '../src/core/local-eval/memory-evaluation-types.js';
import { MEMORY_EVAL_CAPS, parseMemoryEvalCorpus, runMemoryEvaluation } from '../src/core/local-eval/memory-evaluation.js';
const text = readFileSync(new URL('./fixtures/memory/corpus-v1.json', import.meta.url), 'utf8');
const corpus = parseMemoryEvalCorpus(text);
const binding = { sha: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: true, workingSourceDigest: 'sha256_' + 'c'.repeat(64) };

describe('offline memory semantic corpus and evaluator', () => {
  it('assigns exactly six distinct variants in each of twelve behaviors, with independent literal gold and equal evidence access', () => {
    expect(corpus.cases).toHaveLength(72); expect(corpus.seed).toBe(20261014);
    for (const family of MEMORY_EVAL_FAMILIES) expect(corpus.cases.filter(entry => entry.family === family).map(entry => entry.variant).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(corpus.accessPolicy).toBe('identical-complete-case-snapshot-and-query; oracle-withheld-from-both-arms');
  });
  it('matches all independent temporal, authority, scope, lineage, budget and no-result outcomes', () => {
    const report = runMemoryEvaluation(text, binding, { repeats: 1 });
    const governed = report.arms[0]!;
    expect(governed.cases.filter(result => result.verdict !== 'pass').map(result => ({ id: result.caseId, failures: result.failures, status: result.status, selected: result.selectedEventIds }))).toEqual([]);
    expect(governed).toMatchObject({ assigned: 72, passed: 72, failed: 0, unknown: 0 });
    expect(report).toMatchObject({ modelTaskSuccess: 'not-evaluated', executionAuthority: false, sourceBinding: binding });
    expect(report.arms[1]!.assigned).toBe(72); expect(report.arms[1]!.failed).toBeGreaterThan(0);
    expect(governed.timing.firstCall.count).toBe(72); expect(governed.timing.repeats.count).toBe(72);
  });
  it('preserves all 72 literal semantic outcomes when reusable snapshots are prepared by the owning module', () => {
    const raw = runMemoryEvaluation(text, binding, { repeats: 1 }).arms[0]!;
    const prepared = runMemoryEvaluation(text, binding, { repeats: 1, governed: (snapshot, query) => buildMemoryContextPack(immutableMemorySnapshot(snapshot) ?? snapshot, query) }).arms[0]!;
    expect(prepared).toMatchObject({ assigned: 72, passed: 72, failed: 0, unknown: 0 });
    expect(prepared.cases.map(result => result.observationDigest)).toEqual(raw.cases.map(result => result.observationDigest));
  });
  it('keeps thrown/refused/unknown inputs in their assigned denominator, without private error output', () => {
    const report = runMemoryEvaluation(text, binding, { repeats: 1, governed: () => { throw new Error('/Users/private-provider-state'); } });
    expect(report.arms[0]).toMatchObject({ assigned: 72, passed: 0, failed: 0, unknown: 72 });
    expect(JSON.stringify(report)).not.toContain('/Users/private');
    expect(report.arms[0]!.cases.every(result => result.failures.join(',') === 'runner-error')).toBe(true);
  });
  it('detects changed warm output and never lets an arm mutate history for its peer or receive gold', () => {
    let calls = 0; let leakedGold = false;
    const report = runMemoryEvaluation(text, binding, { repeats: 1, governed: (snapshot, query) => {
      leakedGold ||= 'gold' in (snapshot as object) || 'gold' in (query as object);
      const pack = buildMemoryContextPack(snapshot, query);
      if (++calls % 2 === 0) pack.receipt.stopReasons.push('unstable-output');
      (snapshot as { events: unknown[] }).events.length = 0;
      return pack;
    } });
    expect(leakedGold).toBe(false); expect(report.arms[0]!.cases.every(result => result.failures.includes('repeat-output-changed'))).toBe(true);
    const clean = runMemoryEvaluation(text, binding, { repeats: 1 });
    expect(report.arms[1]!.cases.map(result => result.observationDigest)).toEqual(clean.arms[1]!.cases.map(result => result.observationDigest));
    expect(corpus.cases.some(entry => (entry.snapshot as { events: unknown[] }).events.length)).toBe(true);
  });
  it('grades deliberately plausible obsolete evidence as wrong rather than asking the selector to generate its own oracle', () => {
    const report = runMemoryEvaluation(text, binding, { repeats: 1, governed: (snapshot, query) => {
      const pack = buildMemoryContextPack(snapshot, query);
      if (pack.items.length) { pack.items[0]!.eventId = 'obsolete'; pack.receipt.selectedEventIds = ['obsolete']; }
      return pack;
    } });
    expect(report.arms[0]!.failed).toBeGreaterThan(0);
    expect(report.arms[0]!.cases.some(result => result.failures.includes('selected-events'))).toBe(true);
  });
  it.each(['receipt-digest', 'receipt-quote', 'text-omission', 'text-corruption'])('detects citation %s even when expected event IDs and fact text remain present', mode => {
    const report = runMemoryEvaluation(text, binding, { repeats: 1, governed: (snapshot, query) => {
      const pack = structuredClone(buildMemoryContextPack(snapshot, query));
      if (pack.items.length) {
        if (mode === 'receipt-digest') pack.items[0]!.sourceRefs[0]!.digest = 'sha256_' + 'e'.repeat(64);
        if (mode === 'receipt-quote') pack.items[0]!.sourceRefs[0]!.quote = 'Corrupted synthetic citation.';
        if (mode.startsWith('text-')) pack.text = pack.text.split('\n').map(line => {
          if (!line.startsWith('{')) return line;
          const row = JSON.parse(line);
          if (mode === 'text-omission') row.sourceRefs = [];
          else row.sourceRefs[0].digest = 'sha256_' + 'd'.repeat(64);
          return JSON.stringify(row);
        }).join('\n');
        pack.bytes = new TextEncoder().encode(pack.text).byteLength;
      }
      return pack;
    } });
    expect(report.arms[0]!.cases.some(result => result.failures.includes(mode.startsWith('text-') ? 'emitted-citation-payload' : 'citation-payload'))).toBe(true);
  });
  it.each(['duplicate', 'family', 'oversize', 'depth', 'extra', 'missing'])('refuses malformed or unbounded corpus %s before either arm is invoked', mode => {
    const invalid = JSON.parse(text);
    if (mode === 'duplicate') invalid.cases[1].id = invalid.cases[0].id;
    if (mode === 'family') invalid.cases[0].family = 'unknown';
    if (mode === 'extra') invalid.externalApiKey = 'do-not-use';
    if (mode === 'missing') invalid.cases.pop();
    if (mode === 'depth') { let value: unknown = 'deep'; for (let i = 0; i < 40; i++) value = { value }; invalid.cases[0].snapshot = value; }
    const bytes = mode === 'oversize' ? 'x'.repeat(MEMORY_EVAL_CAPS.corpusBytes + 1) : JSON.stringify(invalid);
    expect(() => parseMemoryEvalCorpus(bytes)).toThrow('corpus refused');
  });
  it('requires bounded repetition and exact declared source metadata, rather than inferring installed build identity', () => {
    expect(() => runMemoryEvaluation(text, { ...binding, sha: 'unknown' })).toThrow('source binding refused');
    expect(() => runMemoryEvaluation(text, binding, { repeats: 6 })).toThrow('repetition budget refused');
  });
});
