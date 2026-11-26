import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KNOWLEDGE_SERVE_ITEM_HARD_MAX,
  KNOWLEDGE_SERVE_LONG_NEVER_DAYS,
  KNOWLEDGE_SERVE_MAX_ITEMS,
  KNOWLEDGE_SERVE_MIN_AGE_DAYS,
  KNOWLEDGE_SERVE_MIN_NEVER_SERVED,
  KNOWLEDGE_SERVE_MIN_STALE,
  KNOWLEDGE_SERVE_STALE_DAYS,
  foldKnowledgeServe,
  knowledgeServeBacklogItems,
  knowledgeServeCells,
} from '../src/core/improve/knowledge-serve-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  appendUserBacklogItems,
  readUserBacklogItems,
  validBacklogItem,
} from '../src/core/cloud/backlog.js';
import { recordKnowledgeHits, updateKnowledge, type HitTotals } from '../src/core/learn/retro/store.js';
import type { KnowledgeNoteV1 } from '../src/core/learn/retro/types.js';

vi.mock('../src/core/improve/knowledge-serve-backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/improve/knowledge-serve-backlog.js')>();
  return { ...actual, knowledgeServeBacklogItems: vi.fn(actual.knowledgeServeBacklogItems) };
});

const realFeed = (await vi.importActual<typeof import('../src/core/improve/knowledge-serve-backlog.js')>(
  '../src/core/improve/knowledge-serve-backlog.js',
)).knowledgeServeBacklogItems;
const feedMock = vi.mocked(knowledgeServeBacklogItems);

