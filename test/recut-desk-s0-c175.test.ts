import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStuckQueue } from '../src/core/queue/stuck.js';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';
import { isFleetQueue, type FleetQueueV1 } from '../src/web-ui/routes/verse/ops/ops-queue-model.js';

// Recut of #4356 (RQ-QUEUEAGE2N9JQ8): the desktop Queue pane renders a
// "Waiting to launch" section from `stuck` on the live queue payload. The
// route composes it as { ...readFleetQueue(), stuck: readStuckQueue() }; the
// pane gates on isFleetQueue before reading data.stuck.

const now = new Date('2026-01-01T00:10:00').getTime();

async function runsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'recut-desk-s0-c175-'));
  await mkdir(join(dir, 'queue'));
  return dir;
}

describe('waiting-to-launch queue reading (recut of #4356)', () => {
  it('attaches measured and unknown waiting ages to a payload the console accepts', async () => {
    const dir = await runsDir();
    try {
      const epoch = Math.floor(now / 1000) - 30;
      await writeFile(join(dir, 'queue', 'ready.tsv'), 'READY\tRQ-WAIT-1\tdevin\twork\tphantom\tprompts/a.md\n');
      await writeFile(join(dir, 'queue', 'router-queue.md'),
        `- READY RQ-WAIT-1 (enq=${epoch}): first task\n- READY RQ-WAIT-2 (pool=x): second task\n`);
      await writeFile(join(dir, 'dispatch-events.log'), '2026-01-01 00:09:00 SEEN RQ-WAIT-2\n');
      const queue = await readFleetQueue({ runsDir: dir, now: () => now });
      queue.stuck = await readStuckQueue(dir, now).catch(() => null);
      expect(queue.stuck).toEqual({ jobs: [
        { id: 'RQ-WAIT-1', age_s: 30 },
        { id: 'RQ-WAIT-2', age_s: 60 },
      ], eventsAvailable: true });
      expect(isFleetQueue(queue)).toBe(true);
      const view: FleetQueueV1 = queue;
      expect(view.stuck?.jobs.map((job) => job.id)).toEqual(['RQ-WAIT-1', 'RQ-WAIT-2']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reports eventsAvailable=false when the dispatch log is absent and still validates', async () => {
    const dir = await runsDir();
    try {
      await writeFile(join(dir, 'queue', 'ready.tsv'), 'READY\tRQ-WAIT-1\tdevin\twork\tphantom\tprompts/a.md\n');
      await writeFile(join(dir, 'queue', 'router-queue.md'), '- READY RQ-WAIT-1 (pool=x): first task\n');
      const queue = await readFleetQueue({ runsDir: dir, now: () => now });
      queue.stuck = await readStuckQueue(dir, now).catch(() => null);
      expect(queue.stuck).toEqual({ jobs: [{ id: 'RQ-WAIT-1', age: 'unknown' }], eventsAvailable: false });
      expect(isFleetQueue(queue)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('accepts a null stuck section so the pane can render the unavailable reading', () => {
    const queue: FleetQueueV1 = {
      v: 1, generatedAt: '2026-01-01T00:00:00Z', sources: { ready: 'healthy', skips: 'missing' },
      total: 0, ready: 0, parked: 0, malformed: 0, byLane: [], groups: [], stuck: null,
      skips: [], skipsLast24h: 0,
    };
    expect(isFleetQueue(queue)).toBe(true);
    expect(isFleetQueue({ ...queue, stuck: { jobs: [{ id: 'RQ-X', age: 'unknown' }], eventsAvailable: false } })).toBe(true);
    expect(isFleetQueue({ ...queue, stuck: { jobs: [{ id: 'RQ-X', age: 'unknown' }] } })).toBe(false);
  });
});
