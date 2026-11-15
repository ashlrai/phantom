import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeLeaderReplyBatch } from '../src/core/agents/leader-reply-queue.js';

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'leader-queue-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('rotates past five offline replies across fresh drain invocations without inspecting values', () => {
  const dir = root();
  const pending = Array.from({ length: 12 }, (_, id) => ({ id, get text(): never { throw new Error('body inspected'); } }));
  expect(takeLeaderReplyBatch(pending, dir, 'slack-reply-cursor.json').map(row => row.id)).toEqual([0, 1, 2, 3, 4]);
  expect(takeLeaderReplyBatch(pending, dir, 'slack-reply-cursor.json').map(row => row.id)).toEqual([5, 6, 7, 8, 9]);
  expect(takeLeaderReplyBatch(pending, dir, 'slack-reply-cursor.json').map(row => row.id)).toEqual([10, 11, 0, 1, 2]);
  expect(readFileSync(join(dir, 'slack-reply-cursor.json'), 'utf8')).toBe('3');
});

it('isolates responder cursors and recovers from queue shrinkage and malformed metadata', () => {
  const dir = root();
  takeLeaderReplyBatch([0, 1, 2, 3, 4, 5], dir, 'slack-reply-cursor.json');
  expect(takeLeaderReplyBatch([0, 1, 2, 3, 4, 5], dir, 'network-cursor.json')).toEqual([0, 1, 2, 3, 4]);
  expect(takeLeaderReplyBatch([0, 1], dir, 'slack-reply-cursor.json')).toEqual([1, 0]);
  for (const value of ['{', '-1', 'null', '1e100']) {
    writeFileSync(join(dir, 'slack-reply-cursor.json'), value);
    expect(takeLeaderReplyBatch([0, 1], dir, 'slack-reply-cursor.json')).toEqual([0, 1]);
  }
  expect(takeLeaderReplyBatch([], dir, 'slack-reply-cursor.json')).toEqual([]);
});
