import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { dedupeQueue, dedupeQueueFile } from '../src/core/queue/dedupe.js';
import { cmdQueueDedupe } from '../src/cli/queue-dedupe.js';
import { semanticDedupe } from '../src/core/queue/semantic-dedupe.js';

const queue = [
  '- CLAIMED 09:15 dispatchd RQ-FIRST (repo=lexicon): Edit tests/code-spans.test.ts. Acceptance: handle "adjacent inline code spans".',
  '- READY RQ-EXACT (repo=lexicon): Edit tests/code-spans.test.ts. Acceptance: handle "adjacent inline code spans".',
  '- READY RQ-NEAR (repo=lexicon): Fix tests/code-spans.test.ts. Acceptance: test "adjacent inline code spans" fully.',
  '- READY RQ-OTHER (repo=lexicon): Fix tests/code-spans.test.ts. Acceptance: handle "nested spans".',
  '- READY RQ-UNKNOWN (repo=lexicon): no evidence',
].join('\n') + '\n';

describe('queue dedupe', () => {
  it('collapses the reconstructed fourteen-job incident to two goals', async () => {
    const fixture = await readFile(new URL('./fixtures/queue-semantic-nov16.md', import.meta.url), 'utf8');
    const result = dedupeQueue(fixture);
    expect(result.output.match(/^- READY /gm)).toHaveLength(2);
    expect(result.report.repeats).toHaveLength(12);
    expect(result.report.repeats.every(r => r.reason === 'semantic-goal-overlap' && r.jaccard! >= 0.5)).toBe(true);
    expect(result.report.unknown).toEqual([]);
    expect(dedupeQueue(result.output).report.count).toBe(0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdQueueDedupe(['--file', new URL('./fixtures/queue-semantic-nov16.md', import.meta.url).pathname, '--json'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ count: 12, applied: false, repeats: result.report.repeats });
    } finally { log.mockRestore(); }
  });
  it.each(['CLAIMED 12:00 dispatchd codex-personal', 'running'])('compares %s rows and preserves distinct goals', status => {
    const row = (id: string, goal: string, status = 'READY', repo = 'phantom') => `- ${status} ${id} (repo=${repo}): ${goal}\n`;
    const goal = 'module guardian retry repair deduplicate';
    const text = row('RQ-NEW', goal) + row('RQ-DISTINCT', 'module guardian report latency histogram') +
      row('RQ-REPO', goal, 'READY', 'locus') + row('RQ-FILE', goal.replace('guardian', 'rebase')) +
      row('RQ-OLD', goal, status) + row('RQ-UNKNOWN', 'no target');
    const result = semanticDedupe(text);
    expect(result.repeats.map(r => [r.id, r.repeatOf])).toEqual([['RQ-NEW', 'RQ-OLD']]);
    expect(result.unknown.map(r => r.id)).toEqual(['RQ-UNKNOWN']);
    expect(result.output).toContain('- DUPLICATE-OF-RQ-OLD RQ-NEW');
    expect(semanticDedupe(row('RQ-A', 'src/a.ts alpha beta gamma') + row('RQ-B', 'src/a.ts alpha beta delta')).repeats[0]?.jaccard).toBe(0.5);
    for (const [a, b] of [['src/a.ts alpha beta gamma', 'src/a.ts alpha delta epsilon'], ['a.test.ts retry repair deduplicate', 'b.test.ts retry repair deduplicate'], ['src/a.ts repair broken retry PR#7', 'src/a.ts repair broken retry PR#8']]) {
      expect(semanticDedupe(row('RQ-A', a!) + row('RQ-B', b!)).repeats).toEqual([]);
    }
  });
  it('finds exact and quoted near repeats while preserving other and unknown jobs', () => {
    const { report, output } = dedupeQueue(queue);
    expect(report.repeats.map(r => [r.id, r.repeatOf, r.match])).toEqual([['RQ-EXACT', 'RQ-FIRST', 'acceptance'], ['RQ-NEAR', 'RQ-FIRST', 'quoted']]);
    expect(report.unknown).toHaveLength(1);
    expect(output).toContain('- READY RQ-OTHER');
    expect(output).toContain('- SUPERSEDED-BY-RQ-FIRST RQ-NEAR');
    expect(dedupeQueue(output).report.count).toBe(0);
  });
  it('previews without writing and applies with the shared lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'queue-dedupe-'));
    const path = join(dir, 'router-queue.md');
    await writeFile(path, queue);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdQueueDedupe(['--file', path, '--json'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ count: 2, applied: false, repeats: [{ id: 'RQ-EXACT' }, { id: 'RQ-NEAR' }] });
      expect(await readFile(path, 'utf8')).toBe(queue);
      expect((await dedupeQueueFile(path, true)).applied).toBe(true);
      expect(await readFile(path, 'utf8')).toBe(dedupeQueue(queue).output);
    } finally { log.mockRestore(); }
  });
});
