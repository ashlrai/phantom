/**
 * Knowledge-note trajectory outcomes — the knowledge-runs ledger
 * (record/read), injection-time correlation, and the gated fold that joins
 * served runs to trajectory terminal/realized outcomes. HOME is isolated by
 * test/setup/home.ts.
 */
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { knowledgeBlockFor } from '../src/core/learn/retro/inject.js';
import {
  MIN_KNOWLEDGE_OUTCOME_JOINS,
  readKnowledgeNoteOutcomes,
} from '../src/core/learn/retro/knowledge-outcomes.js';
import {
  knowledgeRunsPath,
  readKnowledgeRuns,
  recordKnowledgeRuns,
  updateKnowledge,
} from '../src/core/learn/retro/store.js';
import type { KnowledgeNoteV1 } from '../src/core/learn/retro/types.js';
import type {
  TrajectoryJoinQualityResult,
  TrajectoryRecord,
} from '../src/core/autonomy/trajectory-records.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const NOTE_ID = 'kn_0123456789abcdef';
const NOTE_ID_2 = 'kn_fedcba9876543210';

function note(id: string, over: Partial<KnowledgeNoteV1> = {}): KnowledgeNoteV1 {
  return {
    v: 1,
    id,
    text: 'Run the affected checks before requesting review.',
    scope: { repo: null, pathGlobs: [], taskKinds: [] },
    status: 'approved',
    retroId: null,
    source: 'fleet',
    createdAt: '2026-09-01T00:00:00.000Z',
    decidedAt: '2026-09-02T00:00:00.000Z',
    edited: false,
    hits: 0,
    lastHitAt: null,
    seen: 1,
    agentsMdTaskId: null,
    ...over,
  };
}

async function seedNote(n: KnowledgeNoteV1): Promise<void> {
  await updateKnowledge((notes) => ({ notes: [...notes, n], result: null }));
}

function trajectory(trajectoryId: string, terminalOutcome: string, realizedOutcome?: string): TrajectoryRecord {
  return {
    trajectoryId,
    terminalOutcome,
    ...(realizedOutcome ? { realizedOutcome } : {}),
  } as TrajectoryRecord;
}

function joinQuality(records: TrajectoryRecord[], degraded = false): TrajectoryJoinQualityResult {
  const source = { sourceState: degraded ? 'degraded' : 'healthy', sourcePresent: true, complete: !degraded };
  return {
    records,
    sourceQuality: {
      sourceState: degraded ? 'degraded' : 'healthy',
      sourcePresent: true,
      complete: !degraded,
      sources: { dispatch: source, outcomes: source, agentActions: source },
    },
    edges: {} as TrajectoryJoinQualityResult['edges'],
    agentActions: { trajectories: 0, reasonCounts: {} } as TrajectoryJoinQualityResult['agentActions'],
  } as TrajectoryJoinQualityResult;
}

beforeEach(() => {
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
});

describe('knowledge-runs ledger', () => {
  it('round-trips trajectory correlations per note and dedupes repeat injections', async () => {
    await recordKnowledgeRuns('run:att-1', [NOTE_ID, NOTE_ID_2, 'not-a-note'], '2026-10-01T00:00:00.000Z');
    await recordKnowledgeRuns('run:att-1', [NOTE_ID], '2026-10-01T00:01:00.000Z');
    await recordKnowledgeRuns('run:att-2', [NOTE_ID], '2026-10-01T00:02:00.000Z');
    const read = await readKnowledgeRuns();
    expect(read.state).toBe('read');
    expect(read.truncated).toBe(false);
    expect(read.byNote.get(NOTE_ID)).toEqual(new Set(['run:att-1', 'run:att-2']));
    expect(read.byNote.get(NOTE_ID_2)).toEqual(new Set(['run:att-1']));
    expect(read.byNote.has('not-a-note')).toBe(false);
  });

  it('drops malformed trajectory ids and note ids rather than recording them', async () => {
    await recordKnowledgeRuns('no-colon-prefix', [NOTE_ID]);
    await recordKnowledgeRuns('run:ok', ['kn_short', 'KN_UPPER_1234567890123456']);
    const read = await readKnowledgeRuns();
    expect(read.state).toBe('missing');
    expect(read.byNote.size).toBe(0);
  });

  it('reports missing and skips malformed lines on read', async () => {
    expect((await readKnowledgeRuns()).state).toBe('missing');
    mkdirSync(dirname(knowledgeRunsPath()), { recursive: true });
    writeFileSync(knowledgeRunsPath(), [
      JSON.stringify({ trajectoryId: 'run:a', ids: [NOTE_ID], at: '2026-10-01T00:00:00.000Z' }),
      '{torn',
      JSON.stringify({ trajectoryId: 'run:b', ids: 'oops' }),
      JSON.stringify({ trajectoryId: 'bad id', ids: [NOTE_ID] }),
      '',
    ].join('\n'));
    const read = await readKnowledgeRuns();
    expect(read.state).toBe('read');
    expect(read.byNote.get(NOTE_ID)).toEqual(new Set(['run:a']));
  });
});

