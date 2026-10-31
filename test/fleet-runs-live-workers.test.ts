/**
 * fleet/runs-live-workers — the desktop console's live process snapshot.
 *
 * Pure and hermetic: `runPs` is injected, no process is ever spawned, and
 * every value below is fake (`RQ-FAKE-*`, repo `phantom`).
 */
import { describe, expect, it } from 'vitest';

import {
  listLiveWorkers,
  parseEtime,
  parsePsTable,
  type LiveWorkersSnapshot,
} from '../src/core/fleet/runs-live-workers.js';

describe('parseEtime', () => {
  it('parses mm:ss', () => {
    expect(parseEtime('05:12')).toBe(312);
    expect(parseEtime('00:07')).toBe(7);
  });

  it('parses hh:mm:ss', () => {
    expect(parseEtime('02:03:04')).toBe(7384);
  });

  it('parses dd-hh:mm:ss', () => {
    expect(parseEtime('1-02:03:04')).toBe(93784);
  });

  it('returns null for garbage', () => {
    for (const bad of ['', 'abc', '-', '1-2-3', '12:34:56:78', '05:99', '1:99:00', '5 :12', '  ']) {
      expect(parseEtime(bad)).toBeNull();
    }
  });
});

const PS_TABLE = [
  '   412     02:11:33 /bin/bash /Users/masonwyatt/.ashlr-runs/bin/launch.sh RQ-FAKE-7 phantom main work',
  '   413        44:12 /bin/bash /Users/masonwyatt/.ashlr-runs/bin/launch.sh RQ-FAKE-7 phantom main work',
  '   501  1-02:03:04 codex exec --cd /Users/masonwyatt/Projects/ashlrai/wt/RQ-FAKE-7 --json',
  '   640        09:10 /bin/bash /Users/masonwyatt/.ashlr-runs/bin/launch.sh RQ-FAKE-8 phantom bugfix fast',
  '   700        05:12 /bin/bash /Users/masonwyatt/.ashlr-runs/bin/orch-pass.sh --repo /Users/masonwyatt/Projects/ashlrai nightly',
  '   701        00:03 grep orch-pass',
  '   702        33:44 claude -p "summarize the leader memo" --output-format json',
  '   703        12:00 /bin/bash /Users/masonwyatt/.ashlr-runs/bin/opus-leader-loop.sh --once',
  '   705        20:00 codex exec --sandbox read-only',
  '   710        01:01 /bin/bash /Users/masonwyatt/.ashlr-runs/bin/launch.sh RQ-FAKE-9 phantom main turbo',
  '  this line is not a ps row',
  '',
].join('\n');

describe('parsePsTable', () => {
  it('builds the exact snapshot for a realistic table', () => {
    expect(parsePsTable(PS_TABLE)).toEqual({
      workers: [
        { pid: 412, job: 'RQ-FAKE-7', repo: 'phantom', lane: 'main', tier: 'work', ageSeconds: 7893 },
        { pid: 640, job: 'RQ-FAKE-8', repo: 'phantom', lane: 'bugfix', tier: 'fast', ageSeconds: 550 },
      ],
      leaders: [{ pid: 700, label: '--repo nightly', ageSeconds: 312 }],
      orchestratorAgents: 3,
    });
  });

  it('drops workers whose tokens fail validation', () => {
    const table = [
      '  11 00:01 /x/bin/launch.sh RQ-FAKE-7 phantom main work',
      '  12 00:01 /x/bin/launch.sh RQ-FAKE-8 Phantom main work',
      '  13 00:01 /x/bin/launch.sh RQ-FAKE-9 phantom main_lane work',
      '  14 00:01 /x/bin/launch.sh "RQ-FAKE-10" phantom main work',
      '  15 00:01 /x/bin/launch.sh RQ-FAKE-11 phantom main frontier',
    ].join('\n');
    expect(parsePsTable(table).workers).toEqual([
      { pid: 11, job: 'RQ-FAKE-7', repo: 'phantom', lane: 'main', tier: 'work', ageSeconds: 1 },
      { pid: 15, job: 'RQ-FAKE-11', repo: 'phantom', lane: 'main', tier: 'frontier', ageSeconds: 1 },
    ]);
  });

  it('removes path-like tokens from a leader label', () => {
    const table = [
      '  77 00:59 /u/bin/orch-pass.sh --plan ~/notes/todo.md --wt=/Users/masonwyatt/Projects/ashlrai/wt/RQ-X sweep',
    ].join('\n');
    expect(parsePsTable(table).leaders).toEqual([
      { pid: 77, label: '--plan sweep', ageSeconds: 59 },
    ]);
  });

  it('attributes agent children carrying a worker job id to that worker', () => {
    const table = [
      '  20 00:10 /x/bin/launch.sh RQ-FAKE-7 phantom main work',
      '  21 00:09 claude -p --cwd /Users/masonwyatt/Projects/ashlrai/wt/RQ-FAKE-7',
      '  22 00:08 claude -p "write tests"',
      '  23 00:07 codex exec --cd /wt/RRQ-FAKE-7-lookalike',
    ].join('\n');
    const out = parsePsTable(table);
    // pid 21 is attributed to RQ-FAKE-7; pid 23's "RRQ-FAKE-7-lookalike" is
    // not the same job, so it counts alongside pid 22.
    expect(out.orchestratorAgents).toBe(2);
  });
});

describe('listLiveWorkers', () => {
  it('reports healthy with the injected table and clock', async () => {
    const at = Date.parse('2026-10-31T04:05:06.789Z');
    const snap = await listLiveWorkers({ runPs: async () => PS_TABLE, now: () => at });
    const expected: LiveWorkersSnapshot = {
      v: 1,
      generatedAt: '2026-10-31T04:05:06.789Z',
      sourceState: 'healthy',
      workers: [
        { pid: 412, job: 'RQ-FAKE-7', repo: 'phantom', lane: 'main', tier: 'work', ageSeconds: 7893 },
        { pid: 640, job: 'RQ-FAKE-8', repo: 'phantom', lane: 'bugfix', tier: 'fast', ageSeconds: 550 },
      ],
      leaders: [{ pid: 700, label: '--repo nightly', ageSeconds: 312 }],
      orchestratorAgents: 3,
    };
    expect(snap).toEqual(expected);
  });

  it('degrades to unavailable when the runner rejects', async () => {
    const at = Date.parse('2026-10-31T04:05:06.789Z');
    const snap = await listLiveWorkers({ runPs: async () => { throw new Error('ps failed'); }, now: () => at });
    expect(snap).toEqual({
      v: 1,
      generatedAt: '2026-10-31T04:05:06.789Z',
      sourceState: 'unavailable',
      workers: [],
      leaders: [],
      orchestratorAgents: 0,
    });
  });
});
