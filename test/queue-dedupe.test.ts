import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { dedupeQueue, dedupeQueueFile } from '../src/core/queue/dedupe.js';
import { cmdQueueDedupe } from '../src/cli/queue-dedupe.js';

const queue = [
  '- CLAIMED 09:15 dispatchd RQ-FIRST (repo=lexicon): Edit tests/code-spans.test.ts. Acceptance: handle "adjacent inline code spans".',
  '- READY RQ-EXACT (repo=lexicon): Edit tests/code-spans.test.ts. Acceptance: handle "adjacent inline code spans".',
  '- READY RQ-NEAR (repo=lexicon): Fix tests/code-spans.test.ts. Acceptance: test "adjacent inline code spans" fully.',
  '- READY RQ-OTHER (repo=lexicon): Fix tests/code-spans.test.ts. Acceptance: handle "nested spans".',
  '- READY RQ-UNKNOWN (repo=lexicon): no evidence',
].join('\n') + '\n';

describe('queue dedupe', () => {
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
