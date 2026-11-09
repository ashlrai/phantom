import { describe, expect, it } from 'vitest';
import { prepareDataset, sampleHash, digest, type TuneSample } from '../src/core/tune/dataset.js';
import { evaluateAdapter, type TuneObservation } from '../src/core/tune/evaluation.js';

function fixtures(n = 25): TuneSample[] {
  return Array.from({ length: n }, (_, i) => {
    const s: TuneSample = { jobId: `job-${i}`, task: `Fix parser case ${i}`, mergedDiff: `+return ${i};`,
      rejectedLocalDiff: '+return null;', mergeSha: 'a'.repeat(40), mergedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      review: { model: 'codex', verdict: 'approve', critique: 'Preserve the numeric result.', contentHash: '' } };
    s.review.contentHash = sampleHash(s); return s;
  });
}
describe('tune dataset', () => {
  it('holds out recent whole tasks and excludes them from preference training', async () => {
    const data = await prepareDataset(fixtures(), async () => true);
    expect(data.train).toHaveLength(15); expect(data.valid).toHaveLength(5); expect(data.test).toHaveLength(5);
    expect(data.preferences).toHaveLength(15);
    expect(data.manifest.testIds).toEqual(fixtures().slice(-5).map(s => digest(s.jobId)));
    expect(JSON.stringify(data.preferences)).not.toContain('Fix parser case 24');
    expect(await prepareDataset(fixtures().reverse(), async () => true)).toEqual(data);
  });
  it('drops scanner hits, mutated approvals, unknown reviewers and duplicate task groups', async () => {
    const rows = fixtures();
    rows[0]!.task = 'Changed after review';
    const wrong = { ...rows[1], review: { ...rows[1]!.review, model: 'local' } };
    const duplicate = { ...rows[2]!, jobId: 'duplicate' }; duplicate.review = { ...duplicate.review, contentHash: sampleHash(duplicate) };
    const data = await prepareDataset([...rows, wrong, duplicate], async raw => !raw.includes('job-3"'));
    expect(data.manifest.accepted).toBe(23); expect(data.manifest.dropped).toBe(4);
  });
  it('drops secrets before passing content to the external scanner', async () => {
    const rows = fixtures();
    rows[0]!.task = 'token ghp_' + 'a'.repeat(36); rows[0]!.review.contentHash = sampleHash(rows[0]!);
    const scanned: string[] = [];
    const data = await prepareDataset(rows, async raw => { scanned.push(raw); return true; });
    expect(data.manifest.dropped).toBe(1); expect(scanned).toHaveLength(24);
    expect(scanned.some(s => s.includes('ghp_'))).toBe(false);
  });
  it('fails closed on scanner failure, insufficient clean data and excessive input', async () => {
    await expect(prepareDataset(fixtures(), async () => false)).rejects.toThrow('five');
    await expect(prepareDataset(fixtures(), async () => { throw new Error('scanner unavailable'); })).rejects.toThrow('scanner unavailable');
    await expect(prepareDataset(Array.from({ length: 10001 }), async () => true)).rejects.toThrow('bound');
  });
  it('keeps unknown metadata out of datasets and scanning', async () => {
    const rows = fixtures().map(s => ({ ...s, extra: 'untrusted metadata' }));
    const output = await prepareDataset(rows, async raw => !raw.includes('untrusted metadata'));
    expect(output.manifest.accepted).toBe(25);
    expect(JSON.stringify(output)).not.toContain('untrusted metadata');
  });
});
const observations = (passed: boolean): TuneObservation[] => Array.from({ length: 5 }, (_, i) => ({
  taskId: digest(`heldout-${i}`), passed, mergeGatePassed: true, latencyMs: 100, tokensPerSecond: 20,
}));
describe('tune paired gate', () => {
  it('requires strict quality improvement on the same held-out tasks', () => {
    const base = observations(false); const candidate = observations(true); const ids = base.map(r => r.taskId);
    expect(evaluateAdapter(base, candidate, ids).decision).toBe('eligible-for-review');
    expect(evaluateAdapter(candidate, candidate, ids).decision).toBe('reject');
    expect(evaluateAdapter(base, [...candidate].reverse(), ids).decision).toBe('eligible-for-review');
  });
  it.each(['latencyMs', 'tokensPerSecond', 'mergeGatePassed'] as const)('rejects regression in %s', field => {
    const base = observations(false); const candidate = observations(true);
    Object.assign(candidate[0]!, { [field]: field === 'latencyMs' ? 101 : field === 'tokensPerSecond' ? 19 : false });
    expect(evaluateAdapter(base, candidate, base.map(r => r.taskId)).decision).toBe('reject');
  });
  it('rejects empty, mismatched, duplicate and nonfinite evaluation claims', () => {
    const base = observations(false); const ids = base.map(r => r.taskId);
    expect(() => evaluateAdapter([], [], [])).toThrow();
    expect(() => evaluateAdapter(base, base, [...ids.slice(1), digest('other')])).toThrow();
    expect(() => evaluateAdapter(base, base, [...ids.slice(1), ids[1]!])).toThrow();
    expect(() => evaluateAdapter(base, [{ ...base[0]!, latencyMs: NaN }, ...base.slice(1)], ids)).toThrow();
  });
});
