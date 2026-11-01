import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';

it('counts only ready repo mix per lane and omits unsafe public repo names', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'queue-repo-mix-'));
  try {
    await mkdir(join(runsDir, 'queue'));
    await writeFile(join(runsDir, 'queue', 'ready.tsv'), [
      'id\tlane\trepo\tstatus',
      'RQ-PHX-1\tcodex-personal\tphantom\tREADY',
      'RQ-PHX-2\tcodex-personal\tother\tREADY',
      'RQ-OTHER-1\tcodex-personal\tverse\tREADY',
      'RQ-PHX-3\tdevin\tphantom\tREADY',
      'RQ-PHX-4\tcodex-personal\tparked-repo\tPARKED-BYHAND',
      'RQ-UNSAFE-1\tunsafe\tfake/path\tREADY',
      'RQ-UNSAFE-2\tunsafe\tfake\\path\tREADY',
      'RQ-UNSAFE-3\tunsafe\tfake\x01repo\tREADY',
      ...['z', 'a', 'b', 'c', 'd', 'e', 'a'].map((repo, i) => `RQ-BOUND-${i}\tbounded\t${repo}\tREADY`),
    ].join('\n'));
    const queue = await readFleetQueue({ runsDir });
    expect(queue.byLane).toEqual([
      { lane: 'bounded', ready: 7, parked: 0, phantom: 0, other: 7, otherRepos: ['a', 'b', 'c', 'd', 'e'] },
      { lane: 'codex-personal', ready: 3, parked: 1, phantom: 2, other: 1, otherRepos: ['verse'] },
      { lane: 'devin', ready: 1, parked: 0, phantom: 1, other: 0, otherRepos: [] },
      { lane: 'unsafe', ready: 3, parked: 0, phantom: 0, other: 3, otherRepos: [] },
    ]);
  } finally { await rm(runsDir, { recursive: true, force: true }); }
});
