import { describe, expect, it } from 'vitest';
import { findHotFiles } from '../src/core/fleet/hot-files.js';
import { buildNodeContextPack, type NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';

const input: NodeContextPackInput = {
  node: { jobId: 'worker', upstreamJobIds: ['up'] },
  tasks: [{ jobId: 'worker', text: 'Implement fix' }],
  outputs: [{ jobId: 'up', text: 'Context '.repeat(100) }], byteBudget: 2000,
};

describe('node context hot files', () => {
  it('requires three distinct PRs and counts duplicates only once', () => {
    expect(findHotFiles([['a', 'a', './b'], ['a', 'b'], ['a', 'b', 'c']]))
      .toEqual([{ path: 'a', count: 3 }, { path: 'b', count: 3 }]);
    expect(findHotFiles([['a', 'a', 'a'], ['a']])).toEqual([]);
    expect(findHotFiles([])).toEqual([]);
    expect(findHotFiles([['../unsafe'], ['../unsafe'], ['../unsafe']])).toEqual([]);
  });

  it('caps at ten, orders by descending count then path, without mutating input', () => {
    const paths = Array.from({ length: 12 }, (_, i) => `file-${String(i).padStart(2, '0')}`).reverse();
    const prs = Object.freeze([Object.freeze(paths), Object.freeze([...paths]), Object.freeze([...paths]), ['z']]);
    expect(findHotFiles([...prs, ['z'], ['z'], ['z']])).toEqual([
      { path: 'z', count: 4 },
      ...[...paths].sort().slice(0, 9).map(path => ({ path, count: 3 })),
    ]);
  });

  it('leaves pack bytes unchanged for missing or empty hot files in both allocation modes', () => {
    for (const fairUpstream of [false, true]) {
      for (const byteBudget of [0, 80, 200, 2000]) {
        const fixture = { ...input, fairUpstream, byteBudget };
        expect(buildNodeContextPack({ ...fixture, hotFiles: [] })).toBe(buildNodeContextPack(fixture));
      }
    }
  });

  it('renders counts before task context and reuses singleton advice', () => {
    const pack = buildNodeContextPack({ ...input, hotFiles: [{ path: 'CHANGELOG.md', count: 10 }] });
    const rows = pack.trim().split('\n').map(line => JSON.parse(line));
    expect(rows[0].kind).toBe('notice');
    expect(rows[0].text).toContain('CHANGELOG.md');
    expect(rows[0].text).toContain('10 open PRs');
    expect(rows[0].text).toContain('changelog.d fragment');
    expect(rows[1].kind).toBe('output');
  });

  it('bounds supplied entries and keeps bus notices first', () => {
    const hotFiles = Array.from({ length: 20 }, (_, i) => ({ path: `f${i}`, count: 3 }));
    const pack = buildNodeContextPack({ ...input, byteBudget: 10000, hotFiles,
      notices: [{ id: 'one', from: 'peer', channel: 'worker', at: '2026-10-31', priority: 'P1', text: 'Bus message' }],
    });
    const rows = pack.trim().split('\n').map(line => JSON.parse(line));
    expect(rows[0].jobId).toBe('bus/one');
    const hotRows = rows.filter(row => row.jobId === 'fleet/hot-files');
    expect(hotRows.length).toBeGreaterThan(0);
    expect(hotRows.length).toBeLessThanOrEqual(10);
    expect(hotRows.some(row => row.text.includes('"f10"'))).toBe(false);
    expect(buildNodeContextPack({ ...input, hotFiles: [
      { path: '../unsafe', count: 3 }, { path: 'safe', count: NaN }, { path: 'safe', count: 2 },
    ] })).toBe(buildNodeContextPack(input));
  });

  it('keeps Unicode and escaped paths inside JSON and respects all byte budgets', () => {
    const hotFiles = Array.from({ length: 20 }, () => ({ path: '🌍"'.repeat(500), count: 3 }));
    for (const fairUpstream of [false, true]) {
      for (let byteBudget = 0; byteBudget < 1500; byteBudget += 7) {
        const pack = buildNodeContextPack({ ...input, fairUpstream, byteBudget, hotFiles });
        expect(Buffer.byteLength(pack)).toBeLessThanOrEqual(byteBudget);
        const rows = pack.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        expect(rows.every(row => !row.text.includes('\uFFFD'))).toBe(true);
        const notices = rows.filter(row => row.kind === 'notice');
        expect(notices.length).toBeLessThanOrEqual(10);
        expect(Buffer.byteLength(notices.map(row => JSON.stringify(row) + '\n').join(''))).toBeLessThanOrEqual(1024);
      }
    }
  }, 30_000);
});
