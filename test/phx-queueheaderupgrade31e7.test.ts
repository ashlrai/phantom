import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';

const now = Date.UTC(2026, 9, 31, 12);
const positional = [
  'READY\tFAKE-READY-1\tFake-Lane\twork\tfake-repo\tfake title',
  'PARKED-MERGERATE.Fake-Lane\tFAKE-PARKED-1\tother-lane\twork\tfake-repo\tfake title',
  'PARKED-MERGERATE.Fake-Lane\tFAKE-PARKED-2\tother-lane\twork\tfake-repo\tfake title',
  'READY\tFAKE-READY-2\tother-lane\twork\tfake-repo\tfake title',
  'PARKED-INVALID.other-lane\tFAKE-PARKED-3\tother-lane\twork\tfake-repo\tfake title',
  'CLAIMED\tFAKE-UNKNOWN\tother-lane\twork\tfake-repo\tfake title',
];
const header = 'id\tstatus\tpool\ttier\trepo\ttitle';
const headered = positional.map((line) => {
  const cells = line.split('\t');
  return [cells[1], cells[0], ...cells.slice(2)].join('\t');
});
const expected = {
  sources: { ready: 'degraded', skips: 'healthy' },
  total: 5, ready: 2, parked: 3, malformed: 1,
  byLane: [
    { lane: 'Fake-Lane', ready: 1, parked: 2 },
    { lane: 'other-lane', ready: 1, parked: 1 },
  ],
  groups: [
    { reason: 'MERGERATE', lane: 'Fake-Lane', count: 2, jobs: ['FAKE-PARKED-1', 'FAKE-PARKED-2'] },
    { reason: 'INVALID', lane: 'other-lane', count: 1, jobs: ['FAKE-PARKED-3'] },
  ],
  skips: [{ at: 'fake time', job: 'FAKE-SKIP', code: 'FAKE', reason: 'fake reason' }],
};

describe('fleet queue header upgrade', () => {
  it('preserves the same projection for positional, headered, and mixed rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fake-queue-upgrade-'));
    try {
      await mkdir(join(root, 'queue'));
      await writeFile(join(root, 'queue/precheck-skips.tsv'), 'fake time\tFAKE-SKIP\tFAKE\tfake reason\n');
      for (const rows of [
        positional,
        [header, ...headered],
        [positional[0]!, header, headered[1]!, positional[2]!, headered[3]!, positional[4]!, headered[5]!],
      ]) {
        await writeFile(join(root, 'queue/ready.tsv'), `${rows.join('\n')}\n`);
        expect(await readFleetQueue({ runsDir: root, now: () => now })).toMatchObject(expected);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves each parked lane suffix when only its casing differs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fake-queue-case-'));
    try {
      await mkdir(join(root, 'queue'));
      await writeFile(join(root, 'queue/ready.tsv'), [
        header,
        'FAKE-ONE\tPARKED-BYHAND.Fake-Lane\tother-lane\twork\tfake-repo\tfake',
        'FAKE-TWO\tPARKED-BYHAND.fake-lane\tother-lane\twork\tfake-repo\tfake',
      ].join('\n'));
      const queue = await readFleetQueue({ runsDir: root, now: () => now });
      expect(queue).toMatchObject({ total: 2, parked: 2, malformed: 0, sources: { ready: 'healthy' } });
      expect(queue.groups).toEqual([
        { reason: 'BYHAND', lane: 'fake-lane', count: 1, jobs: ['FAKE-TWO'] },
        { reason: 'BYHAND', lane: 'Fake-Lane', count: 1, jobs: ['FAKE-ONE'] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps each source usable when the other source fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fake-queue-sources-'));
    try {
      await mkdir(join(root, 'queue'));
      await writeFile(join(root, 'queue/ready.tsv'), [header, ...headered.slice(0, 5)].join('\n'));
      await mkdir(join(root, 'queue/precheck-skips.tsv'));
      const queue = await readFleetQueue({ runsDir: root, now: () => now });
      expect(queue).toMatchObject({ sources: { ready: 'healthy', skips: 'degraded' }, total: 5, ready: 2, parked: 3, malformed: 0, skipsLast24h: null });
      expect(queue.groups).toEqual(expected.groups);

      await rm(join(root, 'queue/precheck-skips.tsv'), { recursive: true });
      await writeFile(join(root, 'queue/precheck-skips.tsv'), 'fake time\tFAKE-SKIP\tFAKE\tfake reason\n');
      await rm(join(root, 'queue/ready.tsv'));
      await mkdir(join(root, 'queue/ready.tsv'));
      const skips = await readFleetQueue({ runsDir: root, now: () => now });
      expect(skips).toMatchObject({ sources: { ready: 'degraded', skips: 'healthy' }, total: 0, malformed: 0, skips: expected.skips });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