describe('injection correlation', () => {
  it('knowledgeBlockFor records a run row only when a trajectoryId is supplied', async () => {
    await seedNote(note(NOTE_ID));
    const target = { repo: null, paths: [], kind: null, text: 'fix the flaky test' };
    knowledgeBlockFor(target, { trajectoryId: 'run:att-9' });
    await vi.waitFor(async () => {
      expect((await readKnowledgeRuns()).byNote.get(NOTE_ID)).toEqual(new Set(['run:att-9']));
    });
    // A hit without a trajectory keeps counting hits but writes no run row.
    rmSync(join(homedir(), '.ashlr', 'learn', 'knowledge-runs.jsonl'), { force: true });
    knowledgeBlockFor(target, {});
    await new Promise((r) => setTimeout(r, 20));
    expect((await readKnowledgeRuns()).state).toBe('missing');
    // recordHits:false previews record neither.
    knowledgeBlockFor(target, { trajectoryId: 'run:att-10', recordHits: false });
    await new Promise((r) => setTimeout(r, 20));
    expect((await readKnowledgeRuns()).state).toBe('missing');
  });
});

describe('readKnowledgeNoteOutcomes', () => {
  const runsRead = (byNote: Map<string, Set<string>>, over: Record<string, unknown> = {}) => async () => ({
    state: 'read' as const, byNote, truncated: false, ...over,
  });

  it('joins served trajectories to terminal and realized outcomes', async () => {
    const byNote = new Map([[NOTE_ID, new Set(['run:a', 'run:b', 'run:c', 'run:outside-window'])]]);
    const records = [
      trajectory('run:a', 'merged', 'followed-up'),
      trajectory('run:b', 'merged', 'reverted'),
      trajectory('run:c', 'failed'),
    ];
    const out = await readKnowledgeNoteOutcomes({
      deps: { readRuns: runsRead(byNote), listJoinQuality: () => joinQuality(records) },
    });
    expect(out).not.toBeNull();
    const row = out!.get(NOTE_ID)!;
    expect(row).toEqual({
      runs: 4,
      joined: 3,
      outcomes: { merged: 2, failed: 1 },
      realized: { 'followed-up': 1, reverted: 1 },
    });
  });

  it('withholds outcome tallies below the join floor but keeps exact run counts', async () => {
    const byNote = new Map([[NOTE_ID, new Set(['run:a', 'run:b'])]]);
    const records = [trajectory('run:a', 'merged'), trajectory('run:b', 'merged')];
    const out = await readKnowledgeNoteOutcomes({
      deps: { readRuns: runsRead(byNote), listJoinQuality: () => joinQuality(records) },
    });
    const row = out!.get(NOTE_ID)!;
    expect(row.runs).toBe(2);
    expect(row.joined).toBe(2);
    expect(row.outcomes).toBeUndefined();
    expect(row.realized).toBeUndefined();
    expect(MIN_KNOWLEDGE_OUTCOME_JOINS).toBe(3);
  });

  it('returns null when trajectory sources are degraded or incomplete', async () => {
    const byNote = new Map([[NOTE_ID, new Set(['run:a', 'run:b', 'run:c'])]]);
    const records = [trajectory('run:a', 'merged'), trajectory('run:b', 'merged'), trajectory('run:c', 'merged')];
    for (const degraded of [true]) {
      const out = await readKnowledgeNoteOutcomes({
        deps: { readRuns: runsRead(byNote), listJoinQuality: () => joinQuality(records, degraded) },
      });
      expect(out).toBeNull();
    }
    const incomplete = joinQuality(records);
    (incomplete.sourceQuality.sources.outcomes as { complete: boolean }).complete = false;
    const out = await readKnowledgeNoteOutcomes({
      deps: { readRuns: runsRead(byNote), listJoinQuality: () => incomplete },
    });
    expect(out).toBeNull();
  });

  it('returns null on a degraded or truncated runs log', async () => {
    const records = [trajectory('run:a', 'merged'), trajectory('run:b', 'merged'), trajectory('run:c', 'merged')];
    const listJoinQuality = () => joinQuality(records);
    expect(await readKnowledgeNoteOutcomes({
      deps: { readRuns: runsRead(new Map(), { state: 'degraded' }), listJoinQuality },
    })).toBeNull();
    expect(await readKnowledgeNoteOutcomes({
      deps: { readRuns: runsRead(new Map([[NOTE_ID, new Set(['run:a'])]]), { truncated: true }), listJoinQuality },
    })).toBeNull();
  });

  it('never resolves a trajectory id claimed by conflicting records', async () => {
    const byNote = new Map([[NOTE_ID, new Set(['run:a', 'run:b', 'run:c', 'run:d'])]]);
    const records = [
      trajectory('run:a', 'merged'), trajectory('run:b', 'merged'), trajectory('run:c', 'merged'),
      trajectory('run:d', 'merged'), trajectory('run:d', 'reverted'),
    ];
    const out = await readKnowledgeNoteOutcomes({
      deps: { readRuns: runsRead(byNote), listJoinQuality: () => joinQuality(records) },
    });
    const row = out!.get(NOTE_ID)!;
    expect(row.runs).toBe(4);
    expect(row.joined).toBe(3);
    expect(row.outcomes).toEqual({ merged: 3 });
  });

  it('returns an empty map when no correlated injections exist', async () => {
    const out = await readKnowledgeNoteOutcomes({
      deps: {
        readRuns: async () => ({ state: 'missing' as const, byNote: new Map(), truncated: false }),
        listJoinQuality: () => joinQuality([]),
      },
    });
    expect(out).not.toBeNull();
    expect(out!.size).toBe(0);
  });
});
