import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStuckQueue, stuckEventTally, stuckJobs } from '../src/core/queue/stuck.js';

describe('waiting router jobs', () => {
  it('uses enqueue time, then first dispatch evidence, otherwise unknown, excluding launches', () => {
    const now = new Date('2026-01-01T00:10:00').getTime();
    const epoch = Math.floor(now / 1000) - 30;
    const queue = `- READY RQ-A (enq=${epoch}): task\n- READY RQ-B (pool=x): task\n- READY RQ-C (pool=x): task\n- READY RQ-D (pool=x): task\n`;
    const events = '2026-01-01 00:08:00 SEEN RQ-A RQ-B\n2026-01-01 00:09:00 SEEN RQ-B\n2026-01-01 00:09:00 LAUNCH RQ-D repo lane work\n';
    expect(stuckJobs(queue, events, now)).toEqual([{ id: 'RQ-A', age_s: 30 }, { id: 'RQ-B', age_s: 120 }, { id: 'RQ-C', age: 'unknown' }]);
  });

  it('ignores launches before a new enqueue or after the observation time', () => {
    const now = new Date('2026-01-01T00:10:00').getTime();
    const epoch = Math.floor(now / 1000) - 30;
    const queue = `- READY RQ-A (enq=${epoch}): task\n- READY RQ-B (enq=${epoch}): task\n`;
    const events = '2026-01-01 00:08:00 LAUNCH RQ-A\n2026-01-01 00:11:00 LAUNCH RQ-B\n';
    expect(stuckJobs(queue, events, now)).toEqual([{ id: 'RQ-A', age_s: 30 }, { id: 'RQ-B', age_s: 30 }]);
  });

  it('folds events incrementally: earliest mention, latest launch', () => {
    const now = new Date('2026-01-01T00:10:00').getTime();
    const events = [
      '2026-01-01 00:05:00 SEEN RQ-A',
      'not an event line',
      '2026-01-01 00:06:00 LAUNCH RQ-A repo lane work',
      '2026-01-01 00:07:00 SEEN RQ-B',
      '2026-01-01 00:07:30 LAUNCH RQ-B repo lane work',
      '2026-01-01 00:08:00 LAUNCH RQ-B repo lane work',
      '2026-01-01 00:11:00 LAUNCH RQ-C repo lane work',
    ].join('\n');
    const tally = stuckEventTally(now);
    for (const line of events.split('\n')) tally.add(line);
    const at = (stamp: string) => new Date(stamp.replace(' ', 'T')).getTime();
    expect(tally.first.get('RQ-A')).toBe(at('2026-01-01 00:05:00'));
    expect(tally.first.get('RQ-B')).toBe(at('2026-01-01 00:07:00'));
    expect(tally.launched.get('RQ-A')).toBe(at('2026-01-01 00:06:00'));
    // The latest in-window launch wins; the post-now one is ignored entirely.
    expect(tally.launched.get('RQ-B')).toBe(at('2026-01-01 00:08:00'));
    expect(tally.launched.has('RQ-C')).toBe(false);
    // The batch reader and the incremental fold agree on the waiting set.
    const queue = '- READY RQ-A (pool=x): task\n- READY RQ-B (pool=x): task\n- READY RQ-C (pool=x): task\n';
    expect(stuckJobs(queue, events, now)).toEqual([{ id: 'RQ-C', age: 'unknown' }]);
    // A launch before a fresh enqueue does not hide the new wait.
    const epoch = Math.floor(now / 1000) - 30;
    expect(stuckJobs(`- READY RQ-A (enq=${epoch}): task\n`, events, now)).toEqual([{ id: 'RQ-A', age_s: 30 }]);
  });
});

describe('readStuckQueue', () => {
  it('streams a large dispatch-events.log without changing the answer', async () => {
    const now = new Date('2026-01-01T00:10:00').getTime();
    const dir = await mkdtemp(join(tmpdir(), 'queue-stuck-'));
    try {
      await mkdir(join(dir, 'queue'));
      await writeFile(join(dir, 'queue', 'router-queue.md'),
        '- READY RQ-OLD (pool=x): waited\n- READY RQ-LAUNCHED (pool=x): done\n');
      // Thousands of lines so the read cannot be one buffered string in practice;
      // first-seen at the head, the launch near the tail.
      const filler = Array.from({ length: 4000 }, (_, i) =>
        `2026-01-01 00:0${i % 6}:${String(i % 60).padStart(2, '0')} HEARTBEAT tick ${i}`).join('\n');
      await writeFile(join(dir, 'dispatch-events.log'),
        `2026-01-01 00:01:00 SEEN RQ-OLD\n${filler}\n2026-01-01 00:09:00 LAUNCH RQ-LAUNCHED repo lane work\n`);
      const report = await readStuckQueue(dir, now);
      expect(report.eventsAvailable).toBe(true);
      expect(report.jobs).toEqual([{ id: 'RQ-OLD', age_s: 540 }]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
