import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markMergedQueueLinesDone } from '../src/core/fleet/self-heal-queue-prune.js';

const fixtureQueue = readFileSync(new URL('./fixtures/queue/router-queue.md', import.meta.url), 'utf8');

let dir: string;
let queuePath: string;
let ghCachePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'queue-prune-'));
  queuePath = join(dir, 'router-queue.md');
  ghCachePath = join(dir, 'gh-prs.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const queue = (text: string) => writeFileSync(queuePath, text, { mode: 0o600 });
const cache = (value: unknown) => writeFileSync(ghCachePath, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
const pr = (number: number, state: string) =>
  ({ number, url: `https://github.com/ashlrai/phantom/pull/${number}`, state });
const lines = () => readFileSync(queuePath, 'utf8').split('\n').filter((line) => line.startsWith('- '));

describe('markMergedQueueLinesDone', () => {
  it('marks PR-OPEN lines DONE when the cached gh state is MERGED, leaves OPEN and unknown PRs', () => {
    queue(fixtureQueue + '- PR-OPEN RQ-FIXTURE-UNKNOWN (pool=codex-personal, tier=work, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/127\n');
    cache([pr(123, 'MERGED'), pr(124, 'OPEN')]);
    const result = markMergedQueueLinesDone({ queuePath, ghCachePath });
    expect(result).toEqual({ scanned: 9, marked: 1, failed: false });
    const rows = lines();
    expect(rows.find((line) => line.includes('RQ-FIXTURE-PR-OPEN'))).toMatch(/^- DONE /);
    expect(rows.find((line) => line.includes('RQ-FIXTURE-LAND'))).toMatch(/^- LAND /);
    expect(rows.find((line) => line.includes('RQ-FIXTURE-UNKNOWN'))).toMatch(/^- PR-OPEN /);
  });

  it('marks lines DONE when the cached gh state is CLOSED', () => {
    queue(fixtureQueue + '- LAND RQ-FIXTURE-CLOSED (pool=codex-personal, tier=work, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/125 BASE_OVERRIDE=keep-me\n');
    cache([pr(123, 'MERGED'), pr(124, 'CLOSED'), pr(125, 'CLOSED')]);
    const result = markMergedQueueLinesDone({ queuePath, ghCachePath });
    expect(result).toEqual({ scanned: 9, marked: 3, failed: false });
    const rows = lines();
    expect(rows.filter((line) => line.startsWith('- DONE '))).toHaveLength(3);
    const closed = rows.find((line) => line.includes('RQ-FIXTURE-CLOSED'))!;
    expect(closed).toMatch(/^- DONE /);
    expect(closed).toContain('BASE_OVERRIDE=keep-me');
  });

  it('leaves OPEN PRs untouched in every status', () => {
    queue(fixtureQueue);
    cache([pr(123, 'OPEN'), pr(124, 'OPEN')]);
    const before = readFileSync(queuePath, 'utf8');
    const result = markMergedQueueLinesDone({ queuePath, ghCachePath });
    expect(result).toEqual({ scanned: 8, marked: 0, failed: false });
    expect(readFileSync(queuePath, 'utf8')).toBe(before);
  });

  it('preserves comments, blank lines, freeform notes, ordering and unknown fields byte-identically', () => {
    queue(fixtureQueue);
    cache([pr(123, 'merged'), pr(124, 'merged')]);
    const result = markMergedQueueLinesDone({ queuePath, ghCachePath });
    expect(result.marked).toBe(2);
    const text = readFileSync(queuePath, 'utf8');
    expect(text).toContain('<!-- Preserve comments, blank lines, ordering, punctuation, and unknown fields. -->\n\n');
    expect(text).toContain('\n\nFreeform operator note: READY and BASE_OVERRIDE here must survive round trips.\n');
    expect(text).toContain('`code`, commas, and colons: detail. EXTRA=keep-me');
    expect(text).toContain('READY in prose is not a status');
    expect(text).toContain('BASE_OVERRIDE=fixture-integration');
    expect(text.endsWith('\n')).toBe(true);
    // Only the status token changed on the marked lines.
    const beforeLines = fixtureQueue.split('\n');
    const afterLines = readFileSync(queuePath, 'utf8').split('\n');
    expect(afterLines).toHaveLength(beforeLines.length);
    for (const [index, before] of beforeLines.entries()) {
      const after = afterLines[index]!;
      if (before === after) continue;
      expect(after).toBe(before.replace(/^- [A-Z][A-Z0-9-]*/, '- DONE'));
      expect(before).toMatch(/^- (PR-OPEN|LAND) /);
    }
  });

  it('never rewrites DONE or CANCELLED lines even when their PR is terminal', () => {
    queue('- DONE RQ-A (pool=x, tier=work, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/1\n' +
      '- CANCELLED RQ-B (pool=x, tier=work, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/2\n');
    cache([pr(1, 'MERGED'), pr(2, 'MERGED')]);
    const before = readFileSync(queuePath, 'utf8');
    expect(markMergedQueueLinesDone({ queuePath, ghCachePath })).toEqual({ scanned: 2, marked: 0, failed: false });
    expect(readFileSync(queuePath, 'utf8')).toBe(before);
  });

  it('requires every PR= on a multi-PR line to be terminal before marking', () => {
    queue('- PR-OPEN RQ-MULTI (pool=x, tier=work, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/1 PR=https://github.com/ashlrai/phantom/pull/2\n');
    cache([pr(1, 'MERGED'), pr(2, 'OPEN')]);
    expect(markMergedQueueLinesDone({ queuePath, ghCachePath })).toEqual({ scanned: 1, marked: 0, failed: false });
    cache([pr(1, 'MERGED'), pr(2, 'CLOSED')]);
    expect(markMergedQueueLinesDone({ queuePath, ghCachePath })).toEqual({ scanned: 1, marked: 1, failed: false });
    expect(lines()[0]).toMatch(/^- DONE /);
  });

  it('accepts a single gh pr view object and a {prs:[...]} envelope; matches case-insensitively', () => {
    queue('- PR-OPEN RQ-A (pool=x, tier=work, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/1\n');
    cache({ url: 'https://github.com/ashlrai/phantom/pull/1', state: 'MERGED' });
    expect(markMergedQueueLinesDone({ queuePath, ghCachePath }).marked).toBe(1);
    queue('- PR-OPEN RQ-B (pool=x, tier=work, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/2\n');
    cache({ prs: [{ url: 'HTTPS://GITHUB.COM/ASHLRAI/PHANTOM/pull/2', state: 'Closed' }] });
    expect(markMergedQueueLinesDone({ queuePath, ghCachePath }).marked).toBe(1);
  });

  it('does not mark when cached states for the same URL conflict', () => {
    queue('- PR-OPEN RQ-A (pool=x, tier=work, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/1\n');
    cache([pr(1, 'MERGED'), pr(1, 'OPEN')]);
    expect(markMergedQueueLinesDone({ queuePath, ghCachePath })).toEqual({ scanned: 1, marked: 0, failed: false });
  });

  it('treats an empty cached list as a valid empty cache and marks nothing', () => {
    queue('- PR-OPEN RQ-A (pool=x, tier=work, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/1\n');
    cache([]);
    expect(markMergedQueueLinesDone({ queuePath, ghCachePath })).toEqual({ scanned: 1, marked: 0, failed: false });
  });

  it.each([['"nope"'], ['{broken'], ['[{"state":"MERGED"}]'], ['[{"url":"https://x.io/a/pull/1","state":"MERGED"}]']])(
    'fails closed on a malformed gh cache %s without touching the queue',
    (raw) => {
      queue('- PR-OPEN RQ-A (pool=x, tier=work, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/1\n');
      cache(raw);
      const before = readFileSync(queuePath, 'utf8');
      const result = markMergedQueueLinesDone({ queuePath, ghCachePath });
      expect(result.failed).toBe(true);
      expect(readFileSync(queuePath, 'utf8')).toBe(before);
    });

  it('fails on a missing gh cache and reports a missing queue as nothing to do', () => {
    queue('- PR-OPEN RQ-A (pool=x, tier=work, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/1\n');
    const result = markMergedQueueLinesDone({ queuePath, ghCachePath });
    expect(result).toEqual({ scanned: 0, marked: 0, failed: true });
    expect(markMergedQueueLinesDone({ queuePath: join(dir, 'absent.md'), ghCachePath }))
      .toEqual({ scanned: 0, marked: 0, failed: false });
  });

  it('writes the marked queue through a lock-protected atomic file and cleans up', () => {
    queue('- PR-OPEN RQ-A (pool=x, tier=work, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/1\n');
    cache([pr(1, 'MERGED')]);
    expect(markMergedQueueLinesDone({ queuePath, ghCachePath }).marked).toBe(1);
    expect(lines()[0]).toMatch(/^- DONE /);
    expect(existsSync(`${queuePath}.lock`)).toBe(false);
  });
});
