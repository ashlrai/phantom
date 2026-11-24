import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KNOWLEDGE_OUTCOME_ADVERSE_RECURRING,
  KNOWLEDGE_OUTCOME_MAX_ITEMS,
  KNOWLEDGE_OUTCOME_RECORD_LIMIT,
  KNOWLEDGE_OUTCOME_WINDOW_HOURS,
  knowledgeOutcomeBacklogItems,
} from '../src/core/improve/knowledge-outcome-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  appendUserBacklogItems,
  readUserBacklogItems,
  validBacklogItem,
} from '../src/core/cloud/backlog.js';
import { updateKnowledge } from '../src/core/learn/retro/store.js';
import type { KnowledgeNoteOutcomes, KnowledgeNoteV1 } from '../src/core/learn/retro/types.js';

vi.mock('../src/core/improve/knowledge-outcome-backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/improve/knowledge-outcome-backlog.js')>();
  return { ...actual, knowledgeOutcomeBacklogItems: vi.fn(actual.knowledgeOutcomeBacklogItems) };
});

const realFeed = (await vi.importActual<typeof import('../src/core/improve/knowledge-outcome-backlog.js')>(
  '../src/core/improve/knowledge-outcome-backlog.js',
)).knowledgeOutcomeBacklogItems;
const feedMock = vi.mocked(knowledgeOutcomeBacklogItems);

const REPO = 'ashlrai/phantom';
const NOTE_A = 'kn_0123456789abcdef';
const NOTE_B = 'kn_fedcba9876543210';
const NOTE_C = 'kn_aaaaaaaabbbbbbbb';

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

function outcomes(entries: Record<string, KnowledgeNoteOutcomes>): Map<string, KnowledgeNoteOutcomes> {
  return new Map(Object.entries(entries));
}

const recurring: KnowledgeNoteOutcomes = {
  runs: 6,
  joined: 5,
  outcomes: { merged: 4, failed: 1 },
  realized: { reverted: 2, regressed: 1 },
};

let previousAshlrHome: string | undefined;
let home: string;

beforeEach(() => {
  feedMock.mockReset();
  feedMock.mockImplementation(realFeed);
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-knowledge-outcome-backlog-'));
  process.env.ASHLR_HOME = home;
  // The knowledge store resolves homedir()/.ashlr/learn, not ASHLR_HOME —
  // clear it so notes other suites left in this worker's home cannot leak in.
  rmSync(join(homedir(), '.ashlr', 'learn'), { recursive: true, force: true });
});

