import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateResearchLines, RESEARCH_ACCEPTANCE_TAIL } from '../src/core/driver/research-restock.js';
import { restockQueue } from '../src/core/driver/restock.js';

const topics = readFileSync(new URL('./fixtures/research-restock/topics.md', import.meta.url), 'utf8');
const queue = readFileSync(new URL('./fixtures/research-restock/queue.txt', import.meta.url), 'utf8');
const input = { topics, queue, holdList: ['HELD', 'frozen deployment'], now: new Date('2026-10-26T13:00:00Z') };

describe('offline research restock', () => {
  it.each([2, 3, 4])('adds %i unique safe lines each UTC day and is idempotent', dailyTarget => {
    let currentQueue = queue;
    for (const day of [26, 27, 28]) {
      const request = { ...input, dailyTarget, queue: currentQueue, now: new Date(`2026-10-${day}T23:59:59Z`) };
      const result = restockQueue(request);
      expect(result.added).toHaveLength(dailyTarget);
      expect(new Set(result.added.map(line => line.split(' ')[0])).size).toBe(dailyTarget);
      for (const line of result.added) {
        expect(line).toMatch(new RegExp(`^RQ-RESEARCH-202610${day}-[A-Z-]+ \\(P2, pool=codex-personal, tier=work, repo=phantom\\): Research `));
        expect(line.endsWith(RESEARCH_ACCEPTANCE_TAIL)).toBe(true);
        expect(line).not.toMatch(/\.github|HELD|frozen deployment|\u2014|INVALID|DASH/);
        expect(currentQueue).not.toContain(line.split(' ')[0]);
      }
      expect(restockQueue({ ...request, queue: result.queue })).toEqual({ queue: result.queue, added: [] });
      currentQueue = result.queue;
    }
  });

  it('tops up partial days and counts duplicate IDs only once', () => {
    const first = generateResearchLines(input)[0];
    const result = restockQueue({ ...input, queue: `${queue}${first}\n${first}` });
    expect(result.added).toHaveLength(2);
    expect(result.queue).toContain(`${first}\n${result.added[0]}`);
  });

  it('honors full queue IDs and case-insensitive topic and phrase holds', () => {
    const lines = generateResearchLines({ ...input, holdList: ['retrieval', 'source freshness', 'LOCAL', 'handoff', 'held'] });
    expect(lines).toEqual([]);
    const first = generateResearchLines(input)[0];
    expect(generateResearchLines({ ...input, holdList: [...input.holdList, first.split(' ')[0].toLowerCase()] })).not.toContain(first);
  });

  it('fails closed for exhausted or malformed topics without altering queue', () => {
    expect(restockQueue({ ...input, topics: '# empty' })).toEqual({ queue, added: [] });
    expect(generateResearchLines({ ...input, topics: '- ONLY | One question', dailyTarget: 4 })).toHaveLength(1);
  });

  it('rejects control characters, line separators, em dashes and protected paths', () => {
    for (const question of ['unsafe\u2014text', 'unsafe\u2028text', 'unsafe\u2029text', 'unsafe\u0000text', '   ', 'Edit .GITHUB/actions']) {
      expect(generateResearchLines({ ...input, topics: `- UNSAFE | ${question}` })).toEqual([]);
    }
  });

  it('does not exceed the quota when a previous tick used a larger target', () => {
    const filled = restockQueue({ ...input, dailyTarget: 4 });
    expect(generateResearchLines({ ...input, queue: filled.queue, dailyTarget: 2 })).toEqual([]);
  });

  it.each([0, 1, 5, 2.5, NaN])('rejects invalid target %s', dailyTarget => {
    expect(() => generateResearchLines({ ...input, dailyTarget })).toThrow(RangeError);
  });

  it('uses UTC date at the day boundary and defaults to three', () => {
    const result = generateResearchLines({ ...input, now: new Date('2026-10-26T23:30:00-04:00') });
    expect(result).toHaveLength(3);
    expect(result.every(line => line.startsWith('RQ-RESEARCH-20261027-'))).toBe(true);
  });
});
