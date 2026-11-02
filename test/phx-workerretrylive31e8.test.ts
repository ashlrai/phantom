import { describe, expect, it } from 'vitest';

import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';

const at = Date.parse('2026-10-31T03:45:00.000Z');
const wrapperA = ' 100 00:20 /bin/bash /fake/home/.ashlr-runs/bin/launch.sh RQ-FAKE-A fake-repo main work';
const wrapperB = ' 200 00:12 /bin/bash /fake/home/.ashlr-runs/bin/launch.sh RQ-FAKE-B fake-repo bugfix fast';
const childA = ' 101 00:19 codex exec --cd /fake/projects/wt/RQ-FAKE-A --json "FAKE_PRIVATE_PROMPT_A"';
const childB = ' 201 00:11 codex exec --cd /fake/projects/wt/RQ-FAKE-B --json "FAKE_PRIVATE_PROMPT_B"';
const leader = ' 300 00:08 /bin/bash /fake/home/.ashlr-runs/bin/orch-pass.sh --repo /fake/projects/fake-repo nightly';
const leaderChild = ' 301 00:07 codex exec --cd /fake/projects/fake-repo --json "FAKE_PRIVATE_LEADER_PROMPT"';

describe('live worker polling with launch wrappers and agent children', () => {
  it('counts each job once as children appear and a completed job disappears', async () => {
    const tables = [
      [wrapperA, wrapperB, leader, leaderChild],
      [childB, wrapperA, leaderChild, childA, leader, wrapperB],
      [childA, leader, wrapperA, leaderChild],
    ];
    let poll = 0;
    const runPs = async (): Promise<string> => tables[poll++]!.join('\n');
    const snapshots = [];
    for (let index = 0; index < tables.length; index++) {
      snapshots.push(await listLiveWorkers({ runPs, now: () => at + index * 1000 }));
    }

    expect(poll).toBe(3);
    expect(snapshots.map((snapshot) => snapshot.workers)).toEqual([
      [
        { pid: 100, job: 'RQ-FAKE-A', repo: 'fake-repo', lane: 'main', tier: 'work', ageSeconds: 20 },
        { pid: 200, job: 'RQ-FAKE-B', repo: 'fake-repo', lane: 'bugfix', tier: 'fast', ageSeconds: 12 },
      ],
      [
        { pid: 100, job: 'RQ-FAKE-A', repo: 'fake-repo', lane: 'main', tier: 'work', ageSeconds: 20 },
        { pid: 200, job: 'RQ-FAKE-B', repo: 'fake-repo', lane: 'bugfix', tier: 'fast', ageSeconds: 12 },
      ],
      [{ pid: 100, job: 'RQ-FAKE-A', repo: 'fake-repo', lane: 'main', tier: 'work', ageSeconds: 20 }],
    ]);
    for (const snapshot of snapshots) {
      expect(snapshot.sourceState).toBe('healthy');
      expect(snapshot.leaders).toEqual([{ pid: 300, label: '--repo nightly', ageSeconds: 8 }]);
      expect(snapshot.orchestratorAgents).toBe(1);
      expect(JSON.stringify(snapshot)).not.toMatch(/FAKE_PRIVATE|\/fake\/projects|codex exec/);
    }
  });

  it('matches job IDs literally and keeps a lookalike agent separate', async () => {
    const snapshot = await listLiveWorkers({
      now: () => at,
      runPs: async () => [
        ' 400 00:10 /bin/bash /fake/bin/launch.sh RQ-FAKE.1 fake-repo main work',
        ' 401 00:09 codex exec --cd /fake/wt/RQ-FAKE.1 --json "FAKE_PRIVATE_PROMPT"',
        ' 402 00:08 codex exec --cd /fake/wt/RQ-FAKEX1 --json "FAKE_PRIVATE_OTHER"',
      ].join('\n'),
    });
    expect(snapshot.workers.map((worker) => worker.job)).toEqual(['RQ-FAKE.1']);
    expect(snapshot.orchestratorAgents).toBe(1);
    expect(JSON.stringify(snapshot)).not.toMatch(/FAKE_PRIVATE|\/fake\/wt/);
  });
});