afterEach(() => {
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('knowledgeOutcomeBacklogItems', () => {
  it('emits one valid item per approved note at the recurring adverse bar', async () => {
    const items = await knowledgeOutcomeBacklogItems({
      repo: REPO,
      outcomes: outcomes({ [NOTE_A]: recurring }),
      notes: [note(NOTE_A)],
    });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.id).toMatch(/^knowledge-outcome-[0-9a-f]{16}$/);
    expect(item.title).toContain('Always run the focused contract');
    expect(item.area).toBe('knowledge-outcomes');
    expect(item.priority).toBe(3);
    expect(item.repo).toBe(REPO);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain(NOTE_A);
    expect(item.prompt).toContain('approved');
    expect(item.prompt).toContain('4 recorded injections');
    expect(item.prompt).toContain('6 distinct trajectories');
    expect(item.prompt).toContain('5 resolved to trajectory records');
    expect(item.prompt).toContain('failed 1, merged 4');
    expect(item.prompt).toContain('reverted 2, regressed 1, followed-up 0');
    expect(item.prompt).toContain('(3 adverse)');
    expect(item.prompt).toContain('descriptive tallies, not a causal verdict');
    expect(item.prompt).toContain('knowledge-outcomes.ts');
    expect(item.prompt).toContain('knowledge-runs.jsonl');
    expect(item.prompt).toContain('owner-decided');
    expect(item.prompt).toContain('no-change');
  });

  it('counts followed-up outcomes toward the same adverse bar', async () => {
    const items = await knowledgeOutcomeBacklogItems({
      repo: REPO,
      outcomes: outcomes({
        [NOTE_A]: { runs: 4, joined: 3, realized: { 'followed-up': KNOWLEDGE_OUTCOME_ADVERSE_RECURRING } },
      }),
      notes: [note(NOTE_A)],
    });
    expect(items).toHaveLength(1);
  });

  it('stays quiet below the recurring bar and on missing realized tallies', async () => {
    for (const realized of [{ reverted: 2 }, { regressed: 1, 'followed-up': 1 }, undefined]) {
      const items = await knowledgeOutcomeBacklogItems({
        repo: REPO,
        outcomes: outcomes({
          [NOTE_A]: { runs: 5, joined: 4, realized },
        }),
        notes: [note(NOTE_A)],
      });
      expect(items).toEqual([]);
    }
  });

  it('withholds on a null projection', async () => {
    const items = await knowledgeOutcomeBacklogItems({
      repo: REPO,
      outcomes: null,
      notes: [note(NOTE_A)],
    });
    expect(items).toEqual([]);
  });

  it('emits only while the note is still approved', async () => {
    const map = outcomes({ [NOTE_A]: recurring, [NOTE_B]: recurring });
    const items = await knowledgeOutcomeBacklogItems({
      repo: REPO,
      outcomes: map,
      notes: [note(NOTE_A, { status: 'rejected' }), note(NOTE_B, { status: 'pending' })],
    });
    expect(items).toEqual([]);
    // A note id the store cannot resolve never emits.
    const missing = await knowledgeOutcomeBacklogItems({
      repo: REPO,
      outcomes: outcomes({ [NOTE_C]: recurring }),
      notes: [note(NOTE_A)],
    });
    expect(missing).toEqual([]);
    // An empty store withholds the same way.
    const empty = await knowledgeOutcomeBacklogItems({ repo: REPO, outcomes: map });
    expect(empty).toEqual([]);
    // Approved is the only live state; rejected was handled, pending was never injected.
    const live = await knowledgeOutcomeBacklogItems({
      repo: REPO,
      outcomes: outcomes({ [NOTE_A]: recurring }),
      notes: [note(NOTE_A, { status: 'approved' })],
    });
    expect(live).toHaveLength(1);
  });

  it('gates on the fleet repository and orders by recorded adverse evidence', async () => {
    const map = outcomes({
      [NOTE_A]: { runs: 9, joined: 8, realized: { reverted: 2, regressed: 1 } },
      [NOTE_B]: { runs: 4, joined: 3, realized: { regressed: 3 } },
      [NOTE_C]: { runs: 7, joined: 6, realized: { reverted: 5 } },
    });
    const notes = [note(NOTE_A), note(NOTE_B), note(NOTE_C)];
    expect(await knowledgeOutcomeBacklogItems({ repo: 'ashlrai/other-repo', outcomes: map, notes })).toEqual([]);
    const items = await knowledgeOutcomeBacklogItems({ repo: REPO, outcomes: map, notes });
    // NOTE_C: 5 adverse, NOTE_A: 3 (joined 8), NOTE_B: 3 (joined 3).
    expect(items.map((item) => item.prompt)).toEqual([
      expect.stringContaining(NOTE_C),
      expect.stringContaining(NOTE_A),
      expect.stringContaining(NOTE_B),
    ]);
    const limited = await knowledgeOutcomeBacklogItems({ repo: REPO, outcomes: map, notes, limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((item) => item.id)).toEqual(items.slice(0, 2).map((item) => item.id));
    // A bare repository name still matches the fleet gate but carries no owner/repo field.
    const bare = await knowledgeOutcomeBacklogItems({ repo: 'phantom', outcomes: map, notes });
    expect(bare).toHaveLength(3);
    expect(bare.every((item) => item.repo === undefined)).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const opts = {
      repo: REPO,
      outcomes: outcomes({ [NOTE_A]: recurring }),
      notes: [note(NOTE_A)],
    };
    const first = await knowledgeOutcomeBacklogItems(opts);
    const second = await knowledgeOutcomeBacklogItems(opts);
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
    // Shifted tallies on the same note keep the same id — no twin items.
    const shifted = await knowledgeOutcomeBacklogItems({
      ...opts,
      outcomes: outcomes({ [NOTE_A]: { runs: 11, joined: 9, realized: { reverted: 4, regressed: 2, 'followed-up': 1 } } }),
    });
    expect(shifted.map((item) => item.id)).toEqual(first.map((item) => item.id));
  });

  it('skips malformed rows without throwing', async () => {
    const map = outcomes({
      'not-a-note-id': recurring,
      'kn_SHORT': recurring,
      [NOTE_A]: { runs: -1, joined: 2, realized: { reverted: 9 } },
      [NOTE_B]: { runs: 5, joined: 4.5, realized: { reverted: 9 } },
      [NOTE_C]: recurring,
    });
    const items = await knowledgeOutcomeBacklogItems({
      repo: REPO,
      outcomes: map,
      notes: [note(NOTE_A), note(NOTE_B), note(NOTE_C)],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain(NOTE_C);
  });

  it('scrubs secret-shaped note text out of titles and prompts', async () => {
    const secretText = `Check ghp_${'a'.repeat(36)} before merging`;
    const items = await knowledgeOutcomeBacklogItems({
      repo: REPO,
      outcomes: outcomes({ [NOTE_A]: recurring }),
      notes: [note(NOTE_A, { text: secretText })],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).not.toContain('ghp_');
    expect(items[0]!.prompt).not.toContain('ghp_');
    expect(items[0]!.title + items[0]!.prompt).toContain('[REDACTED]');
  });

  it('reads the real knowledge store under the isolated home', async () => {
    await updateKnowledge((notes) => ({
      notes: [...notes, note(NOTE_A), note(NOTE_B, { status: 'pending' }), note(NOTE_C, { status: 'rejected' })],
      result: null,
    }));
    const items = await knowledgeOutcomeBacklogItems({
      repo: REPO,
      outcomes: outcomes({ [NOTE_A]: recurring, [NOTE_B]: recurring, [NOTE_C]: recurring }),
    });
    // NOTE_A is approved and emits; the pending and rejected notes withhold.
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain(NOTE_A);
  });
});

describe('knowledgeOutcomeBacklogItems constants', () => {
  it('exposes the documented window, cohort cap and item bounds', () => {
    expect(KNOWLEDGE_OUTCOME_WINDOW_HOURS).toBe(24 * 7);
    expect(KNOWLEDGE_OUTCOME_RECORD_LIMIT).toBe(500);
    expect(KNOWLEDGE_OUTCOME_ADVERSE_RECURRING).toBe(3);
    expect(KNOWLEDGE_OUTCOME_MAX_ITEMS).toBeGreaterThan(0);
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
      id: 'knowledge-outcome-deadbeefdeadbeef',
      title: 'Knowledge note sentinel keeps landing adverse trajectory outcomes',
      prompt: 'Sentinel prompt naming the knowledge-outcome evidence.',
      area: 'knowledge-outcomes',
      priority: 3 as const,
      repo: REPO,
    };
    feedMock.mockResolvedValueOnce([sentinel]);
    const first = await discoverBacklog(REPO, { gh: greenGh });
    expect(feedMock).toHaveBeenCalledWith({ repo: REPO });
    const noteItems = first.items.filter((item) => item.id === sentinel.id);
    expect(noteItems).toHaveLength(1);
    expect(first.items.every((item) => validBacklogItem(item) !== null)).toBe(true);
    expect(appendUserBacklogItems(noteItems)).toBe(1);
    feedMock.mockResolvedValueOnce([sentinel]);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((item) => item.id === sentinel.id))).toBe(0);
    expect(readUserBacklogItems().filter((item) => item.id === sentinel.id)).toHaveLength(1);
  });
});
