import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LESSON_TRIAL_MAX_ITEMS,
  lessonTrialBacklogItems,
} from '../src/core/improve/lesson-trial-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  appendUserBacklogItems,
  readUserBacklogItems,
  validBacklogItem,
} from '../src/core/cloud/backlog.js';
import type { LessonEffect, LessonTrialReport } from '../src/core/improve/lesson-trial.js';
import type { KnowledgeNoteV1 } from '../src/core/learn/retro/types.js';

vi.mock('../src/core/improve/lesson-trial-backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/improve/lesson-trial-backlog.js')>();
  return { ...actual, lessonTrialBacklogItems: vi.fn(actual.lessonTrialBacklogItems) };
});

const realFeed = (await vi.importActual<typeof import('../src/core/improve/lesson-trial-backlog.js')>(
  '../src/core/improve/lesson-trial-backlog.js',
)).lessonTrialBacklogItems;
const feedMock = vi.mocked(lessonTrialBacklogItems);

const REPO = 'ashlrai/phantom';

function effect(overrides: Partial<LessonEffect> = {}): LessonEffect {
  return {
    scope: 'all',
    served: { tasks: 8, landed: 4, rate: 0.5 },
    holdout: { tasks: 3, landed: 3, rate: 1 },
    delta: -0.5,
    ci95: [-0.9, -0.1],
    verdict: 'hurts',
    ...overrides,
  };
}

function report(overrides: Partial<LessonTrialReport> = {}): LessonTrialReport {
  return {
    holdout: 0.2,
    overall: effect(),
    byNote: [],
    excluded: { launchFailed: 1, unfinished: 2 },
    ...overrides,
  };
}

function note(id: string, over: Partial<KnowledgeNoteV1> = {}): KnowledgeNoteV1 {
  return {
    v: 1,
    id,
    text: `Always run the focused contract before broad verification for ${id}`,
    scope: { repo: null, pathGlobs: [], taskKinds: [] },
    status: 'approved',
    retroId: null,
    source: 'fleet',
    createdAt: '2026-09-01T00:00:00.000Z',
    decidedAt: '2026-09-02T00:00:00.000Z',
    edited: false,
    hits: 4,
    lastHitAt: '2026-09-10T00:00:00.000Z',
    seen: 1,
    agentsMdTaskId: null,
    ...over,
  };
}

let previousAshlrHome: string | undefined;
let home: string;

beforeEach(() => {
  feedMock.mockReset();
  feedMock.mockImplementation(realFeed);
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-lesson-trial-backlog-'));
  process.env.ASHLR_HOME = home;
});