const REPO = 'ashlrai/phantom';
const NOW = new Date('2026-11-26T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const DAY = 86_400_000;
const isoDaysAgo = (days: number): string => new Date(NOW_MS - days * DAY).toISOString();

const NOTE_A = 'kn_0123456789abcdef';
const NOTE_B = 'kn_fedcba9876543210';
const NOTE_C = 'kn_aaaaaaaabbbbbbbb';
const NOTE_D = 'kn_1111111122222222';
const NOTE_E = 'kn_3333333344444444';

function note(id: string, over: Partial<KnowledgeNoteV1> = {}): KnowledgeNoteV1 {
  return {
    v: 1,
    id,
    text: `Always run the focused contract before broad verification for ${id}`,
    scope: { repo: null, pathGlobs: [], taskKinds: [] },
    status: 'approved',
    retroId: null,
    source: 'fleet',
    createdAt: isoDaysAgo(30),
    decidedAt: isoDaysAgo(20),
    edited: false,
    hits: 0,
    lastHitAt: null,
    seen: 1,
    agentsMdTaskId: null,
    ...over,
  };
}

function hits(entries: Record<string, HitTotals>): Map<string, HitTotals> {
  return new Map(Object.entries(entries));
}

let previousAshlrHome: string | undefined;
let home: string;

beforeEach(() => {
  feedMock.mockReset();
  feedMock.mockImplementation(realFeed);
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-knowledge-serve-backlog-'));
  process.env.ASHLR_HOME = home;
  // The learn store resolves homedir()/.ashlr/learn, not ASHLR_HOME —
  // clear it so notes other suites left in this worker's home cannot leak in.
  rmSync(join(homedir(), '.ashlr', 'learn'), { recursive: true, force: true });
});

afterEach(() => {
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('knowledgeServeBacklogItems never-served', () => {
  it('emits one valid item at the population bar of approved notes with zero recorded hits', async () => {
    const items = await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [note(NOTE_A), note(NOTE_B, { scope: { repo: 'ashlrai/phantom', pathGlobs: ['src/core/**'], taskKinds: ['fix'] } })],
      hits: new Map(),
      now: NOW,
    });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.id).toMatch(/^knowledge-serve-[0-9a-f]{16}$/);
    expect(item.title).toBe('2 approved knowledge notes have zero recorded prompt injections');
    expect(item.area).toBe('knowledge-serve');
    expect(item.priority).toBe(3);
    expect(item.repo).toBe(REPO);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain('zero recorded injections');
    expect(item.prompt).toContain(NOTE_A);
    expect(item.prompt).toContain(NOTE_B);
    expect(item.prompt).toContain('2 of 2 approved');
    expect(item.prompt).toContain("'fix' ×1");
    expect(item.prompt).toContain("'(any)' ×1");
    expect(item.prompt).toContain('knowledge-hits.jsonl');
    expect(item.prompt).toContain('knowledgeBlockFor');
    expect(item.prompt).toContain('KNOWLEDGE_INJECT_MAX_NOTES');
    expect(item.prompt).toContain('owner-only');
    expect(item.prompt).toContain('no-change');
  });

  it('stays quiet below the population bar until one note reaches the long bar', async () => {
    // One never-served note at 20 days: below both bars.
    expect(await knowledgeServeBacklogItems({
      repo: REPO, notes: [note(NOTE_A)], hits: new Map(), now: NOW,
    })).toEqual([]);
    // Two notes but one is only 3 days approved: below the age bar.
    expect(await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [note(NOTE_A), note(NOTE_B, { decidedAt: isoDaysAgo(3), createdAt: isoDaysAgo(3) })],
      hits: new Map(),
      now: NOW,
    })).toEqual([]);
    // A single note approved past the long bar emits on its own.
    const old = await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [note(NOTE_A, { decidedAt: isoDaysAgo(45), createdAt: isoDaysAgo(50) })],
      hits: new Map(),
      now: NOW,
    });
    expect(old).toHaveLength(1);
    expect(old[0]!.title).toBe('1 approved knowledge note has zero recorded prompt injections');
    expect(old[0]!.prompt).toContain('ages 45–45 days');
  });

  it('counts only approved notes — pending and rejected never evidence a gap', async () => {
    const items = await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [
        note(NOTE_A, { status: 'pending' }),
        note(NOTE_B, { status: 'rejected' }),
        note(NOTE_C, { status: 'approved', decidedAt: isoDaysAgo(3), createdAt: isoDaysAgo(3) }),
      ],
      hits: new Map(),
      now: NOW,
    });
    expect(items).toEqual([]);
    // One approved + one pending still below the population bar.
    const mixed = await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [note(NOTE_A), note(NOTE_B, { status: 'pending' })],
      hits: new Map(),
      now: NOW,
    });
    expect(mixed).toEqual([]);
  });

  it('treats stored note hits and log hits as the same effective counter the Lessons view uses', async () => {
    // Stored hits alone keep a note out of never-served; lastHitAt comes from the stored field.
    const stored = await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [note(NOTE_A, { hits: 3, lastHitAt: isoDaysAgo(10) }), note(NOTE_B)],
      hits: new Map(),
      now: NOW,
    });
    expect(stored).toEqual([]);
    // Log hits alone do the same: NOTE_A stays out of never-served on its
    // recorded hits, and its newest recorded hit (the log's 40d, which
    // beats the stored 50d) is what the stale cell would measure.
    const logged = await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [note(NOTE_A, { hits: 1, lastHitAt: isoDaysAgo(50) }), note(NOTE_B), note(NOTE_C)],
      hits: hits({ [NOTE_A]: { hits: 2, lastHitAt: isoDaysAgo(40) } }),
      now: NOW,
    });
    // NOTE_B and NOTE_C are the never-served pair; NOTE_A's single stale row is below MIN_STALE.
    expect(logged).toHaveLength(1);
    expect(logged[0]!.title).toContain('zero recorded prompt injections');
    expect(logged[0]!.prompt).toContain(NOTE_B);
    expect(logged[0]!.prompt).toContain(NOTE_C);
    expect(logged[0]!.prompt).not.toContain(`'${NOTE_A}'`);
    const threeStale = await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [
        note(NOTE_A, { hits: 1, lastHitAt: isoDaysAgo(50) }),
        note(NOTE_B, { hits: 2, lastHitAt: isoDaysAgo(35) }),
        note(NOTE_C, { hits: 0 }),
      ],
      hits: hits({
        [NOTE_A]: { hits: 2, lastHitAt: isoDaysAgo(40) },
        [NOTE_B]: { hits: 1, lastHitAt: isoDaysAgo(45) },
        [NOTE_C]: { hits: 4, lastHitAt: isoDaysAgo(60) },
      }),
      now: NOW,
    });
    expect(threeStale).toHaveLength(1);
    expect(threeStale[0]!.title).toBe('3 approved knowledge notes stopped recording prompt injections');
    expect(threeStale[0]!.prompt).toContain('10 recorded injections in total');
  });

  it('skips undated approved notes and says so inside the emitted prompt', async () => {
    const items = await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [
        note(NOTE_A),
        note(NOTE_B),
        note(NOTE_C, { decidedAt: 'not-a-date', createdAt: 'also-not-a-date' }),
      ],
      hits: new Map(),
      now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('1 further approved note has unparseable dates');
    expect(items[0]!.prompt).toContain('2 of 2 approved');
  });

  it('withholds on a failed notes or hits read rather than guessing', async () => {
    expect(await knowledgeServeBacklogItems({ repo: REPO, notes: null, hits: new Map(), now: NOW })).toEqual([]);
    expect(await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [note(NOTE_A), note(NOTE_B)],
      hits: null,
      now: NOW,
    })).toEqual([]);
  });
});

