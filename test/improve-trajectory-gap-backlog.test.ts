import { describe, expect, it, vi } from 'vitest';
import {
  TRAJECTORY_GAP_DEGRADED_MIN,
  TRAJECTORY_GAP_KIND_MIN,
  TRAJECTORY_GAP_SKILL_MIN_EVENTS,
  TRAJECTORY_GAP_WINDOW_HOURS,
  trajectoryGapBacklogItems,
} from '../src/core/improve/trajectory-gap-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import type { TrajectoryLearningStatus } from '../src/core/autonomy/trajectory-records.js';

vi.mock('../src/core/improve/trajectory-gap-backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/improve/trajectory-gap-backlog.js')>();
  return { ...actual, trajectoryGapBacklogItems: vi.fn(actual.trajectoryGapBacklogItems) };
});

const feedMock = vi.mocked(trajectoryGapBacklogItems);

const REPO = 'ashlrai/phantom';

function summary(overrides: Partial<TrajectoryLearningStatus> = {}): TrajectoryLearningStatus {
  return {
    version: 1,
    windowHours: TRAJECTORY_GAP_WINDOW_HOURS,
    trajectories: 120,
    population: { observed: 120, learningEligible: 100, incomplete: 10, degraded: 0 },
    coverage: {},
    routeSpine: {},
    skillObservation: { eventState: 'none', sampleState: 'none' },
    traces: { state: 'unavailable', records: [] },
    gaps: [],
    ...overrides,
  };
}

