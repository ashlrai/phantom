import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';

let dir = '';
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
describe('job detail lane evidence', () => {
  it('joins a ready row to the latest launch for the exact job', async () => {
    dir = await mkdtemp(join(tmpdir(), 'job-lane-'));
    await mkdir(join(dir, 'queue'));
    await writeFile(join(dir, 'queue/ready.tsv'), 'RQ-TEST-LANE-1\tphantom\tcodex-personal\twork\tprompt\n');
    await writeFile(join(dir, 'dispatch-events.log'), [
      '2026-11-10 10:00:00 LAUNCH RQ-TEST-LANE-1 phantom codex-cmp work',
      '2026-11-10 10:01:00 LAUNCH RQ-TEST-LANE-10 phantom devin work reason=other',
      '2026-11-10 10:02:00 LAUNCH RQ-TEST-LANE-1 phantom claude work reason=capacity',
    ].join('\n'));
    const detail = await getFleetJobDetail('RQ-TEST-LANE-1', { runsDir: dir });
    expect(detail).toMatchObject({ requestedLane: 'codex-personal', launchedLane: 'claude', laneReason: 'capacity' });
  });
  it('keeps missing evidence unknown and reads claimed lanes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'job-lane-'));
    await mkdir(join(dir, 'queue'));
    await writeFile(join(dir, 'queue/claimed.tsv'), 'RQ-TEST-LANE-1\tdevin\twork\t10:00\t1794304800\n');
    expect(await getFleetJobDetail('RQ-TEST-LANE-1', { runsDir: dir })).toMatchObject({ requestedLane: 'devin', launchedLane: null, laneReason: null });
  });
});