describe('knowledgeServeBacklogItems stale-served', () => {
  it('emits at the higher population bar of served notes gone quiet', async () => {
    const items = await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [
        note(NOTE_A, { hits: 2, lastHitAt: isoDaysAgo(40) }),
        note(NOTE_B, { hits: 1, lastHitAt: isoDaysAgo(35) }),
        note(NOTE_C, { hits: 7, lastHitAt: isoDaysAgo(90) }),
        note(NOTE_D, { hits: 3, lastHitAt: isoDaysAgo(4) }),
      ],
      hits: new Map(),
      now: NOW,
    });
    // NOTE_D hit 4 days ago — not quiet. The other three are.
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.title).toBe('3 approved knowledge notes stopped recording prompt injections');
    expect(item.prompt).toContain('quiet 35–90 days');
    expect(item.prompt).toContain('10 recorded injections in total');
    expect(item.prompt).toContain('work mix drifted');
    expect(item.prompt).not.toContain(NOTE_D);
  });

  it('stays quiet below the bar, on recent hits, and on hit rows without a dated lastHitAt', async () => {
    // Two quiet notes: below MIN_STALE.
    expect(await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [note(NOTE_A, { hits: 1, lastHitAt: isoDaysAgo(40) }), note(NOTE_B, { hits: 1, lastHitAt: isoDaysAgo(40) })],
      hits: new Map(),
      now: NOW,
    })).toEqual([]);
    // Three notes but hits are recent.
    expect(await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [note(NOTE_A, { hits: 1, lastHitAt: isoDaysAgo(10) }), note(NOTE_B, { hits: 1, lastHitAt: isoDaysAgo(12) }), note(NOTE_C, { hits: 1, lastHitAt: isoDaysAgo(15) })],
      hits: new Map(),
      now: NOW,
    })).toEqual([]);
    // Log hits with no lastHitAt cannot prove quiet — skipped, not guessed.
    expect(await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [note(NOTE_A), note(NOTE_B), note(NOTE_C)],
      hits: hits({
        [NOTE_A]: { hits: 2, lastHitAt: null },
        [NOTE_B]: { hits: 2, lastHitAt: null },
        [NOTE_C]: { hits: 2, lastHitAt: null },
      }),
      now: NOW,
    })).toEqual([]);
  });
});

describe('knowledgeServeBacklogItems fold and cells', () => {
  it('emits both cells with never-served first when both bars are met', async () => {
    const items = await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [
        note(NOTE_A), note(NOTE_B),
        note(NOTE_C, { hits: 2, lastHitAt: isoDaysAgo(40) }),
        note(NOTE_D, { hits: 1, lastHitAt: isoDaysAgo(50) }),
        note(NOTE_E, { hits: 3, lastHitAt: isoDaysAgo(35) }),
      ],
      hits: new Map(),
      now: NOW,
    });
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toContain('zero recorded prompt injections');
    expect(items[1]!.title).toContain('stopped recording prompt injections');
    expect(items[0]!.id).not.toBe(items[1]!.id);
    // limit slices the ordered cells.
    const limited = await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [
        note(NOTE_A), note(NOTE_B),
        note(NOTE_C, { hits: 2, lastHitAt: isoDaysAgo(40) }),
        note(NOTE_D, { hits: 1, lastHitAt: isoDaysAgo(50) }),
        note(NOTE_E, { hits: 3, lastHitAt: isoDaysAgo(35) }),
      ],
      hits: new Map(),
      now: NOW,
      limit: 1,
    });
    expect(limited).toHaveLength(1);
    expect(limited[0]!.id).toBe(items[0]!.id);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const opts = {
      repo: REPO,
      notes: [note(NOTE_A), note(NOTE_B)],
      hits: new Map<string, HitTotals>(),
      now: NOW,
    };
    const first = await knowledgeServeBacklogItems(opts);
    const second = await knowledgeServeBacklogItems(opts);
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
    // Shifted corpus sizes keep the same cell id — no twin items.
    const grown = await knowledgeServeBacklogItems({
      ...opts,
      notes: [note(NOTE_A), note(NOTE_B), note(NOTE_C)],
    });
    expect(grown.map((item) => item.id)).toEqual(first.map((item) => item.id));
  });

  it('folds malformed rows without throwing', () => {
    const fold = foldKnowledgeServe(
      [
        note(NOTE_A),
        { ...note(NOTE_B), id: '' },
        { ...note(NOTE_C), status: 'pending' },
        { ...note(NOTE_D), decidedAt: 'garbage', createdAt: 'garbage' },
      ] as KnowledgeNoteV1[],
      new Map([[NOTE_A, { hits: 1, lastHitAt: isoDaysAgo(50) }]]),
      NOW_MS,
    );
    // NOTE_A's log hit keeps it out of never-served; its 50-day quiet puts it in stale.
    // NOTE_B's empty id, NOTE_C's pending status and NOTE_D's unparseable dates are skipped.
    expect(fold.approved).toBe(1);
    expect(fold.undated).toBe(1);
    expect(fold.neverServed).toEqual([]);
    expect(fold.stale.map((row) => row.id)).toEqual([NOTE_A]);
    const cells = knowledgeServeCells(fold, NOW_MS);
    expect(cells).toEqual([]); // one stale row is below the population bar
  });

  it('gates on the fleet repository', async () => {
    const opts = { notes: [note(NOTE_A), note(NOTE_B)], hits: new Map<string, HitTotals>(), now: NOW };
    expect(await knowledgeServeBacklogItems({ ...opts, repo: 'ashlrai/other-repo' })).toEqual([]);
    expect(await knowledgeServeBacklogItems({ ...opts, repo: '' })).toEqual([]);
    const bare = await knowledgeServeBacklogItems({ ...opts, repo: 'phantom' });
    expect(bare).toHaveLength(1);
    expect(bare[0]!.repo).toBeUndefined();
  });

  it('scrubs secret-shaped note text out of titles and prompts', async () => {
    const secretText = `Check ghp_${'a'.repeat(36)} before merging`;
    const items = await knowledgeServeBacklogItems({
      repo: REPO,
      notes: [note(NOTE_A, { text: secretText }), note(NOTE_B, { text: secretText })],
      hits: new Map(),
      now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).not.toContain('ghp_');
    expect(items[0]!.prompt).not.toContain('ghp_');
    expect(items[0]!.title + items[0]!.prompt).toContain('[REDACTED]');
  });
});