describe('trajectoryGapBacklogItems', () => {
  it('emits a degraded-population item at the recurring bar', async () => {
    const items = await trajectoryGapBacklogItems({
      repo: REPO,
      summary: summary({
        population: { observed: 120, learningEligible: 100, incomplete: 10, degraded: TRAJECTORY_GAP_DEGRADED_MIN },
      }),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^trajectory-gap-[0-9a-f]{16}$/);
    expect(items[0]!.title).toContain(String(TRAJECTORY_GAP_DEGRADED_MIN));
    expect(items[0]!.area).toBe('trajectory-evidence');
    expect(items[0]!.priority).toBe(3);
    expect(items[0]!.repo).toBe(REPO);
    expect(items[0]!.prompt).toContain('decision-source');
  });

  it('stays quiet below the degraded bar and on a null projection', async () => {
    expect(await trajectoryGapBacklogItems({
      repo: REPO,
      summary: summary({
        population: { observed: 120, learningEligible: 100, incomplete: 10, degraded: TRAJECTORY_GAP_DEGRADED_MIN - 1 },
      }),
    })).toEqual([]);
    expect(await trajectoryGapBacklogItems({ repo: REPO, summary: null })).toEqual([]);
  });

  it('emits one item per majority-missing evidence join on eligible trajectories', async () => {
    const items = await trajectoryGapBacklogItems({
      repo: REPO,
      summary: summary({
        gaps: [
          { kind: 'agentAction', count: TRAJECTORY_GAP_KIND_MIN, sampleRefs: [] },
          { kind: 'evidence', count: 60, sampleRefs: [] },
          // Below the absolute bar: quiet.
          { kind: 'decision', count: TRAJECTORY_GAP_KIND_MIN - 1, sampleRefs: [] },
        ],
      }),
    });
    // agentAction: 8 < 50% of 100 -> quiet; evidence: 60 >= 50 -> emits.
    expect(items.map((i) => i.title)).toHaveLength(1);
    expect(items[0]!.title).toContain('evidence');
    expect(items[0]!.title).toContain('60');
    expect(items[0]!.title).toContain('100');
    expect(items[0]!.prompt).toContain('autonomy-evidence ledger');
  });

  it('requires the majority-rate signature, not just an absolute count', async () => {
    const items = await trajectoryGapBacklogItems({
      repo: REPO,
      summary: summary({
        population: { observed: 400, learningEligible: 300, incomplete: 60, degraded: 0 },
        gaps: [{ kind: 'agentAction', count: TRAJECTORY_GAP_KIND_MIN + 20, sampleRefs: [] }],
      }),
    });
    // 28 of 300 eligible is recurring but not a majority-missing join.
    expect(items).toEqual([]);
  });

  it('emits the skill-join cell when failed events dominate joins', async () => {
    const items = await trajectoryGapBacklogItems({
      repo: REPO,
      summary: summary({
        skillObservation: {
          eventState: 'present',
          sampleState: 'observed',
          joined: 10,
          unjoined: TRAJECTORY_GAP_SKILL_MIN_EVENTS - 2,
          conflicting: 4,
        },
      }),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('Skill-use telemetry');
    expect(items[0]!.prompt).toContain('trajectoryId/runId/proposalId');
    expect(items[0]!.prompt).toContain('bounded-cohort');
  });

  it('stays quiet when skill events mostly join or none were recorded', async () => {
    expect(await trajectoryGapBacklogItems({
      repo: REPO,
      summary: summary({
        skillObservation: {
          eventState: 'present',
          sampleState: 'observed',
          joined: 100,
          unjoined: TRAJECTORY_GAP_SKILL_MIN_EVENTS,
          conflicting: 0,
        },
      }),
    })).toEqual([]);
    expect(await trajectoryGapBacklogItems({
      repo: REPO,
      summary: summary({
        skillObservation: {
          eventState: 'present',
          sampleState: 'insufficient-sample',
          joined: 0,
          unjoined: TRAJECTORY_GAP_SKILL_MIN_EVENTS - 1,
          conflicting: 0,
        },
      }),
    })).toEqual([]);
    expect(await trajectoryGapBacklogItems({
      repo: REPO,
      summary: summary({
        skillObservation: { eventState: 'none', sampleState: 'none' },
      }),
    })).toEqual([]);
  });

  it('emits only for the fleet repository and honors the item cap', async () => {
    const populated = summary({
      population: { observed: 120, learningEligible: 100, incomplete: 10, degraded: TRAJECTORY_GAP_DEGRADED_MIN },
      gaps: [
        { kind: 'agentAction', count: 90, sampleRefs: [] },
        { kind: 'evidence', count: 80, sampleRefs: [] },
        { kind: 'decision', count: 70, sampleRefs: [] },
      ],
      skillObservation: {
        eventState: 'present',
        sampleState: 'observed',
        joined: 5,
        unjoined: TRAJECTORY_GAP_SKILL_MIN_EVENTS,
        conflicting: 0,
      },
    });
    expect(await trajectoryGapBacklogItems({ repo: 'someone/else', summary: populated })).toEqual([]);
    const items = await trajectoryGapBacklogItems({ repo: REPO, summary: populated });
    // degraded + 3 gaps + skill-join = 5 cells, all under the default cap.
    expect(items).toHaveLength(5);
    expect(new Set(items.map((i) => i.id)).size).toBe(5);
    const capped = await trajectoryGapBacklogItems({ repo: REPO, summary: populated, limit: 2 });
    expect(capped).toHaveLength(2);
    // Degraded ranks first; skill-join last.
    expect(capped[0]!.title).toContain('degraded-evidence');
    expect(capped[1]!.title).toContain('agentAction');
  });

  it('keeps ids stable across refreshes with shifted counts', async () => {
    const base = summary({
      gaps: [{ kind: 'evidence', count: 60, sampleRefs: [] }],
    });
    const first = await trajectoryGapBacklogItems({ repo: REPO, summary: base });
    const shifted = await trajectoryGapBacklogItems({
      repo: REPO,
      summary: summary({ gaps: [{ kind: 'evidence', count: 61, sampleRefs: [] }] }),
    });
    expect(first[0]!.id).toBe(shifted[0]!.id);
  });
});

describe('discoverBacklog wiring', () => {
  const greenGh = async (args: string[]) => {
    const path = args[4] ?? '';
    if (path === 'repos/ashlrai/phantom') {
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
    }
    return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
  };

  it('runs the feed during discovery with the fleet repo', async () => {
    feedMock.mockClear();
    await discoverBacklog(REPO, { gh: greenGh });
    expect(feedMock).toHaveBeenCalledWith({ repo: REPO });
  });
});
