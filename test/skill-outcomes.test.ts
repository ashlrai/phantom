import { describe, expect, it, vi } from 'vitest';
import { readSkillTrajectoryOutcomes } from '../src/core/fleet/skill-outcomes.js';
import type { SkillUseEventReadResult } from '../src/core/fleet/skill-records.js';
import type { SkillUseEvent } from '../src/core/types.js';
import type {
  TrajectoryLearningStatus,
  TrajectoryRecord,
  TrajectoryRecordListOptions,
  TrajectorySkillOutcomeSummary,
} from '../src/core/autonomy/trajectory-records.js';

const skillRead = (over: Partial<SkillUseEventReadResult> = {}): SkillUseEventReadResult => ({
  events: [],
  sourceState: 'healthy',
  sourcePresent: true,
  eventState: 'present',
  ...over,
});

const summary: TrajectorySkillOutcomeSummary = {
  skills: 1,
  selections: 3,
  perSkill: [{
    skillId: 'skill.proposal.p-1',
    skillRevision: 2,
    selections: 3,
    outcomes: { merged: 2, failed: 1 },
    realized: { reverted: 1 },
  }],
};

const learningStatus = (skillOutcomes?: TrajectorySkillOutcomeSummary): TrajectoryLearningStatus =>
  ({ skillOutcomes }) as unknown as TrajectoryLearningStatus;

describe('readSkillTrajectoryOutcomes', () => {
  it('returns the published per-skill summary when the ledger is healthy', () => {
    const events: SkillUseEvent[] = [{
      schemaVersion: 1, eventId: 'e1', ts: '2026-01-01T00:00:00.000Z',
      skillId: 'skill.proposal.p-1', skillRevision: 2, mode: 'shadow', stage: 'selected',
    }];
    const listRecords = vi.fn((_opts?: TrajectoryRecordListOptions) => [] as TrajectoryRecord[]);
    const summarize = vi.fn(() => learningStatus(summary));
    const readEvents = vi.fn(() => skillRead({ events }));
    const out = readSkillTrajectoryOutcomes({}, { readSkillUseEvents: readEvents, listRecords, summarize });
    expect(out).toEqual(summary);
    expect(readEvents).toHaveBeenCalledWith(expect.objectContaining({ maxFiles: 3 }));
    const readOpts = readEvents.mock.calls[0]![0]!;
    expect(readOpts.limit).toBe(1600);
    expect(readOpts.sinceMs).toBeGreaterThan(Date.now() - 25 * 60 * 60 * 1000);
    expect(listRecords).toHaveBeenCalledWith(expect.objectContaining({ windowHours: 24, limit: 200 }));
    // The join sees the same skill-use snapshot the health gate checked.
    const joinDeps = listRecords.mock.calls[0]![0]!.deps!;
    expect(joinDeps.readSkillUseEvents!({})).toEqual(events);
    expect(summarize).toHaveBeenCalledWith([], 24);
  });

  it('withholds everything when the skill-use ledger is degraded', () => {
    const listRecords = vi.fn(() => [] as TrajectoryRecord[]);
    const summarize = vi.fn(() => learningStatus(summary));
    const out = readSkillTrajectoryOutcomes({}, {
      readSkillUseEvents: () => skillRead({ eventState: 'degraded', sourceState: 'degraded' }),
      listRecords,
      summarize,
    });
    expect(out).toBeNull();
    expect(listRecords).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
  });

  it('returns null when the trajectory sample gate publishes nothing', () => {
    const out = readSkillTrajectoryOutcomes({}, {
      readSkillUseEvents: () => skillRead({ eventState: 'none', sourcePresent: false, sourceState: 'missing' }),
      listRecords: () => [] as TrajectoryRecord[],
      summarize: () => learningStatus(undefined),
    });
    expect(out).toBeNull();
  });

  it('never throws: reader and join failures report null', () => {
    expect(readSkillTrajectoryOutcomes({}, {
      readSkillUseEvents: () => { throw new Error('boom'); },
    })).toBeNull();
    expect(readSkillTrajectoryOutcomes({}, {
      readSkillUseEvents: () => skillRead(),
      listRecords: () => { throw new Error('boom'); },
    })).toBeNull();
    expect(readSkillTrajectoryOutcomes({}, {
      readSkillUseEvents: () => skillRead(),
      listRecords: () => [] as TrajectoryRecord[],
      summarize: () => { throw new Error('boom'); },
    })).toBeNull();
  });

  it('includes all daily partitions intersecting the discovery window', () => {
    const readEvents = vi.fn(() => skillRead());
    const listRecords = vi.fn(() => [] as TrajectoryRecord[]);
    readSkillTrajectoryOutcomes({ windowHours: 168, limit: 500 }, {
      readSkillUseEvents: readEvents,
      listRecords,
      summarize: () => learningStatus(undefined),
    });
    expect(readEvents).toHaveBeenCalledWith({
      sinceMs: expect.any(Number),
      maxFiles: 8,
      limit: 4000,
    });
    expect(listRecords).toHaveBeenCalledWith(expect.objectContaining({ windowHours: 168, limit: 500 }));
  });

  it('honours caller window and limit', () => {
    const listRecords = vi.fn((_opts?: TrajectoryRecordListOptions) => [] as TrajectoryRecord[]);
    readSkillTrajectoryOutcomes({ windowHours: 6, limit: 50 }, {
      readSkillUseEvents: () => skillRead(),
      listRecords,
      summarize: () => learningStatus(undefined),
    });
    expect(listRecords).toHaveBeenCalledWith(expect.objectContaining({ windowHours: 6, limit: 50 }));
  });
});