afterEach(() => {
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('lessonTrialBacklogItems', () => {
  it('emits one overall item when the all-runs verdict is hurts', async () => {
    const items = await lessonTrialBacklogItems({ repo: REPO, trial: report() });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.id).toMatch(/^lesson-trial-[0-9a-f]{16}$/);
    expect(item.title).toContain('holdout');
    expect(item.area).toBe('lesson-trial');
    expect(item.priority).toBe(3);
    expect(item.repo).toBe(REPO);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain('served 4/8 landed (50%)');
    expect(item.prompt).toContain('holdout 3/3 landed (100%)');
    expect(item.prompt).toContain('-50 points');
    expect(item.prompt).toContain('95% CI -90 to -10 points');
    expect(item.prompt).toContain('verdict hurts');
    expect(item.prompt).toContain('1 launch failures, 2 unfinished');
    expect(item.prompt).toContain('lesson-trial.ts');
    expect(item.prompt).toContain('inject.ts');
    expect(item.prompt).toContain('no-change');
  });

  it('emits per-note items only for hurts verdicts on still-approved notes', async () => {
    const hurting = effect({ scope: 'note.a', served: { tasks: 6, landed: 1, rate: 1 / 6 }, holdout: { tasks: 4, landed: 4, rate: 1 }, delta: -0.83, ci95: [-1, -0.4] });
    const helping = effect({ scope: 'note.b', served: { tasks: 5, landed: 5, rate: 1 }, holdout: { tasks: 4, landed: 2, rate: 0.5 }, delta: 0.5, ci95: [0.1, 0.9], verdict: 'helps' });
    const unknown = effect({ scope: 'note.c', served: { tasks: 1, landed: 0, rate: 0 }, holdout: { tasks: 2, landed: 1, rate: 0.5 }, delta: null, ci95: null, verdict: 'unknown' });
    const flat = effect({ scope: 'note.d', served: { tasks: 6, landed: 3, rate: 0.5 }, holdout: { tasks: 4, landed: 2, rate: 0.5 }, delta: 0, ci95: [-0.4, 0.4], verdict: 'no-difference' });
    const items = await lessonTrialBacklogItems({
      repo: REPO,
      trial: report({ overall: effect({ verdict: 'no-difference', delta: 0, ci95: [-0.2, 0.2] }), byNote: [hurting, helping, unknown, flat] }),
      notes: [
        note('note.a'),
        note('note.b'),
        note('note.c'),
        note('note.d'),
        note('note.rejected', { status: 'rejected' }),
      ],
    });
    // Only note.a hurts AND is approved — and note.rejected is not even in byNote here.
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('Always run the focused contract');
    expect(items[0]!.prompt).toContain('note.a');
    expect(items[0]!.prompt).toContain('4 recorded injections');
    expect(items[0]!.prompt).toContain('owner-decided');
  });

  it('withholds per-note rows whose note is rejected, pending, missing or the store read fails', async () => {
    const hurtingA = effect({ scope: 'note.a', verdict: 'hurts' });
    const hurtingB = effect({ scope: 'note.b', verdict: 'hurts' });
    const hurtingC = effect({ scope: 'note.c', verdict: 'hurts' });
    const base = report({ overall: effect({ verdict: 'no-difference', delta: 0, ci95: [-0.2, 0.2] }), byNote: [hurtingA, hurtingB, hurtingC] });
    const items = await lessonTrialBacklogItems({
      repo: REPO,
      trial: base,
      notes: [note('note.a', { status: 'rejected' }), note('note.b', { status: 'pending' })],
    });
    expect(items).toEqual([]);
    // note.c has no note record at all — cannot resolve to a live note.
    // An empty store (readKnowledge's answer under a fresh home) withholds the same way.
    const empty = await lessonTrialBacklogItems({ repo: REPO, trial: base });
    expect(empty).toEqual([]);
  });

  it('still emits the overall item when the knowledge store cannot resolve notes', async () => {
    const hurting = effect({ scope: 'note.a', verdict: 'hurts' });
    const items = await lessonTrialBacklogItems({
      repo: REPO,
      trial: report({ byNote: [hurting] }),
      notes: [],
    });
    // Overall hurts → overall item survives; the per-note row withholds.
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('served runs land worse');
    expect(items[0]!.prompt).toContain('1 launch failures, 2 unfinished');
  });

  it('stays quiet on helps, no-difference and unknown verdicts and on a withheld trial', async () => {
    for (const verdict of ['helps', 'no-difference', 'unknown'] as const) {
      const e = effect({ verdict, delta: verdict === 'unknown' ? null : 0.2, ci95: verdict === 'unknown' ? null : [0.05, 0.35] });
      expect(await lessonTrialBacklogItems({ repo: REPO, trial: report({ overall: e }) })).toEqual([]);
    }
    expect(await lessonTrialBacklogItems({ repo: REPO, trial: null })).toEqual([]);
    expect(await lessonTrialBacklogItems({ repo: REPO, trial: report({ overall: effect({ verdict: 'unknown', delta: null, ci95: null }) }) })).toEqual([]);
  });

  it('gates on the fleet repository and orders overall before per-note rows', async () => {
    const hurtingNote = effect({ scope: 'note.z', served: { tasks: 9, landed: 1, rate: 1 / 9 }, holdout: { tasks: 5, landed: 5, rate: 1 }, delta: -0.89, ci95: [-1, -0.3] });
    const hurtingNote2 = effect({ scope: 'note.y', served: { tasks: 4, landed: 0, rate: 0 }, holdout: { tasks: 3, landed: 3, rate: 1 }, delta: -1, ci95: [-1, -0.2] });
    const opts = {
      repo: REPO,
      trial: report({ byNote: [hurtingNote, hurtingNote2] }),
      notes: [note('note.z'), note('note.y')],
    };
    expect(await lessonTrialBacklogItems({ ...opts, repo: 'ashlrai/other-repo' })).toEqual([]);
    const items = await lessonTrialBacklogItems(opts);
    // Overall first, then per-note strongest delta first (note.y -1 < note.z -0.89).
    expect(items).toHaveLength(3);
    expect(items[0]!.title).toContain('served runs land worse');
    expect(items[1]!.prompt).toContain('note.y');
    expect(items[2]!.prompt).toContain('note.z');
    // A bare repository name still matches the fleet gate but carries no owner/repo field.
    const bare = await lessonTrialBacklogItems({ ...opts, repo: 'phantom' });
    expect(bare).toHaveLength(3);
    expect(bare.every((item) => item.repo === undefined)).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const opts = {
      repo: REPO,
      trial: report({ byNote: [effect({ scope: 'note.a' })] }),
      notes: [note('note.a')],
    };
    const first = await lessonTrialBacklogItems(opts);
    const second = await lessonTrialBacklogItems(opts);
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
    // Shifted tallies on the same scope keep the same id — no twin items.
    const shifted = await lessonTrialBacklogItems({
      ...opts,
      trial: report({ byNote: [effect({ scope: 'note.a', served: { tasks: 12, landed: 2, rate: 1 / 6 } })] }),
    });
    expect(shifted.map((item) => item.id)).toEqual(first.map((item) => item.id));
  });

  it('caps emitted items and scrubs secret-shaped note text', async () => {
    const many = Array.from({ length: 12 }, (_, i) => effect({ scope: `note.${i}` }));
    const notes = many.map((e, i) => note(e.scope, { text: i === 0 ? `Check ghp_${'a'.repeat(36)} before merging` : `note text ${i}` }));
    const items = await lessonTrialBacklogItems({
      repo: REPO,
      trial: report({ overall: effect({ verdict: 'no-difference', delta: 0, ci95: [-0.1, 0.1] }), byNote: many }),
      notes,
      limit: 5,
    });
    expect(items).toHaveLength(5);
    expect(items[0]!.title).not.toContain('ghp_');
    expect(items[0]!.prompt).not.toContain('ghp_');
    expect(items[0]!.title + items[0]!.prompt).toContain('[REDACTED]');
  });
});

describe('lessonTrialBacklogItems constants', () => {
  it('exposes the documented item bound', () => {
    expect(LESSON_TRIAL_MAX_ITEMS).toBeGreaterThan(0);
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

  it('appends feed items through discovery and dedupes on refresh', async () => {
    const sentinel = {
      id: 'lesson-trial-deadbeefdeadbeef',
      title: 'Cloud lesson holdout sentinel keeps hurting landing',
      prompt: 'Sentinel prompt naming the lesson-trial evidence.',
      area: 'lesson-trial',
      priority: 3 as const,
      repo: REPO,
    };
    feedMock.mockResolvedValueOnce([sentinel]);
    const first = await discoverBacklog(REPO, { gh: greenGh });
    expect(feedMock).toHaveBeenCalledWith({ repo: REPO });
    const lessonItems = first.items.filter((item) => item.id === sentinel.id);
    expect(lessonItems).toHaveLength(1);
    expect(first.items.every((item) => validBacklogItem(item) !== null)).toBe(true);
    expect(appendUserBacklogItems(lessonItems)).toBe(1);
    feedMock.mockResolvedValueOnce([sentinel]);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((item) => item.id === sentinel.id))).toBe(0);
    expect(readUserBacklogItems().filter((item) => item.id === sentinel.id)).toHaveLength(1);
  });
});