describe('knowledgeServeBacklogItems real store', () => {
  it('reads the real knowledge store and hits log under the isolated home', async () => {
    await updateKnowledge((notes) => ({
      notes: [
        ...notes,
        note(NOTE_A),
        note(NOTE_B),
        note(NOTE_C, { status: 'pending' }),
      ],
      result: null,
    }));
    // NOTE_A gets a recorded hit; NOTE_B stays at zero.
    await recordKnowledgeHits([NOTE_A]);
    const items = await knowledgeServeBacklogItems({ repo: REPO, now: NOW });
    // NOTE_B alone is below the population bar → quiet.
    expect(items).toEqual([]);
    await updateKnowledge((notes) => ({
      notes: [...notes, note(NOTE_D)],
      result: null,
    }));
    const second = await knowledgeServeBacklogItems({ repo: REPO, now: NOW });
    expect(second).toHaveLength(1);
    expect(second[0]!.prompt).toContain(NOTE_B);
    expect(second[0]!.prompt).toContain(NOTE_D);
    expect(second[0]!.prompt).not.toContain(`'${NOTE_A}'`);
  });
});

describe('knowledgeServeBacklogItems constants', () => {
  it('exposes the documented bars and bounds', () => {
    expect(KNOWLEDGE_SERVE_MIN_AGE_DAYS).toBe(7);
    expect(KNOWLEDGE_SERVE_MIN_NEVER_SERVED).toBe(2);
    expect(KNOWLEDGE_SERVE_LONG_NEVER_DAYS).toBe(30);
    expect(KNOWLEDGE_SERVE_STALE_DAYS).toBe(30);
    expect(KNOWLEDGE_SERVE_MIN_STALE).toBe(3);
    expect(KNOWLEDGE_SERVE_MAX_ITEMS).toBe(2);
    expect(KNOWLEDGE_SERVE_ITEM_HARD_MAX).toBeGreaterThan(KNOWLEDGE_SERVE_MAX_ITEMS);
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
      id: 'knowledge-serve-deadbeefdeadbeef',
      title: 'Sentinel approved knowledge notes have zero recorded prompt injections',
      prompt: 'Sentinel prompt naming the knowledge-serve evidence.',
      area: 'knowledge-serve',
      priority: 3 as const,
      repo: REPO,
    };
    feedMock.mockResolvedValueOnce([sentinel]);
    const first = await discoverBacklog(REPO, { gh: greenGh });
    expect(feedMock).toHaveBeenCalledWith({ repo: REPO });
    const serveItems = first.items.filter((item) => item.id === sentinel.id);
    expect(serveItems).toHaveLength(1);
    expect(first.items.every((item) => validBacklogItem(item) !== null)).toBe(true);
    expect(appendUserBacklogItems(serveItems)).toBe(1);
    feedMock.mockResolvedValueOnce([sentinel]);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((item) => item.id === sentinel.id))).toBe(0);
    expect(readUserBacklogItems().filter((item) => item.id === sentinel.id)).toHaveLength(1);
  });
});
